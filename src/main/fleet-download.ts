import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { FleetDownloadJob } from '../shared/app';
import { resolveWslExecutable } from './fleet-terminal';
import { activatedRuntimeCommand } from '../shared/runtime';
import type { WslProcessOwnership } from './wsl-process-ownership';

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,320}$/u;
const SAFE_SESSION = /^[A-Za-z0-9._-]{1,128}$/u;

export interface FleetDownloadTarget {
  sessionId: string;
  hostId: string;
  internalName: string;
  relativePath: string;
  name: string;
  size: number;
}

export interface FleetDownloadManagerOptions {
  distro: () => string;
  downloadsDirectory: () => string;
  onUpdate: (job: FleetDownloadJob) => void;
  onComplete?: (job: FleetDownloadJob) => void;
  spawnProcess?: typeof spawn;
  wslExecutable?: () => string;
  processOwnership?: WslProcessOwnership;
  maxConcurrent?: number;
  maxQueued?: number;
  cancelTimeoutMs?: number;
  verificationTimeoutMs?: number;
  verifyArtifact?: (
    path: string,
    expectedSize: number,
    expectedSha256: string,
    signal?: AbortSignal
  ) => Promise<boolean>;
}

interface ActiveDownload {
  job: FleetDownloadJob;
  target: FleetDownloadTarget;
  distro: string;
  outputDirectory: string;
  destinationPath: string;
  destinationKey: string;
  expectedSize: number;
  child: ChildProcessWithoutNullStreams | null;
  stdout: Buffer;
  stderr: string;
  stderrBuffer: Buffer;
  phase: 'queued' | 'running' | 'verifying' | 'finished';
  cancelRequested: boolean;
  verificationAbortController: AbortController | null;
  slotHeld: boolean;
  spawnError: string;
  integrity?: { path: string; size: number; sha256: string };
  settled: Promise<void>;
  resolveSettled: () => void;
  cancelEscalationTimer: NodeJS.Timeout | null;
  cancelDeadlineTimer: NodeJS.Timeout | null;
}

export class FleetDownloadManager {
  private readonly jobs = new Map<string, ActiveDownload>();
  private readonly queue: string[] = [];
  private readonly spawnProcess: typeof spawn;
  private readonly verifyArtifact: NonNullable<FleetDownloadManagerOptions['verifyArtifact']>;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly cancelTimeoutMs: number;
  private readonly verificationTimeoutMs: number;
  private readonly destinationReservations = new Map<string, string>();
  private running = 0;
  private stopped = false;

