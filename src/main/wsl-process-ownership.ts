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
  kill(signal?: 'SIGTERM'): unknown;
  once?(event: 'exit' | 'error', listener: () => void): unknown;
}

export interface WslProcessOwnershipSnapshot {
  active: number;
  owners: Record<string, number>;
  releases: Record<WslProcessReleaseCause, number>;
}

const CAUSES: WslProcessReleaseCause[] = [
  'detach', 'cancel', 'tmux_kill', 'wsl_shutdown', 'host_restart',
  'app_shutdown', 'timeout', 'protocol_failure', 'superseded'
];

/**
 * Tracks app-owned WSL launcher/PTY handles without discovering or touching
 * unrelated processes. Exit forgets a lease before a replacement can start.
 */
export class WslProcessOwnership {
  private readonly active = new Map<KillableWslProcess, string>();
  private readonly releaseCounts = Object.fromEntries(
    CAUSES.map((cause) => [cause, 0])
  ) as Record<WslProcessReleaseCause, number>;

  own(owner: string, child: KillableWslProcess): void {
    if (!/^[a-z][a-z0-9._:-]{0,127}$/u.test(owner)) throw new Error('WSL process owner is invalid');
    if (this.active.has(child)) throw new Error('WSL process is already owned');
    // A UI slot may replace its WSL process before the old exit event arrives.
    // Supersede only that exact owner; distinct tabs and deliberate duplicate
    // session attachments use distinct owner keys and remain independent.
    this.releaseOwner(owner, 'superseded');
    this.active.set(child, owner);
    child.once?.('exit', () => this.forget(child));
    child.once?.('error', () => this.forget(child));
  }

  forget(child: KillableWslProcess): void {
    this.active.delete(child);
  }

  release(child: KillableWslProcess | null | undefined, cause: WslProcessReleaseCause): boolean {
    if (!child || !this.active.delete(child)) return false;
    this.releaseCounts[cause] += 1;
    try {
      child.kill('SIGTERM');
    } catch {
      // The process exited between ownership resolution and termination.
    }
    return true;
  }

  releaseOwner(owner: string, cause: WslProcessReleaseCause): number {
    const children = [...this.active].filter(([, candidate]) => candidate === owner).map(([child]) => child);
    children.forEach((child) => this.release(child, cause));
    return children.length;
  }

  releaseAll(cause: WslProcessReleaseCause): number {
    const children = [...this.active.keys()];
    children.forEach((child) => this.release(child, cause));
    return children.length;
  }

  snapshot(): WslProcessOwnershipSnapshot {
    const owners: Record<string, number> = {};
    for (const owner of this.active.values()) owners[owner] = (owners[owner] ?? 0) + 1;
    return { active: this.active.size, owners, releases: { ...this.releaseCounts } };
  }
}
