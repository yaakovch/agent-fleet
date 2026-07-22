import type { PaneScrollbackSnapshot } from './terminal';

export interface ConversationChoice { id: string; label: string }
export interface ConversationQuestionOption { id: string; label: string; description: string }
export interface ConversationQuestion {
  id: string; header: string; prompt: string; type: 'single' | 'multi' | 'text' | 'boolean';
  required: boolean; allowOther: boolean; options: ConversationQuestionOption[];
}
export interface ConversationAnswer { questionId: string; choiceIds: string[]; text: string }
export interface ProviderActivity { label: string; elapsedSeconds: number; observedAt: string }
export interface ConversationTask {
  id: string; title: string; activeTitle: string; detail: string;
  state: 'pending' | 'in_progress' | 'completed';
}
export interface ToolPresentationBlock { title: string; kind: string; content: string }
export interface ToolPresentation {
  version: 1; title: string; subtitle: string; previewLines: number;
  inputBlocks: ToolPresentationBlock[]; resultBlocks: ToolPresentationBlock[];
}
export interface ConversationItem {
  id: string; kind: string; timestamp: string; role: string; title: string; text: string; detail: string;
  state: string; tool: string; attachments: string[]; choices: ConversationChoice[]; revision?: string;
  action?: string; target?: string; input?: string; result?: string; startedAt?: string; completedAt?: string;
  questions?: ConversationQuestion[]; answers?: ConversationAnswer[]; presentation?: ToolPresentation;
  source?: string; turnId?: string; taskListId?: string; updateMode?: 'replace' | 'merge'; tasks?: ConversationTask[];
}
export interface ConversationFrame {
  protocolVersion: 2;
  type: 'conversation.snapshot' | 'conversation.event' | 'conversation.status' | 'conversation.heartbeat' | 'conversation.error';
  session?: string; adapter?: string; mode?: string; interactionMode?: 'plan' | 'default' | 'unknown';
  revision?: string; items?: ConversationItem[]; item?: ConversationItem; nextCursor?: string | null;
  hasMore?: boolean; status?: string; error?: { code: string; message: string };
  providerActivity?: ProviderActivity | null;
}
export interface ConversationEvent { tabId: string; frame: ConversationFrame }
export interface NativeActionResult { ok: boolean; message: string; frame?: ConversationFrame; pane?: PaneScrollbackSnapshot }
export interface StagedAttachment { id: string; name: string; mime: string; bytes: number; thumbnail: string }

const MAX_CONVERSATION_FRAME_BYTES = 256 * 1024;
const ITEM_KINDS = new Set([
  'message', 'activity', 'tool', 'question', 'change', 'approval', 'status', 'error', 'attachment',
  'fallback', 'shell_command', 'shell_output', 'task_list', 'plan'
]);
const ITEM_STATES = new Set(['', 'pending', 'running', 'complete', 'error']);

export function parseConversationFrame(line: string): ConversationFrame | null {
  if (new TextEncoder().encode(line).byteLength < 2 || new TextEncoder().encode(line).byteLength > MAX_CONVERSATION_FRAME_BYTES) return null;
  let input: unknown;
  try { input = JSON.parse(line) as unknown; } catch { return null; }
  if (!record(input)) return null;
  const type = input.type;
  if (input.protocolVersion !== 2 || typeof type !== 'string') return null;
  if (type === 'conversation.snapshot') {
    if (!shape(input,
      ['protocolVersion', 'type', 'session', 'adapter', 'mode', 'interactionMode', 'revision', 'items', 'nextCursor', 'hasMore'],
      ['timestamp', 'providerActivity'])
      || !safe(input.session, 160) || !safe(input.adapter, 32) || !safe(input.mode, 32)
      || !member(input.interactionMode, ['plan', 'default', 'unknown']) || !safe(input.revision, 160)
      || !boundedArray(input.items, 200, validConversationItem)
      || !(input.nextCursor === null || safe(input.nextCursor, 2048)) || typeof input.hasMore !== 'boolean'
      || !optionalTimestamp(input) || !optionalProviderActivity(input)) return null;
  } else if (type === 'conversation.event') {
    if (!shape(input, ['protocolVersion', 'type', 'session', 'adapter', 'item'], ['timestamp'])
      || !optionalTimestamp(input) || !safe(input.session, 160) || !safe(input.adapter, 32)
      || !validConversationItem(input.item)) return null;
  } else if (type === 'conversation.status' || type === 'conversation.heartbeat') {
    if (!shape(input, ['protocolVersion', 'type', 'session', 'adapter', 'status', 'interactionMode'], ['timestamp', 'providerActivity'])
      || !optionalTimestamp(input) || !safe(input.session, 160) || !safe(input.adapter, 32) || !safe(input.status, 64)
      || !member(input.interactionMode, ['plan', 'default', 'unknown']) || !optionalProviderActivity(input)) return null;
  } else if (type === 'conversation.error') {
    if (!shape(input, ['protocolVersion', 'type', 'error'], ['timestamp']) || !optionalTimestamp(input) || !record(input.error)
      || !shape(input.error, ['code', 'message']) || !safe(input.error.code, 64) || !safe(input.error.message, 512, true)) return null;
  } else return null;
  return input as unknown as ConversationFrame;
}

