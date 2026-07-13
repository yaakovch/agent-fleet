import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import hljs from 'highlight.js';
import type { WidgetSettings } from '../../shared/settings';
import type { TerminalTabDescriptor } from '../../shared/terminal';
import type {
  ConversationAnswer, ConversationFrame, ConversationItem, ConversationQuestion, StagedAttachment,
  ToolPresentationBlock
} from '../../shared/conversation';

interface TerminalRuntime {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  element: HTMLElement;
}

interface NativeState {
  items: ConversationItem[];
  interactionMode: string;
  connection: string;
  nextCursor: string | null;
  hasMore: boolean;
  loadingOlder: boolean;
  error: string;
  attachments: StagedAttachment[];
  notice: string;
  draft: string;
}

export class SessionWorkspace {
  readonly element = document.createElement('section');
  private tabs = new Map<string, TerminalTabDescriptor>();
  private runtimes = new Map<string, TerminalRuntime>();
  private nativeStates = new Map<string, NativeState>();
  private conversationStarted = new Set<string>();
  private selectedId = '';
  private settings: WidgetSettings;
  private resizeObserver: ResizeObserver;

  constructor(settings: WidgetSettings) {
    this.settings = settings;
    this.element.className = 'session-workspace';
    this.applyAppearance();
    this.resizeObserver = new ResizeObserver(() => this.fitSelected());
    this.resizeObserver.observe(this.element);
    window.limitsWidget.onTerminalData(({ tabId, data }) => this.runtimes.get(tabId)?.terminal.write(data));
    window.limitsWidget.onTerminalStatus(({ tab }) => {
      this.tabs.set(tab.id, tab);
      this.render();
    });
    window.limitsWidget.onTerminalClosed(({ tabId }) => this.remove(tabId));
    window.limitsWidget.onTerminalOpened((tab) => this.open(tab));
    window.limitsWidget.onConversationEvent(({ tabId, frame }) => this.applyConversationFrame(tabId, frame));
    this.element.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void this.sendMessage();
      }
    });
    this.element.addEventListener('input', (event) => {
      const input = event.target;
      if (input instanceof HTMLTextAreaElement && input.matches('[data-native-message]') && this.selectedId) {
        this.nativeState(this.selectedId).draft = input.value;
      }
    });
    this.element.addEventListener('paste', (event) => {
      const image = [...event.clipboardData?.items ?? []].find((item) => item.type.startsWith('image/'))?.getAsFile();
      if (image) { event.preventDefault(); void this.stageFile(image); }
    });
    this.element.addEventListener('dragover', (event) => event.preventDefault());
    this.element.addEventListener('drop', (event) => {
      event.preventDefault();
      for (const file of [...event.dataTransfer?.files ?? []].filter((item) => item.type.startsWith('image/')).slice(0, 8)) void this.stageFile(file);
    });
    void window.limitsWidget.listTerminalTabs().then((state) => {
      state.tabs.forEach((tab) => this.tabs.set(tab.id, tab));
      this.selectedId = state.selectedTabId || state.tabs.at(-1)?.id || '';
      this.render();
    });
  }

  setSettings(settings: WidgetSettings): void {
    this.settings = settings;
    this.applyAppearance();
    for (const runtime of this.runtimes.values()) Object.assign(runtime.terminal.options, this.terminalOptions());
    this.render();
  }

  private applyAppearance(): void {
    this.element.style.setProperty('--terminal-padding', `${this.settings.terminalAppearance.padding}px`);
  }

  mount(container: Element | null): void {
    if (!container) return;
    container.append(this.element);
    this.render();
  }

  detach(): void {
    this.element.remove();
  }

  open(tab: TerminalTabDescriptor): void {
    this.tabs.set(tab.id, tab);
    this.selectedId = tab.id;
    void window.limitsWidget.selectTerminalTab(tab.id);
    this.render();
  }

  handleAction(action: string, target: HTMLElement): boolean {
    const control = target.closest<HTMLElement>('[data-workspace-action]') ?? target;
    if (action === 'workspace-select') {
      const id = control.dataset.tabId;
      if (id && this.tabs.has(id)) {
        this.selectedId = id;
        void window.limitsWidget.selectTerminalTab(id);
        this.render();
      }
      return true;
    }
    if (action === 'workspace-close') {
      const id = control.dataset.tabId;
      if (id) void window.limitsWidget.closeTerminalTab(id);
      return true;
    }
    if (action === 'workspace-retry') {
      if (this.selectedId) void window.limitsWidget.retryTerminalTab(this.selectedId);
      return true;
    }
    if (action === 'workspace-view') {
      const mode = control.dataset.mode === 'terminal' ? 'terminal' : 'native';
      const tab = this.tabs.get(this.selectedId);
      if (tab) {
        tab.viewMode = mode;
        void window.limitsWidget.setTerminalView(tab.id, mode);
        if (mode === 'native') this.startConversation(tab);
        this.render();
      }
      return true;
    }
    if (action === 'workspace-search') {
      const query = window.prompt('Find in terminal');
      if (query) this.runtimes.get(this.selectedId)?.search.findNext(query);
      return true;
    }
    if (action === 'native-retry') {
      const tab = this.tabs.get(this.selectedId);
      if (tab) { this.conversationStarted.delete(tab.id); this.startConversation(tab); }
      return true;
    }
    if (action === 'native-load-older') { void this.loadOlder(); return true; }
    if (action === 'native-approve') {
      const item = this.itemFromControl(control);
      const choice = control.dataset.choice;
      if (item?.revision && choice) void this.approve(item, choice);
      return true;
    }
    if (action === 'native-question-submit') {
      const item = this.itemFromControl(control);
      if (item) void this.submitQuestion(item);
      return true;
    }
    if (action === 'native-attach') { void this.chooseAttachments(); return true; }
    if (action === 'native-clipboard') { void this.stageClipboard(); return true; }
    if (action === 'native-remove-attachment') {
      const id = control.dataset.attachmentId;
      if (id) void this.removeAttachment(id);
      return true;
    }
    if (action === 'native-send') { void this.sendMessage(); return true; }
    if (action === 'native-shift-tab') { void window.limitsWidget.terminalInput(this.selectedId, '\u001b[Z'); return true; }
    if (action === 'native-control-c') { void window.limitsWidget.terminalInput(this.selectedId, '\u0003'); return true; }
    return false;
  }

  private remove(tabId: string): void {
    this.tabs.delete(tabId);
    this.runtimes.get(tabId)?.terminal.dispose();
    this.runtimes.delete(tabId);
    this.nativeStates.delete(tabId);
    this.conversationStarted.delete(tabId);
    if (this.selectedId === tabId) this.selectedId = [...this.tabs.keys()].at(-1) ?? '';
    this.render();
  }

  private render(): void {
    for (const runtime of this.runtimes.values()) runtime.element.remove();
    const selected = this.tabs.get(this.selectedId) ?? [...this.tabs.values()].at(-1);
    if (selected) this.selectedId = selected.id;
    this.element.innerHTML = this.tabs.size ? `
      <div class="workspace-tabs" role="tablist">
        ${[...this.tabs.values()].map((tab) => `<button role="tab" class="workspace-tab ${tab.id === this.selectedId ? 'active' : ''}" data-action="workspace-select" data-workspace-action data-tab-id="${escapeAttr(tab.id)}"><i class="terminal-status status-${tab.status}"></i><span>${escapeHtml(tab.label)}</span><small>${escapeHtml(tab.hostId)}</small><b data-action="workspace-close" data-workspace-action data-tab-id="${escapeAttr(tab.id)}" title="Close tab">×</b></button>`).join('')}
      </div>
      <div class="workspace-toolbar">
        <div class="workspace-segmented"><button data-action="workspace-view" data-workspace-action data-mode="native" class="${selected?.viewMode === 'native' ? 'active' : ''}">Native</button><button data-action="workspace-view" data-workspace-action data-mode="terminal" class="${selected?.viewMode === 'terminal' ? 'active' : ''}">Terminal</button></div>
        <span class="workspace-identity"><strong>${escapeHtml(selected?.label ?? '')}</strong><small>${escapeHtml(selected ? `${selected.hostId} · ${selected.project} · ${selected.tool}` : '')}</small></span>
        <span class="workspace-connection status-text-${selected?.status ?? 'offline'}">${escapeHtml(selected?.statusMessage ?? '')}</span>
        <button class="quiet-button" data-action="workspace-search" data-workspace-action>Find</button>
        ${selected && selected.status !== 'live' ? '<button class="primary-button" data-action="workspace-retry" data-workspace-action>Retry</button>' : ''}
      </div>
      <div class="workspace-stage">
        <div class="native-session-panel ${selected?.viewMode === 'native' ? '' : 'hidden'}">${selected ? this.renderNative(selected) : ''}</div>
        <div class="terminal-session-panel ${selected?.viewMode === 'terminal' ? '' : 'hidden'}"></div>
      </div>` : `<div class="workspace-empty"><span>&gt;_</span><h2>No sessions open</h2><p>Open any fleet session to keep it here as a tab.</p></div>`;
    if (selected) {
      this.mountTerminal(selected);
      if (selected.viewMode === 'native') this.startConversation(selected);
    }
  }

  private mountTerminal(tab: TerminalTabDescriptor): void {
    const host = this.element.querySelector<HTMLElement>('.terminal-session-panel');
    if (!host) return;
    let runtime = this.runtimes.get(tab.id);
    if (!runtime) {
      const terminal = new Terminal(this.terminalOptions());
      const fit = new FitAddon();
      const search = new SearchAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(search);
      terminal.onData((data) => void window.limitsWidget.terminalInput(tab.id, data));
      const element = document.createElement('div');
      element.className = 'xterm-runtime';
      terminal.open(element);
      runtime = { terminal, fit, search, element };
      this.runtimes.set(tab.id, runtime);
    }
    host.append(runtime.element);
    queueMicrotask(() => this.fitSelected());
  }

  private nativeState(tabId: string): NativeState {
    let state = this.nativeStates.get(tabId);
    if (!state) {
      state = { items: [], interactionMode: 'unknown', connection: 'Connecting…', nextCursor: null,
        hasMore: false, loadingOlder: false, error: '', attachments: [], notice: '', draft: '' };
      this.nativeStates.set(tabId, state);
    }
    return state;
  }

  private startConversation(tab: TerminalTabDescriptor): void {
    if (tab.tool === 'shell' || this.conversationStarted.has(tab.id)) return;
    this.conversationStarted.add(tab.id);
    this.nativeState(tab.id).connection = 'Connecting…';
    void window.limitsWidget.startConversation(tab.id).then((started) => {
      if (!started) {
        const state = this.nativeState(tab.id);
        state.error = 'Native view could not start. Terminal remains available.';
        this.render();
      }
    });
  }

  private applyConversationFrame(tabId: string, frame: ConversationFrame): void {
    if (!this.tabs.has(tabId)) return;
    const state = this.nativeState(tabId);
    if (frame.type === 'conversation.snapshot') {
      state.items = mergeItems([], frame.items ?? []);
      state.interactionMode = frame.interactionMode ?? 'unknown';
      state.connection = 'Live'; state.error = '';
      state.nextCursor = frame.nextCursor ?? null; state.hasMore = Boolean(frame.hasMore); state.loadingOlder = false;
    } else if (frame.type === 'conversation.event' && frame.item) {
      state.items = mergeItems(state.items, [frame.item]); state.connection = 'Live'; state.error = '';
    } else if (frame.type === 'conversation.error') {
      state.connection = 'Unavailable'; state.error = frame.error?.message ?? 'Native view is unavailable';
    } else {
      state.connection = frame.status === 'ready' ? 'Live' : frame.status?.replaceAll('_', ' ') ?? state.connection;
      if (frame.interactionMode && frame.interactionMode !== 'unknown') state.interactionMode = frame.interactionMode;
    }
    if (tabId === this.selectedId) this.render();
  }

  private renderNative(tab: TerminalTabDescriptor): string {
    if (tab.tool === 'shell') return `<div class="native-shell"><div class="native-shell-intro"><strong>Friendly shell</strong><span>Use short navigation commands here. Switch to Terminal for full-screen programs.</span></div>${this.renderComposer(tab, this.nativeState(tab.id))}</div>`;
    const state = this.nativeState(tab.id);
    return `<div class="native-conversation ${state.interactionMode === 'plan' ? 'planning' : ''}">
      <div class="native-conversation-header"><span><i class="terminal-status status-${state.connection === 'Live' ? 'live' : 'offline'}"></i>${escapeHtml(state.connection)}</span>${state.interactionMode === 'plan' ? '<b>Planning mode</b>' : ''}</div>
      <div class="native-messages">
        ${state.hasMore ? `<button class="load-older" data-action="native-load-older" data-workspace-action ${state.loadingOlder ? 'disabled' : ''}>${state.loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>` : ''}
        ${state.error ? `<div class="native-error"><strong>Native view needs attention</strong><span>${escapeHtml(state.error)}</span><button data-action="native-retry" data-workspace-action>Retry</button></div>` : ''}
        ${renderConversationRows(state.items)}
        ${!state.items.length && !state.error ? '<div class="native-empty"><strong>Loading conversation…</strong><span>The newest messages appear first; older history loads only when requested.</span></div>' : ''}
      </div>
      ${this.renderComposer(tab, state)}
    </div>`;
  }

  private renderComposer(tab: TerminalTabDescriptor, state: NativeState): string {
    return `<div class="native-composer ${state.interactionMode === 'plan' ? 'planning' : ''}" data-composer-tab="${escapeAttr(tab.id)}">
      ${state.attachments.length ? `<div class="attachment-strip">${state.attachments.map((item) => `<button data-action="native-remove-attachment" data-workspace-action data-attachment-id="${escapeAttr(item.id)}" title="Remove ${escapeAttr(item.name)}"><img src="${item.thumbnail}" alt=""><span>${escapeHtml(item.name)}</span><b>×</b></button>`).join('')}</div>` : ''}
      ${state.notice ? `<small class="composer-notice">${escapeHtml(state.notice)}</small>` : ''}
      <textarea data-native-message maxlength="32768" placeholder="Message ${escapeAttr(tab.tool)}… (Ctrl+Enter to send)">${escapeHtml(state.draft)}</textarea>
      <div class="composer-actions"><button data-action="native-attach" data-workspace-action title="Choose images">Attach</button><button data-action="native-clipboard" data-workspace-action title="Paste image from clipboard">Paste image</button><button data-action="native-shift-tab" data-workspace-action>Shift+Tab</button><button data-action="native-control-c" data-workspace-action>Ctrl+C</button><span></span><button class="primary-button" data-action="native-send" data-workspace-action>Send</button></div>
    </div>`;
  }

  private async loadOlder(): Promise<void> {
    const state = this.nativeState(this.selectedId);
    if (!state.nextCursor || state.loadingOlder) return;
    state.loadingOlder = true; this.render();
    const result = await window.limitsWidget.pageConversation(this.selectedId, state.nextCursor);
    state.loadingOlder = false;
    if (result.frame?.type === 'conversation.snapshot') {
      state.items = mergeItems(result.frame.items ?? [], state.items);
      state.nextCursor = result.frame.nextCursor ?? null; state.hasMore = Boolean(result.frame.hasMore);
    } else state.notice = result.message;
    this.render();
  }

  private itemFromControl(control: HTMLElement): ConversationItem | undefined {
    const id = control.closest<HTMLElement>('[data-conversation-item]')?.dataset.conversationItem;
    return this.nativeState(this.selectedId).items.find((item) => item.id === id);
  }

  private async approve(item: ConversationItem, choice: string): Promise<void> {
    if (!item.revision) return;
    const result = await window.limitsWidget.approveConversation(this.selectedId, item.id, choice, item.revision);
    const state = this.nativeState(this.selectedId); state.notice = result.message;
    if (result.ok) state.items = mergeItems(state.items, [{ ...item, state: 'complete', title: 'Approval sent' }]);
    this.render();
  }

  private async submitQuestion(item: ConversationItem): Promise<void> {
    if (!item.revision || !item.questions?.length) return;
    const card = [...this.element.querySelectorAll<HTMLElement>('[data-conversation-item]')].find((node) => node.dataset.conversationItem === item.id);
    if (!card) return;
    const answers: ConversationAnswer[] = [];
    for (const question of item.questions) {
      const checked = [...card.querySelectorAll<HTMLInputElement>('input[data-question-choice]:checked')]
        .filter((input) => input.dataset.questionId === question.id).map((input) => input.value);
      const text = [...card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-question-text]')]
        .find((input) => input.dataset.questionId === question.id)?.value.trim() ?? '';
      if (question.required && !checked.length && !text) {
        this.nativeState(this.selectedId).notice = `Answer “${question.header || question.prompt}” first`;
        this.render(); return;
      }
      answers.push({ questionId: question.id, choiceIds: checked, text });
    }
    const result = await window.limitsWidget.answerConversation(this.selectedId, item.id, item.revision, answers);
    const state = this.nativeState(this.selectedId); state.notice = result.message;
    if (result.ok) state.items = mergeItems(state.items, [{ ...item, state: 'running', title: 'Answer sent…', answers }]);
    this.render();
  }

  private async stageFile(file: File): Promise<void> {
    try {
      const attachments = await window.limitsWidget.stageAttachmentBytes(this.selectedId, file.name, file.type, new Uint8Array(await file.arrayBuffer()));
      this.nativeState(this.selectedId).attachments = attachments;
    } catch (error) { this.nativeState(this.selectedId).notice = error instanceof Error ? error.message : 'Image could not be staged'; }
    this.render();
  }
  private async stageClipboard(): Promise<void> { await this.updateAttachments(() => window.limitsWidget.stageClipboardImage(this.selectedId)); }
  private async chooseAttachments(): Promise<void> { await this.updateAttachments(() => window.limitsWidget.chooseConversationAttachments(this.selectedId)); }
  private async removeAttachment(id: string): Promise<void> { await this.updateAttachments(() => window.limitsWidget.removeConversationAttachment(this.selectedId, id)); }
  private async updateAttachments(action: () => Promise<StagedAttachment[]>): Promise<void> {
    try { this.nativeState(this.selectedId).attachments = await action(); }
    catch (error) { this.nativeState(this.selectedId).notice = error instanceof Error ? error.message : 'Attachment action failed'; }
    this.render();
  }
  private async sendMessage(): Promise<void> {
    if (!this.selectedId) return;
    const input = this.element.querySelector<HTMLTextAreaElement>('[data-native-message]');
    const text = input?.value ?? '';
    const result = await window.limitsWidget.sendConversationMessage(this.selectedId, text);
    const state = this.nativeState(this.selectedId); state.notice = result.message;
    if (result.ok) { state.attachments = []; state.draft = ''; if (input) input.value = ''; }
    this.render();
  }

  private fitSelected(): void {
    const runtime = this.runtimes.get(this.selectedId);
    if (!runtime || !this.element.isConnected) return;
    try {
      runtime.fit.fit();
      void window.limitsWidget.terminalResize(this.selectedId, runtime.terminal.cols, runtime.terminal.rows);
    } catch { /* the terminal is temporarily hidden */ }
  }

  private terminalOptions(): ConstructorParameters<typeof Terminal>[0] {
    const appearance = this.settings.terminalAppearance;
    const themes = {
      fleetDark: { background: '#0b1017', foreground: '#e7edf5', cursor: '#8db8ff', selectionBackground: '#26456f' },
      midnight: { background: '#05070b', foreground: '#d6deeb', cursor: '#c792ea', selectionBackground: '#2b3750' },
      light: { background: '#f6f8fb', foreground: '#17202b', cursor: '#2459a8', selectionBackground: '#bdd7ff' }
    } as const;
    return {
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: appearance.cursorBlink,
      cursorStyle: appearance.cursorStyle,
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      lineHeight: appearance.lineHeight,
      scrollback: appearance.scrollback,
      theme: themes[appearance.theme]
    };
  }
}

