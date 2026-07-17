import { describe, expect, it } from 'vitest';
import {
  LOCAL_SUGGESTION_MAX_CONTEXT_BYTES,
  boundSuggestionContext,
  canSuggestForComposer,
  canSuggestForQuestion,
  conversationSuggestionContext,
  isLoopbackSuggestionUrl,
  localSuggestionPrompt,
  parseLocalSuggestions
} from '../src/shared/local-suggestions';
import type { ConversationItem, ConversationQuestion } from '../src/shared/conversation';

const item = (value: Partial<ConversationItem>): ConversationItem => ({
  id: 'id', kind: 'message', timestamp: '', role: '', title: '', text: '', detail: '', state: 'complete',
  tool: '', attachments: [], choices: [], ...value
});

describe('local reply suggestions', () => {
  it('keeps only the newest 12 user/assistant messages within 12 KiB', () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const, text: `${index}:${'é'.repeat(2_000)}`
    }));
    const result = boundSuggestionContext(messages);
    expect(result.length).toBeLessThanOrEqual(12);
    expect(result.at(-1)?.text.startsWith('19:')).toBe(true);
    expect(Buffer.byteLength(result.map((value) => `${value.role}:${value.text}`).join(''), 'utf8')).toBeLessThanOrEqual(LOCAL_SUGGESTION_MAX_CONTEXT_BYTES);
  });

  it('excludes tools, plans, attachments, and status rows', () => {
    const result = conversationSuggestionContext([
      item({ id: 'u', role: 'user', text: 'Please fix it' }),
      item({ id: 't', kind: 'tool', role: 'assistant', text: 'secret terminal output' }),
      item({ id: 'p', kind: 'plan', role: 'assistant', text: 'hidden plan' }),
      item({ id: 'a', role: 'assistant', text: 'Which option do you prefer?', attachments: ['image.jpg'] })
    ]);
    expect(result).toEqual([
      { role: 'user', text: 'Please fix it' },
      { role: 'assistant', text: 'Which option do you prefer?' }
    ]);
  });

  it('gates empty composers and pure text questions', () => {
    const assistant = item({ role: 'assistant', text: 'Should I continue?' });
    const question: ConversationQuestion = { id: 'q', header: '', prompt: 'What should change?', type: 'text', required: true, allowOther: false, options: [] };
    expect(canSuggestForComposer([assistant], '')).toBe(true);
    expect(canSuggestForComposer([assistant], 'manual')).toBe(false);
    expect(canSuggestForComposer([assistant, item({ id: 'user', role: 'user', text: 'Please continue' })], '')).toBe(false);
    expect(canSuggestForQuestion(question, '')).toBe(true);
    expect(canSuggestForQuestion({ ...question, type: 'single' }, '')).toBe(false);
  });

  it('builds a conservative JSON-only prompt and includes a text question', () => {
    const prompt = localSuggestionPrompt({ requestId: 'r', tabId: 't', revision: 'v', target: { kind: 'question', itemId: 'i', questionId: 'q', prompt: 'Pick a name' }, messages: [{ role: 'assistant', text: 'What name?' }] });
    expect(prompt[0].content).toContain('Never claim');
    expect(prompt.at(-1)?.content).toContain('Pick a name');
  });

  it('parses JSON or numbered output, deduplicates, and caps results', () => {
    expect(parseLocalSuggestions('{"suggestions":["Yes", "yes", "No", "Maybe", "Extra"]}')).toEqual(['Yes', 'No', 'Maybe']);
    expect(parseLocalSuggestions('1. First\n2. Second')).toEqual(['First', 'Second']);
  });

  it('accepts only loopback HTTP endpoints', () => {
    for (const value of ['http://localhost:8080', 'http://127.0.0.1:1234/v1', 'https://127.42.1.9', 'http://[::1]:8080']) {
      expect(isLoopbackSuggestionUrl(value)).toBe(true);
    }
    for (const value of ['http://192.168.1.2:8080', 'https://example.com', 'file:///tmp/model', 'http://user@localhost']) {
      expect(isLoopbackSuggestionUrl(value)).toBe(false);
    }
  });
});
