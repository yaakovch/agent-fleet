import { describe, expect, it } from 'vitest';
import { emptyFleetSnapshot } from '../src/shared/fleet-protocol';
import { resolveFleetNotificationTarget } from '../src/shared/notification';

function snapshot() {
  const fleet = emptyFleetSnapshot('Ubuntu', '2026-08-01T00:00:00.000Z');
  fleet.controller.status = 'healthy';
  fleet.hosts.push({
    id: 'gaming', name: 'Gaming', machine: 'Windows · WSL', platform: 'wsl', status: 'healthy',
    lastSeenAt: '2026-08-01T00:00:00.000Z', timeZone: 'UTC', wtmuxVersion: 'git-expected',
    protocolVersion: 1, sessionCount: 1, detail: 'Live'
  });
  fleet.physicalHosts.push({
    id: 'gaming-pc', name: 'Gaming PC', platform: 'wsl', status: 'healthy',
    lastSeenAt: '2026-08-01T00:00:00.000Z', errorCode: '', endpointIds: [],
    executionTargetIds: ['linux'], legacyHostIds: ['gaming']
  });
  fleet.sessions.push({
    id: 'gaming:work', hostId: 'gaming', physicalHostId: 'gaming', executionTargetId: 'linux',
    name: 'work', title: 'Work', project: 'agent-fleet', projectPath: '/work', tool: 'codex',
    backend: 'wsl', activity: 'active', attached: false,
    updatedAt: '2026-08-01T00:00:00.000Z', pendingScheduleCount: 0, favorite: false
  });
  fleet.pairingRequests.push({
    id: 'pair-1', deviceName: 'Device', platform: 'Windows', peer: 'device.example.ts.net',
    requestedAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-01T00:10:00.000Z',
    status: 'awaiting-review'
  });
  return fleet;
}

describe('notification click targets', () => {
  it('routes live session, pairing, and host targets exactly', () => {
    const fleet = snapshot();
    expect(resolveFleetNotificationTarget(fleet, { kind: 'session', id: 'gaming:work' })).toEqual({
      action: 'open-session', id: 'gaming:work'
    });
    expect(resolveFleetNotificationTarget(fleet, { kind: 'pairing', id: 'pair-1' })).toEqual({
      action: 'review-pairing', id: 'pair-1'
    });
    expect(resolveFleetNotificationTarget(fleet, { kind: 'host', id: 'gaming' })).toEqual({
      action: 'focus-host', id: 'gaming-pc'
    });
  });

  it('falls back to a safe dashboard view when the resource is stale or unavailable', () => {
    const fleet = snapshot();
    fleet.hosts[0].status = 'offline';
    fleet.pairingRequests[0].status = 'approved';
    expect(resolveFleetNotificationTarget(fleet, { kind: 'session', id: 'gaming:work' })).toMatchObject({
      action: 'dashboard-fallback', view: 'overview'
    });
    expect(resolveFleetNotificationTarget(fleet, { kind: 'pairing', id: 'pair-1' })).toMatchObject({
      action: 'dashboard-fallback', view: 'fleet'
    });
    expect(resolveFleetNotificationTarget(fleet, { kind: 'host', id: 'missing' })).toMatchObject({
      action: 'dashboard-fallback', view: 'fleet'
    });
  });
});
