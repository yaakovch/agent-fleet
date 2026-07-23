import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { win32 } from 'node:path';
import type { FleetDownloadJob } from '../shared/app';
import { resolveWslExecutable } from './fleet-terminal';
import { activatedRuntimeCommand } from '../shared/runtime';

const MAX_OUTPUT_BYTES = 64 * 1024;
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
}

interface ActiveDownload {
  job: FleetDownloadJob;
  child: ChildProcessWithoutNullStreams | null;
  stdout: string;
  stderr: string;
  stderrBuffer: string;
  cancelled: boolean;
}

export class FleetDownloadManager {
  private readonly jobs = new Map<string, ActiveDownload>();
  private readonly spawnProcess: typeof spawn;

  constructor(private readonly options: FleetDownloadManagerOptions) {
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  start(target: FleetDownloadTarget): FleetDownloadJob {
    validateTarget(target);
    this.pruneFinishedJobs();
    const id = `download-${randomUUID()}`;
    const job: FleetDownloadJob = {
      id,
      sessionId: target.sessionId,
      name: target.name,
      relativePath: target.relativePath,
      state: 'running',
      received: 0,
      total: target.size,
      message: 'Starting download…'
    };
    const active: ActiveDownload = { job, child: null, stdout: '', stderr: '', stderrBuffer: '', cancelled: false };
    this.jobs.set(id, active);
    this.emit(active);

    const outputDirectory = this.options.downloadsDirectory();
    const wslOutputDirectory = windowsPathToWsl(outputDirectory);
    const args = [
      '-d', this.options.distro(), '--cd', '~', '--', activatedRuntimeCommand('wtmux'), 'file', 'download',
      '--host', target.hostId, '--session', target.internalName, '--path', target.relativePath,
      '--output-dir', wslOutputDirectory, '--yes', '--json', '--json-progress'
    ];
    try {
      const child = this.spawnProcess(this.options.wslExecutable?.() ?? resolveWslExecutable(), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }) as unknown as ChildProcessWithoutNullStreams;
      active.child = child;
      child.stdout.on('data', (chunk: Buffer) => this.acceptStdout(active, chunk));
      child.stderr.on('data', (chunk: Buffer) => this.acceptStderr(active, chunk));
      child.once('error', (error) => this.finishFailure(active, readableError(error)));
      child.once('exit', (code) => this.finish(active, code));
    } catch (error) {
      this.finishFailure(active, readableError(error));
    }
    return { ...job };
  }

  get(id: string): FleetDownloadJob | undefined {
    const active = this.jobs.get(id);
    return active ? { ...active.job } : undefined;
  }

  cancel(id: string): FleetDownloadJob | undefined {
    const active = this.jobs.get(id);
    if (!active) return undefined;
    if (active.job.state !== 'running') return { ...active.job };
    active.cancelled = true;
    active.job = { ...active.job, state: 'cancelled', message: 'Download cancelled' };
    this.emit(active);
    active.child?.kill('SIGTERM');
    return { ...active.job };
  }

  stop(): void {
    for (const active of this.jobs.values()) {
      if (active.job.state === 'running') this.cancel(active.job.id);
    }
  }

  private acceptStdout(active: ActiveDownload, chunk: Buffer): void {
    if (active.stdout.length >= MAX_OUTPUT_BYTES) return;
    active.stdout = (active.stdout + chunk.toString('utf8')).slice(-MAX_OUTPUT_BYTES);
  }

  private acceptStderr(active: ActiveDownload, chunk: Buffer): void {
    active.stderrBuffer += chunk.toString('utf8');
    if (active.stderrBuffer.length > MAX_OUTPUT_BYTES) active.stderrBuffer = active.stderrBuffer.slice(-MAX_OUTPUT_BYTES);
    let newline = active.stderrBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = active.stderrBuffer.slice(0, newline).trim();
      active.stderrBuffer = active.stderrBuffer.slice(newline + 1);
      if (line) this.acceptProgressLine(active, line);
      newline = active.stderrBuffer.indexOf('\n');
    }
  }

  private acceptProgressLine(active: ActiveDownload, line: string): void {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type !== 'progress' || !Number.isSafeInteger(value.received) || !Number.isSafeInteger(value.total)) throw new Error();
      const received = value.received as number;
      const total = value.total as number;
      if (received < 0 || total < 0 || received > total || total > 2 * 1024 * 1024 * 1024) throw new Error();
      if (active.job.state === 'running') {
        const percent = total ? Math.floor(received * 100 / total) : 100;
        active.job = { ...active.job, received, total, message: `Downloading · ${percent}%` };
        this.emit(active);
      }
    } catch {
      active.stderr = (active.stderr + `${line}\n`).slice(-4_096);
    }
  }

  private finish(active: ActiveDownload, code: number | null): void {
    if (active.cancelled || active.job.state === 'cancelled') return;
    if (active.job.state !== 'running') return;
    if (code !== 0) {
      this.finishFailure(active, cleanFailure(active.stderr || active.stderrBuffer || 'Download failed'));
      return;
    }
    try {
      const lines = active.stdout.trim().split(/\r?\n/u);
      const value = JSON.parse(lines.at(-1) ?? '') as Record<string, unknown>;
      if (value.status !== 'downloaded' || typeof value.name !== 'string' || win32.basename(value.name) !== value.name
        || value.name.includes('/') || value.size !== active.job.total || typeof value.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error();
      const path = win32.join(this.options.downloadsDirectory(), value.name);
      active.job = {
        ...active.job,
        name: value.name,
        state: 'completed',
        received: active.job.total,
        path,
        message: `Downloaded to ${path}`
      };
      this.emit(active);
      this.options.onComplete?.({ ...active.job });
    } catch {
      this.finishFailure(active, 'Host returned an invalid download result');
    }
  }

  private finishFailure(active: ActiveDownload, message: string): void {
    if (active.cancelled || active.job.state === 'cancelled' || active.job.state === 'failed') return;
    active.job = { ...active.job, state: 'failed', message };
    this.emit(active);
  }

  private emit(active: ActiveDownload): void {
    this.options.onUpdate({ ...active.job });
  }

  private pruneFinishedJobs(): void {
    if (this.jobs.size < 100) return;
    for (const [id, active] of this.jobs) {
      if (active.job.state !== 'running') this.jobs.delete(id);
      if (this.jobs.size < 80) break;
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
  if (!target.name || win32.basename(target.name) !== target.name || target.name.includes('/') || target.name.length > 255) throw new Error('Download name is invalid');
  if (!Number.isSafeInteger(target.size) || target.size < 0 || target.size > 2 * 1024 * 1024 * 1024) throw new Error('Download size is invalid');
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Download could not be started';
}

function cleanFailure(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 240) || 'Download failed';
}
