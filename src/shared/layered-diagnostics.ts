import { randomUUID } from 'node:crypto';
import type { FleetBridgeView, FleetDoctorResult } from './fleet-protocol';
import type { TerminalHealth } from './terminal';
import type { WslRuntimeState } from './runtime';

export const DIAGNOSTIC_LAYERS = [
  'client_app', 'platform_adapter', 'client_runtime', 'tailnet', 'ssh',
  'host_runtime', 'tmux', 'endpoint', 'execution_target', 'provider_adapter',
  'update_channel'
] as const;

export type DiagnosticLayer = typeof DIAGNOSTIC_LAYERS[number];
export type LayeredDiagnosticRecovery = 'none' | 'retry' | 'repair_client_runtime' | 'rollback_runtime'
  | 'open_tailscale' | 'review_host_key' | 'copy_redacted_report' | 'open_terminal';

export interface LayeredDiagnosticCheck {
  id: string;
  layer: DiagnosticLayer;
  label: string;
  status: 'healthy' | 'attention' | 'failure' | 'not-run';
  severity: 'info' | 'warning' | 'error';
  errorCode: string;
  durationMs: number;
  version: string;
  recoveryAction: LayeredDiagnosticRecovery;
  summary: string;
  readOnly: true;
}

export interface LayeredDiagnosticReport {
  schemaVersion: 2;
  correlationId: string;
  generatedAt: string;
  totalDurationMs: number;
  components: Array<{ id: string; version: string }>;
  checks: LayeredDiagnosticCheck[];
}

export interface WindowsLayeredDiagnosticsInput {
  clientVersion: string;
  generatedAt?: string;
  correlationId?: string;
  totalDurationMs?: number;
  fleet: FleetBridgeView;
  doctors: readonly FleetDoctorResult[];
  terminal: TerminalHealth;
  wslRuntime: WslRuntimeState;
  updateConfigured: boolean;
}

const LABELS: Record<DiagnosticLayer, string> = {
  client_app: 'Client app',
  platform_adapter: 'Platform adapter',
  client_runtime: 'Client runtime',
  tailnet: 'Private network',
  ssh: 'Secure Shell',
  host_runtime: 'Host runtime',
  tmux: 'Session service',
  endpoint: 'Host endpoint',
  execution_target: 'Execution target',
  provider_adapter: 'Native provider',
  update_channel: 'Update channel'
};

const RECOVERY: Record<DiagnosticLayer, LayeredDiagnosticRecovery> = {
  client_app: 'none',
  platform_adapter: 'copy_redacted_report',
  client_runtime: 'repair_client_runtime',
  tailnet: 'open_tailscale',
  ssh: 'review_host_key',
  host_runtime: 'retry',
  tmux: 'retry',
  endpoint: 'retry',
  execution_target: 'retry',
  provider_adapter: 'open_terminal',
  update_channel: 'rollback_runtime'
};

