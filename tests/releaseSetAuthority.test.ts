import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FleetReleaseSetAuthority,
  loadEmbeddedReleaseKeys,
  type EmbeddedReleaseTrustPins,
  type FleetReleaseSetAuthorityOptions
} from '../src/main/release-set-authority';
import { signedReleaseSetPayload } from '../src/main/release-set-verifier';
import type { FleetPairingBundle } from '../src/shared/fleet-configuration';
import { parseAgentFleetReleaseSetJson } from '../src/shared/release-set';

const RELEASE_VERSION = '0.11.0-beta.21';
const MANIFEST_URL = 'https://updates.example.invalid/runtime/manifest.json';
const NOW = new Date('2026-07-24T12:00:00Z');
const roots: string[] = [];

interface TestContext {
  resourcesRoot: string;
  dataRoot: string;
  configuration: FleetPairingBundle;
  signingKey: KeyObject;
  keyId: string;
  trustPins: EmbeddedReleaseTrustPins;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): Record<string, any> {
  return JSON.parse(readFileSync(
    join(__dirname, 'fixtures', 'contracts', 'release-set-v1.json'),
    'utf8'
  )) as Record<string, any>;
}

function createContext(): TestContext {
  const root = mkdtempSync(join(tmpdir(), 'agent-fleet-release-authority-'));
  roots.push(root);
  const resourcesRoot = join(root, 'resources');
  const dataRoot = join(root, 'data');
  const runtimeRoot = join(resourcesRoot, 'runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  const pair = generateKeyPairSync('ed25519');
  const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' });
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = createHash('sha256').update(publicDer).digest('hex').slice(0, 32);
  const keyFile = `trusted-release-key-${keyId}.pem`;
  const keySha256 = createHash('sha256').update(publicPem).digest('hex');
  writeFileSync(join(runtimeRoot, keyFile), publicPem, { mode: 0o600 });
  const descriptorPayload = `${JSON.stringify({
    schemaVersion: 1,
    baselineVersion: 'git-test',
    sourceRepository: 'https://github.com/yaakovch/wtmux',
    sourceCommit: '1'.repeat(40),
    contractPackageVersion: '1.5.0',
    components: {},
    runtime: {},
    registry: [],
    trustedReleaseKeys: [{
      keyId,
      file: keyFile,
      sha256: keySha256
    }]
  })}\n`;
  writeFileSync(join(runtimeRoot, 'embedded-runtime-v1.json'), descriptorPayload);
  const configuration: FleetPairingBundle = {
    schemaVersion: 1,
    bundleId: 'release-authority-test',
    fleetId: 'fixture-fleet',
    configurationRevision: 1,
    createdAt: NOW.toISOString(),
    registry: [{}],
    clientPolicy: {
      schemaVersion: 1,
      policyRevision: 1,
      apkManifestUrls: ['https://updates.example.invalid/android/manifest.json'],
      runtimeManifestUrls: [MANIFEST_URL],
      artifactOrigins: ['https://updates.example.invalid'],
      checkIntervalSeconds: 3600
    },
    hostTrust: [],
    compatibility: {
      contractPackageVersion: '1.5.0',
      controlVersions: [1],
      conversationVersions: [2],
      minimumReleaseSetSequence: 0
    },
    integrity: { algorithm: 'sha256', digest: 'c'.repeat(64) }
  };
  return {
    resourcesRoot,
    dataRoot,
    configuration,
    signingKey: pair.privateKey,
    keyId,
    trustPins: {
      descriptorSha256: createHash('sha256').update(descriptorPayload).digest('hex'),
      keys: [{ keyId, sha256: keySha256 }]
    }
  };
}

function signedFixture(
  context: Pick<TestContext, 'signingKey' | 'keyId'>,
  mutate?: (value: Record<string, any>) => void
): string {
  const value = fixture();
  mutate?.(value);
  value.signature = { algorithm: 'ed25519', keyId: context.keyId, value: 'A'.repeat(86) };
  const parsed = parseAgentFleetReleaseSetJson(JSON.stringify(value));
  value.signature.value = sign(
    null,
    signedReleaseSetPayload(parsed),
    context.signingKey
  ).toString('base64url');
  return JSON.stringify(value);
}

function authority(
  context: TestContext,
  fetchText: NonNullable<FleetReleaseSetAuthorityOptions['fetchText']>,
  configuration: FleetPairingBundle | null | (() => FleetPairingBundle | null) = context.configuration,
  legacyPolicy: FleetReleaseSetAuthorityOptions['legacyPolicy'] = 'allow-unconfigured'
): FleetReleaseSetAuthority {
  return new FleetReleaseSetAuthority({
    resourcesRoot: context.resourcesRoot,
    dataRoot: context.dataRoot,
    legacyPolicy,
    trustPins: context.trustPins,
    configurationStore: {
      current: () => typeof configuration === 'function' ? configuration() : configuration
    },
    fetchText,
    now: () => NOW
  });
}

describe('fleet release-set authority', () => {
  it('admits an exact signed Windows cohort and persists floors only after health', async () => {
    const context = createContext();
    const fetchText = vi.fn(async () => signedFixture(context));
    const releaseAuthority = authority(context, fetchText);

    const admitted = await releaseAuthority.verifyWindowsRelease(RELEASE_VERSION);
    expect(admitted).toMatchObject({
      sourceUrl: MANIFEST_URL,
      releaseSet: { releaseSetSequence: 1083 },
      windowsArtifact: {
        id: 'windows-x86_64',
        version: RELEASE_VERSION,
        size: 1000
      },
      clientRuntimeArtifact: {
        id: 'client-runtime-linux',
        version: 'git-b5bb8ec',
        size: 1000
      }
    });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted?.releaseSet.components)).toBe(true);
    expect(releaseAuthority.healthyHostRuntimeVersion()).toBeNull();
    releaseAuthority.commitHealthy(admitted!);
    expect(releaseAuthority.healthyHostRuntimeVersion()).toBe('git-b5bb8ec');
    expect(JSON.parse(readFileSync(
      join(context.dataRoot, 'release-authority', 'accepted-v1.json'),
      'utf8'
    ))).toMatchObject({
      schemaVersion: 2,
      releasePolicy: 'signed',
      fleetId: 'fixture-fleet',
      releaseSetSequence: 1083,
      componentFloors: { clientRuntime: 44, hostRuntime: 37 },
      releaseSetIdentity: {
        releaseSetSequence: 1083,
        payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        components: { hostRuntime: { sequence: 38, version: 'git-b5bb8ec' } }
      }
    });
  });

  it('loads the checked-in production trust root only through its protected pins', () => {
    const keys = loadEmbeddedReleaseKeys(join(__dirname, '..', 'resources'));
    expect([...keys.keys()]).toEqual(['ef1aa26c21be89f9ac220e41ae28a865']);
  });

  it('rejects a self-consistent replacement descriptor and release key', () => {
    const context = createContext();
    const runtimeRoot = join(context.resourcesRoot, 'runtime');
    const attacker = generateKeyPairSync('ed25519');
    const publicPem = attacker.publicKey.export({ type: 'spki', format: 'pem' });
    const keyId = createHash('sha256')
      .update(attacker.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex').slice(0, 32);
    const keyFile = `trusted-release-key-${keyId}.pem`;
    writeFileSync(join(runtimeRoot, keyFile), publicPem);
    const descriptorPath = join(runtimeRoot, 'embedded-runtime-v1.json');
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as Record<string, any>;
    descriptor.trustedReleaseKeys = [{
      keyId,
      file: keyFile,
      sha256: createHash('sha256').update(publicPem).digest('hex')
    }];
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`);

    expect(() => authority(context, async () => signedFixture(context)))
      .toThrow('protected production trust pin');
  });

  it('rejects a release set signed by a key outside the embedded trust root', async () => {
    const context = createContext();
    const other = generateKeyPairSync('ed25519');
    const otherKeyId = createHash('sha256')
      .update(other.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex').slice(0, 32);
    const text = signedFixture({ signingKey: other.privateKey, keyId: otherKeyId });

    await expect(authority(context, async () => text).verifyWindowsRelease(RELEASE_VERSION))
      .rejects.toThrow('unknown signing key');
  });

  it('rejects signed artifacts from an origin outside active fleet policy', async () => {
    const context = createContext();
    const text = signedFixture(context, (value) => {
      value.artifacts[0].url = 'https://evil.example.invalid/agent-fleet/windows.exe';
    });

    await expect(authority(context, async () => text).verifyWindowsRelease(RELEASE_VERSION))
      .rejects.toThrow('artifact origin is not approved');
  });

  it('rejects an expired signed release set', async () => {
    const context = createContext();
    const text = signedFixture(context, (value) => {
      value.issuedAt = '2026-07-20T00:00:00Z';
      value.expiresAt = '2026-07-24T12:00:00Z';
    });

    await expect(authority(context, async () => text).verifyWindowsRelease(RELEASE_VERSION))
      .rejects.toThrow('release set has expired');
  });

  it('fails closed on release-set downgrade and disappearance after healthy acceptance', async () => {
    const context = createContext();
    const currentText = signedFixture(context);
    const initialAuthority = authority(context, async () => currentText);
    initialAuthority.commitHealthy((await initialAuthority.verifyWindowsRelease(RELEASE_VERSION))!);
    rmSync(join(context.dataRoot, 'release-authority', 'cache'), { recursive: true, force: true });

    const downgrade = signedFixture(context, (value) => {
      value.releaseSetSequence = 1082;
      value.rollbackFloor.releaseSetSequence = 1081;
    });
    await expect(authority(context, async () => downgrade).verifyWindowsRelease(RELEASE_VERSION))
      .rejects.toThrow('anti-rollback floor');
    await expect(authority(context, async () => '{"schemaVersion":1}').verifyWindowsRelease(RELEASE_VERSION))
      .rejects.toThrow('Invalid release set');
  });

  it('uses only a still-valid signed cache when configured sources are unavailable', async () => {
    const context = createContext();
    const text = signedFixture(context);
    await authority(context, async () => text).verifyWindowsRelease(RELEASE_VERSION);

    const cached = await authority(context, async () => {
      throw new Error('offline');
    }).verifyWindowsRelease(RELEASE_VERSION);
    expect(cached?.releaseSet.releaseSetSequence).toBe(1083);
  });

  it('preserves the legacy no-policy path without fetching release metadata', async () => {
    const context = createContext();
    const fetchText = vi.fn(async () => signedFixture(context));

    await expect(authority(context, fetchText, null).verifyWindowsRelease(RELEASE_VERSION))
      .resolves.toBeNull();
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('can explicitly disable even the unconfigured legacy path', async () => {
    const context = createContext();
    await expect(authority(context, async () => signedFixture(context), null, 'deny')
      .verifyWindowsRelease(RELEASE_VERSION)).rejects.toThrow('Legacy release admission is disabled');
  });

  it('rejects response-shaped legacy fallback whenever a fleet configuration is active', async () => {
    const context = createContext();
    await expect(authority(context, async () => '{"schemaVersion":1}')
      .verifyWindowsRelease(RELEASE_VERSION)).rejects.toThrow('Invalid release set');
  });

  it('does not ignore an explicit signed release floor on first enrollment', async () => {
    const context = createContext();
    const configuration: FleetPairingBundle = {
      ...context.configuration,
      compatibility: {
        ...context.configuration.compatibility,
        minimumReleaseSetSequence: 1
      }
    };
    const releaseAuthority = authority(context, async () => '{"schemaVersion":1}', configuration);
    await expect(releaseAuthority.verifyWindowsRelease(RELEASE_VERSION)).rejects.toThrow('Invalid release set');
    await expect(authority(context, async () => signedFixture(context), null)
      .verifyWindowsRelease(RELEASE_VERSION)).rejects.toThrow('requires an active fleet configuration');
  });

  it('persists signed enrollment before health so configuration loss cannot reopen legacy mode', async () => {
    const context = createContext();
    let configuration: FleetPairingBundle | null = context.configuration;
    const releaseAuthority = authority(
      context,
      async () => signedFixture(context),
      () => configuration
    );

    await expect(releaseAuthority.verifyWindowsRelease(RELEASE_VERSION)).resolves.toBeTruthy();
    expect(JSON.parse(readFileSync(
      join(context.dataRoot, 'release-authority', 'accepted-v1.json'),
      'utf8'
    ))).toMatchObject({
      schemaVersion: 2,
      releasePolicy: 'signed',
      releaseSetSequence: 0,
      releaseSetIdentity: null
    });

    configuration = null;
    await expect(releaseAuthority.verifyWindowsRelease(RELEASE_VERSION))
      .rejects.toThrow('requires an active fleet configuration');
  });

  it('migrates the prior healthy state by pinning the first matching signed identity', async () => {
    const context = createContext();
    const stateRoot = join(context.dataRoot, 'release-authority');
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, 'accepted-v1.json'), `${JSON.stringify({
      schemaVersion: 1,
      fleetId: context.configuration.fleetId,
      releaseSetSequence: 1083,
      componentFloors: fixture().rollbackFloor.componentSequences
    })}\n`);

    await expect(authority(context, async () => signedFixture(context))
      .verifyWindowsRelease(RELEASE_VERSION)).resolves.toBeTruthy();
    expect(JSON.parse(readFileSync(join(stateRoot, 'accepted-v1.json'), 'utf8'))).toMatchObject({
      schemaVersion: 2,
      releasePolicy: 'signed',
      releaseSetSequence: 1083,
      releaseSetIdentity: {
        releaseSetSequence: 1083,
        payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        components: { clientRuntime: { sequence: 45, version: 'git-b5bb8ec' } }
      }
    });
  });

  it('rejects equal-sequence signed content and component equivocation', async () => {
    const context = createContext();
    const current = authority(context, async () => signedFixture(context));
    current.commitHealthy((await current.verifyWindowsRelease(RELEASE_VERSION))!);
    rmSync(join(context.dataRoot, 'release-authority', 'cache'), { recursive: true, force: true });

    const equivocation = signedFixture(context, (value) => {
      value.components.hostRuntime.version = 'git-equivocated';
    });
    await expect(authority(context, async () => equivocation).verifyWindowsRelease(RELEASE_VERSION))
      .rejects.toThrow('sequence was reused with different signed content');
  });

  it('rejects a concurrently admitted equal-sequence cohort at healthy commit', async () => {
    const context = createContext();
    const first = authority(context, async () => signedFixture(context));
    const secondText = signedFixture(context, (value) => {
      value.components.hostRuntime.version = 'git-concurrent';
    });
    const second = authority(context, async () => secondText);
    const firstAdmission = await first.verifyWindowsRelease(RELEASE_VERSION);
    const secondAdmission = await second.verifyWindowsRelease(RELEASE_VERSION);

    first.commitHealthy(firstAdmission!);
    expect(() => second.commitHealthy(secondAdmission!))
      .toThrow('sequence was reused with different signed content');
  });

  it('rechecks the exact configuration generation immediately before activation and commit', async () => {
    const context = createContext();
    let configuration = context.configuration;
    const releaseAuthority = authority(
      context,
      async () => signedFixture(context),
      () => configuration
    );
    const admission = await releaseAuthority.verifyWindowsRelease(RELEASE_VERSION);

    expect(() => releaseAuthority.assertCurrent(admission!)).not.toThrow();
    configuration = {
      ...configuration,
      configurationRevision: configuration.configurationRevision + 1,
      integrity: { ...configuration.integrity, digest: 'd'.repeat(64) }
    };
    expect(() => releaseAuthority.assertCurrent(admission!))
      .toThrow('configuration changed before release-set activation');
    expect(() => releaseAuthority.commitHealthy(admission!))
      .toThrow('configuration changed before release-set activation');

    const other = authority(context, async () => signedFixture(context));
    expect(() => other.assertCurrent(admission!))
      .toThrow('not produced by this authority');
  });

  it('durably associates a healthy cohort with its WSL activation transaction', async () => {
    const context = createContext();
    const activationId = 'a'.repeat(32);
    const releaseAuthority = authority(context, async () => signedFixture(context));
    const admission = await releaseAuthority.verifyWindowsRelease(RELEASE_VERSION);

    releaseAuthority.commitHealthy(admission!, activationId);
    expect(releaseAuthority.isActivationCommitted(activationId)).toBe(true);
    expect(releaseAuthority.isActivationCommitted('b'.repeat(32))).toBe(false);
    expect(JSON.parse(readFileSync(
      join(context.dataRoot, 'release-authority', 'accepted-v1.json'), 'utf8'
    ))).toMatchObject({ schemaVersion: 2, activationId });

    const restarted = authority(context, async () => signedFixture(context));
    expect(restarted.isActivationCommitted(activationId)).toBe(true);
    expect(() => releaseAuthority.commitHealthy(admission!, 'not-a-transaction'))
      .toThrow('activation transaction is invalid');
    expect(() => restarted.commitHealthy(admission!, 'not-a-transaction'))
      .toThrow('not produced by this authority');
  });
});
