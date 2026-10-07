import { describe, expect, it } from 'vitest';
import { ConversationContentCache } from '../src/shared/conversation-content-cache';
import { readFileSync } from 'node:fs';
import type { ConversationItem } from '../src/shared/conversation';

const item = (id: string, text = id): ConversationItem => ({ id, text, kind: 'message', timestamp: '', role: 'assistant', title: '', detail: '', state: 'complete', tool: '', attachments: [], choices: [] });
const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-startup-behavior-v1.json', import.meta.url), 'utf8'));
describe('bounded memory-only Native content', () => {
  it('matches the shared startup limits', () => {
    expect(ConversationContentCache.maximumEntries).toBe(fixture.cache.entries);
    expect(ConversationContentCache.maximumEntryBytes).toBe(fixture.cache.maximumEntryBytes);
  });
  it('isolates returned content and retains only the newest page', () => {
    const cache = new ConversationContentCache();
    cache.put('host/session/conversation', { items: Array.from({ length: 25 }, (_, i) => item(String(i))), nextCursor: 'earlier', hasMore: true });
    const first = cache.get('host/session/conversation')!;
    expect(first.items.map(value => value.id)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 5)));
    first.items[0].text = 'Changed by one renderer';
    expect(cache.get('host/session/conversation')!.items[0].text).toBe('5');
    expect(cache.get('other-host/session/conversation')).toBeUndefined();
    expect(cache.get('host/session/detailed')).toBeUndefined();
  });
  it('evicts the least recently used session and rejects oversized Unicode content', () => {
    const cache = new ConversationContentCache();
    for (let i = 0; i < 4; i++) cache.put(String(i), { items: [item(String(i))], nextCursor: null, hasMore: false });
    cache.get('0');
    cache.put('4', { items: [item('4')], nextCursor: null, hasMore: false });
    expect(cache.get('1')).toBeUndefined();
    expect(cache.get('0')).toBeDefined();
    cache.put('0', { items: [item('huge', '😀'.repeat(100_000))], nextCursor: null, hasMore: false });
    expect(cache.get('0')).toBeUndefined();
  });
});
