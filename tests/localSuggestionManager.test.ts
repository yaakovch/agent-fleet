import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalSuggestionManager, managedLlamaArguments } from '../src/main/local-suggestion-manager';
import { LocalSuggestionStore } from '../src/main/local-suggestion-store';

const servers: Array<ReturnType<typeof createServer>> = [];
const roots: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(): LocalSuggestionStore {
  const root = mkdtempSync(join(tmpdir(), 'agent-fleet-manager-'));
  roots.push(root);
  return new LocalSuggestionStore(join(root, 'settings.json'), {
    encrypt: (value) => `x:${value}`,
    decrypt: (value) => value.slice(2)
  });
}

function managedStore(): LocalSuggestionStore {
  const result = store();
  const root = mkdtempSync(join(tmpdir(), 'agent-fleet-managed-'));
  roots.push(root);
  const executablePath = join(root, 'llama-server.exe');
  const modelPath = join(root, 'model.gguf');
  writeFileSync(executablePath, '');
  writeFileSync(modelPath, '');
  chmodSync(executablePath, 0o700);
  result.save({
    ...result.view(),
    mode: 'manual',
    backend: 'managedLlamaCpp',
    managed: { executablePath, modelPath },
    external: { ...result.view().external, modelId: 'configured-model' }
  });
  return result;
}

function managedChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    killed: false,
    exitCode: null,
    kill: vi.fn(() => true)
  }) as unknown as ChildProcess;
}

