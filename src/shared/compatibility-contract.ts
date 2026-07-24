import type { FleetDoctorResult } from './fleet-protocol';
import { GENERATED_CONTRACT_PACKAGE_VERSION, GENERATED_PROTOCOL_VERSIONS } from './generated/agent-fleet-contracts';

export const CONTRACT_PACKAGE_VERSION = GENERATED_CONTRACT_PACKAGE_VERSION;
export const SUPPORTED_CONTROL_VERSIONS = [GENERATED_PROTOCOL_VERSIONS.control] as const;
export const SUPPORTED_CONVERSATION_VERSIONS = [GENERATED_PROTOCOL_VERSIONS.conversation] as const;
export const SUPPORTED_WORKSPACE_LAYOUT_VERSIONS = [GENERATED_PROTOCOL_VERSIONS['workspace-layout']] as const;
export const CONTRACT_CAPABILITIES = [
  'control.v1',
  'conversation.v2',
  'workspace-layout.v1',
  'host-runtime.v1',
  'diagnostics.v2'
] as const;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const PRIVATE_FIELDS = new Set(['message', 'prompt', 'output', 'transcript', 'panetitle', 'command']);

export type CompatibilityComponentId = 'wtmux' | 'windowsApp' | 'androidApp';

export interface CompatibilityComponent {
  sourceVersion: string;
  controlVersions: number[];
  conversationVersions: number[];
  workspaceLayoutVersions: number[];
}

export interface CompatibilityMatrix {
  schemaVersion: 1;
  contractPackageVersion: string;
  components: Record<CompatibilityComponentId, CompatibilityComponent>;
}

export interface ContractDiagnosticComponent {
  id: string;
  version: string;
  contractPackageVersion: string;
  controlVersions: number[];
  conversationVersions: number[];
  workspaceLayoutVersions: number[];
  capabilities: string[];
}

export interface ContractDiagnosticCheck {
  id: string;
  layer: 'client_app' | 'platform_adapter' | 'client_runtime' | 'tailnet' | 'ssh' | 'host_runtime'
    | 'tmux' | 'endpoint' | 'execution_target' | 'provider_adapter' | 'update_channel';
  status: 'healthy' | 'attention' | 'failure' | 'not-run';
  severity: 'info' | 'warning' | 'error';
  errorCode: string;
  durationMs: number;
  recoveryAction: 'none' | 'automatic' | 'after_refresh' | 'after_recovery' | 'user_action'
    | 'terminal_fallback' | 'no_retry' | 'rollback';
}

export interface ContractDiagnosticReport {
  schemaVersion: 1;
  generatedAt: string;
  components: ContractDiagnosticComponent[];
  checks: ContractDiagnosticCheck[];
}

export function parseCompatibilityMatrixJson(input: string): CompatibilityMatrix {
  if (new TextEncoder().encode(input).byteLength > MAX_DOCUMENT_BYTES) fail('matrix exceeds its size limit');
  let parsed: unknown;
  try { parsed = JSON.parse(input) as unknown; } catch { fail('matrix is not valid JSON'); }
  const root = exact(parsed, ['schemaVersion', 'contractPackageVersion', 'components'], 'matrix');
  if (root.schemaVersion !== 1 || !token(root.contractPackageVersion)) fail('matrix identity is invalid');
  const components = exact(root.components, ['wtmux', 'windowsApp', 'androidApp'], 'components');
  const result = {} as Record<CompatibilityComponentId, CompatibilityComponent>;
  for (const id of ['wtmux', 'windowsApp', 'androidApp'] as const) result[id] = parseComponent(components[id]);
  rejectPrivateFields(root);
  return { schemaVersion: 1, contractPackageVersion: root.contractPackageVersion as string, components: result };
}

export function componentSupportsCurrentContracts(component: CompatibilityComponent): boolean {
  return SUPPORTED_CONTROL_VERSIONS.every((value) => component.controlVersions.includes(value))
    && SUPPORTED_CONVERSATION_VERSIONS.every((value) => component.conversationVersions.includes(value))
    && SUPPORTED_WORKSPACE_LAYOUT_VERSIONS.every((value) => component.workspaceLayoutVersions.includes(value));
}

export function createContractDiagnosticReport(
  componentId: 'windows-app' | 'android-app',
  version: string,
  doctors: readonly FleetDoctorResult[],
  generatedAt = new Date().toISOString()
): ContractDiagnosticReport {
  const compatibility = doctors.flatMap((doctor) => doctor.checks.filter((check) => check.id === 'compatibility'));
  const failed = compatibility.some((check) => check.status === 'failure');
  const attention = compatibility.some((check) => check.status === 'attention');
  const complete = doctors.length > 0 && compatibility.length === doctors.length;
  const status = failed ? 'failure' : attention ? 'attention' : complete ? 'healthy' : 'not-run';
  return {
    schemaVersion: 1,
    generatedAt,
    components: [{
      id: componentId,
      version,
      contractPackageVersion: CONTRACT_PACKAGE_VERSION,
      controlVersions: [...SUPPORTED_CONTROL_VERSIONS],
      conversationVersions: [...SUPPORTED_CONVERSATION_VERSIONS],
      workspaceLayoutVersions: [...SUPPORTED_WORKSPACE_LAYOUT_VERSIONS],
      capabilities: [...CONTRACT_CAPABILITIES]
    }],
    checks: [{
      id: 'runtime-compatibility',
      layer: 'host_runtime',
      status,
      severity: status === 'failure' ? 'error' : status === 'attention' ? 'warning' : 'info',
      errorCode: status === 'failure' ? 'HOST_RUNTIME_INCOMPATIBLE' : 'OK',
      durationMs: 0,
      recoveryAction: status === 'failure' ? 'rollback' : status === 'attention' ? 'after_recovery' : 'none'
    }]
  };
}

