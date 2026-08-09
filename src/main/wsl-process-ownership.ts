import { createHash } from 'node:crypto';

export type WslProcessReleaseCause =
  | 'detach'
  | 'cancel'
  | 'tmux_kill'
  | 'wsl_shutdown'
  | 'host_restart'
  | 'app_shutdown'
  | 'timeout'
  | 'protocol_failure'
  | 'superseded';

export interface KillableWslProcess {
  kill(signal?: 'SIGTERM' | 'SIGKILL'): unknown;
  once?(event: 'exit' | 'close' | 'error', listener: () => void): unknown;
}

export interface WslProcessOwnershipSnapshot {
  active: number;
  owners: Record<string, number>;
  releases: Record<WslProcessReleaseCause, number>;
  forcedTerminations?: number;
  abandoned?: number;
}

export interface WslProcessOwnershipOptions {
  terminationGraceMs?: number;
  forcedTerminationGraceMs?: number;
}

const CAUSES: WslProcessReleaseCause[] = [
  'detach', 'cancel', 'tmux_kill', 'wsl_shutdown', 'host_restart',
  'app_shutdown', 'timeout', 'protocol_failure', 'superseded'
];
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_FORCED_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const OWNER_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/u;

/**
 * Tracks app-owned WSL launcher/PTY handles without discovering or touching
 * unrelated processes. A termination request keeps its lease until exit/close,
 * including while a replacement generation for the same owner is active.
 */
export class WslProcessOwnership {
  private readonly active = new Map<KillableWslProcess, {
    owner: string;
    releaseCause?: WslProcessReleaseCause;
    escalationTimer?: NodeJS.Timeout;
    abandonmentTimer?: NodeJS.Timeout;
  }>();
  private readonly releaseCounts = Object.fromEntries(
    CAUSES.map((cause) => [cause, 0])
  ) as Record<WslProcessReleaseCause, number>;
  private readonly terminationGraceMs: number;
  private readonly forcedTerminationGraceMs: number;
  private forcedTerminations = 0;
  private abandoned = 0;
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: WslProcessOwnershipOptions = {}) {
    this.terminationGraceMs = boundedDelay(
      options.terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS,
      'WSL termination grace'
    );
    this.forcedTerminationGraceMs = boundedDelay(
      options.forcedTerminationGraceMs,
      DEFAULT_FORCED_TERMINATION_GRACE_MS,
      'WSL forced-termination grace'
    );
  }

  own(owner: string, child: KillableWslProcess): void {
    if (!OWNER_PATTERN.test(owner)) throw new Error('WSL process owner is invalid');
    if (this.active.has(child)) throw new Error('WSL process is already owned');
    // A UI slot may replace its WSL process before the old exit event arrives.
    // Supersede only that exact owner; distinct tabs and deliberate duplicate
    // session attachments use distinct owner keys and remain independent.
    this.releaseOwner(owner, 'superseded');
    this.active.set(child, { owner });
    child.once?.('exit', () => this.forget(child));
    child.once?.('close', () => this.forget(child));
    // ChildProcess emits `error` for failed spawn/kill/send operations, not only
    // for process exit. Keep the lease until the subsequent close/exit event.
    child.once?.('error', () => undefined);
  }

  forget(child: KillableWslProcess): void {
    const lease = this.active.get(child);
    if (!lease) return;
    if (lease.escalationTimer) clearTimeout(lease.escalationTimer);
    if (lease.abandonmentTimer) clearTimeout(lease.abandonmentTimer);
    this.active.delete(child);
    this.notifyIdle();
  }

  release(child: KillableWslProcess | null | undefined, cause: WslProcessReleaseCause): boolean {
    if (!child) return false;
    const lease = this.active.get(child);
    if (!lease) return false;
    if (lease.releaseCause) return true;
    lease.releaseCause = cause;
    this.releaseCounts[cause] += 1;
    try {
      child.kill('SIGTERM');
    } catch {
      // The process exited between ownership resolution and termination.
    }
    if (this.active.get(child) !== lease) return true;
    lease.escalationTimer = setTimeout(() => {
      if (this.active.get(child) !== lease) return;
      lease.escalationTimer = undefined;
      this.forcedTerminations += 1;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may have exited without delivering a close event.
      }
      if (this.active.get(child) !== lease) return;
      lease.abandonmentTimer = setTimeout(() => {
        if (this.active.get(child) !== lease) return;
        lease.abandonmentTimer = undefined;
        this.abandoned += 1;
        this.active.delete(child);
        this.notifyIdle();
      }, this.forcedTerminationGraceMs);
      lease.abandonmentTimer.unref();
    }, this.terminationGraceMs);
    lease.escalationTimer.unref();
    return true;
  }

  releaseOwner(owner: string, cause: WslProcessReleaseCause): number {
    const children = [...this.active].filter(([, candidate]) => candidate.owner === owner).map(([child]) => child);
    children.forEach((child) => this.release(child, cause));
    return children.length;
  }

  releaseAll(cause: WslProcessReleaseCause): number {
    const children = [...this.active.keys()];
    children.forEach((child) => this.release(child, cause));
    return children.length;
  }

  /**
   * Requests termination for every currently owned process and waits until all
   * leases have either observed exit/close or reached the abandonment deadline.
   * The caller still has a hard deadline so application shutdown cannot wedge.
   */
  async releaseAllAndWait(
    cause: WslProcessReleaseCause,
    timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS
  ): Promise<boolean> {
    const deadlineMs = boundedDelay(timeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, 'WSL drain timeout');
    this.releaseAll(cause);
    if (this.active.size === 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (idle: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(check);
        resolve(idle);
      };
      const check = (): void => {
        if (this.active.size === 0) finish(true);
      };
      const timer = setTimeout(() => finish(this.active.size === 0), deadlineMs);
      this.idleWaiters.add(check);
      check();
    });
  }

  snapshot(): WslProcessOwnershipSnapshot {
    const owners: Record<string, number> = {};
    for (const lease of this.active.values()) owners[lease.owner] = (owners[lease.owner] ?? 0) + 1;
    return {
      active: this.active.size,
      owners,
      releases: { ...this.releaseCounts },
      forcedTerminations: this.forcedTerminations,
      abandoned: this.abandoned
    };
  }

  private notifyIdle(): void {
    if (this.active.size !== 0) return;
    for (const waiter of [...this.idleWaiters]) waiter();
  }
}

/**
 * Keeps process owner keys deterministic and within the ownership registry's
 * fixed bound even when a persisted renderer/tab identifier is much longer or
 * contains uppercase characters. Short already-safe identities stay readable.
 */
export function wslProcessOwner(scope: string, identity: string): string {
  if (!/^[a-z][a-z0-9._-]{0,31}$/u.test(scope)) throw new Error('WSL process owner scope is invalid');
  const direct = `${scope}:${identity}`;
  if (OWNER_PATTERN.test(direct)) return direct;
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
  const maximumStemLength = 128 - scope.length - digest.length - 2;
  const stem = identity.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '').slice(0, maximumStemLength) || 'id';
  const owner = `${scope}:${stem}-${digest}`;
  if (!OWNER_PATTERN.test(owner)) throw new Error('WSL process owner could not be derived');
  return owner;
}

function boundedDelay(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 60_000) {
    throw new Error(`${label} is invalid`);
  }
  return selected;
}
