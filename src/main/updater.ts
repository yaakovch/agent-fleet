import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod, link, lstat, mkdir, open, readdir, rename, rm,
  type FileHandle
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { UpdaterState } from '../shared/app';
import type {
  FleetReleaseSetAuthorityLike,
  VerifiedReleaseSetAdmission
} from './release-set-authority';
import { signedReleaseSetPayload } from './release-set-verifier';

const STARTUP_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30 * 60 * 1000;
const OWNED_VERIFIED_UPDATE_NAME = /^windows-[a-f0-9]{64}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.exe$/u;

export interface UpdateClient {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  on(event: 'checking-for-update', listener: () => void): this;
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfo) => void): this;
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate?(cancellationToken?: UpdateCancellationToken): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface UpdaterManagerOptions {
  currentVersion: string;
  eligible: boolean;
  prerelease: boolean;
  client?: UpdateClient;
  logger?: unknown;
  operationTimeoutMs?: number;
  releaseSetAuthority?: FleetReleaseSetAuthorityLike;
  verifiedUpdateRoot?: string;
}

interface UpdateCancellationToken {
  cancel(): void;
  dispose?(): void;
}

interface ActiveUpdateOperation {
  generation: number;
  abort: AbortController;
  cancellationToken: UpdateCancellationToken | null;
}

interface VerifiedFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

interface PreparedAdmittedDownload {
  version: string;
  installerPath: string;
  installerIdentity: VerifiedFileIdentity;
  snapshotPath: string;
  snapshotIdentity: VerifiedFileIdentity;
  configurationDigest: string;
  releasePayloadSha256: string;
  windowsArtifact: Readonly<VerifiedReleaseSetAdmission['windowsArtifact']>;
}

export class UpdaterManager extends EventEmitter {
  private readonly client: UpdateClient;
  private readonly eligible: boolean;
  private readonly currentVersion: string;
  private readonly operationTimeoutMs: number;
  private readonly releaseSetAuthority: FleetReleaseSetAuthorityLike | null;
  private readonly verifiedUpdateRoot: string | null;
  private readonly verifiedUpdateReady: Promise<void>;
  private enabled = false;
  private configured = false;
  private startupTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private state: UpdaterState;
  private lifecycleGeneration = 0;
  private activeCheckGeneration: number | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly checksByGeneration = new Map<number, Promise<UpdaterState>>();
  private activeOperation: ActiveUpdateOperation | null = null;
  private installRequested = false;
  private preparedDownload: PreparedAdmittedDownload | null = null;
  private legacyDownloadedVersion: string | null = null;

  constructor(options: UpdaterManagerOptions) {
    super();
    this.client = options.client ?? (electronUpdater.autoUpdater as unknown as UpdateClient);
    this.eligible = options.eligible;
    this.currentVersion = options.currentVersion;
    this.operationTimeoutMs = boundedOperationTimeout(options.operationTimeoutMs);
    this.releaseSetAuthority = options.releaseSetAuthority ?? null;
    this.verifiedUpdateRoot = options.verifiedUpdateRoot ?? null;
    if (this.releaseSetAuthority && !this.verifiedUpdateRoot) {
      throw new Error('Verified update staging root is required for release-set admission');
    }
    this.verifiedUpdateReady = this.verifiedUpdateRoot
      ? sweepOwnedVerifiedUpdates(this.verifiedUpdateRoot)
      : Promise.resolve();
    // Keep construction synchronous without allowing a failed startup sweep
    // to become an unhandled rejection. The admitted check still awaits the
    // original promise and fails closed before it downloads or stages bytes.
    void this.verifiedUpdateReady.catch(() => undefined);
    this.state = {
      status: options.eligible ? 'idle' : 'disabled',
      currentVersion: options.currentVersion,
      message: options.eligible ? undefined : 'Automatic updates are available in the installed app'
    };
    // A configured release authority must review the candidate cohort before
    // any bytes are downloaded. Legacy installations without the authority
    // retain electron-updater's existing automatic path.
    this.client.autoDownload = !this.releaseSetAuthority;
    // electron-updater registers its quit hook before this class can finish
    // validating the downloaded file against the signed release set. Keep
    // implicit installation disabled for the admitted path; an explicit
    // restart remains gated by a protected snapshot and fresh admission.
    this.client.autoInstallOnAppQuit = !this.releaseSetAuthority;
    this.client.allowPrerelease = options.prerelease;
    this.client.logger = options.logger ?? null;
    this.attachEvents();
  }