function completion(suggestion: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ suggestions: [suggestion] }) } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function fakeServer(): Promise<{ url: string; requests: Array<{ url: string; authorization: string; body: string }> }> {
  const requests: Array<{ url: string; authorization: string; body: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url ?? '', authorization: String(request.headers.authorization ?? ''), body });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/models') response.end(JSON.stringify({ data: [{ id: 'gemma-local' }] }));
      else response.end(JSON.stringify({ choices: [{ message: { content: '{"suggestions":["I would keep the current scope.","Please show me the tradeoff first."]}' } }] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

describe('local suggestion manager', () => {
  it('constructs only fixed safe managed-server arguments', () => {
    expect(managedLlamaArguments('C:\\models\\gemma.gguf', 43123, 'random-key')).toEqual([
      '--host', '127.0.0.1', '--port', '43123', '--model', 'C:\\models\\gemma.gguf',
      '--ctx-size', '4096', '--gpu-layers', 'auto', '--api-key', 'random-key',
      '--sleep-idle-seconds', '60'
    ]);
  });

  it('discovers a loopback model and returns bounded parsed suggestions', async () => {
    const fake = await fakeServer();
    const path = join(mkdtempSync(join(tmpdir(), 'agent-fleet-manager-')), 'settings.json');
    const store = new LocalSuggestionStore(path, { encrypt: (value) => `x:${value}`, decrypt: (value) => value.slice(2) });
    store.save({ ...store.view(), mode: 'manual', backend: 'openAICompatible', external: { ...store.view().external, baseUrl: fake.url, bearerToken: 'local-key' } });
    const manager = new LocalSuggestionManager(store);
    const result = await manager.suggest({
      requestId: 'request-1', tabId: 'tab-1', revision: 'revision-1', target: { kind: 'composer' },
      messages: [{ role: 'assistant', text: 'Do you want me to expand the scope?' }]
    });
    expect(result.ok).toBe(true);
    expect(result.suggestions).toEqual(['I would keep the current scope.', 'Please show me the tradeoff first.']);
    expect(fake.requests.map((request) => request.url)).toEqual(['/v1/models', '/v1/chat/completions']);
    expect(fake.requests.every((request) => request.authorization === 'Bearer local-key')).toBe(true);
    expect(fake.requests[1].body).not.toContain('terminal');
    manager.dispose();
  });

  it('rejects non-loopback external servers before making a request', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agent-fleet-manager-')), 'settings.json');
    const store = new LocalSuggestionStore(path, { encrypt: String, decrypt: String });
    store.save({ ...store.view(), mode: 'manual', backend: 'openAICompatible', external: { ...store.view().external, baseUrl: 'https://example.com' } });
    const manager = new LocalSuggestionManager(store);
    const result = await manager.suggest({ requestId: 'r', tabId: 't', revision: 'v', target: { kind: 'composer' }, messages: [] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('loopback');
  });

  it('shares one managed startup generation and installs a child error listener', async () => {
    const settings = managedStore();
    const child = managedChild();
    let releasePort!: (port: number) => void;
    const port = new Promise<number>((resolve) => { releasePort = resolve; });
    const availablePort = vi.fn(() => port);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const fetchProcess = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const manager = new LocalSuggestionManager(settings, { availablePort, spawnProcess, fetch: fetchProcess });

    const first = manager.test();
    const second = manager.test();
    expect(availablePort).toHaveBeenCalledOnce();
    releasePort(43123);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true })
    ]);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect((child as unknown as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
    manager.dispose();
  });

  it('turns a managed child error into a bounded failed operation', async () => {
    const settings = managedStore();
    const child = managedChild();
    let releaseHealth!: (response: Response) => void;
    const health = new Promise<Response>((resolve) => { releaseHealth = resolve; });
    const manager = new LocalSuggestionManager(settings, {
      availablePort: async () => 43123,
      spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
      fetch: vi.fn(() => health) as unknown as typeof fetch
    });

    const pending = manager.test();
    await vi.waitFor(() => expect((child as unknown as EventEmitter).listenerCount('error')).toBeGreaterThan(0));
    (child as unknown as EventEmitter).emit('error', new Error('managed spawn failed'));
    releaseHealth(new Response('{}', { status: 200 }));

    await expect(pending).resolves.toMatchObject({ ok: false, message: 'managed spawn failed' });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('prevents a stopped startup generation from spawning or replacing newer settings', async () => {
    const settings = managedStore();
    const oldManaged = settings.view().managed;
    let releaseOldPort!: (port: number) => void;
    const oldPort = new Promise<number>((resolve) => { releaseOldPort = resolve; });
    const availablePort = vi.fn()
      .mockReturnValueOnce(oldPort)
      .mockResolvedValueOnce(43124);
    const child = managedChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const manager = new LocalSuggestionManager(settings, {
      availablePort,
      spawnProcess,
      fetch: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    });

    const staleTest = manager.test();
    await manager.save({
      ...settings.view(),
      managed: { ...oldManaged, modelPath: `${oldManaged.modelPath}.replacement` }
    });
    writeFileSync(`${oldManaged.modelPath}.replacement`, '');
    releaseOldPort(43123);
    await expect(staleTest).resolves.toMatchObject({ ok: false });
    expect(spawnProcess).not.toHaveBeenCalled();

    await expect(manager.test()).resolves.toMatchObject({ ok: true });
    expect(spawnProcess).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('does not let a superseded duplicate request clear or complete the newer generation', async () => {
    const settings = store();
    settings.save({
      ...settings.view(),
      mode: 'manual',
      backend: 'openAICompatible',
      external: { ...settings.view().external, modelId: 'configured-model' }
    });
    const resolvers: Array<(response: Response) => void> = [];
    const fetchProcess = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve))) as unknown as typeof fetch;
    const manager = new LocalSuggestionManager(settings, { fetch: fetchProcess });
    const request = {
      requestId: 'duplicate', tabId: 'tab', revision: 'revision',
      target: { kind: 'composer' as const }, messages: []
    };

    const stale = manager.suggest(request);
    await vi.waitFor(() => expect(fetchProcess).toHaveBeenCalledTimes(1));
    const current = manager.suggest(request);
    await vi.waitFor(() => expect(fetchProcess).toHaveBeenCalledTimes(2));
    resolvers[0](completion('stale'));
    await expect(stale).resolves.toMatchObject({ ok: false, suggestions: [] });

    manager.cancel('duplicate');
    resolvers[1](completion('current'));
    await expect(current).resolves.toMatchObject({ ok: false, suggestions: [] });
  });

  it('rejects an oversized local-model response without buffering it unboundedly', async () => {
    const settings = store();
    settings.save({
      ...settings.view(),
      mode: 'manual',
      backend: 'openAICompatible',
      external: { ...settings.view().external, modelId: 'configured-model' }
    });
    const manager = new LocalSuggestionManager(settings, {
      fetch: vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'x'.repeat(1024 * 1024) } }]
      }), { status: 200 })) as unknown as typeof fetch
    });

    await expect(manager.suggest({
      requestId: 'oversized',
      tabId: 'tab',
      revision: 'revision',
      target: { kind: 'composer' },
      messages: []
    })).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('safety limit')
    });
  });

  it('cancels every unused managed health response body', async () => {
    const settings = managedStore();
    const child = managedChild();
    const cancellations = [vi.fn((): void => undefined), vi.fn((): void => undefined)];
    let attempt = 0;
    const healthResponse = (status: number, canceled: () => void): Response =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{}'));
        },
        cancel: () => { canceled(); }
      }), { status });
    const manager = new LocalSuggestionManager(settings, {
      availablePort: async () => 43123,
      spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
      fetch: vi.fn(async () => {
        const index = Math.min(attempt, 1);
        attempt += 1;
        return healthResponse(index === 0 ? 503 : 200, cancellations[index]);
      }) as unknown as typeof fetch
    });

    await expect(manager.test()).resolves.toMatchObject({ ok: true });
    expect(cancellations[0]).toHaveBeenCalledOnce();
    expect(cancellations[1]).toHaveBeenCalledOnce();
    manager.dispose();
  });
});
