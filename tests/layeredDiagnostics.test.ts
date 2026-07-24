import { describe, expect, it } from 'vitest';
import { createDiagnosticsEntries } from '../src/main/diagnostics';
import {
  assertLayeredDiagnosticReport,
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
  updateConfigured: true
});

describe('layered diagnostics v2', () => {
  it('uses every shared layer with stable labels and read-only recovery evidence', () => {
    const report = createWindowsLayeredDiagnostics(input());
    assertLayeredDiagnosticReport(report);
    expect(report.checks.map((check) => check.layer)).toEqual(DIAGNOSTIC_LAYERS);
    expect(report.checks.every((check) => check.readOnly)).toBe(true);
    expect(report.checks.find((check) => check.layer === 'tailnet')?.errorCode).toBe('TAILNET_UNAVAILABLE');
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
      updateConfigured: value.updateConfigured
    });
    expect(Object.keys(entries)).toEqual(['diagnostics-v2.json']);
    expect(JSON.stringify(entries)).not.toContain('secret-canary');
    expect(JSON.stringify(entries)).not.toContain('C:\\Users');
  });
});

function fixture(name: string): string {
  return require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'contracts', name), 'utf8') as string;
}
