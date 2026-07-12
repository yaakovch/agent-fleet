import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBridgeFleetSnapshot, toFleetSnapshot } from '../src/shared/fleet-protocol';

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'fleet-snapshot-v1.json');

describe('fleet protocol v1', () => {
  it('maps the metadata-only fixture into dashboard data', () => {
    const raw = parseBridgeFleetSnapshot(JSON.parse(readFileSync(fixturePath, 'utf8')));
    const dashboard = toFleetSnapshot(raw, 'Ubuntu');
    expect(dashboard.revision).toBe('fixture-revision');
    expect(dashboard.hosts[0]?.status).toBe('healthy');
    expect(dashboard.sessions[0]?.title).toBe('');
    expect(dashboard.schedules[0]?.summary).toBe('Scheduled message');
    expect(JSON.stringify(dashboard).toLowerCase()).not.toContain('continue');
  });

  it('rejects pane-derived titles and prompt fields', () => {
    const titlePayload = JSON.parse(readFileSync(fixturePath, 'utf8'));
    titlePayload.sessions[0].title = 'private pane title';
    expect(() => parseBridgeFleetSnapshot(titlePayload)).toThrow(/title/i);

    const promptPayload = JSON.parse(readFileSync(fixturePath, 'utf8'));
    promptPayload.schedules[0].prompt = 'continue';
    expect(() => parseBridgeFleetSnapshot(promptPayload)).toThrow(/private field|fields are invalid/i);
  });

  it('rejects unknown fields and cross-host references', () => {
    const unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
    unknown.hosts[0].cpu = 12;
    expect(() => parseBridgeFleetSnapshot(unknown)).toThrow(/fields are invalid/i);

    const crossHost = JSON.parse(readFileSync(fixturePath, 'utf8'));
    crossHost.sessions[0].hostId = 'other-host';
    expect(() => parseBridgeFleetSnapshot(crossHost)).toThrow(/unknown host/i);
  });

  it('accepts only cache-safe pairing request summaries', () => {
    const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
    payload.pairingRequests = [{
      id: 'pair-1', deviceName: 'phone', platform: 'termux', peer: 'phone.tailnet.ts.net',
      requestedAt: '2026-07-12T04:00:00Z', expiresAt: '2026-07-12T04:10:00Z', status: 'awaiting-review'
    }];
    expect(toFleetSnapshot(parseBridgeFleetSnapshot(payload), 'Ubuntu').pairingRequests).toHaveLength(1);
    payload.pairingRequests[0].token = 'secret';
    expect(() => parseBridgeFleetSnapshot(payload)).toThrow(/fields are invalid|private field/i);
  });

  it('accepts strict fleet presets and marks matching sessions as favorites', () => {
    const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
    payload.presets = [{
      id: 'favorite-1', name: 'Demo Codex', hostId: payload.hosts[0].id,
      project: payload.sessions[0].project, backend: payload.sessions[0].backend,
      tool: payload.sessions[0].tool, profileAlias: ''
    }];
    const snapshot = toFleetSnapshot(parseBridgeFleetSnapshot(payload), 'Ubuntu');
    expect(snapshot.favorites).toHaveLength(1);
    expect(snapshot.sessions[0].favorite).toBe(true);
    payload.presets[0].prompt = 'secret';
    expect(() => parseBridgeFleetSnapshot(payload)).toThrow(/fields are invalid|private field/i);
  });
});
