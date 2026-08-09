import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { join } from 'node:path';
import type {
  AgentFleetReleaseSet,
  ReleaseArtifact,
  ReleaseComponentId
} from '../shared/release-set';
import type { FleetPairingBundle } from '../shared/fleet-configuration';
import { FleetConfigurationStore } from './fleet-configuration-store';
import {
  durableAtomicWrite,
  readFileSnapshot,
  readOptionalFileSnapshot,
  withCrossProcessLock
} from './durable-file';
import { signedReleaseSetPayload, verifyAgentFleetReleaseSet } from './release-set-verifier';

const MAX_RELEASE_SET_BYTES = 256 * 1024;
const MAX_CACHE_BYTES = 2 * MAX_RELEASE_SET_BYTES;
const FETCH_TIMEOUT_MS = 30_000;
const COMPONENTS: ReleaseComponentId[] = [
  'windowsApp', 'androidApp', 'clientRuntime', 'hostRuntime', 'providerAdapters', 'contracts'
];

export interface EmbeddedReleaseTrustPins {
  descriptorSha256: string;
  keys: ReadonlyArray<{ keyId: string; sha256: string }>;
}

/**
 * This value is bundled into the ASAR-protected main process. The descriptor
 * and public keys remain external resources so WSL can consume the adjacent
 * runtime artifacts, but they are not allowed to define their own trust root.
 */
export const PRODUCTION_RELEASE_TRUST_PINS: EmbeddedReleaseTrustPins = Object.freeze({
  descriptorSha256: '5ffe0393579ec8428c79592ddf81e9a6fc0b590febd2531c12eafa2af5943c45',
  keys: Object.freeze([Object.freeze({
    keyId: 'ef1aa26c21be89f9ac220e41ae28a865',
    sha256: 'a3500746ab5f70c708741dd8f3c41b0dc66fabb7a47b43b726bceb6cf9108364'
  })])
});

interface AcceptedReleaseIdentity {
  releaseSetSequence: number;
  payloadSha256: string;
  components: Record<ReleaseComponentId, { sequence: number; version: string }>;
}

interface AcceptedReleaseState {
  schemaVersion: 2;
  releasePolicy: 'signed';
  fleetId: string;
  releaseSetSequence: number;
  componentFloors: Record<ReleaseComponentId, number>;
  releaseSetIdentity: AcceptedReleaseIdentity | null;
  activationId: string | null;
  needsMigration: boolean;
}

interface CachedReleaseSet {
  schemaVersion: 1;
  configurationDigest: string;
  sourceUrl: string;
  releaseSetJson: string;
}

export interface VerifiedReleaseSetAdmission {
  configurationDigest: string;
  sourceUrl: string;
  releaseSet: AgentFleetReleaseSet;
  windowsArtifact: ReleaseArtifact;
  clientRuntimeArtifact: ReleaseArtifact;
}

export interface FleetReleaseSetAuthorityLike {
  verifyWindowsRelease(windowsVersion: string): Promise<VerifiedReleaseSetAdmission | null>;
  /** Required by mutating runtime consumers immediately before activation. */
  assertCurrent?(admission: VerifiedReleaseSetAdmission): void;
  commitHealthy(admission: VerifiedReleaseSetAdmission, activationId?: string): void;
  isActivationCommitted?(activationId: string): boolean;
}

export interface FleetReleaseSetAuthorityOptions {
  resourcesRoot: string;
  dataRoot: string;
  legacyPolicy: 'allow-unconfigured' | 'deny';
  configurationStore?: Pick<FleetConfigurationStore, 'current'>;
  trustPins?: EmbeddedReleaseTrustPins;
  fetchText?(url: string, maximumBytes: number, timeoutMs: number): Promise<string>;
  now?(): Date;
}

/**
 * Connects the data-only fleet configuration to the signed cohort used by
 * update and runtime admission. The caller may explicitly preserve the legacy
 * path only while no configuration has ever enrolled signed policy. Merely
 * observing a configured policy persists that enrollment before network I/O.
 */
