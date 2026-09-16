import { describe, expect, it } from 'vitest';
import { connectArguments, parseConnectResult } from '../src/shared/fleet-connect';
import { transportRecovery } from '../src/shared/transport-contract';

const discovery = { schemaVersion: 1, viaHostId: 'paired-host', nodes: [
  { nodeId: 'node-new', name: 'New host', address: 'new.tailnet.ts.net', ip: '100.64.0.9', platform: 'linux', online: true, hostId: '' }
] };

describe('Tailnet host setup', () => {
  it('discovers candidates without silently pairing them', () => {
    const result = parseConnectResult(JSON.stringify(discovery));
    expect(result.nodes?.[0]).toMatchObject({ nodeId: 'node-new', online: true, hostId: '' });
    expect(result.review).toBeUndefined();
  });
  it('requires a reviewed identity and bounded account selection', () => {
    expect(connectArguments({ action: 'review', nodeId: 'node-new', username: 'tester' })).toEqual([
      'review', '--node-id', 'node-new', '--username', 'tester'
    ]);
    for (const value of [
      { action: 'review', nodeId: 'node-new', username: 'tester;command' },
      { action: 'pair', reviewId: '../../unreviewed' },
      { action: 'repair', hostId: 'host', bundle: '/untrusted.tar' }
    ]) expect(() => connectArguments(value)).toThrow();
  });
  it('rejects ambiguous discovery and a non-boolean reachability claim', () => {
    expect(() => parseConnectResult(JSON.stringify({ ...discovery, nodes: [...discovery.nodes, ...discovery.nodes] }))).toThrow();
    expect(() => parseConnectResult(JSON.stringify({ ...discovery, nodes: [{ ...discovery.nodes[0], online: 'true' }] }))).toThrow();
  });
  it('reports missing host dependencies after runtime repair', () => {
    expect(parseConnectResult(JSON.stringify({ schemaVersion: 1, status: 'repaired', hostId: 'host', missingTools: ['tmux'] })).message).toContain('Install tmux');
    expect(transportRecovery('HOST_RESPONSE_INVALID')?.actionKind).toBe('retry');
    expect(transportRecovery('HOST_RUNTIME_INCOMPATIBLE')?.action).toContain('Diagnostics');
  });
});
