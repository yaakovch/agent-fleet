import { describe, expect, it } from 'vitest';
import { FLEET_FIXTURE } from '../src/renderer/src/fleet-fixtures';

describe('dashboard fleet fixture', () => {
  it('uses stable unique identities and valid cross references', () => {
    const hostIds = new Set(FLEET_FIXTURE.hosts.map((host) => host.id));
    const sessionIds = new Set(FLEET_FIXTURE.sessions.map((session) => session.id));

    expect(hostIds.size).toBe(FLEET_FIXTURE.hosts.length);
    expect(sessionIds.size).toBe(FLEET_FIXTURE.sessions.length);
    expect(FLEET_FIXTURE.sessions.every((session) => hostIds.has(session.hostId))).toBe(true);
    expect(FLEET_FIXTURE.schedules.every((schedule) => hostIds.has(schedule.hostId))).toBe(true);
    expect(FLEET_FIXTURE.schedules.filter((schedule) => schedule.status === 'pending').every((schedule) => sessionIds.has(schedule.sessionId))).toBe(true);
  });

  it('covers every prototype severity and schedule outcome family', () => {
    expect(new Set(FLEET_FIXTURE.hosts.map((host) => host.status))).toEqual(
      new Set(['healthy', 'attention', 'offline'])
    );
    expect(new Set(FLEET_FIXTURE.attention.map((item) => item.severity))).toEqual(
      new Set(['failure', 'attention', 'offline'])
    );
    expect(new Set(FLEET_FIXTURE.schedules.map((schedule) => schedule.status))).toEqual(
      new Set(['pending', 'delivered', 'interrupted'])
    );
  });

  it('contains metadata only', () => {
    const serialized = JSON.stringify(FLEET_FIXTURE).toLowerCase();
    for (const forbidden of ['transcript', 'terminaloutput', 'authenticationtoken', 'accesstoken', 'secretkey']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