function renderConversationRows(items: ConversationItem[]): string {
  let html = '';
  for (let index = 0; index < items.length;) {
    if (items[index].kind === 'tool') {
      const tools: ConversationItem[] = [];
      while (items[index]?.kind === 'tool') tools.push(items[index++]);
      html += tools.length > 1 ? renderToolGroup(tools) : renderTool(tools[0]);
      continue;
    }
    html += renderConversationItem(items[index++]);
  }
  return html;
}

function renderConversationItem(item: ConversationItem): string {
  if (item.kind === 'question') return renderQuestion(item);
  if (item.kind === 'approval') return `<article class="native-card approval-card state-${escapeAttr(item.state)}" data-conversation-item="${escapeAttr(item.id)}"><small>Approval</small><h3>${escapeHtml(item.title || 'Approval needed')}</h3>${markdown(item.text || item.detail)}<div class="native-choice-actions">${item.state === 'complete' ? '<b>Answered</b>' : item.choices.map((choice) => `<button class="${/deny|reject|cancel/iu.test(choice.id) ? 'quiet-button' : 'primary-button'}" data-action="native-approve" data-workspace-action data-choice="${escapeAttr(choice.id)}">${escapeHtml(choice.label)}</button>`).join('')}</div></article>`;
  if (item.kind === 'change') return `<article class="native-card change-card"><small>Files changed</small><h3>${escapeHtml(item.title || item.target || 'Change')}</h3>${markdown(item.text || item.detail)}</article>`;
  if (item.kind === 'error') return `<article class="native-card native-error"><strong>${escapeHtml(item.title || 'Error')}</strong>${markdown(item.text || item.detail)}</article>`;
  const role = item.role === 'user' ? 'user' : item.role === 'assistant' ? 'assistant' : 'activity';
  const content = item.text || item.detail;
  if (!content && !item.title) return '';
  return `<article class="native-message ${role}">${item.title && item.title !== content ? `<small>${escapeHtml(item.title)}</small>` : ''}${markdown(content || item.title)}</article>`;
}