  getState(): UpdaterState {
    return { ...this.state };
  }

  setEnabled(enabled: boolean): void {
    const nextEnabled = enabled && this.eligible;
    if (!nextEnabled) this.discardPreparedDownload();
    if (this.configured && this.enabled === nextEnabled) return;
    this.configured = true;
    this.cancelActiveOperation();
    const generation = ++this.lifecycleGeneration;
    this.enabled = nextEnabled;
    this.clearTimers();
    this.installRequested = false;
    if (!this.enabled) {
      this.setState({
        status: this.eligible ? 'disabled' : 'disabled',
        currentVersion: this.currentVersion,
        message: this.eligible ? 'Automatic update checks are disabled' : 'Automatic updates are available in the installed app'
      });
      return;
    }
    this.setState({ status: 'idle', currentVersion: this.currentVersion });
    this.startupTimer = setTimeout(() => {
      if (this.enabled && generation === this.lifecycleGeneration) void this.checkNow();
    }, STARTUP_DELAY_MS);
    this.startupTimer.unref();
    this.intervalTimer = setInterval(() => {
      if (this.enabled && generation === this.lifecycleGeneration) void this.checkNow();
    }, CHECK_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  stop(): void {
    this.cancelActiveOperation();
    this.discardPreparedDownload();
    this.lifecycleGeneration += 1;
    this.enabled = false;
    this.configured = false;
    this.installRequested = false;
    this.clearTimers();
  }

  checkNow(): Promise<UpdaterState> {
    if (!this.eligible) return Promise.resolve(this.getState());
    const generation = this.lifecycleGeneration;
    const existing = this.checksByGeneration.get(generation);
    if (existing) return existing;

    const operation = this.operationTail
      .catch(() => undefined)
      .then(() => this.runCheck(generation));
    this.operationTail = operation.then(() => undefined, () => undefined);
    this.checksByGeneration.set(generation, operation);
    this.installRequested = false;
    this.setState({ status: 'checking', currentVersion: this.currentVersion });
    void operation.then(
      () => this.clearCheck(generation, operation),
      () => this.clearCheck(generation, operation)
    );
    return operation;
  }

  private async runCheck(generation: number): Promise<UpdaterState> {
    if (generation !== this.lifecycleGeneration) return this.getState();
    const previousDownload = this.preparedDownload;
    this.preparedDownload = null;
    this.legacyDownloadedVersion = null;
    if (previousDownload) {
      await rm(previousDownload.snapshotPath, { force: true }).catch(() => undefined);
    }
    if (generation !== this.lifecycleGeneration) return this.getState();
    const operation: ActiveUpdateOperation = {
      generation,
      abort: new AbortController(),
      cancellationToken: null
    };
    this.activeOperation = operation;
    this.activeCheckGeneration = generation;
    let deadline: NodeJS.Timeout | null = null;
    const interrupted = new Promise<never>((_resolve, reject) => {
      const rejectInterrupted = (): void => {
        const reason = operation.abort.signal.reason;
        reject(reason instanceof Error ? reason : new UpdateOperationCanceledError());
      };
      operation.abort.signal.addEventListener('abort', rejectInterrupted, { once: true });
      deadline = setTimeout(() => {
        cancelUpdateToken(operation.cancellationToken);
        operation.abort.abort(new UpdateOperationTimeoutError());
      }, this.operationTimeoutMs);
      deadline.unref();
    });
    const check = Promise.resolve().then(() => this.client.checkForUpdates());
    void check.then(
      (result) => {
        const token = updateCancellationToken(result);
        if (operation.abort.signal.aborted) {
          cancelUpdateToken(token);
          disposeUpdateToken(token);
        }
        const download = updateDownloadPromise(result);
        if (download) void download.catch(() => undefined);
      },
      () => undefined
    );
    try {
      const result = await Promise.race([check, interrupted]);
      operation.cancellationToken = updateCancellationToken(result);
      if (operation.abort.signal.aborted) {
        cancelUpdateToken(operation.cancellationToken);
        throw operation.abort.signal.reason;
      }
      if (this.releaseSetAuthority) {
        await this.runAdmittedDownload(result, operation, interrupted);
      } else {
        const download = updateDownloadPromise(result);
        if (download) await Promise.race([download, interrupted]);
      }
    } catch (error) {
      this.setCurrentCheckState(generation, {
        status: 'error',
        currentVersion: this.currentVersion,
        message: formatUpdateError(error)
      });
    } finally {
      if (deadline) clearTimeout(deadline);
      disposeUpdateToken(operation.cancellationToken);
      if (this.activeOperation === operation) this.activeOperation = null;
      if (this.activeCheckGeneration === generation) this.activeCheckGeneration = null;
    }
    return this.getState();
  }

  private async runAdmittedDownload(
    result: unknown,
    operation: ActiveUpdateOperation,
    interrupted: Promise<never>
  ): Promise<void> {
    await Promise.race([this.verifiedUpdateReady, interrupted]);
    const updateInfo = updateInfoFromResult(result);
    if (!updateInfo) return;
    const admission = await Promise.race([
      this.releaseSetAuthority!.verifyWindowsRelease(updateInfo.version),
      interrupted
    ]);
    if (admission) assertUpdateInfoMatchesAdmission(updateInfo, admission);

    const automatic = updateDownloadPromise(result);
    const download = automatic ?? this.client.downloadUpdate?.(operation.cancellationToken ?? undefined);
    if (!download) throw new Error('The update client cannot perform an admitted download');
    const paths = await Promise.race([download, interrupted]);
    const prepared = admission
      ? await stageDownloadedReleaseArtifact(paths, admission, this.verifiedUpdateRoot!)
      : null;
    if (operation.abort.signal.aborted) {
      if (prepared) await rm(prepared.snapshotPath, { force: true }).catch(() => undefined);
      throw operation.abort.signal.reason;
    }
    if (prepared) {
      this.preparedDownload = prepared;
      this.legacyDownloadedVersion = null;
    } else {
      this.preparedDownload = null;
      this.legacyDownloadedVersion = updateInfo.version;
    }
    this.publishVerifiedDownload(updateInfo);
  }

  async restartToUpdate(): Promise<void> {
    if (this.state.status !== 'downloaded' || this.installRequested) return;
    this.installRequested = true;
    let attemptedPrepared: PreparedAdmittedDownload | null = null;
    try {
      if (this.releaseSetAuthority) {
        const version = this.state.availableVersion;
        if (!version) throw new Error('Downloaded update admission is unavailable');
        const prepared = this.preparedDownload;
        const currentAdmission = await this.releaseSetAuthority.verifyWindowsRelease(version);
        if (prepared) {
          attemptedPrepared = prepared;
          if (prepared.version !== version || this.preparedDownload !== prepared
            || this.state.status !== 'downloaded') {
            throw new Error('Downloaded update changed while installation was being prepared');
          }
          assertSameAdmission(prepared, currentAdmission);
          await bindAndInstallPreparedDownload(prepared, this.client, () => {
            if (this.preparedDownload !== prepared || this.state.status !== 'downloaded'
              || this.state.availableVersion !== prepared.version) {
              throw new Error('Downloaded update changed while installation was being prepared');
            }
            assertSameAdmission(prepared, currentAdmission);
            assertCurrentAdmission(this.releaseSetAuthority!, currentAdmission);
          });
          if (this.preparedDownload === prepared) this.preparedDownload = null;
          return;
        }
        if (this.legacyDownloadedVersion !== version || currentAdmission !== null) {
          throw new UpdateAdmissionChangedError();
        }
      }
      this.client.quitAndInstall(false, true);
    } catch (error) {
      if (attemptedPrepared) {
        if (this.preparedDownload === attemptedPrepared) this.preparedDownload = null;
        await rm(attemptedPrepared.snapshotPath, { force: true }).catch(() => undefined);
      }
      this.installRequested = false;
      this.setState({
        status: 'error',
        currentVersion: this.currentVersion,
        message: formatUpdateError(error)
      });
    }
  }

  private attachEvents(): void {
    this.client.on('checking-for-update', () => this.setClientEventState({
      status: 'checking',
      currentVersion: this.currentVersion
    }));
    this.client.on('update-available', (info) =>
      this.setClientEventState({ status: 'available', currentVersion: this.currentVersion, availableVersion: info.version })
    );
    this.client.on('update-not-available', () =>
      this.setClientEventState({
        status: 'up-to-date',
        currentVersion: this.currentVersion,
        message: 'AI Limits Widget is up to date'
      })
    );
    this.client.on('download-progress', (progress) =>
      this.setClientEventState({
        status: 'downloading',
        currentVersion: this.currentVersion,
        availableVersion: this.state.availableVersion,
        progressPercent: Math.max(0, Math.min(100, progress.percent))
      })
    );
    this.client.on('update-downloaded', (info) => {
      const admittedVersion = this.preparedDownload?.version ?? this.legacyDownloadedVersion;
      if (this.releaseSetAuthority && admittedVersion !== info.version) {
        return;
      }
      this.publishVerifiedDownload(info);
    });
    this.client.on('error', (error) =>
      this.setClientEventState({
        status: 'error',
        currentVersion: this.currentVersion,
        message: formatUpdateError(error)
      })
    );
  }

  private setClientEventState(state: UpdaterState): void {
    const generation = this.activeCheckGeneration;
    if (generation === null) return;
    this.setCurrentCheckState(generation, state);
  }

  private publishVerifiedDownload(info: UpdateInfo): void {
    this.setClientEventState({
      status: 'downloaded',
      currentVersion: this.currentVersion,
      availableVersion: info.version,
      progressPercent: 100,
      message: 'Update downloaded. Restart when convenient.'
    });
  }

  private setCurrentCheckState(generation: number, state: UpdaterState): void {
    if (generation === this.lifecycleGeneration && this.activeCheckGeneration === generation) this.setState(state);
  }

  private clearCheck(generation: number, operation: Promise<UpdaterState>): void {
    if (this.checksByGeneration.get(generation) === operation) this.checksByGeneration.delete(generation);
  }

  private setState(state: UpdaterState): void {
    this.state = state;
    this.emit('changed', this.getState());
  }

  private clearTimers(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
  }

  private cancelActiveOperation(): void {
    const operation = this.activeOperation;
    if (!operation || operation.abort.signal.aborted) return;
    cancelUpdateToken(operation.cancellationToken);
    operation.abort.abort(new UpdateOperationCanceledError());
  }

  private discardPreparedDownload(): void {
    const prepared = this.preparedDownload;
    this.preparedDownload = null;
    this.legacyDownloadedVersion = null;
    if (prepared) void rm(prepared.snapshotPath, { force: true }).catch(() => undefined);
  }
}

class UpdateOperationCanceledError extends Error {
  constructor() {
    super('Update operation canceled');
  }
}

class UpdateOperationTimeoutError extends Error {
  constructor() {
    super('Update operation timed out');
  }
}

class UpdateAdmissionChangedError extends Error {
  constructor() {
    super('Downloaded update is no longer admitted by current policy');
  }
}

function formatUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b404\b/.test(message)) return 'No published update feed is available yet.';
  const firstLine = message.split(/\r?\n/, 1)[0].trim();
  return firstLine.slice(0, 240) || 'Update check failed';
}

