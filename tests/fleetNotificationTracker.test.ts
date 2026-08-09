import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FleetNotificationTracker,
  FLEET_NOTIFICATION_PAUSE_MS,
  MAX_ATTENTION_NOTIFICATION_IDS,
  MAX_HOST_NOTIFICATION_STATES,
  MAX_NOTIFICATIONS_PER_UPDATE,
  MAX_PAIRING_NOTIFICATION_STATES,
  MAX_SCHEDULE_NOTIFICATION_STATES
} from '../src/main/fleet-notification-tracker';
import type { FleetAttention, FleetHost, FleetSchedule, FleetSnapshot } from '../src/shared/fleet';
import { emptyFleetSnapshot, type FleetBridgeView } from '../src/shared/fleet-protocol';
import { createDefaultFleetNotifications, type FleetNotificationSettings } from '../src/shared/settings';

interface AlertFixture {
  alerts: {
    categories: Array<{ id: keyof FleetNotificationSettings; sources: string[]; target: string }>;
    bounds: {
      hostStates: number;
      scheduleStates: number;
      attentionIds: number;
      pairingRequestStates: number;
      deliveriesPerUpdate: number;
      concreteDeliveriesBeforeSummary: number;
    };
    pause: { durationSeconds: number };
    transitions: { unchangedResource: string; resolvedResource: string; sameIdRecurrence: string };
  };
}

const fixture = JSON.parse(readFileSync('tests/fixtures/client-behavior-v1.json', 'utf8')) as AlertFixture;
const preferences = createDefaultFleetNotifications();

