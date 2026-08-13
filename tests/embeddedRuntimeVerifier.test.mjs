import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertConnectableMachineRegistryRecord,
  assertRuntimeManifestIdentity,
  assertTerminalReplySafeRuntime,
  verifyEmbeddedRuntime
} from '../scripts/verify-embedded-runtime.mjs';

const source = resolve('resources/runtime');
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-fleet-embedded-runtime-'));
  roots.push(root);
  await cp(source, root, { recursive: true });
  return root;
}

describe('embedded runtime verifier', () => {
  it('rejects runtimes that can reopen tmux 3.6 panes without the reply guard', () => {
    const safeFiles = new Set([
      'lib/tmux_safety.py',
      'lib/tmux_state.sh',
      'scripts/wtmux-tmux-safety'
    ]);
    expect(() => assertTerminalReplySafeRuntime({
      clientRuntime: { sequence: 57 },
      hostRuntime: { sequence: 51 },
      providerAdapters: { sequence: 24 }
    }, safeFiles)).toThrow('predates managed terminal-reply safety');
    expect(() => assertTerminalReplySafeRuntime({
      clientRuntime: { sequence: 61 },
      hostRuntime: { sequence: 55 },
      providerAdapters: { sequence: 28 }
    }, safeFiles)).toThrow('predates managed terminal-reply safety');
    expect(() => assertTerminalReplySafeRuntime({
      clientRuntime: { sequence: 64 },
      hostRuntime: { sequence: 58 },
      providerAdapters: { sequence: 31 }
    }, new Set(['lib/tmux_state.sh']))).toThrow('omits managed terminal-reply safety');
    expect(assertTerminalReplySafeRuntime({
      clientRuntime: { sequence: 64 },
      hostRuntime: { sequence: 58 },
      providerAdapters: { sequence: 31 }
    }, safeFiles)).toMatchObject({ clientRuntime: { sequence: 64 } });
  });

  it('requires identity-v2 evidence for every packaged host transport', () => {
    expect(() => assertConnectableMachineRegistryRecord({
      schemaVersion: 1,
      id: 'legacy-host',
      roles: ['host'],
      transport: 'tailscale'
    })).toThrow('identity schema v2');

    expect(() => assertConnectableMachineRegistryRecord({
      schemaVersion: 2,
      id: 'unverified-host',
      roles: ['host'],
      transport: 'tailscale',
      endpoints: [{
        network: 'tailnet',
        sshEngine: 'openssh',
        identityState: 'unverified',
        sshHostKeySha256: '',
        tailscaleNodeId: ''
      }]
    })).toThrow('no verified transport');

    expect(assertConnectableMachineRegistryRecord({
      schemaVersion: 2,
      id: 'verified-host',
      roles: ['host'],
      transport: 'tailscale',
      endpoints: [{
        network: 'tailnet',
        sshEngine: 'openssh',
        identityState: 'verified',
        sshHostKeySha256: 'SHA256:example',
        tailscaleNodeId: 'node-example'
      }]
    })).toMatchObject({ id: 'verified-host' });

    expect(() => assertConnectableMachineRegistryRecord({
      schemaVersion: 2,
      id: 'invalid-direct-tailscale-cli',
      roles: ['host'],
      transport: 'ssh',
      endpoints: [{
        network: 'direct',
        sshEngine: 'tailscale-cli',
        identityState: 'verified',
        sshHostKeySha256: '',
        tailscaleNodeId: ''
      }]
    })).toThrow('no verified transport');

    expect(assertConnectableMachineRegistryRecord({
      schemaVersion: 2,
      id: 'client-only',
      roles: ['client'],
      transport: 'ssh',
      endpoints: []
    })).toMatchObject({ id: 'client-only' });
  });

  it('rejects ambiguous source, target, component, and license provenance', () => {
    const descriptor = JSON.parse(readFileSync(join(source, 'embedded-runtime-v1.json'), 'utf8'));
    const baseline = {
      formatVersion: 2,
      version: descriptor.baselineVersion,
      components: structuredClone(descriptor.components),
      source: {
        schemaVersion: 1,
        repository: descriptor.sourceRepository,
        commit: descriptor.sourceCommit,
        license: 'MIT',
        contractPackageVersion: descriptor.contractPackageVersion
      },
      target: {
        platform: 'linux',
        architecture: 'universal',
        prefix: '/home/agent-fleet/.local'
      },
      files: []
    };
    expect(assertRuntimeManifestIdentity(structuredClone(baseline), descriptor)).toEqual(baseline);

    for (const mutate of [
      (value) => { value.source.license = 'NOASSERTION'; },
      (value) => { value.source.unexpected = true; },
      (value) => { value.target.architecture = 'x86_64'; },
      (value) => { value.target.prefix = '/tmp/runtime'; },
      (value) => { value.components.clientRuntime.unexpected = true; }
    ]) {
      const candidate = structuredClone(baseline);
      mutate(candidate);
      expect(() => assertRuntimeManifestIdentity(candidate, descriptor)).toThrow(/fields are invalid|identity/u);
    }
  });

  it('binds the immutable descriptor to the exact archived manifest bytes', async () => {
    const root = await fixture();
    const descriptorPath = join(root, 'embedded-runtime-v1.json');
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    descriptor.runtime.manifestSha256 = '0'.repeat(64);
    writeFileSync(descriptorPath, JSON.stringify(descriptor));

    expect(() => verifyEmbeddedRuntime(root)).toThrow(
      'runtime manifest checksum does not match its descriptor'
    );
  });
});