function renderQuestion(item: ConversationItem): string {
  const complete = item.state === 'complete';
  const questions = item.questions?.length ? item.questions : fallbackQuestion(item);
  return `<article class="native-card question-card state-${escapeAttr(item.state)}" data-conversation-item="${escapeAttr(item.id)}"><small>${complete ? 'Answered' : 'Question'}</small><h3>${escapeHtml(item.title || 'Your input is needed')}</h3>${item.text ? markdown(item.text) : ''}
    ${questions.map((question) => renderQuestionPart(question, item)).join('')}
    ${complete ? '<div class="question-complete">Answer submitted</div>' : '<button class="primary-button question-submit" data-action="native-question-submit" data-workspace-action>Submit answers</button>'}</article>`;
}

function renderQuestionPart(question: ConversationQuestion, item: ConversationItem): string {
  const existing = item.answers?.find((answer) => answer.questionId === question.id);
  const type = question.type === 'multi' ? 'checkbox' : 'radio';
  const options = question.options.map((option) => `<label class="question-option"><input type="${type}" name="q-${escapeAttr(item.id)}-${escapeAttr(question.id)}" value="${escapeAttr(option.id)}" data-question-choice data-question-id="${escapeAttr(question.id)}" ${existing?.choiceIds.includes(option.id) ? 'checked' : ''}><span><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</span></label>`).join('');
  const textInput = question.type === 'text' || question.allowOther
    ? `<textarea data-question-text data-question-id="${escapeAttr(question.id)}" placeholder="${question.type === 'text' ? 'Type your answer' : 'Or type another answer'}">${escapeHtml(existing?.text ?? '')}</textarea>` : '';
  return `<fieldset class="question-part"><legend>${question.header ? `<small>${escapeHtml(question.header)}</small>` : ''}<strong>${escapeHtml(question.prompt)}</strong></legend>${options}${textInput}</fieldset>`;
}

