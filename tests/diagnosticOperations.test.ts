import { describe, expect, it } from 'vitest';
import { DiagnosticOperationJournal, diagnosticOperationsNdjson, connectionDiagnosticStatus } from '../src/main/diagnostic-operations';

describe('metadata-only creation diagnostics', () => {
  it('records a live snapshot with an unavailable host as failure even without an error code', () => {
    expect(connectionDiagnosticStatus('live', '', [{ status: 'offline', errorCode: '' }]))
      .toEqual({ status: 'failure', code: 'host_offline' });
    expect(connectionDiagnosticStatus('live', '', [{ status: 'healthy', errorCode: '' }]))
      .toEqual({ status: 'healthy', code: '' });
  });
  it('ignores intentional paused connections and startup while retaining transport failures', () => {
    expect(connectionDiagnosticStatus('offline', '', [], true)).toBeNull();
    expect(connectionDiagnosticStatus('starting', '', [])).toBeNull();
    expect(connectionDiagnosticStatus('error', 'SNAPSHOT_TIMEOUT', []))
      .toEqual({ status: 'failure', code: 'SNAPSHOT_TIMEOUT' });
  });
  it('retains creation time and failure code while dropping private content and unknown tokens', () => {
    const now = Date.parse('2026-10-09T12:11:00Z');
    const body = diagnosticOperationsNdjson([
      { occurredAt: new Date(now).toISOString(), operation: 'session.create.windows', status: 'failure',
        code: 'TIMEOUT', durationMs: 12, message: 'secret transcript', path: '/private/project', hostId: 'private-host' },
      { occurredAt: new Date(now).toISOString(), operation: 'session.create', status: 'failure', code: 'secret-token' }
    ], now);
    const rows = body.trim().split('\n').map((line) => JSON.parse(line));
    expect(rows[0]).toEqual({ schemaVersion: 1, occurredAt: new Date(now).toISOString(), operation: 'session.create.windows',
      status: 'failure', code: 'timeout', durationMs: 12 });
    expect(rows[1].code).toBe('operation_failed');
    expect(body).not.toMatch(/secret|private|transcript|hostId|message|path/);
  });
  it('bounds age, count and duration and ignores malformed or unrelated records', () => {
    const now = Date.parse('2026-10-09T12:11:00Z');
    const record = { occurredAt: new Date(now).toISOString(), operation: 'session.create.linux', status: 'pending', durationMs: Infinity };
    const rows = diagnosticOperationsNdjson([null, { ...record, operation: 'secret' },
      { ...record, occurredAt: 'invalid' }, { ...record, occurredAt: '2020-01-01T00:00:00Z' },
      ...Array.from({ length: 220 }, () => record)], now).trim().split('\n');
    expect(rows).toHaveLength(200);
    expect(JSON.parse(rows[0]).durationMs).toBe(0);
  });
  it('records a pending attempt and its outcome without exporting identifiers', () => {
    let now = Date.parse('2026-10-09T12:11:00Z');
    const journal = new DiagnosticOperationJournal(() => now);
    journal.record('session.create.linux', 'pending');
    now += 20;
    journal.record('session.create.linux', 'healthy', '', 20);
    expect(journal.entries().map((row) => row.status)).toEqual(['pending', 'healthy']);
    now += 8 * 86400_000;
    journal.record('session.create.windows', 'failure', 'host_offline');
    expect(journal.entries()).toHaveLength(1);
  });
});
