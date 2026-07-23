import type {
  FleetAttention,
  FleetBackend,
  FleetFavorite,
  FleetHost,
  FleetEndpoint,
  FleetExecutionTarget,
  FleetUsageLimit,
  FleetSchedule,
  FleetSession,
  FleetSnapshot,
  FleetTool
} from './fleet';

export const FLEET_PROTOCOL_VERSION = 1;
export const FLEET_MAX_FRAME_BYTES = 256 * 1024;

export interface BridgeHostSnapshot {
  id: string;
  name: string;
  platform: 'wsl' | 'linux' | 'termux';
  transport: 'local' | 'tailscale' | 'ssh';
  status: 'healthy' | 'connecting' | 'offline';
  lastSeenAt: string | null;
  errorCode: string;
  capabilities: string[];
  wtmuxVersion: string;
  agentVersion: string;
  protocolVersion: 1;
  timeZone: string;
}

export interface BridgeSessionSnapshot {
  id: string;
  hostId: string;
  physicalHostId?: string;
  executionTargetId?: 'linux' | 'windows';
  internalName: string;
  name: string;
  title: string;
  nameMode: 'automatic' | 'manual';
  project: string;
  projectPath: string;
  locationKind: 'project' | 'custom';
  tool: FleetTool;
  backend: 'linux' | 'windows';
  activity: 'active' | 'idle';
  attached: boolean;
  updatedAt: string | null;
  pendingScheduleCount: number;
}

export interface BridgePhysicalHostSnapshot {
  id: string;
  name: string;
  platform: 'wsl' | 'linux' | 'termux';
  status: 'healthy' | 'connecting' | 'offline';
  lastSeenAt: string | null;
  errorCode: string;
  endpointIds: string[];
  executionTargetIds: Array<'linux' | 'windows'>;
  legacyHostIds: string[];
}
export type BridgeEndpointSnapshot = FleetEndpoint;
export type BridgeExecutionTargetSnapshot = FleetExecutionTarget;

export interface BridgeScheduleSnapshot {
  id: string;
  hostId: string;
  sessionId: string;
  kind: 'scheduled-message';
  backend: 'linux' | 'windows';
  agent: 'codex' | 'claude' | 'unknown';
  deliverAt: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  outcomeCode: string;
}

export interface BridgeAttentionSnapshot {
  id: string;
  hostId: string;
  kind: 'hard-limit';
  sessionId: string;
  agent: 'codex' | 'claude' | 'unknown';
  resetAt: string | null;
  state: string;
  detectedAt: string | null;
  updatedAt: string | null;
}

export interface BridgeLimitWindowSnapshot {
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string;
  windowMinutes: number;
}

export interface BridgeLimitSnapshot {
  id: string;
  hostId: string;
  provider: 'codex';
  profileAlias: string;
  status: 'ready' | 'limited';
  primary: BridgeLimitWindowSnapshot | null;
  secondary: BridgeLimitWindowSnapshot | null;
  updatedAt: string;
}

export interface BridgeFleetSnapshot {
  revision: string;
  presentationRevision?: string;
  generatedAt: string;
  hosts: BridgeHostSnapshot[];
  fleetId?: string;
  physicalHosts: BridgePhysicalHostSnapshot[];
  endpoints: BridgeEndpointSnapshot[];
  executionTargets: BridgeExecutionTargetSnapshot[];
  sessions: BridgeSessionSnapshot[];
  schedules: BridgeScheduleSnapshot[];
  attention: BridgeAttentionSnapshot[];
  limits: BridgeLimitSnapshot[];
  presets: FleetFavorite[];
  pairingRequests: BridgePairingRequest[];
}

export interface BridgePairingRequest {
  id: string;
  deviceName: string;
  platform: string;
  peer: string;
  requestedAt: string;
  expiresAt: string;
  status: 'awaiting-review' | 'approved' | 'rejected';
}

export type FleetBridgeStatus = 'starting' | 'live' | 'cached' | 'offline' | 'error';

export interface FleetBridgeView {
  status: FleetBridgeStatus;
  snapshot: FleetSnapshot;
  cacheSavedAt: string | null;
  errorCode: string;
}

export type FleetMutationMethod = 'session.create' | 'session.kill' | 'schedule.cancel' | 'schedule.create' | 'schedule.update'
  | 'attention.dismiss'
  | 'host.doctor' | 'host.update' | 'session.rename' | 'session.name.reset'
  | 'directory.list' | 'directory.create' | 'repository.list' | 'repository.search'
  | 'session.model.get' | 'session.model.set' | 'session.model.cancel'
  | 'preset.upsert' | 'preset.delete'
  | 'pairing.invite' | 'pairing.review' | 'pairing.approve' | 'pairing.reject' | 'pairing.revoke';

export interface PairingInvitation {
  invitationId: string;
  shortCode: string;
  bootstrapPeer: string;
  bootstrapUser: string;
  expiresAt: string;
  link: string;
  termuxCommand: string;
}

export interface PairingProposalReview extends BridgePairingRequest {
  peerIp: string;
  proposal: Record<string, unknown>;
}

export interface FleetMutationResult {
  operationId: string;
  status: string;
  snapshot: FleetSnapshot;
  scheduleId?: string;
  sessionId?: string;
  invitation?: PairingInvitation;
  pairingRequest?: PairingProposalReview;
  doctor?: FleetDoctorResult;
  path?: string;
}

export interface FleetDirectoryEntry { name: string; path: string }
export interface FleetDirectoryShortcut { id: string; label: string; path: string }
export interface FleetDirectoryListing {
  backend: 'linux' | 'windows';
  path: string;
  parentPath: string | null;
  entries: FleetDirectoryEntry[];
  shortcuts: FleetDirectoryShortcut[];
  truncated: boolean;
}