function validConversationItem(input: unknown): boolean {
  if (!record(input) || !shape(input,
    ['id', 'kind', 'timestamp', 'role', 'title', 'text', 'detail', 'state', 'tool', 'attachments', 'choices'],
    ['revision', 'action', 'target', 'input', 'result', 'startedAt', 'completedAt', 'questions', 'answers',
      'presentation', 'source', 'turnId', 'taskListId', 'updateMode', 'tasks'])) return false;
  if (!safe(input.id, 160) || typeof input.kind !== 'string' || !ITEM_KINDS.has(input.kind)
    || !timestamp(input.timestamp) || !safe(input.role, 16) || !safe(input.title, 240)
    || !safe(input.text, 65_536, true) || !safe(input.detail, 131_072, true)
    || typeof input.state !== 'string' || !ITEM_STATES.has(input.state) || !safe(input.tool, 120)
    || !boundedArray(input.attachments, 16, (item) => safe(item, 512))
    || !boundedArray(input.choices, 8, validChoice)) return false;
  if (!optionalSafe(input, 'revision', 160) || !optionalSafe(input, 'action', 32)
    || !optionalSafe(input, 'target', 160) || !optionalSafe(input, 'input', 131_072, true)
    || !optionalSafe(input, 'result', 131_072, true) || !optionalSafe(input, 'startedAt', 64)
    || !optionalSafe(input, 'completedAt', 64) || !optionalSafe(input, 'source', 64)
    || !optionalSafe(input, 'turnId', 160) || !optionalSafe(input, 'taskListId', 160)) return false;
  if ('updateMode' in input && !member(input.updateMode, ['replace', 'merge'])) return false;
  if ('questions' in input && !boundedArray(input.questions, 8, validQuestion)) return false;
  if ('answers' in input && !boundedArray(input.answers, 8, validAnswer)) return false;
  if ('tasks' in input && !boundedArray(input.tasks, 64, validTask)) return false;
  return !('presentation' in input) || validPresentation(input.presentation);
}

function validChoice(input: unknown): boolean {
  return record(input) && shape(input, ['id', 'label']) && safe(input.id, 64) && safe(input.label, 120);
}

function validQuestion(input: unknown): boolean {
  return record(input) && shape(input, ['id', 'header', 'prompt', 'type', 'required', 'allowOther', 'options'])
    && safe(input.id, 80) && safe(input.header, 120) && safe(input.prompt, 2_000, true)
    && member(input.type, ['single', 'multi', 'text', 'boolean'])
    && typeof input.required === 'boolean' && typeof input.allowOther === 'boolean'
    && boundedArray(input.options, 16, (candidate) => record(candidate)
      && shape(candidate, ['id', 'label', 'description']) && safe(candidate.id, 80)
      && safe(candidate.label, 160) && safe(candidate.description, 320, true));
}

function validAnswer(input: unknown): boolean {
  return record(input) && shape(input, ['questionId', 'choiceIds', 'text']) && safe(input.questionId, 80)
    && boundedArray(input.choiceIds, 16, (value) => safe(value, 80)) && safe(input.text, 8_192, true);
}

function validTask(input: unknown): boolean {
  return record(input) && shape(input, ['id', 'title', 'activeTitle', 'detail', 'state'])
    && safe(input.id, 160) && safe(input.title, 1_000, true) && safe(input.activeTitle, 1_000, true)
    && safe(input.detail, 4_000, true) && member(input.state, ['pending', 'in_progress', 'completed']);
}

function validPresentation(input: unknown): boolean {
  if (!record(input) || !shape(input, ['version', 'title', 'subtitle', 'previewLines', 'inputBlocks', 'resultBlocks'])
    || input.version !== 1 || !safe(input.title, 80) || !safe(input.subtitle, 160)
    || !Number.isInteger(input.previewLines) || (input.previewLines as number) < 1 || (input.previewLines as number) > 50) return false;
  const block = (candidate: unknown): boolean => record(candidate) && shape(candidate, ['title', 'kind', 'content'])
    && safe(candidate.title, 80) && safe(candidate.kind, 16) && safe(candidate.content, 24_576, true);
  return boundedArray(input.inputBlocks, 32, block) && boundedArray(input.resultBlocks, 32, block);
}

function optionalProviderActivity(input: Record<string, unknown>): boolean {
  if (!('providerActivity' in input) || input.providerActivity === null) return true;
  const value = input.providerActivity;
  return record(value) && shape(value, ['label', 'elapsedSeconds', 'observedAt']) && safe(value.label, 80)
    && Number.isInteger(value.elapsedSeconds) && (value.elapsedSeconds as number) >= 0
    && (value.elapsedSeconds as number) <= 604_800 && timestamp(value.observedAt);
}

