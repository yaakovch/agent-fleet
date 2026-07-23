export const RELEASE_SET_SCHEMA_VERSION = 1;
export const RELEASE_SET_MAX_BYTES = 256 * 1024;

export type ReleaseComponentId =
  | 'windowsApp' | 'androidApp' | 'clientRuntime' | 'hostRuntime' | 'providerAdapters' | 'contracts';

export interface ReleaseProtocolRange { minimum: number; maximum: number }
export interface ReleaseComponent {
  sequence: number;
  version: string;
  compatibility: Partial<Record<ReleaseComponentId, ReleaseSequenceRange>>;
}
export interface ReleaseSequenceRange { minimum: number; maximum: number }
export interface ReleaseArtifact {
  id: string;
  component: ReleaseComponentId;
  componentSequence: number;
  version: string;
  platform: 'windows' | 'android' | 'linux' | 'termux' | 'any';
  architecture: 'x86_64' | 'arm64' | 'universal' | 'any';
  url: string;
  sha256: string;
  size: number;
  sourceRepository: string;
  sourceCommit: string;
  contractPackageVersion: string;
  sbomSha256: string;
  licenseSha256: string;
}
export interface AgentFleetReleaseSet {
  schemaVersion: 1;
  releaseSetSequence: number;
  issuedAt: string;
  expiresAt: string;
  contractPackageVersion: string;
  protocols: {
    control: ReleaseProtocolRange;
    conversation: ReleaseProtocolRange;
    workspaceLayout: ReleaseProtocolRange;
  };
  components: Record<ReleaseComponentId, ReleaseComponent>;
  artifacts: ReleaseArtifact[];
  rollbackFloor: {
    releaseSetSequence: number;
    componentSequences: Record<ReleaseComponentId, number>;
  };
  signature: { algorithm: 'ed25519'; keyId: string; value: string };
}

const COMPONENTS: ReleaseComponentId[] = [
  'windowsApp', 'androidApp', 'clientRuntime', 'hostRuntime', 'providerAdapters', 'contracts'
];
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const TOKEN = /^[a-z][a-z0-9._-]{0,95}$/u;

