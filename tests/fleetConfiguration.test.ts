import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetConfigurationStore } from '../src/main/fleet-configuration-store';
import {
  fleetConfigurationExport,
  parseFleetPairingBundle,
  reviewPairingInvitation
} from '../src/shared/fleet-configuration';

const roots: string[] = [];
const fixture = (): string => readFileSync(join(__dirname, 'fixtures/contracts/pairing-bundle-v1.json'), 'utf8');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

function withIntegrity(value: Record<string, any>): string {
  const payload = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'integrity'));
  value.integrity.digest = createHash('sha256')
    .update(`${JSON.stringify(canonical(payload))}\n`)
    .digest('hex');
  return JSON.stringify(value);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('unified fleet configuration', () => {
  it('parses the shared integrity fixture and keeps primary/fallback sources in policy', () => {
    const value = parseFleetPairingBundle(fixture());
    expect(value.configurationRevision).toBe(7);
    expect(value.clientPolicy.apkManifestUrls).toHaveLength(2);
    expect(value.clientPolicy.runtimeManifestUrls).toHaveLength(2);
    expect(value.hostTrust[0].identityState).toBe('verified');
  });

  it('reviews invitations without returning their one-time secret', () => {
    const review = reviewPairingInvitation(
      'wtmux://pair?pairingVersion=1&bootstrapPeer=controller.tailnet.ts.net&bootstrapUser=controller'
      + '&token=pAAAAAAAAAAAAAAAAAAAAAA&expiresAt=2026-07-25T12%3A00%3A00Z',
      new Date('2026-07-24T12:00:00Z')
    );
    expect(review).toEqual({
      bootstrapPeer: 'controller.tailnet.ts.net',
      bootstrapUser: 'controller',
      expiresAt: '2026-07-25T12:00:00Z',
      expired: false,
      integrity: 'one-time-secret'
    });
    expect(JSON.stringify(review)).not.toContain('pAAAAAAAA');
  });

  it('rejects a configured metadata source outside the artifact origin allowlist', () => {
    const value = JSON.parse(fixture()) as Record<string, any>;
    value.clientPolicy.runtimeManifestUrls[0] = 'https://evil.example.invalid/runtime/manifest.json';
    expect(() => parseFleetPairingBundle(withIntegrity(value))).toThrow('source origin is not approved');
  });

  it('activates atomically and rejects a corrupt replacement without losing healthy state', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-configuration-'));
    roots.push(root);
    const store = new FleetConfigurationStore(root);
    expect(store.activate(fixture()).status).toBe('activated');
    const healthy = store.current();
    expect(healthy?.configurationRevision).toBe(7);
    expect(() => store.activate(fixture().replace('"gaming"', '"changed"'))).toThrow('integrity');
    expect(store.current()).toEqual(healthy);
  });

  it('exports only the canonical pairing allowlist', () => {
    const value = parseFleetPairingBundle(fixture());
    const exported = JSON.parse(fleetConfigurationExport(value)) as Record<string, unknown>;
    expect(Object.keys(exported).sort()).toEqual([
      'bundleId', 'clientPolicy', 'compatibility', 'configurationRevision', 'createdAt',
      'fleetId', 'hostTrust', 'integrity', 'registry', 'schemaVersion'
    ].sort());
    expect(JSON.stringify(exported).toLowerCase()).not.toContain('transcript');
    expect(JSON.stringify(exported).toLowerCase()).not.toContain('credential');
  });
});
