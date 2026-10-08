import { afterEach, expect, it, vi } from 'vitest';
import { LinuxDemand } from '../src/main/linux-demand';

afterEach(() => vi.useRealTimers());

it('rejects failed startup before an operation and permits an explicit retry', async () => {
  const start = vi.fn().mockRejectedValueOnce(new Error('WSL timed out')).mockResolvedValue(undefined);
  const stop = vi.fn(), error = vi.fn();
  const demand = new LinuxDemand({ start, stop, error });
  demand.setForeground(true);
  await expect(demand.ready()).rejects.toThrow('WSL timed out');
  expect(demand.active).toBe(false);
  expect(demand.failure).toBeInstanceOf(Error);
  expect(stop).toHaveBeenCalledOnce();
  const release = demand.acquire();
  await demand.ready();
  expect(start).toHaveBeenCalledTimes(2);
  expect(demand.failure).toBeUndefined();
  expect(demand.active).toBe(true);
  release();
  demand.setDemand(false, false);
  demand.setDemand(false, false);
  expect(start).toHaveBeenCalledTimes(2);
});

it('never launches for tray-only startup, and coalesces rapid reopen', async () => {
  vi.useFakeTimers();
  const start = vi.fn(async () => {}), stop = vi.fn();
  const demand = new LinuxDemand({ start, stop });
  demand.setForeground(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(start).not.toHaveBeenCalled();
  demand.setForeground(true);
  await demand.ready();
  demand.setForeground(false);
  await vi.advanceTimersByTimeAsync(1999);
  demand.setForeground(true);
  expect(stop).not.toHaveBeenCalled();
  expect(start).toHaveBeenCalledOnce();
  demand.setForeground(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(stop).toHaveBeenCalledOnce();
});

it('holds demand for operations and transfers until their lease ends', async () => {
  vi.useFakeTimers();
  const stop = vi.fn();
  const demand = new LinuxDemand({ start: async () => {}, stop });
  const release = demand.acquire();
  await demand.ready();
  await vi.advanceTimersByTimeAsync(5000);
  expect(stop).not.toHaveBeenCalled();
  release(); release();
  await vi.advanceTimersByTimeAsync(2000);
  expect(stop).toHaveBeenCalledOnce();
});

it('reuses pending startup when reopening after idle without overlapping provisioning', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const start = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const demand = new LinuxDemand({ start, stop: vi.fn() });
  demand.setForeground(true); demand.setForeground(false);
  await vi.advanceTimersByTimeAsync(2000);
  demand.setForeground(true);
  expect(start).toHaveBeenCalledOnce();
  finish(); await demand.ready();
  expect(demand.active).toBe(true);
});

it('rejects a delayed startup after idle and starts one new generation on reopen', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const stop = vi.fn();
  const start = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const demand = new LinuxDemand({ start, stop });
  demand.setForeground(true);
  demand.setForeground(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(demand.active).toBe(false);
  finish();
  await demand.ready();
  expect(stop).toHaveBeenCalledTimes(2);
  demand.setForeground(true);
  expect(start).toHaveBeenCalledTimes(2);
  finish();
  await demand.ready();
});