export function parseAgentFleetReleaseSetJson(text: string): AgentFleetReleaseSet {
  if (Buffer.byteLength(text, 'utf8') > RELEASE_SET_MAX_BYTES) fail('release set exceeds its size limit');
  try {
    return parseAgentFleetReleaseSet(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid release set:')) throw error;
    fail('release set is not valid JSON');
  }
}

export function parseAgentFleetReleaseSet(input: unknown): AgentFleetReleaseSet {
  const value = exact(input, [
    'schemaVersion', 'releaseSetSequence', 'issuedAt', 'expiresAt', 'contractPackageVersion',
    'protocols', 'components', 'artifacts', 'rollbackFloor', 'signature'
  ]);
  if (value.schemaVersion !== RELEASE_SET_SCHEMA_VERSION) fail('schema version is unsupported');
  const releaseSetSequence = integer(value.releaseSetSequence, 1, Number.MAX_SAFE_INTEGER, 'sequence');
  const issuedAt = instant(value.issuedAt, 'issuedAt');
  const expiresAt = instant(value.expiresAt, 'expiresAt');
  if (Date.parse(issuedAt) >= Date.parse(expiresAt)) fail('expiry must follow issuance');
  const contractPackageVersion = pattern(value.contractPackageVersion, VERSION, 'contract package version');

  const protocolValue = exact(value.protocols, ['control', 'conversation', 'workspaceLayout']);
  const protocols = {
    control: range(protocolValue.control, 'control'),
    conversation: range(protocolValue.conversation, 'conversation'),
    workspaceLayout: range(protocolValue.workspaceLayout, 'workspace layout')
  };

  const componentValue = exact(value.components, COMPONENTS);
  const components = Object.fromEntries(
    COMPONENTS.map((id) => [id, component(componentValue[id], id)])
  ) as Record<ReleaseComponentId, ReleaseComponent>;
  for (const [id, selected] of Object.entries(components) as [ReleaseComponentId, ReleaseComponent][]) {
    for (const [dependency, accepted] of Object.entries(selected.compatibility) as [ReleaseComponentId, ReleaseSequenceRange][]) {
      if (dependency === id) fail(`${id} cannot depend on itself`);
      const dependencySequence = components[dependency].sequence;
      if (dependencySequence < accepted.minimum || dependencySequence > accepted.maximum) {
        fail(`${id} is incompatible with ${dependency}`);
      }
    }
  }

  if (!Array.isArray(value.artifacts) || value.artifacts.length > 64) fail('artifacts are invalid');
  const artifactIds = new Set<string>();
  const artifacts = value.artifacts.map((candidate) => {
    const item = exact(candidate, [
      'id', 'component', 'componentSequence', 'version', 'platform', 'architecture', 'url',
      'sha256', 'size', 'sourceRepository', 'sourceCommit', 'contractPackageVersion',
      'sbomSha256', 'licenseSha256'
    ]);
    const id = pattern(item.id, TOKEN, 'artifact id');
    if (artifactIds.has(id)) fail('artifact id is duplicated');
    artifactIds.add(id);
    const componentId = member(item.component, COMPONENTS, 'artifact component');
    const componentSequence = integer(item.componentSequence, 1, Number.MAX_SAFE_INTEGER, 'artifact component sequence');
    const version = pattern(item.version, VERSION, 'artifact version');
    const platform = member(item.platform, ['windows', 'android', 'linux', 'termux', 'any'] as const, 'artifact platform');
    const architecture = member(item.architecture, ['x86_64', 'arm64', 'universal', 'any'] as const, 'artifact architecture');
    const url = httpsUrl(item.url);
    const sha256 = pattern(item.sha256, /^[a-f0-9]{64}$/u, 'artifact digest');
    const size = integer(item.size, 1, 2 * 1024 * 1024 * 1024, 'artifact size');
    const sourceRepository = httpsUrl(item.sourceRepository);
    const sourceCommit = pattern(item.sourceCommit, /^[a-f0-9]{40}$/u, 'artifact source commit');
    const artifactContractVersion = pattern(item.contractPackageVersion, VERSION, 'artifact contract package version');
    const sbomSha256 = pattern(item.sbomSha256, /^[a-f0-9]{64}$/u, 'artifact SBOM digest');
    const licenseSha256 = pattern(item.licenseSha256, /^[a-f0-9]{64}$/u, 'artifact license digest');
    const selected = components[componentId];
    if (componentSequence !== selected.sequence || version !== selected.version) fail('artifact component identity does not match');
    if (artifactContractVersion !== contractPackageVersion) fail('artifact contract package version does not match');
    return {
      id, component: componentId, componentSequence, version, platform, architecture, url, sha256, size,
      sourceRepository, sourceCommit, contractPackageVersion: artifactContractVersion, sbomSha256, licenseSha256
    };
  });

  const floorValue = exact(value.rollbackFloor, ['releaseSetSequence', 'componentSequences']);
  const sequenceValues = exact(floorValue.componentSequences, COMPONENTS);
  const componentSequences = Object.fromEntries(COMPONENTS.map((id) => {
    const sequence = integer(sequenceValues[id], 0, components[id].sequence, `${id} rollback floor`);
    return [id, sequence];
  })) as Record<ReleaseComponentId, number>;
  const rollbackFloor = {
    releaseSetSequence: integer(floorValue.releaseSetSequence, 0, releaseSetSequence, 'rollback release sequence'),
    componentSequences
  };
  const signatureValue = exact(value.signature, ['algorithm', 'keyId', 'value']);
  if (signatureValue.algorithm !== 'ed25519') fail('signature algorithm is unsupported');
  const signature = {
    algorithm: 'ed25519' as const,
    keyId: pattern(signatureValue.keyId, /^[a-f0-9]{32}$/u, 'signature key'),
    value: pattern(signatureValue.value, /^[A-Za-z0-9_-]{64,128}$/u, 'signature value')
  };
  return {
    schemaVersion: 1, releaseSetSequence, issuedAt, expiresAt, contractPackageVersion,
    protocols, components, artifacts, rollbackFloor, signature
  };
}

function component(input: unknown, label: string): ReleaseComponent {
  const value = exact(input, ['sequence', 'version', 'compatibility']);
  const compatibilityValue = atMost(value.compatibility, COMPONENTS);
  const compatibility = Object.fromEntries(Object.entries(compatibilityValue).map(([dependency, accepted]) => [
    dependency, sequenceRange(accepted, `${label} ${dependency}`)
  ])) as Partial<Record<ReleaseComponentId, ReleaseSequenceRange>>;
  return {
    sequence: integer(value.sequence, 1, Number.MAX_SAFE_INTEGER, `${label} sequence`),
    version: pattern(value.version, VERSION, `${label} version`),
    compatibility
  };
}

function range(input: unknown, label: string): ReleaseProtocolRange {
  const value = exact(input, ['minimum', 'maximum']);
  const minimum = integer(value.minimum, 1, 1024, `${label} minimum`);
  const maximum = integer(value.maximum, 1, 1024, `${label} maximum`);
  if (minimum > maximum) fail(`${label} range is inverted`);
  return { minimum, maximum };
}

function sequenceRange(input: unknown, label: string): ReleaseSequenceRange {
  const value = exact(input, ['minimum', 'maximum']);
  const minimum = integer(value.minimum, 1, Number.MAX_SAFE_INTEGER, `${label} minimum`);
  const maximum = integer(value.maximum, 1, Number.MAX_SAFE_INTEGER, `${label} maximum`);
  if (minimum > maximum) fail(`${label} range is inverted`);
  return { minimum, maximum };
}

function exact(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('object shape is invalid');
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) fail('object fields are invalid');
  return value;
}

function atMost(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('object shape is invalid');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((item) => !fields.includes(item))) fail('object fields are invalid');
  return value;
}

function integer(input: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < minimum || (input as number) > maximum) fail(`${label} is invalid`);
  return input as number;
}

function pattern(input: unknown, expression: RegExp, label: string): string {
  if (typeof input !== 'string' || !expression.test(input)) fail(`${label} is invalid`);
  return input;
}

function instant(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length > 40 || !Number.isFinite(Date.parse(input))) fail(`${label} is invalid`);
  return input;
}

function member<const T extends readonly string[]>(input: unknown, values: T, label: string): T[number] {
  if (typeof input !== 'string' || !values.includes(input)) fail(`${label} is invalid`);
  return input as T[number];
}

function httpsUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) fail('artifact URL is invalid');
  try {
    const value = new URL(input);
    if (value.protocol !== 'https:' || value.username || value.password) fail('artifact URL is invalid');
    return input;
  } catch {
    fail('artifact URL is invalid');
  }
}

function fail(message: string): never {
  throw new Error(`Invalid release set: ${message}`);
}