function updateDownloadPromise(value: unknown): Promise<unknown> | null {
  if (!value || typeof value !== 'object' || !('downloadPromise' in value)) return null;
  const download = (value as { downloadPromise?: unknown }).downloadPromise;
  return download && typeof (download as PromiseLike<unknown>).then === 'function'
    ? Promise.resolve(download)
    : null;
}

function updateCancellationToken(value: unknown): UpdateCancellationToken | null {
  if (!value || typeof value !== 'object' || !('cancellationToken' in value)) return null;
  const token = (value as { cancellationToken?: unknown }).cancellationToken;
  return token && typeof (token as UpdateCancellationToken).cancel === 'function'
    ? token as UpdateCancellationToken
    : null;
}

function cancelUpdateToken(token: UpdateCancellationToken | null): void {
  try {
    token?.cancel();
  } catch {
    // The local deadline still invalidates the generation.
  }
}

function disposeUpdateToken(token: UpdateCancellationToken | null): void {
  try {
    token?.dispose?.();
  } catch {
    // A broken cleanup hook must not wedge future update checks.
  }
}

function boundedOperationTimeout(value: number | undefined): number {
  const selected = value ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(selected) || selected < 10 || selected > 24 * 60 * 60 * 1000) {
    throw new Error('Update operation timeout is invalid');
  }
  return selected;
}