export function assertContractDiagnosticReport(input: unknown): asserts input is ContractDiagnosticReport {
  const root = exact(input, ['schemaVersion', 'generatedAt', 'components', 'checks'], 'diagnostics');
  if (root.schemaVersion !== 1 || !instant(root.generatedAt)) fail('diagnostics identity is invalid');
  if (!Array.isArray(root.components) || root.components.length > 32) fail('diagnostic components are invalid');
  if (!Array.isArray(root.checks) || root.checks.length > 256) fail('diagnostic checks are invalid');
  root.components.forEach(parseDiagnosticComponent);
  root.checks.forEach(parseDiagnosticCheck);
  rejectPrivateFields(root);
}

function parseComponent(input: unknown): CompatibilityComponent {
  const value = exact(input, ['sourceVersion', 'controlVersions', 'conversationVersions', 'workspaceLayoutVersions'], 'component');
  if (!token(value.sourceVersion)) fail('component version is invalid');
  return {
    sourceVersion: value.sourceVersion as string,
    controlVersions: versions(value.controlVersions),
    conversationVersions: versions(value.conversationVersions),
    workspaceLayoutVersions: versions(value.workspaceLayoutVersions)
  };
}

function parseDiagnosticComponent(input: unknown): void {
  const value = exact(input, ['id', 'version', 'contractPackageVersion', 'controlVersions', 'conversationVersions', 'workspaceLayoutVersions', 'capabilities'], 'diagnostic component');
  if (!lowerToken(value.id) || !safeText(value.version, 128) || !safeText(value.contractPackageVersion, 128)) fail('diagnostic component identity is invalid');
  versions(value.controlVersions); versions(value.conversationVersions); versions(value.workspaceLayoutVersions);
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 64 || new Set(value.capabilities).size !== value.capabilities.length
    || value.capabilities.some((item) => !lowerToken(item))) fail('diagnostic capabilities are invalid');
}

function parseDiagnosticCheck(input: unknown): void {
  const value = exact(input, ['id', 'layer', 'status', 'severity', 'errorCode', 'durationMs', 'recoveryAction'], 'diagnostic check');
  if (!lowerToken(value.id)
    || !member(value.layer, ['client_app', 'platform_adapter', 'client_runtime', 'tailnet', 'ssh', 'host_runtime', 'tmux', 'endpoint', 'execution_target', 'provider_adapter', 'update_channel'])
    || !member(value.status, ['healthy', 'attention', 'failure', 'not-run'])
    || !member(value.severity, ['info', 'warning', 'error'])
    || typeof value.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.errorCode)
    || !Number.isInteger(value.durationMs) || (value.durationMs as number) < 0 || (value.durationMs as number) > 300_000
    || !member(value.recoveryAction, ['none', 'automatic', 'after_refresh', 'after_recovery', 'user_action', 'terminal_fallback', 'no_retry', 'rollback'])) fail('diagnostic check is invalid');
}

function versions(input: unknown): number[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8 || new Set(input).size !== input.length
    || input.some((item) => !Number.isInteger(item) || item < 1 || item > 1024)) fail('protocol versions are invalid');
  return [...input] as number[];
}

function exact(input: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${label} is not an object`);
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some((field) => !(field in value))) fail(`${label} fields are invalid`);
  return value;
}
function token(input: unknown): input is string { return typeof input === 'string' && TOKEN.test(input); }
function lowerToken(input: unknown): input is string { return typeof input === 'string' && /^[a-z][a-z0-9._-]{0,63}$/u.test(input); }
function safeText(input: unknown, maximum: number): input is string { return typeof input === 'string' && input.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(input); }
function instant(input: unknown): boolean { return typeof input === 'string' && input.length > 0 && input.length <= 40 && Number.isFinite(Date.parse(input)); }
function member(input: unknown, values: readonly string[]): boolean { return typeof input === 'string' && values.includes(input); }
function rejectPrivateFields(input: unknown): void {
  if (Array.isArray(input)) { input.forEach(rejectPrivateFields); return; }
  if (!input || typeof input !== 'object') return;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (PRIVATE_FIELDS.has(key.toLowerCase())) fail(`private field is forbidden: ${key}`);
    rejectPrivateFields(value);
  }
}
function fail(message: string): never { throw new Error(`Invalid Agent Fleet compatibility contract: ${message}`); }
