import { describe, expect, it, vi } from 'vitest';
import { retryStaleSessionCreation } from '../src/main/session-create-recovery';

describe('session creation recovery', () => {
  it('refreshes and retries once with a new key only after a stale rejection', async () => {
    const create = vi.fn().mockRejectedValueOnce({ code: 'stale_revision' }).mockResolvedValueOnce('created');
    const refresh = vi.fn().mockResolvedValue(undefined);
    expect(await retryStaleSessionCreation(create, refresh, 'original', () => 'fresh')).toBe('created');
    expect(create.mock.calls).toEqual([['original'], ['fresh']]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each(['timeout', 'unsafe_state', 'host_offline', 'invalid_request'])('never duplicates creation after %s', async (code) => {
    const failure = { code };
    const create = vi.fn().mockRejectedValue(failure);
    const refresh = vi.fn();
    await expect(retryStaleSessionCreation(create, refresh, 'original', () => 'fresh')).rejects.toBe(failure);
    expect(create).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('surfaces a repeated stale rejection rather than looping', async () => {
    const create = vi.fn().mockRejectedValue({ code: 'stale_revision' });
    await expect(retryStaleSessionCreation(create, async () => undefined, 'original', () => 'fresh')).rejects.toEqual({ code: 'stale_revision' });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