  constructor(private readonly options: FleetDownloadManagerOptions) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.verifyArtifact = options.verifyArtifact ?? verifyLocalArtifact;
    this.maxConcurrent = boundedInteger(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, 1, 8, 'download concurrency');
    this.maxQueued = boundedInteger(options.maxQueued, DEFAULT_MAX_QUEUED, 0, 256, 'download queue');
    this.cancelTimeoutMs = boundedInteger(
      options.cancelTimeoutMs,
      DEFAULT_CANCEL_TIMEOUT_MS,
      10,
      60_000,
      'download cancellation timeout'
    );
    this.verificationTimeoutMs = boundedInteger(
      options.verificationTimeoutMs,
      DEFAULT_VERIFICATION_TIMEOUT_MS,
      10,
      600_000,
      'download verification timeout'
    );
  }

  start(target: FleetDownloadTarget): FleetDownloadJob {
    if (this.stopped) throw new Error('Download manager is stopping');
    validateTarget(target);
    this.pruneFinishedJobs();
    const pending = [...this.jobs.values()].filter((active) => active.phase !== 'finished').length;
    if (pending >= this.maxConcurrent + this.maxQueued) throw new Error('Too many downloads are already queued');

    const id = `download-${randomUUID()}`;
    const outputDirectory = this.options.downloadsDirectory();
    windowsPathToWsl(outputDirectory);
    const destinationPath = win32.join(outputDirectory, target.name);
    const destinationKey = canonicalWindowsPath(destinationPath);
    if (this.destinationReservations.has(destinationKey)) {
      throw new Error('A download for this destination is already active or available');
    }
    const job: FleetDownloadJob = {
      id,
      sessionId: target.sessionId,
      name: target.name,
      relativePath: target.relativePath,
      state: 'running',
      received: 0,
      total: target.size,
      message: this.running < this.maxConcurrent ? 'Starting download…' : 'Waiting for a download slot…'
    };
    let resolveSettled = (): void => undefined;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const active: ActiveDownload = {
      job,
      target: { ...target },
      distro: this.options.distro(),
      outputDirectory,
      destinationPath,
      destinationKey,
      expectedSize: target.size,
      child: null,
      stdout: Buffer.alloc(0),
      stderr: '',
      stderrBuffer: Buffer.alloc(0),
      phase: 'queued',
      cancelRequested: false,
      verificationAbortController: null,
      slotHeld: false,
      spawnError: '',
      settled,
      resolveSettled,
      cancelEscalationTimer: null,
      cancelDeadlineTimer: null
    };
    this.jobs.set(id, active);
    this.destinationReservations.set(destinationKey, id);
    this.emit(active);
    this.queue.push(id);
    this.pumpQueue();
    return { ...active.job };
  }

  private launch(active: ActiveDownload, target: FleetDownloadTarget): void {
    if (active.phase !== 'queued' || active.cancelRequested) return;
    active.phase = 'running';
    active.slotHeld = true;
    this.running += 1;
    active.job = { ...active.job, message: 'Starting download…' };
    this.emit(active);
    const wslOutputDirectory = windowsPathToWsl(active.outputDirectory);
    const args = [
      '-d', active.distro, '--cd', '~', '--', activatedRuntimeCommand('wtmux'), 'file', 'download',
      '--host', target.hostId, '--session', target.internalName, '--path', target.relativePath,
      '--output-dir', wslOutputDirectory, '--yes', '--json', '--json-progress'
    ];
    try {
      const child = this.spawnProcess(this.options.wslExecutable?.() ?? resolveWslExecutable(), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }) as unknown as ChildProcessWithoutNullStreams;
      active.child = child;
      try {
        this.options.processOwnership?.own(`download:${active.job.id}`, child);
      } catch (error) {
        active.child = null;
        child.once('error', () => undefined);
        try { child.kill('SIGKILL'); } catch { /* the failed registration still owns cleanup */ }
        throw error;
      }
      child.stdout.on('data', (chunk: Buffer) => this.acceptStdout(active, chunk));
      child.stderr.on('data', (chunk: Buffer) => this.acceptStderr(active, chunk));
      child.once('error', (error) => { active.spawnError = readableError(error); });
      child.once('close', (code) => {
        void this.finishAfterClose(active, code).catch((error: unknown) => {
          this.finishFailure(active, readableError(error));
        });
      });
    } catch (error) {
      this.finishFailure(active, readableError(error));
    }
  }

  get(id: string): FleetDownloadJob | undefined {
    const active = this.jobs.get(id);
    return active ? { ...active.job } : undefined;
  }

  async cancel(id: string): Promise<FleetDownloadJob | undefined> {
    const active = this.jobs.get(id);
    if (!active) return undefined;
    if (active.phase === 'finished') return { ...active.job };
    active.cancelRequested = true;
    if (active.phase === 'queued') {
      this.finishCancelled(active);
      return { ...active.job };
    }
    active.job = { ...active.job, message: 'Cancelling download…' };
    this.emit(active);
    this.scheduleCancellationDeadline(active);
    await active.settled;
    return { ...active.job };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.jobs.values()]
      .filter((active) => active.phase !== 'finished')
      .map((active) => this.cancel(active.job.id)));
  }

  async verifyForUse(id: string): Promise<FleetDownloadJob | undefined> {
    const active = this.jobs.get(id);
    if (!active || active.phase !== 'finished' || active.job.state !== 'completed' || !active.integrity) {
      return active ? { ...active.job } : undefined;
    }
    let verified = false;
    try {
      verified = await this.verifyWithDeadline(
        active.integrity.path,
        active.integrity.size,
        active.integrity.sha256
      );
    } catch {
      verified = false;
    }
    if (!verified && active.job.state === 'completed') {
      active.integrity = undefined;
      active.job = {
        ...active.job,
        state: 'failed',
        path: undefined,
        message: 'Downloaded file failed integrity verification'
      };
      this.releaseDestination(active);
      this.emit(active);
    }
    return { ...active.job };
  }

  private acceptStdout(active: ActiveDownload, chunk: Buffer): void {
    active.stdout = appendTail(active.stdout, chunk, MAX_OUTPUT_BYTES);
  }

  private acceptStderr(active: ActiveDownload, chunk: Buffer): void {
    active.stderrBuffer = appendTail(active.stderrBuffer, chunk, MAX_OUTPUT_BYTES);
    let newline = active.stderrBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = active.stderrBuffer.subarray(0, newline).toString('utf8').trim();
      active.stderrBuffer = active.stderrBuffer.subarray(newline + 1);
      if (line) this.acceptProgressLine(active, line);
      newline = active.stderrBuffer.indexOf(0x0a);
    }
  }

  private acceptProgressLine(active: ActiveDownload, line: string): void {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type !== 'progress' || !Number.isSafeInteger(value.received) || !Number.isSafeInteger(value.total)) throw new Error();
      const received = value.received as number;
      const total = value.total as number;
      if (received < 0 || total !== active.expectedSize || received > total) throw new Error();
      if (active.job.state === 'running') {
        const percent = total ? Math.floor(received * 100 / total) : 100;
        active.job = { ...active.job, received, total, message: `Downloading · ${percent}%` };
        this.emit(active);
      }
    } catch {
      active.stderr = (active.stderr + `${line}\n`).slice(-4_096);
    }
  }

  private async finishAfterClose(active: ActiveDownload, code: number | null): Promise<void> {
    if (active.phase !== 'running') return;
    active.child = null;
    active.phase = 'verifying';
    if (active.cancelRequested) {
      this.finishCancelled(active);
      return;
    }
    if (code !== 0) {
      this.finishFailure(active, cleanFailure(
        active.spawnError || active.stderr || active.stderrBuffer.toString('utf8') || 'Download failed'
      ));
      return;
    }
    let value: Record<string, unknown>;
    try {
      const lines = active.stdout.toString('utf8').trim().split(/\r?\n/u);
      value = JSON.parse(lines.at(-1) ?? '') as Record<string, unknown>;
      if (value.status !== 'downloaded' || typeof value.name !== 'string' || win32.basename(value.name) !== value.name
        || !isExpectedDownloadName(active.target.name, value.name) || value.name.includes('/')
        || value.size !== active.expectedSize
        || typeof value.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error();
    } catch {
      this.finishFailure(active, 'Host returned an invalid download result');
      return;
    }
    const path = win32.join(active.outputDirectory, value.name as string);
    let verified = false;
    try {
      verified = await this.verifyWithDeadline(
        path,
        active.expectedSize,
        value.sha256 as string,
        active
      );
    } catch {
      verified = false;
    }
    if (active.cancelRequested) {
      this.finishCancelled(active);
      return;
    }
    if (!verified) {
      this.finishFailure(active, 'Downloaded file failed final integrity verification');
      return;
    }
    active.integrity = { path, size: active.expectedSize, sha256: value.sha256 as string };
    active.job = {
      ...active.job,
      name: value.name as string,
      state: 'completed',
      received: active.expectedSize,
      path,
      message: `Downloaded to ${path}`
    };
    this.finishCompleted(active);
  }

  private finishFailure(active: ActiveDownload, message: string): void {
    if (active.phase === 'finished') return;
    if (active.cancelRequested) {
      this.finishCancelled(active);
      return;
    }
    active.job = { ...active.job, state: 'failed', message };
    this.finalize(active);
  }

  private finishCompleted(active: ActiveDownload): void {
    if (active.phase === 'finished') return;
    this.finalize(active);
    this.options.onComplete?.({ ...active.job });
  }

  private finishCancelled(active: ActiveDownload): void {
    if (active.phase === 'finished') return;
    active.job = { ...active.job, state: 'cancelled', path: undefined, message: 'Download cancelled' };
    active.integrity = undefined;
    this.finalize(active);
  }

  private finalize(active: ActiveDownload): void {
    if (active.cancelEscalationTimer) clearTimeout(active.cancelEscalationTimer);
    if (active.cancelDeadlineTimer) clearTimeout(active.cancelDeadlineTimer);
    active.cancelEscalationTimer = null;
    active.cancelDeadlineTimer = null;
    active.phase = 'finished';
    this.emit(active);
    active.resolveSettled();
    if (active.slotHeld) {
      active.slotHeld = false;
      this.running -= 1;
    }
    this.releaseDestination(active);
    this.pumpQueue();
  }

  private scheduleCancellationDeadline(active: ActiveDownload): void {
    if (active.cancelDeadlineTimer || active.phase === 'finished') return;
    active.verificationAbortController?.abort();
    const child = active.child;
    const owned = child ? this.options.processOwnership?.release(child, 'cancel') ?? false : false;
    if (child && !owned) {
      try {
        child.kill('SIGTERM');
      } catch {
        // The child closed between cancellation resolution and termination.
      }
      active.cancelEscalationTimer = setTimeout(() => {
        active.cancelEscalationTimer = null;
        if (active.phase === 'finished' || active.child !== child) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // The child may have exited without emitting close.
        }
      }, Math.max(1, Math.floor(this.cancelTimeoutMs / 2)));
      active.cancelEscalationTimer.unref();
    }
    active.cancelDeadlineTimer = setTimeout(() => {
      active.cancelDeadlineTimer = null;
      if (active.phase === 'finished') return;
      active.child = null;
      this.finishCancelled(active);
    }, this.cancelTimeoutMs);
    active.cancelDeadlineTimer.unref();
  }

  private releaseDestination(active: ActiveDownload): void {
    if (this.destinationReservations.get(active.destinationKey) === active.job.id) {
      this.destinationReservations.delete(active.destinationKey);
    }
  }

  private async verifyWithDeadline(
    path: string,
    expectedSize: number,
    expectedSha256: string,
    active?: ActiveDownload
  ): Promise<boolean> {
    const controller = new AbortController();
    if (active) active.verificationAbortController = controller;
    let timer: NodeJS.Timeout | null = null;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, this.verificationTimeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([
        Promise.resolve(this.verifyArtifact(path, expectedSize, expectedSha256, controller.signal))
          .catch(() => false),
        deadline
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (active?.verificationAbortController === controller) {
        active.verificationAbortController = null;
      }
    }
  }

  private emit(active: ActiveDownload): void {
    this.options.onUpdate({ ...active.job });
  }

  private pruneFinishedJobs(): void {
    if (this.jobs.size < 100) return;
    for (const [id, active] of this.jobs) {
      if (active.phase === 'finished') {
        this.releaseDestination(active);
        this.jobs.delete(id);
      }
      if (this.jobs.size < 80) break;
    }
  }

  private pumpQueue(): void {
    if (this.stopped) return;
    while (this.running < this.maxConcurrent) {
      const id = this.queue.shift();
      if (!id) return;
      const active = this.jobs.get(id);
      if (!active || active.phase !== 'queued') continue;
      this.launch(active, active.target);
    }
  }
}

