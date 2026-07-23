import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  ACTIVATED_RUNTIME_ROOT,
  activatedRuntimeCommand,
  type RuntimeCompatibilityStatus,
  type WslRuntimeState
} from '../shared/runtime';

const execFileAsync = promisify(execFile);
const COMPONENTS = ['clientRuntime', 'hostRuntime', 'providerAdapters', 'contracts'] as const;

interface RuntimeDescriptor {
  schemaVersion: 1;
  baselineVersion: string;
  sourceRepository: string;
  sourceCommit: string;
  contractPackageVersion: string;
  components: Record<typeof COMPONENTS[number], { sequence: number; version: string }>;
  runtime: {
    file: string;
    sha256: string;
    size: number;
    sbomSha256: string;
    licenseSha256: string;
  };
}

interface RuntimeToolStatus {
  current: string;
  previous: string;
  activationPhase?: string;
  activationFailureCode?: string;
  components?: Record<string, { sequence: number; version: string }>;
  source?: { commit?: string; contractPackageVersion?: string };
}

export interface WslCommandResult { stdout: string; stderr: string }
export interface WslRuntimeManagerOptions {
  resourcesRoot: string;
  distro(): string;
  run?(command: string, args: string[], timeoutMs: number): Promise<WslCommandResult>;
}

export class WslRuntimeManager {
  private state: WslRuntimeState | null = null;
  private readonly run: NonNullable<WslRuntimeManagerOptions['run']>;

  constructor(private readonly options: WslRuntimeManagerOptions) {
    this.run = options.run ?? runCommand;
  }

  getState(): WslRuntimeState {
    return this.state ?? this.initialState('The app-owned WSL runtime has not been checked yet.');
  }

  async inspect(): Promise<WslRuntimeState> {
    try {
      const descriptor = this.descriptor();
      const status = await this.toolStatus();
      this.state = this.stateFromStatus(descriptor, status);
    } catch (error) {
      this.state = this.initialState('The app-owned WSL runtime is not installed.', 'missing', readableError(error));
    }
    return this.state;
  }

  async ensure(): Promise<WslRuntimeState> {
    const descriptor = this.descriptor();
    this.verifyEmbeddedArtifact(descriptor);
    const inspected = await this.inspect();
    if (inspected.status === 'ready') return inspected;
    this.state = this.initialState('Installing the verified app-owned WSL runtime…', 'busy');
    await this.bootstrap('install', descriptor);
    const activated = await this.inspect();
    if (activated.status !== 'ready') {
      throw new Error(activated.error || activated.detail || 'The WSL runtime failed its compatibility check.');
    }
    return activated;
  }

  async repair(): Promise<WslRuntimeState> {
    const descriptor = this.descriptor();
    this.verifyEmbeddedArtifact(descriptor);
    this.state = this.initialState('Repairing the verified app-owned WSL runtime…', 'busy');
    await this.bootstrap('install', descriptor);
    return this.inspect();
  }

  async rollback(): Promise<WslRuntimeState> {
    const descriptor = this.descriptor();
    this.state = this.initialState('Rolling back the app-owned WSL runtime…', 'busy');
    await this.run('wsl.exe', [
      '-d', this.options.distro(), '--cd', '~', '--',
      activatedRuntimeCommand('wtmux-runtime'), 'rollback',
      '--root', ACTIVATED_RUNTIME_ROOT, '--bin-dir', '.local/share/agent-fleet/bin'
    ], 60_000);
    return this.inspect().then((state) => {
      if (state.status === 'incompatible') {
        return { ...state, detail: `Rolled back to ${state.current}; this version is outside the embedded compatibility set.` };
      }
      return state;
    });
  }

  runtimeCommand(command: string): string {
    return activatedRuntimeCommand(command);
  }

  private descriptor(): RuntimeDescriptor {
    const path = join(this.options.resourcesRoot, 'runtime', 'embedded-runtime-v1.json');
    if (!existsSync(path)) throw new Error('The embedded WSL runtime descriptor is missing.');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The embedded WSL runtime descriptor is invalid.');
    const value = raw as Record<string, unknown>;
    exactFields(value, [
      'schemaVersion', 'baselineVersion', 'sourceRepository', 'sourceCommit',
      'contractPackageVersion', 'components', 'runtime'
    ], 'runtime descriptor');
    if (value.schemaVersion !== 1 || !safeVersion(value.baselineVersion) || !commit(value.sourceCommit)
      || !safeVersion(value.contractPackageVersion) || !httpsUrl(value.sourceRepository)) {
      throw new Error('The embedded WSL runtime identity is invalid.');
    }
    const componentValue = object(value.components, 'runtime components');
    exactFields(componentValue, COMPONENTS, 'runtime components');
    const components = Object.fromEntries(COMPONENTS.map((name) => {
      const item = object(componentValue[name], `${name} component`);
      exactFields(item, ['sequence', 'version'], `${name} component`);
      if (!Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1 || !safeVersion(item.version)) {
        throw new Error(`The embedded ${name} identity is invalid.`);
      }
      return [name, { sequence: item.sequence as number, version: item.version as string }];
    })) as RuntimeDescriptor['components'];
    const runtime = object(value.runtime, 'runtime artifact');
    exactFields(runtime, ['file', 'sha256', 'size', 'sbomSha256', 'licenseSha256'], 'runtime artifact');
    if (!safeFile(runtime.file) || !digest(runtime.sha256) || !digest(runtime.sbomSha256)
      || !digest(runtime.licenseSha256) || !Number.isSafeInteger(runtime.size)
      || (runtime.size as number) < 1 || (runtime.size as number) > 32 * 1024 * 1024) {
      throw new Error('The embedded WSL runtime artifact identity is invalid.');
    }
    if (components.contracts.version !== value.contractPackageVersion
      || COMPONENTS.slice(0, 3).some((name) => components[name].version !== value.baselineVersion)) {
      throw new Error('The embedded WSL runtime component versions disagree.');
    }
    return {
      schemaVersion: 1,
      baselineVersion: value.baselineVersion as string,
      sourceRepository: value.sourceRepository as string,
      sourceCommit: value.sourceCommit as string,
      contractPackageVersion: value.contractPackageVersion as string,
      components,
      runtime: runtime as unknown as RuntimeDescriptor['runtime']
    };
  }

