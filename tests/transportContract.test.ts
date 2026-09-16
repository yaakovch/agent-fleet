import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TRANSPORT_RECOVERY,
  selectedTransportEndpoint,
  stableTransportCode,
  transportEndpointLabel,
  transportRecovery,
  transportRecoveryDetail
} from '../src/shared/transport-contract';
import type { FleetSnapshot } from '../src/shared/fleet';

const fixture = JSON.parse(readFileSync(
  resolve('tests/fixtures/contracts/transport-conformance-v1.json'),
  'utf8'
)) as {
  defaultEngine: string;
  fallbackEngine: string;
  connectionReuseDefault: string;
  transferModeDefault: string;
  failures: Array<{ code: keyof typeof TRANSPORT_RECOVERY; recoveryAction: string }>;
  decisions: Record<string, { state: string; killSwitch: string }>;
};

describe('transport contract', () => {
  it('implements every canonical stable failure with one recovery', () => {
    expect(fixture.defaultEngine).toBe('openssh');
    expect(fixture.fallbackEngine).toBe('tailscale-cli');
    expect(Object.keys(TRANSPORT_RECOVERY)).toEqual(expect.arrayContaining(fixture.failures.map((failure) => failure.code)));
    for (const failure of fixture.failures) {
      expect(transportRecovery(failure.code)?.action).toBeTruthy();
    }
  });

  it('maps every discovery phase failure to a recovery', () => {
    for (const code of ['ENDPOINT_REVERIFY_REQUIRED', 'ENDPOINT_TRUST_UNAVAILABLE', 'ENDPOINT_UNSUPPORTED', 'HANDSHAKE_TIMEOUT', 'HEARTBEAT_TIMEOUT', 'SNAPSHOT_TIMEOUT', 'LOCAL_RUNTIME_UNAVAILABLE', 'REGISTRY_INVALID'] ) expect(transportRecovery(code)?.action).toBeTruthy();
  });

  it('keeps unproven optimizations disabled behind declared kill switches', () => {
    expect(fixture.connectionReuseDefault).toBe('disabled');
    expect(fixture.transferModeDefault).toBe('stream');
    expect(fixture.decisions.connectionReuse).toMatchObject({ state: 'disabled', killSwitch: 'WTMUX_SSH_REUSE' });
    expect(fixture.decisions.sftp).toMatchObject({ state: 'rejected', killSwitch: 'WTMUX_TRANSFER_MODE' });
  });

  it('maps legacy errors and presents only the selected endpoint', () => {
    expect(stableTransportCode('auth_failure')).toBe('SSH_AUTH_REQUIRED');
    const snapshot = {
      physicalHosts: [{
        id: 'gaming', name: 'Gaming', platform: 'wsl', status: 'offline', lastSeenAt: null,
        errorCode: 'HOST_KEY_CHANGED', endpointIds: ['openssh', 'fallback'],
        executionTargetIds: ['linux'], legacyHostIds: ['gaming-ubuntu']
      }],
      endpoints: [{
        id: 'openssh', physicalHostId: 'gaming', network: 'tailnet', address: 'synthetic.invalid',
        port: 22, sshEngine: 'openssh', authentication: 'tailnet-ssh', status: 'offline',
        identityState: 'reverify-required', sshHostKeySha256: '', tailscaleNodeId: '',
        errorCode: 'HOST_KEY_CHANGED'
      }, {
        id: 'fallback', physicalHostId: 'gaming', network: 'tailnet', address: 'synthetic.invalid',
        port: 22, sshEngine: 'tailscale-cli', authentication: 'tailnet-ssh', status: 'offline',
        identityState: 'unverified', sshHostKeySha256: '', tailscaleNodeId: '', errorCode: ''
      }]
    } as FleetSnapshot;
    const host = snapshot.physicalHosts[0];
    expect(selectedTransportEndpoint(snapshot, host)?.id).toBe('openssh');
    expect(transportEndpointLabel(snapshot.endpoints[0])).toBe('OpenSSH over Tailnet');
    expect(transportRecoveryDetail(snapshot, host)).toBe('Endpoint identity changed · Re-verify before connecting');
  });
});
