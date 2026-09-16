import type { FleetEndpoint, FleetPhysicalHost, FleetSnapshot } from './fleet';

export type StableTransportErrorCode =
  | 'NETWORK_UNREACHABLE'
  | 'DNS_UNAVAILABLE'
  | 'SSH_AUTH_REQUIRED'
  | 'SSH_CHECK_REQUIRED'
  | 'HOST_KEY_CHANGED'
  | 'TTY_UNAVAILABLE'
  | 'HOST_RUNTIME_MISSING'
  | 'HOST_RUNTIME_INCOMPATIBLE'
  | 'HOST_RESPONSE_INVALID'
  | 'HOST_RUNTIME_UNAVAILABLE'
  | 'TMUX_UNAVAILABLE'
  | 'ENDPOINT_REVERIFY_REQUIRED'
  | 'ENDPOINT_TRUST_UNAVAILABLE'
  | 'HANDSHAKE_TIMEOUT'
  | 'HEARTBEAT_TIMEOUT'
  | 'SNAPSHOT_TIMEOUT'
  | 'LOCAL_RUNTIME_UNAVAILABLE'
  | 'REGISTRY_INVALID'
  | 'ENDPOINT_UNSUPPORTED';

export interface TransportRecovery {
  title: string;
  action: string;
  actionKind: 'retry' | 'review' | 'rollback';
}

export const TRANSPORT_RECOVERY: Readonly<Record<StableTransportErrorCode, TransportRecovery>> = {
  ENDPOINT_UNSUPPORTED: {
    title: 'No compatible host route', action: 'Verify an OpenSSH endpoint for this host', actionKind: 'review'
  },
  NETWORK_UNREACHABLE: {
    title: 'Private network unavailable',
    action: 'Waiting for host contact; retrying automatically',
    actionKind: 'retry'
  },
  DNS_UNAVAILABLE: {
    title: 'Endpoint name unavailable',
    action: 'Retry endpoint lookup',
    actionKind: 'retry'
  },
  SSH_AUTH_REQUIRED: {
    title: 'SSH authentication required',
    action: 'Review SSH access',
    actionKind: 'review'
  },
  SSH_CHECK_REQUIRED: {
    title: 'SSH approval required',
    action: 'Complete browser approval',
    actionKind: 'review'
  },
  HOST_KEY_CHANGED: {
    title: 'Endpoint identity changed',
    action: 'Re-verify before connecting',
    actionKind: 'review'
  },
  TTY_UNAVAILABLE: {
    title: 'Terminal unavailable on this SSH engine',
    action: 'Select OpenSSH',
    actionKind: 'review'
  },
  HOST_RUNTIME_MISSING: {
    title: 'Host runtime missing',
    action: 'Repair the host runtime',
    actionKind: 'review'
  },
  HOST_RUNTIME_INCOMPATIBLE: {
    title: 'Host protocols need attention',
    action: 'Run Diagnostics or Repair host',
    actionKind: 'review'
  },
  HOST_RESPONSE_INVALID: { title: 'Host returned an invalid response', action: 'Retrying automatically; open Diagnostics if this continues', actionKind: 'retry' },
  HOST_RUNTIME_UNAVAILABLE: { title: 'Host service is not ready', action: 'Retrying automatically; open Diagnostics if this continues', actionKind: 'retry' },
  TMUX_UNAVAILABLE: {
    title: 'tmux unavailable',
    action: 'Repair the host session service',
    actionKind: 'review'
  },
  ENDPOINT_REVERIFY_REQUIRED: { title: 'Endpoint verification required', action: 'Verify this host before connecting', actionKind: 'review' },
  ENDPOINT_TRUST_UNAVAILABLE: { title: 'Host key unavailable', action: 'Retry when the host is reachable', actionKind: 'retry' },
  HANDSHAKE_TIMEOUT: { title: 'Host handshake timed out', action: 'Retry the host connection', actionKind: 'retry' },
  HEARTBEAT_TIMEOUT: { title: 'Host contact lost', action: 'Retry the host connection', actionKind: 'retry' },
  SNAPSHOT_TIMEOUT: { title: 'Session inventory timed out', action: 'Retry session discovery', actionKind: 'retry' },
  LOCAL_RUNTIME_UNAVAILABLE: { title: 'Local runtime unavailable', action: 'Repair the built-in runtime', actionKind: 'review' },
  REGISTRY_INVALID: { title: 'Fleet configuration unavailable', action: 'Review or restore the last verified configuration', actionKind: 'review' }
};

const LEGACY_CODES: Readonly<Record<string, StableTransportErrorCode>> = {
  bridge_disconnected: 'NETWORK_UNREACHABLE',
  runtime_unavailable: 'LOCAL_RUNTIME_UNAVAILABLE',
  connection_failed: 'NETWORK_UNREACHABLE',
  heartbeat_timeout: 'NETWORK_UNREACHABLE',
  unreachable: 'NETWORK_UNREACHABLE',
  auth_failure: 'SSH_AUTH_REQUIRED',
  protocol_error: 'HOST_RUNTIME_INCOMPATIBLE',
  missing_host_runtime: 'HOST_RUNTIME_MISSING'
};

export function stableTransportCode(value: string): StableTransportErrorCode | null {
  if (value in TRANSPORT_RECOVERY) return value as StableTransportErrorCode;
  return LEGACY_CODES[value] ?? null;
}

export function transportRecovery(value: string): TransportRecovery | null {
  const code = stableTransportCode(value);
  return code ? TRANSPORT_RECOVERY[code] : null;
}

export function selectedTransportEndpoint(
  snapshot: FleetSnapshot,
  host: FleetPhysicalHost
): FleetEndpoint | undefined {
  for (const endpointId of host.endpointIds) {
    const endpoint = snapshot.endpoints.find((candidate) => candidate.id === endpointId);
    if (endpoint) return endpoint;
  }
  return snapshot.endpoints.find((endpoint) => endpoint.physicalHostId === host.id);
}

export function transportEndpointLabel(endpoint: FleetEndpoint | undefined): string {
  if (!endpoint) return 'No selected endpoint';
  const engine = endpoint.sshEngine === 'openssh' ? 'OpenSSH' : 'Tailscale SSH';
  const network = endpoint.network === 'tailnet'
    ? 'Tailnet'
    : endpoint.network === 'direct'
      ? 'Direct SSH'
      : 'Local';
  return `${engine} over ${network}`;
}

export function transportRecoveryDetail(
  snapshot: FleetSnapshot,
  host: FleetPhysicalHost
): string | null {
  const endpoint = selectedTransportEndpoint(snapshot, host);
  const recovery = transportRecovery(endpoint?.errorCode || host.errorCode);
  if (recovery) return `${recovery.title} · ${recovery.action}`;
  if (endpoint && endpoint.identityState !== 'verified') {
    return `${transportEndpointLabel(endpoint)} · Endpoint identity needs verification`;
  }
  return host.status === 'healthy' ? null : `${host.status} · Showing last known data`;
}
