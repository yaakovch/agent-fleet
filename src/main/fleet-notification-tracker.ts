import type { FleetAttention, FleetSnapshot } from '../shared/fleet';
import type { FleetBridgeView } from '../shared/fleet-protocol';
import type { FleetNotificationTarget } from '../shared/notification';
import type { FleetNotificationSettings } from '../shared/settings';

export const MAX_HOST_NOTIFICATION_STATES = 256;
export const MAX_SCHEDULE_NOTIFICATION_STATES = 500;
export const MAX_ATTENTION_NOTIFICATION_IDS = 500;
export const MAX_PAIRING_NOTIFICATION_STATES = 256;
export const MAX_NOTIFICATIONS_PER_UPDATE = 16;
export const FLEET_NOTIFICATION_PAUSE_MS = 60 * 60 * 1_000;

export interface FleetNotificationCandidate {
  title: string;
  body: string;
  target?: FleetNotificationTarget;
}

export interface FleetNotificationTrackerState {
  hosts: number;
  schedules: number;
  versionDrifts: number;
  attentionIds: number;
  pairingRequestStates: number;
}

interface ProcessOptions {
  emit: boolean;
  expectedHostRuntimeVersion: string | null;
}

/**
 * Converts successive authoritative fleet snapshots into one-shot desktop
 * notifications. Every live snapshot advances the tracker even while delivery
 * is paused, unsupported, or disabled by category, so resuming cannot replay
 * changes that happened while suppressed.
 */
export class FleetNotificationTracker {
  private baselineReady = false;
  private hostStates = new Map<string, string>();
  private scheduleStates = new Map<string, string>();
  private versionDrifts = new Map<string, string>();
  private attentionIds = new Set<string>();
  private pairingStates = new Map<string, FleetSnapshot['pairingRequests'][number]['status']>();

  /** Starts a fresh baseline after the authoritative fleet source is replaced. */
  reset(): void {
    this.baselineReady = false;
    this.hostStates = new Map();
    this.scheduleStates = new Map();
    this.versionDrifts = new Map();
    this.attentionIds = new Set();
    this.pairingStates = new Map();
  }

  process(
    view: FleetBridgeView,
    preferences: FleetNotificationSettings,
    options: ProcessOptions
  ): FleetNotificationCandidate[] {
    if (view.status !== 'live') return [];

    const snapshot = view.snapshot;
    if (!this.baselineReady) {
      this.observeBaseline(snapshot, options.expectedHostRuntimeVersion);
      this.baselineReady = true;
      return [];
    }

    const candidates: FleetNotificationCandidate[] = [];
    const explicitVersionHosts = new Set<string>();

    const nextAttentionIds = new Set<string>();
    for (const attention of snapshot.attention.slice(0, MAX_ATTENTION_NOTIFICATION_IDS)) {
      if (nextAttentionIds.has(attention.id)) continue;
      nextAttentionIds.add(attention.id);
      if (this.attentionIds.has(attention.id)) continue;
      if (attention.kind === 'version' && attention.hostId) explicitVersionHosts.add(attention.hostId);
      if (options.emit && attentionEnabled(attention, preferences)) {
        const copy = attentionNotification(attention);
        candidates.push({
          ...copy,
          ...(attention.kind === 'hard-limit' && attention.targetSessionId
            ? { target: { kind: 'session' as const, id: attention.targetSessionId } }
            : attention.hostId ? { target: { kind: 'host' as const, id: attention.hostId } } : {})
        });
      }
    }
    this.attentionIds = nextAttentionIds;

    const nextHostStates = new Map<string, string>();
    for (const host of snapshot.hosts.slice(0, MAX_HOST_NOTIFICATION_STATES)) {
      if (nextHostStates.has(host.id)) continue;
      nextHostStates.set(host.id, host.status);
      const previous = this.hostStates.get(host.id);
      if (!options.emit || !preferences.hostState || !previous || previous === host.status) continue;
      if (host.status === 'offline') {
        candidates.push({
          title: `${host.name} is offline`,
          body: 'The host missed its heartbeat threshold. Open Fleet to review its current state.',
          target: { kind: 'host', id: host.id }
        });
      } else if (previous === 'offline' && host.status === 'healthy') {
        candidates.push({
          title: `${host.name} recovered`,
          body: 'The host is connected and live actions are available again.',
          target: { kind: 'host', id: host.id }
        });
      }
    }
    this.hostStates = nextHostStates;

    const nextScheduleStates = new Map<string, string>();
    for (const schedule of snapshot.schedules.slice(0, MAX_SCHEDULE_NOTIFICATION_STATES)) {
      if (nextScheduleStates.has(schedule.id)) continue;
      nextScheduleStates.set(schedule.id, schedule.status);
      const previous = this.scheduleStates.get(schedule.id);
      if (!options.emit || !previous || previous === schedule.status || schedule.status === 'pending') continue;
      if (schedule.status === 'delivered' && preferences.deliverySuccess) {
        candidates.push({
          title: 'Scheduled continue delivered',
          body: `${schedule.hostId} · delivery confirmed`,
          target: { kind: 'session', id: schedule.sessionId }
        });
      } else if (preferences.deliveryFailures && ['failed', 'interrupted'].includes(schedule.status)) {
        candidates.push({
          title: `Scheduled continue ${schedule.status}`,
          body: `${schedule.hostId} · delivery ${schedule.status}`,
          target: { kind: 'session', id: schedule.sessionId }
        });
      }
    }
    this.scheduleStates = nextScheduleStates;

    const expectedVersion = options.expectedHostRuntimeVersion;
    const driftedHosts = this.observeVersionDrift(snapshot, expectedVersion);
    const newlyDrifted = driftedHosts.filter((host) => !explicitVersionHosts.has(host.id));
    if (options.emit && preferences.versionDrift && expectedVersion && newlyDrifted.length > 0) {
      candidates.push(versionDriftNotification(newlyDrifted, expectedVersion));
    }

    const nextPairingStates = new Map<string, FleetSnapshot['pairingRequests'][number]['status']>();
    const newPairingRequests: FleetSnapshot['pairingRequests'] = [];
    for (const request of snapshot.pairingRequests.slice(0, MAX_PAIRING_NOTIFICATION_STATES)) {
      if (nextPairingStates.has(request.id)) continue;
      nextPairingStates.set(request.id, request.status);
      if (request.status === 'awaiting-review' && this.pairingStates.get(request.id) !== 'awaiting-review') {
        newPairingRequests.push(request);
      }
    }
    this.pairingStates = nextPairingStates;
    if (options.emit && preferences.pairing && newPairingRequests.length > 0) {
      candidates.push(pairingNotification(newPairingRequests));
    }

    if (!options.emit) return [];
    return boundNotifications(candidates);
  }

