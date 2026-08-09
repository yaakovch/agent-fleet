import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('main/preload IPC boundary wiring', () => {
  it('routes every preload invocation through the shared payload validator', () => {
    const source = readFileSync('src/preload/index.ts', 'utf8');
    expect(source.match(/ipcRenderer\.invoke\(/gu)).toHaveLength(1);
    expect(source).toContain('assertIpcPayload(channel, args)');
    expect(source).toContain('assertIpcEventPayload(channel, value)');
  });

  it('validates payloads and renderer roles before dispatching main handlers', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const trusted = source.indexOf("throw new Error('Rejected IPC from an untrusted sender')");
    const payload = source.indexOf('assertIpcPayload(channel, args)', trusted);
    const role = source.indexOf('rendererAccess.assertAnyRole(event.sender.id, allowedRendererRoles(channel))', payload);
    const dispatch = source.indexOf('return listener(event, ...(args as never[]))', role);
    expect(trusted).toBeGreaterThan(0);
    expect(payload).toBeGreaterThan(trusted);
    expect(role).toBeGreaterThan(payload);
    expect(dispatch).toBeGreaterThan(role);
  });

  it('revokes content grants and private drafts from the terminal close callback', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const closedHandler = source.slice(
      source.indexOf('onClosed: (event) => {'),
      source.indexOf('onWorkspace:', source.indexOf('onClosed: (event) => {'))
    );
    expect(closedHandler).toContain('rendererAccess.revokeTab(event.tabId)');
    expect(closedHandler).toContain('conversationManager.close(event.tabId)');
  });

  it('authorizes Native history through the conversation binding', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const handler = source.slice(
      source.indexOf('handle(IPC_CHANNELS.conversationHistory'),
      source.indexOf('handle(IPC_CHANNELS.conversationPage')
    );
    expect(handler).toContain("requireContent(event, 'conversation', tabId)");
    expect(handler).not.toContain("requireContent(event, 'terminal', tabId)");
  });

  it('lets the shared role gate authorize diagnostics copy from Settings', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const handler = source.slice(
      source.indexOf('handle(IPC_CHANNELS.conversationCopyText'),
      source.indexOf('handle(IPC_CHANNELS.killFleetSession')
    );
    expect(handler).toContain('clipboard.writeText(text)');
    expect(handler).not.toContain('requireDashboard(event)');
  });

  it('reads settings imports through a bounded same-descriptor snapshot', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    expect(source).toContain('readFileSnapshot(importPath, MAX_SETTINGS_IMPORT_BYTES).data');
    expect(source).not.toContain('parseSettingsImport(readFileSync');
  });

  it('resets notification state before constructing a replacement fleet bridge', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    expect(source).toMatch(
      /fleetBridge\.stop\(\);\s+fleetNotificationTracker\.reset\(\);\s+fleetBridge = createFleetBridge\(\);/u
    );
  });
});
