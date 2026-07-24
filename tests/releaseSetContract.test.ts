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
    expect(lock).toMatchObject({ schemaVersion: 1, packageVersion: '1.7.0', algorithm: 'sha256' });
    const fixtures = {
      'fixtures/invalid/activation-journal-content-field-v1.json': 'activation-journal-content-field-v1.json',
      'fixtures/invalid/activation-journal-unknown-field-v1.json': 'activation-journal-unknown-field-v1.json',
      'fixtures/valid/activation-journal-v1.json': 'activation-journal-v1.json',
      'fixtures/invalid/compatibility-content-field-v1.json': 'compatibility-content-field-v1.json',
      'fixtures/invalid/compatibility-unknown-field-v1.json': 'compatibility-unknown-field-v1.json',
      'fixtures/valid/control-frames-v1.json': 'control-frames-v1.json',
      'fixtures/valid/control-results-v1.json': 'control-results-v1.json',
      'fixtures/valid/conversation-frames-v2.json': 'conversation-frames-v2.json',
      'fixtures/valid/conversation-structured-work-v2.json': 'conversation-structured-work-v2.json',
      'fixtures/valid/diagnostics-v1.json': 'diagnostics-v1.json',
      'fixtures/valid/fleet-snapshot-base-v1.json': 'fleet-snapshot-base-v1.json',
      'fixtures/valid/host-runtime-conformance-v1.json': 'host-runtime-conformance-v1.json',
      'fixtures/valid/release-set-v1.json': 'release-set-v1.json',
      'fixtures/valid/workspace-layout-v1.json': 'workspace-layout-v1.json',
      'fixtures/invalid/control-content-field-v1.json': 'control-content-field-v1.json',
      'fixtures/invalid/control-unknown-field-v1.json': 'control-unknown-field-v1.json',
      'fixtures/invalid/control-result-content-field-v1.json': 'control-result-content-field-v1.json',
      'fixtures/invalid/control-result-unknown-field-v1.json': 'control-result-unknown-field-v1.json',
      'fixtures/invalid/conversation-item-unknown-field-v2.json': 'conversation-item-unknown-field-v2.json',
      'fixtures/invalid/conversation-unknown-field-v2.json': 'conversation-unknown-field-v2.json',
      'fixtures/invalid/diagnostics-content-field-v1.json': 'diagnostics-content-field-v1.json',
      'fixtures/invalid/diagnostics-unknown-field-v1.json': 'diagnostics-unknown-field-v1.json',
      'fixtures/invalid/fleet-snapshot-content-field-v1.json': 'fleet-snapshot-content-field-v1.json',
      'fixtures/invalid/fleet-snapshot-unknown-field-v1.json': 'fleet-snapshot-unknown-field-v1.json',
      'fixtures/invalid/host-runtime-content-field-v1.json': 'host-runtime-content-field-v1.json',
      'fixtures/invalid/host-runtime-unknown-field-v1.json': 'host-runtime-unknown-field-v1.json',
      'fixtures/invalid/release-set-content-field-v1.json': 'release-set-content-field-v1.json',
      'fixtures/invalid/release-set-unknown-field-v1.json': 'release-set-unknown-field-v1.json',
      'fixtures/valid/transport-conformance-v1.json': 'transport-conformance-v1.json',
      'fixtures/invalid/transport-content-field-v1.json': 'transport-content-field-v1.json',
      'fixtures/invalid/transport-unknown-field-v1.json': 'transport-unknown-field-v1.json',
      'fixtures/invalid/workspace-layout-unknown-field-v1.json': 'workspace-layout-unknown-field-v1.json',
      'generated/structural-models-v1.json': 'structural-models-v1.json'
    };
    for (const [canonicalPath, localName] of Object.entries(fixtures)) {
      expect(createHash('sha256').update(fixture(localName)).digest('hex')).toBe(lock.files[canonicalPath]);
    }
  });

  it('accepts the shared release set and base fleet snapshot', () => {
    const release = parseAgentFleetReleaseSetJson(fixture('release-set-v1.json'));
    expect(release.releaseSetSequence).toBe(1083);
    expect(release.artifacts.map((item) => item.component)).toEqual([
      'windowsApp', 'androidApp', 'clientRuntime', 'clientRuntime'
    ]);
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
    expect(() => parseAgentFleetReleaseSetJson(JSON.stringify({ ...baseline, rollbackFloor: { ...baseline.rollbackFloor, releaseSetSequence: 1084 } }))).toThrow();
    expect(() => parseAgentFleetReleaseSetJson(JSON.stringify({ ...baseline, artifacts: [baseline.artifacts[0], baseline.artifacts[0]] }))).toThrow();
    const incompatible = structuredClone(baseline);
    incompatible.components.clientRuntime.sequence = 46;
    expect(() => parseAgentFleetReleaseSetJson(JSON.stringify(incompatible))).toThrow('incompatible');
    const mismatchedArtifact = structuredClone(baseline);
    mismatchedArtifact.artifacts[0].componentSequence += 1;
    expect(() => parseAgentFleetReleaseSetJson(JSON.stringify(mismatchedArtifact))).toThrow('identity');
    const credentialed = structuredClone(baseline); credentialed.artifacts[0].url = 'https://user:secret@updates.example.invalid/app';
    expect(() => parseAgentFleetReleaseSetJson(JSON.stringify(credentialed))).toThrow();
  });
});
