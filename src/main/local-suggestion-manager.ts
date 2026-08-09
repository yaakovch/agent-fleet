import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import type {
  LocalSuggestionOperationResult,
  LocalSuggestionRequest,
  LocalSuggestionResult,
  LocalSuggestionSettingsInput,
  LocalSuggestionSettingsView
} from '../shared/local-suggestions';
import {
  boundSuggestionContext,
  isLoopbackSuggestionUrl,
  localSuggestionsEnabled,
  localSuggestionPrompt,
  parseLocalSuggestions
} from '../shared/local-suggestions';
import type { LocalSuggestionStore } from './local-suggestion-store';

interface ManagedServer {
  process: ChildProcess;
  baseUrl: string;
  apiKey: string;
  failure?: Error;
  stopRequested: boolean;
}

interface ManagedStart {
  generation: number;
  server: ManagedServer | null;
  abort: AbortController;
  promise: Promise<ManagedServer>;
}

interface ActiveSuggestion {
  requestId: string;
  abort: AbortController;
}

const MAX_MODEL_DISCOVERY_BYTES = 256 * 1024;
const MAX_COMPLETION_BYTES = 1024 * 1024;

export interface LocalSuggestionManagerOptions {
  spawnProcess?: typeof spawn;
  availablePort?: () => Promise<number>;
  fetch?: typeof fetch;
}

export class LocalSuggestionManager {
  private managed: ManagedServer | null = null;
  private managedStart: ManagedStart | null = null;
  private managedGeneration = 0;
  private active: ActiveSuggestion | null = null;
  private readonly spawnProcess: typeof spawn;
  private readonly findAvailablePort: () => Promise<number>;
  private readonly fetchProcess: typeof fetch;