function updateInfoFromResult(value: unknown): UpdateInfo | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as { isUpdateAvailable?: unknown; updateInfo?: unknown };
  if (result.isUpdateAvailable !== true || !result.updateInfo || typeof result.updateInfo !== 'object') return null;
  const info = result.updateInfo as Partial<UpdateInfo>;
  if (typeof info.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(info.version)
    || !Array.isArray(info.files)) {
    throw new Error('Update metadata is invalid');
  }
  return info as UpdateInfo;
}

function assertUpdateInfoMatchesAdmission(
  updateInfo: UpdateInfo,
  admission: VerifiedReleaseSetAdmission
): void {
  const artifact = admission.windowsArtifact;
  if (updateInfo.version !== artifact.version) throw new Error('Update version does not match the signed release set');
  const expectedName = safeRemoteBasename(artifact.url);
  const matching = updateInfo.files.filter((file) =>
    file && typeof file.url === 'string' && safeRemoteBasename(file.url) === expectedName);
  if (matching.length !== 1) throw new Error('Update metadata does not select the signed Windows artifact');
}

async function stageDownloadedReleaseArtifact(
  paths: unknown,
  admission: VerifiedReleaseSetAdmission,
  verifiedUpdateRoot: string
): Promise<PreparedAdmittedDownload> {
  const windowsArtifact = Object.freeze({ ...admission.windowsArtifact });
  const configurationDigest = admission.configurationDigest;
  const releasePayloadSha256 = hashReleasePayload(admission);
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8
    || paths.some((path) => typeof path !== 'string' || path.length < 1 || path.length > 32_768)) {
    throw new Error('Downloaded update paths are invalid');
  }
  // NsisUpdater returns the installer first (followed by an optional web
  // package). Do not accept a decoy path with the signed digest while the
  // updater has selected a different executable for installation.
  const installerPath = paths[0] as string;
  if (!isAbsolute(installerPath)
    || basename(installerPath) !== safeRemoteBasename(windowsArtifact.url)) {
    throw new Error('Downloaded update does not match the signed release set: installer name is invalid');
  }
  let snapshotPath: string | null = null;
  let source: OpenVerifiedFile | null = null;
  let destination: FileHandle | null = null;
  try {
    await ensureVerifiedUpdateRoot(verifiedUpdateRoot);
    source = await openStableFile(
      installerPath,
      windowsArtifact.size
    );
    snapshotPath = join(
      verifiedUpdateRoot,
      `windows-${windowsArtifact.sha256}-${randomUUID()}.exe`
    );
    destination = await open(
      snapshotPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600
    );
    const copiedSha256 = await copyVerifiedBytes(
      source.handle,
      destination,
      windowsArtifact.size
    );
    await destination.sync();
    const sourceAfterCopy = await source.handle.stat({ bigint: true });
    const sourcePathAfterCopy = await lstat(installerPath, { bigint: true });
    if (!sameFile(source.identity, sourceAfterCopy)
      || !sameFile(source.identity, sourcePathAfterCopy)) {
      throw new Error('downloaded artifact changed while its protected snapshot was created');
    }
    if (copiedSha256 !== windowsArtifact.sha256) {
      throw new Error('downloaded artifact checksum does not match');
    }
    await destination.close();
    destination = null;
    await chmod(snapshotPath, 0o400);
    const snapshot = await openVerifiedFile(
      snapshotPath,
      windowsArtifact.size,
      windowsArtifact.sha256
    );
    const snapshotIdentity = snapshot.identity;
    await snapshot.handle.close();
    return {
      version: windowsArtifact.version,
      installerPath,
      installerIdentity: source.identity,
      snapshotPath,
      snapshotIdentity,
      configurationDigest,
      releasePayloadSha256,
      windowsArtifact
    };
  } catch (error) {
    if (snapshotPath) await rm(snapshotPath, { force: true }).catch(() => undefined);
    throw new Error(`Downloaded update does not match the signed release set: ${safeArtifactError(error)}`);
  } finally {
    if (destination) await destination.close().catch(() => undefined);
    if (source) await source.handle.close().catch(() => undefined);
  }
}

