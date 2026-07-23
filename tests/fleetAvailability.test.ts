import { describe, expect, it } from 'vitest';
import {
  isFleetSessionAvailable,
  reconcileHiddenUnavailableSessions,
  transportHostId,
  type FleetSnapshot
} from '../src/shared/fleet';

function snapshot(): FleetSnapshot {
  return {
    revision: 'one', generatedAt: '', registrySyncedAt: '',
    controller: { distro: 'Ubuntu', status: 'healthy', protocolVersion: 1 },
    hosts: [{
      id: 'gaming', name: 'Gaming', machine: 'gaming', platform: 'wsl', status: 'healthy',
      lastSeenAt: '', timeZone: 'UTC', wtmuxVersion: 'test', protocolVersion: 1,
      sessionCount: 1, detail: ''
    }],
    physicalHosts: [{
      id: 'gaming', name: 'Gaming', platform: 'wsl', status: 'healthy', lastSeenAt: '',
      errorCode: '', endpointIds: [], executionTargetIds: ['linux', 'windows'], legacyHostIds: ['gaming']
    }],
    endpoints: [],
    executionTargets: [
      { id: 'linux', physicalHostId: 'gaming', kind: 'linux', label: 'WSL', status: 'available', fingerprint: '' }
    ],
    sessions: [{
      id: 'gaming:one', hostId: 'gaming', physicalHostId: 'gaming', executionTargetId: 'linux',
      internalName: 'one', name: 'One', title: 'codex',
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

  it('maps a physical host target to the correct legacy transport alias', () => {
    const fleet = snapshot();
    fleet.hosts.push({ ...fleet.hosts[0], id: 'gaming_windows', platform: 'wsl' });
    fleet.physicalHosts[0].legacyHostIds.push('gaming_windows');
    fleet.executionTargets.push({
      id: 'windows', physicalHostId: 'gaming', kind: 'windows-git-bash',
      label: 'Windows', status: 'available', fingerprint: ''
    });
    expect(transportHostId(fleet, 'gaming', 'linux')).toBe('gaming');
    expect(transportHostId(fleet, 'gaming', 'windows')).toBe('gaming_windows');
  });
});
