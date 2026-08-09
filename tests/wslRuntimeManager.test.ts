import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync,
  readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WslRuntimeManager } from '../src/main/wsl-runtime-manager';
import {
  WSL_RUNTIME_INSTALLER_LOADER,
  WSL_RUNTIME_INSTALLER_PROGRAM
} from '../src/main/wsl-runtime-installer';
import type {
  FleetReleaseSetAuthorityLike,
  VerifiedReleaseSetAdmission
} from '../src/main/release-set-authority';

const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAf3Vg2lizbyEw0Wwna3dKj+wvBgBQ+sHhD0niWKq+gYA=
-----END PUBLIC KEY-----
`;
const RUNTIME_PAYLOAD = Buffer.from('verified runtime bundle');
const RUNTIME_SHA256 = createHash('sha256').update(RUNTIME_PAYLOAD).digest('hex');

const roots: string[] = [];
const posixIt = process.platform === 'win32' ? it.skip : it;
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function resources(): { root: string; bundle: string; descriptor: Record<string, unknown> } {
  const root = mkdtempSync(join(tmpdir(), 'agent-fleet-wsl-runtime-')); roots.push(root);
  const runtime = join(root, 'runtime'); mkdirSync(runtime);
  const payload = RUNTIME_PAYLOAD;
  const bundle = join(runtime, 'wtmux-runtime-git-deadbee.tar');
  writeFileSync(bundle, payload);
  const registryPayload = Buffer.from('verified registry bundle');
  const registryBundle = join(runtime, 'wtmux-registry-deadbee.tar');
  writeFileSync(registryBundle, registryPayload);
  const releaseKey = 'trusted-release-key-ef1aa26c21be89f9ac220e41ae28a865.pem';
  writeFileSync(join(runtime, releaseKey), RELEASE_PUBLIC_KEY);
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
      sha256: RUNTIME_SHA256,
      size: payload.length,
      formatVersion: 2,
      manifestSha256: '4'.repeat(64),
      sbomSha256: '2'.repeat(64),
      licenseSha256: '3'.repeat(64)
    },
    registry: {
      file: 'wtmux-registry-deadbee.tar',
      sha256: createHash('sha256').update(registryPayload).digest('hex'),
      size: registryPayload.length,
      records: 3
    },
    trustedReleaseKeys: [{
      keyId: 'ef1aa26c21be89f9ac220e41ae28a865',
      file: releaseKey,
      sha256: createHash('sha256').update(RELEASE_PUBLIC_KEY).digest('hex')
    }]
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
    },
    trust: { artifactSha256: RUNTIME_SHA256, manifestSha256: '4'.repeat(64) }
  };
}

function verifiedAdmission(hostRuntimeVersion = 'git-deadbee'): VerifiedReleaseSetAdmission {
  return {
    configurationDigest: 'a'.repeat(64),
    sourceUrl: 'https://updates.example.invalid/runtime/manifest.json',
    releaseSet: {
      contractPackageVersion: '1.3.0',
      components: {
        windowsApp: { sequence: 1, version: '1.0.0', compatibility: {} },
        androidApp: { sequence: 1, version: '1.0.0', compatibility: {} },
        clientRuntime: { sequence: 45, version: 'git-deadbee', compatibility: {} },
        hostRuntime: { sequence: 38, version: hostRuntimeVersion, compatibility: {} },
        providerAdapters: { sequence: 13, version: 'git-deadbee', compatibility: {} },
        contracts: { sequence: 13, version: '1.3.0', compatibility: {} }
      }
    },
    windowsArtifact: {
      component: 'windowsApp', version: '1.0.0', size: 1, sha256: '1'.repeat(64)
    },
    clientRuntimeArtifact: {
      component: 'clientRuntime', version: 'git-deadbee', size: RUNTIME_PAYLOAD.length,
      sha256: RUNTIME_SHA256,
      sourceRepository: 'https://github.com/yaakovch/wtmux',
      sourceCommit: '1'.repeat(40)
    }
  } as unknown as VerifiedReleaseSetAdmission;
}

function trustedCommand(args: string[], command: string): boolean {
  return args.includes('python3') && args.includes(WSL_RUNTIME_INSTALLER_PROGRAM) && args.includes(command);
}

function trustedInstallerResult(args: string[]): Record<string, unknown> {
  if (trustedCommand(args, 'pending')) return { activationId: '' };
  if (trustedCommand(args, 'finalize')) return { status: 'finalized', activationId: args.at(-1) };
  if (trustedCommand(args, 'abort')) return { status: 'recovered' };
  if (trustedCommand(args, 'recover')) return { status: 'clean' };
  return {};
}

function mockedOutput(args: string[], status: ReturnType<typeof readyStatus>): string {
  return JSON.stringify(args.includes('status') ? status : trustedInstallerResult(args));
}

describe('app-owned WSL runtime manager', () => {
  it('admits the active signed cohort before runtime use and exposes its trusted host version', async () => {
    const fixture = resources();
    const admission = verifiedAdmission();
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => admission),
      assertCurrent: vi.fn(),
      commitHealthy: vi.fn()
    };
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: mockedOutput(args, readyStatus()),
      stderr: ''
    }));
    const manager = new WslRuntimeManager({
      resourcesRoot: fixture.root,
      distro: () => 'Ubuntu',
      windowsVersion: () => '1.0.0',
      releaseSetAuthority: authority,
      run
    });

    await expect(manager.ensure()).resolves.toMatchObject({ status: 'ready' });
    expect(authority.verifyWindowsRelease).toHaveBeenCalledWith('1.0.0');
    expect(authority.assertCurrent).toHaveBeenCalledWith(admission);
    expect(authority.commitHealthy).toHaveBeenCalledWith(admission, expect.stringMatching(/^[a-f0-9]{32}$/));
    expect(manager.expectedHostRuntimeVersion()).toBe('git-deadbee');
  });

  it('does not install an embedded runtime outside the active signed cohort', async () => {
    const fixture = resources();
    const admission = verifiedAdmission('git-newhost');
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => admission),
      commitHealthy: vi.fn()
    };
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: mockedOutput(args, readyStatus()), stderr: ''
    }));
    const manager = new WslRuntimeManager({
      resourcesRoot: fixture.root,
      distro: () => 'Ubuntu',
      windowsVersion: () => '1.0.0',
      releaseSetAuthority: authority,
      run
    });

    await expect(manager.ensure()).rejects.toThrow('outside the active signed release set');
    expect(run).toHaveBeenCalledTimes(2);
    expect(authority.commitHealthy).not.toHaveBeenCalled();
  });

  it('does not accept matching component labels from bytes outside the signed runtime artifact', async () => {
    const fixture = resources();
    const admission = verifiedAdmission();
    admission.clientRuntimeArtifact.sha256 = '9'.repeat(64);
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => admission),
      commitHealthy: vi.fn()
    };
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: mockedOutput(args, readyStatus()),
      stderr: ''
    }));
    const manager = new WslRuntimeManager({
      resourcesRoot: fixture.root,
      distro: () => 'Ubuntu',
      windowsVersion: () => '1.0.0',
      releaseSetAuthority: authority,
      run
    });

    await expect(manager.ensure()).rejects.toThrow('outside the active signed release set');
    expect(run).toHaveBeenCalledTimes(2);
    expect(authority.commitHealthy).not.toHaveBeenCalled();
  });

  it('provisions from the embedded artifact and resolves only the activated runtime', async () => {
    const fixture = resources();
    let installed = false;
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('status')) {
        if (!installed) throw new Error('runtime missing');
        return { stdout: JSON.stringify(readyStatus()), stderr: '' };
      }
      expect(args).toContain('--exec');
      expect(args).not.toContain('--');
      expect(args).toContain('python3');
      expect(args).toContain(WSL_RUNTIME_INSTALLER_LOADER);
      expect(args.join(' ')).not.toContain('tar -xf');
      expect(args.join(' ')).not.toContain('staging/scripts/wtmux-runtime');
      if (trustedCommand(args, 'pending') || trustedCommand(args, 'recover')
        || trustedCommand(args, 'finalize')) {
        return { stdout: JSON.stringify(trustedInstallerResult(args)), stderr: '' };
      }
      if (trustedCommand(args, 'install-registry')) {
        expect(args.some((value) => value.includes('wtmux-registry-deadbee.tar'))).toBe(true);
        expect(args).toContain('.config/wtmux/wtmux.conf');
        return { stdout: JSON.stringify(trustedInstallerResult(args)), stderr: '' };
      }
      expect(trustedCommand(args, 'install')).toBe(true);
      expect(args).toContain('4'.repeat(64));
      expect(args).toContain('.local/share/agent-fleet/wtmux');
      expect(args).toContain('1');
      expect(args.join('').length).toBeLessThan(30_000);
      installed = true;
      return { stdout: JSON.stringify(trustedInstallerResult(args)), stderr: '' };
    });
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });
    await expect(manager.ensure()).resolves.toMatchObject({
      status: 'ready', current: 'git-deadbee', contractPackageVersion: '1.3.0'
    });
    expect(manager.runtimeCommand('wtmux')).toBe('.local/share/agent-fleet/wtmux/current/scripts/wtmux');
    expect(run).toHaveBeenCalledTimes(6);
  });

  it('reports selected-version skew before clients use the runtime', async () => {
    const fixture = resources();
    const status = readyStatus();
    status.components.hostRuntime.sequence = 39;
    const manager = new WslRuntimeManager({
      resourcesRoot: fixture.root,
      distro: () => 'Ubuntu',
      run: async (_command, args) => ({ stdout: mockedOutput(args, status), stderr: '' })
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

  posixIt('rejects a self-authored installed manifest and extra release files outside its receipt', async () => {
    const fixture = resources();
    const home = join(fixture.root, 'home');
    const runtimeRoot = join(home, '.local/share/agent-fleet/wtmux');
    const release = join(runtimeRoot, 'releases/git-deadbee');
    const scriptPath = join(release, 'scripts/wtmux');
    mkdirSync(join(release, 'scripts'), { recursive: true });
    const originalScript = Buffer.from('#!/bin/sh\nexit 0\n');
    writeFileSync(scriptPath, originalScript);
    chmodSync(scriptPath, 0o755);
    const status = readyStatus();
    const manifest = {
      formatVersion: 2,
      version: 'git-deadbee',
      components: status.components,
      source: status.source,
      target: { platform: 'linux', architecture: 'universal', prefix: '~/.local' },
      files: [{
        path: 'scripts/wtmux',
        sha256: createHash('sha256').update(originalScript).digest('hex'),
        size: originalScript.length,
        mode: 0o755
      }]
    };
    const writeManifest = (): Buffer => {
      const payload = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(join(release, 'runtime-manifest.json'), payload);
      return payload;
    };
    const manifestPayload = writeManifest();
    const manifestSha256 = createHash('sha256').update(manifestPayload).digest('hex');
    const descriptor = fixture.descriptor as {
      runtime: { sha256: string; manifestSha256: string };
    };
    descriptor.runtime.manifestSha256 = manifestSha256;
    writeFileSync(
      join(fixture.root, 'runtime/embedded-runtime-v1.json'),
      JSON.stringify(fixture.descriptor)
    );
    symlinkSync('releases/git-deadbee', join(runtimeRoot, 'current'));
    symlinkSync('releases/git-deadbee', join(runtimeRoot, 'baseline'));
    writeFileSync(join(runtimeRoot, 'activation-journal-v1.json'), JSON.stringify({
      schemaVersion: 1,
      transactionId: 'a'.repeat(32),
      phase: 'committed',
      fromCurrent: '',
      fromPrevious: '',
      candidate: 'releases/git-deadbee',
      updatedAt: '2026-07-30T00:00:00Z',
      failureCode: ''
    }));
    let trustInvocation: string[] | null = null;
    const run = async (_command: string, args: string[]) => {
      const execute = args.indexOf('--exec');
      if (args.includes('status')) trustInvocation = [...args];
      const result = spawnSync(args[execute + 1], args.slice(execute + 2), {
        cwd: home,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
      });
      if (result.status !== 0) throw new Error(result.stderr.trim() || 'runtime trust failed');
      return { stdout: result.stdout, stderr: result.stderr };
    };
    const manager = new WslRuntimeManager({
      resourcesRoot: fixture.root, distro: () => 'Ubuntu', run
    });

    await expect(manager.inspect()).resolves.toMatchObject({
      status: 'missing',
      error: expect.stringContaining('trust receipt')
    });
    expect(trustInvocation).not.toBeNull();
    const execute = trustInvocation!.indexOf('--exec');
    const recordArgs = trustInvocation!.slice(execute + 2);
    recordArgs[3] = 'record';
    const recorded = spawnSync(trustInvocation![execute + 1], recordArgs, {
      cwd: home,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    expect(recorded.stderr).toBe('');
    expect(recorded.status).toBe(0);

    const initiallyTrusted = await manager.inspect();
    expect(initiallyTrusted, initiallyTrusted.error).toMatchObject({ status: 'ready' });

    const changedScript = Buffer.from('#!/bin/sh\nprintf changed\n');
    writeFileSync(scriptPath, changedScript);
    chmodSync(scriptPath, 0o755);
    manifest.files[0].sha256 = createHash('sha256').update(changedScript).digest('hex');
    manifest.files[0].size = changedScript.length;
    writeManifest();
    await expect(manager.inspect()).resolves.toMatchObject({
      status: 'missing',
      error: expect.stringContaining('does not match its trusted receipt')
    });

    writeFileSync(scriptPath, originalScript);
    chmodSync(scriptPath, 0o755);
    manifest.files[0].sha256 = createHash('sha256').update(originalScript).digest('hex');
    manifest.files[0].size = originalScript.length;
    writeManifest();
    writeFileSync(join(release, 'unexpected'), 'not declared');
    await expect(manager.inspect()).resolves.toMatchObject({
      status: 'missing',
      error: expect.stringContaining('contains an extra file')
    });
  });

  it('repairs a missing registry even when the selected runtime is already compatible', async () => {
    const fixture = resources();
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: mockedOutput(args, readyStatus()),
      stderr: ''
    }));
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });
    await expect(manager.ensure()).resolves.toMatchObject({ status: 'ready', current: 'git-deadbee' });
    expect(run).toHaveBeenCalledTimes(5);
    expect(trustedCommand(run.mock.calls[2]![1], 'install-registry')).toBe(true);
  });

  it('preserves a receipt-verified coherent hotfix when the embedded recovery baseline is unchanged', async () => {
    const fixture = resources();
    const status = readyStatus();
    status.current = 'git-hotfix1';
    status.previous = 'git-deadbee';
    status.source.commit = '4'.repeat(40);
    for (const name of ['clientRuntime', 'hostRuntime', 'providerAdapters'] as const) {
      status.components[name] = { sequence: 1, version: 'git-hotfix1' };
    }
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: mockedOutput(args, status),
      stderr: ''
    }));
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });

    await expect(manager.ensure()).resolves.toMatchObject({
      status: 'ready', current: 'git-hotfix1', embeddedVersion: 'git-deadbee'
    });
    expect(run).toHaveBeenCalledTimes(5);
    expect(run.mock.calls.some(([, args]) =>
      trustedCommand(args, 'install'))).toBe(false);
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
      run: async (_command, args) => ({ stdout: mockedOutput(args, status), stderr: '' })
    });

    await expect(manager.inspect()).resolves.toMatchObject({
      status: 'incompatible', current: 'git-hotfix1', embeddedVersion: 'git-deadbee'
    });
  });

  it('promotes an already-installed matching runtime to the embedded recovery baseline', async () => {
    const fixture = resources();
    const status = readyStatus();
    status.baseline = 'git-oldbase';
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('status')) return { stdout: JSON.stringify(status), stderr: '' };
      if (trustedCommand(args, 'install')) {
        expect(args).toContain('1');
        status.baseline = 'git-deadbee';
      }
      return { stdout: JSON.stringify(trustedInstallerResult(args)), stderr: '' };
    });
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });

    await expect(manager.ensure()).resolves.toMatchObject({
      status: 'ready', current: 'git-deadbee', embeddedVersion: 'git-deadbee'
    });
    expect(run.mock.calls.some(([, args]) =>
      trustedCommand(args, 'install'))).toBe(true);
  });

  it('preflights the receipt and rolls back through the verified embedded manager', async () => {
    const fixture = resources();
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: mockedOutput(args, readyStatus()),
      stderr: ''
    }));
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });
    await expect(manager.rollback()).resolves.toMatchObject({ status: 'ready' });
    expect(run.mock.calls[1]?.[1]).toContain('verify-slot');
    expect(trustedCommand(run.mock.calls[2]![1], 'rollback')).toBe(true);
    expect(run.mock.calls[2]?.[1]).not.toContain(
      '.local/share/agent-fleet/wtmux/current/scripts/wtmux-runtime'
    );
  });

  it('coalesces duplicate ensures and keeps the registry activation single-flight', async () => {
    const fixture = resources();
    let releaseRegistry = (): void => undefined;
    const registryGate = new Promise<void>((resolve) => { releaseRegistry = resolve; });
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('status')) return { stdout: JSON.stringify(readyStatus()), stderr: '' };
      if (trustedCommand(args, 'install-registry')) await registryGate;
      return { stdout: JSON.stringify(trustedInstallerResult(args)), stderr: '' };
    });
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });

    const first = manager.ensure();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    const duplicate = manager.ensure();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(3);
    releaseRegistry();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ status: 'ready' }),
      expect.objectContaining({ status: 'ready' })
    ]);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('serializes repair and rollback so activation mutations cannot overlap', async () => {
    const fixture = resources();
    let releaseInstall = (): void => undefined;
    const installGate = new Promise<void>((resolve) => { releaseInstall = resolve; });
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('status')) return { stdout: JSON.stringify(readyStatus()), stderr: '' };
      if (trustedCommand(args, 'install')) await installGate;
      return { stdout: JSON.stringify(trustedInstallerResult(args)), stderr: '' };
    });
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => 'Ubuntu', run });

    const repair = manager.repair();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    const rollback = manager.rollback();
    await Promise.resolve();
    expect(run.mock.calls.some(([, args]) => trustedCommand(args, 'rollback'))).toBe(false);
    releaseInstall();
    await expect(repair).resolves.toMatchObject({ status: 'ready' });
    await expect(rollback).resolves.toMatchObject({ status: 'ready' });
    const rollbackCall = run.mock.calls.findIndex(([, args]) => trustedCommand(args, 'rollback'));
    const repairStatusCall = run.mock.calls.findIndex(([, args]) => args.includes('status'));
    expect(rollbackCall).toBeGreaterThan(repairStatusCall);
  });

  it('rechecks configuration at the mutation boundary and performs no activation when it is stale', async () => {
    const fixture = resources();
    const admission = verifiedAdmission();
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => admission),
      assertCurrent: vi.fn(() => { throw new Error('configuration generation is stale'); }),
      commitHealthy: vi.fn()
    };
    const run = vi.fn(async (_command: string, _args: string[]) => {
      throw new Error('runtime missing');
    });
    const manager = new WslRuntimeManager({
      resourcesRoot: fixture.root,
      distro: () => 'Ubuntu',
      windowsVersion: () => '1.0.0',
      releaseSetAuthority: authority,
      run
    });

    await expect(manager.ensure()).rejects.toThrow('configuration generation is stale');
    expect(authority.assertCurrent).toHaveBeenCalledWith(admission);
    expect(run.mock.calls.some(([, args]) => trustedCommand(args, 'install'))).toBe(false);
    expect(run.mock.calls.some(([, args]) => trustedCommand(args, 'abort'))).toBe(false);
  });

  it('conditionally quarantines a just-activated cohort when healthy commit becomes stale', async () => {
    const fixture = resources();
    const admission = verifiedAdmission();
    const events: string[] = [];
    let distro = 'Ubuntu';
    let installed = false;
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => admission),
      assertCurrent: vi.fn(() => { events.push('configuration-recheck'); }),
      commitHealthy: vi.fn(() => {
        events.push('healthy-commit');
        distro = 'Debian';
        throw new Error('Fleet configuration changed before release-set health was committed');
      })
    };
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('status')) {
        events.push('status');
        if (!installed) throw new Error('runtime missing');
        return { stdout: JSON.stringify(readyStatus()), stderr: '' };
      }
      if (trustedCommand(args, 'install')) {
        installed = true;
        events.push('runtime-install');
      } else if (trustedCommand(args, 'install-registry')) {
        events.push('registry-install');
      } else if (trustedCommand(args, 'abort')) {
        installed = false;
        events.push(`abort:${args[1]}`);
      }
      return { stdout: JSON.stringify(trustedInstallerResult(args)), stderr: '' };
    });
    const manager = new WslRuntimeManager({
      resourcesRoot: fixture.root,
      distro: () => distro,
      windowsVersion: () => '1.0.0',
      releaseSetAuthority: authority,
      run
    });

    await expect(manager.ensure()).rejects.toThrow('Fleet configuration changed');
    expect(events).toEqual([
      'status', 'configuration-recheck', 'runtime-install', 'configuration-recheck',
      'registry-install', 'status', 'healthy-commit', 'abort:Ubuntu'
    ]);
    expect(installed).toBe(false);
    expect(run.mock.calls.find(([, args]) => trustedCommand(args, 'abort'))?.[1][1]).toBe('Ubuntu');
  });

  it('finalizes instead of undoing a transaction durably accepted before a process crash', async () => {
    const fixture = resources();
    const activationId = 'e'.repeat(32);
    const events: string[] = [];
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => verifiedAdmission()),
      assertCurrent: vi.fn(),
      commitHealthy: vi.fn(),
      isActivationCommitted: vi.fn((candidate) => candidate === activationId)
    };
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (trustedCommand(args, 'pending')) {
        events.push('pending');
        return { stdout: JSON.stringify({ activationId }), stderr: '' };
      }
      if (trustedCommand(args, 'finalize')) {
        events.push('finalize');
        return { stdout: JSON.stringify({ status: 'finalized', activationId }), stderr: '' };
      }
      if (trustedCommand(args, 'recover')) events.push('recover');
      if (args.includes('status')) {
        events.push('status');
        return { stdout: JSON.stringify(readyStatus()), stderr: '' };
      }
      return { stdout: JSON.stringify(trustedInstallerResult(args)), stderr: '' };
    });
    const manager = new WslRuntimeManager({
      resourcesRoot: fixture.root,
      distro: () => 'Ubuntu',
      releaseSetAuthority: authority,
      run
    });

    await expect(manager.inspect()).resolves.toMatchObject({ status: 'ready' });
    expect(authority.isActivationCommitted).toHaveBeenCalledWith(activationId);
    expect(events).toEqual(['pending', 'finalize', 'status']);
  });

  it('undoes an explicit rollback when its healthy commit becomes stale', async () => {
    const fixture = resources();
    const admission = verifiedAdmission();
    const events: string[] = [];
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => admission),
      assertCurrent: vi.fn(),
      commitHealthy: vi.fn(() => {
        events.push('healthy-commit');
        throw new Error('Fleet configuration changed before release-set health was committed');
      })
    };
    const run = vi.fn(async (_command: string, args: string[]) => {
      for (const command of ['pending', 'rollback', 'abort', 'finalize'] as const) {
        if (trustedCommand(args, command)) events.push(command);
      }
      if (args.includes('verify-slot')) events.push('verify-slot');
      if (args.includes('status')) {
        events.push('status');
        return { stdout: JSON.stringify(readyStatus()), stderr: '' };
      }
      return { stdout: JSON.stringify(trustedInstallerResult(args)), stderr: '' };
    });
    const manager = new WslRuntimeManager({
      resourcesRoot: fixture.root,
      distro: () => 'Ubuntu',
      windowsVersion: () => '1.0.0',
      releaseSetAuthority: authority,
      run
    });

    await expect(manager.rollback()).rejects.toThrow('Fleet configuration changed');
    expect(events).toEqual([
      'pending', 'verify-slot', 'rollback', 'status', 'healthy-commit', 'abort'
    ]);
    expect(events).not.toContain('finalize');
  });

  posixIt('uses the protected one-open snapshot and rejects replaced or symlinked artifact bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-runtime-snapshot-'));
    roots.push(root);
    const productionRoot = join(__dirname, '..', 'resources', 'runtime');
    const descriptor = JSON.parse(readFileSync(
      join(productionRoot, 'embedded-runtime-v1.json'), 'utf8'
    )) as {
      baselineVersion: string;
      runtime: { file: string; size: number; sha256: string; manifestSha256: string };
      registry: { file: string; size: number; sha256: string; records: number };
    };
    const original = join(productionRoot, descriptor.runtime.file);
    const candidate = join(root, descriptor.runtime.file);
    copyFileSync(original, candidate);
    const replacement = readFileSync(candidate);
    replacement[0] ^= 0xff;
    writeFileSync(candidate, replacement);
    const runtimeRoot = join(root, 'home/.local/share/agent-fleet/wtmux');
    const receipt = join(root, 'home/.local/share/agent-fleet/wtmux-runtime-trust-v1.json');
    const baseArguments = [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'install',
      candidate, String(descriptor.runtime.size), descriptor.runtime.sha256,
      descriptor.baselineVersion, descriptor.runtime.manifestSha256,
      runtimeRoot, receipt, join(root, 'home/.local/bin'), '1', 'a'.repeat(32)
    ];

    const replaced = spawnSync('python3', baseArguments, { encoding: 'utf8', timeout: 30_000 });
    expect(replaced.status).toBe(2);
    expect(replaced.stderr).toContain('checksum does not match');
    expect(existsSync(runtimeRoot)).toBe(false);

    rmSync(candidate);
    symlinkSync(original, candidate);
    const linked = spawnSync('python3', baseArguments, { encoding: 'utf8', timeout: 30_000 });
    expect(linked.status).toBe(2);
    expect(linked.stderr).toContain('missing or unsafe');
    expect(existsSync(runtimeRoot)).toBe(false);
  });

  // This integration path launches several protected subprocesses; match their timeout budget.
  posixIt('installs an admitted archive entirely through the protected exact-bytes program', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-runtime-protected-install-'));
    roots.push(root);
    const productionRoot = join(__dirname, '..', 'resources', 'runtime');
    const descriptor = JSON.parse(readFileSync(
      join(productionRoot, 'embedded-runtime-v1.json'), 'utf8'
    )) as {
      baselineVersion: string;
      runtime: { file: string; size: number; sha256: string; manifestSha256: string };
      registry: { file: string; size: number; sha256: string; records: number };
    };
    const candidate = join(root, descriptor.runtime.file);
    copyFileSync(join(productionRoot, descriptor.runtime.file), candidate);
    const runtimeRoot = join(root, 'home/.local/share/agent-fleet/wtmux');
    const result = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'install',
      candidate, String(descriptor.runtime.size), descriptor.runtime.sha256,
      descriptor.baselineVersion, descriptor.runtime.manifestSha256,
      runtimeRoot, join(root, 'home/.local/share/agent-fleet/wtmux-runtime-trust-v1.json'),
      join(root, 'home/.local/bin'), '1', 'b'.repeat(32)
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });

    expect(result.stderr, result.stderr).toBe('');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'active', version: descriptor.baselineVersion, activationId: 'b'.repeat(32)
    });
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(`releases/${descriptor.baselineVersion}`);

    const receipt = join(root, 'home/.local/share/agent-fleet/wtmux-runtime-trust-v1.json');
    const bin = join(root, 'home/.local/bin');
    const finalized = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'finalize',
      runtimeRoot, 'b'.repeat(32)
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(finalized.status, finalized.stderr).toBe(0);

    const alternateCandidate = join(root, `alternate-${descriptor.runtime.file}`);
    const alternatePayload = Buffer.concat([readFileSync(candidate), Buffer.alloc(10_240)]);
    writeFileSync(alternateCandidate, alternatePayload);
    const alternateDigest = createHash('sha256').update(alternatePayload).digest('hex');
    const equivocated = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'install',
      alternateCandidate, String(alternatePayload.length), alternateDigest,
      descriptor.baselineVersion, descriptor.runtime.manifestSha256,
      runtimeRoot, receipt, bin, '1', 'f'.repeat(32)
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(equivocated.status).toBe(2);
    expect(equivocated.stderr).toContain('version was reused');
    expect(existsSync(join(runtimeRoot, 'activation-authority-v1.json'))).toBe(false);

    const reused = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'install',
      candidate, String(descriptor.runtime.size), descriptor.runtime.sha256,
      descriptor.baselineVersion, descriptor.runtime.manifestSha256,
      runtimeRoot, receipt, bin, '1', 'c'.repeat(32)
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(reused.status, reused.stderr).toBe(0);

    const registryBundle = join(root, descriptor.registry.file);
    copyFileSync(join(productionRoot, descriptor.registry.file), registryBundle);
    const config = join(root, 'home/.config/wtmux/wtmux.conf');
    mkdirSync(join(root, 'home/.config/wtmux'), { recursive: true });
    const priorConfig = Buffer.from('WTMUX_MACHINE_IDS=(local)\n# preserve exact bytes\n');
    writeFileSync(config, priorConfig, { mode: 0o640 });
    chmodSync(config, 0o640);
    const registry = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'install-registry',
      registryBundle, String(descriptor.registry.size), descriptor.registry.sha256,
      runtimeRoot, receipt, config, String(descriptor.registry.records), 'c'.repeat(32)
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(registry.status, registry.stderr).toBe(0);
    expect(JSON.parse(registry.stdout)).toMatchObject({ registry: descriptor.registry.sha256 });
    expect(readFileSync(config)).not.toEqual(priorConfig);

    const activatedConfig = readFileSync(config);
    const concurrentConfig = Buffer.from('WTMUX_MACHINE_IDS=(operator-edit)\n');
    writeFileSync(config, concurrentConfig);
    const conflictedAbort = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'abort',
      runtimeRoot, receipt, bin, 'c'.repeat(32)
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(conflictedAbort.status).toBe(2);
    expect(conflictedAbort.stderr).toContain('preserving the newer edit');
    expect(readFileSync(config)).toEqual(concurrentConfig);
    writeFileSync(config, activatedConfig);

    const aborted = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'abort',
      runtimeRoot, receipt, bin, 'c'.repeat(32)
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(aborted.status, aborted.stderr).toBe(0);
    expect(JSON.parse(aborted.stdout)).toMatchObject({ status: 'recovered' });
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(`releases/${descriptor.baselineVersion}`);
    expect(existsSync(join(runtimeRoot, `releases/${descriptor.baselineVersion}`))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'rejected'))).toBe(false);
    expect(existsSync(join(runtimeRoot, 'registry/current'))).toBe(false);
    expect(readdirSync(join(runtimeRoot, 'registry/rejected'))).toHaveLength(1);
    expect(readFileSync(config)).toEqual(priorConfig);
    expect(statSync(config).mode & 0o777).toBe(0o640);
    expect(existsSync(join(runtimeRoot, 'activation-authority-v1.json'))).toBe(false);

    const previousVersion = `${descriptor.baselineVersion}-previous`;
    const currentRelease = join(runtimeRoot, `releases/${descriptor.baselineVersion}`);
    const previousRelease = join(runtimeRoot, `releases/${previousVersion}`);
    cpSync(currentRelease, previousRelease, { recursive: true });
    const previousManifestPath = join(previousRelease, 'runtime-manifest.json');
    const previousManifest = JSON.parse(readFileSync(previousManifestPath, 'utf8')) as {
      version: string;
      components: Record<string, { version: string }>;
    };
    previousManifest.version = previousVersion;
    for (const name of ['clientRuntime', 'hostRuntime', 'providerAdapters']) {
      previousManifest.components[name]!.version = previousVersion;
    }
    const previousManifestPayload = Buffer.from(`${JSON.stringify(previousManifest, null, 2)}\n`);
    writeFileSync(previousManifestPath, previousManifestPayload);
    const previousManifestDigest = createHash('sha256').update(previousManifestPayload).digest('hex');
    const receiptValue = JSON.parse(readFileSync(receipt, 'utf8')) as {
      releases: Array<{ version: string; artifactSha256: string; manifestSha256: string }>;
    };
    receiptValue.releases.push({
      version: previousVersion,
      artifactSha256: '9'.repeat(64),
      manifestSha256: previousManifestDigest
    });
    writeFileSync(receipt, `${JSON.stringify(receiptValue, null, 2)}\n`);
    symlinkSync(`releases/${previousVersion}`, join(runtimeRoot, 'previous'));
    const rolledBack = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'rollback',
      runtimeRoot, receipt, bin, '7'.repeat(32)
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(rolledBack.status, rolledBack.stderr).toBe(0);
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(`releases/${previousVersion}`);
    expect(readlinkSync(join(runtimeRoot, 'previous'))).toBe(`releases/${descriptor.baselineVersion}`);

    const rollbackAbort = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'abort',
      runtimeRoot, receipt, bin, '7'.repeat(32)
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(rollbackAbort.status, rollbackAbort.stderr).toBe(0);
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(`releases/${descriptor.baselineVersion}`);
    expect(readlinkSync(join(runtimeRoot, 'previous'))).toBe(`releases/${previousVersion}`);
    expect(existsSync(currentRelease)).toBe(true);
    expect(existsSync(previousRelease)).toBe(true);
    expect(existsSync(join(runtimeRoot, 'rejected'))).toBe(false);

    const registryOnly = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'install-registry',
      registryBundle, String(descriptor.registry.size), descriptor.registry.sha256,
      runtimeRoot, receipt, config, String(descriptor.registry.records), '8'.repeat(32)
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(registryOnly.status, registryOnly.stderr).toBe(0);
    expect(readlinkSync(join(runtimeRoot, 'registry/current'))).toBe(
      `releases/${descriptor.registry.sha256}`
    );
    const registryOnlyFinalized = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'finalize',
      runtimeRoot, '8'.repeat(32)
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(registryOnlyFinalized.status, registryOnlyFinalized.stderr).toBe(0);
    expect(existsSync(join(runtimeRoot, 'activation-authority-v1.json'))).toBe(false);
  }, 30_000);

  posixIt('deterministically compensates an uncommitted activation after restart and remains idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-runtime-crash-recovery-'));
    roots.push(root);
    const productionRoot = join(__dirname, '..', 'resources', 'runtime');
    const descriptor = JSON.parse(readFileSync(
      join(productionRoot, 'embedded-runtime-v1.json'), 'utf8'
    )) as {
      baselineVersion: string;
      runtime: { file: string; size: number; sha256: string; manifestSha256: string };
    };
    const candidate = join(root, descriptor.runtime.file);
    copyFileSync(join(productionRoot, descriptor.runtime.file), candidate);
    const runtimeRoot = join(root, 'home/.local/share/agent-fleet/wtmux');
    const receipt = join(root, 'home/.local/share/agent-fleet/wtmux-runtime-trust-v1.json');
    const bin = join(root, 'home/.local/bin');
    const transaction = 'd'.repeat(32);
    const installed = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'install',
      candidate, String(descriptor.runtime.size), descriptor.runtime.sha256,
      descriptor.baselineVersion, descriptor.runtime.manifestSha256,
      runtimeRoot, receipt, bin, '1', transaction
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(installed.status, installed.stderr).toBe(0);
    expect(existsSync(join(runtimeRoot, 'activation-authority-v1.json'))).toBe(true);

    const recovered = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'recover',
      runtimeRoot, receipt, bin, '-'
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({ status: 'recovered', current: '' });
    expect(existsSync(join(runtimeRoot, 'current'))).toBe(false);
    expect(existsSync(join(runtimeRoot, 'baseline'))).toBe(false);
    expect(existsSync(join(runtimeRoot, `releases/${descriptor.baselineVersion}`))).toBe(false);
    expect(readdirSync(join(runtimeRoot, 'rejected'))).toHaveLength(1);
    expect(existsSync(join(runtimeRoot, 'activation-authority-v1.json'))).toBe(false);

    const again = spawnSync('python3', [
      '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'recover',
      runtimeRoot, receipt, bin, '-'
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ status: 'clean' });
    expect(readdirSync(join(runtimeRoot, 'rejected'))).toHaveLength(1);
  });

  it('rejects a stale runtime result when the selected WSL distribution changes', async () => {
    const fixture = resources();
    let distro = 'Ubuntu';
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (run.mock.calls.length === 1) await firstGate;
      return { stdout: mockedOutput(args, readyStatus()), stderr: '' };
    });
    const manager = new WslRuntimeManager({ resourcesRoot: fixture.root, distro: () => distro, run });

    const stale = manager.inspect();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    distro = 'Debian';
    const current = manager.inspect();
    releaseFirst();
    await expect(stale).rejects.toThrow(/distribution changed/i);
    await expect(current).resolves.toMatchObject({ status: 'ready' });
    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(['Ubuntu', 'Debian', 'Debian']);
    expect(manager.getState().status).toBe('ready');
  });
});
