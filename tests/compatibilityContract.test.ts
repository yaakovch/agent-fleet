import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertContractDiagnosticReport,
  componentSupportsCurrentContracts,
  createContractDiagnosticReport,
  parseCompatibilityMatrixJson
} from '../src/shared/compatibility-contract';
import {
  GENERATED_CONTROL_REQUEST_SHAPES,
  GENERATED_OBJECT_SHAPES,
  GENERATED_PROTOCOL_VERSIONS
} from '../src/shared/generated/agent-fleet-contracts';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'contracts', name), 'utf8');

describe('Agent Fleet compatibility and diagnostics contracts', () => {
  it('uses the shared generated structural catalog', () => {
    const catalog = JSON.parse(fixture('structural-models-v1.json')) as {
      protocolVersions: Record<string, number>;
      objectShapes: Array<{ id: string; required: string[]; optional: string[]; rejectUnknown: boolean }>;
      controlRequestShapes: Record<string, { required: string[]; optional: string[] }>;
    };
    expect(GENERATED_PROTOCOL_VERSIONS).toEqual(catalog.protocolVersions);
    expect(GENERATED_OBJECT_SHAPES).toEqual(Object.fromEntries(catalog.objectShapes.map(({ id, ...shape }) => [id, shape])));
    expect(GENERATED_CONTROL_REQUEST_SHAPES).toEqual(catalog.controlRequestShapes);
  });

  it('accepts the shared compatibility matrix', () => {
    const matrix = parseCompatibilityMatrixJson(fixture('compatibility-v1.json'));
    expect(matrix.contractPackageVersion).toBe('1.7.0');
    expect(Object.values(matrix.components).every(componentSupportsCurrentContracts)).toBe(true);
  });

  it.each(['compatibility-unknown-field-v1.json', 'compatibility-content-field-v1.json'])(
    'rejects shared invalid compatibility matrix %s', (name) => {
      expect(() => parseCompatibilityMatrixJson(fixture(name))).toThrow('Invalid Agent Fleet compatibility contract');
    }
  );

  it('accepts the shared diagnostics fixture and rejects the same invalid fixtures', () => {
    assertContractDiagnosticReport(JSON.parse(fixture('diagnostics-v1.json')));
    for (const name of ['diagnostics-unknown-field-v1.json', 'diagnostics-content-field-v1.json']) {
      expect(() => assertContractDiagnosticReport(JSON.parse(fixture(name)))).toThrow('Invalid Agent Fleet compatibility contract');
    }
  });

  it('reports additive host compatibility without failing legacy doctors', () => {
    const legacy = createContractDiagnosticReport('windows-app', 'test', [{
      hostId: 'host', checkedAt: '2026-07-22T12:00:00Z', status: 'healthy', checks: []
    }]);
    expect(legacy.checks[0].status).toBe('not-run');
    const compatible = createContractDiagnosticReport('windows-app', 'test', [{
      hostId: 'host', checkedAt: '2026-07-22T12:00:00Z', status: 'healthy',
      checks: [{ id: 'compatibility', status: 'healthy', summary: 'Ready', detail: 'contracts 1.0.0' }]
    }]);
    expect(compatible.checks[0]).toMatchObject({ status: 'healthy', errorCode: 'OK' });
    expect(compatible.components[0].capabilities).toContain('host-runtime.v1');
    assertContractDiagnosticReport(compatible);
  });
});