describe('fleet notification tracker', () => {
  it('maps every canonical alert source to its enabled notification category', () => {
    expect(fixture.alerts.categories).toEqual([
      { id: 'hardLimits', sources: ['attention.hard-limit'], target: 'session-or-dashboard' },
      { id: 'deliveryFailures', sources: ['schedule.failed', 'schedule.interrupted'], target: 'session-or-dashboard' },
      { id: 'deliverySuccess', sources: ['schedule.delivered'], target: 'session-or-dashboard' },
      { id: 'hostState', sources: ['host.offline', 'host.recovered'], target: 'host-or-dashboard' },
      { id: 'versionDrift', sources: ['host-runtime.mismatch-verified-expected'], target: 'host-or-dashboard' },
      { id: 'pairing', sources: ['pairing.awaiting-review'], target: 'pairing-review' }
    ]);
    const tracker = new FleetNotificationTracker();
    const initial = snapshot();
    run(tracker, initial, preferences, true, 'git-expected');

    const changed = structuredClone(initial);
    changed.hosts[0].status = 'offline';
    changed.hosts[0].wtmuxVersion = 'git-behind';
    changed.schedules[0].status = 'failed';
    changed.attention.push({ ...attention('hard-limit', 'hard-limit'), targetSessionId: 'session-hard-limit' });
    changed.pairingRequests.push(pairing('pair-category'));
    expect(run(tracker, changed, preferences, true, 'git-expected')).toEqual([
      {
        title: 'Usage limit detected', body: 'Host gaming. Open Agent Fleet to review the limit.',
        target: { kind: 'session', id: 'session-hard-limit' }
      },
      {
        title: 'gaming is offline',
        body: 'The host missed its heartbeat threshold. Open Fleet to review its current state.',
        target: { kind: 'host', id: 'gaming' }
      },
      {
        title: 'Scheduled continue failed', body: 'gaming · delivery failed',
        target: { kind: 'session', id: 'session-schedule' }
      },
      {
        title: 'gaming runtime version drift', body: 'Installed git-behind · expected git-expected',
        target: { kind: 'host', id: 'gaming' }
      },
      {
        title: 'Pairing request from device-pair-category',
        body: 'Windows · review the verified device proposal',
        target: { kind: 'pairing', id: 'pair-category' }
      }
    ]);

    const deliveryTracker = new FleetNotificationTracker();
    run(deliveryTracker, initial, preferences, true, 'git-expected');
    const delivered = structuredClone(initial);
    delivered.schedules[0].status = 'delivered';
    expect(run(deliveryTracker, delivered, preferences, true, 'git-expected')).toEqual([{
      title: 'Scheduled continue delivered', body: 'gaming · delivery confirmed',
      target: { kind: 'session', id: 'session-schedule' }
    }]);
  });

  it('consumes the initial baseline and paused transitions without replaying them', () => {
    const tracker = new FleetNotificationTracker();
    const initial = snapshot();
    expect(run(tracker, initial, preferences, true, 'git-expected')).toEqual([]);

    const paused = structuredClone(initial);
    paused.hosts[0].status = 'offline';
    paused.hosts[0].detail = 'Three missed heartbeats';
    paused.hosts[0].wtmuxVersion = 'git-behind';
    paused.schedules[0].status = 'delivered';
    paused.attention.push(attention('limit-paused', 'hard-limit'));
    paused.pairingRequests.push(pairing('pair-paused'));
    expect(run(tracker, paused, preferences, false, 'git-expected')).toEqual([]);

    expect(run(tracker, paused, preferences, true, 'git-expected')).toEqual([]);

    const resumed = structuredClone(paused);
    resumed.hosts[0].status = 'healthy';
    resumed.hosts[0].wtmuxVersion = 'git-expected';
    resumed.attention.push(attention('limit-new', 'hard-limit'));
    resumed.pairingRequests.push(pairing('pair-new'));
    const notifications = run(tracker, resumed, preferences, true, 'git-expected');
    expect(notifications.map((item) => item.title)).toEqual([
      'Usage limit detected',
      'gaming recovered',
      'Pairing request from device-pair-new'
    ]);
  });

  it('starts a fresh baseline after the authoritative fleet source is replaced', () => {
    const tracker = new FleetNotificationTracker();
    const initial = snapshot();
    run(tracker, initial, preferences, true, 'git-expected');

    tracker.reset();
    expect(tracker.state()).toEqual({
      hosts: 0,
      schedules: 0,
      versionDrifts: 0,
      attentionIds: 0,
      pairingRequestStates: 0
    });

    const replacementBaseline = structuredClone(initial);
    replacementBaseline.hosts[0].status = 'offline';
    replacementBaseline.schedules[0].status = 'failed';
    replacementBaseline.attention.push(attention('replacement-limit', 'hard-limit'));
    replacementBaseline.pairingRequests.push(pairing('replacement-pairing'));
    expect(run(tracker, replacementBaseline, preferences, true, 'git-expected')).toEqual([]);

    const next = structuredClone(replacementBaseline);
    next.hosts[0].status = 'healthy';
    next.schedules[0].status = 'delivered';
    next.attention.push(attention('replacement-limit-next', 'hard-limit'));
    next.pairingRequests.push(pairing('replacement-pairing-next'));
    expect(run(tracker, next, preferences, true, 'git-expected').map((item) => item.title)).toEqual([
      'Usage limit detected',
      'gaming recovered',
      'Scheduled continue delivered',
      'Pairing request from device-replacement-pairing-next'
    ]);
  });

  it('makes pairing and verified expected-version drift settings live without false upgrade alerts', () => {
    const tracker = new FleetNotificationTracker();
    const initial = snapshot();
    expect(run(tracker, initial, preferences, true, null)).toEqual([]);

    const expectedBecomesTrusted = structuredClone(initial);
    expectedBecomesTrusted.hosts[0].wtmuxVersion = 'git-old';
    const drift = run(tracker, expectedBecomesTrusted, preferences, true, 'git-expected');
    expect(drift).toEqual([{
      title: 'gaming runtime version drift',
      body: 'Installed git-old · expected git-expected',
      target: { kind: 'host', id: 'gaming' }
    }]);

    const upgradedTogether = structuredClone(expectedBecomesTrusted);
    upgradedTogether.hosts[0].wtmuxVersion = 'git-new';
    expect(run(tracker, upgradedTogether, preferences, true, 'git-new')).toEqual([]);

    const disabled = { ...preferences, versionDrift: false, pairing: false };
    const suppressedBySetting = structuredClone(upgradedTogether);
    suppressedBySetting.hosts[0].wtmuxVersion = 'git-behind-again';
    suppressedBySetting.pairingRequests.push(pairing('pair-disabled'));
    expect(run(tracker, suppressedBySetting, disabled, true, 'git-new')).toEqual([]);
    expect(run(tracker, suppressedBySetting, preferences, true, 'git-new')).toEqual([]);

    const next = structuredClone(suppressedBySetting);
    next.pairingRequests.push(pairing('pair-enabled'));
    expect(run(tracker, next, preferences, true, 'git-new')).toEqual([{
      title: 'Pairing request from device-pair-enabled',
      body: 'Windows · review the verified device proposal',
      target: { kind: 'pairing', id: 'pair-enabled' }
    }]);
  });

  it('prunes resolved resource state and recognizes a later genuine recurrence', () => {
    expect(fixture.alerts.transitions).toEqual({
      unchangedResource: 'consume-once', resolvedResource: 'prune', sameIdRecurrence: 'deliver-again'
    });
    const tracker = new FleetNotificationTracker();
    const initial = snapshot();
    run(tracker, initial, preferences, true, 'git-expected');

    const active = structuredClone(initial);
    active.attention.push(attention('recurring-limit', 'hard-limit'));
    active.pairingRequests.push(pairing('recurring-pairing'));
    expect(run(tracker, active, preferences, true, 'git-expected')).toHaveLength(2);

    expect(run(tracker, initial, preferences, true, 'git-expected')).toEqual([]);
    expect(tracker.state()).toMatchObject({ attentionIds: 0, pairingRequestStates: 0 });

    const recurrence = run(tracker, active, preferences, true, 'git-expected');
    expect(recurrence.map((item) => item.title)).toEqual([
      'Usage limit detected',
      'Pairing request from device-recurring-pairing'
    ]);
  });

  it('defensively deduplicates repeated resource identities within one snapshot', () => {
    const tracker = new FleetNotificationTracker();
    const initial = snapshot();
    run(tracker, initial, preferences, true, 'git-expected');

    const changed = structuredClone(initial);
    const failedSchedule = { ...changed.schedules[0], status: 'failed' as const };
    const limit = attention('duplicate-limit', 'hard-limit');
    const pairingRequest = pairing('duplicate-pairing');
    changed.schedules = [failedSchedule, { ...failedSchedule }];
    changed.attention = [limit, { ...limit }];
    changed.pairingRequests = [pairingRequest, { ...pairingRequest }];

    expect(run(tracker, changed, preferences, true, 'git-expected').map((item) => item.title)).toEqual([
      'Usage limit detected',
      'Scheduled continue failed',
      'Pairing request from device-duplicate-pairing'
    ]);
    expect(tracker.state()).toMatchObject({ schedules: 1, attentionIds: 1, pairingRequestStates: 1 });
  });

  it('uses the same first-seen duplicate policy for a replacement baseline', () => {
    const tracker = new FleetNotificationTracker();
    const baseline = snapshot();
    baseline.hosts = [baseline.hosts[0], { ...baseline.hosts[0], status: 'offline' }];
    baseline.schedules = [
      { ...baseline.schedules[0], status: 'failed' },
      { ...baseline.schedules[0], status: 'delivered' }
    ];
    const request = pairing('baseline-pairing');
    baseline.pairingRequests = [request, { ...request, status: 'rejected' }];
    expect(run(tracker, baseline, preferences, true, 'git-expected')).toEqual([]);

    const next = snapshot();
    next.schedules[0].status = 'failed';
    next.pairingRequests = [request];
    expect(run(tracker, next, preferences, true, 'git-expected')).toEqual([]);
  });

  it('keeps protocol-supplied content and paths out of desktop notification copy', () => {
    const tracker = new FleetNotificationTracker();
    const initial = snapshot();
    run(tracker, initial, preferences, true, 'git-expected');

    const secret = 'PRIVATE_CANARY_PROMPT /private/repository/path';
    const changed = structuredClone(initial);
    changed.hosts[0].status = 'offline';
    changed.hosts[0].detail = secret;
    changed.schedules[0].status = 'interrupted';
    changed.schedules[0].summary = secret;
    changed.schedules[0].detail = secret;
    changed.attention.push({
      ...attention('private-attention', 'hard-limit'),
      title: secret,
      detail: secret,
      targetSessionId: 'gaming:session'
    });
    changed.attention.push({
      ...attention('private-version', 'version'),
      title: secret,
      detail: secret
    });
    changed.pairingRequests.push({ ...pairing('private-pairing'), peer: secret });

    const rendered = JSON.stringify(run(tracker, changed, preferences, true, 'git-expected'));
    expect(rendered).not.toContain('PRIVATE_CANARY_PROMPT');
    expect(rendered).not.toContain('/private/repository/path');
    expect(rendered).not.toContain('device.example.ts.net');
    expect(rendered).toContain('Usage limit detected');
    expect(rendered).toContain('Runtime version drift detected');
    expect(rendered).toContain('delivery interrupted');
  });

  it('matches canonical category and state bounds and caps a notification burst', () => {
    expect(fixture.alerts.categories.map((item) => item.id)).toEqual([
      'hardLimits', 'deliveryFailures', 'deliverySuccess', 'hostState', 'versionDrift', 'pairing'
    ]);
    expect(FLEET_NOTIFICATION_PAUSE_MS / 1_000).toBe(fixture.alerts.pause.durationSeconds);
    expect({
      hostStates: MAX_HOST_NOTIFICATION_STATES,
      scheduleStates: MAX_SCHEDULE_NOTIFICATION_STATES,
      attentionIds: MAX_ATTENTION_NOTIFICATION_IDS,
      pairingRequestStates: MAX_PAIRING_NOTIFICATION_STATES,
      deliveriesPerUpdate: MAX_NOTIFICATIONS_PER_UPDATE,
      concreteDeliveriesBeforeSummary: MAX_NOTIFICATIONS_PER_UPDATE - 1
    }).toEqual(fixture.alerts.bounds);

    const tracker = new FleetNotificationTracker();
    run(tracker, oversizedSnapshot(), preferences, true, 'git-expected');
    expect(tracker.state()).toEqual({
      hosts: MAX_HOST_NOTIFICATION_STATES,
      schedules: MAX_SCHEDULE_NOTIFICATION_STATES,
      versionDrifts: MAX_HOST_NOTIFICATION_STATES,
      attentionIds: MAX_ATTENTION_NOTIFICATION_IDS,
      pairingRequestStates: MAX_PAIRING_NOTIFICATION_STATES
    });

    const burstTracker = new FleetNotificationTracker();
    run(burstTracker, snapshot(), preferences, true, 'git-expected');
    const burst = snapshot();
    burst.attention = Array.from({ length: 30 }, (_, index) => attention(`burst-${index}`, 'hard-limit'));
    const notifications = run(burstTracker, burst, preferences, true, 'git-expected');
    expect(notifications).toHaveLength(MAX_NOTIFICATIONS_PER_UPDATE);
    expect(notifications.at(-1)?.title).toBe('15 more fleet changes');
  });
});

