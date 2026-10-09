const OPERATIONS = new Set(['session.create', 'session.create.linux', 'session.create.windows',
  'fleet.refresh', 'fleet.reconnect', 'runtime.prepare', 'runtime.update']);
const STATUSES = new Set(['pending', 'healthy', 'failure']);
const CODES = new Set([
  '', 'operation_failed', 'invalid_request', 'invalid_response', 'stale_revision',
  'host_offline', 'backpressure', 'timeout', 'request_timeout', 'unsafe_state',
  'not_found', 'internal_failure', 'host_error', 'transport_error', 'fleet_loading',
  'local_runtime_unavailable', 'snapshot_timeout', 'host_runtime_missing',
  'host_runtime_unavailable', 'host_key_mismatch', 'endpoint_unavailable',
  'registry_invalid', 'process_start_failed', 'session_exists', 'windows_unavailable',
  'windows_launch_failed', 'created_open_failed', 'ssh_failed', 'ssh_auth_failed',
  'ssh_host_key_changed', 'ssh_connect_failed', 'ssh_timeout', 'ssh_not_found',
  'host_key_unknown', 'protocol_incompatible', 'json_response_invalid', 'validation_failed',
  'io_failure', 'security_error', 'state_invalid'
]);

export interface DiagnosticOperation {
  schemaVersion: 1;
  occurredAt: string;
  operation: string;
  status: string;
  code: string;
  durationMs: number;
}

/** Export fixed metadata fields only; never serialize exception or journal content. */
export function diagnosticOperationsNdjson(input: readonly unknown[], now = Date.now()): string {
  const records: DiagnosticOperation[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    if (typeof item.operation !== 'string' || !OPERATIONS.has(item.operation)
      || typeof item.status !== 'string' || !STATUSES.has(item.status)
      || typeof item.occurredAt !== 'string') continue;
    const epoch = Date.parse(item.occurredAt);
    if (!Number.isFinite(epoch) || epoch < now - 7 * 86400_000 || epoch > now + 60_000) continue;
    const code = typeof item.code === 'string' ? item.code.toLowerCase() : '';
    records.push({ schemaVersion: 1, occurredAt: new Date(epoch).toISOString(),
      operation: item.operation, status: item.status,
      code: CODES.has(code) ? code : 'operation_failed',
      durationMs: typeof item.durationMs === 'number' && Number.isFinite(item.durationMs)
        ? Math.max(0, Math.min(86400_000, Math.floor(item.durationMs))) : 0 });
  }
  return records.slice(-200).map((record) => JSON.stringify(record) + '\n').join('');
}

export class DiagnosticOperationJournal {
  private records: DiagnosticOperation[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  record(operation: string, status: string, code = '', durationMs = 0): void {
    const epoch = this.now();
    const body = diagnosticOperationsNdjson([...this.records,
      { occurredAt: new Date(epoch).toISOString(), operation, status, code, durationMs }], epoch);
    this.records = body.trim() ? body.trim().split('\n').map((line) => JSON.parse(line) as DiagnosticOperation) : [];
  }
  entries(): DiagnosticOperation[] { return this.records.map((item) => ({ ...item })); }
}
