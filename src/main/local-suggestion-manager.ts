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
  localSuggestionPrompt,
  parseLocalSuggestions
} from '../shared/local-suggestions';
import type { LocalSuggestionStore } from './local-suggestion-store';

interface ManagedServer { process: ChildProcess; baseUrl: string; apiKey: string }

export class LocalSuggestionManager {
  private managed: ManagedServer | null = null;
  private active: { requestId: string; abort: AbortController } | null = null;

  constructor(private readonly store: LocalSuggestionStore) {}

  settings(): LocalSuggestionSettingsView { return this.store.view(); }

  async save(input: LocalSuggestionSettingsInput): Promise<LocalSuggestionOperationResult> {
    if (input.enabled && input.backend === 'openAICompatible' && !isLoopbackSuggestionUrl(input.external.baseUrl)) {
      throw new Error('External backend must use localhost, 127.x, or ::1.');
    }
    if (input.enabled && input.backend === 'managedLlamaCpp'
      && (!input.managed.executablePath.trim() || !input.managed.modelPath.trim())) {
      throw new Error('Choose llama-server.exe and a GGUF model before enabling local suggestions.');
    }
    const before = this.store.view();
    const settings = this.store.save(input);
    const managedChanged = before.backend !== settings.backend
      || before.managed.executablePath !== settings.managed.executablePath
      || before.managed.modelPath !== settings.managed.modelPath;
    if (!settings.enabled || managedChanged) this.stopManaged();
    if (!settings.enabled) this.cancel();
    return { ok: true, message: settings.enabled ? 'Local reply suggestions enabled.' : 'Local reply suggestions disabled; managed model memory was released.', settings };
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
    if (!settings.enabled) return failure(request, 'Enable local reply suggestions in Settings first.');
    this.cancel();
    const abort = new AbortController();
    this.active = { requestId: request.requestId, abort };
    const timeout = setTimeout(() => abort.abort(new Error('Local model timed out')), 30_000);
    try {
      const connection = await this.connection(settings, abort.signal);
      const model = await this.resolveModel(connection.baseUrl, connection.apiKey, settings.external.modelId, abort.signal);
      const body = {
        model,
        messages: localSuggestionPrompt(request),
        temperature: 0.35,
        max_tokens: 280,
        response_format: { type: 'json_object' }
      };
      let response = await this.postCompletion(connection, body, abort.signal);
      if (!response.ok && response.status === 400) {
        const { response_format: _responseFormat, ...plainBody } = body;
        response = await this.postCompletion(connection, plainBody, abort.signal);
      }
      if (!response.ok) throw new Error(`Local model returned HTTP ${response.status}`);
      const json = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const suggestions = parseLocalSuggestions(json.choices?.[0]?.message?.content);
      if (!suggestions.length) throw new Error('Local model returned no usable suggestions');
      return { ok: true, requestId: request.requestId, revision: request.revision, suggestions, message: `${suggestions.length} local suggestion${suggestions.length === 1 ? '' : 's'} ready.` };
    } catch (error) {
      return failure(request, abort.signal.aborted ? 'Suggestion canceled or timed out.' : userMessage(error));
    } finally {
      clearTimeout(timeout);
      if (this.active?.requestId === request.requestId) this.active = null;
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
    if (this.managed && !this.managed.process.killed && this.managed.process.exitCode === null) return this.managed;
    const executable = settings.managed.executablePath;
    const model = settings.managed.modelPath;
    if (!executable || !model) throw new Error('Choose llama-server.exe and a GGUF model in Settings.');
    try { accessSync(executable, constants.X_OK); accessSync(model, constants.R_OK); }
    catch { throw new Error('The managed executable or GGUF model cannot be opened.'); }
    const port = await availablePort();
    const apiKey = randomBytes(24).toString('base64url');
    const child = spawn(executable, managedLlamaArguments(model, port, apiKey), { windowsHide: true, stdio: 'ignore' });
    child.once('exit', () => { if (this.managed?.process === child) this.managed = null; });
    const server = { process: child, baseUrl: `http://127.0.0.1:${port}`, apiKey };
    this.managed = server;
    try { await waitForHealth(server, signal); }
    catch (error) { this.stopManaged(); throw error; }
    return server;
  }

  private async resolveModel(baseUrl: string, apiKey: string, configured: string, signal?: AbortSignal): Promise<string> {
    if (configured) return configured;
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: headers(apiKey), signal, redirect: 'error'
    });
    if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}`);
    const json = await response.json() as { data?: Array<{ id?: unknown }> };
    const id = json.data?.find((value) => typeof value.id === 'string')?.id;
    if (!id || typeof id !== 'string') throw new Error('The local server did not report a model.');
    return id;
  }

  private postCompletion(connection: { baseUrl: string; apiKey: string }, body: object, signal: AbortSignal): Promise<Response> {
    return fetch(`${connection.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { ...headers(connection.apiKey), 'content-type': 'application/json' },
      body: JSON.stringify(body), signal, redirect: 'error'
    });
  }

  private stopManaged(): void {
    const server = this.managed;
    this.managed = null;
    if (server && server.process.exitCode === null && !server.process.killed) server.process.kill();
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

async function waitForHealth(server: ManagedServer, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Managed backend startup canceled.');
    if (server.process.exitCode !== null) throw new Error('Managed backend exited during startup.');
    try {
      const response = await fetch(`${server.baseUrl}/health`, { headers: headers(server.apiKey), signal, redirect: 'error' });
      if (response.ok) return;
    } catch { /* startup is still in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Managed backend did not become ready.');
}

function userMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|network/iu.test(message)) return 'The local model server is not reachable.';
  return message.slice(0, 300) || 'Local reply suggestion failed.';
}
