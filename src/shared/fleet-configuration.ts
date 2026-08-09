import { createHash } from 'node:crypto';

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const HOST_KEY = /^(|SHA256:[A-Za-z0-9+/]{20,88})$/u;
const HTTPS_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
const FORBIDDEN = new Set([
  'attachment', 'credential', 'devicepreference', 'discoveredhealth', 'invitation',
  'message', 'output', 'panetitle', 'prompt', 'response', 'secret', 'terminal',
  'token', 'transcript'
]);

export interface FleetClientPolicy {
  schemaVersion: 1;
  policyRevision: number;
  apkManifestUrls: string[];
  runtimeManifestUrls: string[];
  artifactOrigins: string[];
  checkIntervalSeconds: number;
}

export interface FleetHostTrust {
  physicalHostId: string;
  endpointId: string;
  identityState: 'verified' | 'unverified' | 'reverify-required';
  sshHostKeySha256: string;
  tailscaleNodeId: string;
}

export interface FleetPairingBundle {
  schemaVersion: 1;
  bundleId: string;
  fleetId: string;
  configurationRevision: number;
  createdAt: string;
  registry: Record<string, unknown>[];
  clientPolicy: FleetClientPolicy;
  hostTrust: FleetHostTrust[];
  compatibility: {
    contractPackageVersion: string;
    controlVersions: number[];
    conversationVersions: number[];
    minimumReleaseSetSequence: number;
  };
  integrity: { algorithm: 'sha256'; digest: string };
}

export interface PairingInvitationReview {
  bootstrapPeer: string;
  bootstrapUser: string;
  expiresAt: string;
  expired: boolean;
  integrity: 'one-time-secret';
}

export function parseFleetPairingBundle(input: string): FleetPairingBundle {
  if (Buffer.byteLength(input, 'utf8') > MAX_BUNDLE_BYTES) fail('bundle exceeds 4 MiB');
  let parsed: unknown;
  try { parsed = JSON.parse(input) as unknown; } catch { fail('bundle is not valid JSON'); }
  const root = exact(parsed, [
    'schemaVersion', 'bundleId', 'fleetId', 'configurationRevision', 'createdAt',
    'registry', 'clientPolicy', 'hostTrust', 'compatibility', 'integrity'
  ], 'bundle');
  if (root.schemaVersion !== 1 || !id(root.bundleId) || !id(root.fleetId)
    || !positiveInteger(root.configurationRevision) || !instant(root.createdAt)) fail('bundle identity is invalid');
  if (!Array.isArray(root.registry) || root.registry.length < 1 || root.registry.length > 256) fail('registry is invalid');
  const registry = root.registry.map((value, index) => parseRegistryRecord(value, index, root.fleetId as string));
  if (new Set(registry.map((value) => value.id)).size !== registry.length) fail('registry machine IDs are not unique');
  const clientPolicy = parsePolicy(root.clientPolicy);
  const hostTrust = parseTrust(root.hostTrust, registry);
  const compatibility = parseCompatibility(root.compatibility);
  const integrity = exact(root.integrity, ['algorithm', 'digest'], 'integrity');
  if (integrity.algorithm !== 'sha256' || typeof integrity.digest !== 'string' || !SHA256.test(integrity.digest)) {
    fail('integrity metadata is invalid');
  }
  rejectForbidden(root);
  const expected = createHash('sha256').update(canonicalWithoutIntegrity(root)).digest('hex');
  if (expected !== integrity.digest) fail('bundle integrity check failed');
  return {
    schemaVersion: 1,
    bundleId: root.bundleId as string,
    fleetId: root.fleetId as string,
    configurationRevision: root.configurationRevision as number,
    createdAt: root.createdAt as string,
    registry,
    clientPolicy,
    hostTrust,
    compatibility,
    integrity: { algorithm: 'sha256', digest: integrity.digest }
  };
}