  constructor(
    private readonly store: LocalSuggestionStore,
    options: LocalSuggestionManagerOptions = {}
  ) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.findAvailablePort = options.availablePort ?? availablePort;
    this.fetchProcess = options.fetch ?? fetch;
  }

  settings(): LocalSuggestionSettingsView { return this.store.view(); }

  async save(input: LocalSuggestionSettingsInput): Promise<LocalSuggestionOperationResult> {
    const enabled = localSuggestionsEnabled(input.mode);
    if (enabled && input.backend === 'openAICompatible' && !isLoopbackSuggestionUrl(input.external.baseUrl)) {
      throw new Error('External backend must use localhost, 127.x, or ::1.');
    }
    if (enabled && input.backend === 'managedLlamaCpp'
      && (!input.managed.executablePath.trim() || !input.managed.modelPath.trim())) {
      throw new Error('Choose llama-server.exe and a GGUF model before enabling local suggestions.');
    }
    const before = this.store.view();
    const settings = this.store.save(input);
    const managedChanged = before.backend !== settings.backend
      || before.managed.executablePath !== settings.managed.executablePath
      || before.managed.modelPath !== settings.managed.modelPath;
    if (!localSuggestionsEnabled(settings.mode) || managedChanged) this.stopManaged();
    if (!localSuggestionsEnabled(settings.mode)) this.cancel();
    const message = settings.mode === 'off'
      ? 'Local reply suggestions disabled; managed model memory was released.'
      : `Local reply suggestions set to ${settings.mode === 'automatic' ? 'Automatic' : 'Manual'}.`;
    return { ok: true, message, settings };
  }

  async test(): Promise<LocalSuggestionOperationResult> {
    const settings = this.store.view();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30_000);
    try {
      const connection = await this.connection(settings, abort.signal);
      const model = await this.resolveModel(connection.baseUrl, connection.apiKey, settings.external.modelId, abort.signal);
      return { ok: true, message: `Backend is ready${model ? ` · ${model}` : ''}.`, settings };
    } catch (error) {
      return { ok: false, message: userMessage(error), settings };
    } finally { clearTimeout(timeout); }
  }

  async suggest(input: LocalSuggestionRequest): Promise<LocalSuggestionResult> {
    const settings = this.store.view();
    const request = normalizeRequest(input);
    if (!localSuggestionsEnabled(settings.mode)) return failure(request, 'Enable local reply suggestions in Settings first.');
    this.cancel();
    const abort = new AbortController();
    const operation: ActiveSuggestion = { requestId: request.requestId, abort };
    this.active = operation;
    const timeout = setTimeout(() => abort.abort(new Error('Local model timed out')), 30_000);
    try {
      const connection = await this.connection(settings, abort.signal);
      this.assertActive(operation);
      const model = await this.resolveModel(connection.baseUrl, connection.apiKey, settings.external.modelId, abort.signal);
      this.assertActive(operation);
      const body = {
        model,
        messages: localSuggestionPrompt(request),
        temperature: 0.35,
        max_tokens: 280,
        response_format: { type: 'json_object' }
      };
      let response = await this.postCompletion(connection, body, abort.signal);
      this.assertActiveResponse(operation, response);
      if (!response.ok && response.status === 400) {
        cancelResponseBody(response);
        const { response_format: _responseFormat, ...plainBody } = body;
        response = await this.postCompletion(connection, plainBody, abort.signal);
        this.assertActiveResponse(operation, response);
      }
      if (!response.ok) {
        cancelResponseBody(response);
        throw new Error(`Local model returned HTTP ${response.status}`);
      }
      const json = await readBoundedJson(
        response,
        MAX_COMPLETION_BYTES,
        abort.signal,
        'Local model response'
      ) as { choices?: Array<{ message?: { content?: unknown } }> };
      this.assertActive(operation);
      const suggestions = parseLocalSuggestions(json.choices?.[0]?.message?.content);
      if (!suggestions.length) throw new Error('Local model returned no usable suggestions');
      return { ok: true, requestId: request.requestId, revision: request.revision, suggestions, message: `${suggestions.length} local suggestion${suggestions.length === 1 ? '' : 's'} ready.` };
    } catch (error) {
      return failure(request, abort.signal.aborted ? 'Suggestion canceled or timed out.' : userMessage(error));
    } finally {
      clearTimeout(timeout);
      if (this.active === operation) this.active = null;
    }
  }

  cancel(requestId?: string): void {
    if (!this.active || requestId && this.active.requestId !== requestId) return;
    this.active.abort.abort();
    this.active = null;
  }

  dispose(): void { this.cancel(); this.stopManaged(); }

  private async connection(settings: LocalSuggestionSettingsView, signal?: AbortSignal): Promise<{ baseUrl: string; apiKey: string }> {
    if (settings.backend === 'openAICompatible') {
      if (!isLoopbackSuggestionUrl(settings.external.baseUrl)) throw new Error('External backend must use a loopback URL.');
      return { baseUrl: normalizeBaseUrl(settings.external.baseUrl), apiKey: this.store.token() };
    }
    if (this.managed && !this.managed.failure
      && !this.managed.process.killed && this.managed.process.exitCode === null) return this.managed;
    if (this.managed) {
      stopServer(this.managed);
      this.managed = null;
    }
    const executable = settings.managed.executablePath;
    const model = settings.managed.modelPath;
    if (!executable || !model) throw new Error('Choose llama-server.exe and a GGUF model in Settings.');
    try { accessSync(executable, constants.X_OK); accessSync(model, constants.R_OK); }
    catch { throw new Error('The managed executable or GGUF model cannot be opened.'); }
    const startup = this.managedStart?.promise ?? this.startManaged(executable, model);
    return waitForStartup(startup, signal);
  }

  private async resolveModel(baseUrl: string, apiKey: string, configured: string, signal?: AbortSignal): Promise<string> {
    if (configured) return configured;
    const response = await this.fetchProcess(`${baseUrl}/v1/models`, {
      headers: headers(apiKey), signal, redirect: 'error'
    });
    if (!response.ok) {
      cancelResponseBody(response);
      throw new Error(`Model discovery returned HTTP ${response.status}`);
    }
    const json = await readBoundedJson(
      response,
      MAX_MODEL_DISCOVERY_BYTES,
      signal,
      'Model discovery response'
    ) as { data?: Array<{ id?: unknown }> };
    const id = json.data?.find((value) => typeof value.id === 'string')?.id;
    if (!id || typeof id !== 'string') throw new Error('The local server did not report a model.');
    return id;
  }

  private postCompletion(connection: { baseUrl: string; apiKey: string }, body: object, signal: AbortSignal): Promise<Response> {
    return this.fetchProcess(`${connection.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { ...headers(connection.apiKey), 'content-type': 'application/json' },
      body: JSON.stringify(body), signal, redirect: 'error'
    });
  }

  private stopManaged(): void {
    this.managedGeneration += 1;
    const start = this.managedStart;
    const servers = new Set<ManagedServer>();
    if (this.managed) servers.add(this.managed);
    if (start?.server) servers.add(start.server);
    this.managed = null;
    this.managedStart = null;
    start?.abort.abort();
    for (const server of servers) stopServer(server);
  }

  private startManaged(executable: string, model: string): Promise<ManagedServer> {
    const start = {
      generation: this.managedGeneration,
      server: null,
      abort: new AbortController(),
      promise: undefined as unknown as Promise<ManagedServer>
    } satisfies ManagedStart;
    this.managedStart = start;
    start.promise = this.launchManaged(start, executable, model);
    return start.promise;
  }

  private async launchManaged(start: ManagedStart, executable: string, model: string): Promise<ManagedServer> {
    let server: ManagedServer | null = null;
    try {
      const port = await this.findAvailablePort();
      this.assertManagedStart(start);
      const apiKey = randomBytes(24).toString('base64url');
      const child = this.spawnProcess(executable, managedLlamaArguments(model, port, apiKey), {
        windowsHide: true,
        stdio: 'ignore'
      });
      server = {
        process: child,
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey,
        stopRequested: false
      };
      start.server = server;
      child.on('error', (error) => {
        server!.failure = error;
      });
      child.once('exit', () => {
        server!.failure ??= new Error('Managed backend exited.');
        if (this.managed?.process === child) this.managed = null;
      });
      await waitForHealth(server, this.fetchProcess, start.abort.signal);
      this.assertManagedStart(start);
      if (server.failure) throw server.failure;
      if (server.process.killed || server.process.exitCode !== null) {
        throw new Error('Managed backend exited during startup.');
      }
      this.managedStart = null;
      this.managed = server;
      return server;
    } catch (error) {
      if (this.managedStart === start) this.managedStart = null;
      if (server) stopServer(server);
      throw error;
    }
  }

  private assertManagedStart(start: ManagedStart): void {
    if (this.managedStart !== start || this.managedGeneration !== start.generation) {
      throw new Error('Managed backend startup was superseded.');
    }
  }

  private assertActive(operation: ActiveSuggestion): void {
    if (this.active !== operation || operation.abort.signal.aborted) {
      throw new Error('Suggestion request was superseded.');
    }
  }

  private assertActiveResponse(operation: ActiveSuggestion, response: Response): void {
    try {
      this.assertActive(operation);
    } catch (error) {
      cancelResponseBody(response);
      throw error;
    }
  }
}

export function managedLlamaArguments(modelPath: string, port: number, apiKey: string): string[] {
  return [
    '--host', '127.0.0.1', '--port', String(port), '--model', modelPath,
    '--ctx-size', '4096', '--gpu-layers', 'auto', '--api-key', apiKey,
    '--sleep-idle-seconds', '60'
  ];
}

function normalizeRequest(input: LocalSuggestionRequest): LocalSuggestionRequest {
  if (!input || typeof input !== 'object' || typeof input.requestId !== 'string' || !input.requestId
    || typeof input.tabId !== 'string' || typeof input.revision !== 'string'
    || !input.target || !['composer', 'question'].includes(input.target.kind)) throw new Error('Suggestion request is invalid.');
  const target = input.target.kind === 'question' && typeof input.target.itemId === 'string'
    && typeof input.target.questionId === 'string' && typeof input.target.prompt === 'string'
    ? { kind: 'question' as const, itemId: input.target.itemId, questionId: input.target.questionId, prompt: input.target.prompt.slice(0, 4_096) }
    : { kind: 'composer' as const };
  return { requestId: input.requestId.slice(0, 128), tabId: input.tabId.slice(0, 256), revision: input.revision.slice(0, 256), target, messages: boundSuggestionContext(Array.isArray(input.messages) ? input.messages : []) };
}

function failure(request: Pick<LocalSuggestionRequest, 'requestId' | 'revision'>, message: string): LocalSuggestionResult {
  return { ok: false, requestId: request.requestId, revision: request.revision, suggestions: [], message };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/u, '').replace(/\/v1$/u, '');
  url.search = '';
  return url.toString().replace(/\/$/u, '');
}

function headers(apiKey: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(
  server: ManagedServer,
  fetchProcess: typeof fetch,
  signal: AbortSignal
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.failure) throw server.failure;
    if (server.stopRequested || signal.aborted) throw new Error('Managed backend startup canceled.');
    if (server.process.exitCode !== null) throw new Error('Managed backend exited during startup.');
    const attempt = new AbortController();
    const canceled = (): void => attempt.abort();
    signal.addEventListener('abort', canceled, { once: true });
    const attemptTimer = setTimeout(() => attempt.abort(), 1_000);
    attemptTimer.unref();
    try {
      const response = await fetchProcess(`${server.baseUrl}/health`, {
        headers: headers(server.apiKey),
        signal: attempt.signal,
        redirect: 'error'
      });
      const healthy = response.ok;
      cancelResponseBody(response);
      if (healthy) return;
    } catch { /* startup is still in progress */ }
    finally {
      clearTimeout(attemptTimer);
      signal.removeEventListener('abort', canceled);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Managed backend did not become ready.');
}

function waitForStartup(startup: Promise<ManagedServer>, signal?: AbortSignal): Promise<ManagedServer> {
  if (!signal) return startup;
  if (signal.aborted) return Promise.reject(new Error('Managed backend startup canceled.'));
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener('abort', aborted);
      reject(new Error('Managed backend startup canceled.'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    startup.then(
      (server) => {
        signal.removeEventListener('abort', aborted);
        resolve(server);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      }
    );
  });
}

function stopServer(server: ManagedServer): void {
  if (server.stopRequested) return;
  server.stopRequested = true;
  if (server.process.exitCode === null && !server.process.killed) {
    try { server.process.kill(); } catch { /* process already exited */ }
  }
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  label: string
): Promise<unknown> {
  if (!response.body) throw new Error(`${label} was empty`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const aborted = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    if (signal?.aborted) throw new Error(`${label} was canceled`);
    while (true) {
      const item = await reader.read();
      if (signal?.aborted) throw new Error(`${label} was canceled`);
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeded the safety limit`);
      }
      chunks.push(Buffer.from(item.value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
    } catch {
      throw new Error(`${label} was not valid JSON`);
    }
  } finally {
    signal?.removeEventListener('abort', aborted);
    reader.releaseLock();
  }
}

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // A locked or already-consumed response has no remaining body to retain.
  }
}

function userMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|network/iu.test(message)) return 'The local model server is not reachable.';
  return message.slice(0, 300) || 'Local reply suggestion failed.';
}
