import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionWorkspace } from '../src/renderer/src/session-workspace';
import { ConfirmedQuestionCompletions, partitionPendingActions, unavailableProviderState, type ConversationItem, type ProviderState } from '../src/shared/conversation';
import type { TerminalTabDescriptor } from '../src/shared/terminal';

vi.mock('dompurify', () => ({ default: { sanitize: (value: string) => value } }));
afterEach(() => vi.unstubAllGlobals());
const verified: ProviderState = { ...unavailableProviderState(), confidence: 'verified', reasonCode: 'VERIFIED', mutationsAllowed: true, fallback: 'none' };
function question(id = 'request', overrides: Partial<ConversationItem> = {}): ConversationItem {
  return { id, kind: 'question', timestamp: '2026-09-22T00:00:00Z', role: 'assistant', title: 'Answer needed',
    text: '', detail: '', state: 'pending', tool: 'question', attachments: [], choices: [], source: 'codex_async_question', revision: 'stable',
    questions: [{ id: 'q1', header: 'Choice', prompt: 'Choose', type: 'single', required: true, allowOther: true,
      options: [{ id: 'a', label: 'First', description: '' }] }], ...overrides };
}
function user(timestamp = '2026-09-22T00:01:00Z'): ConversationItem {
  return { ...question('user'), kind: 'message', role: 'user', text: 'Keep working', timestamp, state: 'complete', source: '' };
}
function fixture() {
  const tab: TerminalTabDescriptor = { id: 'tab', hostId: 'host', sessionId: 'session', internalName: 'internal',
    project: '', label: 'Codex', tool: 'codex', backend: 'linux', viewMode: 'native', status: 'live', statusMessage: '' };
  // Exercise production state initialization, frame handling, sheets and rendering;
  // replace only DOM scheduling, local suggestions and external answer transport.
  const workspace = Object.create(SessionWorkspace.prototype) as any;
  Object.assign(workspace, { tabs: new Map([[tab.id, tab]]), nativeStates: new Map(), selectedId: tab.id,
    savedStates: new Map(), savedRestoreTokens: new Map(), savedTails: new Map(), savedRecovery: new Map(),
    restoredAnchors: new Map(), notificationSessions: new Set(), notificationHandled: new Set(),
    savedQuestionClears: new Map(), savedClearClock: 0,
    nativeView: 'detailed', viewGeneration: 0, localSuggestionSettings: { mode: 'off' },
    suggestionRevision: () => '', maybeStartAutomaticSuggestion: () => {}, queueNativeRender: vi.fn(),
    renderSelectedNative: vi.fn(), captureVisibleQuestionDraft: () => {} });
  const state = workspace.nativeState(tab.id);
  const snapshot = (items: ConversationItem[], providerState: ProviderState | undefined = verified) => workspace.applyConversationFrame(tab.id,
    { protocolVersion: 2, type: 'conversation.snapshot', session: tab.internalName, items, providerState });
  const html = () => workspace.renderNative(tab) as string;
  return { workspace, tab, state, snapshot, html };
}

