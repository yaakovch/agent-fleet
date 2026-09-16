import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { connectArguments, parseConnectResult, type FleetConnectResult } from '../shared/fleet-connect';
import {
  ACTIVATED_RUNTIME_ROOT,
  activatedRuntimeCommand,
  type RuntimeCompatibilityStatus,
  type WslRuntimeState
} from '../shared/runtime';
import type {
  FleetReleaseSetAuthorityLike,
  VerifiedReleaseSetAdmission
} from './release-set-authority';
import { readFileSnapshot } from './durable-file';
import {
  WSL_RUNTIME_INSTALLER_LOADER,
  WSL_RUNTIME_INSTALLER_PROGRAM
} from './wsl-runtime-installer';

const execFileAsync = promisify(execFile);
const COMPONENTS = ['clientRuntime', 'hostRuntime', 'providerAdapters', 'contracts'] as const;
const RUNTIME_TRUST_RECEIPT = '.local/share/agent-fleet/wtmux-runtime-trust-v1.json';
type RuntimeOperation = 'inspect' | 'ensure' | 'repair' | 'rollback';
interface RuntimeActivation { id: string }

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
    formatVersion: 2;
    manifestSha256: string;
    sbomSha256: string;
    licenseSha256: string;
  };
  registry: {
    file: string;
    sha256: string;
    size: number;
    records: number;
  };
  trustedReleaseKeys: Array<{ keyId: string; file: string; sha256: string }>;
}

interface RuntimeToolStatus {
  baseline: string;
  current: string;
  previous: string;
  activationPhase?: string;
  activationFailureCode?: string;
  components?: Record<string, { sequence: number; version: string }>;
  source?: { repository?: string; commit?: string; contractPackageVersion?: string };
  trust?: { artifactSha256?: string; manifestSha256?: string };
}

export interface WslCommandResult { stdout: string; stderr: string }
export interface WslRuntimeManagerOptions {
  resourcesRoot: string;
  distro(): string;
  windowsVersion?(): string;
  releaseSetAuthority?: FleetReleaseSetAuthorityLike;
  run?(command: string, args: string[], timeoutMs: number): Promise<WslCommandResult>;
}

export class WslRuntimeManager {
  private state: WslRuntimeState | null = null;
  private stateDistro: string | null = null;
  private readonly run: NonNullable<WslRuntimeManagerOptions['run']>;
  private operationTail: Promise<void> = Promise.resolve();
  private lastOperation: { key: string; promise: Promise<WslRuntimeState> } | null = null;
  private operationGeneration = 0;
  private releaseAdmission: VerifiedReleaseSetAdmission | null = null;
  private embeddedHostRuntimeVersion: string | null = null;

  constructor(private readonly options: WslRuntimeManagerOptions) {
    this.run = options.run ?? runCommand;
  }

  getState(): WslRuntimeState {
    return this.state && this.stateDistro === this.options.distro()
      ? this.state
      : this.initialState('The app-owned WSL runtime has not been checked yet.');
  }

  async inspect(): Promise<WslRuntimeState> {
    return this.serialize('inspect', (generation, distro) => this.inspectOperation(generation, distro));
  }

  async ensure(): Promise<WslRuntimeState> {
    return this.serialize('ensure', async (generation, distro) => {
      const admission = await this.admitReleaseSet();
      const descriptor = this.descriptor();
      this.verifyEmbeddedArtifacts(descriptor);
      let activation: RuntimeActivation | null = null;
      let authorityCommitted = false;
      try {
        const inspected = await this.inspectOperation(generation, distro, admission);
        if (inspected.status !== 'ready') {
          this.assertEmbeddedReleaseSelection(descriptor, admission);
          this.assertAdmissionCurrent(admission);
          this.publish(generation, distro, this.initialState('Installing the verified app-owned WSL runtime…', 'busy'));
          activation = { id: randomUUID().replaceAll('-', '') };
          await this.bootstrap(descriptor, distro, activation.id);
        }
        this.assertAdmissionCurrent(admission);
        activation ??= { id: randomUUID().replaceAll('-', '') };
        this.publish(generation, distro, this.initialState('Checking the verified fleet configuration…', 'busy'));
        await this.installRegistry(descriptor, distro, activation.id);
        const activated = await this.inspectOperation(generation, distro, admission, false);
        if (activated.status !== 'ready') {
          throw new Error(activated.error || activated.detail || 'The WSL runtime failed its compatibility check.');
        }
        if (admission) {
          this.options.releaseSetAuthority?.commitHealthy(admission, activation.id);
          authorityCommitted = true;
        }
        await this.finalizeActivation(activation, distro);
        return activated;
      } catch (error) {
        if (activation && !authorityCommitted) await this.rejectActivation(activation, distro, error);
        throw error;
      }
    });
  }

  async repair(): Promise<WslRuntimeState> {
    return this.serialize('repair', async (generation, distro) => {
      const admission = await this.admitReleaseSet();
      const descriptor = this.descriptor();
      this.verifyEmbeddedArtifacts(descriptor);
      this.assertEmbeddedReleaseSelection(descriptor, admission);
      let activation: RuntimeActivation | null = null;
      let authorityCommitted = false;
      try {
        await this.recoverPendingActivation(distro);
        this.assertAdmissionCurrent(admission);
        this.publish(generation, distro, this.initialState('Repairing the verified app-owned WSL runtime…', 'busy'));
        activation = { id: randomUUID().replaceAll('-', '') };
        await this.bootstrap(descriptor, distro, activation.id);
        this.assertAdmissionCurrent(admission);
        await this.installRegistry(descriptor, distro, activation.id);
        const repaired = await this.inspectOperation(generation, distro, admission, false);
        if (repaired.status !== 'ready') {
          throw new Error(repaired.error || repaired.detail || 'The repaired WSL runtime failed its compatibility check.');
        }
        if (admission) {
          this.options.releaseSetAuthority?.commitHealthy(admission, activation.id);
          authorityCommitted = true;
        }
        await this.finalizeActivation(activation, distro);
        return repaired;
      } catch (error) {
        if (activation && !authorityCommitted) await this.rejectActivation(activation, distro, error);
        throw error;
      }
    });
  }

