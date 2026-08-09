import type { WslRuntimeState } from '../shared/runtime';

export interface RuntimeLifecycleBridge {
  isRunning(): boolean;
  start(): void;
  stop(): void;
}

export interface RuntimeLifecycleOptions {
  bridge(): RuntimeLifecycleBridge;
  runtimeState(): WslRuntimeState;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 6_500;

/**
 * Waits for shutdown work to settle while preserving a hard application-exit
 * deadline. Promise rejections are observed so a failed cleanup cannot create
 * an unhandled rejection or prevent the remaining cleanup from running.
 */
export async function awaitBoundedShutdown(
  tasks: Iterable<PromiseLike<unknown>>,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Shutdown timeout is invalid');
  }
  const settled = Promise.allSettled([...tasks]).then(() => true);
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Coordinates runtime mutations with the single long-lived fleet bridge.
 * Only the newest operation may resume the bridge. If an operation fails
 * before invalidating a previously ready runtime, the bridge is restored.
 */
export class RuntimeLifecycleCoordinator {
  private generation = 0;
  private resumeAfterFailure = false;

  constructor(private readonly options: RuntimeLifecycleOptions) {}

  async maintain(operation: () => Promise<WslRuntimeState>): Promise<WslRuntimeState> {
    const generation = ++this.generation;
    const bridge = this.options.bridge();
    this.resumeAfterFailure ||= bridge.isRunning();
    bridge.stop();

    try {
      const state = await operation();
      if (generation === this.generation) {
        if (state.status === 'ready') this.options.bridge().start();
        this.resumeAfterFailure = false;
      }
      return state;
    } catch (error) {
      if (generation === this.generation) {
        let runtimeRemainsReady = false;
        try {
          runtimeRemainsReady = this.options.runtimeState().status === 'ready';
        } catch {
          // Preserve the original operation error and leave the bridge stopped.
        }
        if (this.resumeAfterFailure && runtimeRemainsReady) this.options.bridge().start();
        this.resumeAfterFailure = false;
      }
      throw error;
    }
  }
}