describe('Native provider discovery through the production frame handler', () => {
  it('shows retained messages while refreshing and keeps mutations disabled', () => {
    const { workspace, state, snapshot, html } = fixture();
    snapshot([{ ...user(), text: 'Retained newest message' }]);
    state.draft = 'Keep this draft';
    state.scrollTop = 42;
    workspace.beginConversationLoading('tab');
    expect(html()).toContain('Retained newest message');
    expect(html()).toContain('Refreshing…');
    expect(html()).not.toContain('Loading conversation…');
    expect(state.draft).toBe('Keep this draft');
    expect(state.scrollTop).toBe(42);
    expect(state.providerState.mutationsAllowed).toBe(false);
    expect(html()).toMatch(/data-action="native-send"[^>]*disabled/);
  });

  it('keeps a cold connection loading and read-only until verified', () => {
    const { workspace, state, tab, snapshot, html } = fixture();
    expect(state.providerStateKnown).toBe(false);
    expect(state.providerState.mutationsAllowed).toBe(false);
    expect(html()).toContain('Connecting…');
    expect(html()).toContain('Loading conversation…');
    expect(html()).toMatch(/data-action="native-send"[^>]*disabled/);
    expect(html()).not.toContain('Terminal-only provider state');
    workspace.nativeView = 'conversation';
    expect(html()).not.toContain('Update this host');
    workspace.applyConversationFrame(tab.id, { type: 'conversation.status', status: 'ready' });
    expect(state.providerStateKnown).toBe(false);
    expect(html()).not.toContain('Terminal-only provider state');
    snapshot([]);
    expect(state.providerStateKnown).toBe(true);
    expect(state.providerState.mutationsAllowed).toBe(true);
    expect(html()).not.toMatch(/data-action="native-send"[^>]*disabled/);
    expect(html()).not.toContain('Terminal-only provider state');
    workspace.beginConversationLoading(tab.id);
    expect(state.providerState.mutationsAllowed).toBe(false);
    expect(html()).toContain('Connecting…');
    expect(html()).not.toContain('Terminal-only provider state');
  });

  it('renders explicit unsupported state even when its fields match the loading placeholder', () => {
    const { workspace, tab, state, html } = fixture();
    workspace.applyConversationFrame(tab.id, { type: 'conversation.status', providerState: unavailableProviderState() });
    expect(state.providerStateKnown).toBe(true);
    expect(html()).toContain('Terminal-only provider state');
  });

  it('treats a completed legacy snapshot without provider state as unavailable', () => {
    const { workspace, tab, state, html } = fixture();
    workspace.applyConversationFrame(tab.id, { type: 'conversation.snapshot', items: [] });
    expect(state.providerStateKnown).toBe(true);
    expect(html()).toContain('Terminal-only provider state');
  });

  it('shows stream errors without inventing an unsupported provider result', () => {
    const { workspace, tab, html } = fixture();
    workspace.applyConversationFrame(tab.id, { type: 'conversation.error', error: { message: 'Connection failed' } });
    expect(html()).toContain('Connection failed');
    expect(html()).not.toContain('Terminal-only provider state');
  });
});