  private verifyEmbeddedArtifact(descriptor: RuntimeDescriptor): void {
    const path = join(this.options.resourcesRoot, 'runtime', descriptor.runtime.file);
    if (!existsSync(path) || statSync(path).size !== descriptor.runtime.size) {
      throw new Error('The embedded WSL runtime artifact is missing or has the wrong size.');
    }
    const digestValue = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (digestValue !== descriptor.runtime.sha256) throw new Error('The embedded WSL runtime artifact checksum does not match.');
  }

  private async bootstrap(action: 'install', descriptor: RuntimeDescriptor): Promise<void> {
    const bundle = join(this.options.resourcesRoot, 'runtime', descriptor.runtime.file);
    const shell = [
      'bundle="$(wslpath -a "$1")"',
      'staging="$(mktemp -d)"',
      "trap 'rm -rf -- \"$staging\"' EXIT",
      'tar -xf "$bundle" -C "$staging" scripts/wtmux-runtime',
      'python3 "$staging/scripts/wtmux-runtime" "$2" --bundle "$bundle" --sha256 "$3"',
      `--root ${ACTIVATED_RUNTIME_ROOT} --bin-dir .local/share/agent-fleet/bin`
    ].join(' ');
    await this.run('wsl.exe', [
      '-d', this.options.distro(), '--cd', '~', '--', 'sh', '-lc', shell,
      'agent-fleet-runtime-bootstrap', bundle, action, descriptor.runtime.sha256
    ], 120_000);
  }

  private async toolStatus(): Promise<RuntimeToolStatus> {
    const result = await this.run('wsl.exe', [
      '-d', this.options.distro(), '--cd', '~', '--',
      activatedRuntimeCommand('wtmux-runtime'), 'status', '--verbose',
      '--root', ACTIVATED_RUNTIME_ROOT, '--bin-dir', '.local/share/agent-fleet/bin'
    ], 30_000);
    return JSON.parse(result.stdout) as RuntimeToolStatus;
  }

  private stateFromStatus(descriptor: RuntimeDescriptor, status: RuntimeToolStatus): WslRuntimeState {
    const componentsMatch = COMPONENTS.every((name) =>
      status.components?.[name]?.sequence === descriptor.components[name].sequence
      && status.components?.[name]?.version === descriptor.components[name].version);
    const sourceMatches = status.source?.commit === descriptor.sourceCommit
      && status.source?.contractPackageVersion === descriptor.contractPackageVersion;
    const ready = status.current === descriptor.baselineVersion && componentsMatch && sourceMatches
      && status.activationPhase === 'committed';
    return {
      status: ready ? 'ready' : status.current ? 'incompatible' : 'repair-needed',
      current: status.current || '',
      previous: status.previous || '',
      embeddedVersion: descriptor.baselineVersion,
      contractPackageVersion: descriptor.contractPackageVersion,
      sourceCommit: descriptor.sourceCommit,
      detail: ready
        ? `Runtime ${status.current} is verified and compatible.`
        : status.current
          ? `Runtime ${status.current} does not match the app's signed component set.`
          : 'The verified app-owned WSL runtime needs repair.',
      ...(status.activationFailureCode ? { error: `Activation recovery: ${status.activationFailureCode}` } : {})
    };
  }

  private initialState(
    detail: string,
    status: RuntimeCompatibilityStatus = 'missing',
    error?: string
  ): WslRuntimeState {
    let descriptor: RuntimeDescriptor | null = null;
    try { descriptor = this.descriptor(); } catch { /* represented by the supplied detail */ }
    return {
      status,
      current: '',
      previous: '',
      embeddedVersion: descriptor?.baselineVersion ?? '',
      contractPackageVersion: descriptor?.contractPackageVersion ?? '',
      sourceCommit: descriptor?.sourceCommit ?? '',
      detail,
      ...(error ? { error } : {})
    };
  }
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<WslCommandResult> {
  const result = await execFileAsync(command, args, {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 512 * 1024,
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`The embedded ${label} is invalid.`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`The embedded ${label} fields are invalid.`);
  }
}

function safeVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value);
}
function safeFile(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$/u.test(value);
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
function commit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}
function httpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}
function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
