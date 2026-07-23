import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseBridgeFleetSnapshot, parseFleetDirectoryListing, parseFleetModelControlState, parseFleetRepositoryPage,
  toFleetSnapshot
} from '../src/shared/fleet-protocol';

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'fleet-snapshot-v1.json');
const identityFixturePath = join(process.cwd(), 'tests', 'fixtures', 'contracts', 'fleet-snapshot-identity-v1.json');

describe('fleet protocol v1', () => {
  it('maps the metadata-only fixture into dashboard data', () => {
    const raw = parseBridgeFleetSnapshot(JSON.parse(readFileSync(fixturePath, 'utf8')));
    const dashboard = toFleetSnapshot(raw, 'Ubuntu');
    expect(dashboard.revision).toBe('fixture-revision');
    expect(dashboard.hosts[0]?.status).toBe('healthy');
    expect(dashboard.sessions[0]?.title).toBe('');
    expect(dashboard.schedules[0]?.summary).toBe('Scheduled message');
    expect(dashboard.physicalHosts[0]).toMatchObject({ id: 'test-host', legacyHostIds: ['test-host'] });
    expect(dashboard.sessions[0]).toMatchObject({ physicalHostId: 'test-host', executionTargetId: 'linux' });
    expect(JSON.stringify(dashboard).toLowerCase()).not.toContain('continue');
  });

  it('accepts the negotiated canonical identity graph without changing legacy session identity', () => {
    const raw = parseBridgeFleetSnapshot(JSON.parse(readFileSync(identityFixturePath, 'utf8')));
    const dashboard = toFleetSnapshot(raw, 'Ubuntu');
    expect(dashboard.physicalHosts).toHaveLength(1);
    expect(dashboard.physicalHosts[0]).toMatchObject({
      id: 'gaming-desktop',
      executionTargetIds: ['linux', 'windows'],
      legacyHostIds: ['gaming-desktop-ubuntu', 'gaming-desktop_windows']
    });
    expect(dashboard.sessions[0]).toMatchObject({
      id: 'gaming-desktop-ubuntu:wtmux-project-1',
      hostId: 'gaming-desktop-ubuntu',
      physicalHostId: 'gaming-desktop',
      executionTargetId: 'linux'
    });
    expect(dashboard.endpoints[0]).toMatchObject({ identityState: 'verified', sshEngine: 'openssh' });
  });

  it('rejects duplicate or inconsistent canonical identity mappings', () => {
    const duplicate = JSON.parse(readFileSync(identityFixturePath, 'utf8'));
    duplicate.executionTargets.push({ ...duplicate.executionTargets[0] });
    expect(() => parseBridgeFleetSnapshot(duplicate)).toThrow(/duplicate scoped id/i);

    const inconsistent = JSON.parse(readFileSync(identityFixturePath, 'utf8'));
    inconsistent.sessions[0].executionTargetId = 'windows';
    expect(() => parseBridgeFleetSnapshot(inconsistent)).toThrow(/backend and execution target differ/i);

    const changedEvidence = JSON.parse(readFileSync(identityFixturePath, 'utf8'));
    changedEvidence.endpoints[0].identityState = 'reverify-required';
    expect(parseBridgeFleetSnapshot(changedEvidence).endpoints[0]?.identityState).toBe('reverify-required');
  });

  it('accepts negotiated smart titles but still rejects unnegotiated titles and prompt fields', () => {
    const titlePayload = JSON.parse(readFileSync(fixturePath, 'utf8'));
    titlePayload.sessions[0].title = 'private pane title';
    expect(() => parseBridgeFleetSnapshot(titlePayload)).toThrow(/title/i);

    titlePayload.presentationRevision = '0123456789abcdef';
    titlePayload.sessions[0].nameMode = 'automatic';
    const titled = toFleetSnapshot(parseBridgeFleetSnapshot(titlePayload), 'Ubuntu');
    expect(titled.sessions[0]).toMatchObject({ title: 'private pane title', nameMode: 'automatic' });
    expect(titled.presentationRevision).toBe('0123456789abcdef');

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

  it('accepts current bounded host quota metadata', () => {
    const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
    payload.limits = [{
      id: 'test-host:codex:default', hostId: 'test-host', provider: 'codex', profileAlias: 'Codex', status: 'ready',
      primary: { usedPercent: 25, remainingPercent: 75, resetsAt: '2026-07-12T05:00:00Z', windowMinutes: 300 },
      secondary: { usedPercent: 40, remainingPercent: 60, resetsAt: '2026-07-19T05:00:00Z', windowMinutes: 10080 },
      updatedAt: '2026-07-12T04:00:00Z'
    }];
    const snapshot = toFleetSnapshot(parseBridgeFleetSnapshot(payload), 'Ubuntu');
    expect(snapshot.limits).toEqual([expect.objectContaining({ fiveHourRemaining: 75, weeklyRemaining: 60 })]);
    payload.limits[0].primary.remainingPercent = 101;
    expect(() => parseBridgeFleetSnapshot(payload)).toThrow(/remainingPercent/i);
  });

  it('accepts additive session paths while keeping them out of titles', () => {
    const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
    payload.sessions[0].projectPath = '/srv/private/work';
    payload.sessions[0].locationKind = 'custom';
    const snapshot = toFleetSnapshot(parseBridgeFleetSnapshot(payload), 'Ubuntu');
    expect(snapshot.sessions[0]).toMatchObject({ projectPath: '/srv/private/work', title: '' });
    expect(snapshot.sessions[0].name).not.toContain('/srv/private/work');
  });

  it('shows only active hard-limit attention states', () => {
    const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const base = {
      id: 'limit-active', hostId: payload.hosts[0].id, kind: 'hard-limit',
      sessionId: payload.sessions[0].id, agent: 'codex', resetAt: '2026-07-12T06:00:00Z',
      detectedAt: '2026-07-12T05:00:00Z', updatedAt: '2026-07-12T05:00:00Z'
    };
    payload.attention = [
      { ...base, id: 'detected', state: 'detected' },
      { ...base, id: 'offered', state: 'offered' },
      { ...base, id: 'resolved', state: 'resolved' },
      { ...base, id: 'expired', state: 'expired' },
      { ...base, id: 'future-state', state: 'future-state' }
    ];
    expect(toFleetSnapshot(parseBridgeFleetSnapshot(payload), 'Ubuntu').attention.map((item) => item.id))
      .toEqual(['detected', 'offered']);
  });

  it('parses bounded transient directory listings', () => {
    const listing = parseFleetDirectoryListing({
      backend: 'linux', path: '/home/user', parentPath: '/home', truncated: false,
      entries: [{ name: 'work', path: '/home/user/work' }],
      shortcuts: [{ id: 'home', label: 'Home', path: '/home/user' }]
    });
    expect(listing.entries[0]).toEqual({ name: 'work', path: '/home/user/work' });
    expect(() => parseFleetDirectoryListing({ ...listing, entries: [{ name: 'bad', path: '/ok', extra: true }] })).toThrow(/fields/i);
  });

  it('parses strict transient repository pages', () => {
    const shared = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'repository_page_v1.json'), 'utf8'));
    const page = parseFleetRepositoryPage(shared);
    expect(page.entries[1]).toMatchObject({ relativePath: 'docs/guide.pdf', size: 1200 });
    expect(() => parseFleetRepositoryPage({ ...page, entries: [{ ...page.entries[1], size: null }] })).toThrow(/size/i);
    expect(() => parseFleetRepositoryPage({ ...page, entries: [{ ...page.entries[1], prompt: 'secret' }] })).toThrow(/fields/i);
    expect(() => parseFleetRepositoryPage({ ...page, relativePath: '../secret' })).toThrow(/invalid/i);
  });

  it('parses strict resource-revisioned session model state', () => {
    const payload = {
      sessionId: 'test-host:session-1', configRevision: '0123456789abcdef', tool: 'codex', status: 'queued',
      selected: { modelId: 'auto', modelLabel: 'Auto', effortId: 'automatic', effortLabel: 'Automatic' },
      effective: null,
      pending: {
        operationId: 'model-operation-1', modelId: 'provider/model-2', effortId: 'high', custom: false,
        requestedAt: '2026-07-18T00:00:00Z', expiresAt: '2026-07-18T00:30:00Z'
      },
      catalog: { customAllowed: true, models: [{
        id: 'provider/model-2', label: 'Provider Model 2', description: 'Discovered on host', isDefault: false,
        efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultEffort: 'high'
      }] },
      detail: ''
    };
    expect(parseFleetModelControlState(payload)).toMatchObject({ pending: { effortId: 'high' } });
    expect(() => parseFleetModelControlState({ ...payload, transcript: 'private' })).toThrow(/fields/i);
    expect(() => parseFleetModelControlState({
      ...payload, catalog: { ...payload.catalog, models: [{ ...payload.catalog.models[0], id: 'bad model; echo secret' }] }
    })).toThrow(/model id/i);
  });
});
