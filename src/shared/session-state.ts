import type { ConversationAnswer } from './conversation';

export interface SessionIdentity {
  schemaVersion: 1; host: string; session: string; incarnationId: string;
  projectRoot: string; backend: 'linux' | 'windows' | 'termux'; tool: string;
}
export interface ReadingAnchor { itemId: string; offset: number }
export interface SavedQuestionDraft { requestId: string; form: string; answers: ConversationAnswer[] }
export interface SavedSessionContent {
  message: string; questions: SavedQuestionDraft[]; selectedView: 'native' | 'terminal';
  followOutput: boolean; anchor: ReadingAnchor | null;
}
export interface SavedSessionState extends SavedSessionContent {
  schemaVersion: 1; revision: number; identity: SessionIdentity; executionTarget: string;
}

export function parseSessionIdentity(input: unknown, host: string, session: string): SessionIdentity | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'backend,host,incarnationId,projectRoot,schemaVersion,session,tool'
    || value.schemaVersion !== 1 || value.host !== host || value.session !== session
    || typeof value.incarnationId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.incarnationId)
    || typeof value.projectRoot !== 'string' || !value.projectRoot || value.projectRoot.length > 32767
    || /[\x00-\x1f\x7f]/u.test(value.projectRoot)
    || !['linux', 'windows', 'termux'].includes(String(value.backend))
    || !['shell', 'codex', 'claude', 'copilot'].includes(String(value.tool))) return null;
  return value as unknown as SessionIdentity;
}

export function validSessionContent(input: unknown): input is SavedSessionContent {
  if (!input || typeof input !== 'object') return false;
  const value = input as SavedSessionContent;
  if (Object.keys(value).sort().join(',') !== 'anchor,followOutput,message,questions,selectedView'
    || typeof value.message !== 'string' || value.message.length > 32768 || value.message.includes('\0')
    || !['native', 'terminal'].includes(value.selectedView) || typeof value.followOutput !== 'boolean'
    || !Array.isArray(value.questions) || value.questions.length > 256) return false;
  if (value.anchor !== null && (!value.anchor || Object.keys(value.anchor).sort().join(',') !== 'itemId,offset'
    || typeof value.anchor.itemId !== 'string' || !value.anchor.itemId || value.anchor.itemId.length > 160
    || !Number.isSafeInteger(value.anchor.offset) || Math.abs(value.anchor.offset) > 1_000_000)) return false;
  const ids = new Set<string>();
  return value.questions.every((draft) => {
    if (!draft || Object.keys(draft).sort().join(',') !== 'answers,form,requestId'
      || typeof draft.requestId !== 'string' || !draft.requestId || draft.requestId.length > 160 || ids.has(JSON.stringify([draft.requestId, draft.form]))
      || typeof draft.form !== 'string' || !draft.form || draft.form.length > 160 || !Array.isArray(draft.answers)
      || draft.answers.length > 8 || new TextEncoder().encode(JSON.stringify(draft.answers)).length > 32768) return false;
    ids.add(JSON.stringify([draft.requestId, draft.form]));
    const questions = new Set<string>();
    return draft.answers.every((answer) => {
      if (!answer || Object.keys(answer).sort().join(',') !== 'choiceIds,questionId,text'
        || typeof answer.questionId !== 'string' || !answer.questionId || answer.questionId.length > 160
        || questions.has(answer.questionId) || typeof answer.text !== 'string' || answer.text.includes('\0')
        || !Array.isArray(answer.choiceIds) || answer.choiceIds.length > 16
        || !answer.choiceIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 160)
        || new Set(answer.choiceIds).size !== answer.choiceIds.length) return false;
      questions.add(answer.questionId); return true;
    });
  });
}

export function emptySessionContent(): SavedSessionContent {
  return { message: '', questions: [], selectedView: 'native', followOutput: true, anchor: null };
}
import type { ConversationQuestion } from './conversation';

export function questionFormContent(questions: ConversationQuestion[]): string {
  return JSON.stringify(questions.map((question) => [question.id, question.header, question.prompt, question.type,
    question.required, question.allowOther, question.options.map((option) => [option.id, option.label, option.description])]));
}
