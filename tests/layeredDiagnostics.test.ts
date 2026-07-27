import { describe, expect, it } from 'vitest';
import { createDiagnosticsEntries } from '../src/main/diagnostics';
import {
  assertLayeredDiagnosticReport,
  createLegacyUsage,
  createWindowsLayeredDiagnostics,
  DIAGNOSTIC_LAYERS
} from '../src/shared/layered-diagnostics';
import { emptyFleetSnapshot } from '../src/shared/fleet-protocol';

const input = () => ({
  clientVersion: 'test-client',
  correlationId: 'diag-0123456789abcdef0123456789abcdef',
  generatedAt: '2026-07-24T12:00:00Z',
  fleet: {
    status: 'offline' as const,
    snapshot: emptyFleetSnapshot('Ubuntu'),
    cacheSavedAt: null,
    errorCode: 'NETWORK_UNREACHABLE'
  },
  doctors: [],
  terminal: {
    wslAvailable: true,
    conptyState: 'ready' as const,
    activePtys: 0,
    reconnectingPtys: 0,
    unavailablePtys: 0,
    failureCodes: []
  },
  wslRuntime: {
    status: 'ready' as const,
    current: 'runtime-test',
    previous: 'runtime-old',
    embeddedVersion: 'runtime-test',
    contractPackageVersion: '1.7.0',
    sourceCommit: 'fixture',
    detail: 'ready'
  },
  updateConfigured: true,
  processOwnership: {
    active: 2,
    owners: { 'control:bridge': 1, 'conversation:tab-a': 1 } as Record<string, number>,
    releases: {
      detach: 0, cancel: 0, tmux_kill: 0, wsl_shutdown: 0, host_restart: 0,
      app_shutdown: 0, timeout: 0, protocol_failure: 0, superseded: 0
    }
  }
});

describe('layered diagnostics v2', () => {
  it('uses every shared layer with stable labels and read-only recovery evidence', () => {
    const report = createWindowsLayeredDiagnostics(input());
    assertLayeredDiagnosticReport(report);
    expect(report.checks.map((check) => check.layer)).toEqual(DIAGNOSTIC_LAYERS);
    expect(report.checks.every((check) => check.readOnly)).toBe(true);
    expect(report.checks.find((check) => check.layer === 'tailnet')?.errorCode).toBe('TAILNET_UNAVAILABLE');
    expect(report.legacyUsage).toEqual({
      successfulReleaseCycles: 0,
      migrationVerification: {
        registeredHosts: 0, verifiedHosts: 0, registeredClients: 1, verifiedClients: 1
      },
      signals: {
        syntheticWindowsIdentities: 0, ambientRuntimeResolutions: 0,
        androidOneShotControlStarts: 0, legacyConfigFields: 0
      },
      removalEligible: false,
      blockers: ['release_cycles', 'host_migration']
    });
  });

  it('only declares legacy removal eligible from two clean verified release cycles', () => {
    const eligible = createLegacyUsage({
      successfulReleaseCycles: 2,
      registeredHosts: 3,
      verifiedHosts: 3,
      registeredClients: 2,
      verifiedClients: 2,
      syntheticWindowsIdentities: 0,
      ambientRuntimeResolutions: 0,
      androidOneShotControlStarts: 0,
      legacyConfigFields: 0
    });
    expect(eligible).toMatchObject({ removalEligible: true, blockers: [] });
    const report = createWindowsLayeredDiagnostics(input());
    const forged = { ...report, legacyUsage: { ...report.legacyUsage, removalEligible: true } };
    expect(() => assertLayeredDiagnosticReport(forged)).toThrow();
  });

  it('accepts the canonical fixture and rejects path or content fields', () => {
    const valid = JSON.parse(fixture('diagnostics-v2.json')) as unknown;
    expect(() => assertLayeredDiagnosticReport(valid)).not.toThrow();
    expect(() => assertLayeredDiagnosticReport(JSON.parse(fixture('diagnostics-content-field-v2.json')))).toThrow();
    expect(() => assertLayeredDiagnosticReport(JSON.parse(fixture('diagnostics-private-path-v2.json')))).toThrow();
  });

  it('exports exactly one redacted report even when inputs contain canaries', () => {
    const value = input();
    value.wslRuntime.detail = 'token=secret-canary at C:\\Users\\person\\private';
    const entries = createDiagnosticsEntries({
      app: {
        name: 'Agent Fleet', version: value.clientVersion, packaged: true, portable: false,
        dataDirectory: 'redacted', releaseUrl: 'https://example.invalid'
      },
      fleet: value.fleet,
      doctors: value.doctors,
      terminal: value.terminal,
      wslRuntime: value.wslRuntime,
      updateConfigured: value.updateConfigured,
      processOwnership: value.processOwnership
    });
    expect(Object.keys(entries)).toEqual(['diagnostics-v2.json']);
    expect(JSON.stringify(entries)).not.toContain('secret-canary');
    expect(JSON.stringify(entries)).not.toContain('C:\\Users');
  });

  it('surfaces duplicate app-owned process generations without exposing owner IDs', () => {
    const value = input();
    value.processOwnership = {
      ...value.processOwnership,
      active: 2,
      owners: { 'conversation:private-tab': 2 }
    };
    const report = createWindowsLayeredDiagnostics(value);
    const platform = report.checks.find((check) => check.layer === 'platform_adapter');
    expect(platform).toMatchObject({
      status: 'attention',
      errorCode: 'STALE_CONNECTIONS_DETECTED',
      summary: '1 app connection owners need review'
    });
    expect(JSON.stringify(report)).not.toContain('private-tab');
  });
});

function fixture(name: string): string {
  return require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'contracts', name), 'utf8') as string;
}