export class FleetReleaseSetAuthority implements FleetReleaseSetAuthorityLike {
  private readonly configurationStore: Pick<FleetConfigurationStore, 'current'>;
  private readonly fetchText: NonNullable<FleetReleaseSetAuthorityOptions['fetchText']>;
  private readonly now: () => Date;
  private readonly statePath: string;
  private readonly cacheRoot: string;
  private readonly trustedKeys: ReadonlyMap<string, KeyObject>;
  private readonly verifiedAdmissions = new WeakSet<object>();
  private readonly inFlight = new Map<string, Promise<VerifiedReleaseSetAdmission | null>>();
  private healthyAdmission: VerifiedReleaseSetAdmission | null = null;

  constructor(private readonly options: FleetReleaseSetAuthorityOptions) {
    this.configurationStore = options.configurationStore ?? new FleetConfigurationStore();
    this.fetchText = options.fetchText ?? fetchBoundedText;
    this.now = options.now ?? (() => new Date());
    this.statePath = join(options.dataRoot, 'release-authority', 'accepted-v1.json');
    this.cacheRoot = join(options.dataRoot, 'release-authority', 'cache');
    this.trustedKeys = loadEmbeddedReleaseKeys(
      options.resourcesRoot,
      options.trustPins ?? PRODUCTION_RELEASE_TRUST_PINS
    );
  }

