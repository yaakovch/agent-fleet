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

export interface FleetSession {
  id: string;
  hostId: string;
  internalName?: string;
  name: string;
  title: string;
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
  generatedAt: string;
  registrySyncedAt: string;
  controller: { distro: string; status: FleetSeverity; protocolVersion: number };
  hosts: FleetHost[];
  sessions: FleetSession[];
  schedules: FleetSchedule[];
  attention: FleetAttention[];
  favorites: FleetFavorite[];
  events: FleetEvent[];
  pairingRequests: PairingRequest[];
  limits: FleetUsageLimit[];
}