export interface FleetRepositoryEntry {
  name: string;
  relativePath: string;
  kind: 'directory' | 'file';
  size: number | null;
  modifiedAt: string;
  hidden: boolean;
  isLink: boolean;
}

export interface FleetRepositoryPage {
  rootName: string;
  relativePath: string;
  parentPath: string | null;
  entries: FleetRepositoryEntry[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface FleetModelEffortOption { id: string; label: string }
export interface FleetModelOption {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
  efforts: FleetModelEffortOption[];
  defaultEffort: string;
}
export interface FleetModelSelection {
  modelId: string;
  modelLabel: string;
  effortId: string;
  effortLabel: string;
}
export interface FleetPendingModelChange {
  operationId: string;
  modelId: string;
  effortId: string;
  custom: boolean;
  requestedAt: string;
  expiresAt: string;
}
export interface FleetModelControlState {
  sessionId: string;
  configRevision: string;
  tool: 'codex' | 'claude' | 'copilot';
  status: 'ready' | 'queued' | 'applying' | 'cancelled' | 'already-clear' | 'expired' | 'error' | 'unknown';
  selected: FleetModelSelection;
  effective: FleetModelSelection | null;
  pending: FleetPendingModelChange | null;
  catalog: { models: FleetModelOption[]; customAllowed: boolean } | null;
  detail: string;
}
export interface FleetModelControlMutationResult {
  operationId: string;
  status: string;
  modelControl: FleetModelControlState;
}

export interface FleetDoctorCheck {
  id: string;
  status: 'healthy' | 'attention' | 'failure';
  summary: string;
  detail: string;
}

export interface FleetDoctorResult {
  hostId: string;
  checkedAt: string;
  status: 'healthy' | 'attention' | 'failure';
  checks: FleetDoctorCheck[];
}

const FORBIDDEN_KEYS = new Set(['message', 'prompt', 'output', 'transcript', 'panetitle', 'command']);

export function parseBridgeFleetSnapshot(input: unknown): BridgeFleetSnapshot {
  const candidate = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const snapshotFields = ['revision', 'generatedAt', 'hosts', 'sessions', 'schedules', 'attention'];
  if ('limits' in candidate) snapshotFields.push('limits');
  if ('presets' in candidate) snapshotFields.push('presets');
  if ('pairingRequests' in candidate) snapshotFields.push('pairingRequests');
  if ('presentationRevision' in candidate) snapshotFields.push('presentationRevision');
  const graphFieldNames = ['fleetId', 'physicalHosts', 'endpoints', 'executionTargets'] as const;
  const graphFieldCount = graphFieldNames.filter((field) => field in candidate).length;
  if (graphFieldCount !== 0 && graphFieldCount !== graphFieldNames.length) fail('identity graph fields are incomplete');
  const includesIdentityGraph = graphFieldCount === graphFieldNames.length;
  if (includesIdentityGraph) snapshotFields.push(...graphFieldNames);
  const root = exactObject(input, snapshotFields, 'snapshot');
  rejectPrivateFields(root);
  const revision = text(root.revision, 'revision', 64, false);
  const presentationRevision = 'presentationRevision' in root
    ? text(root.presentationRevision, 'presentationRevision', 64, false) : undefined;
  const generatedAt = instant(root.generatedAt, 'generatedAt', false) as string;
  const hosts = array(root.hosts, 'hosts', 256).map(parseHost);
  const hostIds = new Set(hosts.map((host) => host.id));
  if (hostIds.size !== hosts.length) fail('hosts contain a duplicate id');
  const sessions = array(root.sessions, 'sessions', 500).map((value) => parseSession(
    value, hostIds, Boolean(presentationRevision), includesIdentityGraph
  ));
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) fail('sessions contain a duplicate id');
  const schedules = array(root.schedules, 'schedules', 500).map((value) => parseSchedule(value, hostIds));
  const attention = array(root.attention, 'attention', 500).map((value) => parseAttention(value, hostIds));
  const limits = 'limits' in root ? array(root.limits, 'limits', 100).map((value) => parseLimit(value, hostIds)) : [];
  const presets = 'presets' in root ? array(root.presets, 'presets', 100).map((value) => parsePreset(value, hostIds)) : [];
  const pairingRequests = 'pairingRequests' in root
    ? array(root.pairingRequests, 'pairingRequests', 256).map(parsePairingRequest)
    : [];
  const identity = includesIdentityGraph
    ? parseIdentityGraph(root, hosts, sessions)
    : legacyIdentityGraph(hosts, sessions);
  return {
    revision,
    ...(presentationRevision ? { presentationRevision } : {}),
    generatedAt,
    hosts,
    sessions,
    schedules,
    attention,
    limits,
    presets,
    pairingRequests,
    ...identity
  };
}

export function toFleetSnapshot(raw: BridgeFleetSnapshot, distro: string): FleetSnapshot {
  const sessions = raw.sessions.map((session) => toSession(session, raw.presets));
  const hostTimeZones = new Map(raw.hosts.map((host) => [host.id, host.timeZone]));
  return {
    revision: raw.revision,
    ...(raw.presentationRevision ? { presentationRevision: raw.presentationRevision } : {}),
    generatedAt: raw.generatedAt,
    registrySyncedAt: raw.generatedAt,
    controller: { distro, status: raw.hosts.some((host) => host.status === 'healthy') ? 'healthy' : 'offline', protocolVersion: 1 },
    hosts: raw.hosts.map((host) => toHost(host, sessions)),
    physicalHosts: raw.physicalHosts.map((host) => ({
      ...host,
      status: host.status === 'healthy' ? 'healthy' : 'offline'
    })),
    endpoints: raw.endpoints,
    executionTargets: raw.executionTargets,
    sessions,
    schedules: raw.schedules.map((schedule) => toSchedule(schedule, hostTimeZones.get(schedule.hostId) ?? '')),
    attention: raw.attention.filter((item) => ['detected', 'offering', 'offered'].includes(item.state)).map(toAttention),
    favorites: raw.presets,
    events: [],
    pairingRequests: raw.pairingRequests,
    limits: raw.limits.map(toUsageLimit)
  };
}

export function emptyFleetSnapshot(distro: string, generatedAt = new Date().toISOString()): FleetSnapshot {
  return {
    revision: 'empty',
    generatedAt,
    registrySyncedAt: generatedAt,
    controller: { distro, status: 'offline', protocolVersion: 1 },
    hosts: [],
    physicalHosts: [],
    endpoints: [],
    executionTargets: [],
    sessions: [],
    schedules: [],
    attention: [],
    favorites: [],
    events: [],
    pairingRequests: [],
    limits: []
  };
}

export function parseFleetDirectoryListing(input: unknown): FleetDirectoryListing {
  const value = exactObject(input, ['backend', 'path', 'parentPath', 'entries', 'shortcuts', 'truncated'], 'directory listing');
  const backend = oneOf(value.backend, 'directory.backend', ['linux', 'windows']);
  const path = text(value.path, 'directory.path', 2048, false);
  const parentPath = value.parentPath === null ? null : text(value.parentPath, 'directory.parentPath', 2048, false);
  const entries = array(value.entries, 'directory.entries', 1000).map((entry) => {
    const item = exactObject(entry, ['name', 'path'], 'directory entry');
    return { name: text(item.name, 'directory entry name', 255, false), path: text(item.path, 'directory entry path', 2048, false) };
  });
  const shortcuts = array(value.shortcuts, 'directory.shortcuts', 64).map((shortcut) => {
    const item = exactObject(shortcut, ['id', 'label', 'path'], 'directory shortcut');
    return {
      id: text(item.id, 'directory shortcut id', 80, false),
      label: text(item.label, 'directory shortcut label', 80, false),
      path: text(item.path, 'directory shortcut path', 2048, false)
    };
  });
  return { backend, path, parentPath, entries, shortcuts, truncated: boolean(value.truncated, 'directory.truncated') };
}

export function parseFleetRepositoryPage(input: unknown): FleetRepositoryPage {
  const value = exactObject(input, ['rootName', 'relativePath', 'parentPath', 'entries', 'nextCursor', 'truncated'], 'repository page');
  const parentPath = value.parentPath === null ? null : text(value.parentPath, 'repository.parentPath', 2048);
  const nextCursor = value.nextCursor === null ? null : text(value.nextCursor, 'repository.nextCursor', 2048, false);
  const entries = array(value.entries, 'repository.entries', 250).map((entry) => {
    const item = exactObject(entry, ['name', 'relativePath', 'kind', 'size', 'modifiedAt', 'hidden', 'isLink'], 'repository entry');
    const kind = oneOf(item.kind, 'repository.kind', ['directory', 'file']);
    const size = item.size === null ? null : integer(item.size, 'repository.size', 0, 2 * 1024 * 1024 * 1024);
    if ((kind === 'directory') !== (size === null)) fail('repository entry size does not match its kind');
    return {
      name: text(item.name, 'repository.name', 255, false),
      relativePath: repositoryPath(item.relativePath, 'repository.relativePath', false),
      kind,
      size,
      modifiedAt: instant(item.modifiedAt, 'repository.modifiedAt', false) as string,
      hidden: boolean(item.hidden, 'repository.hidden'),
      isLink: boolean(item.isLink, 'repository.isLink')
    };
  });
  return {
    rootName: text(value.rootName, 'repository.rootName', 255, false),
    relativePath: repositoryPath(value.relativePath, 'repository.relativePath', true),
    parentPath: parentPath === null ? null : repositoryPath(parentPath, 'repository.parentPath', true),
    entries,
    nextCursor,
    truncated: boolean(value.truncated, 'repository.truncated')
  };
}

export function parseFleetModelControlState(input: unknown): FleetModelControlState {
  const value = exactObject(input, [
    'sessionId', 'configRevision', 'tool', 'status', 'selected', 'effective', 'pending', 'catalog', 'detail'
  ], 'model control');
  const parseSelection = (inputSelection: unknown, nullable: boolean): FleetModelSelection | null => {
    if (inputSelection === null && nullable) return null;
    const selection = exactObject(inputSelection, ['modelId', 'modelLabel', 'effortId', 'effortLabel'], 'model selection');
    return {
      modelId: modelIdentifier(selection.modelId, 'model selection model'),
      modelLabel: text(selection.modelLabel, 'model selection label', 120, false),
      effortId: effortIdentifier(selection.effortId, 'model selection effort'),
      effortLabel: text(selection.effortLabel, 'model selection effort label', 120, false)
    };
  };
  const pendingValue = value.pending === null ? null
    : exactObject(value.pending, ['operationId', 'modelId', 'effortId', 'custom', 'requestedAt', 'expiresAt'], 'pending model control');
  const pending = pendingValue === null ? null : {
    operationId: token(pendingValue.operationId, 'pending model operation', 160),
    modelId: modelIdentifier(pendingValue.modelId, 'pending model'),
    effortId: effortIdentifier(pendingValue.effortId, 'pending effort'),
    custom: boolean(pendingValue.custom, 'pending custom flag'),
    requestedAt: instant(pendingValue.requestedAt, 'pending model requestedAt', false) as string,
    expiresAt: instant(pendingValue.expiresAt, 'pending model expiresAt', false) as string
  };
  const catalogValue = value.catalog === null ? null : exactObject(value.catalog, ['models', 'customAllowed'], 'model catalog');
  const catalog = catalogValue === null ? null : {
    customAllowed: boolean(catalogValue.customAllowed, 'model catalog custom flag'),
    models: array(catalogValue.models, 'model catalog models', 128).map((candidate) => {
      const item = exactObject(candidate, ['id', 'label', 'description', 'isDefault', 'efforts', 'defaultEffort'], 'model catalog entry');
      const efforts = array(item.efforts, 'model efforts', 16).map((candidateEffort) => {
        const effort = exactObject(candidateEffort, ['id', 'label'], 'model effort');
        return { id: effortIdentifier(effort.id, 'model effort id'), label: text(effort.label, 'model effort label', 80, false) };
      });
      if (!efforts.length) fail('model catalog entry has no efforts');
      const defaultEffort = effortIdentifier(item.defaultEffort, 'model default effort');
      if (!efforts.some((effort) => effort.id === defaultEffort)) fail('model default effort is unavailable');
      return {
        id: modelIdentifier(item.id, 'model id'),
        label: text(item.label, 'model label', 120, false),
        description: text(item.description, 'model description', 240),
        isDefault: boolean(item.isDefault, 'model default flag'), efforts, defaultEffort
      };
    })
  };
  if (catalog && !catalog.models.length) fail('model catalog is empty');
  return {
    sessionId: token(value.sessionId, 'model control session', 320),
    configRevision: revision(value.configRevision, 'model control revision'),
    tool: oneOf(value.tool, 'model control tool', ['codex', 'claude', 'copilot']),
    status: oneOf(value.status, 'model control status', [
      'ready', 'queued', 'applying', 'cancelled', 'already-clear', 'expired', 'error', 'unknown'
    ]),
    selected: parseSelection(value.selected, false) as FleetModelSelection,
    effective: parseSelection(value.effective, true), pending, catalog,
    detail: text(value.detail, 'model control detail', 240)
  };
}

export function parseFleetModelControlMutationResult(input: unknown): FleetModelControlMutationResult {
  const value = exactObject(input, ['operationId', 'status', 'modelControl'], 'model control mutation');
  return {
    operationId: token(value.operationId, 'model control operation', 160),
    status: token(value.status, 'model control mutation status', 32),
    modelControl: parseFleetModelControlState(value.modelControl)
  };
}

function modelIdentifier(input: unknown, label: string): string {
  const value = text(input, label, 160, false);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\\-]{0,159}$/u.test(value)) fail(`${label} is invalid`);
  return value;
}