export function windowsPathToWsl(value: string): string {
  const parsed = win32.parse(value);
  if (!/^[A-Za-z]:\\/u.test(value) || !parsed.root) throw new Error('Windows Downloads folder is not on a local drive');
  const drive = value[0].toLowerCase();
  const rest = value.slice(3).split('\\').filter(Boolean).join('/');
  if (/[\u0000-\u001f\u007f]/u.test(rest)) throw new Error('Windows Downloads folder is invalid');
  return `/mnt/${drive}${rest ? `/${rest}` : ''}`;
}

function validateTarget(target: FleetDownloadTarget): void {
  if (!SAFE_ID.test(target.sessionId) || !SAFE_ID.test(target.hostId) || !SAFE_SESSION.test(target.internalName)) {
    throw new Error('Download session is invalid');
  }
  if (!target.relativePath || target.relativePath.length > 2048 || target.relativePath.startsWith('/')
    || target.relativePath.includes('\\') || target.relativePath.split('/').some((part) => !part || part === '.' || part === '..')
    || /[\u0000-\u001f\u007f]/u.test(target.relativePath)) {
    throw new Error('Download path is invalid');
  }
  if (!target.name || win32.basename(target.name) !== target.name || target.name.includes('/')
    || target.name.length > 255 || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(target.name)
    || /[. ]$/u.test(target.name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(target.name)) {
    throw new Error('Download name is invalid');
  }
  if (!Number.isSafeInteger(target.size) || target.size < 0 || target.size > 2 * 1024 * 1024 * 1024) throw new Error('Download size is invalid');
}

function canonicalWindowsPath(value: string): string {
  return win32.normalize(value).toLowerCase();
}

function isExpectedDownloadName(requested: string, returned: string): boolean {
  if (returned === requested) return true;
  const firstSuffix = requested.indexOf('.', requested.startsWith('.') ? 1 : 0);
  const stem = firstSuffix > 0 ? requested.slice(0, firstSuffix) : requested;
  const suffixes = firstSuffix > 0 ? requested.slice(firstSuffix) : '';
  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const escapedSuffixes = suffixes.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`^${escapedStem} \\(([1-9][0-9]{0,3})\\)${escapedSuffixes}$`, 'u').exec(returned);
  return Boolean(match && Number(match[1]) <= 9_999);
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Download could not be started';
}

