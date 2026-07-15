import { describe, expect, it } from 'vitest';
import { isRetryableFleetErrorCode } from '../src/shared/fleet-errors';

describe('fleet failure retryability', () => {
  it('retries only connection and timeout failures', () => {
    expect(isRetryableFleetErrorCode('host_offline')).toBe(true);
    expect(isRetryableFleetErrorCode('bridge_disconnected')).toBe(true);
    expect(isRetryableFleetErrorCode('timeout')).toBe(true);
    expect(isRetryableFleetErrorCode('repository_unavailable')).toBe(false);
    expect(isRetryableFleetErrorCode('invalid_path')).toBe(false);
    expect(isRetryableFleetErrorCode('conflict')).toBe(false);
  });
});
