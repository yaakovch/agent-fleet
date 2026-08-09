import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { discoverWslProfiles, runWslDiscovery, type WslDiscoveryRunner } from '../src/main/wsl-discovery';
import { WslProcessOwnership } from '../src/main/wsl-process-ownership';

describe('WSL discovery', () => {
  it('discovers profiles using fixed argument arrays', async () => {
    const calls: string[][] = [];
    const runner: WslDiscoveryRunner = async (args) => {
      calls.push(args);
      if (args[0] === '--list') return { status: 0, stdout: 'Ubuntu\r\n', stderr: '' };
      return {
        status: 0,
        stdout: 'user=testuser\nhome=/home/testuser\nexecutable=/usr/local/bin/codex\ncodexHome=/home/testuser/.codex\ncodexHome=/home/testuser/.codex-work\n',
        stderr: ''
      };
    };
    const result = await discoverWslProfiles(runner);
    expect(result.profiles.map((profile) => profile.codexHome)).toEqual([
      '/home/testuser/.codex',
      '/home/testuser/.codex-work'
    ]);
    expect(calls[1].slice(0, 4)).toEqual(['--distribution', 'Ubuntu', '--exec', 'sh']);
    expect(calls[1]).not.toContain('testuser');
  });

  it('returns an actionable result when WSL is unavailable', async () => {
    const result = await discoverWslProfiles(async () => ({ status: 1, stdout: '', stderr: 'WSL not installed' }));
    expect(result.wslAvailable).toBe(false);
    expect(result.warnings[0]).toContain('WSL not installed');
  });

  it('discovers distributions concurrently with a fixed upper bound', async () => {
    let active = 0;
    let peak = 0;
    const runner: WslDiscoveryRunner = async (args) => {
      if (args[0] === '--list') {
        return { status: 0, stdout: Array.from({ length: 9 }, (_, index) => `Distro-${index}`).join('\n'), stderr: '' };
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: 0, stdout: 'user=test\nhome=/home/test\n', stderr: '' };
    };

    const result = await discoverWslProfiles(runner);

    expect(result.distributions).toHaveLength(9);
    expect(peak).toBe(4);
  });

  it('keeps a timed-out discovery child owned until close confirms exit', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true)
      });
      const ownership = new WslProcessOwnership();
      const pending = runWslDiscovery(
        ['--list', '--quiet'],
        5_000,
        ownership,
        vi.fn(() => child) as unknown as typeof spawn
      );
      expect(ownership.snapshot().active).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toMatchObject({ status: null, error: expect.any(Error) });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(ownership.snapshot()).toMatchObject({ active: 1, releases: { timeout: 1 } });

      child.emit('close', null);
      expect(ownership.snapshot().active).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds child output in bytes and retains ownership until close', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true)
    });
    const ownership = new WslProcessOwnership();
    const pending = runWslDiscovery(
      ['--list', '--quiet'],
      5_000,
      ownership,
      vi.fn(() => child) as unknown as typeof spawn
    );

    child.stdout.write(Buffer.alloc(256 * 1024 + 1, 0x61));
    await expect(pending).resolves.toMatchObject({ status: null, error: expect.any(Error) });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(ownership.snapshot()).toMatchObject({ active: 1, releases: { protocol_failure: 1 } });

    child.emit('close', null);
    expect(ownership.snapshot().active).toBe(0);
  });
});