function cleanFailure(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 240) || 'Download failed';
}

function appendTail(current: Buffer, chunk: Buffer, maximum: number): Buffer {
  if (chunk.length >= maximum) return Buffer.from(chunk.subarray(chunk.length - maximum));
  const keep = Math.min(current.length, maximum - chunk.length);
  return Buffer.concat([current.subarray(current.length - keep), chunk], keep + chunk.length);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return selected;
}

export async function verifyLocalArtifact(
  path: string,
  expectedSize: number,
  expectedSha256: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false;
  const beforePath = await lstat(path);
  if (!beforePath.isFile() || beforePath.size !== expectedSize) return false;
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  let stream: ReturnType<typeof handle.createReadStream> | null = null;
  let closePromise: Promise<void> | null = null;
  const closeHandle = (): Promise<void> => {
    closePromise ??= handle.close();
    return closePromise;
  };
  const abortRead = (): void => {
    stream?.destroy();
    void closeHandle().catch(() => undefined);
  };
  signal?.addEventListener('abort', abortRead, { once: true });
  try {
    if (signal?.aborted) {
      abortRead();
      return false;
    }
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedSize || !sameArtifactStat(beforePath, stat)) return false;
    const hash = createHash('sha256');
    stream = handle.createReadStream({ autoClose: false, start: 0 });
    if (signal?.aborted) {
      abortRead();
      return false;
    }
    for await (const chunk of stream) {
      if (signal?.aborted) return false;
      hash.update(chunk as Buffer);
    }
    if (signal?.aborted) return false;
    const after = await handle.stat();
    const afterPath = await lstat(path);
    if (signal?.aborted) return false;
    return sameArtifactStat(stat, after)
      && sameArtifactStat(stat, afterPath)
      && hash.digest('hex') === expectedSha256;
  } catch (error) {
    if (signal?.aborted) return false;
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortRead);
    stream?.destroy();
    try {
      await closeHandle();
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
  }
}

function sameArtifactStat(
  left: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino' | 'size' | 'mtimeMs'>,
  right: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino' | 'size' | 'mtimeMs'>
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}