function run(
  tracker: FleetNotificationTracker,
  value: FleetSnapshot,
  selectedPreferences: FleetNotificationSettings,
  emit: boolean,
  expectedHostRuntimeVersion: string | null
) {
  return tracker.process(live(value), selectedPreferences, { emit, expectedHostRuntimeVersion });
}

function live(value: FleetSnapshot): FleetBridgeView {
  return { status: 'live', snapshot: value, cacheSavedAt: null, errorCode: '' };
}

function snapshot(): FleetSnapshot {
  const value = emptyFleetSnapshot('Ubuntu', '2026-08-01T00:00:00.000Z');
  value.controller.status = 'healthy';
  value.hosts = [host('gaming')];
  value.schedules = [schedule('schedule')];
  return value;
}

function host(id: string): FleetHost {
  return {
    id,
    name: id,
    machine: 'Windows · WSL',
    platform: 'wsl',
    status: 'healthy',
    lastSeenAt: '2026-08-01T00:00:00.000Z',
    timeZone: 'UTC',
    wtmuxVersion: 'git-expected',
    protocolVersion: 1,
    sessionCount: 0,
    detail: 'Live'
  };
}

function schedule(id: string): FleetSchedule {
  return {
    id,
    sessionId: `session-${id}`,
    hostId: 'gaming',
    summary: 'continue',
    deliverAt: '2026-08-01T01:00:00.000Z',
    hostTimeZone: 'UTC',
    status: 'pending',
    createdAt: '2026-08-01T00:00:00.000Z'
  };
}