  async rollback(): Promise<WslRuntimeState> {
    return this.serialize('rollback', async (generation, distro) => {
      const admission = await this.admitReleaseSet();
      const descriptor = this.descriptor();
      this.verifyEmbeddedArtifacts(descriptor);
      this.publish(generation, distro, this.initialState('Rolling back the app-owned WSL runtime…', 'busy'));
      await this.recoverPendingActivation(distro);
      await this.verifyTrustedSlot('previous', distro);
      this.assertAdmissionCurrent(admission);
      const activationId = randomUUID().replaceAll('-', '');
      const activation = { id: activationId };
      let activated = false;
      let authorityCommitted = false;
      try {
        activated = true;
        await this.run('wsl.exe', [
          '-d', distro, '--cd', '~', '--exec',
          'python3', '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'rollback',
          ACTIVATED_RUNTIME_ROOT, RUNTIME_TRUST_RECEIPT, '.local/share/agent-fleet/bin', activationId
        ], 60_000);
        this.assertDistro(distro);
        const state = await this.inspectOperation(generation, distro, admission, false);
        this.assertAdmissionCurrent(admission);
        if (state.status !== 'ready' && state.status !== 'incompatible') {
          throw new Error(state.error || state.detail || 'The rolled-back WSL runtime failed verification.');
        }
        if (state.status === 'ready' && admission) {
          this.options.releaseSetAuthority?.commitHealthy(admission, activation.id);
          authorityCommitted = true;
        }
        await this.finalizeActivation(activation, distro);
        if (state.status === 'incompatible') {
          const incompatible = {
            ...state,
            detail: `Rolled back to ${state.current}; this version is outside the embedded compatibility set.`
          };
          this.publish(generation, distro, incompatible);
          return incompatible;
        }
        return state;
      } catch (error) {
        if (activated && !authorityCommitted) await this.rejectActivation(activation, distro, error);
        throw error;
      }
    });
  }

  runtimeCommand(command: string): string {
    return activatedRuntimeCommand(command);
  }

  async connectHost(request: unknown): Promise<FleetConnectResult> {
    const argumentsList = connectArguments(request);
    await this.ensure();
    const distro = this.options.distro();
    const descriptor = this.descriptor();
    let bundle = '';
    if (argumentsList[0] === 'repair') {
      this.verifyArtifact('host repair runtime', descriptor.runtime);
      bundle = join(this.options.resourcesRoot, 'runtime', descriptor.runtime.file);
      argumentsList.push('--bundle', bundle, '--sha256', descriptor.runtime.sha256);
    }
    const loader = `import os,pathlib,subprocess,sys
args=sys.argv[1:]
if '--bundle' in args:
 i=args.index('--bundle')+1
 if not args[i].startswith('/'): args[i]=subprocess.check_output(['wslpath','-u',args[i]],text=True,timeout=5).strip()
p=pathlib.Path.home()/'.local/share/agent-fleet/wtmux/current/scripts/wtmux-connect'
os.execv(sys.executable,[sys.executable,str(p),*args])`;
    try {
      const result = await this.run('wsl.exe', ['-d', distro, '--cd', '~', '--exec', 'python3', '-c', loader, ...argumentsList], 150_000);
      this.assertDistro(distro);
      return parseConnectResult(result.stdout);
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      if (typeof stderr === 'string' && stderr.length < 8192) {
        try {
          const failure = JSON.parse(stderr) as { schemaVersion?: number; error?: unknown };
          if (failure.schemaVersion === 1 && typeof failure.error === 'string' && failure.error.length <= 256) {
            return { ok: false, message: failure.error };
          }
        } catch { /* Use the bounded generic recovery message. */ }
      }
      return { ok: false, message: 'Host setup could not finish. Check Tailscale SSH access and retry.' };
    }
  }

  expectedHostRuntimeVersion(): string | null {
    if (this.releaseAdmission) return this.releaseAdmission.releaseSet.components.hostRuntime.version;
    if (this.embeddedHostRuntimeVersion) return this.embeddedHostRuntimeVersion;
    try {
      const descriptor = this.descriptor();
      this.verifyArtifact('WSL runtime', descriptor.runtime);
      this.embeddedHostRuntimeVersion = descriptor.components.hostRuntime.version;
      return this.embeddedHostRuntimeVersion;
    } catch {
      return null;
    }
  }

  private async inspectOperation(
    generation: number,
    distro: string,
    admission: VerifiedReleaseSetAdmission | null = this.releaseAdmission,
    recoverPending = true
  ): Promise<WslRuntimeState> {
    try {
      const descriptor = this.descriptor();
      this.verifyArtifact('WSL runtime', descriptor.runtime);
      if (recoverPending) await this.recoverPendingActivation(distro);
      const status = await this.toolStatus(descriptor, distro);
      const state = this.stateFromStatus(descriptor, status, admission);
      this.publish(generation, distro, state);
      return state;
    } catch (error) {
      this.assertDistro(distro);
      const state = this.initialState('The app-owned WSL runtime is not installed.', 'missing', readableError(error));
      this.publish(generation, distro, state);
      return state;
    }
  }

