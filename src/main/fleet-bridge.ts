import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WidgetSettings } from '../shared/settings';
import {
  FLEET_MAX_FRAME_BYTES,
  FLEET_PROTOCOL_VERSION,
  emptyFleetSnapshot,
  parseBridgeFleetSnapshot,
  toFleetSnapshot,
  type BridgeFleetSnapshot,
  type FleetBridgeStatus,
  type FleetBridgeView,
  type FleetMutationMethod,
  type FleetMutationResult
} from '../shared/fleet-protocol';

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const HEARTBEAT_TIMEOUT_MS = 30_000;

export interface FleetBridgeLaunch {
  command: string;
  args: string[];
  distro: string;
}

export interface FleetBridgeLogger {
  info(message: string, ...values: unknown[]): void;
  warn(message: string, ...values: unknown[]): void;
  error(message: string, ...values: unknown[]): void;
}

export interface FleetBridgeOptions {
  cachePath: string;
  launch: FleetBridgeLaunch;
  logger: FleetBridgeLogger;
  spawnProcess?: typeof spawn;
  mutationTimeoutMs?: number;
}

interface CacheEnvelope {
  cacheVersion: 1;
  protocolVersion: 1;
  savedAt: string;
  snapshot: BridgeFleetSnapshot;
}

interface PendingMutation {
  requestId: string;
  resolve: (result: FleetMutationResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class FleetMutationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class FleetBridgeSupervisor extends EventEmitter {
  private readonly spawnProcess: typeof spawn;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private snapshot: BridgeFleetSnapshot | null = null;
  private cacheSavedAt: string | null = null;
  private status: FleetBridgeStatus = 'starting';
  private errorCode = '';
  private stopped = true;
  private retryAttempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private settlePolls = 0;
  private lastFrameAt = 0;
  private requestNumber = 0;
  private pendingRequestId = '';
  private pendingMutation: PendingMutation | null = null;

  constructor(private readonly options: FleetBridgeOptions) {
    super();
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.loadCache();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.status = this.snapshot ? 'cached' : 'starting';
    this.errorCode = '';
    this.emitChanged();
    this.startChild();
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), 5_000);
    this.heartbeatTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.settleTimer = null;
    safeKill(this.child);
    this.child = null;
    this.rejectPendingMutation('bridge_disconnected', 'Fleet bridge stopped');
  }

  refresh(): void {
    if (this.child && !this.child.killed) this.requestSnapshot();
    else if (!this.stopped && !this.retryTimer) this.startChild();
  }

  getView(): FleetBridgeView {
    const snapshot = this.snapshot
      ? toFleetSnapshot(this.snapshot, this.options.launch.distro)
      : emptyFleetSnapshot(this.options.launch.distro);
    snapshot.controller.status = this.status === 'live' ? 'healthy' : this.status === 'error' ? 'failure' : 'offline';
    return { status: this.status, snapshot, cacheSavedAt: this.cacheSavedAt, errorCode: this.errorCode };
  }

