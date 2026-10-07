import type { ConversationItem } from './conversation';

export interface CachedConversationContent {
  items: ConversationItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Process-local content only. Cached provider state never authorizes actions. */
export class ConversationContentCache {
  private readonly entries = new Map<string, string>();
  static readonly maximumEntries = 4;
  static readonly maximumEntryBytes = 256 * 1024;

  put(binding: string, content: CachedConversationContent): void {
    const encoded = JSON.stringify({ ...content, items: content.items.slice(-20) });
    this.entries.delete(binding);
    if (!binding || new TextEncoder().encode(encoded).byteLength > ConversationContentCache.maximumEntryBytes) return;
    this.entries.set(binding, encoded);
    while (this.entries.size > ConversationContentCache.maximumEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  get(binding: string): CachedConversationContent | undefined {
    const encoded = this.entries.get(binding);
    if (!encoded) return undefined;
    this.entries.delete(binding);
    this.entries.set(binding, encoded);
    return JSON.parse(encoded) as CachedConversationContent;
  }

  remove(binding: string): void { this.entries.delete(binding); }
  removeSession(identity: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(`${identity}\0`)) this.entries.delete(key);
  }
  clear(): void { this.entries.clear(); }
}