function effortIdentifier(input: unknown, label: string): string {
  const value = text(input, label, 64, false);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+\\-]{0,63}$/u.test(value)) fail(`${label} is invalid`);
  return value;
}

function token(input: unknown, label: string, maximum: number): string {
  const value = text(input, label, maximum, false);
  if (!/^[A-Za-z0-9._:-]+$/u.test(value)) fail(`${label} is invalid`);
  return value;
}

function revision(input: unknown, label: string): string {
  const value = text(input, label, 16, false);
  if (!/^[a-f0-9]{16}$/u.test(value)) fail(`${label} is invalid`);
  return value;
}

function repositoryPath(input: unknown, label: string, empty: boolean): string {
  const value = text(input, label, 2048, empty);
  if (value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)
    || (value && value.split('/').some((part) => !part || part === '.' || part === '..'))) {
    fail(`${label} is invalid`);
  }
  return value;
}

function parseIdentityGraph(
  root: Record<string, unknown>,
  hosts: BridgeHostSnapshot[],
  sessions: BridgeSessionSnapshot[]
): Pick<BridgeFleetSnapshot, 'fleetId' | 'physicalHosts' | 'endpoints' | 'executionTargets'> {
  const fleetId = text(root.fleetId, 'fleetId', 160, false);
  const physicalHosts = array(root.physicalHosts, 'physicalHosts', 256).map((input) => {
    const value = exactObject(input, [
      'id', 'name', 'platform', 'status', 'lastSeenAt', 'errorCode',
      'endpointIds', 'executionTargetIds', 'legacyHostIds'
    ], 'physical host');
    return {
      id: text(value.id, 'physicalHost.id', 160, false),
      name: text(value.name, 'physicalHost.name', 256, false),
      platform: oneOf(value.platform, 'physicalHost.platform', ['wsl', 'linux', 'termux']),
      status: oneOf(value.status, 'physicalHost.status', ['healthy', 'connecting', 'offline']),
      lastSeenAt: instant(value.lastSeenAt, 'physicalHost.lastSeenAt'),
      errorCode: text(value.errorCode, 'physicalHost.errorCode', 64),
      endpointIds: uniqueStrings(value.endpointIds, 'physicalHost.endpointIds', 16, 160, true),
      executionTargetIds: uniqueStrings(value.executionTargetIds, 'physicalHost.executionTargetIds', 16, 16, true)
        .map((id) => oneOf(id, 'physicalHost.executionTargetId', ['linux', 'windows'])),
      legacyHostIds: uniqueStrings(value.legacyHostIds, 'physicalHost.legacyHostIds', 16, 160, true)
    } satisfies BridgePhysicalHostSnapshot;
  });
  const physicalIds = new Set(physicalHosts.map((host) => host.id));
  if (physicalIds.size !== physicalHosts.length) fail('physical hosts contain a duplicate id');
  const legacyAliases = physicalHosts.flatMap((host) => host.legacyHostIds);
  if (new Set(legacyAliases).size !== legacyAliases.length) fail('physical hosts contain a duplicate legacy alias');
  const rawHostIds = new Set(hosts.map((host) => host.id));
  if ([...rawHostIds].some((id) => !legacyAliases.includes(id))) fail('legacy host is missing from the identity graph');

  const endpoints = array(root.endpoints, 'endpoints', 512).map((input) => {
    const value = exactObject(input, [
      'id', 'physicalHostId', 'network', 'address', 'port', 'sshEngine', 'authentication',
      'status', 'identityState', 'sshHostKeySha256', 'tailscaleNodeId', 'errorCode'
    ], 'endpoint');
    const physicalHostId = text(value.physicalHostId, 'endpoint.physicalHostId', 160, false);
    if (!physicalIds.has(physicalHostId)) fail('endpoint references an unknown physical host');
    return {
      id: text(value.id, 'endpoint.id', 160, false),
      physicalHostId,
      network: oneOf(value.network, 'endpoint.network', ['local', 'tailnet', 'direct']),
      address: text(value.address, 'endpoint.address', 253, false),
      port: integer(value.port, 'endpoint.port', 1, 65535),
      sshEngine: oneOf(value.sshEngine, 'endpoint.sshEngine', ['openssh', 'tailscale-cli']),
      authentication: oneOf(value.authentication, 'endpoint.authentication', ['tailnet-ssh', 'key']),
      status: oneOf(value.status, 'endpoint.status', ['healthy', 'connecting', 'offline']),
      identityState: oneOf(value.identityState, 'endpoint.identityState', ['verified', 'unverified', 'reverify-required']),
      sshHostKeySha256: text(value.sshHostKeySha256, 'endpoint.sshHostKeySha256', 96),
      tailscaleNodeId: text(value.tailscaleNodeId, 'endpoint.tailscaleNodeId', 128),
      errorCode: text(value.errorCode, 'endpoint.errorCode', 64)
    } satisfies BridgeEndpointSnapshot;
  });
  if (new Set(endpoints.map((endpoint) => endpoint.id)).size !== endpoints.length) fail('endpoints contain a duplicate id');

  const executionTargets = array(root.executionTargets, 'executionTargets', 512).map((input) => {
    const value = exactObject(input, ['id', 'physicalHostId', 'kind', 'label', 'status', 'fingerprint'], 'execution target');
    const id = oneOf(value.id, 'executionTarget.id', ['linux', 'windows']);
    const physicalHostId = text(value.physicalHostId, 'executionTarget.physicalHostId', 160, false);
    if (!physicalIds.has(physicalHostId)) fail('execution target references an unknown physical host');
    const kind = oneOf(value.kind, 'executionTarget.kind', ['linux', 'windows-git-bash']);
    if ((id === 'linux') !== (kind === 'linux')) fail('execution target kind does not match its id');
    return {
      id,
      physicalHostId,
      kind,
      label: text(value.label, 'executionTarget.label', 128, false),
      status: oneOf(value.status, 'executionTarget.status', ['available', 'unavailable', 'unknown']),
      fingerprint: text(value.fingerprint, 'executionTarget.fingerprint', 160)
    } satisfies BridgeExecutionTargetSnapshot;
  });
  const targetKeys = executionTargets.map((target) => `${target.physicalHostId}:${target.id}`);
  if (new Set(targetKeys).size !== targetKeys.length) fail('execution targets contain a duplicate scoped id');
  for (const host of physicalHosts) {
    if (host.endpointIds.some((id) => !endpoints.some((endpoint) => endpoint.id === id && endpoint.physicalHostId === host.id))) {
      fail('physical host references an unknown endpoint');
    }
    if (host.executionTargetIds.some((id) => !executionTargets.some((target) => target.id === id && target.physicalHostId === host.id))) {
      fail('physical host references an unknown execution target');
    }
  }
  for (const session of sessions) {
    const physicalHost = physicalHosts.find((host) => host.id === session.physicalHostId);
    if (!physicalHost || !physicalHost.legacyHostIds.includes(session.hostId)) fail('session physical host identity is inconsistent');
    if (!executionTargets.some((target) =>
      target.physicalHostId === session.physicalHostId && target.id === session.executionTargetId)) {
      fail('session references an unknown execution target');
    }
    if (session.executionTargetId !== session.backend) fail('session backend and execution target differ');
  }
  return { fleetId, physicalHosts, endpoints, executionTargets };
}