interface OpenVerifiedFile {
  handle: FileHandle;
  identity: VerifiedFileIdentity;
}

async function openVerifiedFile(
  path: string,
  expectedSize: number,
  expectedSha256: string,
  expectedIdentity?: VerifiedFileIdentity
): Promise<OpenVerifiedFile> {
  const opened = await openStableFile(path, expectedSize, expectedIdentity);
  try {
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < expectedSize) {
      const read = await opened.handle.read(buffer, 0, Math.min(buffer.length, expectedSize - offset), offset);
      if (read.bytesRead < 1) throw new Error('downloaded artifact was truncated during verification');
      digest.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await opened.handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!sameFile(opened.identity, after) || !sameFile(opened.identity, afterPath)) {
      throw new Error('downloaded artifact changed during verification');
    }
    if (digest.digest('hex') !== expectedSha256) throw new Error('downloaded artifact checksum does not match');
    return opened;
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

async function openStableFile(
  path: string,
  expectedSize: number,
  expectedIdentity?: VerifiedFileIdentity
): Promise<OpenVerifiedFile> {
  const beforePath = await lstat(path, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size !== BigInt(expectedSize)) {
    throw new Error('downloaded artifact size or file type is invalid');
  }
  if (expectedIdentity && !sameFile(beforePath, expectedIdentity)) {
    throw new Error('downloaded artifact identity changed after admission');
  }
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameFile(beforePath, before) || !before.isFile()
      || (expectedIdentity && !sameFile(before, expectedIdentity))) {
      throw new Error('downloaded artifact changed before verification');
    }
    return { handle, identity: fileIdentity(before) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function ensureVerifiedUpdateRoot(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('verified update staging root is invalid');
  }
  await chmod(path, 0o700);
  const after = await lstat(path, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('verified update staging root changed during preparation');
  }
}

async function sweepOwnedVerifiedUpdates(path: string): Promise<void> {
  await ensureVerifiedUpdateRoot(path);
  const names = await readdir(path);
  for (const name of names) {
    if (!OWNED_VERIFIED_UPDATE_NAME.test(name)) continue;
    // A generated snapshot is always a regular file. Remove an exact-name
    // symlink defensively, but preserve directories and every unknown name so
    // the startup sweep cannot become a broad recursive deletion primitive.
    const candidatePath = join(path, name);
    const candidate = await lstat(candidatePath);
    if (!candidate.isFile() && !candidate.isSymbolicLink()) continue;
    await rm(candidatePath, { force: true });
  }
}

async function copyVerifiedBytes(source: FileHandle, destination: FileHandle, size: number): Promise<string> {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const read = await source.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (read.bytesRead < 1) throw new Error('downloaded artifact was truncated while being staged');
    digest.update(buffer.subarray(0, read.bytesRead));
    let written = 0;
    while (written < read.bytesRead) {
      const result = await destination.write(
        buffer,
        written,
        read.bytesRead - written,
        offset + written
      );
      if (result.bytesWritten < 1) throw new Error('protected update snapshot could not be written');
      written += result.bytesWritten;
    }
    offset += read.bytesRead;
  }
  return digest.digest('hex');
}

