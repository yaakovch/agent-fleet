import { describe, expect, it, vi } from 'vitest';
import {
  awaitBoundedShutdown,
  RuntimeLifecycleCoordinator,
  type RuntimeLifecycleBridge
} from '../src/main/runtime-lifecycle';
import type { WslRuntimeState } from '../src/shared/runtime';

const READY_STATE: WslRuntimeState = {
  status: 'ready',
  current: '1.0.0',
  previous: '',
  embeddedVersion: '1.0.0',
  contractPackageVersion: '1.0.0',
  sourceCommit: 'a'.repeat(40),
  detail: 'ready'
};

describe('runtime lifecycle coordinator', () => {
  it('awaits shutdown work but releases the caller at a hard deadline', async () => {
    vi.useFakeTimers();
    await expect(awaitBoundedShutdown([Promise.resolve(), Promise.reject(new Error('ignored'))], 20))
      .resolves.toBe(true);
    const blocked = awaitBoundedShutdown([new Promise(() => undefined)], 20);
    await vi.advanceTimersByTimeAsync(20);
    await expect(blocked).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('starts the fleet bridge after initial runtime provisioning succeeds', async () => {
    const bridge = createBridge(false);
    const coordinator = new RuntimeLifecycleCoordinator({
      bridge: () => bridge,
      runtimeState: () => READY_STATE
    });

    await expect(coordinator.maintain(async () => READY_STATE)).resolves.toEqual(READY_STATE);

    expect(bridge.stop).toHaveBeenCalledOnce();
    expect(bridge.start).toHaveBeenCalledOnce();
  });

  it('restores a previously running bridge when preflight fails but the runtime remains ready', async () => {
    const bridge = createBridge(true);
    const coordinator = new RuntimeLifecycleCoordinator({
      bridge: () => bridge,
      runtimeState: () => READY_STATE
    });

    await expect(coordinator.maintain(async () => {
      throw new Error('embedded descriptor is missing');
    })).rejects.toThrow(/descriptor/u);

    expect(bridge.stop).toHaveBeenCalledOnce();
    expect(bridge.start).toHaveBeenCalledOnce();
  });

  it('leaves the bridge stopped after a failure that invalidates the runtime', async () => {
    const bridge = createBridge(true);
    const coordinator = new RuntimeLifecycleCoordinator({
      bridge: () => bridge,
      runtimeState: () => ({ ...READY_STATE, status: 'repair-needed' })
    });

    await expect(coordinator.maintain(async () => {
      throw new Error('activation failed');
    })).rejects.toThrow(/activation/u);

    expect(bridge.stop).toHaveBeenCalledOnce();
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it('allows only the newest overlapping operation to restart the bridge', async () => {
    const bridge = createBridge(true);
    const first = deferred<WslRuntimeState>();
    const second = deferred<WslRuntimeState>();
    const coordinator = new RuntimeLifecycleCoordinator({
      bridge: () => bridge,
      runtimeState: () => READY_STATE
    });

    const firstResult = coordinator.maintain(() => first.promise);
    const secondResult = coordinator.maintain(() => second.promise);
    first.resolve(READY_STATE);
    await firstResult;
    expect(bridge.start).not.toHaveBeenCalled();

    second.resolve(READY_STATE);
    await secondResult;
    expect(bridge.start).toHaveBeenCalledOnce();
  });
});

function createBridge(initiallyRunning: boolean): RuntimeLifecycleBridge & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  let running = initiallyRunning;
  return {
    isRunning: () => running,
    start: vi.fn(() => { running = true; }),
    stop: vi.fn(() => { running = false; })
  };
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve(value: Value): void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
}
