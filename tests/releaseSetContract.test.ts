import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseBridgeFleetSnapshot } from '../src/shared/fleet-protocol';
import { parseAgentFleetReleaseSetJson } from '../src/shared/release-set';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'contracts', name), 'utf8');

describe('Agent Fleet canonical contract fixtures', () => {
  it('matches the canonical fixture lock byte for byte', () => {
    const lock = JSON.parse(fixture('contract-lock-v1.json')) as {
      schemaVersion: number; packageVersion: string; algorithm: string; files: Record<string, string>
    };
    expect(lock).toMatchObject({ schemaVersion: 1, packageVersion: '1.0.0', algorithm: 'sha256' });
    const fixtures = {
      'fixtures/valid/conversation-structured-work-v2.json': 'conversation-structured-work-v2.json',
      'fixtures/valid/fleet-snapshot-base-v1.json': 'fleet-snapshot-base-v1.json',
      'fixtures/valid/release-set-v1.json': 'release-set-v1.json',
      'fixtures/valid/workspace-layout-v1.json': 'workspace-layout-v1.json',
      'fixtures/invalid/conversation-item-unknown-field-v2.json': 'conversation-item-unknown-field-v2.json',
      'fixtures/invalid/conversation-unknown-field-v2.json': 'conversation-unknown-field-v2.json',
      'fixtures/invalid/fleet-snapshot-content-field-v1.json': 'fleet-snapshot-content-field-v1.json',
      'fixtures/invalid/fleet-snapshot-unknown-field-v1.json': 'fleet-snapshot-unknown-field-v1.json',
      'fixtures/invalid/release-set-content-field-v1.json': 'release-set-content-field-v1.json',
      'fixtures/invalid/release-set-unknown-field-v1.json': 'release-set-unknown-field-v1.json',
      'fixtures/invalid/workspace-layout-unknown-field-v1.json': 'workspace-layout-unknown-field-v1.json'
    };
    for (const [canonicalPath, localName] of Object.entries(fixtures)) {
      expect(createHash('sha256').update(fixture(localName)).digest('hex')).toBe(lock.files[canonicalPath]);
    }
  });

  it('accepts the shared release set and base fleet snapshot', () => {
    const release = parseAgentFleetReleaseSetJson(fixture('release-set-v1.json'));
    expect(release.releaseSetSequence).toBe(1082);
    expect(release.artifacts.map((item) => item.component)).toEqual(['windowsApp', 'androidApp']);
    expect(parseBridgeFleetSnapshot(JSON.parse(fixture('fleet-snapshot-base-v1.json'))).revision).toBe('fixture-revision');
  });

  it.each(['fleet-snapshot-unknown-field-v1.json', 'fleet-snapshot-content-field-v1.json'])(
    'rejects shared invalid fleet snapshot %s', (name) => {
      expect(() => parseBridgeFleetSnapshot(JSON.parse(fixture(name)))).toThrow('Invalid fleet protocol v1');
    }
  );

  it.each(['release-set-unknown-field-v1.json', 'release-set-content-field-v1.json'])(
    'rejects shared invalid fixture %s', (name) => {
      expect(() => parseAgentFleetReleaseSetJson(fixture(name))).toThrow('Invalid release set');
    }
  );

  it('rejects nested unknowns, rollback, duplicate artifacts, and credentialed URLs', () => {
    const baseline = JSON.parse(fixture('release-set-v1.json'));
    expect(() => parseAgentFleetReleaseSetJson(JSON.stringify({ ...baseline, protocols: { ...baseline.protocols, extra: 1 } }))).toThrow();
    expect(() => parseAgentFleetReleaseSetJson(JSON.stringify({ ...baseline, rollbackFloor: { ...baseline.rollbackFloor, releaseSetSequence: 1083 } }))).toThrow();
    expect(() => parseAgentFleetReleaseSetJson(JSON.stringify({ ...baseline, artifacts: [baseline.artifacts[0], baseline.artifacts[0]] }))).toThrow();
    const credentialed = structuredClone(baseline); credentialed.artifacts[0].url = 'https://user:secret@updates.example.invalid/app';
    expect(() => parseAgentFleetReleaseSetJson(JSON.stringify(credentialed))).toThrow();
  });
});
