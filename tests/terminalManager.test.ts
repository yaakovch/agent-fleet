import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalManager, type PtyProcess } from '../src/main/terminal-manager';
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
      onData: data, onStatus: vi.fn(), onClosed: vi.fn(), spawnPty: spawn
    });
    const tab = manager.open(session);
    expect(spawn.mock.calls[0]?.slice(0, 2)).toEqual(['wsl.exe', [
      '-d', 'Ubuntu', '--cd', '~', '--', '.local/bin/wtmux', '--host', 'gaming',
      '--project', 'agent-fleet', '--session', 'wtmux-agent-fleet-1', '--fast'
    ]]);
    pty.data?.('private prompt text');
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
});

function makeManager(statePath: string): { manager: TerminalManager; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn(() => new FakePty());
  return { spawn, manager: new TerminalManager({
    statePath, logger: { info: vi.fn(), warn: vi.fn() }, getDistro: () => 'Ubuntu',
    resolveSession: (id) => id === session.id ? session : undefined,
    onData: vi.fn(), onStatus: vi.fn(), onClosed: vi.fn(), spawnPty: spawn
  }) };
}

const session: FleetSession = {
  id: 'gaming:wtmux-agent-fleet-1', hostId: 'gaming', internalName: 'wtmux-agent-fleet-1',
  name: 'Agent Fleet', title: 'codex', project: 'agent-fleet', projectPath: '/home/me/projects/agent-fleet',
  tool: 'codex', backend: 'linux', activity: 'active', attached: false, updatedAt: null,
  pendingScheduleCount: 0, favorite: false
};