function attention(id: string, kind: FleetAttention['kind']): FleetAttention {
  return {
    id,
    severity: 'attention',
    kind,
    title: `${kind} ${id}`,
    detail: 'Review the fleet event',
    hostId: 'gaming',
    createdAt: '2026-08-01T00:00:00.000Z',
    actionLabel: 'Review',
    resolutionScope: 'fleet'
  };
}

function pairing(id: string): FleetSnapshot['pairingRequests'][number] {
  return {
    id,
    deviceName: `device-${id}`,
    platform: 'Windows',
    peer: 'device.example.ts.net',
    requestedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:10:00.000Z',
    status: 'awaiting-review'
  };
}

function oversizedSnapshot(): FleetSnapshot {
  const value = snapshot();
  value.hosts = Array.from({ length: MAX_HOST_NOTIFICATION_STATES + 20 }, (_, index) => ({
    ...host(`host-${index}`),
    wtmuxVersion: 'git-behind'
  }));
  value.schedules = Array.from({ length: MAX_SCHEDULE_NOTIFICATION_STATES + 20 }, (_, index) => schedule(`schedule-${index}`));
  value.attention = Array.from({ length: MAX_ATTENTION_NOTIFICATION_IDS + 20 }, (_, index) => attention(`attention-${index}`, 'hard-limit'));
  value.pairingRequests = Array.from({ length: MAX_PAIRING_NOTIFICATION_STATES + 20 }, (_, index) => pairing(`pair-${index}`));
  return value;
}
