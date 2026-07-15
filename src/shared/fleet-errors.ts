const RETRYABLE_FLEET_CODES = new Set([
  'bridge_disconnected',
  'host_offline',
  'timeout'
]);

export function isRetryableFleetErrorCode(code: string): boolean {
  return RETRYABLE_FLEET_CODES.has(code);
}