function optionalTimestamp(input: Record<string, unknown>): boolean {
  return !('timestamp' in input) || timestamp(input.timestamp);
}

function optionalSafe(input: Record<string, unknown>, name: string, maximum: number, multiline = false): boolean {
  return !(name in input) || safe(input[name], maximum, multiline);
}

function boundedArray(input: unknown, maximum: number, validate: (value: unknown) => boolean): boolean {
  return Array.isArray(input) && input.length <= maximum && input.every(validate);
}

function timestamp(input: unknown): boolean { return safe(input, 64) && input.length > 0; }

function safe(input: unknown, maximum: number, multiline = false): input is string {
  return typeof input === 'string' && input.length <= maximum && !input.includes('\u0000')
    && (multiline || !/[\u0000-\u001f\u007f]/u.test(input));
}

function member(input: unknown, values: readonly string[]): boolean {
  return typeof input === 'string' && values.includes(input);
}

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === 'object' && !Array.isArray(input);
}

function shape(input: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const actual = Object.keys(input);
  const allowed = new Set([...required, ...optional]);
  return required.every((field) => field in input) && actual.every((field) => allowed.has(field));
}

export function mergeConversationItems(current: ConversationItem[], incoming: ConversationItem[]): ConversationItem[] {
  const values = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const old = values.get(item.id);
    if (old && item.kind === 'task_list') {
      const tasks = item.updateMode === 'replace' ? item.tasks ?? [] : mergeTasks(old.tasks ?? [], item.tasks ?? []);
      values.set(item.id, { ...old, ...item, text: item.text || old.text, tasks });
      continue;
    }
    values.set(item.id, old && ['tool', 'question'].includes(item.kind) ? {
      ...old, ...item,
      state: old.state === 'complete' || item.state === 'complete' ? 'complete' : item.state || old.state,
      text: item.text || old.text, detail: item.detail || old.detail,
      questions: item.questions?.length ? item.questions : old.questions,
      answers: item.answers?.length ? item.answers : old.answers,
      input: item.input || old.input, result: item.result || old.result,
      startedAt: item.startedAt || old.startedAt, completedAt: item.completedAt || old.completedAt,
      presentation: mergeToolPresentation(old.presentation, item.presentation)
    } : item);
  }
  return retireSupersededQuestions([...values.values()].slice(-2_000));
}

export function retireSupersededQuestions(items: ConversationItem[]): ConversationItem[] {
  const timestamps = items.map((item) => item.timestamp).filter(Boolean);
  const latestTimestamp = timestamps.sort().at(-1) ?? '';
  let latestTimestampIndex = -1;
  if (latestTimestamp) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].timestamp === latestTimestamp) { latestTimestampIndex = index; break; }
    }
  }
  return items.map((item, index) => {
    if (item.kind !== 'question' || item.state === 'complete') return item;
    const superseded = item.timestamp && latestTimestamp
      ? latestTimestamp > item.timestamp
        || (latestTimestamp === item.timestamp && latestTimestampIndex > index && items[latestTimestampIndex].id !== item.id)
      : items.slice(index + 1).some((later) => later.id !== item.id);
    return superseded ? {
      ...item, title: 'No longer active', state: 'complete', completedAt: latestTimestamp
    } : item;
  });
}

export function activePendingAction(items: ConversationItem[]): ConversationItem | undefined {
  return [...retireSupersededQuestions(items)].reverse().find((item) =>
    ['question', 'approval'].includes(item.kind) && item.state !== 'complete'
  );
}

function mergeTasks(current: ConversationTask[], incoming: ConversationTask[]): ConversationTask[] {
  const tasks = new Map(current.map((task) => [task.id, task]));
  for (const task of incoming) {
    const old = tasks.get(task.id);
    tasks.set(task.id, old ? {
      ...old, ...task,
      title: task.title || old.title,
      activeTitle: task.activeTitle || old.activeTitle,
      detail: task.detail || old.detail
    } : task);
  }
  return [...tasks.values()];
}

export function resolveConversationScroll(
  mode: 'append' | 'prepend' | 'preserve', previousTop: number, previousHeight: number,
  nextHeight: number, wasNearBottom: boolean
): number {
  if (mode === 'prepend') return Math.max(0, previousTop + nextHeight - previousHeight);
  if (mode === 'append' && wasNearBottom) return nextHeight;
  return Math.max(0, previousTop);
}

function mergeToolPresentation(old: ToolPresentation | undefined, incoming: ToolPresentation | undefined): ToolPresentation | undefined {
  if (!old) return incoming;
  if (!incoming) return old;
  return {
    version: 1,
    title: old.title || incoming.title,
    subtitle: old.subtitle || incoming.subtitle,
    previewLines: incoming.previewLines || old.previewLines,
    inputBlocks: old.inputBlocks.length ? old.inputBlocks : incoming.inputBlocks,
    resultBlocks: incoming.resultBlocks.length ? incoming.resultBlocks : old.resultBlocks
  };
}
