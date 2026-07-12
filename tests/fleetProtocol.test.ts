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
});
