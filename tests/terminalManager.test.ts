import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWorkspaceState, TerminalManager, type PtyProcess } from '../src/main/terminal-manager';
import type { FleetSession } from '../src/shared/fleet';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

class FakePty implements PtyProcess {
  data?: (value: string) => void;
  exit?: (event: { exitCode: number }) => void;
  writes: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = false;
  write(data: string): void { this.writes.push(data); }
  resize(columns: number, rows: number): void { this.sizes.push([columns, rows]); }
  kill(): void { this.killed = true; }
  onData(listener: (data: string) => void): { dispose(): void } { this.data = listener; return { dispose() {} }; }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } { this.exit = listener; return { dispose() {} }; }
}

describe('embedded terminal manager', () => {
  it('spawns validated WSL attaches and persists descriptors without terminal content', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-terminal-')); roots.push(root);
    const statePath = join(root, 'workspace.json');
    const pty = new FakePty();
    const data = vi.fn();
    const spawn = vi.fn(() => pty);
    const manager = new TerminalManager({
      statePath, logger: { info: vi.fn(), warn: vi.fn() }, getDistro: () => 'Ubuntu',
      resolveSession: (id) => id === session.id ? session : undefined,
      onData: data, onStatus: vi.fn(), onClosed: vi.fn(), spawnPty: spawn,
      resolveWslExecutable: () => WINDOWS_WSL
    });
    const tab = manager.open(session);
    expect(spawn.mock.calls[0]?.slice(0, 2)).toEqual([WINDOWS_WSL, [
      '-d', 'Ubuntu', '--cd', '~', '--', '.local/bin/wtmux', '--host', 'gaming',
      '--project', 'agent-fleet', '--session', 'wtmux-agent-fleet-1', '--fast'
    ]]);
    pty.data?.('private prompt text');
    expect(data).not.toHaveBeenCalled();
    manager.bind(tab.id);
    expect(data).toHaveBeenCalledWith({ tabId: tab.id, data: 'private prompt text' });
    expect(manager.input(tab.id, 'hello\r')).toBe(true);
    expect(manager.resize(tab.id, 100, 30)).toBe(true);
    expect(pty.writes).toEqual(['hello\r']);
    expect(pty.sizes).toEqual([[100, 30]]);
    expect(readFileSync(statePath, 'utf8')).not.toContain('private prompt text');
    expect(readFileSync(statePath, 'utf8')).not.toContain('hello');
    manager.dispose();
  });

  it('restores metadata and reconnects to a still-live fleet session', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-terminal-')); roots.push(root);
    const statePath = join(root, 'workspace.json');
    const first = makeManager(statePath); const opened = first.manager.open(session); first.manager.dispose();
    const second = makeManager(statePath); const restored = second.manager.restore();
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe(opened.id);
    expect(restored[0].status).toBe('live');
    expect(second.spawn).toHaveBeenCalledOnce();
    second.manager.dispose();
  });

  it('reconciles a restored ended pane when a later fleet snapshot discovers the session', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-terminal-')); roots.push(root);
    const statePath = join(root, 'workspace.json');
    const first = makeManager(statePath); first.manager.open(session); first.manager.dispose();
    let discovered: FleetSession | undefined;
    const spawn = vi.fn(() => new FakePty());
    const manager = new TerminalManager({
      statePath, logger: { info: vi.fn(), warn: vi.fn() }, getDistro: () => 'Ubuntu',
      resolveSession: () => discovered, onData: vi.fn(), onStatus: vi.fn(), onClosed: vi.fn(),
      spawnPty: spawn, resolveWslExecutable: () => WINDOWS_WSL
    });
    expect(manager.restore()[0]).toMatchObject({ status: 'ended' });
    expect(spawn).not.toHaveBeenCalled();
    discovered = session;
    expect(manager.reconcileSessions()).toBe(1);
    expect(manager.list()[0]).toMatchObject({ status: 'live' });
    expect(spawn).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('keeps a cached session assigned while its host is offline, then reconnects or ends authoritatively', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-terminal-')); roots.push(root);
    const statePath = join(root, 'workspace.json');
    const first = makeManager(statePath); first.manager.open(session); first.manager.dispose();
    let available = false;
    let discovered: FleetSession | undefined = session;
    const spawn = vi.fn(() => new FakePty());
    const manager = new TerminalManager({
      statePath, logger: { info: vi.fn(), warn: vi.fn() }, getDistro: () => 'Ubuntu',
      resolveSession: () => discovered, isHostAvailable: () => available,
      onData: vi.fn(), onStatus: vi.fn(), onClosed: vi.fn(), spawnPty: spawn,
      resolveWslExecutable: () => WINDOWS_WSL
    });
    expect(manager.restore()[0]).toMatchObject({ status: 'offline' });
    expect(manager.getWorkspaceState().layout.root).toMatchObject({ kind: 'pane', sessionId: session.id });
    expect(spawn).not.toHaveBeenCalled();
    available = true;
    expect(manager.reconcileSessions()).toBe(1);
    expect(manager.list()[0]).toMatchObject({ status: 'live' });
    expect(spawn).toHaveBeenCalledOnce();
    discovered = undefined;
    expect(manager.reconcileSessions()).toBe(0);
    expect(manager.list()[0]).toMatchObject({ status: 'ended' });
    manager.dispose();
  });

  it('migrates a legacy single-tab workspace into the focused v2 pane', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-terminal-')); roots.push(root);
    const legacyPath = join(root, 'terminal-workspace-v1.json');
    writeFileSync(legacyPath, JSON.stringify({ version: 1, selectedTabId: 'tab-one', tabs: [{
      id: 'tab-one', sessionId: session.id, hostId: session.hostId, project: session.project,
      internalName: session.internalName, label: session.name, tool: session.tool, backend: session.backend,
      viewMode: 'terminal', status: 'live', statusMessage: 'Live'
    }] }));
    const state = readWorkspaceState(join(root, 'terminal-workspace-v2.json'), legacyPath, {
      pane: () => 'migrated-pane', split: () => 'unused-split'
    });
    expect(state.version).toBe(2);
    expect(state.tabs).toHaveLength(1);
    expect(state.layout.root).toMatchObject({ kind: 'pane', id: 'migrated-pane', sessionId: session.id, viewMode: 'terminal' });
    expect(state.layout.focusedPaneId).toBe('migrated-pane');
  });

  it('emits output for every visible terminal and buffers hidden terminals', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-terminal-')); roots.push(root);
    const firstProcess = new FakePty();
    const secondProcess = new FakePty();
    const ptys = [firstProcess, secondProcess];
    const data = vi.fn();
    const manager = new TerminalManager({
      statePath: join(root, 'workspace.json'), logger: { info: vi.fn(), warn: vi.fn() }, getDistro: () => 'Ubuntu',
      resolveSession: (id) => [session, secondSession].find((item) => item.id === id),
      onData: data, onStatus: vi.fn(), onClosed: vi.fn(), spawnPty: vi.fn(() => ptys.shift()!),
      resolveWslExecutable: () => WINDOWS_WSL
    });
    const first = manager.open(session);
    const second = manager.open(secondSession, { placement: 'split-right' });
    manager.syncBindings([first.id, second.id]);
    firstProcess.data?.('first live');
    secondProcess.data?.('second live');
    expect(data).toHaveBeenCalledWith({ tabId: first.id, data: 'first live' });
    expect(data).toHaveBeenLastCalledWith({ tabId: second.id, data: 'second live' });
    manager.syncBindings([second.id]);
    firstProcess.data?.('first buffered');
    manager.syncBindings([first.id, second.id]);
    expect(data).toHaveBeenLastCalledWith({ tabId: first.id, data: 'first buffered' });
    manager.dispose();
  });

  it('keeps rail-only sessions connection-free and enforces four assigned panes', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-terminal-')); roots.push(root);
    const sessions = Array.from({ length: 5 }, (_, index) => ({
      ...session, id: `gaming:wtmux-${index}`, internalName: `wtmux-${index}`, name: `Session ${index}`
    }));
    const spawn = vi.fn(() => new FakePty());
    const manager = new TerminalManager({
      statePath: join(root, 'workspace.json'), logger: { info: vi.fn(), warn: vi.fn() }, getDistro: () => 'Ubuntu',
      resolveSession: (id) => sessions.find((item) => item.id === id), onData: vi.fn(), onStatus: vi.fn(),
      onClosed: vi.fn(), spawnPty: spawn, resolveWslExecutable: () => WINDOWS_WSL
    });
    manager.open(sessions[0]);
    manager.open(sessions[1], { placement: 'split-right' });
    manager.open(sessions[2], { placement: 'split-down' });
    manager.open(sessions[3], { placement: 'split-right' });
    expect(manager.getWorkspaceState().tabs).toHaveLength(4);
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(() => manager.open(sessions[4], { placement: 'split-down' })).toThrow(/four sessions/i);
    expect(spawn).toHaveBeenCalledTimes(4);
    manager.dispose();
  });

  it('clears a killed session while preserving the pane leaf', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-terminal-')); roots.push(root);
    const manager = makeManager(join(root, 'workspace.json')).manager;
    manager.open(session);
    const pane = manager.getWorkspaceState().layout.root;
    expect(pane.kind).toBe('pane');
    manager.applyWorkspaceCommand({ type: 'clear', paneId: pane.id });
    expect(manager.getWorkspaceState().layout.root).toMatchObject({ kind: 'pane', id: pane.id, sessionId: null });
    expect(manager.list()).toHaveLength(0);
    manager.dispose();
  });

  it('restarts before binding when inactive output exceeded the safe buffer', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-terminal-')); roots.push(root);
    const first = new FakePty();
    const second = new FakePty();
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const data = vi.fn();
    const manager = new TerminalManager({
      statePath: join(root, 'workspace.json'), logger: { info: vi.fn(), warn: vi.fn() }, getDistro: () => 'Ubuntu',
      resolveSession: (id) => id === session.id ? session : undefined,
      onData: data, onStatus: vi.fn(), onClosed: vi.fn(), spawnPty: spawn,
      resolveWslExecutable: () => WINDOWS_WSL
    });
    const tab = manager.open(session);
    first.data?.('x'.repeat(1024 * 1024 + 1));
    manager.bind(tab.id);
    expect(first.killed).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(data).not.toHaveBeenCalled();
    second.data?.('fresh screen');
    expect(data).toHaveBeenCalledWith({ tabId: tab.id, data: 'fresh screen' });
    manager.dispose();
  });

  it('stops retrying and reports a stable failure when WSL is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-terminal-')); roots.push(root);
    const status = vi.fn();
    const spawn = vi.fn(() => new FakePty());
    const manager = new TerminalManager({
      statePath: join(root, 'workspace.json'), logger: { info: vi.fn(), warn: vi.fn() }, getDistro: () => 'Ubuntu',
      resolveSession: (id) => id === session.id ? session : undefined,
      onData: vi.fn(), onStatus: status, onClosed: vi.fn(), spawnPty: spawn,
      resolveWslExecutable: () => { throw new Error('File not found: wsl.exe'); }
    });
    const tab = manager.open(session);
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.list()[0]).toMatchObject({ id: tab.id, status: 'unavailable', failure: { code: 'wsl_not_found', retryable: false } });
    expect(manager.getHealth()).toMatchObject({ wslAvailable: false, unavailablePtys: 1, failureCodes: ['wsl_not_found'] });
    expect(status.mock.calls.at(-1)?.[0].tab.status).toBe('unavailable');
    manager.dispose();
  });
});

function makeManager(statePath: string): { manager: TerminalManager; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn(() => new FakePty());
  return { spawn, manager: new TerminalManager({
    statePath, logger: { info: vi.fn(), warn: vi.fn() }, getDistro: () => 'Ubuntu',
    resolveSession: (id) => id === session.id ? session : undefined,
    onData: vi.fn(), onStatus: vi.fn(), onClosed: vi.fn(), spawnPty: spawn,
    resolveWslExecutable: () => WINDOWS_WSL
  }) };
}

const WINDOWS_WSL = 'C:\\Windows\\System32\\wsl.exe';

const session: FleetSession = {
  id: 'gaming:wtmux-agent-fleet-1', hostId: 'gaming', internalName: 'wtmux-agent-fleet-1',
  name: 'Agent Fleet', title: 'codex', project: 'agent-fleet', projectPath: '/home/me/projects/agent-fleet',
  tool: 'codex', backend: 'linux', activity: 'active', attached: false, updatedAt: null,
  pendingScheduleCount: 0, favorite: false
};

const secondSession: FleetSession = {
  ...session,
  id: 'gaming:wtmux-agent-fleet-2',
  internalName: 'wtmux-agent-fleet-2',
  name: 'Agent Fleet 2'
};