  verifyWindowsRelease(windowsVersion: string): Promise<VerifiedReleaseSetAdmission | null> {
    if (!safeVersion(windowsVersion)) return Promise.reject(new Error('Windows release version is invalid'));
    const configuration = this.configurationStore.current();
    if (!configuration) {
      const state = this.readState();
      if (state?.releasePolicy === 'signed') {
        return Promise.reject(new Error('Signed release-set enrollment requires an active fleet configuration'));
      }
      return this.options.legacyPolicy === 'allow-unconfigured'
        ? Promise.resolve(null)
        : Promise.reject(new Error('Legacy release admission is disabled'));
    }
    this.assertConfigurationCompatibility(configuration);
    this.enrollSignedPolicy(configuration);
    const key = `${configuration.integrity.digest}\u0000${windowsVersion}`;
    const active = this.inFlight.get(key);
    if (active) return active;
    const operation = this.verifyConfiguredRelease(configuration, windowsVersion);
    this.inFlight.set(key, operation);
    void operation.finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  assertCurrent(admission: VerifiedReleaseSetAdmission): void {
    if (!this.verifiedAdmissions.has(admission)) {
      throw new Error('Release-set admission was not produced by this authority');
    }
    const configuration = this.configurationStore.current();
    if (!configuration || configuration.integrity.digest !== admission.configurationDigest) {
      throw new Error('Fleet configuration changed before release-set activation');
    }
  }

  commitHealthy(admission: VerifiedReleaseSetAdmission, activationId?: string): void {
    this.assertCurrent(admission);
    if (activationId !== undefined && !/^[a-f0-9]{32}$/u.test(activationId)) {
      throw new Error('Runtime activation transaction is invalid');
    }
    const configuration = this.configurationStore.current();
    if (!configuration || configuration.integrity.digest !== admission.configurationDigest) {
      throw new Error('Fleet configuration changed before release-set health was committed');
    }
    withCrossProcessLock(this.statePath, () => {
      const current = this.readState();
      if (current && current.fleetId !== configuration.fleetId) {
        throw new Error('Fleet identity changed across accepted release-set state');
      }
      if (current && admission.releaseSet.releaseSetSequence < current.releaseSetSequence) {
        throw new Error('Release-set state advanced while health was being committed');
      }
      const admissionIdentity = releaseIdentity(admission.releaseSet);
      if (current?.releaseSetIdentity
        && current.releaseSetSequence === admission.releaseSet.releaseSetSequence
        && !sameReleaseIdentity(current.releaseSetIdentity, admissionIdentity)) {
        throw new Error('Release-set sequence was reused with different signed content');
      }
      const floors = Object.fromEntries(COMPONENTS.map((name) => [
        name,
        Math.max(
          current?.componentFloors[name] ?? 0,
          admission.releaseSet.rollbackFloor.componentSequences[name]
        )
      ])) as Record<ReleaseComponentId, number>;
      const next: AcceptedReleaseState = {
        schemaVersion: 2,
        releasePolicy: 'signed',
        fleetId: configuration.fleetId,
        releaseSetSequence: Math.max(
          current?.releaseSetSequence ?? 0,
          admission.releaseSet.releaseSetSequence
        ),
        componentFloors: floors,
        releaseSetIdentity: !current
          || admission.releaseSet.releaseSetSequence > current.releaseSetSequence
          || !current.releaseSetIdentity
          ? admissionIdentity
          : current.releaseSetIdentity,
        activationId: activationId ?? current?.activationId ?? null,
        needsMigration: false
      };
      this.writeState(next);
    });
    this.healthyAdmission = admission;
  }

  isActivationCommitted(activationId: string): boolean {
    return /^[a-f0-9]{32}$/u.test(activationId)
      && this.readState()?.activationId === activationId;
  }

  healthyHostRuntimeVersion(): string | null {
    return this.healthyAdmission?.releaseSet.components.hostRuntime.version ?? null;
  }

  private async verifyConfiguredRelease(
    configuration: FleetPairingBundle,
    windowsVersion: string
  ): Promise<VerifiedReleaseSetAdmission | null> {
    const allowedOrigins = new Set(configuration.clientPolicy.artifactOrigins.map(canonicalOrigin));
    const state = this.readState();
    if (state && state.fleetId !== configuration.fleetId) {
      throw new Error('Fleet identity does not match accepted release-set state');
    }
    const minimumReleaseSetSequence = Math.max(
      configuration.compatibility.minimumReleaseSetSequence,
      state?.releaseSetSequence ?? 0
    );
    const componentFloors = state?.componentFloors;
    const errors: Error[] = [];

    for (const sourceUrl of configuration.clientPolicy.runtimeManifestUrls) {
      if (!allowedOrigins.has(canonicalOrigin(sourceUrl))) {
        throw new Error('Release-set source origin is not approved by fleet configuration');
      }
      try {
        const text = await this.fetchText(sourceUrl, MAX_RELEASE_SET_BYTES, FETCH_TIMEOUT_MS);
        return this.verifyAndCache(
          text,
          sourceUrl,
          configuration,
          windowsVersion,
          allowedOrigins,
          minimumReleaseSetSequence,
          componentFloors
        );
      } catch (error) {
        errors.push(asError(error));
      }
    }

    try {
      const cached = this.readCache(configuration, windowsVersion);
      if (cached) {
        return this.verifyAdmission(
          cached.releaseSetJson,
          cached.sourceUrl,
          configuration,
          windowsVersion,
          allowedOrigins,
          minimumReleaseSetSequence,
          componentFloors
        );
      }
    } catch (error) {
      errors.push(asError(error));
    }

    const detail = errors.at(-1)?.message ?? 'No signed release set was available from configured sources';
    throw new Error(`Signed release-set admission failed: ${detail}`);
  }

  private verifyAndCache(
    text: string,
    sourceUrl: string,
    configuration: FleetPairingBundle,
    windowsVersion: string,
    allowedOrigins: ReadonlySet<string>,
    minimumReleaseSetSequence: number,
    componentFloors: Partial<Record<ReleaseComponentId, number>> | undefined
  ): VerifiedReleaseSetAdmission {
    const admission = this.verifyAdmission(
      text,
      sourceUrl,
      configuration,
      windowsVersion,
      allowedOrigins,
      minimumReleaseSetSequence,
      componentFloors
    );
    const cache: CachedReleaseSet = {
      schemaVersion: 1,
      configurationDigest: configuration.integrity.digest,
      sourceUrl,
      releaseSetJson: text
    };
    durableAtomicWrite(
      this.cachePath(configuration, windowsVersion),
      `${JSON.stringify(cache)}\n`,
      { mode: 0o600 }
    );
    return admission;
  }

  private verifyAdmission(
    text: string,
    sourceUrl: string,
    configuration: FleetPairingBundle,
    windowsVersion: string,
    allowedOrigins: ReadonlySet<string>,
    minimumReleaseSetSequence: number,
    componentFloors: Partial<Record<ReleaseComponentId, number>> | undefined
  ): VerifiedReleaseSetAdmission {
    if (!allowedOrigins.has(canonicalOrigin(sourceUrl))) {
      throw new Error('Cached release-set source origin is no longer approved');
    }
    const releaseSet = verifyAgentFleetReleaseSet(text, {
      trustedKeys: this.trustedKeys,
      allowedOrigins,
      trustedSourceOrigins: new Set(['https://github.com']),
      installedWindowsVersion: windowsVersion,
      now: this.now(),
      minimumReleaseSetSequence,
      componentFloors
    });
    if (releaseSet.contractPackageVersion !== configuration.compatibility.contractPackageVersion) {
      throw new Error('Release set does not match the active fleet contract package');
    }
    for (const [name, supported] of [
      ['control', 1], ['conversation', 2], ['workspaceLayout', 1]
    ] as const) {
      const range = releaseSet.protocols[name];
      if (supported < range.minimum || supported > range.maximum) {
        throw new Error(`Release set does not support the Windows ${name} protocol`);
      }
    }
    const windowsArtifact = selectWindowsArtifact(releaseSet);
    const clientRuntimeArtifact = selectClientRuntimeArtifact(releaseSet);
    this.recordSignedEnrollment(configuration, releaseSet);
    const admission = freezeDeep<VerifiedReleaseSetAdmission>({
      configurationDigest: configuration.integrity.digest,
      sourceUrl,
      releaseSet,
      windowsArtifact,
      clientRuntimeArtifact
    });
    this.verifiedAdmissions.add(admission);
    return admission;
  }

  private assertConfigurationCompatibility(configuration: FleetPairingBundle): void {
    if (!configuration.compatibility.controlVersions.includes(1)
      || !configuration.compatibility.conversationVersions.includes(2)) {
      throw new Error('Fleet configuration is incompatible with this Windows client');
    }
  }

  private readState(): AcceptedReleaseState | null {
    const snapshot = readOptionalFileSnapshot(this.statePath, 64 * 1024);
    if (!snapshot) return null;
    const value = JSON.parse(snapshot.data.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Accepted release-set state is invalid');
    }
    const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
    const hasActivationId = Object.prototype.hasOwnProperty.call(value, 'activationId');
    const root = exact(value, schemaVersion === 1
      ? ['schemaVersion', 'fleetId', 'releaseSetSequence', 'componentFloors']
      : [
        'schemaVersion', 'releasePolicy', 'fleetId', 'releaseSetSequence',
        'componentFloors', 'releaseSetIdentity', ...(hasActivationId ? ['activationId'] : [])
      ], 'accepted release-set state');
    const floors = exact(root.componentFloors, COMPONENTS, 'accepted component floors');
    if ((root.schemaVersion !== 1 && root.schemaVersion !== 2) || !safeId(root.fleetId)
      || !nonNegativeInteger(root.releaseSetSequence)) {
      throw new Error('Accepted release-set state is invalid');
    }
    const componentFloors = Object.fromEntries(COMPONENTS.map((name) => {
      if (!nonNegativeInteger(floors[name])) throw new Error('Accepted component floors are invalid');
      return [name, floors[name] as number];
    })) as Record<ReleaseComponentId, number>;
    const identity = root.schemaVersion === 1
      ? null
      : parseReleaseIdentity(root.releaseSetIdentity, root.releaseSetSequence as number);
    if (root.schemaVersion === 2 && root.releasePolicy !== 'signed') {
      throw new Error('Accepted release-set policy is invalid');
    }
    const activationId = root.schemaVersion === 2 && hasActivationId ? root.activationId : null;
    if (activationId !== null && (typeof activationId !== 'string' || !/^[a-f0-9]{32}$/u.test(activationId))) {
      throw new Error('Accepted runtime activation transaction is invalid');
    }
    return {
      schemaVersion: 2,
      releasePolicy: 'signed',
      fleetId: root.fleetId as string,
      releaseSetSequence: root.releaseSetSequence as number,
      componentFloors,
      releaseSetIdentity: identity,
      activationId: activationId as string | null,
      needsMigration: root.schemaVersion === 1
    };
  }

  private recordSignedEnrollment(
    configuration: FleetPairingBundle,
    releaseSet: AgentFleetReleaseSet
  ): void {
    const active = this.configurationStore.current();
    if (!active || active.integrity.digest !== configuration.integrity.digest) {
      throw new Error('Fleet configuration changed during release-set admission');
    }
    withCrossProcessLock(this.statePath, () => {
      const current = this.readState();
      if (current && current.fleetId !== configuration.fleetId) {
        throw new Error('Fleet identity does not match accepted release-set state');
      }
      if (current && releaseSet.releaseSetSequence < current.releaseSetSequence) {
        throw new Error('Release set is below the accepted anti-rollback floor');
      }
      for (const name of COMPONENTS) {
        if (releaseSet.components[name].sequence < (current?.componentFloors[name] ?? 0)) {
          throw new Error(`${name} is below its accepted anti-rollback floor`);
        }
      }
      const identity = releaseIdentity(releaseSet);
      if (current?.releaseSetIdentity
        && current.releaseSetSequence === releaseSet.releaseSetSequence
        && !sameReleaseIdentity(current.releaseSetIdentity, identity)) {
        throw new Error('Release-set sequence was reused with different signed content');
      }
      if (!current) {
        this.writeState({
          schemaVersion: 2,
          releasePolicy: 'signed',
          fleetId: configuration.fleetId,
          releaseSetSequence: 0,
          componentFloors: zeroComponentFloors(),
          releaseSetIdentity: null,
          activationId: null,
          needsMigration: false
        });
      } else if (current.needsMigration) {
        this.writeState({
          ...current,
          releaseSetIdentity: current.releaseSetSequence === releaseSet.releaseSetSequence
            ? identity
            : current.releaseSetIdentity,
          needsMigration: false
        });
      }
    });
  }

  private enrollSignedPolicy(configuration: FleetPairingBundle): void {
    const active = this.configurationStore.current();
    if (!active || active.integrity.digest !== configuration.integrity.digest) {
      throw new Error('Fleet configuration changed during signed release enrollment');
    }
    withCrossProcessLock(this.statePath, () => {
      const current = this.readState();
      if (current && current.fleetId !== configuration.fleetId) {
        throw new Error('Fleet identity does not match accepted release-set state');
      }
      if (!current) {
        this.writeState({
          schemaVersion: 2,
          releasePolicy: 'signed',
          fleetId: configuration.fleetId,
          releaseSetSequence: 0,
          componentFloors: zeroComponentFloors(),
          releaseSetIdentity: null,
          activationId: null,
          needsMigration: false
        });
      }
    });
  }

  private writeState(state: AcceptedReleaseState): void {
    const persisted = {
      schemaVersion: 2,
      releasePolicy: state.releasePolicy,
      fleetId: state.fleetId,
      releaseSetSequence: state.releaseSetSequence,
      componentFloors: state.componentFloors,
      releaseSetIdentity: state.releaseSetIdentity,
      activationId: state.activationId
    };
    durableAtomicWrite(this.statePath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
  }

  private readCache(configuration: FleetPairingBundle, windowsVersion: string): CachedReleaseSet | null {
    const snapshot = readOptionalFileSnapshot(
      this.cachePath(configuration, windowsVersion),
      MAX_CACHE_BYTES
    );
    if (!snapshot) return null;
    const root = exact(JSON.parse(snapshot.data.toString('utf8')) as unknown, [
      'schemaVersion', 'configurationDigest', 'sourceUrl', 'releaseSetJson'
    ], 'cached release set');
    if (root.schemaVersion !== 1 || root.configurationDigest !== configuration.integrity.digest
      || typeof root.sourceUrl !== 'string' || typeof root.releaseSetJson !== 'string'
      || Buffer.byteLength(root.releaseSetJson, 'utf8') > MAX_RELEASE_SET_BYTES) {
      throw new Error('Cached release set is invalid');
    }
    return root as unknown as CachedReleaseSet;
  }

  private cachePath(configuration: FleetPairingBundle, windowsVersion: string): string {
    const key = createHash('sha256')
      .update(configuration.integrity.digest).update('\u0000').update(windowsVersion)
      .digest('hex');
    return join(this.cacheRoot, `${key}.json`);
  }
}

export function loadEmbeddedReleaseKeys(
  resourcesRoot: string,
  pins: EmbeddedReleaseTrustPins = PRODUCTION_RELEASE_TRUST_PINS
): ReadonlyMap<string, KeyObject> {
  const pinnedKeys = validateTrustPins(pins);
  const runtimeRoot = join(resourcesRoot, 'runtime');
  const descriptorSnapshot = readFileSnapshot(join(runtimeRoot, 'embedded-runtime-v1.json'), 64 * 1024);
  if (descriptorSnapshot.sha256 !== pins.descriptorSha256) {
    throw new Error('Embedded runtime descriptor does not match the protected production trust pin');
  }
  const descriptor = exact(
    JSON.parse(descriptorSnapshot.data.toString('utf8')) as unknown,
    [
      'schemaVersion', 'baselineVersion', 'sourceRepository', 'sourceCommit',
      'contractPackageVersion', 'components', 'runtime', 'registry', 'trustedReleaseKeys'
    ],
    'embedded runtime descriptor'
  );
  if (descriptor.schemaVersion !== 1 || !Array.isArray(descriptor.trustedReleaseKeys)
    || descriptor.trustedReleaseKeys.length !== pinnedKeys.size) {
    throw new Error('Embedded trusted release keys are invalid');
  }
  const keys = new Map<string, KeyObject>();
  for (const candidate of descriptor.trustedReleaseKeys) {
    const value = exact(candidate, ['keyId', 'file', 'sha256'], 'embedded trusted release key');
    if (typeof value.keyId !== 'string' || !/^[a-f0-9]{32}$/u.test(value.keyId)
      || value.file !== `trusted-release-key-${value.keyId}.pem`
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
      || keys.has(value.keyId)) {
      throw new Error('Embedded trusted release key identity is invalid');
    }
    if (pinnedKeys.get(value.keyId) !== value.sha256) {
      throw new Error('Embedded trusted release key does not match the protected production trust pin');
    }
    const snapshot = readFileSnapshot(join(runtimeRoot, value.file), 4096);
    if (snapshot.sha256 !== value.sha256) throw new Error('Embedded trusted release key checksum does not match');
    const key = createPublicKey(snapshot.data);
    const derived = createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 32);
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' || derived !== value.keyId) {
      throw new Error('Embedded trusted release key is invalid');
    }
    keys.set(value.keyId, key);
  }
  return keys;
}