function fallbackQuestion(item: ConversationItem): ConversationQuestion[] {
  return [{ id: 'answer', header: '', prompt: item.text || item.title, type: item.choices.length ? 'single' : 'text', required: true,
    allowOther: !item.choices.length, options: item.choices.map((choice) => ({ ...choice, description: '' })) }];
}

function renderToolGroup(tools: ConversationItem[]): string {
  const running = tools.filter((tool) => tool.state === 'running').length;
  const label = tools.map(toolLabel).filter((value, index, all) => all.indexOf(value) === index).slice(0, 3).join(', ');
  return `<details class="tool-group"><summary><span><strong>${tools.length} tool calls</strong><small>${escapeHtml(label)}${running ? ` · ${running} running` : ''}</small></span><b>Show</b></summary><div>${tools.map(renderTool).join('')}</div></details>`;
}

function renderTool(item: ConversationItem): string {
  const presentation = item.presentation;
  const title = presentation?.title || humanizeTool(item.tool || item.action || 'Tool');
  const subtitle = presentation?.subtitle || item.target || stateLabel(item.state);
  const inputBlocks = presentation?.inputBlocks?.length ? presentation.inputBlocks : item.input ? [{ title: 'Input', kind: 'json', content: item.input }] : [];
  const resultBlocks = presentation?.resultBlocks?.length ? presentation.resultBlocks : item.result ? [{ title: 'Result', kind: 'text', content: item.result }] : [];
  return `<details class="tool-call state-${escapeAttr(item.state)}"><summary><span class="tool-state"></span><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle)}</small></span><b>${escapeHtml(stateLabel(item.state))}</b></summary><div class="tool-detail">${[...inputBlocks, ...resultBlocks].map(renderToolBlock).join('') || '<p>No details reported.</p>'}</div></details>`;
}

