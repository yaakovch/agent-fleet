import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WslProcessOwnership,
  wslProcessOwner,
  type KillableWslProcess,
  type WslProcessReleaseCause
} from '../src/main/wsl-process-ownership';

function child(): KillableWslProcess & EventEmitter {
  return Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
}

afterEach(() => vi.useRealTimers());

describe('WSL interop process ownership', () => {
  it('derives stable bounded owner keys for long persisted renderer identities', () => {
    const identity = `Uppercase:${'x'.repeat(320)}`;
    const owner = wslProcessOwner('terminal', identity);
    expect(owner).toHaveLength(128);
    expect(owner).toMatch(/^[a-z][a-z0-9._:-]{0,127}$/u);
    expect(wslProcessOwner('terminal', identity)).toBe(owner);
    expect(wslProcessOwner('terminal', 'short-safe')).toBe('terminal:short-safe');
  });

  it.each<WslProcessReleaseCause>([
    'detach', 'cancel', 'tmux_kill', 'wsl_shutdown', 'host_restart',
    'app_shutdown', 'timeout', 'protocol_failure', 'superseded'
  ])('converges fifty %s cleanup generations without an owned orphan', (cause) => {
    const ownership = new WslProcessOwnership();
    for (let generation = 0; generation < 50; generation += 1) {
      const process = child();
      ownership.own(`stress:${cause}:${generation}`, process);
      expect(ownership.release(process, cause)).toBe(true);
      expect(process.kill).toHaveBeenCalledOnce();
      expect(ownership.snapshot().active).toBe(1);
      expect(ownership.release(process, cause)).toBe(true);
      expect(process.kill).toHaveBeenCalledOnce();
      process.emit('exit');
    }
    expect(ownership.snapshot()).toMatchObject({
      active: 0,
      owners: {},
      releases: { [cause]: 50 }
    });
  });

  it('forgets an exited WSL generation before registering its replacement', () => {
    const ownership = new WslProcessOwnership();
    const first = child();
    ownership.own('control:bridge', first);
    first.emit('exit');
    expect(ownership.snapshot().active).toBe(0);
    const replacement = child();
    ownership.own('control:bridge', replacement);
    expect(ownership.snapshot()).toMatchObject({ active: 1, owners: { 'control:bridge': 1 } });
    expect(ownership.releaseAll('app_shutdown')).toBe(1);
    expect(ownership.snapshot()).toMatchObject({ active: 1, owners: { 'control:bridge': 1 } });
    replacement.emit('exit');
    expect(ownership.snapshot().active).toBe(0);
  });

  it('keeps a superseded generation owned until it actually exits', () => {
    const ownership = new WslProcessOwnership();
    const first = child();
    const independent = child();
    const replacement = child();
    ownership.own('conversation:tab-a', first);
    ownership.own('conversation:tab-b', independent);
    ownership.own('conversation:tab-a', replacement);

    expect(first.kill).toHaveBeenCalledOnce();
    expect(independent.kill).not.toHaveBeenCalled();
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(ownership.snapshot()).toMatchObject({
      active: 3,
      owners: { 'conversation:tab-a': 2, 'conversation:tab-b': 1 },
      releases: { superseded: 1 }
    });
    first.emit('exit');
    expect(ownership.snapshot()).toMatchObject({
      active: 2,
      owners: { 'conversation:tab-a': 1, 'conversation:tab-b': 1 }
    });
  });

  it('does not confuse a child error with confirmed process exit', () => {
    const ownership = new WslProcessOwnership();
    const process = child();
    ownership.own('conversation:tab-a', process);
    ownership.release(process, 'cancel');
    process.emit('error');
    expect(ownership.snapshot()).toMatchObject({
      active: 1,
      owners: { 'conversation:tab-a': 1 },
      releases: { cancel: 1 }
    });
    process.emit('exit');
    expect(ownership.snapshot().active).toBe(0);
  });

  it('escalates and releases ownership by a hard deadline when a child never exits', async () => {
    vi.useFakeTimers();
    const ownership = new WslProcessOwnership({
      terminationGraceMs: 10,
      forcedTerminationGraceMs: 20
    });
    const process = child();
    ownership.own('download:stuck', process);
    ownership.release(process, 'cancel');

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(10);
    expect(process.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(ownership.snapshot()).toMatchObject({
      active: 1,
      forcedTerminations: 1,
      abandoned: 0
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(ownership.snapshot()).toMatchObject({
      active: 0,
      owners: {},
      forcedTerminations: 1,
      abandoned: 1
    });
  });

  it('awaits owned process exit and bounds an unresponsive shutdown drain', async () => {
    vi.useFakeTimers();
    const ownership = new WslProcessOwnership({
      terminationGraceMs: 10,
      forcedTerminationGraceMs: 20
    });
    const exiting = child();
    ownership.own('shutdown:exiting', exiting);
    const drained = ownership.releaseAllAndWait('app_shutdown', 40);
    exiting.emit('exit');
    await expect(drained).resolves.toBe(true);

    const stuck = child();
    ownership.own('shutdown:stuck', stuck);
    const timedOut = ownership.releaseAllAndWait('app_shutdown', 15);
    await vi.advanceTimersByTimeAsync(15);
    await expect(timedOut).resolves.toBe(false);
  });
});