describe('Native confirmed completions across actual snapshots', () => {
  it('keeps delivery-confirmed answers complete through empty and stale snapshots and clears only the sent draft', async () => {
    const { workspace, state, snapshot, html } = fixture();
    const item = question();
    snapshot([item]);
    state.draft = 'Unsent composer';
    state.questionDrafts.set(item.id, [{ questionId: 'q1', choiceIds: ['a'], text: '' }]);
    vi.stubGlobal('window', { limitsWidget: { answerConversation: vi.fn().mockResolvedValue({ ok: true, message: 'Delivered' }) } });
    await workspace.submitQuestion(item);
    expect(state.items[0].state).toBe('complete');
    // An authoritative completion without an answer payload must not erase the receipt.
    snapshot([{ ...item, state: 'complete' }]);
    snapshot([]);
    snapshot([{ ...item, revision: undefined }]);
    expect(state.items[0].state).toBe('complete');
    expect(state.items[0].revision).toBe('stable');
    expect(state.items[0].answers).toEqual([{ questionId: 'q1', choiceIds: ['a'], text: '' }]);
    expect(html()).not.toContain('native-answer-bar');
    expect(state.draft).toBe('Unsent composer');
    expect(state.questionDrafts.has(item.id)).toBe(false);
  });

  it('retains provider-confirmed async completion without transferring it to a new revision or session', () => {
    const { workspace, tab, state, snapshot } = fixture();
    const pending = question();
    snapshot([{ ...pending, state: 'complete', title: 'Answered' }]);
    snapshot([pending]);
    expect(state.items[0].state).toBe('complete');
    snapshot([{ ...pending, revision: 'new-request' }]);
    expect(state.items[0].state).toBe('pending');
    workspace.applyConversationFrame(tab.id, { type: 'conversation.snapshot', session: 'other', items: [{ ...pending, state: 'complete' }] });
    expect(state.items[0].revision).toBe('new-request');
    workspace.tabs.set(tab.id, { ...tab, sessionId: 'other-session', internalName: 'other' });
    workspace.applyConversationFrame(tab.id, { type: 'conversation.snapshot', session: 'other', items: [pending] });
    expect(workspace.nativeState(tab.id).items[0].state).toBe('pending');
  });

  it('restores completions in paged history after the request left the latest page', async () => {
    const { workspace, state, snapshot } = fixture();
    const pending = question();
    snapshot([{ ...pending, state: 'complete' }]);
    snapshot([]);
    state.nextCursor = 'older';
    vi.stubGlobal('window', { limitsWidget: { pageConversation: vi.fn().mockResolvedValue({ frame: {
      type: 'conversation.snapshot', items: [pending], nextCursor: null, hasMore: false
    } }) } });
    await workspace.loadOlder();
    expect(state.items[0].state).toBe('complete');
  });

  it('routes anchor paging to its own tab and falls back after an unavailable page', async () => {
    const { workspace, tab, state } = fixture();
    state.nextCursor = 'expired'; state.hasMore = true;
    workspace.restoredAnchors.set(tab.id, { itemId: 'missing', offset: 12 });
    workspace.selectedId = 'another-tab';
    const page = vi.fn().mockResolvedValue({ ok: false, message: 'Cursor expired' });
    vi.stubGlobal('window', { limitsWidget: { pageConversation: page } });
    await workspace.loadOlder(tab.id);
    expect(page).toHaveBeenCalledWith(tab.id, 'expired');
    expect(state.loadingOlder).toBe(false);
    expect(workspace.restoredAnchors.has(tab.id)).toBe(false);
  });

  it('stops automatic anchor paging at the shared 2000-row limit', async () => {
    const { workspace, tab, state } = fixture();
    state.items = Array.from({ length: 2000 }, (_, index) => ({ ...user(), id: `row-${index}` }));
    state.nextCursor = 'more'; state.hasMore = true;
    const page = vi.fn(); vi.stubGlobal('window', { limitsWidget: { pageConversation: page } });
    await workspace.loadOlder(tab.id);
    expect(page).not.toHaveBeenCalled(); expect(state.hasMore).toBe(false); expect(state.nextCursor).toBeNull();
  });

  it('bounds retained receipts and recovers a missing completion revision only from an exact current request', () => {
    const memory = new ConfirmedQuestionCompletions();
    const pending = question();
    memory.remember([{ ...pending, state: 'complete', revision: undefined }], [pending]);
    expect(memory.restore([pending])[0].state).toBe('complete');
    memory.remember([{ ...question('unmatched'), state: 'complete', revision: undefined }]);
    expect(memory.restore([question('unmatched')])[0].state).toBe('pending');
    for (let index = 0; index < 256; index++) memory.remember([question(`complete-${index}`, { state: 'complete' })]);
    expect(memory.restore([pending])[0].state).toBe('pending');
    expect(memory.restore([question('complete-255')])[0].state).toBe('complete');
  });

  it('does not restore unrevisioned history with changed request identity or ambiguous saved revisions', () => {
    const { state, snapshot } = fixture();
    const original = question();
    snapshot([{ ...original, state: 'complete' }]);
    const variants: Array<Partial<ConversationItem>> = [
      { source: 'other-source' }, { timestamp: '2026-09-22T00:00:01Z' }, { timestamp: '' }, { questions: [] },
      { questions: [{ ...original.questions![0], prompt: 'Changed question' }] },
      { questions: [{ ...original.questions![0], options: [{ id: 'a', label: 'Changed answer', description: '' }] }] }
    ];
    for (const variant of variants) {
      snapshot([{ ...original, revision: undefined, ...variant }]);
      expect(state.items[0].state).toBe('pending');
    }
    snapshot([{ ...original, revision: 'second', state: 'complete' }]);
    snapshot([{ ...original, revision: undefined }]);
    expect(state.items[0].state).toBe('pending');
  });

  it('does not record a completion from another session returned by history paging', async () => {
    const { workspace, state, snapshot } = fixture();
    const pending = question();
    snapshot([]);
    state.nextCursor = 'older';
    vi.stubGlobal('window', { limitsWidget: { pageConversation: vi.fn().mockResolvedValue({ frame: {
      type: 'conversation.snapshot', session: 'other', items: [{ ...pending, state: 'complete' }]
    } }) } });
    await workspace.loadOlder();
    snapshot([pending]);
    expect(state.items[0].state).toBe('pending');
  });
});

