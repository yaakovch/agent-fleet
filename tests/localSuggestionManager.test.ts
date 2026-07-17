import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalSuggestionManager, managedLlamaArguments } from '../src/main/local-suggestion-manager';
import { LocalSuggestionStore } from '../src/main/local-suggestion-store';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

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
    store.save({ ...store.view(), enabled: true, backend: 'openAICompatible', external: { ...store.view().external, baseUrl: fake.url, bearerToken: 'local-key' } });
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
    store.save({ ...store.view(), enabled: true, backend: 'openAICompatible', external: { ...store.view().external, baseUrl: 'https://example.com' } });
    const manager = new LocalSuggestionManager(store);
    const result = await manager.suggest({ requestId: 'r', tabId: 't', revision: 'v', target: { kind: 'composer' }, messages: [] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('loopback');
  });
});