export function createWindowsLayeredDiagnostics(input: WindowsLayeredDiagnosticsInput): LayeredDiagnosticReport {
  const runtimeHealthy = input.wslRuntime.status === 'ready';
  const fleetHealthy = input.fleet.status === 'live';
  const fleetFailure = input.fleet.status === 'offline' || input.fleet.status === 'error';
  const hostStatuses = input.fleet.snapshot.physicalHosts.map((host) => host.status);
  const endpointAvailable = input.fleet.snapshot.endpoints.length > 0;
  const targetAvailable = input.fleet.snapshot.executionTargets.length > 0;
  const providerAvailable = input.fleet.snapshot.sessions.some((session) => session.tool !== 'shell');
  const sshEvidence = doctorEvidence(input.doctors, ['ssh', 'transport', 'connection']);
  const runtimeEvidence = doctorEvidence(input.doctors, ['compatibility', 'runtime']);
  const tmuxEvidence = doctorEvidence(input.doctors, ['tmux', 'session-service']);
  const checks: LayeredDiagnosticCheck[] = [
    healthy('client_app', input.clientVersion, 'Client metadata is readable'),
    input.terminal.wslAvailable
      ? healthy('platform_adapter', process.platform, 'Windows integration is ready')
      : failed('platform_adapter', 'PLATFORM_ADAPTER_UNAVAILABLE', process.platform, 'Windows integration is unavailable'),
    runtimeHealthy
      ? healthy('client_runtime', safeVersion(input.wslRuntime.current || input.wslRuntime.embeddedVersion), 'Verified runtime is active')
      : failed('client_runtime', runtimeCode(input.wslRuntime.status), safeVersion(input.wslRuntime.embeddedVersion), 'Verified runtime needs recovery'),
    fleetHealthy
      ? healthy('tailnet', 'external', 'Private network path is connected')
      : stateCheck('tailnet', fleetFailure, 'TAILNET_UNAVAILABLE', 'external', 'Private network path is unavailable'),
    evidenceCheck('ssh', sshEvidence, 'SSH_UNAVAILABLE', 'external', 'Secure connection is unavailable'),
    evidenceCheck('host_runtime', runtimeEvidence, 'HOST_RUNTIME_UNAVAILABLE', safeVersion(input.wslRuntime.contractPackageVersion), 'Host runtime is unavailable'),
    evidenceCheck('tmux', tmuxEvidence, 'TMUX_UNAVAILABLE', 'external', 'Session service is unavailable'),
    endpointAvailable && hostStatuses.some((status) => status === 'healthy')
      ? healthy('endpoint', 'registry', 'A selected endpoint is reachable')
      : stateCheck('endpoint', hostStatuses.some((status) => status === 'offline'), 'ENDPOINT_UNREACHABLE', 'registry', 'No selected endpoint is reachable'),
    targetAvailable
      ? healthy('execution_target', 'registry', 'Execution target metadata is available')
      : failed('execution_target', 'EXECUTION_TARGET_MISSING', 'registry', 'Execution target metadata is unavailable'),
    providerAvailable
      ? healthy('provider_adapter', 'release-set', 'Provider adapter metadata is available')
      : notRun('provider_adapter', 'PROVIDER_ADAPTER_NOT_OBSERVED', 'release-set', 'No provider session was observed'),
    input.updateConfigured
      ? healthy('update_channel', safeVersion(input.wslRuntime.contractPackageVersion), 'Update policy is configured')
      : notRun('update_channel', 'UPDATE_POLICY_NOT_CONFIGURED', safeVersion(input.wslRuntime.contractPackageVersion), 'Update policy is not configured')
  ];
  const report: LayeredDiagnosticReport = {
    schemaVersion: 2,
    correlationId: input.correlationId ?? `diag-${randomUUID().replaceAll('-', '')}`,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    totalDurationMs: boundedDuration(input.totalDurationMs ?? checks.reduce((total, value) => total + value.durationMs, 0)),
    components: [
      { id: 'windows-app', version: safeVersion(input.clientVersion) },
      { id: 'client-runtime', version: safeVersion(input.wslRuntime.current || input.wslRuntime.embeddedVersion) },
      { id: 'contracts', version: safeVersion(input.wslRuntime.contractPackageVersion) }
    ],
    checks
  };
  assertLayeredDiagnosticReport(report);
  return report;
}

export function assertLayeredDiagnosticReport(input: unknown): asserts input is LayeredDiagnosticReport {
  const root = exact(input, ['schemaVersion', 'correlationId', 'generatedAt', 'totalDurationMs', 'components', 'checks']);
  if (root.schemaVersion !== 2 || typeof root.correlationId !== 'string'
    || !/^diag-[a-f0-9]{32}$/u.test(root.correlationId)
    || typeof root.generatedAt !== 'string' || !Number.isFinite(Date.parse(root.generatedAt))
    || !duration(root.totalDurationMs) || !Array.isArray(root.components) || root.components.length > 32
    || !Array.isArray(root.checks) || root.checks.length < 11 || root.checks.length > 256) invalid();
  root.components.forEach((component) => {
    const value = exact(component, ['id', 'version']);
    if (!token(value.id) || !text(value.version, 128)) invalid();
  });
  const layers = new Set<DiagnosticLayer>();
  root.checks.forEach((item) => {
    const value = exact(item, [
      'id', 'layer', 'label', 'status', 'severity', 'errorCode', 'durationMs',
      'version', 'recoveryAction', 'summary', 'readOnly'
    ]);
    if (!token(value.id) || !DIAGNOSTIC_LAYERS.includes(value.layer as DiagnosticLayer)
      || value.label !== LABELS[value.layer as DiagnosticLayer]
      || !['healthy', 'attention', 'failure', 'not-run'].includes(String(value.status))
      || !['info', 'warning', 'error'].includes(String(value.severity))
      || typeof value.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.errorCode)
      || !duration(value.durationMs) || !text(value.version, 128)
      || value.recoveryAction !== RECOVERY[value.layer as DiagnosticLayer]
      || !text(value.summary, 160) || /[/\\]/u.test(value.summary as string)
      || value.readOnly !== true || layers.has(value.layer as DiagnosticLayer)) invalid();
    layers.add(value.layer as DiagnosticLayer);
  });
  if (DIAGNOSTIC_LAYERS.some((layer) => !layers.has(layer))) invalid();
  rejectPrivateFields(root);
}