function legacyIdentityGraph(
  hosts: BridgeHostSnapshot[],
  sessions: BridgeSessionSnapshot[]
): Pick<BridgeFleetSnapshot, 'physicalHosts' | 'endpoints' | 'executionTargets'> {
  const physicalHosts = hosts.map((host) => ({
    id: host.id,
    name: host.name,
    platform: host.platform,
    status: host.status,
    lastSeenAt: host.lastSeenAt,
    errorCode: host.errorCode,
    endpointIds: [],
    executionTargetIds: (host.platform === 'wsl' ? ['linux', 'windows'] : ['linux']) as Array<'linux' | 'windows'>,
    legacyHostIds: [host.id]
  }));
  const executionTargets = physicalHosts.flatMap((host) => host.executionTargetIds.map((id) => ({
    id,
    physicalHostId: host.id,
    kind: id === 'windows' ? 'windows-git-bash' as const : 'linux' as const,
    label: id === 'windows' ? 'Windows Git Bash' : host.platform === 'wsl' ? 'WSL' : 'Linux',
    status: host.status === 'healthy' ? 'available' as const : 'unknown' as const,
    fingerprint: ''
  })));
  sessions.forEach((session) => {
    session.physicalHostId = session.hostId;
    session.executionTargetId = session.backend;
  });
  return { physicalHosts, endpoints: [], executionTargets };
}

