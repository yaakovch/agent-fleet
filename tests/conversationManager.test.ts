import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { ConversationManager } from '../src/main/conversation-manager';
import type { TerminalTabDescriptor } from '../src/shared/terminal';

function fakeProcess(): ChildProcess {
  const process = new EventEmitter() as ChildProcess;
  Object.assign(process, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  });
  return process;
}

function tab(id: string): TerminalTabDescriptor {
  return {
    id, sessionId: `gaming:${id}`, hostId: 'gaming', project: 'agent-fleet', internalName: id,
    label: id, tool: 'codex', backend: 'linux', viewMode: 'native', status: 'live', statusMessage: 'Live'
  };
}

describe('native conversation streams', () => {
  it('keeps up to four visible streams alive and only stops streams removed from the workspace', () => {
    const tabs = new Map(['one', 'two', 'three', 'four'].map((id) => [id, tab(id)]));
    const processes = [fakeProcess(), fakeProcess(), fakeProcess(), fakeProcess()];
    const spawnMock = vi.fn((_command: string, _args: readonly string[], _options: object) => processes.shift()!);
    const spawnProcess = spawnMock as unknown as typeof spawn;
    const manager = new ConversationManager({
      tempPath: 'unused', getDistro: () => 'Ubuntu', resolveTab: (id) => tabs.get(id),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() }, spawnProcess
    });
    expect(manager.sync(['one', 'two', 'three', 'four', 'ignored'])).toEqual(['one', 'two', 'three', 'four']);
    expect(spawnMock).toHaveBeenCalledTimes(4);
    const first = spawnMock.mock.results[0].value as ChildProcess;
    const second = spawnMock.mock.results[1].value as ChildProcess;
    expect(manager.sync(['two', 'three', 'four'])).toEqual(['two', 'three', 'four']);
    expect(first.kill).toHaveBeenCalledOnce();
    expect(second.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(4);
    manager.dispose();
    expect(second.kill).toHaveBeenCalledOnce();
  });

  it('loads integrity-checked tmux pane scrollback without starting a conversation stream', async () => {
    const process = fakeProcess();
    const spawnMock = vi.fn((_command: string, _args: readonly string[], _options: object) => process);
    const manager = new ConversationManager({
      tempPath: 'unused', getDistro: () => 'Ubuntu', resolveTab: () => tab('history'),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: spawnMock as unknown as typeof spawn
    });
    const pending = manager.history('history');
    const ansi = Buffer.from('older row\ncurrent row');
    (process.stdout as PassThrough).end(`${JSON.stringify({
      protocolVersion: 1, type: 'pane.scrollback', session: 'history', columns: 120, rows: 32,
      historyLines: 2, capturedLines: 2, truncated: false,
      revision: createHash('sha256').update(ansi).digest('hex'), ansiBase64: ansi.toString('base64')
    })}\n`);
    (process.stderr as PassThrough).end(); process.emit('exit', 0);
    await expect(pending).resolves.toMatchObject({ ok: true, pane: { type: 'pane.scrollback', session: 'history' } });
    expect(spawnMock).toHaveBeenCalledWith('wsl.exe', expect.arrayContaining([
      'pane', 'scrollback', '--host', 'gaming', '--session', 'history', '--limit', '2000'
    ]), expect.any(Object));
  });

  it('rejects a pane frame whose integrity revision does not match its ANSI', async () => {
    const process = fakeProcess();
    const manager = new ConversationManager({
      tempPath: 'unused', getDistro: () => 'Ubuntu', resolveTab: () => tab('history'),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: vi.fn(() => process) as unknown as typeof spawn
    });
    const pending = manager.history('history');
    (process.stdout as PassThrough).end(`${JSON.stringify({
      protocolVersion: 1, type: 'pane.scrollback', session: 'history', columns: 120, rows: 32,
      historyLines: 1, capturedLines: 1, truncated: false, revision: '0'.repeat(64), ansiBase64: 'cm93'
    })}\n`);
    (process.stderr as PassThrough).end(); process.emit('exit', 0);
    await expect(pending).resolves.toMatchObject({ ok: false });
  });
});
