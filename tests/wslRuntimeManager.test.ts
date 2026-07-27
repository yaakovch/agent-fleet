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
  const registryPayload = Buffer.from('verified registry bundle');
  const registryBundle = join(runtime, 'wtmux-registry-deadbee.tar');
  writeFileSync(registryBundle, registryPayload);
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
    },
    registry: {
      file: 'wtmux-registry-deadbee.tar',
      sha256: createHash('sha256').update(registryPayload).digest('hex'),
      size: registryPayload.length,
      records: 3
    }
  };
  writeFileSync(join(runtime, 'embedded-runtime-v1.json'), JSON.stringify(descriptor));
  return { root, bundle, descriptor };
}

function readyStatus() {
  return {
    baseline: 'git-deadbee',
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
    source: {
      repository: 'https://github.com/yaakovch/wtmux',
      commit: '1'.repeat(40),
      contractPackageVersion: '1.3.0'
    }
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
      expect(args).toContain('--exec');
      expect(args).not.toContain('--');
      expect(args.join(' ')).toContain('wslpath');
      const shell = args[args.indexOf('-lc') + 1];
      if (shell.includes('install-registry')) {
        expect(shell).toContain('wtmux-registry-deadbee.tar');
        expect(shell).toContain(" --config '.config/wtmux/wtmux.conf'");
        return { stdout: '{}', stderr: '' };
      }
      expect(shell.split('; ')).toHaveLength(6);
      expect(shell).toContain('; tar -xf "$bundle"');
      expect(shell).toContain('; python3 "$staging/scripts/wtmux-runtime"');
      expect(shell).toContain(' --root \'.local/share/agent-fleet/wtmux\'');
      expect(args.at(-1)).toBe(shell);
      installed = true;
      return { stdout: '{}', stderr: '' };
    });
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });
    await expect(manager.ensure()).resolves.toMatchObject({
      status: 'ready', current: 'git-deadbee', contractPackageVersion: '1.3.0'
    });
    expect(manager.runtimeCommand('wtmux')).toBe('.local/share/agent-fleet/wtmux/current/scripts/wtmux');
    expect(run).toHaveBeenCalledTimes(4);
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

  it('repairs a missing registry even when the selected runtime is already compatible', async () => {
    const fixture = resources();
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: JSON.stringify(args.includes('status') ? readyStatus() : {}),
      stderr: ''
    }));
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });
    await expect(manager.ensure()).resolves.toMatchObject({ status: 'ready', current: 'git-deadbee' });
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[1]?.[1].at(-1)).toContain('install-registry');
  });

  it('preserves a coherent hotfix when the embedded recovery baseline is unchanged', async () => {
    const fixture = resources();
    const status = readyStatus();
    status.current = 'git-hotfix1';
    status.previous = 'git-deadbee';
    status.source.commit = '4'.repeat(40);
    for (const name of ['clientRuntime', 'hostRuntime', 'providerAdapters'] as const) {
      status.components[name] = { sequence: 1, version: 'git-hotfix1' };
    }
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: JSON.stringify(args.includes('status') ? status : {}),
      stderr: ''
    }));
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });

    await expect(manager.ensure()).resolves.toMatchObject({
      status: 'ready', current: 'git-hotfix1', embeddedVersion: 'git-deadbee'
    });
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.some(([, args]) => args.at(-1)?.includes('python3 "$staging/scripts/wtmux-runtime"'))).toBe(false);
  });

  it('does not preserve a hotfix across an embedded recovery-baseline change', async () => {
    const fixture = resources();
    const status = readyStatus();
    status.current = 'git-hotfix1';
    status.baseline = 'git-oldbase';
    status.source.commit = '4'.repeat(40);
    for (const name of ['clientRuntime', 'hostRuntime', 'providerAdapters'] as const) {
      status.components[name] = { sequence: 1, version: 'git-hotfix1' };
    }
    const manager = new WslRuntimeManager({
      resourcesRoot: fixture.root,
      distro: () => 'Ubuntu',
      run: async () => ({ stdout: JSON.stringify(status), stderr: '' })
    });

    await expect(manager.inspect()).resolves.toMatchObject({
      status: 'incompatible', current: 'git-hotfix1', embeddedVersion: 'git-deadbee'
    });
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
