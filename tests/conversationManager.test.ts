import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationManager } from '../src/main/conversation-manager';
import { WslProcessOwnership } from '../src/main/wsl-process-ownership';
import type { TerminalTabDescriptor } from '../src/shared/terminal';

const roots: string[] = [];
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function tempPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-fleet-conversation-'));
  roots.push(root);
  return root;
}

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
  it('kills a spawned stream when ownership registration fails', () => {
    const process = fakeProcess();
    const manager = new ConversationManager({
      tempPath: tempPath(),
      getDistro: () => 'Ubuntu',
      resolveTab: () => tab('stream'),
      sendTerminalInput: vi.fn(() => true),
      onEvent: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: vi.fn(() => process) as unknown as typeof spawn,
      processOwnership: {
        own: () => { throw new Error('ownership unavailable'); }
      } as never
    });

    expect(() => manager.start('stream')).toThrow('ownership unavailable');
    expect(process.kill).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('keeps up to four visible streams alive and only stops streams removed from the workspace', () => {
    const tabs = new Map(['one', 'two', 'three', 'four'].map((id) => [id, tab(id)]));
    const processes = [fakeProcess(), fakeProcess(), fakeProcess(), fakeProcess()];
    const spawnMock = vi.fn((_command: string, _args: readonly string[], _options: object) => processes.shift()!);
    const spawnProcess = spawnMock as unknown as typeof spawn;
    const manager = new ConversationManager({
      tempPath: tempPath(), getDistro: () => 'Ubuntu', resolveTab: (id) => tabs.get(id),
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
    const processOwnership = new WslProcessOwnership();
    const manager = new ConversationManager({
      tempPath: tempPath(), getDistro: () => 'Ubuntu', resolveTab: () => tab('history'),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: spawnMock as unknown as typeof spawn, processOwnership
    });
    const pending = manager.history('history');
    const startingOwnership = processOwnership.snapshot();
    expect(startingOwnership.active).toBe(1);
    expect(Object.entries(startingOwnership.owners)).toEqual([
      [expect.stringMatching(/^conversation-action:history:/u), 1]
    ]);
    const ansi = Buffer.from('older row\ncurrent row');
    (process.stdout as PassThrough).end(`${JSON.stringify({
      protocolVersion: 1, type: 'pane.scrollback', session: 'history', columns: 120, rows: 32,
      historyLines: 2, capturedLines: 2, truncated: false,
      revision: createHash('sha256').update(ansi).digest('hex'), ansiBase64: ansi.toString('base64')
    })}\n`);
    (process.stderr as PassThrough).end(); process.emit('exit', 0);
    await expect(pending).resolves.toMatchObject({ ok: true, pane: { type: 'pane.scrollback', session: 'history' } });
    expect(processOwnership.snapshot().active).toBe(0);
    expect(spawnMock).toHaveBeenCalledWith('wsl.exe', expect.arrayContaining([
      'pane', 'scrollback', '--host', 'gaming', '--session', 'history', '--limit', '2000'
    ]), expect.any(Object));
  });

  it('rejects a pane frame whose integrity revision does not match its ANSI', async () => {
    const process = fakeProcess();
    const manager = new ConversationManager({
      tempPath: tempPath(), getDistro: () => 'Ubuntu', resolveTab: () => tab('history'),
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

  it('terminates a bounded action when output exceeds its byte budget', async () => {
    const process = fakeProcess();
    const manager = new ConversationManager({
      tempPath: tempPath(), getDistro: () => 'Ubuntu', resolveTab: () => tab('history'),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: vi.fn(() => process) as unknown as typeof spawn
    });
    const pending = manager.history('history');
    (process.stdout as PassThrough).write(Buffer.alloc(512 * 1024 + 1, 0x61));
    expect(process.kill).toHaveBeenCalledOnce();
    process.emit('exit', null);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/safety limit/i)
    });
  });

  it('returns a bounded timeout even when the child ignores termination and never exits', async () => {
    vi.useFakeTimers();
    const process = fakeProcess();
    const processOwnership = new WslProcessOwnership({
      terminationGraceMs: 10,
      forcedTerminationGraceMs: 20
    });
    const manager = new ConversationManager({
      tempPath: tempPath(), getDistro: () => 'Ubuntu', resolveTab: () => tab('history'),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: vi.fn(() => process) as unknown as typeof spawn,
      processOwnership
    });

    const pending = manager.history('history');
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/timed out/i)
    });
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(30);
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    expect(processOwnership.snapshot()).toMatchObject({ active: 0, abandoned: 1 });
    manager.dispose();
  });

  it('measures stream frame limits in UTF-8 bytes', () => {
    const process = fakeProcess();
    const onEvent = vi.fn();
    const manager = new ConversationManager({
      tempPath: tempPath(), getDistro: () => 'Ubuntu', resolveTab: () => tab('stream'),
      sendTerminalInput: vi.fn(() => true), onEvent, logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: vi.fn(() => process) as unknown as typeof spawn
    });
    expect(manager.start('stream')).toBe(true);
    (process.stdout as PassThrough).write('😀'.repeat(131_073));
    expect(process.kill).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 'stream',
      frame: expect.objectContaining({
        type: 'conversation.error',
        error: expect.objectContaining({ code: 'oversized_frame' })
      })
    }));
  });

  it('streams selected images into a private spool and removes abandoned crash remnants', async () => {
    const root = tempPath();
    const abandoned = join(root, 'run-2147483646-00000000-0000-4000-8000-000000000000');
    mkdirSync(abandoned);
    writeFileSync(join(abandoned, '00000000-0000-4000-8000-000000000001.bin'), 'abandoned');
    const source = join(root, 'private-original-name.png');
    writeFileSync(source, PNG);
    const manager = new ConversationManager({
      tempPath: root, getDistro: () => 'Ubuntu', resolveTab: () => tab('draft'),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() },
      thumbnail: () => 'data:image/png;base64,thumbnail'
    });

    expect(() => statSync(abandoned)).toThrow();
    const staged = await manager.stageFiles('draft', [{ path: source, name: 'private-original-name.png', mime: 'image/png' }]);
    expect(staged).toHaveLength(1);
    const run = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory())!;
    const privateFiles = readdirSync(join(root, run.name));
    expect(privateFiles).toHaveLength(1);
    expect(privateFiles[0]).toMatch(/^[a-f0-9-]{36}\.bin$/u);
    expect(privateFiles[0]).not.toContain('private-original-name');
    expect(staged[0]).not.toHaveProperty('path');
    expect(staged[0]).not.toHaveProperty('sha256');
    expect(statSync(join(root, run.name)).mode & 0o077).toBe(0);
    expect(statSync(join(root, run.name, privateFiles[0])).mode & 0o077).toBe(0);

    manager.dispose();
    expect(readdirSync(root, { withFileTypes: true }).some((entry) => entry.isDirectory())).toBe(false);
  });

  it('rolls back an entire selection when a later file exceeds the bound', async () => {
    const root = tempPath();
    const valid = join(root, 'valid.png');
    const oversized = join(root, 'oversized.png');
    writeFileSync(valid, PNG);
    writeFileSync(oversized, PNG);
    truncateSync(oversized, 20 * 1024 * 1024 + 1);
    const manager = new ConversationManager({
      tempPath: root, getDistro: () => 'Ubuntu', resolveTab: () => tab('draft'),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() },
      thumbnail: () => 'data:image/png;base64,thumbnail'
    });

    await expect(manager.stageFiles('draft', [
      { path: valid, name: 'valid.png', mime: 'image/png' },
      { path: oversized, name: 'oversized.png', mime: 'image/png' }
    ])).rejects.toThrow(/20 MB/i);
    await expect(manager.stageFiles('draft', [])).resolves.toEqual([]);
    const run = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory())!;
    expect(readdirSync(join(root, run.name))).toEqual([]);
  });

  it('serializes concurrent staging and retains failed drafts only until explicit cleanup', async () => {
    const root = tempPath();
    const manager = new ConversationManager({
      tempPath: root, getDistro: () => 'Ubuntu', resolveTab: () => tab('draft'),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() },
      thumbnail: () => 'data:image/png;base64,thumbnail'
    });
    const attempts = await Promise.allSettled(Array.from({ length: 9 }, (_, index) =>
      manager.stage('draft', `image-${index}.png`, 'image/png', PNG)));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(8);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const run = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory())!;
    expect(readdirSync(join(root, run.name))).toHaveLength(8);

    await expect(manager.send('draft', 'retry this')).resolves.toMatchObject({ ok: false });
    expect(readdirSync(join(root, run.name))).toHaveLength(8);
    manager.close('draft');
    expect(readdirSync(join(root, run.name))).toEqual([]);
  });

  it('verifies the staged size and digest immediately before upload', async () => {
    const root = tempPath();
    const spawnMock = vi.fn();
    const manager = new ConversationManager({
      tempPath: root, getDistro: () => 'Ubuntu', resolveTab: () => tab('draft'),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: spawnMock as unknown as typeof spawn,
      thumbnail: () => 'data:image/png;base64,thumbnail',
      toWslPath: () => '/mnt/c/private.bin'
    });
    await manager.stage('draft', 'private.png', 'image/png', PNG);
    const run = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory())!;
    const privatePath = join(root, run.name, readdirSync(join(root, run.name))[0]);
    const changed = Buffer.from(PNG);
    changed[changed.length - 1] ^= 0xff;
    writeFileSync(privatePath, changed);

    await expect(manager.send('draft', 'do not upload corrupted bytes')).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/changed/i)
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readdirSync(join(root, run.name))).toHaveLength(1);
    manager.close('draft');
    expect(readdirSync(join(root, run.name))).toEqual([]);
  });

  it('bounds cold-start orphan cleanup work', () => {
    const root = tempPath();
    for (let index = 0; index < 130; index += 1) {
      mkdirSync(join(root, `run-2147483646-${index.toString(16).padStart(36, '0')}`));
    }
    const manager = new ConversationManager({
      tempPath: root, getDistro: () => 'Ubuntu', resolveTab: () => tab('draft'),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() },
      thumbnail: () => 'data:image/png;base64,thumbnail'
    });

    const abandoned = readdirSync(root).filter((name) => name.startsWith('run-2147483646-'));
    expect(abandoned).toHaveLength(2);
    manager.dispose();
  });

  it('rejects compressed images whose declared dimensions exceed the decode budget', async () => {
    const root = tempPath();
    const manager = new ConversationManager({
      tempPath: root, getDistro: () => 'Ubuntu', resolveTab: () => tab('draft'),
      sendTerminalInput: vi.fn(() => true), onEvent: vi.fn(), logger: { info: vi.fn(), warn: vi.fn() },
      thumbnail: () => 'data:image/png;base64,thumbnail'
    });
    const bomb = Buffer.from(PNG);
    bomb.writeUInt32BE(100_000, 16);
    bomb.writeUInt32BE(100_000, 20);

    await expect(manager.stage('draft', 'bomb.png', 'image/png', bomb)).rejects.toThrow(/dimensions/i);
    const run = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory())!;
    expect(readdirSync(join(root, run.name))).toEqual([]);
  });
});
