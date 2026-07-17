import type { ConversationItem, ConversationQuestion } from './conversation';

export const LOCAL_SUGGESTION_MAX_MESSAGES = 12;
export const LOCAL_SUGGESTION_MAX_CONTEXT_BYTES = 12 * 1024;
export const LOCAL_SUGGESTION_MAX_RESULTS = 3;
export const LOCAL_SUGGESTION_MAX_RESULT_CHARS = 500;

export type LocalSuggestionBackend = 'managedLlamaCpp' | 'openAICompatible';
export type LocalSuggestionTarget =
  | { kind: 'composer' }
  | { kind: 'question'; itemId: string; questionId: string; prompt: string };

export interface LocalSuggestionMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface LocalSuggestionRequest {
  requestId: string;
  tabId: string;
  revision: string;
  target: LocalSuggestionTarget;
  messages: LocalSuggestionMessage[];
}

export interface LocalSuggestionResult {
  ok: boolean;
  requestId: string;
  revision: string;
  suggestions: string[];
  message: string;
}

export interface LocalSuggestionSettingsView {
  version: 1;
  enabled: boolean;
  backend: LocalSuggestionBackend;
  managed: { executablePath: string; modelPath: string };
  external: { baseUrl: string; modelId: string; tokenConfigured: boolean };
}

export interface LocalSuggestionSettingsInput extends LocalSuggestionSettingsView {
  external: LocalSuggestionSettingsView['external'] & { bearerToken?: string; clearToken?: boolean };
}

export interface LocalSuggestionOperationResult {
  ok: boolean;
  message: string;
  settings: LocalSuggestionSettingsView;
}

export function createDefaultLocalSuggestionSettings(): LocalSuggestionSettingsView {
  return {
    version: 1,
    enabled: false,
    backend: 'managedLlamaCpp',
    managed: { executablePath: '', modelPath: '' },
    external: { baseUrl: 'http://127.0.0.1:8080', modelId: '', tokenConfigured: false }
  };
}

export function conversationSuggestionContext(items: ConversationItem[]): LocalSuggestionMessage[] {
  const messages = items
    .filter((item) => item.kind === 'message' && (item.role === 'user' || item.role === 'assistant'))
    .map((item) => ({ role: item.role as LocalSuggestionMessage['role'], text: cleanContextText(item.text || item.detail) }))
    .filter((message) => Boolean(message.text));
  return boundSuggestionContext(messages);
}

export function boundSuggestionContext(messages: LocalSuggestionMessage[]): LocalSuggestionMessage[] {
  const selected: LocalSuggestionMessage[] = [];
  let bytes = 0;
  for (const message of messages.slice(-LOCAL_SUGGESTION_MAX_MESSAGES).reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = cleanContextText(message.text);
    if (!text) continue;
    const overhead = utf8Length(message.role) + 2;
    const available = LOCAL_SUGGESTION_MAX_CONTEXT_BYTES - bytes - overhead;
    if (available <= 0) break;
    const bounded = truncateUtf8(text, available);
    if (!bounded) break;
    selected.unshift({ role: message.role, text: bounded });
    bytes += overhead + utf8Length(bounded);
  }
  return selected;
}

export function canSuggestForComposer(items: ConversationItem[], draft: string): boolean {
  if (draft.trim()) return false;
  const latest = items.filter((item) =>
    item.kind === 'message' && (item.role === 'user' || item.role === 'assistant') && Boolean((item.text || item.detail).trim())
  ).at(-1);
  return latest?.role === 'assistant' && latest.state === 'complete';
}

export function canSuggestForQuestion(question: ConversationQuestion | undefined, draft: string): boolean {
  return Boolean(question && question.type === 'text' && !question.allowOther && !draft.trim());
}

export function localSuggestionPrompt(request: LocalSuggestionRequest): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const system = [
    'You draft possible replies for the human user in an AI coding conversation.',
    'Return JSON only: {"suggestions":["..."]}.',
    'Provide 1 to 3 concise, conservative, meaningfully distinct first-person replies.',
    'Never claim actions, facts, preferences, authorization, or verification that the user did not state.',
    'Do not answer as the assistant. Do not include markdown fences or explanations.'
  ].join(' ');
  const messages = boundSuggestionContext(request.messages).map((message) => ({
    role: message.role,
    content: message.text
  }));
  if (request.target.kind === 'question') {
    messages.push({ role: 'user', content: `Structured question to answer: ${cleanContextText(request.target.prompt)}` });
  }
  return [{ role: 'system', content: system }, ...messages];
}

export function parseLocalSuggestions(value: unknown): string[] {
  let source = value;
  if (typeof source === 'string') {
    const text = source.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    try { source = JSON.parse(text); }
    catch { source = text.split(/\r?\n/u).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, '')); }
  }
  const candidates = Array.isArray(source) ? source
    : source && typeof source === 'object' && Array.isArray((source as { suggestions?: unknown }).suggestions)
      ? (source as { suggestions: unknown[] }).suggestions : [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const cleaned = candidate.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, LOCAL_SUGGESTION_MAX_RESULT_CHARS);
    const key = cleaned.toLocaleLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key); result.push(cleaned);
    if (result.length === LOCAL_SUGGESTION_MAX_RESULTS) break;
  }
  return result;
}

export function isLoopbackSuggestionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    if (host === 'localhost' || host === '::1') return true;
    const parts = host.split('.').map(Number);
    return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 127;
  } catch { return false; }
}

function cleanContextText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let low = 0; let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Length(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low).trimEnd();
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
