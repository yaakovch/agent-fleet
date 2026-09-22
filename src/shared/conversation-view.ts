import type { ConversationItem, ConversationView } from './conversation';

export interface ActivityPage {
  items: ConversationItem[]; cursor: string | null; sourceCursor: string;
  loading: boolean; error: string;
}

/** Shared device budget, no disk cache or extra stream. */
export class ActivityCache {
  private pages = new Map<string, ActivityPage>();
  get(key: string): ActivityPage | undefined { return this.pages.get(key); }
  values(prefix = ""): ActivityPage[] { return [...this.pages].filter(([key]) => key.startsWith(prefix)).map(([, page]) => page); }
  set(key: string, page: ActivityPage): void {
    this.pages.delete(key);
    this.pages.set(key, { ...page, items: page.items.slice(0, 200) });
    while (this.pages.size > 8 || new TextEncoder().encode(JSON.stringify([...this.pages])).length > 4 * 1024 * 1024) {
      this.pages.delete(this.pages.keys().next().value!);
    }
  }
  clear(): void { this.pages.clear(); }
}

export function conversationRows(items: ConversationItem[], view: ConversationView): ConversationItem[] {
  if (view === 'detailed') return items;
  const states = new Map(items.filter((item) => item.activitySummary).map((item) => [item.turnId, item.activitySummary!.state]));
  const progress = new Map<string | undefined, string>();
  for (const item of items) if (item.messagePurpose === 'progress') progress.set(item.turnId, item.id);
  const lastUser = new Map<string, string>();
  for (const item of items) if (item.role === 'user' && item.turnId) lastUser.set(item.turnId, item.id);
  const summaries = new Map(items.filter((item) => item.activitySummary && item.turnId && lastUser.has(item.turnId)).map((item) => [item.turnId!, item]));
  const ordered = items.flatMap((item) => {
    if (item.activitySummary && item.turnId && summaries.has(item.turnId)) return [];
    const summary = item.turnId && lastUser.get(item.turnId) === item.id ? summaries.get(item.turnId) : undefined;
    return summary ? [item, summary] : [item];
  });
  return ordered.filter((item) => {
    if (item.messagePurpose === 'progress') return states.get(item.turnId) !== 'complete' && progress.get(item.turnId) === item.id;
    if (item.kind === 'error' || item.state === 'error') return states.get(item.turnId) !== 'complete';
    return !(item.kind === 'status' && ['Working', 'Done', 'Turn Duration'].includes(item.title));
  });
}
