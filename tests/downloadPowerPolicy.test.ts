import { describe, expect, it, vi } from 'vitest';
import { DownloadPowerPolicy } from '../src/main/download-power-policy';

describe('download power policy', () => {
  it('blocks only application suspension while at least one download is active', () => {
    const active = new Set<number>();
    const blocker = {
      start: vi.fn((_type: 'prevent-app-suspension') => { active.add(7); return 7; }),
      stop: vi.fn((id: number) => { active.delete(id); }),
      isStarted: vi.fn((id: number) => active.has(id))
    };
    const policy = new DownloadPowerPolicy(blocker);
    policy.update({ id: 'one', state: 'running' });
    policy.update({ id: 'two', state: 'running' });
    expect(blocker.start).toHaveBeenCalledOnce();
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(policy.status()).toEqual({ activeDownloads: 2, suspensionBlocked: true, displayBlocked: false });
    policy.update({ id: 'one', state: 'completed' });
    expect(blocker.stop).not.toHaveBeenCalled();
    policy.update({ id: 'two', state: 'failed' });
    expect(blocker.stop).toHaveBeenCalledWith(7);
    expect(policy.status().displayBlocked).toBe(false);
  });

  it('releases the lease on disposal', () => {
    const blocker = { start: vi.fn(() => 3), stop: vi.fn(), isStarted: vi.fn(() => true) };
    const policy = new DownloadPowerPolicy(blocker);
    policy.update({ id: 'one', state: 'running' });
    policy.dispose();
    expect(blocker.stop).toHaveBeenCalledWith(3);
  });
});