function parseHost(input: unknown): BridgeHostSnapshot {
  const value = exactObject(input, [
    'id', 'name', 'platform', 'transport', 'status', 'lastSeenAt', 'errorCode', 'capabilities',
    'wtmuxVersion', 'agentVersion', 'protocolVersion', 'timeZone'
  ], 'host');
  return {
    id: text(value.id, 'host.id', 160, false),
    name: text(value.name, 'host.name', 256, false),
    platform: oneOf(value.platform, 'host.platform', ['wsl', 'linux', 'termux']),
    transport: oneOf(value.transport, 'host.transport', ['local', 'tailscale', 'ssh']),
    status: oneOf(value.status, 'host.status', ['healthy', 'connecting', 'offline']),
    lastSeenAt: instant(value.lastSeenAt, 'host.lastSeenAt'),
    errorCode: text(value.errorCode, 'host.errorCode', 64),
    capabilities: array(value.capabilities, 'host.capabilities', 32).map((item) => text(item, 'capability', 64, false)),
    wtmuxVersion: text(value.wtmuxVersion, 'host.wtmuxVersion', 64),
    agentVersion: text(value.agentVersion, 'host.agentVersion', 64),
    protocolVersion: literal(value.protocolVersion, 'host.protocolVersion', 1),
    timeZone: text(value.timeZone, 'host.timeZone', 64)
  };
}

