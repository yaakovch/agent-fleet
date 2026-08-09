import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConversationFrame } from '../src/shared/conversation';
import { parseBridgeFleetSnapshot, toFleetSnapshot } from '../src/shared/fleet-protocol';
import {
  assertIpcEventPayload,
  assertIpcPayload,
  MAX_IPC_ATTACHMENT_BYTES
} from '../src/shared/ipc-validation';

describe('renderer IPC payload limits', () => {
  it('accepts normal structured arguments and the bounded attachment channel', () => {
    expect(() => assertIpcPayload('terminal:input', ['tab-1', 'hello'])).not.toThrow();
    expect(() => assertIpcPayload('conversation:stageBytes', [
      'tab-1', 'image.png', 'image/png', new Uint8Array(MAX_IPC_ATTACHMENT_BYTES)
    ])).not.toThrow();
  });

  it('rejects oversized strings, collections, binary payloads, depth, and cycles', () => {
    expect(() => assertIpcPayload('terminal:input', ['x'.repeat(128 * 1024 + 1)])).toThrow(/string/i);
    expect(() => assertIpcPayload('terminal:syncBindings', [Array.from({ length: 257 }, () => 'tab')])).toThrow(/array/i);
    expect(() => assertIpcPayload('terminal:input', [new Uint8Array(1)])).toThrow(/binary/i);
    expect(() => assertIpcPayload('conversation:stageBytes', [
      'tab-1', 'image.png', 'image/png', new Uint8Array(MAX_IPC_ATTACHMENT_BYTES + 1)
    ])).toThrow(/binary/i);
    let deep: unknown = 'leaf';
    for (let index = 0; index < 10; index += 1) deep = { value: deep };
    expect(() => assertIpcPayload('limits:saveSettings', [deep])).toThrow(/complex/i);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertIpcPayload('limits:saveSettings', [cyclic])).toThrow(/invalid/i);
  });

  it('accepts a protocol-valid maximum-size conversation event without loosening requests', () => {
    const frame = parseConversationFrame(JSON.stringify({
      protocolVersion: 2,
      type: 'conversation.event',
      session: 'session-1',
      adapter: 'codex',
      item: {
        id: 'item-1',
        kind: 'tool',
        timestamp: '2026-07-29T12:00:00Z',
        role: 'assistant',
        title: 'Tool result',
        text: '',
        detail: 'x'.repeat(131_072),
        state: 'complete',
        tool: 'shell',
        attachments: [],
        choices: []
      }
    }));
    expect(frame).not.toBeNull();
    expect(() => assertIpcEventPayload('conversation:event', { tabId: 'tab-1', frame })).not.toThrow();
    expect(() => assertIpcPayload('conversation:send', ['x'.repeat(131_072)])).toThrow(/string/i);
  });

  it('accepts a protocol-valid fleet event at the collection maximum', () => {
    const raw = JSON.parse(readFileSync(
      join(process.cwd(), 'tests', 'fixtures', 'fleet-snapshot-v1.json'),
      'utf8'
    )) as Record<string, unknown> & { sessions: Array<Record<string, unknown>> };
    const template = raw.sessions[0];
    raw.sessions = Array.from({ length: 500 }, (_, index) => ({
      ...template,
      id: `test-host:session-${index + 1}`,
      internalName: `session-${index + 1}`,
      name: `project:${index + 1}`
    }));
    const snapshot = toFleetSnapshot(parseBridgeFleetSnapshot(raw), 'Test Linux');

    expect(() => assertIpcEventPayload('fleet:stateUpdated', {
      status: 'live',
      snapshot,
      cacheSavedAt: null,
      errorCode: ''
    })).not.toThrow();
    expect(() => assertIpcPayload('limits:saveSettings', [raw.sessions])).toThrow(/array/i);
  });
});
