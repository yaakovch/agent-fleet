export const MAX_IPC_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface PayloadLimits {
  maxTotal: number;
  maxString: number;
  maxBinary: number;
  maxArray: number;
  maxKeys: number;
  maxNodes: number;
  maxDepth: number;
}

const DEFAULT_LIMITS: PayloadLimits = {
  maxTotal: 1024 * 1024,
  maxString: 64 * 1024,
  maxBinary: 0,
  maxArray: 256,
  maxKeys: 128,
  maxNodes: 4_096,
  maxDepth: 8
};

const CHANNEL_LIMITS: Readonly<Record<string, Partial<PayloadLimits>>> = {
  'conversation:copyText': {
    maxString: 128 * 1024
  },
  'conversation:stageBytes': {
    maxTotal: MAX_IPC_ATTACHMENT_BYTES + 16 * 1024,
    maxString: 4_096,
    maxBinary: MAX_IPC_ATTACHMENT_BYTES,
    maxArray: 16
  }
};

const EVENT_CHANNEL_LIMITS: Readonly<Record<string, Partial<PayloadLimits>>> = {
  'conversation:event': {
    maxString: 131_072,
    maxNodes: 32_768,
    maxDepth: 12
  },
  'fleet:stateUpdated': {
    maxTotal: 4 * 1024 * 1024,
    maxString: 131_072,
    maxArray: 512,
    maxNodes: 65_536,
    maxDepth: 12
  }
};

export function assertIpcPayload(channel: string, args: readonly unknown[]): void {
  assertPayload(channel, args, CHANNEL_LIMITS[channel]);
}

export function assertIpcEventPayload(channel: string, value: unknown): void {
  assertPayload(channel, [value], EVENT_CHANNEL_LIMITS[channel]);
}

function assertPayload(channel: string, args: readonly unknown[], overrides?: Partial<PayloadLimits>): void {
  if (!/^[a-z][A-Za-z0-9:-]{0,95}$/u.test(channel)) throw new Error('IPC channel is invalid');
  if (!Array.isArray(args) || args.length > 16) throw new Error('IPC argument list is too large');
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const seen = new WeakSet<object>();
  let total = 0;
  let nodes = 0;

  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) throw new Error('IPC payload is too complex');
    if (value === null || value === undefined || typeof value === 'boolean') {
      total += 1;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('IPC number is invalid');
      total += 8;
    } else if (typeof value === 'string') {
      if (value.length > limits.maxString) throw new Error('IPC string is too large');
      total += value.length * 2;
    } else if (value instanceof Uint8Array) {
      if (!limits.maxBinary || value.byteLength > limits.maxBinary) throw new Error('IPC binary payload is too large');
      total += value.byteLength;
    } else if (Array.isArray(value)) {
      if (value.length > limits.maxArray || seen.has(value)) throw new Error('IPC array is invalid or too large');
      seen.add(value);
      total += value.length * 8;
      for (const item of value) visit(item, depth + 1);
    } else if (typeof value === 'object') {
      if (Object.prototype.toString.call(value) !== '[object Object]' || seen.has(value)) {
        throw new Error('IPC object is invalid');
      }
      seen.add(value);
      const symbols = Object.getOwnPropertySymbols(value);
      const entries = Object.entries(value as Record<string, unknown>);
      if (symbols.length || entries.length > limits.maxKeys) throw new Error('IPC object has too many fields');
      total += entries.length * 16;
      for (const [key, item] of entries) {
        if (key.length > 128) throw new Error('IPC object key is too large');
        total += key.length * 2;
        visit(item, depth + 1);
      }
    } else {
      throw new Error('IPC payload contains an unsupported value');
    }
    if (total > limits.maxTotal) throw new Error('IPC payload is too large');
  };

  visit(args, 0);
}
