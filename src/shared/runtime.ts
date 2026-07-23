export const ACTIVATED_RUNTIME_ROOT = '.local/share/agent-fleet/wtmux';

export type RuntimeCompatibilityStatus = 'ready' | 'missing' | 'repair-needed' | 'incompatible' | 'busy';

export interface WslRuntimeState {
  status: RuntimeCompatibilityStatus;
  current: string;
  previous: string;
  embeddedVersion: string;
  contractPackageVersion: string;
  sourceCommit: string;
  detail: string;
  error?: string;
}

export function activatedRuntimeCommand(command: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(command)) throw new Error('Runtime command name is invalid');
  return `${ACTIVATED_RUNTIME_ROOT}/current/scripts/${command}`;
}