function noFollowFlag(): number {
  return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

function fileIdentity(value: VerifiedFileIdentity): VerifiedFileIdentity {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs
  };
}

function assertSameAdmission(
  prepared: PreparedAdmittedDownload,
  current: VerifiedReleaseSetAdmission | null
): asserts current is VerifiedReleaseSetAdmission {
  if (!current
    || current.configurationDigest !== prepared.configurationDigest
    || hashReleasePayload(current) !== prepared.releasePayloadSha256
    || !sameWindowsArtifact(current.windowsArtifact, prepared.windowsArtifact)) {
    throw new UpdateAdmissionChangedError();
  }
}

function assertCurrentAdmission(
  authority: FleetReleaseSetAuthorityLike,
  admission: VerifiedReleaseSetAdmission
): void {
  if (typeof authority.assertCurrent !== 'function') throw new UpdateAdmissionChangedError();
  try {
    authority.assertCurrent(admission);
  } catch {
    throw new UpdateAdmissionChangedError();
  }
}

async function bindAndInstallPreparedDownload(
  prepared: PreparedAdmittedDownload,
  client: UpdateClient,
  revalidateAdmission: () => void
): Promise<void> {
  const artifact = prepared.windowsArtifact;
  let selected: OpenVerifiedFile | null = null;
  let snapshot: OpenVerifiedFile | null = null;
  let rebound: OpenVerifiedFile | null = null;
  let replacementPath: string | null = null;
  try {
    selected = await openVerifiedFile(
      prepared.installerPath,
      artifact.size,
      artifact.sha256,
      prepared.installerIdentity
    );
    snapshot = await openVerifiedFile(
      prepared.snapshotPath,
      artifact.size,
      artifact.sha256,
      prepared.snapshotIdentity
    );

    if (!sameFile(selected.identity, snapshot.identity)) {
      replacementPath = join(
        dirname(prepared.installerPath),
        `.${basename(prepared.installerPath)}.verified-${randomUUID()}.tmp`
      );
      await link(prepared.snapshotPath, replacementPath);
      const linked = await lstat(replacementPath, { bigint: true });
      if (!sameFile(linked, snapshot.identity)) {
        throw new Error('protected update snapshot changed before installation');
      }
    }

    const selectedImmediatelyBeforeBind = await lstat(prepared.installerPath, { bigint: true });
    const selectedHandleAfterAdmission = await selected.handle.stat({ bigint: true });
    const snapshotPathAfterAdmission = await lstat(prepared.snapshotPath, { bigint: true });
    const snapshotHandleAfterAdmission = await snapshot.handle.stat({ bigint: true });
    if (!sameFile(selectedImmediatelyBeforeBind, selected.identity)
      || !sameFile(selectedHandleAfterAdmission, selected.identity)
      || !sameFile(snapshotPathAfterAdmission, snapshot.identity)
      || !sameFile(snapshotHandleAfterAdmission, snapshot.identity)) {
      throw new Error('downloaded artifact changed immediately before installation');
    }
    if (replacementPath) {
      const linkedAfterAdmission = await lstat(replacementPath, { bigint: true });
      if (!sameFile(linkedAfterAdmission, snapshot.identity)) {
        throw new Error('protected update snapshot changed before installation');
      }
    }

    // Keep the verified handles and protected hard link live while the
    // current admission is checked immediately before binding the updater's
    // selected path to the verified inode.
    revalidateAdmission();
    if (replacementPath) {
      await rename(replacementPath, prepared.installerPath);
      replacementPath = null;
    }

    rebound = await openStableFile(
      prepared.installerPath,
      artifact.size,
      snapshot.identity
    );
    if (!sameFile(rebound.identity, snapshot.identity)) {
      throw new Error('installer path was not bound to the protected update snapshot');
    }
    prepared.installerIdentity = snapshot.identity;

    // The installer path is now an independently named hard link to the
    // verified inode, so the protected staging name is no longer needed.
    // Remove it before requesting process exit, then prove that cleanup did
    // not disturb the updater-selected path.
    await snapshot.handle.close();
    snapshot = null;
    await rm(prepared.snapshotPath, { force: true });
    const reboundPathImmediatelyBeforeInstall = await lstat(prepared.installerPath, { bigint: true });
    const reboundHandleImmediatelyBeforeInstall = await rebound.handle.stat({ bigint: true });
    if (!sameFile(reboundPathImmediatelyBeforeInstall, rebound.identity)
      || !sameFile(reboundHandleImmediatelyBeforeInstall, rebound.identity)) {
      throw new Error('installer path changed after protected snapshot cleanup');
    }

    // Configuration generation and signed-cohort freshness can change while
    // the filesystem binding is in progress. Check them again with no async
    // gap before handing control to electron-updater.
    revalidateAdmission();
    client.quitAndInstall(false, true);
  } catch (error) {
    if (error instanceof UpdateAdmissionChangedError) throw error;
    throw new Error(`Downloaded update could not be safely installed: ${safeArtifactError(error)}`);
  } finally {
    if (replacementPath) await rm(replacementPath, { force: true }).catch(() => undefined);
    if (rebound) await rebound.handle.close().catch(() => undefined);
    if (snapshot) await snapshot.handle.close().catch(() => undefined);
    if (selected) await selected.handle.close().catch(() => undefined);
  }
}