describe('Earlier async questions', () => {
  it('consumes the shared question attention fixture without changing request states', () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/native-question-attention-v1.json'), 'utf8'));
    for (const example of fixture.cases) {
      const before = JSON.stringify(example.items);
      const result = partitionPendingActions(example.items);
      expect(result.current.map(item => item.id), example.name).toEqual(example.current);
      expect(result.earlier.map(item => item.id), example.name).toEqual(example.earlier);
      expect(JSON.stringify(example.items), example.name).toBe(before);
    }
  });

  it('uses the latest user timestamp even when old async requests are appended later', () => {
    const old = question();
    const recent = question('new', { timestamp: '2026-09-22T00:02:00Z' });
    const unknown = question('unknown', { timestamp: '' });
    const blocking = question('blocking', { source: 'codex_request_user_input' });
    const approval = question('approval', { kind: 'approval' });
    const { current, earlier } = partitionPendingActions([user(), recent, unknown, blocking, approval, old]);
    expect(earlier.map(item => item.id)).toEqual([old.id]);
    expect(current.map(item => item.id)).toEqual(['new', 'unknown', 'blocking', 'approval']);
    expect(old.state).toBe('pending');
  });

  it('uses timestamp equality order conservatively and never ages requests out by time alone', () => {
    const same = '2026-09-22T00:00:00Z';
    expect(partitionPendingActions([question('before'), user(same), question('after')]).earlier.map(item => item.id)).toEqual(['before']);
    expect(partitionPendingActions([question('old', { timestamp: '2000-01-01T00:00:00Z' })]).current).toHaveLength(1);
    expect(partitionPendingActions([question(), user('unknown')]).current).toHaveLength(1);
  });

  it('keeps seven historical requests out of the waiting bar and reopens their preserved draft independently', () => {
    const { state, snapshot, html } = fixture();
    const questions = Array.from({ length: 7 }, (_, index) => question(`old-${index}`));
    snapshot([user(), ...questions]);
    state.draft = 'Composer draft';
    state.questionDrafts.set('old-0', [{ questionId: 'q1', choiceIds: [], text: 'Question draft' }]);
    state.expandedDetails.add('earlier-questions');
    expect(html()).toContain('Earlier questions (7)');
    expect(html()).not.toContain('questions waiting');
    expect(html()).not.toContain('native-answer-bar');
    expect(html()).toContain('data-native-message');
    state.questionSheetId = 'old-0';
    expect(html()).toContain('native-question-sheet');
    expect(html()).toContain('Question draft');
    expect(html()).toContain('Composer draft');
    snapshot([user(), ...questions, question('current', { timestamp: '2026-09-22T00:02:00Z' })]);
    expect(html()).toContain('Earlier questions (7)');
    expect(html()).toContain('native-answer-bar');
    expect(html()).not.toContain('8 questions waiting');
    expect(html()).toContain('Question draft');
    expect(state.items.filter((item: ConversationItem) => item.kind === 'question' && item.state === 'pending')).toHaveLength(8);
  });

  it('does not let an earlier question capture automatic composer suggestions unless explicitly opened', () => {
    const { workspace, tab, state, snapshot } = fixture();
    const old = question('old', { questions: [{ id: 'text', header: '', prompt: 'Explain', type: 'text', required: true, allowOther: false, options: [] }] });
    snapshot([old, user(), { ...user('2026-09-22T00:02:00Z'), id: 'assistant', role: 'assistant', text: 'Finished' }]);
    expect(workspace.automaticSuggestionTarget(tab.id)).toEqual({ kind: 'composer' });
    state.questionSheetId = old.id;
    expect(workspace.automaticSuggestionTarget(tab.id)).toMatchObject({ kind: 'question', itemId: old.id });
  });
});
