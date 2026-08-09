import { isFleetSessionAvailable, type FleetSnapshot } from './fleet';

export interface FleetNotificationTarget {
  kind: 'session' | 'host' | 'pairing';
  id: string;
}

export type FleetNotificationRoute =
  | { action: 'open-session'; id: string }
  | { action: 'review-pairing'; id: string }
  | { action: 'focus-host'; id: string }
  | { action: 'dashboard-fallback'; view: 'overview' | 'fleet'; message: string };

export function resolveFleetNotificationTarget(
  snapshot: FleetSnapshot,
  target: FleetNotificationTarget
): FleetNotificationRoute {
  if (target.kind === 'session') {
    const session = snapshot.sessions.find((item) => item.id === target.id);
    return session && isFleetSessionAvailable(snapshot, session)
      ? { action: 'open-session', id: session.id }
      : {
          action: 'dashboard-fallback',
          view: 'overview',
          message: 'The notification target is no longer available; showing current fleet state.'
        };
  }
  if (target.kind === 'pairing') {
    const request = snapshot.pairingRequests.find((item) =>
      item.id === target.id && item.status === 'awaiting-review');
    return request
      ? { action: 'review-pairing', id: request.id }
      : {
          action: 'dashboard-fallback',
          view: 'fleet',
          message: 'The pairing request is no longer awaiting review.'
        };
  }
  const hostExists = snapshot.hosts.some((item) => item.id === target.id);
  const physicalHost = snapshot.physicalHosts.find((item) => item.legacyHostIds.includes(target.id));
  return hostExists
    ? { action: 'focus-host', id: physicalHost?.id ?? target.id }
    : {
        action: 'dashboard-fallback',
        view: 'fleet',
        message: 'The host is no longer in the current fleet snapshot.'
      };
}
