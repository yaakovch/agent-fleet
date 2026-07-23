import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WslRuntimeManager } from '../src/main/wsl-runtime-manager';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function resources(): { root: string; bundle: string; descriptor: Record<string, unknown> } {
  const root = mkdtempSync(join(tmpdir(), 'agent-fleet-wsl-runtime-')); roots.push(root);
  const runtime = join(root, 'runtime'); mkdirSync(runtime);
  const payload = Buffer.from('verified runtime bundle');
  const bundle = join(runtime, 'wtmux-runtime-git-deadbee.tar');
  writeFileSync(bundle, payload);
  const descriptor = {
    schemaVersion: 1,
    baselineVersion: 'git-deadbee',
    sourceRepository: 'https://github.com/yaakovch/wtmux',
    sourceCommit: '1'.repeat(40),
    contractPackageVersion: '1.3.0',
    components: {
      clientRuntime: { sequence: 45, version: 'git-deadbee' },
      hostRuntime: { sequence: 38, version: 'git-deadbee' },
      providerAdapters: { sequence: 13, version: 'git-deadbee' },
      contracts: { sequence: 13, version: '1.3.0' }
    },
    runtime: {
      file: 'wtmux-runtime-git-deadbee.tar',
      sha256: createHash('sha256').update(payload).digest('hex'),
      size: payload.length,
      sbomSha256: '2'.repeat(64),
      licenseSha256: '3'.repeat(64)
    }
  };
  writeFileSync(join(runtime, 'embedded-runtime-v1.json'), JSON.stringify(descriptor));
  return { root, bundle, descriptor };
}

function readyStatus() {
  return {
    current: 'git-deadbee',
    previous: '',
    activationPhase: 'committed',
    activationFailureCode: '',
    components: {
      clientRuntime: { sequence: 45, version: 'git-deadbee' },
      hostRuntime: { sequence: 38, version: 'git-deadbee' },
      providerAdapters: { sequence: 13, version: 'git-deadbee' },
      contracts: { sequence: 13, version: '1.3.0' }
    },
    source: { commit: '1'.repeat(40), contractPackageVersion: '1.3.0' }
  };
}

describe('app-owned WSL runtime manager', () => {
  it('provisions from the embedded artifact and resolves only the activated runtime', async () => {
    const fixture = resources();
    let installed = false;
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('status')) {
        if (!installed) throw new Error('runtime missing');
        return { stdout: JSON.stringify(readyStatus()), stderr: '' };
      }
      expect(args).toContain('sh');
      expect(args.join(' ')).toContain('wslpath');
      installed = true;
      return { stdout: '{}', stderr: '' };
    });
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });
    await expect(manager.ensure()).resolves.toMatchObject({
      status: 'ready', current: 'git-deadbee', contractPackageVersion: '1.3.0'
    });
    expect(manager.runtimeCommand('wtmux')).toBe('.local/share/agent-fleet/wtmux/current/scripts/wtmux');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('reports selected-version skew before clients use the runtime', async () => {
    const fixture = resources();
    const status = readyStatus();
    status.components.hostRuntime.sequence = 39;
    const manager = new WslRuntimeManager({
      resourcesRoot: fixture.root,
      distro: () => 'Ubuntu',
      run: async () => ({ stdout: JSON.stringify(status), stderr: '' })
    });
    await expect(manager.inspect()).resolves.toMatchObject({
      status: 'incompatible', current: 'git-deadbee'
    });
  });

  it('rejects a corrupt embedded artifact before invoking WSL', async () => {
    const fixture = resources();
    writeFileSync(fixture.bundle, 'changed');
    const run = vi.fn();
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });
    await expect(manager.ensure()).rejects.toThrow('wrong size');
    expect(run).not.toHaveBeenCalled();
  });

  it('rolls back through the activated immutable manager', async () => {
    const fixture = resources();
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: JSON.stringify(args.includes('status') ? readyStatus() : {}),
      stderr: ''
    }));
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });
    await expect(manager.rollback()).resolves.toMatchObject({ status: 'ready' });
    expect(run.mock.calls[0]?.[1]).toContain('rollback');
    expect(run.mock.calls[0]?.[1]).toContain('.local/share/agent-fleet/wtmux/current/scripts/wtmux-runtime');
  });
});