export function reviewPairingInvitation(value: string, now = new Date()): PairingInvitationReview {
  if (value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) fail('invitation is invalid');
  let url: URL;
  try { url = new URL(value); } catch { fail('invitation is invalid'); }
  if (url.protocol !== 'wtmux:' || url.hostname !== 'pair' || (url.pathname !== '' && url.pathname !== '/')) {
    fail('invitation target is invalid');
  }
  const names = [...url.searchParams.keys()];
  const allowed = new Set(['pairingVersion', 'bootstrapPeer', 'bootstrapUser', 'token', 'expiresAt']);
  if (names.some((name) => !allowed.has(name)) || new Set(names).size !== names.length
    || !['pairingVersion', 'bootstrapPeer', 'token', 'expiresAt'].every((name) => url.searchParams.has(name))) {
    fail('invitation fields are invalid');
  }
  const peer = url.searchParams.get('bootstrapPeer') ?? '';
  const user = url.searchParams.get('bootstrapUser') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const expiresAt = url.searchParams.get('expiresAt') ?? '';
  if (url.searchParams.get('pairingVersion') !== '1' || !HTTPS_HOST.test(peer)
    || (user !== '' && !/^[a-z_][a-z0-9_-]{0,63}$/u.test(user))
    || !/^(?:[A-Za-z0-9_-]{22}|p[A-Za-z0-9_-]{22})$/u.test(token) || !instant(expiresAt)) {
    fail('invitation values are invalid');
  }
  return {
    bootstrapPeer: peer.toLowerCase(),
    bootstrapUser: user,
    expiresAt,
    expired: Date.parse(expiresAt) <= now.getTime(),
    integrity: 'one-time-secret'
  };
}

export function fleetConfigurationExport(bundle: FleetPairingBundle): string {
  const normalized = parseFleetPairingBundle(`${JSON.stringify(bundle)}\n`);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function parseRegistryRecord(input: unknown, index: number, fleetId: string): Record<string, unknown> & { id: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`registry[${index}] is invalid`);
  const value = input as Record<string, unknown>;
  const base = [
    'schemaVersion', 'id', 'name', 'roles', 'platform', 'linuxUsername', 'tailscaleNode',
    'projectsRoot', 'transport', 'wslDistro', 'fallback', 'hostCommand'
  ];
  const identity = ['fleetId', 'physicalHostId', 'aliases', 'endpoints', 'executionTargets'];
  exact(value, value.schemaVersion === 2 ? [...base, ...identity] : base, `registry[${index}]`);
  if (![1, 2].includes(Number(value.schemaVersion)) || !id(value.id) || typeof value.name !== 'string'
    || value.name.length < 1 || value.name.length > 128 || !Array.isArray(value.roles)) fail(`registry[${index}] identity is invalid`);
  if (value.schemaVersion === 2 && value.fleetId !== fleetId) fail(`registry[${index}] fleet identity is invalid`);
  return { ...value, id: value.id as string };
}

function parsePolicy(input: unknown): FleetClientPolicy {
  const value = exact(input, [
    'schemaVersion', 'policyRevision', 'apkManifestUrls', 'runtimeManifestUrls',
    'artifactOrigins', 'checkIntervalSeconds'
  ], 'client policy');
  const origins = urls(value.artifactOrigins, 4, true);
  const allowedOrigins = new Set(origins.map((origin) => new URL(origin).origin));
  const apk = urls(value.apkManifestUrls, 2, false);
  const runtime = urls(value.runtimeManifestUrls, 2, false);
  if (value.schemaVersion !== 1 || !positiveInteger(value.policyRevision)
    || !Number.isInteger(value.checkIntervalSeconds)
    || (value.checkIntervalSeconds as number) < 3600 || (value.checkIntervalSeconds as number) > 604800) {
    fail('client policy is invalid');
  }
  if ([...apk, ...runtime].some((source) => !allowedOrigins.has(new URL(source).origin))) {
    fail('client policy source origin is not approved');
  }
  return {
    schemaVersion: 1, policyRevision: value.policyRevision as number,
    apkManifestUrls: apk, runtimeManifestUrls: runtime, artifactOrigins: origins,
    checkIntervalSeconds: value.checkIntervalSeconds as number
  };
}

