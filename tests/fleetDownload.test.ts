import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetDownloadManager, verifyLocalArtifact, windowsPathToWsl } from '../src/main/fleet-download';
import type { FleetDownloadJob } from '../src/shared/app';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    killed: false, kill: vi.fn(() => true)
  });
}

function target(name = 'file.bin', size = 1) {
  return {
    sessionId: 'host:session-1', hostId: 'host', internalName: 'session-1',
    relativePath: `build/${name}`, name, size
  };
}

describe('fleet repository downloads', () => {
  it('maps a local Windows Downloads path into a direct WSL argument', () => {
    expect(windowsPathToWsl('C:\\Users\\Yaakov\\Downloads')).toBe('/mnt/c/Users/Yaakov/Downloads');
    expect(() => windowsPathToWsl('\\\\server\\share')).toThrow(/local drive/i);
  });

  it('hashes the final local file through one open descriptor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-download-'));
    roots.push(root);
    const path = join(root, 'artifact.bin');
    const payload = Buffer.from('verified download');
    writeFileSync(path, payload);
    const sha256 = createHash('sha256').update(payload).digest('hex');

    await expect(verifyLocalArtifact(path, payload.length, sha256)).resolves.toBe(true);
    await expect(verifyLocalArtifact(path, payload.length + 1, sha256)).resolves.toBe(false);
    await expect(verifyLocalArtifact(path, payload.length, '0'.repeat(64))).resolves.toBe(false);
  });

  it('does not verify an artifact through a symbolic link', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-download-'));
    roots.push(root);
    const targetPath = join(root, 'target.bin');
    const linkPath = join(root, 'download.bin');
    const payload = Buffer.from('verified download');
    writeFileSync(targetPath, payload);
    try {
      symlinkSync(targetPath, linkPath);
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    const sha256 = createHash('sha256').update(payload).digest('hex');
    await expect(verifyLocalArtifact(linkPath, payload.length, sha256)).resolves.toBe(false);
  });

  it('destroys a blocked artifact read immediately when verification is aborted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-download-'));
    roots.push(root);
    const path = join(root, 'blocked.bin');
    const payload = Buffer.from('blocked verification');
    writeFileSync(path, payload);
    const probe = await open(path, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      createReadStream: typeof probe.createReadStream;
    };
    await probe.close();
    const blocked = new Readable({ read: () => undefined });
    const destroy = vi.spyOn(blocked, 'destroy');
    const createReadStream = vi.spyOn(fileHandlePrototype, 'createReadStream')
      .mockReturnValueOnce(blocked as never);
    const abort = new AbortController();
    try {
      const verification = verifyLocalArtifact(
        path,
        payload.length,
        createHash('sha256').update(payload).digest('hex'),
        abort.signal
      );
      await vi.waitFor(() => expect(createReadStream).toHaveBeenCalledOnce());
      abort.abort();
      await expect(verification).resolves.toBe(false);
      expect(destroy).toHaveBeenCalled();
    } finally {
      createReadStream.mockRestore();
    }
  });

  it('reports locally verified background progress and completion only after process close', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as never;
    const updates: FleetDownloadJob[] = [];
    const verifyArtifact = vi.fn(async () => true);
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'C:\\Users\\Yaakov\\Downloads',
      onUpdate: (job) => updates.push(job), spawnProcess, verifyArtifact,
      wslExecutable: () => 'C:\\Windows\\System32\\wsl.exe'
    });
    const started = manager.start({
      sessionId: 'host:session-1', hostId: 'host', internalName: 'session-1',
      relativePath: 'build/report.pdf', name: 'report.pdf', size: 12
    });
    child.stderr.write('{"type":"progress","received":12,"total":12}\n');
    child.stdout.write(`{"status":"downloaded","name":"report.pdf","size":12,"sha256":"${'ab'.repeat(32)}"}\n`);
    child.emit('exit', 0);
    expect(manager.get(started.id)?.state).toBe('running');
    child.emit('close', 0);
    await vi.waitFor(() => expect(manager.get(started.id)?.state).toBe('completed'));
    expect(spawnProcess).toHaveBeenCalledWith('C:\\Windows\\System32\\wsl.exe', expect.arrayContaining([
      'file', 'download', '--path', 'build/report.pdf', '--output-dir', '/mnt/c/Users/Yaakov/Downloads'
    ]), expect.any(Object));
    expect(manager.get(started.id)).toMatchObject({
      state: 'completed', received: 12, path: 'C:\\Users\\Yaakov\\Downloads\\report.pdf'
    });
    expect(updates.some((job) => job.message.includes('100%'))).toBe(true);
    expect(verifyArtifact).toHaveBeenCalledWith(
      'C:\\Users\\Yaakov\\Downloads\\report.pdf',
      12,
      'ab'.repeat(32),
      expect.any(AbortSignal)
    );
  });

  it('does not report cancellation complete until the child and its streams close', async () => {
    const child = fakeChild();
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: vi.fn(() => child) as never, wslExecutable: () => 'wsl.exe'
    });
    const job = manager.start(target());
    let settled = false;
    const cancellation = manager.cancel(job.id).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(manager.get(job.id)).toMatchObject({ state: 'running', message: 'Cancelling download…' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', null);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', null);
    await expect(cancellation).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('bounds manager shutdown when a download child ignores every termination signal', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: vi.fn(() => child) as never, wslExecutable: () => 'wsl.exe',
      cancelTimeoutMs: 20
    });
    manager.start(target('stuck.bin'));

    const stopping = manager.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(10);
    await expect(stopping).resolves.toBeUndefined();
  });

  it('bounds cancellation while final artifact verification is stalled', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    let verificationSignal: AbortSignal | undefined;
    const verifyArtifact = vi.fn((_path, _size, _sha256, signal?: AbortSignal) => {
      verificationSignal = signal;
      return new Promise<boolean>(() => undefined);
    });
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: vi.fn(() => child) as never, wslExecutable: () => 'wsl.exe',
      cancelTimeoutMs: 20, verifyArtifact
    });
    const job = manager.start(target('verifying.bin', 4));
    child.stdout.write(`{"status":"downloaded","name":"verifying.bin","size":4,"sha256":"${'ab'.repeat(32)}"}\n`);
    child.emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(verifyArtifact).toHaveBeenCalledOnce();

    const cancellation = manager.cancel(job.id);
    expect(verificationSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    await expect(cancellation).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('bounds verification before use even when a verifier never resolves', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const verifyArtifact = vi.fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => new Promise<boolean>(() => undefined));
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: vi.fn(() => child) as never, wslExecutable: () => 'wsl.exe',
      verificationTimeoutMs: 20, verifyArtifact
    });
    const job = manager.start(target('bounded.bin', 3));
    child.stdout.write(`{"status":"downloaded","name":"bounded.bin","size":3,"sha256":"${'cd'.repeat(32)}"}\n`);
    child.emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.get(job.id)?.state).toBe('completed');

    const verification = manager.verifyForUse(job.id);
    await vi.advanceTimersByTimeAsync(20);
    await expect(verification).resolves.toMatchObject({
      state: 'failed',
      message: 'Downloaded file failed integrity verification'
    });
  });

  it('reserves case-insensitive destination names across concurrent downloads', async () => {
    const child = fakeChild();
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: vi.fn(() => child) as never, wslExecutable: () => 'wsl.exe'
    });
    const first = manager.start(target('Report.pdf'));

    expect(() => manager.start({
      ...target('report.pdf'),
      relativePath: 'other/report.pdf'
    })).toThrow(/destination/i);
    expect(manager.get(first.id)?.state).toBe('running');

    const cancellation = manager.cancel(first.id);
    child.emit('close', null);
    await expect(cancellation).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('rejects a completion record that does not prove the expected size and digest', async () => {
    const child = fakeChild();
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: vi.fn(() => child) as never, wslExecutable: () => 'wsl.exe'
    });
    const job = manager.start(target('file.bin', 4));
    child.stdout.write('{"status":"downloaded","name":"file.bin","size":3,"sha256":"bad"}\n');
    child.emit('close', 0);
    await vi.waitFor(() => expect(manager.get(job.id)?.state).toBe('failed'));
  });

  it('rejects a host result that redirects the download to another basename', async () => {
    const child = fakeChild();
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: vi.fn(() => child) as never, wslExecutable: () => 'wsl.exe'
    });
    const job = manager.start(target('expected.bin', 4));
    child.stdout.write(`{"status":"downloaded","name":"other.bin","size":4,"sha256":"${'ab'.repeat(32)}"}\n`);
    child.emit('close', 0);
    await vi.waitFor(() => expect(manager.get(job.id)).toMatchObject({
      state: 'failed',
      message: 'Host returned an invalid download result'
    }));
  });

  it('accepts only the runtime collision suffix derived from the requested basename', async () => {
    const child = fakeChild();
    const verifyArtifact = vi.fn(async () => true);
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: vi.fn(() => child) as never, wslExecutable: () => 'wsl.exe', verifyArtifact
    });
    const job = manager.start(target('report.final.pdf', 4));
    child.stdout.write(`{"status":"downloaded","name":"report (1).final.pdf","size":4,"sha256":"${'ab'.repeat(32)}"}\n`);
    child.emit('close', 0);

    await vi.waitFor(() => expect(manager.get(job.id)).toMatchObject({
      state: 'completed',
      name: 'report (1).final.pdf',
      path: 'D:\\Downloads\\report (1).final.pdf'
    }));
    expect(verifyArtifact).toHaveBeenCalledWith(
      'D:\\Downloads\\report (1).final.pdf',
      4,
      'ab'.repeat(32),
      expect.any(AbortSignal)
    );
  });

  it('bounds active WSL downloads and retains a slot through final hash verification', async () => {
    const children = [fakeChild(), fakeChild()];
    let spawnIndex = 0;
    const spawnProcess = vi.fn(() => children[spawnIndex++]);
    let releaseVerification = (): void => undefined;
    const verification = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const verifyArtifact = vi.fn(async () => { await verification; return true; });
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: spawnProcess as never, wslExecutable: () => 'wsl.exe', maxConcurrent: 1, verifyArtifact
    });
    const first = manager.start(target('first.bin', 1));
    const second = manager.start(target('second.bin', 1));
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(manager.get(second.id)?.message).toMatch(/Waiting/);

    children[0].stdout.write(`{"status":"downloaded","name":"first.bin","size":1,"sha256":"${'11'.repeat(32)}"}\n`);
    children[0].emit('close', 0);
    await vi.waitFor(() => expect(verifyArtifact).toHaveBeenCalledTimes(1));
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    releaseVerification();
    await vi.waitFor(() => expect(manager.get(first.id)?.state).toBe('completed'));
    expect(spawnProcess).toHaveBeenCalledTimes(2);

    const cancellation = manager.cancel(second.id);
    children[1].emit('close', null);
    await expect(cancellation).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('reverifies the exact artifact immediately before use and revokes a tampered completion', async () => {
    const child = fakeChild();
    const verifyArtifact = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: vi.fn(() => child) as never, wslExecutable: () => 'wsl.exe', verifyArtifact
    });
    const job = manager.start(target('file.bin', 3));
    child.stdout.write(`{"status":"downloaded","name":"file.bin","size":3,"sha256":"${'cd'.repeat(32)}"}\n`);
    child.emit('close', 0);
    await vi.waitFor(() => expect(manager.get(job.id)?.state).toBe('completed'));

    await expect(manager.verifyForUse(job.id)).resolves.toMatchObject({
      state: 'failed',
      message: 'Downloaded file failed integrity verification'
    });
    expect(manager.get(job.id)?.path).toBeUndefined();
    expect(verifyArtifact).toHaveBeenNthCalledWith(
      2,
      'D:\\Downloads\\file.bin',
      3,
      'cd'.repeat(32),
      expect.any(AbortSignal)
    );
  });
});