function hashReleasePayload(admission: VerifiedReleaseSetAdmission): string {
  return createHash('sha256').update(signedReleaseSetPayload(admission.releaseSet)).digest('hex');
}

function sameWindowsArtifact(
  left: VerifiedReleaseSetAdmission['windowsArtifact'],
  right: VerifiedReleaseSetAdmission['windowsArtifact']
): boolean {
  return left.id === right.id
    && left.component === right.component
    && left.componentSequence === right.componentSequence
    && left.version === right.version
    && left.platform === right.platform
    && left.architecture === right.architecture
    && left.url === right.url
    && left.sha256 === right.sha256
    && left.size === right.size
    && left.sourceRepository === right.sourceRepository
    && left.sourceCommit === right.sourceCommit
    && left.contractPackageVersion === right.contractPackageVersion
    && left.sbomSha256 === right.sbomSha256
    && left.licenseSha256 === right.licenseSha256;
}

function sameFile(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function safeRemoteBasename(value: string): string {
  try {
    const url = new URL(value, 'https://update.invalid/');
    const name = basename(decodeURIComponent(url.pathname));
    if (!name || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error();
    return name;
  } catch {
    throw new Error('Update artifact URL is invalid');
  }
}

function safeArtifactError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).split(/\r?\n/u, 1)[0];
  return /^(downloaded artifact|protected update snapshot|verified update staging root|installer path)/u.test(message)
    ? message.slice(0, 160)
    : 'installer verification failed';
}
