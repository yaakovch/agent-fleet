import { describe, expect, it } from 'vitest';
import { ActivityCache, conversationRows } from '../src/shared/conversation-view';
import { parseConversationFrame, type ConversationItem } from '../src/shared/conversation';
const message = (id: string, purpose = 'unknown'): ConversationItem => ({ id, kind: 'message', timestamp: 'now', role: 'assistant', title: '', text: id, detail: '', state: '', tool: '', attachments: [], choices: [], turnId: 'turn', messagePurpose: purpose as ConversationItem['messagePurpose'] });
const summary: ConversationItem = { ...message('activity'), kind: 'activity', activitySummary: { turnId: 'turn', state: 'running', toolCount: 1001, changeCount: 2, progressCount: 2, otherCount: 0, partial: false, latestProgress: 'Checking', cursor: 'cursor' } };
describe('Conversation and Detailed views', () => {
  it('keeps only latest identified progress, preserves unknown prose, collapses recovered errors', () => {
    const items = [message('p1', 'progress'), message('unknown'), message('p2', 'progress'), { ...message('error'), kind: 'error' }, summary];
    expect(conversationRows(items, 'conversation').map((x) => x.id)).toEqual(['unknown', 'p2', 'error', 'activity']);
    const complete = items.map((x) => x.activitySummary ? { ...x, activitySummary: { ...x.activitySummary, state: 'complete' as const } } : x);
    expect(conversationRows(complete, 'conversation').map((x) => x.id)).toEqual(['unknown', 'activity']);
    expect(conversationRows(items, 'detailed')).toEqual(items);
  });
  it('parses paged activity and rejects malformed summaries', () => {
    const frame = { protocolVersion: 2, type: 'conversation.activity', timestamp: 'now', session: 's', adapter: 'codex', turnId: 'turn', items: [summary], nextCursor: null, hasMore: false };
    expect(parseConversationFrame(JSON.stringify(frame))?.type).toBe('conversation.activity');
    frame.items = [{ ...summary, activitySummary: { ...summary.activitySummary!, toolCount: -1 } }];
    expect(parseConversationFrame(JSON.stringify(frame))).toBeNull();
  });
  it('bounds activity memory across turns and after refresh', () => {
    const cache = new ActivityCache();
    for (let index = 0; index < 20; index++) cache.set(String(index), { items: Array.from({ length: 300 }, (_, id) => message(String(id))), cursor: null, sourceCursor: 'cursor', loading: false, error: '' });
    expect(cache.values()).toHaveLength(8);
    expect(cache.values().every((x) => x.items.length <= 200)).toBe(true);
    cache.clear(); expect(cache.values()).toHaveLength(0);
  });
});
