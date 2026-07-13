export interface ConversationChoice { id: string; label: string }
export interface ConversationQuestionOption { id: string; label: string; description: string }
export interface ConversationQuestion {
  id: string; header: string; prompt: string; type: 'single' | 'multi' | 'text' | 'boolean';
  required: boolean; allowOther: boolean; options: ConversationQuestionOption[];
}
export interface ConversationAnswer { questionId: string; choiceIds: string[]; text: string }
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
}
export interface ConversationFrame {
  protocolVersion: 2;
  type: 'conversation.snapshot' | 'conversation.event' | 'conversation.status' | 'conversation.heartbeat' | 'conversation.error';
  session?: string; adapter?: string; mode?: string; interactionMode?: 'plan' | 'default' | 'unknown';
  revision?: string; items?: ConversationItem[]; item?: ConversationItem; nextCursor?: string | null;
  hasMore?: boolean; status?: string; error?: { code: string; message: string };
}
export interface ConversationEvent { tabId: string; frame: ConversationFrame }
export interface NativeActionResult { ok: boolean; message: string; frame?: ConversationFrame }
export interface StagedAttachment { id: string; name: string; mime: string; bytes: number; thumbnail: string }