function renderToolBlock(block: ToolPresentationBlock): string {
  if (block.kind === 'markdown') return `<section><h4>${escapeHtml(block.title)}</h4>${markdown(block.content)}</section>`;
  const highlighted = hljs.highlightAuto(block.content).value;
  return `<section><h4>${escapeHtml(block.title)}</h4><pre><code>${highlighted}</code></pre></section>`;
}

function markdown(value: string): string {
  const raw = marked.parse(value, { async: false, gfm: true, breaks: true });
  return `<div class="native-markdown">${DOMPurify.sanitize(raw, {
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'onerror', 'onclick']
  })}</div>`;
}

function toolLabel(item: ConversationItem): string { return item.presentation?.title || humanizeTool(item.tool || item.action || 'tool'); }
function humanizeTool(value: string): string { return value.replaceAll('_', ' ').replace(/\b\w/gu, (match) => match.toUpperCase()); }
function stateLabel(value: string): string { return value === 'complete' ? 'Done' : value === 'running' ? 'Running' : value === 'error' ? 'Failed' : 'Pending'; }

function mergeItems(current: ConversationItem[], incoming: ConversationItem[]): ConversationItem[] {
  const values = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const old = values.get(item.id);
    values.set(item.id, old && ['tool', 'question'].includes(item.kind) ? {
      ...old, ...item,
      state: old.state === 'complete' || item.state === 'complete' ? 'complete' : item.state || old.state,
      text: item.text || old.text, detail: item.detail || old.detail,
      questions: item.questions?.length ? item.questions : old.questions,
      answers: item.answers?.length ? item.answers : old.answers,
      presentation: item.presentation ?? old.presentation
    } : item);
  }
  return [...values.values()].slice(-2_000);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function escapeAttr(value: string): string { return escapeHtml(value); }
