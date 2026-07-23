export type FleetSeverity = 'healthy' | 'attention' | 'failure' | 'offline';
export type FleetTool = 'codex' | 'claude' | 'copilot' | 'shell';
export type FleetBackend = 'wsl' | 'linux' | 'windows';

export interface FleetHost {
  id: string;
  name: string;
  machine: string;
  platform: 'wsl' | 'linux' | 'termux';
  status: FleetSeverity;
  lastSeenAt: string | null;
  timeZone: string;
  wtmuxVersion: string;
  protocolVersion: number;
  sessionCount: number;
  cpuPercent?: number;
  memoryPercent?: number;
  detail: string;
}

export interface FleetPhysicalHost {
  id: string;
  name: string;
  platform: 'wsl' | 'linux' | 'termux';
  status: FleetSeverity;
  lastSeenAt: string | null;
  errorCode: string;
  endpointIds: string[];
  executionTargetIds: Array<'linux' | 'windows'>;
  legacyHostIds: string[];
}

export interface FleetEndpoint {
  id: string;
  physicalHostId: string;
  network: 'local' | 'tailnet' | 'direct';
  address: string;
  port: number;
  sshEngine: 'openssh' | 'tailscale-cli';
  authentication: 'tailnet-ssh' | 'key';
  status: 'healthy' | 'connecting' | 'offline';
  identityState: 'verified' | 'unverified' | 'reverify-required';
  sshHostKeySha256: string;
  tailscaleNodeId: string;
  errorCode: string;
}

export interface FleetExecutionTarget {
  id: 'linux' | 'windows';
  physicalHostId: string;
  kind: 'linux' | 'windows-git-bash';
  label: string;
  status: 'available' | 'unavailable' | 'unknown';
  fingerprint: string;
}

export interface FleetSession {
  id: string;
  hostId: string;
  physicalHostId: string;
  executionTargetId: 'linux' | 'windows';
  internalName?: string;
  name: string;
  title: string;
  nameMode?: 'automatic' | 'manual';
  project: string;
  projectPath: string;
  tool: FleetTool;
  backend: FleetBackend;
  profileAlias?: string;
  activity: 'active' | 'idle' | 'waiting' | 'exited';
  attached: boolean;
  updatedAt: string | null;
  pendingScheduleCount: number;
  favorite: boolean;
}

export interface FleetSchedule {
  id: string;
  sessionId: string;
  hostId: string;
  summary: string;
  deliverAt: string;
  hostTimeZone: string;
  status: 'pending' | 'delivered' | 'cancelled' | 'interrupted' | 'failed';
  createdAt: string;
  completedAt?: string;
  detail?: string;
}

export interface FleetAttention {
  id: string;
  severity: Exclude<FleetSeverity, 'healthy'>;
  kind: 'hard-limit' | 'delivery' | 'host' | 'version' | 'pairing';
  title: string;
  detail: string;
  hostId?: string;
  createdAt: string;
  actionLabel: string;
  resolutionScope: 'fleet' | 'local';
  targetSessionId?: string;
  suggestedAt?: string;
}

export interface FleetFavorite {
  id: string;
  name: string;
  hostId: string;
  project: string;
  backend: FleetBackend;
  tool: FleetTool;
  profileAlias?: string;
}

export interface FleetEvent {
  id: string;
  kind: 'session' | 'schedule' | 'host' | 'limit' | 'pairing';
  title: string;
  detail: string;
  occurredAt: string;
  severity: FleetSeverity;
}

export interface PairingRequest {
  id: string;
  deviceName: string;
  platform: string;
  peer: string;
  requestedAt: string;
  expiresAt: string;
  status: 'awaiting-review' | 'approved' | 'rejected';
}

export interface FleetUsageLimit {
  id: string;
  label: string;
  fiveHourRemaining: number | null;
  weeklyRemaining: number | null;
  resetsAt: string | null;
  status: 'ok' | 'stale' | 'error';
}

export interface FleetSnapshot {
  revision: string;
  presentationRevision?: string;
  generatedAt: string;
  registrySyncedAt: string;
  controller: { distro: string; status: FleetSeverity; protocolVersion: number };
  hosts: FleetHost[];
  physicalHosts: FleetPhysicalHost[];
  endpoints: FleetEndpoint[];
  executionTargets: FleetExecutionTarget[];
  sessions: FleetSession[];
  schedules: FleetSchedule[];
  attention: FleetAttention[];
  favorites: FleetFavorite[];
  events: FleetEvent[];
  pairingRequests: PairingRequest[];
  limits: FleetUsageLimit[];
}

export interface SessionIdentityPresentation {
  primary: string;
  secondary: string;
  stableName: string;
}

export const MAX_INHERITED_SESSION_TITLE_CHARS = 48;

export function inheritedSessionTitle(value: string): string {
  const title = value.trim();
  const characters = [...title];
  if (characters.length <= MAX_INHERITED_SESSION_TITLE_CHARS) return title;
  const available = MAX_INHERITED_SESSION_TITLE_CHARS - 1;
  const prefix = characters.slice(0, available).join('').trimEnd();
  const boundary = prefix.lastIndexOf(' ');
  return `${(boundary >= Math.floor(available * 2 / 3) ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}

export function sessionIdentityPresentation(session: FleetSession): SessionIdentityPresentation {
  const automatic = session.nameMode !== 'manual';
  const primary = automatic && session.title ? inheritedSessionTitle(session.title) : session.name;
  const secondary = automatic && session.title
    ? [session.name, session.hostId, session.project].filter(Boolean).join(' · ')
    : [session.hostId, session.project].filter(Boolean).join(' · ');
  return { primary, secondary, stableName: session.name };
}

export function isFleetSessionAvailable(snapshot: FleetSnapshot, session: FleetSession): boolean {
  if (snapshot.controller.status !== 'healthy') return false;
  return snapshot.hosts.some((host) => host.id === session.hostId && host.status === 'healthy');
}

export function physicalHostForSession(snapshot: FleetSnapshot, session: FleetSession): FleetPhysicalHost | undefined {
  return snapshot.physicalHosts.find((host) => host.id === session.physicalHostId);
}

export function transportHostId(
  snapshot: FleetSnapshot,
  physicalHostId: string,
  executionTargetId: 'linux' | 'windows'
): string | undefined {
  const physicalHost = snapshot.physicalHosts.find((host) => host.id === physicalHostId);
  if (!physicalHost || !physicalHost.executionTargetIds.includes(executionTargetId)) return undefined;
  const liveLegacyIds = new Set(snapshot.hosts.map((host) => host.id));
  const candidates = physicalHost.legacyHostIds.filter((id) => liveLegacyIds.has(id));
  const preferred = candidates.find((id) => executionTargetId === 'windows' ? id.endsWith('_windows') : !id.endsWith('_windows'));
  return preferred ?? candidates[0];
}

export function reconcileHiddenUnavailableSessions(snapshot: FleetSnapshot, hiddenSessionIds: string[]): string[] {
  const hidden = new Set(hiddenSessionIds.slice(0, 64));
  return snapshot.sessions
    .filter((session) => hidden.has(session.id) && !isFleetSessionAvailable(snapshot, session))
    .map((session) => session.id)
    .slice(0, 64);
}