function urls(input: unknown, maximum: number, originOnly: boolean): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > maximum
    || new Set(input).size !== input.length || input.some((value) => typeof value !== 'string')) fail('policy URLs are invalid');
  return input.map((value) => {
    if ((value as string).length > 2048 || (value as string).includes('\\')
      || /[\s\u0000-\u001f\u007f]/u.test(value as string)) fail('policy URL is invalid');
    let url: URL;
    try { url = new URL(value as string); } catch { fail('policy URL is invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || !['', '443'].includes(url.port) || !HTTPS_HOST.test(url.hostname)
      || (originOnly && !['', '/'].includes(url.pathname)) || (originOnly && url.search)) fail('policy URL is invalid');
    return value as string;
  });
}

function parseTrust(input: unknown, records: Array<Record<string, unknown> & { id: string }>): FleetHostTrust[] {
  if (!Array.isArray(input) || input.length > 4096) fail('host trust is invalid');
  const known = new Set<string>();
  for (const record of records) {
    if (record.schemaVersion !== 2 || !Array.isArray(record.endpoints)) continue;
    for (const endpoint of record.endpoints) {
      if (endpoint && typeof endpoint === 'object' && typeof (endpoint as { id?: unknown }).id === 'string') {
        known.add(`${String(record.physicalHostId)}:${String((endpoint as { id: string }).id)}`);
      }
    }
  }
  const seen = new Set<string>();
  return input.map((item, index) => {
    const value = exact(item, [
      'physicalHostId', 'endpointId', 'identityState', 'sshHostKeySha256', 'tailscaleNodeId'
    ], `hostTrust[${index}]`);
    const key = `${String(value.physicalHostId)}:${String(value.endpointId)}`;
    if (!id(value.physicalHostId) || !id(value.endpointId) || seen.has(key) || (known.size > 0 && !known.has(key))
      || !['verified', 'unverified', 'reverify-required'].includes(String(value.identityState))
      || typeof value.sshHostKeySha256 !== 'string' || !HOST_KEY.test(value.sshHostKeySha256)
      || typeof value.tailscaleNodeId !== 'string' || value.tailscaleNodeId.length > 128
      || (value.identityState === 'verified' && !value.sshHostKeySha256 && !value.tailscaleNodeId)) fail(`hostTrust[${index}] is invalid`);
    seen.add(key);
    return value as unknown as FleetHostTrust;
  });
}

function parseCompatibility(input: unknown): FleetPairingBundle['compatibility'] {
  const value = exact(input, [
    'contractPackageVersion', 'controlVersions', 'conversationVersions', 'minimumReleaseSetSequence'
  ], 'compatibility');
  if (typeof value.contractPackageVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.contractPackageVersion)
    || !nonNegativeInteger(value.minimumReleaseSetSequence)) fail('compatibility is invalid');
  return {
    contractPackageVersion: value.contractPackageVersion,
    controlVersions: versions(value.controlVersions),
    conversationVersions: versions(value.conversationVersions),
    minimumReleaseSetSequence: value.minimumReleaseSetSequence as number
  };
}

function versions(input: unknown): number[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8 || new Set(input).size !== input.length
    || input.some((value) => !Number.isInteger(value) || value < 1 || value > 1024)) fail('versions are invalid');
  return input as number[];
}

function canonicalWithoutIntegrity(value: Record<string, unknown>): string {
  const payload = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'integrity'));
  return `${JSON.stringify(sortObject(payload))}\n`;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortObject(item)]));
}

function exact(input: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${label} is not an object`);
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some((field) => !(field in value))) fail(`${label} fields are invalid`);
  return value;
}
function rejectForbidden(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(rejectForbidden); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN.has(key.toLowerCase().replace(/[^a-z]/gu, ''))) fail(`forbidden pairing field: ${key}`);
    rejectForbidden(child);
  }
}
function id(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function instant(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function positiveInteger(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonNegativeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function fail(message: string): never { throw new Error(`Invalid Agent Fleet fleet configuration: ${message}`); }