function parseSession(
  input: unknown,
  hostIds: ReadonlySet<string>,
  includeTitles: boolean,
  includeIdentityGraph: boolean
): BridgeSessionSnapshot {
  const candidate = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const fields = [
    'id', 'hostId', 'internalName', 'name', 'title', 'project', 'tool', 'backend', 'activity',
    'attached', 'updatedAt', 'pendingScheduleCount'
  ];
  if ('projectPath' in candidate || 'locationKind' in candidate) fields.push('projectPath', 'locationKind');
  if ('nameMode' in candidate) fields.push('nameMode');
  if ('physicalHostId' in candidate || 'executionTargetId' in candidate) fields.push('physicalHostId', 'executionTargetId');
  const value = exactObject(input, fields, 'session');
  const hostId = text(value.hostId, 'session.hostId', 160, false);
  if (!hostIds.has(hostId)) fail('session references an unknown host');
  const nameMode = 'nameMode' in value ? oneOf(value.nameMode, 'session.nameMode', ['automatic', 'manual']) : 'automatic';
  if (value.title !== '' && (!includeTitles || !('nameMode' in value))) {
    fail('pane-derived session titles are forbidden without negotiation');
  }
  if (includeIdentityGraph !== ('physicalHostId' in value && 'executionTargetId' in value)) {
    fail('session identity graph fields are incomplete or unnegotiated');
  }
  const backend = oneOf(value.backend, 'session.backend', ['linux', 'windows']);
  return {
    id: text(value.id, 'session.id', 320, false),
    hostId,
    ...('physicalHostId' in value ? {
      physicalHostId: text(value.physicalHostId, 'session.physicalHostId', 160, false),
      executionTargetId: oneOf(value.executionTargetId, 'session.executionTargetId', ['linux', 'windows'])
    } : {}),
    internalName: text(value.internalName, 'session.internalName', 128, false),
    name: text(value.name, 'session.name', 256, false),
    title: text(value.title, 'session.title', 120),
    nameMode,
    project: text(value.project, 'session.project', 256),
    projectPath: 'projectPath' in value ? text(value.projectPath, 'session.projectPath', 2048) : '',
    locationKind: 'locationKind' in value ? oneOf(value.locationKind, 'session.locationKind', ['project', 'custom']) : 'project',
    tool: oneOf(value.tool, 'session.tool', ['codex', 'claude', 'copilot', 'shell']),
    backend,
    activity: oneOf(value.activity, 'session.activity', ['active', 'idle']),
    attached: boolean(value.attached, 'session.attached'),
    updatedAt: instant(value.updatedAt, 'session.updatedAt'),
    pendingScheduleCount: integer(value.pendingScheduleCount, 'session.pendingScheduleCount', 0, 500)
  };
}

function parseSchedule(input: unknown, hostIds: ReadonlySet<string>): BridgeScheduleSnapshot {
  const value = exactObject(input, [
    'id', 'hostId', 'sessionId', 'kind', 'backend', 'agent', 'deliverAt', 'status', 'createdAt',
    'updatedAt', 'completedAt', 'outcomeCode'
  ], 'schedule');
  const hostId = text(value.hostId, 'schedule.hostId', 160, false);
  if (!hostIds.has(hostId)) fail('schedule references an unknown host');
  return {
    id: text(value.id, 'schedule.id', 160, false),
    hostId,
    sessionId: text(value.sessionId, 'schedule.sessionId', 320, false),
    kind: literal(value.kind, 'schedule.kind', 'scheduled-message'),
    backend: oneOf(value.backend, 'schedule.backend', ['linux', 'windows']),
    agent: oneOf(value.agent, 'schedule.agent', ['codex', 'claude', 'unknown']),
    deliverAt: instant(value.deliverAt, 'schedule.deliverAt'),
    status: text(value.status, 'schedule.status', 24, false),
    createdAt: instant(value.createdAt, 'schedule.createdAt'),
    updatedAt: instant(value.updatedAt, 'schedule.updatedAt'),
    completedAt: instant(value.completedAt, 'schedule.completedAt'),
    outcomeCode: text(value.outcomeCode, 'schedule.outcomeCode', 64)
  };
}

