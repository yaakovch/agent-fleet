import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWorkspace } from '../src/renderer/src/session-workspace';
import type { ConversationItem } from '../src/shared/conversation';
vi.mock('dompurify', () => ({ default: { sanitize: (value: string) => value } }));
afterEach(() => vi.unstubAllGlobals());
function fixture(count: number) {
  const item: ConversationItem = { id: 'request', kind: 'question', timestamp: '', role: 'assistant',
    title: 'Answer needed', text: '', detail: '', state: 'pending', tool: 'question', attachments: [], choices: [], revision: 'stable',
    questions: Array.from({ length: count }, (_, index) => ({ id: `q${index}`, header: '', prompt: `Choose ${index}`,
      type: 'single' as const, required: true, allowOther: true, options: [{ id: 'a', label: 'First', description: '' }] })) };
  const state = { items: [item], providerState: { mutationsAllowed: true, eventPosition: 10 },
    questionDrafts: new Map(), questionSteps: new Map(), submittingQuestions: new Set(), questionSheetId: item.id, notice: '' };
  // Exercise the production event handlers, replacing only DOM rendering and IPC.
  const workspace = Object.create(SessionWorkspace.prototype) as any;
  Object.assign(workspace, { selectedId: 'session', nativeState: () => state, captureVisibleQuestionDraft: () => {},
    renderSelectedNative: vi.fn(), maybeStartAutomaticSuggestion: () => {} });
  const answer = vi.fn(); vi.stubGlobal('window', { limitsWidget: { answerConversation: answer } });
  return { item, state, workspace, answer };
}
describe('Native question delivery handlers', () => {
  it.each([1, 2, 3, 4, 8])('sends exactly once at the end of %i choices and waits for receipt', async (count) => {
    const { item, state, workspace, answer } = fixture(count);
    let confirm!: (value: unknown) => void;
    answer.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    for (let index = 0; index < count - 1; index++) await workspace.chooseQuestionOption(item, `q${index}`, 'a');
    expect(answer).not.toHaveBeenCalled();
    const pending = workspace.chooseQuestionOption(item, `q${count - 1}`, 'a');
    expect(state.submittingQuestions.has(item.id)).toBe(true);
    expect(state.questionSheetId).toBe(item.id);
    await workspace.chooseQuestionOption(item, `q${count - 1}`, 'a');
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0][4]).toHaveLength(count);
    confirm({ ok: true, message: 'Delivered' }); await pending;
    expect(state.items[0].state).toBe('complete');
    expect(state.questionSheetId).toBe('');
    await workspace.chooseQuestionOption(item, `q${count - 1}`, 'a');
    expect(answer).toHaveBeenCalledTimes(1);
  });
  it('retains answers on rejection and retries the same payload', async () => {
    const { item, state, workspace, answer } = fixture(1);
    answer.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ ok: true, message: 'Delivered' });
    await workspace.chooseQuestionOption(item, 'q0', 'a');
    expect(state.items[0].state).toBe('error');
    expect(state.questionSheetId).toBe(item.id);
    expect(state.submittingQuestions.size).toBe(0);
    await workspace.submitQuestion(state.items[0]);
    expect(answer.mock.calls[1]).toEqual(answer.mock.calls[0]);
    expect(state.items[0].state).toBe('complete');
  });
});