  mutate(method: FleetMutationMethod, params: Record<string, unknown>): Promise<FleetMutationResult> {
    if (this.status !== 'live' || !this.snapshot || !this.child || this.child.killed || !this.child.stdin.writable) {
      return Promise.reject(new FleetMutationError('host_offline', 'Fleet controller is not live'));
    }
    if (this.pendingRequestId) {
      return Promise.reject(new FleetMutationError('conflict', 'Another fleet request is still in progress'));
    }
    this.requestNumber += 1;
    const requestId = `desktop-mutation-${this.requestNumber}`;
    this.pendingRequestId = requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.finishPendingMutation();
        reject(new FleetMutationError('timeout', 'Fleet mutation timed out; refresh before retrying'));
        this.errorCode = 'mutation_timeout';
        safeKill(this.child);
      }, this.options.mutationTimeoutMs ?? 15_000);
      timeout.unref();
      this.pendingMutation = { requestId, resolve, reject, timeout };
      const request = {
        protocolVersion: FLEET_PROTOCOL_VERSION,
        type: 'request',
        requestId,
        method,
        timestamp: new Date().toISOString(),
        params: { ...params, expectedRevision: this.snapshot!.revision }
      };
      this.child!.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) this.rejectPendingMutation('bridge_disconnected', 'Fleet bridge write failed');
      });
    });
  }

  private startChild(): void {
    if (this.stopped || this.child) return;
    this.buffer = Buffer.alloc(0);
    this.pendingRequestId = '';
    this.lastFrameAt = Date.now();
    this.settlePolls = 0;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(this.options.launch.command, this.options.launch.args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      this.options.logger.error('Fleet bridge spawn failed', error);
      this.disconnect('bridge_unavailable');
      return;
    }
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.acceptData(chunk));
    child.stderr.on('data', () => undefined);
    child.once('error', (error) => {
      this.options.logger.warn('Fleet bridge process error', error);
      this.disconnect('bridge_unavailable');
    });
    child.once('exit', () => this.disconnect(this.errorCode || 'bridge_disconnected'));
    this.requestSnapshot();
  }

  private acceptData(chunk: Buffer): void {
    if (!this.child) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > FLEET_MAX_FRAME_BYTES && !this.buffer.includes(0x0a)) {
      this.protocolFailure('frame_too_large');
      return;
    }
    let newline = this.buffer.indexOf(0x0a);
    while (newline >= 0) {
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (frame.length > FLEET_MAX_FRAME_BYTES) {
        this.protocolFailure('frame_too_large');
        return;
      }
      try {
        this.acceptFrame(JSON.parse(frame.toString('utf8')) as unknown);
      } catch (error) {
        this.options.logger.warn('Rejected invalid fleet bridge frame', error);
        this.protocolFailure('protocol_error');
        return;
      }
      newline = this.buffer.indexOf(0x0a);
    }
  }

  private acceptFrame(input: unknown): void {
    const value = object(input, 'frame');
    if (value.protocolVersion !== FLEET_PROTOCOL_VERSION) throw new Error('Unsupported fleet protocol version');
    this.lastFrameAt = Date.now();
    if (value.type === 'event') {
      exactKeys(value, ['protocolVersion', 'type', 'eventId', 'event', 'timestamp', 'revision', 'data'], 'event');
      if (value.event !== 'fleet.heartbeat' || typeof value.revision !== 'string') throw new Error('Invalid heartbeat');
      const data = object(value.data, 'heartbeat data');
      exactKeys(data, ['hostCount'], 'heartbeat data');
      if (!Number.isInteger(data.hostCount)) throw new Error('Invalid heartbeat host count');
      if (!this.snapshot || value.revision !== this.snapshot.revision) this.requestSnapshot();
      return;
    }
    if (this.pendingMutation && value.requestId === this.pendingMutation.requestId) {
      this.acceptMutationResponse(value);
      return;
    }
    exactKeys(value, ['protocolVersion', 'type', 'requestId', 'timestamp', 'ok', 'result'], 'response');
    if (value.type !== 'response' || value.ok !== true || value.requestId !== this.pendingRequestId) {
      throw new Error('Invalid or uncorrelated bridge response');
    }
    const snapshot = parseBridgeFleetSnapshot(value.result);
    this.pendingRequestId = '';
    const isSettling = snapshot.hosts.some((host) => host.status === 'connecting');
    if (isSettling && this.snapshot && this.status === 'cached') {
      this.scheduleSettlePoll();
      return;
    }
    this.snapshot = snapshot;
    this.cacheSavedAt = new Date().toISOString();
    this.status = 'live';
    this.errorCode = '';
    this.retryAttempt = 0;
    if (!isSettling) this.saveCache(snapshot, this.cacheSavedAt);
    else this.scheduleSettlePoll();
    this.emitChanged();
  }

  private acceptMutationResponse(value: Record<string, unknown>): void {
    const pending = this.pendingMutation;
    if (!pending) throw new Error('Mutation response is not pending');
    if (value.ok === false) {
      exactKeys(value, ['protocolVersion', 'type', 'requestId', 'timestamp', 'ok', 'error'], 'mutation error');
      const error = object(value.error, 'mutation error detail');
      exactKeys(error, ['code', 'message'], 'mutation error detail');
      const code = safeToken(error.code, 64) ? error.code : 'internal_failure';
      const message = safeText(error.message, 256) ? error.message : 'Fleet mutation failed';
      this.finishPendingMutation();
      pending.reject(new FleetMutationError(code, message));
      return;
    }
    exactKeys(value, ['protocolVersion', 'type', 'requestId', 'timestamp', 'ok', 'result'], 'mutation response');
    if (value.type !== 'response' || value.ok !== true) throw new Error('Mutation response is invalid');
    const result = object(value.result, 'mutation result');
    const keys = Object.keys(result).sort();
    const baseKeys = ['operationId', 'snapshot', 'status'].sort();
    const scheduleKeys = [...baseKeys, 'scheduleId'].sort();
    const sessionKeys = [...baseKeys, 'sessionId'].sort();
    if (!sameKeys(keys, baseKeys) && !sameKeys(keys, scheduleKeys) && !sameKeys(keys, sessionKeys)) {
      throw new Error('Mutation result fields are invalid');
    }
    if (!safeToken(result.operationId, 160) || !safeToken(result.status, 32)) throw new Error('Mutation result identity is invalid');
    if ('scheduleId' in result && !safeToken(result.scheduleId, 160)) throw new Error('Mutation scheduleId is invalid');
    if ('sessionId' in result && !safeToken(result.sessionId, 320)) throw new Error('Mutation sessionId is invalid');
    const snapshot = parseBridgeFleetSnapshot(result.snapshot);
    this.snapshot = snapshot;
    this.cacheSavedAt = new Date().toISOString();
    this.status = 'live';
    this.errorCode = '';
    this.saveCache(snapshot, this.cacheSavedAt);
    this.finishPendingMutation();
    const output: FleetMutationResult = {
      operationId: result.operationId,
      status: result.status,
      snapshot: toFleetSnapshot(snapshot, this.options.launch.distro),
      ...(typeof result.scheduleId === 'string' ? { scheduleId: result.scheduleId } : {}),
      ...(typeof result.sessionId === 'string' ? { sessionId: result.sessionId } : {})
    };
    pending.resolve(output);
    this.emitChanged();
  }

  private requestSnapshot(): void {
    if (!this.child || this.child.killed || !this.child.stdin.writable || this.pendingRequestId) return;
    this.requestNumber += 1;
    this.pendingRequestId = `desktop-${this.requestNumber}`;
    const request = {
      protocolVersion: FLEET_PROTOCOL_VERSION,
      type: 'request',
      requestId: this.pendingRequestId,
      method: 'fleet.snapshot',
      timestamp: new Date().toISOString(),
      params: {}
    };
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  private scheduleSettlePoll(): void {
    if (this.settleTimer || this.settlePolls >= 10 || this.stopped) return;
    this.settlePolls += 1;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.requestSnapshot();
    }, 1_000);
    this.settleTimer.unref();
  }

  private checkHeartbeat(): void {
    if (!this.child || Date.now() - this.lastFrameAt <= HEARTBEAT_TIMEOUT_MS) return;
    this.errorCode = 'heartbeat_timeout';
    safeKill(this.child);
  }

  private protocolFailure(code: string): void {
    this.errorCode = code;
    this.status = 'error';
    this.emitChanged();
    safeKill(this.child);
  }

  private disconnect(code: string): void {
    if (!this.child && this.retryTimer) return;
    this.child = null;
    this.pendingRequestId = '';
    this.rejectPendingMutation('bridge_disconnected', 'Fleet bridge disconnected');
    if (this.stopped) return;
    this.errorCode = code;
    if (this.status !== 'error') this.status = this.snapshot ? 'cached' : 'offline';
    this.emitChanged();
    const delay = RECONNECT_DELAYS_MS[Math.min(this.retryAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startChild();
    }, delay);
    this.retryTimer.unref();
  }

  private finishPendingMutation(): void {
    if (this.pendingMutation) clearTimeout(this.pendingMutation.timeout);
    this.pendingMutation = null;
    this.pendingRequestId = '';
  }

  private rejectPendingMutation(code: string, message: string): void {
    const pending = this.pendingMutation;
    if (!pending) return;
    this.finishPendingMutation();
    pending.reject(new FleetMutationError(code, message));
  }

  private loadCache(): void {
    try {
      const envelope = object(JSON.parse(readFileSync(this.options.cachePath, 'utf8')) as unknown, 'cache');
      exactKeys(envelope, ['cacheVersion', 'protocolVersion', 'savedAt', 'snapshot'], 'cache');
      if (envelope.cacheVersion !== 1 || envelope.protocolVersion !== 1 || typeof envelope.savedAt !== 'string') {
        throw new Error('Unsupported fleet cache');
      }
      this.snapshot = parseBridgeFleetSnapshot(envelope.snapshot);
      this.cacheSavedAt = envelope.savedAt;
      this.status = 'cached';
    } catch {
      this.snapshot = null;
      this.cacheSavedAt = null;
    }
  }

  private saveCache(snapshot: BridgeFleetSnapshot, savedAt: string): void {
    const envelope: CacheEnvelope = { cacheVersion: 1, protocolVersion: 1, savedAt, snapshot };
    const temporary = `${this.options.cachePath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.options.cachePath), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.options.cachePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* no temporary file */ }
      this.options.logger.warn('Could not save verified fleet cache', error);
    }
  }

  private emitChanged(): void {
    this.emit('changed', this.getView());
  }
}

export function fleetBridgeLaunchFromSettings(settings: WidgetSettings): FleetBridgeLaunch {
  const profile = settings.codexProfiles.find((item) => item.enabled && item.distro && item.user && item.home)
    ?? settings.codexProfiles.find((item) => item.distro && item.user && item.home);
  const distro = process.env.AGENT_FLEET_WSL_DISTRO || profile?.distro || 'Ubuntu';
  const args = profile
    ? ['-d', distro, '-u', profile.user, '--', `${profile.home}/.local/bin/wtmux-bridge`, '--stdio']
    : ['-d', distro, '--cd', '~', '--', '.local/bin/wtmux-bridge', '--stdio'];
  return { command: 'wsl.exe', args, distro };
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function safeToken(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeKill(child: ChildProcessWithoutNullStreams | null): void {
  if (!child) return;
  try { child.kill(); } catch { /* process never started or already exited */ }
}