function validateTrustPins(pins: EmbeddedReleaseTrustPins): ReadonlyMap<string, string> {
  if (!/^[a-f0-9]{64}$/u.test(pins.descriptorSha256)
    || !Array.isArray(pins.keys) || pins.keys.length < 1 || pins.keys.length > 4) {
    throw new Error('Protected production release trust pins are invalid');
  }
  const keys = new Map<string, string>();
  for (const pin of pins.keys) {
    if (!pin || typeof pin !== 'object' || !/^[a-f0-9]{32}$/u.test(pin.keyId)
      || !/^[a-f0-9]{64}$/u.test(pin.sha256) || keys.has(pin.keyId)) {
      throw new Error('Protected production release trust pins are invalid');
    }
    keys.set(pin.keyId, pin.sha256);
  }
  return keys;
}

function releaseIdentity(releaseSet: AgentFleetReleaseSet): AcceptedReleaseIdentity {
  return {
    releaseSetSequence: releaseSet.releaseSetSequence,
    payloadSha256: createHash('sha256').update(signedReleaseSetPayload(releaseSet)).digest('hex'),
    components: Object.fromEntries(COMPONENTS.map((name) => [name, {
      sequence: releaseSet.components[name].sequence,
      version: releaseSet.components[name].version
    }])) as AcceptedReleaseIdentity['components']
  };
}