  private descriptor(): RuntimeDescriptor {
    const path = join(this.options.resourcesRoot, 'runtime', 'embedded-runtime-v1.json');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSnapshot(path, 64 * 1024).data.toString('utf8')) as unknown;
    } catch (error) {
      throw new Error('The embedded WSL runtime descriptor is missing or invalid.', { cause: error });
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The embedded WSL runtime descriptor is invalid.');
    const value = raw as Record<string, unknown>;
    exactFields(value, [
      'schemaVersion', 'baselineVersion', 'sourceRepository', 'sourceCommit',
      'contractPackageVersion', 'components', 'runtime', 'registry', 'trustedReleaseKeys'
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
    exactFields(runtime, [
      'file', 'sha256', 'size', 'formatVersion', 'manifestSha256', 'sbomSha256', 'licenseSha256'
    ], 'runtime artifact');
    if (!safeFile(runtime.file) || !digest(runtime.sha256) || runtime.formatVersion !== 2
      || !digest(runtime.manifestSha256) || !digest(runtime.sbomSha256)
      || !digest(runtime.licenseSha256) || !Number.isSafeInteger(runtime.size)
      || (runtime.size as number) < 1 || (runtime.size as number) > 32 * 1024 * 1024) {
      throw new Error('The embedded WSL runtime artifact identity is invalid.');
    }
    const registry = object(value.registry, 'registry artifact');
    exactFields(registry, ['file', 'sha256', 'size', 'records'], 'registry artifact');
    if (!safeFile(registry.file) || !digest(registry.sha256)
      || !Number.isSafeInteger(registry.size) || (registry.size as number) < 1
      || (registry.size as number) > 32 * 1024 * 1024
      || !Number.isSafeInteger(registry.records) || (registry.records as number) < 1
      || (registry.records as number) > 256) {
      throw new Error('The embedded machine registry artifact identity is invalid.');
    }
    if (components.contracts.version !== value.contractPackageVersion
      || COMPONENTS.slice(0, 3).some((name) => components[name].version !== value.baselineVersion)) {
      throw new Error('The embedded WSL runtime component versions disagree.');
    }
    if (!Array.isArray(value.trustedReleaseKeys)
      || value.trustedReleaseKeys.length < 1 || value.trustedReleaseKeys.length > 4) {
      throw new Error('The embedded trusted release keys are invalid.');
    }
    const trustedReleaseKeys = value.trustedReleaseKeys.map((candidate) => {
      const key = object(candidate, 'trusted release key');
      exactFields(key, ['keyId', 'file', 'sha256'], 'trusted release key');
      if (typeof key.keyId !== 'string' || !/^[a-f0-9]{32}$/u.test(key.keyId)
        || key.file !== `trusted-release-key-${key.keyId}.pem` || !digest(key.sha256)) {
        throw new Error('The embedded trusted release key identity is invalid.');
      }
      return key as unknown as RuntimeDescriptor['trustedReleaseKeys'][number];
    });
    if (new Set(trustedReleaseKeys.map((key) => key.keyId)).size !== trustedReleaseKeys.length) {
      throw new Error('The embedded trusted release keys contain duplicates.');
    }
    return {
      schemaVersion: 1,
      baselineVersion: value.baselineVersion as string,
      sourceRepository: value.sourceRepository as string,
      sourceCommit: value.sourceCommit as string,
      contractPackageVersion: value.contractPackageVersion as string,
      components,
      runtime: runtime as unknown as RuntimeDescriptor['runtime'],
      registry: registry as unknown as RuntimeDescriptor['registry'],
      trustedReleaseKeys
    };
  }

  private verifyEmbeddedArtifacts(descriptor: RuntimeDescriptor): void {
    for (const [label, artifact] of [
      ['WSL runtime', descriptor.runtime],
      ['machine registry', descriptor.registry]
    ] as const) {
      this.verifyArtifact(label, artifact);
    }
    this.embeddedHostRuntimeVersion = descriptor.components.hostRuntime.version;
  }

  private verifyArtifact(label: string, artifact: { file: string; sha256: string; size: number }): void {
    const path = join(this.options.resourcesRoot, 'runtime', artifact.file);
    let snapshot;
    try {
      snapshot = readFileSnapshot(path, 32 * 1024 * 1024);
    } catch (error) {
      throw new Error(`The embedded ${label} artifact is missing or unsafe.`, { cause: error });
    }
    if (snapshot.bytes !== artifact.size) {
      throw new Error(`The embedded ${label} artifact is missing or has the wrong size.`);
    }
    if (snapshot.sha256 !== artifact.sha256) {
      throw new Error(`The embedded ${label} artifact checksum does not match.`);
    }
  }

  private async bootstrap(
    descriptor: RuntimeDescriptor,
    distro: string,
    activationId: string
  ): Promise<void> {
    this.assertDistro(distro);
    const bundle = join(this.options.resourcesRoot, 'runtime', descriptor.runtime.file);
    await this.run('wsl.exe', [
      '-d', distro, '--cd', '~', '--exec',
      'python3', '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'install',
      bundle, String(descriptor.runtime.size), descriptor.runtime.sha256,
      descriptor.baselineVersion, descriptor.runtime.manifestSha256,
      ACTIVATED_RUNTIME_ROOT, RUNTIME_TRUST_RECEIPT, '.local/share/agent-fleet/bin',
      '1', activationId
    ], 120_000);
    this.assertDistro(distro);
  }

  private async installRegistry(
    descriptor: RuntimeDescriptor,
    distro: string,
    activationId: string
  ): Promise<void> {
    this.assertDistro(distro);
    const registryBundle = join(this.options.resourcesRoot, 'runtime', descriptor.registry.file);
    await this.run('wsl.exe', [
      '-d', distro, '--cd', '~', '--exec',
      'python3', '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'install-registry',
      registryBundle, String(descriptor.registry.size), descriptor.registry.sha256,
      ACTIVATED_RUNTIME_ROOT, RUNTIME_TRUST_RECEIPT, '.config/wtmux/wtmux.conf',
      String(descriptor.registry.records), activationId
    ], 30_000);
    this.assertDistro(distro);
  }

  private async toolStatus(descriptor: RuntimeDescriptor, distro: string): Promise<RuntimeToolStatus> {
    this.assertDistro(distro);
    const result = await this.run('wsl.exe', [
      '-d', distro, '--cd', '~', '--exec',
      'python3', '-c', RUNTIME_TRUST_LOADER, RUNTIME_TRUST_PROGRAM, 'status',
      ACTIVATED_RUNTIME_ROOT, RUNTIME_TRUST_RECEIPT,
      descriptor.baselineVersion, descriptor.runtime.sha256, descriptor.runtime.manifestSha256
    ], 30_000);
    this.assertDistro(distro);
    return JSON.parse(result.stdout) as RuntimeToolStatus;
  }

  private async verifyTrustedSlot(slot: 'previous', distro: string): Promise<void> {
    this.assertDistro(distro);
    await this.run('wsl.exe', [
      '-d', distro, '--cd', '~', '--exec',
      'python3', '-c', RUNTIME_TRUST_LOADER, RUNTIME_TRUST_PROGRAM, 'verify-slot',
      ACTIVATED_RUNTIME_ROOT, RUNTIME_TRUST_RECEIPT, slot
    ], 30_000);
    this.assertDistro(distro);
  }

  private assertAdmissionCurrent(admission: VerifiedReleaseSetAdmission | null): void {
    if (!admission) return;
    const authority = this.options.releaseSetAuthority;
    if (!authority?.assertCurrent) {
      throw new Error('The release-set authority cannot recheck the active fleet configuration');
    }
    authority.assertCurrent(admission);
  }

  private async recoverPendingActivation(distro: string): Promise<void> {
    this.assertDistro(distro);
    const pendingResult = await this.run('wsl.exe', [
      '-d', distro, '--cd', '~', '--exec',
      'python3', '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'pending',
      ACTIVATED_RUNTIME_ROOT
    ], 30_000);
    this.assertDistro(distro);
    const pending = JSON.parse(pendingResult.stdout) as { activationId?: unknown };
    if (pending.activationId === '') return;
    if (typeof pending.activationId !== 'string' || !/^[a-f0-9]{32}$/u.test(pending.activationId)) {
      throw new Error('The pending WSL runtime activation identity is invalid');
    }
    if (this.options.releaseSetAuthority?.isActivationCommitted?.(pending.activationId)) {
      await this.finalizeActivation({ id: pending.activationId }, distro);
      return;
    }
    const recovered = await this.run('wsl.exe', [
      '-d', distro, '--cd', '~', '--exec',
      'python3', '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'recover',
      ACTIVATED_RUNTIME_ROOT, RUNTIME_TRUST_RECEIPT, '.local/share/agent-fleet/bin', '-'
    ], 60_000);
    this.assertDistro(distro);
    const result = JSON.parse(recovered.stdout) as { status?: unknown };
    if (result.status !== 'recovered' && result.status !== 'clean' && result.status !== 'absent') {
      throw new Error('The pending WSL runtime activation was not safely recovered');
    }
  }

  private async finalizeActivation(activation: RuntimeActivation, distro: string): Promise<void> {
    this.assertDistro(distro);
    const argumentsValue = [
      '-d', distro, '--cd', '~', '--exec',
      'python3', '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'finalize',
      ACTIVATED_RUNTIME_ROOT, activation.id
    ];
    let finalized: WslCommandResult;
    try {
      finalized = await this.run('wsl.exe', argumentsValue, 30_000);
    } catch {
      // Finalization is idempotent. Retry once so a transient WSL launch
      // failure cannot strand an authority-accepted transaction as pending.
      finalized = await this.run('wsl.exe', argumentsValue, 30_000);
    }
    this.assertDistro(distro);
    const result = JSON.parse(finalized.stdout) as { status?: unknown; activationId?: unknown };
    if (result.status !== 'finalized'
      || (result.activationId !== undefined && result.activationId !== activation.id)) {
      throw new Error('The WSL runtime activation was not safely finalized');
    }
  }

  private async rejectActivation(
    activation: RuntimeActivation,
    distro: string,
    originalError: unknown
  ): Promise<void> {
    this.releaseAdmission = null;
    try {
      // Cleanup deliberately targets the captured distro even when the UI
      // selection changed after activation; otherwise the rejected cohort
      // would remain active in the old distribution.
      const compensated = await this.run('wsl.exe', [
        '-d', distro, '--cd', '~', '--exec',
        'python3', '-c', WSL_RUNTIME_INSTALLER_LOADER, WSL_RUNTIME_INSTALLER_PROGRAM, 'abort',
        ACTIVATED_RUNTIME_ROOT, RUNTIME_TRUST_RECEIPT, '.local/share/agent-fleet/bin', activation.id
      ], 60_000);
      const result = JSON.parse(compensated.stdout) as { status?: unknown };
      if (result.status !== 'recovered' && result.status !== 'absent') {
        throw new Error('The rejected WSL runtime activation was not safely compensated');
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [originalError, cleanupError],
        `The release activation failed and its rejected cohort could not be quarantined: ${readableError(cleanupError)}`
      );
    }
  }

  private serialize(
    operation: RuntimeOperation,
    task: (generation: number, distro: string) => Promise<WslRuntimeState>
  ): Promise<WslRuntimeState> {
    const distro = this.options.distro();
    const key = `${operation}\u0000${distro}`;
    if (this.lastOperation?.key === key) return this.lastOperation.promise;

    const generation = ++this.operationGeneration;
    const promise = this.operationTail
      .catch(() => undefined)
      .then(async () => {
        this.assertDistro(distro);
        try {
          return await task(generation, distro);
        } catch (error) {
          if (this.options.distro() === distro && this.stateDistro === distro && this.state?.status === 'busy') {
            this.publish(
              generation,
              distro,
              this.initialState('The app-owned WSL runtime operation failed.', 'repair-needed', readableError(error))
            );
          }
          throw error;
        }
      });
    this.operationTail = promise.then(() => undefined, () => undefined);
    this.lastOperation = { key, promise };
    void promise.then(
      () => this.clearLastOperation(promise),
      () => this.clearLastOperation(promise)
    );
    return promise;
  }

  private clearLastOperation(promise: Promise<WslRuntimeState>): void {
    if (this.lastOperation?.promise === promise) this.lastOperation = null;
  }

  private publish(generation: number, distro: string, state: WslRuntimeState): void {
    if (generation !== this.operationGeneration || this.options.distro() !== distro) return;
    this.state = state;
    this.stateDistro = distro;
  }

  private assertDistro(distro: string): void {
    if (this.options.distro() !== distro) {
      throw new Error('The selected WSL distribution changed while the runtime operation was in progress.');
    }
  }

  private stateFromStatus(
    descriptor: RuntimeDescriptor,
    status: RuntimeToolStatus,
    admission: VerifiedReleaseSetAdmission | null
  ): WslRuntimeState {
    const componentsMatch = COMPONENTS.every((name) =>
      status.components?.[name]?.sequence === descriptor.components[name].sequence
      && status.components?.[name]?.version === descriptor.components[name].version);
    const sourceMatches = status.source?.commit === descriptor.sourceCommit
      && status.source?.contractPackageVersion === descriptor.contractPackageVersion;
    const embeddedReady = status.current === descriptor.baselineVersion
      && status.baseline === descriptor.baselineVersion
      && componentsMatch && sourceMatches
      && status.activationPhase === 'committed'
      && !status.activationFailureCode;
    const coherentHotfix = status.current !== descriptor.baselineVersion
      && status.baseline === descriptor.baselineVersion
      && safeVersion(status.current)
      && status.activationPhase === 'committed'
      && !status.activationFailureCode
      && status.source?.repository === descriptor.sourceRepository
      && commit(status.source?.commit)
      && status.source.contractPackageVersion === descriptor.contractPackageVersion
      && COMPONENTS.slice(0, 3).every((name) => {
        const component = status.components?.[name];
        return component?.version === status.current
          && Number.isSafeInteger(component.sequence) && component.sequence >= 1;
      })
      && status.components?.contracts?.version === descriptor.contractPackageVersion
      && Number.isSafeInteger(status.components.contracts.sequence)
      && status.components.contracts.sequence >= 1;
    const locallyTrusted = embeddedReady || coherentHotfix;
    const selectedComponentsMatch = !admission || COMPONENTS.every((name) =>
      status.components?.[name]?.sequence === admission.releaseSet.components[name].sequence
      && status.components?.[name]?.version === admission.releaseSet.components[name].version);
    const selectedContractMatches = !admission
      || status.source?.contractPackageVersion === admission.releaseSet.contractPackageVersion;
    const selectedArtifactMatches = !admission
      || (status.source?.repository === admission.clientRuntimeArtifact.sourceRepository
        && status.source?.commit === admission.clientRuntimeArtifact.sourceCommit
        && status.trust?.artifactSha256 === admission.clientRuntimeArtifact.sha256);
    const ready = locallyTrusted && selectedComponentsMatch
      && selectedContractMatches && selectedArtifactMatches;
    return {
      status: ready ? 'ready' : status.current ? 'incompatible' : 'repair-needed',
      current: status.current || '',
      previous: status.previous || '',
      embeddedVersion: descriptor.baselineVersion,
      contractPackageVersion: descriptor.contractPackageVersion,
      sourceCommit: descriptor.sourceCommit,
      detail: ready && coherentHotfix
        ? `Runtime ${status.current} is active with recovery baseline ${descriptor.baselineVersion}.`
        : ready
        ? `Runtime ${status.current} is verified and compatible.`
        : status.current
          ? `Runtime ${status.current} does not match the app's signed component set.`
          : 'The verified app-owned WSL runtime needs repair.',
      ...(status.activationFailureCode ? { error: `Activation recovery: ${status.activationFailureCode}` } : {})
    };
  }

  private async admitReleaseSet(): Promise<VerifiedReleaseSetAdmission | null> {
    const authority = this.options.releaseSetAuthority;
    if (!authority) return null;
    this.releaseAdmission = null;
    const windowsVersion = this.options.windowsVersion?.();
    if (!windowsVersion) throw new Error('Windows version is unavailable for release-set admission');
    const admission = await authority.verifyWindowsRelease(windowsVersion);
    this.releaseAdmission = admission;
    return admission;
  }

  private assertEmbeddedReleaseSelection(
    descriptor: RuntimeDescriptor,
    admission: VerifiedReleaseSetAdmission | null
  ): void {
    if (!admission) return;
    if (descriptor.contractPackageVersion !== admission.releaseSet.contractPackageVersion
      || descriptor.runtime.sha256 !== admission.clientRuntimeArtifact.sha256
      || descriptor.sourceRepository !== admission.clientRuntimeArtifact.sourceRepository
      || descriptor.sourceCommit !== admission.clientRuntimeArtifact.sourceCommit
      || COMPONENTS.some((name) =>
        descriptor.components[name].sequence !== admission.releaseSet.components[name].sequence
        || descriptor.components[name].version !== admission.releaseSet.components[name].version)) {
      throw new Error('The embedded WSL runtime is outside the active signed release set');
    }
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

const RUNTIME_TRUST_LOADER =
  "import base64,sys;exec(compile(base64.b64decode(sys.argv.pop(1)), '<agent-fleet-runtime-trust>', 'exec'))";
const RUNTIME_TRUST_PROGRAM = Buffer.from(String.raw`
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import uuid
from pathlib import Path, PurePosixPath

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_FILES = 256
MAX_RECEIPT_BYTES = 64 * 1024
MAX_RECEIPT_RELEASES = 64
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$")
DIGEST_RE = re.compile(r"^[a-f0-9]{64}$")

def fail(message):
    raise RuntimeError(message)

def exact(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields):
        fail(f"{label} fields are invalid")
    return value

def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            fail("runtime trust JSON contains a duplicate field")
        value[key] = item
    return value

def parse_json(payload, label):
    try:
        return json.loads(payload.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{label} is invalid") from error

def safe_version(value, label="runtime version"):
    if not isinstance(value, str) or not VERSION_RE.fullmatch(value):
        fail(f"{label} is invalid")
    return value

def safe_digest(value, label):
    if not isinstance(value, str) or not DIGEST_RE.fullmatch(value):
        fail(f"{label} is invalid")
    return value

def absolute_path(value):
    return Path(os.path.abspath(os.path.expanduser(value)))

def read_regular(path, limit, label, expected_size=None, expected_mode=None):
    descriptor = -1
    try:
        path_before = os.lstat(path)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        before = os.fstat(descriptor)
        identity = (
            before.st_dev, before.st_ino, before.st_size,
            before.st_mtime_ns, before.st_ctime_ns,
        )
        if (
            not stat.S_ISREG(before.st_mode)
            or stat.S_ISLNK(path_before.st_mode)
            or (path_before.st_dev, path_before.st_ino) != (before.st_dev, before.st_ino)
            or before.st_nlink != 1
            or before.st_size > limit
            or (expected_size is not None and before.st_size != expected_size)
            or (expected_mode is not None and stat.S_IMODE(before.st_mode) != expected_mode)
        ):
            fail(f"{label} is missing or unsafe")
        chunks = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                fail(f"{label} changed while it was read")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        if identity != (
            after.st_dev, after.st_ino, after.st_size,
            after.st_mtime_ns, after.st_ctime_ns,
        ):
            fail(f"{label} changed while it was read")
        return b"".join(chunks)
    except OSError as error:
        raise RuntimeError(f"{label} is missing or unsafe") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)

def safe_target(target, label, allow_empty=True):
    if target == "" and allow_empty:
        return ""
    if not isinstance(target, str):
        fail(f"{label} is invalid")
    path = PurePosixPath(target)
    if (
        path.is_absolute() or len(path.parts) != 2 or path.parts[0] != "releases"
        or not VERSION_RE.fullmatch(path.parts[1])
    ):
        fail(f"{label} is invalid")
    return target

def read_link(root, name):
    path = root / name
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return ""
    except OSError as error:
        raise RuntimeError(f"runtime {name} link is unavailable") from error
    if not stat.S_ISLNK(metadata.st_mode):
        fail(f"runtime {name} link is unsafe")
    try:
        return safe_target(os.readlink(path), f"runtime {name} link")
    except OSError as error:
        raise RuntimeError(f"runtime {name} link is unavailable") from error

def parse_manifest(payload, expected_version, expected_digest):
    if hashlib.sha256(payload).hexdigest() != expected_digest:
        fail("installed runtime manifest does not match its trusted receipt")
    manifest = exact(parse_json(payload, "installed runtime manifest"), {
        "formatVersion", "version", "components", "source", "target", "files",
    }, "installed runtime manifest")
    if manifest["formatVersion"] != 2 or manifest["version"] != expected_version:
        fail("installed runtime manifest identity is invalid")
    files = manifest["files"]
    if not isinstance(files, list) or not (1 <= len(files) <= MAX_FILES):
        fail("installed runtime manifest file list is invalid")
    seen = set()
    total = 0
    for item in files:
        exact(item, {"path", "sha256", "size", "mode"}, "installed runtime file")
        relative = item["path"]
        path = PurePosixPath(relative) if isinstance(relative, str) else PurePosixPath(".")
        if (
            not isinstance(relative, str) or not relative or "\\" in relative
            or path.is_absolute() or path.as_posix() != relative
            or any(part in ("", ".", "..") for part in path.parts)
            or relative == "runtime-manifest.json" or relative in seen
        ):
            fail("installed runtime manifest path is unsafe")
        safe_digest(item["sha256"], "installed runtime file checksum")
        if (
            not isinstance(item["size"], int) or isinstance(item["size"], bool)
            or not (0 <= item["size"] <= MAX_FILE_BYTES)
            or not isinstance(item["mode"], int) or isinstance(item["mode"], bool)
            or not (0 <= item["mode"] <= 0o777)
        ):
            fail(f"installed runtime file metadata is invalid: {relative}")
        total += item["size"]
        if total > 32 * 1024 * 1024:
            fail("installed runtime manifest payload is too large")
        seen.add(relative)
    return manifest

def expected_tree(manifest):
    files = {"runtime-manifest.json", *(item["path"] for item in manifest["files"])}
    directories = set()
    for relative in files:
        parent = PurePosixPath(relative).parent
        while parent != PurePosixPath("."):
            directories.add(parent.as_posix())
            parent = parent.parent
    return files, directories

def scan_tree(release, expected_files, expected_directories):
    observed_files = set()
    observed_directories = set()
    observed_identities = {}
    pending = [release]
    while pending:
        directory = pending.pop()
        try:
            entries = list(os.scandir(directory))
        except OSError as error:
            raise RuntimeError("installed runtime tree is unavailable") from error
        for entry in entries:
            relative = Path(entry.path).relative_to(release).as_posix()
            try:
                metadata = entry.stat(follow_symlinks=False)
            except OSError as error:
                raise RuntimeError(f"installed runtime entry is unavailable: {relative}") from error
            observed_identities[relative] = (
                metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_size,
                metadata.st_mtime_ns, metadata.st_ctime_ns,
            )
            if stat.S_ISLNK(metadata.st_mode):
                fail(f"installed runtime tree contains a symlink: {relative}")
            if stat.S_ISDIR(metadata.st_mode):
                if relative not in expected_directories:
                    fail(f"installed runtime tree contains an extra directory: {relative}")
                observed_directories.add(relative)
                pending.append(Path(entry.path))
            elif stat.S_ISREG(metadata.st_mode):
                if relative not in expected_files:
                    fail(f"installed runtime tree contains an extra file: {relative}")
                observed_files.add(relative)
            else:
                fail(f"installed runtime tree contains an unsafe entry: {relative}")
    if observed_files != expected_files or observed_directories != expected_directories:
        fail("installed runtime tree is incomplete")
    return observed_files, observed_directories, observed_identities

def validate_release(root, target, expected_manifest_digest):
    target = safe_target(target, "runtime release", allow_empty=False)
    version = target.removeprefix("releases/")
    release = root / target
    try:
        release_metadata = os.lstat(release)
    except OSError as error:
        raise RuntimeError("installed runtime release is unavailable") from error
    if not stat.S_ISDIR(release_metadata.st_mode) or stat.S_ISLNK(release_metadata.st_mode):
        fail("installed runtime release path is unsafe")
    manifest_payload = read_regular(
        release / "runtime-manifest.json", MAX_FILE_BYTES, "installed runtime manifest",
    )
    manifest = parse_manifest(manifest_payload, version, expected_manifest_digest)
    expected_files, expected_directories = expected_tree(manifest)
    first_tree = scan_tree(release, expected_files, expected_directories)
    for item in manifest["files"]:
        payload = read_regular(
            release / item["path"], MAX_FILE_BYTES, f"installed runtime file {item['path']}",
            expected_size=item["size"], expected_mode=item["mode"],
        )
        if hashlib.sha256(payload).hexdigest() != item["sha256"]:
            fail(f"installed runtime file checksum does not match: {item['path']}")
    if read_regular(
        release / "runtime-manifest.json", MAX_FILE_BYTES, "installed runtime manifest",
    ) != manifest_payload:
        fail("installed runtime manifest changed while it was verified")
    if scan_tree(release, expected_files, expected_directories) != first_tree:
        fail("installed runtime tree changed while it was verified")
    return manifest

def receipt_records(path, allow_missing=False):
    try:
        payload = read_regular(path, MAX_RECEIPT_BYTES, "Windows runtime trust receipt")
    except RuntimeError:
        if allow_missing and not os.path.lexists(path):
            return {}
        raise
    receipt = exact(parse_json(payload, "Windows runtime trust receipt"), {
        "schemaVersion", "releases",
    }, "Windows runtime trust receipt")
    if receipt["schemaVersion"] != 1 or not isinstance(receipt["releases"], list):
        fail("Windows runtime trust receipt is invalid")
    if len(receipt["releases"]) > MAX_RECEIPT_RELEASES:
        fail("Windows runtime trust receipt contains too many releases")
    records = {}
    for item in receipt["releases"]:
        exact(item, {"version", "artifactSha256", "manifestSha256"}, "Windows runtime trust release")
        version = safe_version(item["version"], "Windows runtime trust version")
        safe_digest(item["artifactSha256"], "Windows runtime artifact checksum")
        safe_digest(item["manifestSha256"], "Windows runtime manifest checksum")
        if version in records:
            fail("Windows runtime trust receipt contains a duplicate release")
        records[version] = item
    return records

def write_receipt(path, records):
    releases = [records[version] for version in sorted(records)]
    if len(releases) > MAX_RECEIPT_RELEASES:
        fail("Windows runtime trust receipt contains too many releases")
    payload = (json.dumps({
        "schemaVersion": 1, "releases": releases,
    }, indent=2, sort_keys=True) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}")
    descriptor = -1
    try:
        descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600,
        )
        written = 0
        while written < len(payload):
            count = os.write(descriptor, payload[written:])
            if count <= 0:
                fail("Windows runtime trust receipt could not be written")
            written += count
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass

def runtime_paths(root_value, receipt_value):
    root = absolute_path(root_value)
    receipt = absolute_path(receipt_value)
    if receipt.parent != root.parent or receipt.name != "wtmux-runtime-trust-v1.json":
        fail("Windows runtime trust receipt path is invalid")
    return root, receipt

def runtime_lock(root):
    try:
        metadata = os.lstat(root)
    except OSError as error:
        raise RuntimeError("runtime root is unavailable") from error
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail("runtime root is unsafe")
    try:
        descriptor = os.open(
            root / ".runtime.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600,
        )
    except OSError as error:
        raise RuntimeError("runtime lock is unsafe") from error
    os.fchmod(descriptor, 0o600)
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    return descriptor

def read_journal(root):
    path = root / "activation-journal-v1.json"
    if not os.path.lexists(path):
        return "", ""
    journal = exact(parse_json(
        read_regular(path, MAX_RECEIPT_BYTES, "runtime activation journal"),
        "runtime activation journal",
    ), {
        "schemaVersion", "transactionId", "phase", "fromCurrent", "fromPrevious",
        "candidate", "updatedAt", "failureCode",
    }, "runtime activation journal")
    phase = journal["phase"]
    failure = journal["failureCode"]
    if (
        journal["schemaVersion"] != 1 or not isinstance(phase, str)
        or not isinstance(failure, str) or len(failure) > 64
    ):
        fail("runtime activation journal is invalid")
    return phase, failure

def trusted_record(records, target):
    version = safe_target(target, "runtime release", allow_empty=False).removeprefix("releases/")
    record = records.get(version)
    if record is None:
        fail(f"runtime release has no Windows trust receipt: {version}")
    return record

def command_status(arguments):
    if len(arguments) != 5:
        fail("runtime trust status arguments are invalid")
    root, receipt = runtime_paths(arguments[0], arguments[1])
    expected_baseline = safe_version(arguments[2], "embedded runtime version")
    expected_artifact = safe_digest(arguments[3], "embedded runtime artifact checksum")
    expected_manifest = safe_digest(arguments[4], "embedded runtime manifest checksum")
    if not os.path.lexists(root):
        print(json.dumps({"baseline": "", "current": "", "previous": ""}, sort_keys=True))
        return
    lock = runtime_lock(root)
    try:
        current = read_link(root, "current")
        previous = read_link(root, "previous")
        baseline = read_link(root, "baseline")
        records = receipt_records(receipt) if current or baseline else {}
        manifests = {}
        for target in {current, baseline} - {""}:
            record = trusted_record(records, target)
            manifests[target] = validate_release(root, target, record["manifestSha256"])
        if baseline == f"releases/{expected_baseline}":
            baseline_record = trusted_record(records, baseline)
            if (
                baseline_record["artifactSha256"] != expected_artifact
                or baseline_record["manifestSha256"] != expected_manifest
            ):
                fail("embedded recovery baseline does not match its Windows trust receipt")
        if current and read_link(root, "current") != current:
            fail("runtime current link changed while it was verified")
        if baseline and read_link(root, "baseline") != baseline:
            fail("runtime baseline link changed while it was verified")
        manifest = manifests.get(current)
        phase, failure = read_journal(root)
        record = records.get(current.removeprefix("releases/"), {}) if current else {}
        value = {
            "baseline": baseline.removeprefix("releases/"),
            "current": current.removeprefix("releases/"),
            "previous": previous.removeprefix("releases/"),
            "activationPhase": phase,
            "activationFailureCode": failure,
            "components": manifest.get("components", {}) if manifest else {},
            "source": manifest.get("source", {}) if manifest else {},
            "trust": {
                "artifactSha256": record.get("artifactSha256", ""),
                "manifestSha256": record.get("manifestSha256", ""),
            } if record else {},
        }
        print(json.dumps(value, sort_keys=True))
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)

def command_record(arguments):
    if len(arguments) != 5:
        fail("runtime trust record arguments are invalid")
    root, receipt = runtime_paths(arguments[0], arguments[1])
    version = safe_version(arguments[2])
    artifact_digest = safe_digest(arguments[3], "runtime artifact checksum")
    manifest_digest = safe_digest(arguments[4], "runtime manifest checksum")
    lock = runtime_lock(root)
    try:
        target = read_link(root, "current")
        if target != f"releases/{version}":
            fail("installed runtime does not match the trusted artifact version")
        validate_release(root, target, manifest_digest)
        try:
            records = receipt_records(receipt, allow_missing=True)
        except RuntimeError:
            records = {}
        retained = {}
        for release_version, record in records.items():
            path = root / "releases" / release_version
            try:
                metadata = os.lstat(path)
            except OSError:
                continue
            if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
                retained[release_version] = record
        retained[version] = {
            "version": version,
            "artifactSha256": artifact_digest,
            "manifestSha256": manifest_digest,
        }
        write_receipt(receipt, retained)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)

def command_verify_slot(arguments):
    if len(arguments) != 3:
        fail("runtime trust slot arguments are invalid")
    root, receipt = runtime_paths(arguments[0], arguments[1])
    slot = arguments[2]
    if slot not in {"previous"}:
        fail("runtime trust slot is invalid")
    lock = runtime_lock(root)
    try:
        target = read_link(root, slot)
        if not target:
            fail(f"runtime {slot} release is unavailable")
        records = receipt_records(receipt)
        record = trusted_record(records, target)
        validate_release(root, target, record["manifestSha256"])
        if read_link(root, slot) != target:
            fail(f"runtime {slot} link changed while it was verified")
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)

def main():
    if len(sys.argv) < 2:
        fail("runtime trust command is missing")
    command = sys.argv[1]
    actions = {
        "status": command_status,
        "record": command_record,
        "verify-slot": command_verify_slot,
    }
    action = actions.get(command)
    if action is None:
        fail("runtime trust command is invalid")
    action(sys.argv[2:])

try:
    main()
except (OSError, RuntimeError, ValueError) as error:
    print(f"agent-fleet-runtime-trust: {error}", file=sys.stderr)
    raise SystemExit(2)
`, 'utf8').toString('base64');

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