function doctorEvidence(doctors: readonly FleetDoctorResult[], ids: readonly string[]): 'healthy' | 'failure' | 'missing' {
  const checks = doctors.flatMap((doctor) => doctor.checks)
    .filter((check) => ids.some((id) => check.id.toLowerCase().includes(id)));
  if (checks.length === 0) return 'missing';
  return checks.some((check) => check.status === 'failure') ? 'failure' : 'healthy';
}

function healthy(layer: DiagnosticLayer, version: string, summary: string): LayeredDiagnosticCheck {
  return diagnostic(layer, 'healthy', 'OK', version, summary);
}
function failed(layer: DiagnosticLayer, code: string, version: string, summary: string): LayeredDiagnosticCheck {
  return diagnostic(layer, 'failure', code, version, summary);
}
function notRun(layer: DiagnosticLayer, code: string, version: string, summary: string): LayeredDiagnosticCheck {
  return diagnostic(layer, 'not-run', code, version, summary);
}
function stateCheck(
  layer: DiagnosticLayer, failure: boolean, code: string, version: string, summary: string
): LayeredDiagnosticCheck {
  return failure ? failed(layer, code, version, summary) : notRun(layer, `${code}_NOT_OBSERVED`, version, summary);
}
function evidenceCheck(
  layer: DiagnosticLayer, evidence: 'healthy' | 'failure' | 'missing',
  code: string, version: string, summary: string
): LayeredDiagnosticCheck {
  return evidence === 'healthy' ? healthy(layer, version, summary.replace('unavailable', 'ready'))
    : evidence === 'failure' ? failed(layer, code, version, summary)
      : notRun(layer, `${code}_NOT_OBSERVED`, version, summary.replace('unavailable', 'not checked'));
}
function diagnostic(
  layer: DiagnosticLayer, status: LayeredDiagnosticCheck['status'], code: string, version: string, summary: string
): LayeredDiagnosticCheck {
  return {
    id: layer.replaceAll('_', '-'), layer, label: LABELS[layer], status,
    severity: status === 'failure' ? 'error' : status === 'healthy' ? 'info' : 'warning',
    errorCode: code, durationMs: 0, version: safeVersion(version),
    recoveryAction: RECOVERY[layer], summary: safeSummary(summary), readOnly: true
  };
}
function runtimeCode(status: WslRuntimeState['status']): string {
  return status === 'missing' ? 'CLIENT_RUNTIME_MISSING'
    : status === 'incompatible' ? 'CLIENT_RUNTIME_INCOMPATIBLE'
      : status === 'busy' ? 'CLIENT_RUNTIME_BUSY' : 'CLIENT_RUNTIME_REPAIR_NEEDED';
}
function safeSummary(value: string): string {
  return value.replace(/[/\\]/gu, '').replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 160);
}
function safeVersion(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 128);
}
function exact(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some((field) => !(field in value))) invalid();
  return value;
}
function token(value: unknown): boolean { return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,63}$/u.test(value); }
function text(value: unknown, maximum: number): boolean {
  return typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}
function duration(value: unknown): boolean { return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 300_000; }
function boundedDuration(value: number): number { return Math.max(0, Math.min(300_000, Math.round(value))); }
function rejectPrivateFields(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(rejectPrivateFields); return; }
  if (!value || typeof value !== 'object') return;
  const forbidden = new Set(['credential', 'invitation', 'message', 'output', 'path', 'prompt', 'response', 'terminal', 'token', 'transcript']);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key.toLowerCase())) invalid();
    rejectPrivateFields(child);
  }
}
function invalid(): never { throw new Error('Invalid Agent Fleet layered diagnostics'); }