  state(): FleetNotificationTrackerState {
    return {
      hosts: this.hostStates.size,
      schedules: this.scheduleStates.size,
      versionDrifts: this.versionDrifts.size,
      attentionIds: this.attentionIds.size,
      pairingRequestStates: this.pairingStates.size
    };
  }

  private observeBaseline(snapshot: FleetSnapshot, expectedVersion: string | null): void {
    this.hostStates = new Map();
    for (const host of snapshot.hosts.slice(0, MAX_HOST_NOTIFICATION_STATES)) {
      if (!this.hostStates.has(host.id)) this.hostStates.set(host.id, host.status);
    }
    this.scheduleStates = new Map();
    for (const schedule of snapshot.schedules.slice(0, MAX_SCHEDULE_NOTIFICATION_STATES)) {
      if (!this.scheduleStates.has(schedule.id)) this.scheduleStates.set(schedule.id, schedule.status);
    }
    this.attentionIds = new Set();
    for (const attention of snapshot.attention.slice(0, MAX_ATTENTION_NOTIFICATION_IDS)) {
      this.attentionIds.add(attention.id);
    }
    this.pairingStates = new Map();
    for (const request of snapshot.pairingRequests.slice(0, MAX_PAIRING_NOTIFICATION_STATES)) {
      if (!this.pairingStates.has(request.id)) this.pairingStates.set(request.id, request.status);
    }
    this.observeVersionDrift(snapshot, expectedVersion);
  }

  private observeVersionDrift(
    snapshot: FleetSnapshot,
    expectedVersion: string | null
  ): FleetSnapshot['hosts'] {
    const next = new Map<string, string>();
    const seenHostIds = new Set<string>();
    const newlyDrifted: FleetSnapshot['hosts'] = [];
    if (expectedVersion) {
      for (const host of snapshot.hosts.slice(0, MAX_HOST_NOTIFICATION_STATES)) {
        if (seenHostIds.has(host.id)) continue;
        seenHostIds.add(host.id);
        if (!host.wtmuxVersion || host.wtmuxVersion === 'unknown' || host.wtmuxVersion === expectedVersion) continue;
        const fingerprint = `${expectedVersion}\u0000${host.wtmuxVersion}`;
        next.set(host.id, fingerprint);
        if (this.versionDrifts.get(host.id) !== fingerprint) newlyDrifted.push(host);
      }
    }
    this.versionDrifts = next;
    return newlyDrifted;
  }
}

function attentionEnabled(attention: FleetAttention, preferences: FleetNotificationSettings): boolean {
  if (attention.kind === 'hard-limit') return preferences.hardLimits;
  if (attention.kind === 'version') return preferences.versionDrift;
  return false;
}

function attentionNotification(attention: FleetAttention): FleetNotificationCandidate {
  const host = attention.hostId ? `Host ${attention.hostId}. ` : '';
  if (attention.kind === 'hard-limit') {
    return { title: 'Usage limit detected', body: `${host}Open Agent Fleet to review the limit.` };
  }
  return { title: 'Runtime version drift detected', body: `${host}Open Fleet to review the verified versions.` };
}

function versionDriftNotification(
  hosts: FleetSnapshot['hosts'],
  expectedVersion: string
): FleetNotificationCandidate {
  if (hosts.length === 1) {
    const host = hosts[0];
    return {
      title: `${host.name} runtime version drift`,
      body: `Installed ${host.wtmuxVersion} · expected ${expectedVersion}`,
      target: { kind: 'host', id: host.id }
    };
  }
  const names = hosts.slice(0, 3).map((host) => host.name).join(', ');
  const remainder = hosts.length > 3 ? ` and ${hosts.length - 3} more` : '';
  return {
    title: `${hosts.length} hosts have runtime version drift`,
    body: `${names}${remainder} · expected ${expectedVersion}`
  };
}

function pairingNotification(requests: FleetSnapshot['pairingRequests']): FleetNotificationCandidate {
  if (requests.length === 1) {
    return {
      title: `Pairing request from ${requests[0].deviceName}`,
      body: `${requests[0].platform} · review the verified device proposal`,
      target: { kind: 'pairing', id: requests[0].id }
    };
  }
  return {
    title: `${requests.length} pairing requests need review`,
    body: 'Open Fleet to review the verified device proposals.'
  };
}

function boundNotifications(candidates: FleetNotificationCandidate[]): FleetNotificationCandidate[] {
  if (candidates.length <= MAX_NOTIFICATIONS_PER_UPDATE) return candidates;
  const visible = candidates.slice(0, MAX_NOTIFICATIONS_PER_UPDATE - 1);
  visible.push({
    title: `${candidates.length - visible.length} more fleet changes`,
    body: 'Open Agent Fleet to review the remaining changes.'
  });
  return visible;
}