function parseAttention(input: unknown, hostIds: ReadonlySet<string>): BridgeAttentionSnapshot {
  const value = exactObject(input, [
    'id', 'hostId', 'kind', 'sessionId', 'agent', 'resetAt', 'state', 'detectedAt', 'updatedAt'
  ], 'attention');
  const hostId = text(value.hostId, 'attention.hostId', 160, false);
  if (!hostIds.has(hostId)) fail('attention item references an unknown host');
  return {
    id: text(value.id, 'attention.id', 160, false),
    hostId,
    kind: literal(value.kind, 'attention.kind', 'hard-limit'),
    sessionId: text(value.sessionId, 'attention.sessionId', 320, false),
    agent: oneOf(value.agent, 'attention.agent', ['codex', 'claude', 'unknown']),
    resetAt: instant(value.resetAt, 'attention.resetAt'),
    state: text(value.state, 'attention.state', 32, false),
    detectedAt: instant(value.detectedAt, 'attention.detectedAt'),
    updatedAt: instant(value.updatedAt, 'attention.updatedAt')
  };
}

function parsePairingRequest(input: unknown): BridgePairingRequest {
  const value = exactObject(input, ['id', 'deviceName', 'platform', 'peer', 'requestedAt', 'expiresAt', 'status'], 'pairing request');
  return {
    id: text(value.id, 'pairing.id', 160, false),
    deviceName: text(value.deviceName, 'pairing.deviceName', 128, false),
    platform: text(value.platform, 'pairing.platform', 32, false),
    peer: text(value.peer, 'pairing.peer', 253, false),
    requestedAt: instant(value.requestedAt, 'pairing.requestedAt', false) as string,
    expiresAt: instant(value.expiresAt, 'pairing.expiresAt', false) as string,
    status: oneOf(value.status, 'pairing.status', ['awaiting-review', 'approved', 'rejected'])
  };
}

function parseLimit(input: unknown, hostIds: ReadonlySet<string>): BridgeLimitSnapshot {
  const value = exactObject(input, [
    'id', 'hostId', 'provider', 'profileAlias', 'status', 'primary', 'secondary', 'updatedAt'
  ], 'limit');
  const hostId = text(value.hostId, 'limit.hostId', 160, false);
  if (!hostIds.has(hostId)) fail('limit references an unknown host');
  return {
    id: text(value.id, 'limit.id', 320, false),
    hostId,
    provider: literal(value.provider, 'limit.provider', 'codex'),
    profileAlias: text(value.profileAlias, 'limit.profileAlias', 64, false),
    status: oneOf(value.status, 'limit.status', ['ready', 'limited']),
    primary: parseLimitWindow(value.primary, 'limit.primary'),
    secondary: parseLimitWindow(value.secondary, 'limit.secondary'),
    updatedAt: instant(value.updatedAt, 'limit.updatedAt', false) as string
  };
}

function parseLimitWindow(input: unknown, label: string): BridgeLimitWindowSnapshot | null {
  if (input === null) return null;
  const value = exactObject(input, ['usedPercent', 'remainingPercent', 'resetsAt', 'windowMinutes'], label);
  return {
    usedPercent: finiteNumber(value.usedPercent, `${label}.usedPercent`, 0, 100),
    remainingPercent: finiteNumber(value.remainingPercent, `${label}.remainingPercent`, 0, 100),
    resetsAt: instant(value.resetsAt, `${label}.resetsAt`, false) as string,
    windowMinutes: integer(value.windowMinutes, `${label}.windowMinutes`, 1, 60 * 24 * 365)
  };
}

function parsePreset(input: unknown, hostIds: Set<string>): FleetFavorite {
  const value = exactObject(input, ['id', 'name', 'hostId', 'project', 'backend', 'tool', 'profileAlias'], 'preset');
  const hostId = text(value.hostId, 'preset.hostId', 160, false);
  if (!hostIds.has(hostId)) fail('preset references an unknown host');
  return {
    id: text(value.id, 'preset.id', 160, false),
    name: text(value.name, 'preset.name', 128, false),
    hostId,
    project: text(value.project, 'preset.project', 128, false),
    backend: oneOf(value.backend, 'preset.backend', ['linux', 'windows']),
    tool: oneOf(value.tool, 'preset.tool', ['shell', 'codex', 'claude', 'copilot']),
    profileAlias: text(value.profileAlias, 'preset.profileAlias', 64)
  };
}

function toHost(host: BridgeHostSnapshot, sessions: FleetSession[]): FleetHost {
  const status = host.status === 'healthy' ? 'healthy' : 'offline';
  return {
    id: host.id,
    name: host.name,
    machine: `${host.platform.toUpperCase()} · ${host.transport}`,
    platform: host.platform,
    status,
    lastSeenAt: host.lastSeenAt,
    timeZone: host.timeZone,
    wtmuxVersion: host.wtmuxVersion || 'unknown',
    protocolVersion: host.protocolVersion,
    sessionCount: sessions.filter((session) => session.hostId === host.id).length,
    detail: status === 'healthy' ? `Live through ${host.transport}` : host.errorCode ? humanCode(host.errorCode) : 'Connecting'
  };
}

