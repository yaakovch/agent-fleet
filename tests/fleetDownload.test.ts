import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { FleetDownloadManager, windowsPathToWsl } from '../src/main/fleet-download';
import type { FleetDownloadJob } from '../src/shared/app';

describe('fleet repository downloads', () => {
  it('maps a local Windows Downloads path into a direct WSL argument', () => {
    expect(windowsPathToWsl('C:\\Users\\Yaakov\\Downloads')).toBe('/mnt/c/Users/Yaakov/Downloads');
    expect(() => windowsPathToWsl('\\\\server\\share')).toThrow(/local drive/i);
  });

  it('reports verified background progress and completion', () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      killed: false, kill: vi.fn(() => true)
    });
    const spawnProcess = vi.fn(() => child) as never;
    const updates: FleetDownloadJob[] = [];
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'C:\\Users\\Yaakov\\Downloads',
      onUpdate: (job) => updates.push(job), spawnProcess, wslExecutable: () => 'C:\\Windows\\System32\\wsl.exe'
    });
    const started = manager.start({
      sessionId: 'host:session-1', hostId: 'host', internalName: 'session-1',
      relativePath: 'build/report.pdf', name: 'report.pdf', size: 12
    });
    child.stderr.write('{"type":"progress","received":12,"total":12}\n');
    child.stdout.write(`{"status":"downloaded","name":"report.pdf","size":12,"sha256":"${'ab'.repeat(32)}"}\n`);
    child.emit('exit', 0);
    expect(spawnProcess).toHaveBeenCalledWith('C:\\Windows\\System32\\wsl.exe', expect.arrayContaining([
      'file', 'download', '--path', 'build/report.pdf', '--output-dir', '/mnt/c/Users/Yaakov/Downloads'
    ]), expect.any(Object));
    expect(manager.get(started.id)).toMatchObject({
      state: 'completed', received: 12, path: 'C:\\Users\\Yaakov\\Downloads\\report.pdf'
    });
    expect(updates.some((job) => job.message.includes('100%'))).toBe(true);
  });

  it('marks active work cancelled and terminates its WSL process', () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      killed: false, kill: vi.fn(() => true)
    });
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: vi.fn(() => child) as never, wslExecutable: () => 'wsl.exe'
    });
    const job = manager.start({
      sessionId: 'host:session-1', hostId: 'host', internalName: 'session-1',
      relativePath: 'file.bin', name: 'file.bin', size: 1
    });
    expect(manager.cancel(job.id)?.state).toBe('cancelled');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects a completion record that does not prove the expected size and digest', () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      killed: false, kill: vi.fn(() => true)
    });
    const manager = new FleetDownloadManager({
      distro: () => 'Ubuntu', downloadsDirectory: () => 'D:\\Downloads', onUpdate: () => undefined,
      spawnProcess: vi.fn(() => child) as never, wslExecutable: () => 'wsl.exe'
    });
    const job = manager.start({
      sessionId: 'host:session-1', hostId: 'host', internalName: 'session-1',
      relativePath: 'file.bin', name: 'file.bin', size: 4
    });
    child.stdout.write('{"status":"downloaded","name":"file.bin","size":3,"sha256":"bad"}\n');
    child.emit('exit', 0);
    expect(manager.get(job.id)?.state).toBe('failed');
  });
});
