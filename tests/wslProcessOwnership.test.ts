import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  WslProcessOwnership,
  type KillableWslProcess,
  type WslProcessReleaseCause
} from '../src/main/wsl-process-ownership';

function child(): KillableWslProcess & EventEmitter {
  return Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
}

describe('WSL interop process ownership', () => {
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
      expect(ownership.release(process, cause)).toBe(false);
      expect(process.kill).toHaveBeenCalledOnce();
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
    expect(ownership.snapshot().active).toBe(0);
  });

  it('supersedes only the previous generation of the same owner', () => {
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
      active: 2,
      owners: { 'conversation:tab-a': 1, 'conversation:tab-b': 1 },
      releases: { superseded: 1 }
    });
  });
});