function toSession(session: BridgeSessionSnapshot, presets: FleetFavorite[]): FleetSession {
  return {
    id: session.id,
    hostId: session.hostId,
    physicalHostId: session.physicalHostId ?? session.hostId,
    executionTargetId: session.executionTargetId ?? session.backend,
    internalName: session.internalName,
    name: session.name,
    title: session.title,
    nameMode: session.nameMode,
    project: session.project,
    projectPath: session.projectPath,
    tool: session.tool,
    backend: session.backend as FleetBackend,
    activity: session.activity,
    attached: session.attached,
    updatedAt: session.updatedAt,
    pendingScheduleCount: session.pendingScheduleCount,
    favorite: presets.some((preset) => preset.hostId === session.hostId && preset.project === session.project
      && preset.backend === session.backend && preset.tool === session.tool)
  };
}

function toSchedule(schedule: BridgeScheduleSnapshot, hostTimeZone: string): FleetSchedule {
  const supported = ['pending', 'delivered', 'cancelled', 'interrupted', 'failed'] as const;
  const status = supported.includes(schedule.status as typeof supported[number])
    ? schedule.status as typeof supported[number]
    : 'failed';
  return {
    id: schedule.id,
    sessionId: schedule.sessionId,
    hostId: schedule.hostId,
    summary: 'Scheduled message',
    deliverAt: schedule.deliverAt ?? schedule.updatedAt ?? schedule.createdAt ?? new Date(0).toISOString(),
    hostTimeZone,
    status,
    createdAt: schedule.createdAt ?? schedule.updatedAt ?? new Date(0).toISOString(),
    ...(schedule.completedAt ? { completedAt: schedule.completedAt } : {}),
    ...(schedule.outcomeCode ? { detail: humanCode(schedule.outcomeCode) } : {})
  };
}

function toAttention(item: BridgeAttentionSnapshot): FleetAttention {
  const agent = item.agent === 'unknown' ? 'Coding agent' : item.agent === 'codex' ? 'Codex' : 'Claude';
  return {
    id: item.id,
    severity: 'failure',
    kind: 'hard-limit',
    title: `${agent} usage limit detected`,
    detail: `${item.hostId}${item.resetAt ? ` · resets ${new Date(item.resetAt).toLocaleString()}` : ''}`,
    hostId: item.hostId,
    createdAt: item.detectedAt ?? item.updatedAt ?? new Date(0).toISOString(),
    actionLabel: 'Open session',
    resolutionScope: 'fleet',
    targetSessionId: item.sessionId,
    ...(item.resetAt ? { suggestedAt: new Date(new Date(item.resetAt).getTime() + 60_000).toISOString() } : {})
  };
}

function toUsageLimit(item: BridgeLimitSnapshot): FleetUsageLimit {
  const windows = [item.primary, item.secondary].filter((value): value is BridgeLimitWindowSnapshot => value !== null);
  const fiveHour = windows.find((value) => value.windowMinutes === 300) ?? [...windows].sort((left, right) => left.windowMinutes - right.windowMinutes)[0];
  const weekly = windows.find((value) => value.windowMinutes === 10_080) ?? [...windows].sort((left, right) => right.windowMinutes - left.windowMinutes)[0];
  return {
    id: item.id,
    label: item.profileAlias,
    fiveHourRemaining: fiveHour?.remainingPercent ?? null,
    weeklyRemaining: weekly?.remainingPercent ?? null,
    resetsAt: fiveHour?.resetsAt ?? weekly?.resetsAt ?? null,
    status: 'ok'
  };
}

function exactObject(input: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${label} must be an object`);
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail(`${label} fields are invalid`);
  return value;
}

function rejectPrivateFields(input: unknown): void {
  if (Array.isArray(input)) {
    input.forEach(rejectPrivateFields);
    return;
  }
  if (!input || typeof input !== 'object') return;
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) fail(`private field is forbidden: ${key}`);
    rejectPrivateFields(value);
  }
}

function array(input: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(input) || input.length > maximum) fail(`${label} is invalid`);
  return input;
}

function uniqueStrings(
  input: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
  requireOne = false
): string[] {
  const values = array(input, label, maximumItems).map((item) => text(item, label, maximumLength, false));
  if (requireOne && values.length === 0) fail(`${label} must not be empty`);
  if (new Set(values).size !== values.length) fail(`${label} contains a duplicate`);
  return values;
}

function text(input: unknown, label: string, maximum: number, empty = true): string {
  if (typeof input !== 'string' || input.length > maximum || (!empty && !input) || /[\u0000-\u001f\u007f]/u.test(input)) {
    fail(`${label} is invalid`);
  }
  return input;
}

function instant(input: unknown, label: string, nullable = true): string | null {
  if (input === null && nullable) return null;
  const value = text(input, label, 40, false);
  if (!Number.isFinite(Date.parse(value))) fail(`${label} is not an instant`);
  return value;
}

function oneOf<const T extends readonly string[]>(input: unknown, label: string, values: T): T[number] {
  if (typeof input !== 'string' || !values.includes(input)) fail(`${label} is unsupported`);
  return input as T[number];
}

function literal<const T extends string | number>(input: unknown, label: string, value: T): T {
  if (input !== value) fail(`${label} is unsupported`);
  return value;
}

function boolean(input: unknown, label: string): boolean {
  if (typeof input !== 'boolean') fail(`${label} is invalid`);
  return input;
}

function integer(input: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(input) || (input as number) < minimum || (input as number) > maximum) fail(`${label} is invalid`);
  return input as number;
}

function finiteNumber(input: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < minimum || input > maximum) fail(`${label} is invalid`);
  return input;
}

function humanCode(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./u, (letter) => letter.toUpperCase());
}

function fail(message: string): never {
  throw new Error(`Invalid fleet protocol v1: ${message}`);
}