function parseReleaseIdentity(input: unknown, acceptedSequence: number): AcceptedReleaseIdentity | null {
  if (input === null) {
    if (acceptedSequence !== 0) throw new Error('Accepted release-set identity is missing');
    return null;
  }
  const root = exact(
    input,
    ['releaseSetSequence', 'payloadSha256', 'components'],
    'accepted release-set identity'
  );
  if (!nonNegativeInteger(root.releaseSetSequence)
    || root.releaseSetSequence !== acceptedSequence
    || acceptedSequence === 0
    || typeof root.payloadSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(root.payloadSha256)) {
    throw new Error('Accepted release-set identity is invalid');
  }
  const values = exact(root.components, COMPONENTS, 'accepted release-set components');
  const components = Object.fromEntries(COMPONENTS.map((name) => {
    const component = exact(values[name], ['sequence', 'version'], `accepted ${name} identity`);
    if (!Number.isSafeInteger(component.sequence) || (component.sequence as number) < 1
      || !safeVersion(component.version)) {
      throw new Error('Accepted release-set component identity is invalid');
    }
    return [name, { sequence: component.sequence as number, version: component.version as string }];
  })) as AcceptedReleaseIdentity['components'];
  return {
    releaseSetSequence: root.releaseSetSequence as number,
    payloadSha256: root.payloadSha256,
    components
  };
}

