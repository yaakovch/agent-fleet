import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  createLimitWindow,
  nowUnixSeconds,
  type CodexProfileId,
  type LimitWindowId,
  type ProviderLimitSnapshot
} from '../../shared/limits';

interface JsonRpcResponse {
  id?: string | number | null;
  result?: unknown;
  error?: {
    code?: string | number;
    message?: string;
  };
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

interface GetAccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface WslCodexProfile {
  id: CodexProfileId;
  label: string;
  distro: string;
  user: string;
  home: string;
  codexHome: string;
  executable: string;
}

export interface CodexLaunchSpec {
  command: string;
  args: string[];
}

export const CODEX_PROFILE_TIMEOUT_MS = 8_000;
class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderr = '';
  private pending = new Map<string | number, PendingRequest>();
  private nextId = 1;
  private readonly deadlineAt: number;

  constructor(
    private readonly launch: CodexLaunchSpec,
    timeoutMs: number
  ) {
    this.deadlineAt = Date.now() + timeoutMs;
  }

  async start(): Promise<void> {
    this.child = spawn(this.launch.command, this.launch.args, {
      stdio: 'pipe',
      windowsHide: true
    });

    this.child.stdout.on('data', (chunk: Buffer) => this.handleData(chunk.toString('utf8')));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
    this.child.on('error', (error) => this.rejectPending(error));
    this.child.on('exit', () => {
      const detail = this.stderr.trim();
      this.rejectPending(new Error(detail || 'Codex app-server exited before replying'));
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'limits-widget',
        title: 'Limits Widget',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    });
  }

  async readRateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.request('account/rateLimits/read') as Promise<GetAccountRateLimitsResponse>;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.rejectPending(new Error('Codex app-server disposed'));
    if (!child || child.exitCode !== null) return;

    try {
      child.stdin.end();
    } catch {
      child.kill();
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish();
      }, 500);
      child.once('exit', finish);
    });
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('Codex app-server is not running'));
    const remainingMs = this.deadlineAt - Date.now();
    if (remainingMs <= 0) return Promise.reject(new Error(`Refresh timed out after ${CODEX_PROFILE_TIMEOUT_MS / 1000} seconds`));

    const id = this.nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Refresh timed out after ${CODEX_PROFILE_TIMEOUT_MS / 1000} seconds`));
      }, remainingMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private handleData(data: string): void {
    this.buffer += data;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? String(message.error.code ?? 'Codex error')));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function getWslCodexLaunch(profile: WslCodexProfile): CodexLaunchSpec {
  return {
    command: 'wsl.exe',
    args: [
      '-d',
      profile.distro,
      '-u',
      profile.user,
      '--exec',
      'env',
      `HOME=${profile.home}`,
      `CODEX_HOME=${profile.codexHome}`,
      profile.executable,
      'app-server',
      '--stdio'
    ]
  };
}

export async function collectCodexProfileLimits(
  profile: WslCodexProfile,
  timeoutMs = CODEX_PROFILE_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ProviderLimitSnapshot> {
  const client = new CodexAppServerClient(getWslCodexLaunch(profile), timeoutMs);
  const abort = (): void => { void client.dispose(); };
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await client.start();
    const response = await client.readRateLimits();
    return mapCodexRateLimitsResponse(response, profile);
  } catch (error) {
    return {
      id: profile.id,
      provider: 'codex',
      label: profile.label,
      status: 'error',
      source: 'WSL Codex app-server',
      fetchedAt: null,
      message: formatCodexError(error),
      windows: {}
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    await client.dispose();
  }
}

export function mapCodexRateLimitsResponse(
  response: GetAccountRateLimitsResponse,
  profile: Pick<WslCodexProfile, 'id' | 'label'>
): ProviderLimitSnapshot {
  const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
  const windows = mapCodexWindows(snapshot);
  return {
    id: profile.id,
    provider: 'codex',
    label: profile.label,
    status: Object.keys(windows).length > 0 ? 'ok' : 'unavailable',
    source: 'WSL Codex app-server',
    fetchedAt: nowUnixSeconds(),
    message: Object.keys(windows).length > 0 ? undefined : 'Codex did not return rate-limit windows',
    windows
  };
}

export function mapCodexWindows(
  snapshot: Pick<RateLimitSnapshot, 'primary' | 'secondary'> | null | undefined
): Partial<Record<LimitWindowId, ReturnType<typeof createLimitWindow>>> {
  const windows: Partial<Record<LimitWindowId, ReturnType<typeof createLimitWindow>>> = {};
  const ordered = [snapshot?.primary, snapshot?.secondary].filter(Boolean) as RateLimitWindow[];

  for (const [index, window] of ordered.entries()) {
    const id = inferWindowId(window, index);
    if (windows[id]) continue;
    windows[id] = createLimitWindow(id, window.usedPercent, window.resetsAt, window.windowDurationMins);
  }
  return windows;
}

export function formatCodexError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/token_invalidated|authentication token has been invalidated|401 Unauthorized/i.test(message)) {
    return 'Sign in required (authentication token invalidated)';
  }
  if (/timed out/i.test(message)) return `Refresh timed out after ${CODEX_PROFILE_TIMEOUT_MS / 1000} seconds`;
  const singleLine = message.replace(/\s+/g, ' ').trim();
  return singleLine.length > 180 ? `${singleLine.slice(0, 177)}...` : singleLine;
}

function inferWindowId(window: RateLimitWindow, index: number): LimitWindowId {
  if (window.windowDurationMins !== null) return window.windowDurationMins <= 360 ? 'fiveHour' : 'weekly';
  return index === 0 ? 'fiveHour' : 'weekly';
}
