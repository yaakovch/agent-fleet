import { describe, expect, it } from 'vitest';
import { isFleetSessionAvailable, reconcileHiddenUnavailableSessions, type FleetSnapshot } from '../src/shared/fleet';

function snapshot(): FleetSnapshot {
  return {
    revision: 'one', generatedAt: '', registrySyncedAt: '',
    controller: { distro: 'Ubuntu', status: 'healthy', protocolVersion: 1 },
    hosts: [{
      id: 'gaming', name: 'Gaming', machine: 'gaming', platform: 'wsl', status: 'healthy',
      lastSeenAt: '', timeZone: 'UTC', wtmuxVersion: 'test', protocolVersion: 1,
      sessionCount: 1, detail: ''
    }],
    sessions: [{
      id: 'gaming:one', hostId: 'gaming', internalName: 'one', name: 'One', title: 'codex',
      project: 'project', projectPath: '/project', tool: 'codex', backend: 'wsl',
      activity: 'active', attached: false, updatedAt: '', pendingScheduleCount: 0, favorite: false
    }],
    schedules: [], attention: [], favorites: [], events: [], pairingRequests: [], limits: []
  };
}

describe('fleet session availability', () => {
  it('requires both the controller and owning host to be healthy', () => {
    const fleet = snapshot();
    expect(isFleetSessionAvailable(fleet, fleet.sessions[0])).toBe(true);
    fleet.hosts[0].status = 'offline';
    expect(isFleetSessionAvailable(fleet, fleet.sessions[0])).toBe(false);
    fleet.hosts[0].status = 'healthy';
    fleet.controller.status = 'offline';
    expect(isFleetSessionAvailable(fleet, fleet.sessions[0])).toBe(false);
  });

  it('retains local hides only while the cached session is unavailable', () => {
    const fleet = snapshot();
    fleet.hosts[0].status = 'offline';
    expect(reconcileHiddenUnavailableSessions(fleet, ['gaming:one', 'missing'])).toEqual(['gaming:one']);
    fleet.hosts[0].status = 'healthy';
    expect(reconcileHiddenUnavailableSessions(fleet, ['gaming:one'])).toEqual([]);
  });
});
