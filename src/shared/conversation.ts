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
