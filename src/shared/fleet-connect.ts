export type FleetConnectRequest =
  | { action: 'discover' }
  | { action: 'review'; nodeId: string; username: string }
  | { action: 'pair'; reviewId: string }
  | { action: 'repair'; hostId: string };

export interface TailnetHost {
  nodeId: string; name: string; address: string; ip: string;
  platform: 'linux' | 'windows'; online: boolean; hostId: string;
}

export interface TailnetHostReview {
  reviewId: string; name: string; address: string; username: string;
  runtimePresent: boolean; tmuxPresent: boolean;
}

export interface FleetConnectResult {
  ok: boolean; message: string; nodes?: TailnetHost[]; review?: TailnetHostReview; hostId?: string;
}

export function connectArguments(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Host setup request is invalid');
  const request = value as Record<string, unknown>;
  const fields = Object.keys(request).sort().join(',');
  const token = (key: string, pattern: RegExp): string => {
    const item = request[key];
    if (typeof item !== 'string' || !pattern.test(item)) throw new Error('Host setup selection is invalid');
    return item;
  };
  if (request.action === 'discover' && fields === 'action') return ['discover'];
  if (request.action === 'review' && fields === 'action,nodeId,username') return [
    'review', '--node-id', token('nodeId', /^[A-Za-z0-9_-]{1,160}$/u),
    '--username', token('username', /^[a-z_][a-z0-9_-]{0,63}$/u)
  ];
  if (request.action === 'pair' && fields === 'action,reviewId') return ['pair', '--review-id', token('reviewId', /^[a-f0-9]{32}$/u)];
  if (request.action === 'repair' && fields === 'action,hostId') return ['repair', '--host-id', token('hostId', /^[a-z0-9][a-z0-9._-]{0,63}$/u)];
  throw new Error('Host setup request is invalid');
}

export function parseConnectResult(text: string): FleetConnectResult {
  if (text.length > 1024 * 1024) throw new Error('Host setup result is too large');
  const value = JSON.parse(text) as Record<string, unknown>;
  if (!value || value.schemaVersion !== 1) throw new Error('Host setup result is invalid');
  const safe = (item: unknown, limit: number, empty = false): string => {
    if (typeof item !== 'string' || item.length > limit || (!empty && !item.length) || /[\u0000-\u001f\u007f]/u.test(item)) throw new Error('Host metadata is invalid');
    return item;
  };
  if (Array.isArray(value.nodes) && value.nodes.length <= 256) {
    const nodes = value.nodes.map((raw: unknown): TailnetHost => {
      if (!raw || typeof raw !== 'object') throw new Error('Tailnet host is invalid');
      const node = raw as Record<string, unknown>;
      if (!['linux', 'windows'].includes(String(node.platform)) || typeof node.online !== 'boolean') throw new Error('Tailnet host is invalid');
      return { nodeId: safe(node.nodeId, 160), name: safe(node.name, 128), address: safe(node.address, 253),
        ip: safe(node.ip, 45), platform: node.platform as TailnetHost['platform'], online: node.online, hostId: safe(node.hostId, 64, true) };
    });
    if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) throw new Error('Duplicate Tailnet host');
    return { ok: true, message: 'Tailnet hosts found', nodes };
  }
  if (value.prepared && typeof value.prepared === 'object') {
    const prepared = value.prepared as Record<string, unknown>;
    const record = prepared.record as Record<string, unknown>;
    const reviewId = safe(value.reviewId, 32);
    if (!/^[a-f0-9]{32}$/u.test(reviewId) || !record || typeof prepared.runtimePresent !== 'boolean' || typeof prepared.tmuxPresent !== 'boolean') throw new Error('Host review is invalid');
    return { ok: true, message: 'Review host setup', review: { reviewId, name: safe(record.name, 128),
      address: safe(record.tailscaleNode, 253), username: safe(record.linuxUsername, 64),
      runtimePresent: prepared.runtimePresent, tmuxPresent: prepared.tmuxPresent } };
  }
  if (value.status === 'paired' || value.status === 'repaired') return {
    ok: true, message: value.status === 'paired' ? 'Host paired; reconnecting' :
      Array.isArray(value.missingTools) && value.missingTools.includes('tmux')
        ? 'Runtime repaired. Install tmux on this host to enable sessions.' : 'Host runtime repaired; reconnecting', hostId: safe(value.hostId, 64)
  };
  throw new Error('Host setup returned no result');
}
