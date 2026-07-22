import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConversationFrame } from '../src/shared/conversation';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', 'contracts', name), 'utf8');

describe('canonical conversation v2 contract', () => {
  it('accepts and round-trips the shared structured-work fixture', () => {
    const parsed = parseConversationFrame(fixture('conversation-structured-work-v2.json'));
    expect(parsed?.type).toBe('conversation.snapshot');
    expect(parsed?.items).toHaveLength(3);
    expect(parseConversationFrame(JSON.stringify(parsed))).not.toBeNull();
  });

  it.each(['conversation-unknown-field-v2.json', 'conversation-item-unknown-field-v2.json'])(
    'rejects shared invalid fixture %s', (name) => {
      expect(parseConversationFrame(fixture(name))).toBeNull();
    }
  );

  it('rejects over-limit frames and nested collections', () => {
    const baseline = JSON.parse(fixture('conversation-structured-work-v2.json'));
    baseline.items[2].questions[0].options = Array.from({ length: 17 }, (_, index) => ({
      id: `option-${index}`, label: `Option ${index}`, description: ''
    }));
    expect(parseConversationFrame(JSON.stringify(baseline))).toBeNull();
    expect(parseConversationFrame(JSON.stringify({
      protocolVersion: 2, type: 'conversation.error', timestamp: '2026-07-22T12:00:00Z',
      error: { code: 'large', message: 'x'.repeat(256 * 1024) }
    }))).toBeNull();
  });
});