function sameReleaseIdentity(left: AcceptedReleaseIdentity, right: AcceptedReleaseIdentity): boolean {
  return left.releaseSetSequence === right.releaseSetSequence
    && left.payloadSha256 === right.payloadSha256
    && COMPONENTS.every((name) => left.components[name].sequence === right.components[name].sequence
      && left.components[name].version === right.components[name].version);
}

function zeroComponentFloors(): Record<ReleaseComponentId, number> {
  return Object.fromEntries(COMPONENTS.map((name) => [name, 0])) as Record<ReleaseComponentId, number>;
}

async function fetchBoundedText(url: string, maximumBytes: number, timeoutMs: number): Promise<string> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error('Release-set fetch timed out')), timeoutMs);
  deadline.unref();
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: abort.signal
    });
    if (!response.ok || !response.body) throw new Error(`Release-set source returned HTTP ${response.status}`);
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
      throw new Error('Release-set response exceeds its size limit');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error('Release-set response exceeds its size limit');
      }
      chunks.push(item.value);
    }
    const payload = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } finally {
    clearTimeout(deadline);
  }
}

function selectWindowsArtifact(releaseSet: AgentFleetReleaseSet): ReleaseArtifact {
  const ranked = releaseSet.artifacts
    .filter((artifact) => artifact.component === 'windowsApp'
      && ['windows', 'any'].includes(artifact.platform)
      && ['x86_64', 'universal', 'any'].includes(artifact.architecture))
    .map((artifact) => ({
      artifact,
      rank: (artifact.platform === 'windows' ? 10 : 0)
        + (artifact.architecture === 'x86_64' ? 3 : artifact.architecture === 'universal' ? 2 : 1)
    }))
    .sort((left, right) => right.rank - left.rank);
  if (!ranked.length) throw new Error('Release set has no compatible Windows artifact');
  if (ranked[1]?.rank === ranked[0].rank) throw new Error('Release set has ambiguous Windows artifacts');
  return ranked[0].artifact;
}

function selectClientRuntimeArtifact(releaseSet: AgentFleetReleaseSet): ReleaseArtifact {
  const ranked = releaseSet.artifacts
    .filter((artifact) => artifact.component === 'clientRuntime'
      && ['linux', 'any'].includes(artifact.platform)
      && ['x86_64', 'universal', 'any'].includes(artifact.architecture))
    .map((artifact) => ({
      artifact,
      rank: (artifact.platform === 'linux' ? 10 : 0)
        + (artifact.architecture === 'x86_64' ? 3 : artifact.architecture === 'universal' ? 2 : 1)
    }))
    .sort((left, right) => right.rank - left.rank);
  if (!ranked.length) throw new Error('Release set has no compatible WSL runtime artifact');
  if (ranked[1]?.rank === ranked[0].rank) throw new Error('Release set has ambiguous WSL runtime artifacts');
  return ranked[0].artifact;
}

function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !['', '443'].includes(url.port)) {
    throw new Error('Fleet configuration contains an unsafe HTTPS origin');
  }
  return url.origin;
}

function exact(input: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label} is invalid`);
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
  return value;
}

function safeVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value);
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function freezeDeep<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}
