import type {
  FleetAttention,
  FleetBackend,
  FleetHost,
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
  internalName: string;
  name: string;
  title: '';
  project: string;
  tool: FleetTool;
  backend: 'linux' | 'windows';
  activity: 'active' | 'idle';
  attached: boolean;
  updatedAt: string | null;
  pendingScheduleCount: number;
}

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

export interface BridgeFleetSnapshot {
  revision: string;
  generatedAt: string;
  hosts: BridgeHostSnapshot[];
  sessions: BridgeSessionSnapshot[];
  schedules: BridgeScheduleSnapshot[];
  attention: BridgeAttentionSnapshot[];
}

export type FleetBridgeStatus = 'starting' | 'live' | 'cached' | 'offline' | 'error';

export interface FleetBridgeView {
  status: FleetBridgeStatus;
  snapshot: FleetSnapshot;
  cacheSavedAt: string | null;
  errorCode: string;
}

export type FleetMutationMethod = 'session.kill' | 'schedule.cancel' | 'schedule.create';

export interface FleetMutationResult {
  operationId: string;
  status: string;
  snapshot: FleetSnapshot;
  scheduleId?: string;
}

const FORBIDDEN_KEYS = new Set(['message', 'prompt', 'output', 'transcript', 'panetitle', 'command']);

export function parseBridgeFleetSnapshot(input: unknown): BridgeFleetSnapshot {
  const root = exactObject(input, ['revision', 'generatedAt', 'hosts', 'sessions', 'schedules', 'attention'], 'snapshot');
  rejectPrivateFields(root);
  const revision = text(root.revision, 'revision', 64, false);
  const generatedAt = instant(root.generatedAt, 'generatedAt', false) as string;
  const hosts = array(root.hosts, 'hosts', 256).map(parseHost);
  const hostIds = new Set(hosts.map((host) => host.id));
  if (hostIds.size !== hosts.length) fail('hosts contain a duplicate id');
  const sessions = array(root.sessions, 'sessions', 500).map((value) => parseSession(value, hostIds));
  const schedules = array(root.schedules, 'schedules', 500).map((value) => parseSchedule(value, hostIds));
  const attention = array(root.attention, 'attention', 500).map((value) => parseAttention(value, hostIds));
  return { revision, generatedAt, hosts, sessions, schedules, attention };
}

export function toFleetSnapshot(raw: BridgeFleetSnapshot, distro: string): FleetSnapshot {
  const sessions = raw.sessions.map(toSession);
  const hostTimeZones = new Map(raw.hosts.map((host) => [host.id, host.timeZone]));
  return {
    revision: raw.revision,
    generatedAt: raw.generatedAt,
    registrySyncedAt: raw.generatedAt,
    controller: { distro, status: raw.hosts.some((host) => host.status === 'healthy') ? 'healthy' : 'offline', protocolVersion: 1 },
    hosts: raw.hosts.map((host) => toHost(host, sessions)),
    sessions,
    schedules: raw.schedules.map((schedule) => toSchedule(schedule, hostTimeZones.get(schedule.hostId) ?? '')),
    attention: raw.attention.filter((item) => !['dismissed', 'scheduled', 'resolved'].includes(item.state)).map(toAttention),
    favorites: [],
    events: [],
    pairingRequests: [],
    limits: []
  };
}

export function emptyFleetSnapshot(distro: string, generatedAt = new Date().toISOString()): FleetSnapshot {
  return {
    revision: 'empty',
    generatedAt,
    registrySyncedAt: generatedAt,
    controller: { distro, status: 'offline', protocolVersion: 1 },
    hosts: [],
    sessions: [],
    schedules: [],
    attention: [],
    favorites: [],
    events: [],
    pairingRequests: [],
    limits: []
  };
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

function parseSession(input: unknown, hostIds: ReadonlySet<string>): BridgeSessionSnapshot {
  const value = exactObject(input, [
    'id', 'hostId', 'internalName', 'name', 'title', 'project', 'tool', 'backend', 'activity',
    'attached', 'updatedAt', 'pendingScheduleCount'
  ], 'session');
  const hostId = text(value.hostId, 'session.hostId', 160, false);
  if (!hostIds.has(hostId)) fail('session references an unknown host');
  if (value.title !== '') fail('pane-derived session titles are forbidden');
  return {
    id: text(value.id, 'session.id', 320, false),
    hostId,
    internalName: text(value.internalName, 'session.internalName', 128, false),
    name: text(value.name, 'session.name', 256, false),
    title: '',
    project: text(value.project, 'session.project', 256),
    tool: oneOf(value.tool, 'session.tool', ['codex', 'claude', 'copilot', 'shell']),
    backend: oneOf(value.backend, 'session.backend', ['linux', 'windows']),
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

function toSession(session: BridgeSessionSnapshot): FleetSession {
  return {
    id: session.id,
    hostId: session.hostId,
    internalName: session.internalName,
    name: session.name,
    title: '',
    project: session.project,
    projectPath: '',
    tool: session.tool,
    backend: session.backend as FleetBackend,
    activity: session.activity,
    attached: session.attached,
    updatedAt: session.updatedAt,
    pendingScheduleCount: session.pendingScheduleCount,
    favorite: false
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

function humanCode(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./u, (letter) => letter.toUpperCase());
}

function fail(message: string): never {
  throw new Error(`Invalid fleet protocol v1: ${message}`);
}
