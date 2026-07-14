import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import hljs from 'highlight.js';
import type { WidgetSettings } from '../../shared/settings';
import type { TerminalTabDescriptor } from '../../shared/terminal';
import type { FleetAttention, FleetSnapshot } from '../../shared/fleet';
import type {
  ConversationAnswer, ConversationFrame, ConversationItem, ConversationQuestion, StagedAttachment,
  ToolPresentationBlock
} from '../../shared/conversation';
import { mergeConversationItems, resolveConversationScroll } from '../../shared/conversation';

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
  scrollTop: number;
  scrollHeight: number;
  scrollInitialized: boolean;
  followOutput: boolean;
  newMessages: boolean;
  renderMode: 'initial' | 'append' | 'prepend' | 'preserve';
  questionDrafts: Map<string, ConversationAnswer[]>;
  questionSteps: Map<string, number>;
  submittingQuestions: Set<string>;
  expandedDetails: Set<string>;
  questionSheetId: string;
  viewer: { itemId: string; actionIndex: number | null; wrap: boolean } | null;
}

interface RenderSnapshot {
  tabId: string;
  scrollTop: number;
  scrollHeight: number;
  nearBottom: boolean;
  focusKey: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

export class SessionWorkspace {
  readonly element = document.createElement('section');
  private tabs = new Map<string, TerminalTabDescriptor>();
  private runtimes = new Map<string, TerminalRuntime>();
  private nativeStates = new Map<string, NativeState>();
  private conversationStarted = new Set<string>();
  private selectedId = '';
  private renderedTabId = '';
  private mounted = false;
  private boundTerminalId = '';
  private fleetSnapshot: FleetSnapshot | null = null;
  private settings: WidgetSettings;
  private resizeObserver: ResizeObserver;
  private nativeRenderQueued = false;

  constructor(settings: WidgetSettings) {
    this.settings = settings;
    this.element.className = 'session-workspace';
    this.applyAppearance();
    this.resizeObserver = new ResizeObserver(() => this.fitSelected());
    this.resizeObserver.observe(this.element);
    window.limitsWidget.onTerminalData(({ tabId, data }) => this.runtimes.get(tabId)?.terminal.write(data));
    window.limitsWidget.onTerminalStatus(({ tab }) => {
      const previous = this.tabs.get(tab.id);
      if (previous && terminalDescriptorEqual(previous, tab)) return;
      this.tabs.set(tab.id, tab);
      this.render();
    });
    window.limitsWidget.onTerminalClosed(({ tabId }) => this.remove(tabId));
    window.limitsWidget.onTerminalOpened((tab) => this.open(tab));
    window.limitsWidget.onConversationEvent(({ tabId, frame }) => this.applyConversationFrame(tabId, frame));
    document.addEventListener('visibilitychange', () => {
      this.syncConversation();
      this.syncTerminal();
    });
    this.element.addEventListener('keydown', (event) => {
      const questionText = event.target instanceof HTMLTextAreaElement && event.target.matches('[data-question-text]')
        ? event.target : null;
      if (questionText && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.captureQuestionDraft(questionText);
        const item = this.itemFromControl(questionText);
        if (item) void this.advanceOrSubmitQuestion(item);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void this.sendMessage();
      }
    });
    this.element.addEventListener('input', (event) => {
      const input = event.target;
      if (input instanceof HTMLTextAreaElement && input.matches('[data-native-message]') && this.selectedId) {
        this.nativeState(this.selectedId).draft = input.value;
      } else if (input instanceof HTMLTextAreaElement && input.matches('[data-question-text]')) {
        this.captureQuestionDraft(input);
      }
    });
    this.element.addEventListener('scroll', (event) => {
      const messages = event.target;
      if (!(messages instanceof HTMLElement) || !messages.matches('.native-messages')) return;
      const tabId = messages.dataset.nativeScrollTab;
      if (!tabId) return;
      const state = this.nativeState(tabId);
      state.scrollTop = messages.scrollTop;
      state.scrollHeight = messages.scrollHeight;
      state.followOutput = isNearBottom(messages);
      if (state.followOutput && state.newMessages) {
        state.newMessages = false;
        this.element.querySelector('[data-new-messages]')?.remove();
      }
    }, true);
    this.element.addEventListener('toggle', (event) => {
      const detail = event.target;
      if (!(detail instanceof HTMLDetailsElement) || !detail.dataset.detailId || !this.renderedTabId) return;
      const expanded = this.nativeState(this.renderedTabId).expandedDetails;
      if (detail.open) expanded.add(detail.dataset.detailId); else expanded.delete(detail.dataset.detailId);
    }, true);
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

  setFleetSnapshot(snapshot: FleetSnapshot): void {
    const changed = this.fleetSnapshot?.revision !== snapshot.revision;
    this.fleetSnapshot = snapshot;
    if (changed && this.selectedId) this.renderSelectedNative();
  }

  private applyAppearance(): void {
    this.element.style.setProperty('--terminal-padding', `${this.settings.terminalAppearance.padding}px`);
  }

  mount(container: Element | null): void {
    if (!container) return;
    this.mounted = true;
    container.append(this.element);
    this.render();
  }

  detach(): void {
    this.mounted = false;
    this.element.remove();
    this.syncConversation();
    this.syncTerminal();
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
      if (id) void this.closeTab(id);
      return true;
    }
    if (action === 'workspace-kill') {
      const tab = this.tabs.get(this.selectedId);
      if (tab) void this.killTab(tab);
      return true;
    }
    if (action === 'workspace-retry') {
      if (this.selectedId) void window.limitsWidget.retryTerminalTab(this.selectedId);
      return true;
    }
    if (action === 'workspace-open-vscode' || action === 'workspace-open-windows') {
      const tab = this.tabs.get(this.selectedId);
      if (tab) void window.limitsWidget.openFleetSessionExternal(
        tab.sessionId,
        action === 'workspace-open-vscode' ? 'vscode' : 'windowsTerminal'
      );
      return true;
    }
    if (action === 'workspace-view') {
      const mode = control.dataset.mode === 'terminal' ? 'terminal' : 'native';
      const tab = this.tabs.get(this.selectedId);
      if (tab) {
        tab.viewMode = mode;
        void window.limitsWidget.setTerminalView(tab.id, mode);
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
    if (action === 'native-new-messages') { this.scrollToLatest(); return true; }
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
    if (action === 'native-question-choice') {
      const item = this.itemFromControl(control);
      const questionId = control.dataset.questionId;
      const choice = control.dataset.choice;
      if (item && questionId && choice) void this.chooseQuestionOption(item, questionId, choice);
      return true;
    }
    if (action === 'native-question-next') {
      const item = this.itemFromControl(control);
      if (item) void this.advanceOrSubmitQuestion(item);
      return true;
    }
    if (action === 'native-question-open') {
      const item = this.itemFromControl(control);
      if (item) { this.nativeState(this.selectedId).questionSheetId = item.id; this.render(); }
      return true;
    }
    if (action === 'native-question-close') {
      this.nativeState(this.selectedId).questionSheetId = '';
      this.render();
      return true;
    }
    if (action === 'native-question-back') {
      const item = this.itemFromControl(control);
      if (item) {
        const state = this.nativeState(this.selectedId);
        state.questionSteps.set(item.id, Math.max(0, (state.questionSteps.get(item.id) ?? 0) - 1));
        state.renderMode = 'preserve';
        this.render();
      }
      return true;
    }
    if (action === 'native-copy') { void this.copyFromControl(control); return true; }
    if (action === 'native-open-tool' || action === 'native-open-plan') {
      const item = this.itemFromControl(control);
      if (item) {
        const actionIndex = Number.parseInt(control.dataset.actionIndex ?? '', 10);
        this.nativeState(this.selectedId).viewer = {
          itemId: item.id, actionIndex: Number.isFinite(actionIndex) ? actionIndex : null, wrap: false
        };
        this.render();
      }
      return true;
    }
    if (action === 'native-viewer-close') {
      this.nativeState(this.selectedId).viewer = null;
      this.render();
      return true;
    }
    if (action === 'native-viewer-wrap') {
      const viewer = this.nativeState(this.selectedId).viewer;
      if (viewer) { viewer.wrap = !viewer.wrap; this.render(); }
      return true;
    }
    if (action === 'native-toggle-tasks') {
      const item = this.itemFromControl(control);
      if (item) {
        const key = `tasks-${item.id}`;
        const expanded = this.nativeState(this.selectedId).expandedDetails;
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        this.render();
      }
      return true;
    }
    if (action === 'native-limit-schedule') {
      const attention = this.attentionFromControl(control);
      if (attention?.targetSessionId && attention.suggestedAt) {
        void this.scheduleLimit(attention, attention.suggestedAt);
      }
      return true;
    }
    if (action === 'native-limit-change') {
      const attention = this.attentionFromControl(control);
      if (attention?.targetSessionId) {
        const initial = toLocalDateTimeValue(attention.suggestedAt ?? new Date(Date.now() + 60_000).toISOString());
        const chosen = window.prompt('Schedule Continue at (local time)', initial);
        if (chosen) {
          const instant = new Date(chosen);
          const state = this.nativeState(this.selectedId);
          if (Number.isFinite(instant.getTime()) && instant.getTime() > Date.now()) void this.scheduleLimit(attention, instant.toISOString());
          else { state.notice = 'Choose a valid future time'; this.render(); }
        }
      }
      return true;
    }
    if (action === 'native-limit-dismiss') {
      const attention = this.attentionFromControl(control);
      if (attention) void this.dismissLimit(attention);
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
    this.syncConversation();
  }

  private render(): void {
    const previous = this.captureRenderSnapshot();
    for (const runtime of this.runtimes.values()) runtime.element.remove();
    const selected = this.tabs.get(this.selectedId) ?? [...this.tabs.values()].at(-1);
    if (selected) this.selectedId = selected.id;
    if (selected && previous?.tabId === selected.id) {
      const state = this.nativeState(selected.id);
      if (state.renderMode === 'append') state.newMessages = !previous.nearBottom;
    }
    this.element.innerHTML = this.tabs.size ? `
      <div class="workspace-tabs" role="tablist">
        ${[...this.tabs.values()].map((tab) => `<button role="tab" class="workspace-tab ${tab.id === this.selectedId ? 'active' : ''}" data-action="workspace-select" data-workspace-action data-tab-id="${escapeAttr(tab.id)}"><i class="terminal-status status-${tab.status}"></i><span>${escapeHtml(tab.label)}</span><small>${escapeHtml(tab.hostId)}</small><b data-action="workspace-close" data-workspace-action data-tab-id="${escapeAttr(tab.id)}" title="Close tab">×</b></button>`).join('')}
      </div>
      <div class="workspace-toolbar">
        <div class="workspace-segmented"><button data-action="workspace-view" data-workspace-action data-mode="native" class="${selected?.viewMode === 'native' ? 'active' : ''}">Native</button><button data-action="workspace-view" data-workspace-action data-mode="terminal" class="${selected?.viewMode === 'terminal' ? 'active' : ''}">Terminal</button></div>
        <span class="workspace-identity"><strong>${escapeHtml(selected?.label ?? '')}</strong><small>${escapeHtml(selected ? `${selected.hostId} · ${selected.project} · ${selected.tool}` : '')}</small></span>
        <span class="workspace-connection status-text-${selected?.status ?? 'offline'}">${escapeHtml(selected?.statusMessage ?? '')}</span>
        <button class="quiet-button" data-action="workspace-search" data-workspace-action>Find</button>
        ${selected ? `<details class="workspace-actions-menu"><summary>Actions</summary><div><button data-action="workspace-close" data-workspace-action data-tab-id="${escapeAttr(selected.id)}">Close tab</button><button class="danger-quiet" data-action="workspace-kill" data-workspace-action>Kill session…</button></div></details>` : ''}
        ${selected && selected.status !== 'live' ? '<button class="primary-button" data-action="workspace-retry" data-workspace-action>Retry</button>' : ''}
      </div>
      <div class="workspace-stage">
        <div class="native-session-panel ${selected?.viewMode === 'native' ? '' : 'hidden'}">${selected ? this.renderNative(selected) : ''}</div>
        <div class="terminal-session-panel ${selected?.viewMode === 'terminal' ? '' : 'hidden'}"></div>
      </div>` : `<div class="workspace-empty"><span>&gt;_</span><h2>No sessions open</h2><p>Open any fleet session to keep it here as a tab.</p></div>`;
    if (selected) {
      this.renderedTabId = selected.id;
      this.mountTerminal(selected);
      this.syncConversation();
      this.syncTerminal();
      queueMicrotask(() => this.restoreRenderSnapshot(selected.id, previous));
    } else {
      this.renderedTabId = '';
      this.syncConversation();
      this.syncTerminal();
    }
  }

  private mountTerminal(tab: TerminalTabDescriptor): void {
    const host = this.element.querySelector<HTMLElement>('.terminal-session-panel');
    if (!host || tab.viewMode !== 'terminal') return;
    if (tab.failure) {
      host.insertAdjacentHTML('beforeend', `<section class="terminal-unavailable"><strong>Terminal unavailable</strong><p>${escapeHtml(tab.failure.message)}</p><div><button class="primary-button" data-action="workspace-retry" data-workspace-action>Retry</button><button data-action="workspace-open-vscode" data-workspace-action>Open in VS Code</button><button data-action="workspace-open-windows" data-workspace-action>Open in Windows Terminal</button></div></section>`);
      return;
    }
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
        hasMore: false, loadingOlder: false, error: '', attachments: [], notice: '', draft: '',
        scrollTop: 0, scrollHeight: 0, scrollInitialized: false, followOutput: true, newMessages: false,
        renderMode: 'initial', questionDrafts: new Map(), questionSteps: new Map(),
        submittingQuestions: new Set(), expandedDetails: new Set(), questionSheetId: '', viewer: null };
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
        this.renderSelectedNative();
      }
    });
  }

  private syncConversation(): void {
    const selected = this.tabs.get(this.selectedId);
    const desired = this.mounted && !document.hidden && selected?.viewMode === 'native' && selected.tool !== 'shell'
      ? selected.id : '';
    for (const tabId of [...this.conversationStarted]) {
      if (tabId !== desired) {
        this.conversationStarted.delete(tabId);
        void window.limitsWidget.stopConversation(tabId);
      }
    }
    if (desired && selected) this.startConversation(selected);
  }

  private syncTerminal(): void {
    const selected = this.tabs.get(this.selectedId);
    const desired = this.mounted && !document.hidden && selected?.viewMode === 'terminal' && !selected.failure
      ? selected.id : '';
    if (desired === this.boundTerminalId) return;
    this.boundTerminalId = desired;
    void window.limitsWidget.bindTerminalTab(desired);
  }

  private applyConversationFrame(tabId: string, frame: ConversationFrame): void {
    if (!this.tabs.has(tabId)) return;
    const state = this.nativeState(tabId);
    const pendingBefore = [...state.items].reverse().find((item) => ['question', 'approval'].includes(item.kind) && item.state !== 'complete')?.id ?? '';
    if (frame.type === 'conversation.snapshot') {
      const firstSnapshot = !state.scrollInitialized && !state.items.length;
      state.items = mergeItems([], frame.items ?? []);
      state.renderMode = firstSnapshot ? 'initial' : 'preserve';
      state.interactionMode = frame.interactionMode ?? 'unknown';
      state.connection = 'Live'; state.error = '';
      state.nextCursor = frame.nextCursor ?? null; state.hasMore = Boolean(frame.hasMore); state.loadingOlder = false;
    } else if (frame.type === 'conversation.event' && frame.item) {
      state.renderMode = 'append';
      state.items = mergeItems(state.items, [frame.item]); state.connection = 'Live'; state.error = '';
    } else if (frame.type === 'conversation.error') {
      state.connection = 'Unavailable'; state.error = frame.error?.message ?? 'Native view is unavailable';
    } else {
      const connection = frame.status === 'ready' ? 'Live' : frame.status?.replaceAll('_', ' ') ?? state.connection;
      const interactionMode = frame.interactionMode && frame.interactionMode !== 'unknown'
        ? frame.interactionMode : state.interactionMode;
      if (connection === state.connection && interactionMode === state.interactionMode) return;
      state.connection = connection;
      state.interactionMode = interactionMode;
    }
    const activeQuestionIds = new Set(state.items.filter((item) => item.kind === 'question' && item.state !== 'complete').map((item) => item.id));
    for (const id of state.submittingQuestions) if (!activeQuestionIds.has(id)) state.submittingQuestions.delete(id);
    const pendingAfter = [...state.items].reverse().find((item) => ['question', 'approval'].includes(item.kind) && item.state !== 'complete')?.id ?? '';
    if (!pendingAfter) state.questionSheetId = '';
    else if (pendingAfter !== pendingBefore && state.followOutput && !state.viewer) state.questionSheetId = pendingAfter;
    if (tabId === this.selectedId) this.queueNativeRender();
  }

  private queueNativeRender(): void {
    if (this.nativeRenderQueued) return;
    this.nativeRenderQueued = true;
    requestAnimationFrame(() => {
      this.nativeRenderQueued = false;
      this.renderSelectedNative();
    });
  }

  private renderSelectedNative(): void {
    const tab = this.tabs.get(this.selectedId);
    const host = this.element.querySelector<HTMLElement>('.native-session-panel');
    if (!tab || !host || tab.viewMode !== 'native') return;
    const previous = this.captureRenderSnapshot();
    host.innerHTML = this.renderNative(tab);
    queueMicrotask(() => this.restoreRenderSnapshot(tab.id, previous));
  }

  private renderNative(tab: TerminalTabDescriptor): string {
    if (tab.tool === 'shell') return `<div class="native-shell"><div class="native-shell-intro"><strong>Friendly shell</strong><span>Use short navigation commands here. Switch to Terminal for full-screen programs.</span></div>${this.renderComposer(tab, this.nativeState(tab.id))}</div>`;
    const state = this.nativeState(tab.id);
    const pending = [...state.items].reverse().find((item) => ['question', 'approval'].includes(item.kind) && item.state !== 'complete');
    const feedItems = pending ? state.items.filter((item) => item.id !== pending.id) : state.items;
    const viewerItem = state.viewer ? state.items.find((item) => item.id === state.viewer?.itemId) : undefined;
    const attention = this.fleetSnapshot?.attention.find((item) => item.kind === 'hard-limit' && item.targetSessionId === tab.sessionId);
    return `<div class="native-conversation ${state.interactionMode === 'plan' ? 'planning' : ''}" data-native-tab="${escapeAttr(tab.id)}">
      <div class="native-conversation-header"><span><i class="terminal-status status-${state.connection === 'Live' ? 'live' : 'offline'}"></i>${escapeHtml(state.connection)}</span>${state.interactionMode === 'plan' ? '<b>Planning mode</b>' : ''}</div>
      <div class="native-messages" data-native-scroll-tab="${escapeAttr(tab.id)}">
        ${state.hasMore ? `<button class="load-older" data-action="native-load-older" data-workspace-action ${state.loadingOlder ? 'disabled' : ''}>${state.loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>` : ''}
        ${state.error ? `<div class="native-error"><strong>Native view needs attention</strong><span>${escapeHtml(state.error)}</span><button data-action="native-retry" data-workspace-action>Retry</button></div>` : ''}
        ${renderConversationRows(feedItems, state.expandedDetails)}
        ${!state.items.length && !state.error ? '<div class="native-empty"><strong>Loading conversation…</strong><span>The newest messages appear first; older history loads only when requested.</span></div>' : ''}
      </div>
      ${state.newMessages ? '<button class="new-messages-button" data-new-messages data-action="native-new-messages" data-workspace-action>New messages ↓</button>' : ''}
      ${attention ? renderLimitCard(attention) : ''}
      ${pending ? this.renderPendingAction(pending, state) : this.renderComposer(tab, state)}
      ${viewerItem && state.viewer ? renderConversationViewer(viewerItem, state.viewer) : ''}
    </div>`;
  }

  private renderPendingAction(item: ConversationItem, state: NativeState): string {
    const content = item.kind === 'question'
      ? renderQuestion(item, state.questionSteps.get(item.id) ?? 0, state.questionDrafts.get(item.id), state.submittingQuestions.has(item.id))
      : renderConversationItem(item);
    const label = item.kind === 'question' ? (item.title || 'Answer needed') : (item.title || 'Approval needed');
    return `<section class="native-answer-bar ${state.interactionMode === 'plan' ? 'planning' : ''}" data-conversation-item="${escapeAttr(item.id)}"><button data-action="native-question-open" data-workspace-action><span><strong>${escapeHtml(label)}</strong><small>Tap to respond</small></span><b>Open</b></button></section>
      ${state.questionSheetId === item.id ? `<div class="native-sheet-backdrop"><section class="native-question-sheet"><header><span><strong>Action needed</strong><small>Complete this to continue the session</small></span><button class="quiet-button" data-action="native-question-close" data-workspace-action aria-label="Close">×</button></header>${content}</section></div>` : ''}`;
  }

  private renderComposer(tab: TerminalTabDescriptor, state: NativeState): string {
    return `<div class="native-composer ${state.interactionMode === 'plan' ? 'planning' : ''}" data-composer-tab="${escapeAttr(tab.id)}">
      ${state.attachments.length ? `<div class="attachment-strip">${state.attachments.map((item) => `<button data-action="native-remove-attachment" data-workspace-action data-attachment-id="${escapeAttr(item.id)}" title="Remove ${escapeAttr(item.name)}"><img src="${item.thumbnail}" alt=""><span>${escapeHtml(item.name)}</span><b>×</b></button>`).join('')}</div>` : ''}
      ${state.notice ? `<small class="composer-notice">${escapeHtml(state.notice)}</small>` : ''}
      <textarea data-native-message data-focus-key="native-message" maxlength="32768" placeholder="Message ${escapeAttr(tab.tool)}… (Ctrl+Enter to send)">${escapeHtml(state.draft)}</textarea>
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
      state.renderMode = 'prepend';
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
    this.captureVisibleQuestionDraft(item.id);
    const state = this.nativeState(this.selectedId);
    const answers = state.questionDrafts.get(item.id) ?? [];
    for (const question of item.questions) {
      const answer = answers.find((value) => value.questionId === question.id);
      if (question.required && !answer?.choiceIds.length && !answer?.text.trim()) {
        state.notice = `Answer “${question.header || question.prompt}” first`;
        state.questionSteps.set(item.id, item.questions.indexOf(question));
        this.render(); return;
      }
    }
    state.submittingQuestions.add(item.id);
    state.notice = 'Submitting answers…';
    this.render();
    const result = await window.limitsWidget.answerConversation(this.selectedId, item.id, item.revision, answers);
    state.notice = result.message;
    if (result.ok) state.items = mergeItems(state.items, [{ ...item, state: 'running', title: 'Answer sent…', answers }]);
    else state.submittingQuestions.delete(item.id);
    this.render();
  }

  private captureQuestionDraft(input: HTMLInputElement | HTMLTextAreaElement): void {
    const card = input.closest<HTMLElement>('[data-conversation-item]');
    if (!card?.dataset.conversationItem) return;
    this.captureVisibleQuestionDraft(card.dataset.conversationItem);
  }

  private captureVisibleQuestionDraft(itemId: string): void {
    const candidates = [...this.element.querySelectorAll<HTMLElement>('[data-conversation-item]')]
      .filter((node) => node.dataset.conversationItem === itemId);
    const card = candidates.find((node) => node.querySelector('[data-question-id]')) ?? candidates[0];
    const item = this.nativeState(this.selectedId).items.find((value) => value.id === itemId);
    if (!card || !item) return;
    const state = this.nativeState(this.selectedId);
    const answers = [...(state.questionDrafts.get(itemId) ?? item.answers ?? [])];
    const step = state.questionSteps.get(itemId) ?? 0;
    const question = item.questions?.[Math.min(step, (item.questions?.length ?? 1) - 1)];
    const textInput = card.querySelector<HTMLTextAreaElement>('[data-question-text]');
    const questionId = textInput?.dataset.questionId ?? question?.id;
    if (!questionId || !textInput) return;
    const previous = answers.find((value) => value.questionId === questionId);
    const next = { questionId, choiceIds: previous?.choiceIds ?? [], text: textInput.value };
    const index = answers.findIndex((value) => value.questionId === questionId);
    if (index >= 0) answers[index] = next; else answers.push(next);
    state.questionDrafts.set(itemId, answers);
  }

  private async chooseQuestionOption(item: ConversationItem, questionId: string, choice: string): Promise<void> {
    if (!item.questions?.length) return;
    const state = this.nativeState(this.selectedId);
    const step = state.questionSteps.get(item.id) ?? 0;
    const question = item.questions[Math.min(step, item.questions.length - 1)];
    if (question.id !== questionId) return;
    const answers = [...(state.questionDrafts.get(item.id) ?? item.answers ?? [])];
    const index = answers.findIndex((value) => value.questionId === question.id);
    const previous = index >= 0 ? answers[index] : { questionId: question.id, choiceIds: [], text: '' };
    const choiceIds = question.type === 'multi'
      ? (previous.choiceIds.includes(choice) ? previous.choiceIds.filter((value) => value !== choice) : [...previous.choiceIds, choice])
      : [choice];
    const next = { ...previous, choiceIds };
    if (index >= 0) answers[index] = next; else answers.push(next);
    state.questionDrafts.set(item.id, answers);
    if (question.type === 'multi') { this.render(); return; }
    if (step < item.questions.length - 1) {
      state.questionSteps.set(item.id, step + 1);
      state.renderMode = 'preserve';
      this.render();
    } else await this.submitQuestion(item);
  }

  private async advanceOrSubmitQuestion(item: ConversationItem): Promise<void> {
    if (!item.questions?.length) return;
    this.captureVisibleQuestionDraft(item.id);
    const state = this.nativeState(this.selectedId);
    const step = state.questionSteps.get(item.id) ?? 0;
    const question = item.questions[Math.min(step, item.questions.length - 1)];
    const answer = state.questionDrafts.get(item.id)?.find((value) => value.questionId === question.id);
    if (!answer || (!answer.choiceIds.length && !answer.text.trim())) {
      state.notice = `Answer “${question.header || question.prompt}” first`;
      this.render();
      return;
    }
    if (step >= item.questions.length - 1) { await this.submitQuestion(item); return; }
    state.questionSteps.set(item.id, step + 1);
    state.renderMode = 'preserve';
    this.render();
  }

  private async closeTab(tabId: string): Promise<void> {
    const state = this.nativeStates.get(tabId);
    if ((state?.draft.trim() || state?.attachments.length) && !window.confirm('Close this tab and discard its unsent draft and staged attachments?')) return;
    await window.limitsWidget.closeTerminalTab(tabId);
  }

  private async killTab(tab: TerminalTabDescriptor): Promise<void> {
    if (!window.confirm(`Kill “${tab.label}” on ${tab.hostId}? This destroys the tmux session and cancels its pending schedules.`)) return;
    const result = await window.limitsWidget.killFleetSession(tab.sessionId);
    const state = this.nativeState(tab.id);
    state.notice = result.message;
    if (result.ok) await window.limitsWidget.closeTerminalTab(tab.id);
    else this.render();
  }

  private attentionFromControl(control: HTMLElement): FleetAttention | undefined {
    const id = control.closest<HTMLElement>('[data-attention-id]')?.dataset.attentionId;
    return this.fleetSnapshot?.attention.find((item) => item.id === id);
  }

  private async scheduleLimit(attention: FleetAttention, deliverAt: string): Promise<void> {
    if (!attention.targetSessionId) return;
    const state = this.nativeState(this.selectedId);
    state.notice = 'Scheduling Continue…';
    this.render();
    const result = await window.limitsWidget.createFleetContinueSchedule(attention.targetSessionId, deliverAt, attention.id);
    state.notice = result.message;
    this.render();
  }

  private async dismissLimit(attention: FleetAttention): Promise<void> {
    const state = this.nativeState(this.selectedId);
    state.notice = 'Dismissing limit offer…';
    this.render();
    const result = await window.limitsWidget.dismissFleetAttention(attention.id);
    state.notice = result.message;
    this.render();
  }

  private async copyFromControl(control: HTMLElement): Promise<void> {
    const source = control.closest<HTMLElement>('[data-copy-source]');
    const value = source?.querySelector<HTMLElement>('[data-copy-value]')?.textContent
      ?? source?.querySelector<HTMLElement>('pre, code')?.textContent ?? '';
    const result = await window.limitsWidget.copyConversationText(value);
    const previous = control.textContent;
    control.textContent = result.ok ? 'Copied' : 'Copy failed';
    window.setTimeout(() => { if (control.isConnected) control.textContent = previous; }, 1_500);
  }

  private scrollToLatest(): void {
    const messages = this.element.querySelector<HTMLElement>('.native-messages');
    if (!messages) return;
    messages.scrollTop = messages.scrollHeight;
    const state = this.nativeState(this.selectedId);
    state.followOutput = true; state.newMessages = false; state.scrollTop = messages.scrollTop;
    this.element.querySelector('[data-new-messages]')?.remove();
  }

  private captureRenderSnapshot(): RenderSnapshot | null {
    if (!this.renderedTabId) return null;
    const messages = this.element.querySelector<HTMLElement>('.native-messages');
    if (!messages) return null;
    const state = this.nativeState(this.renderedTabId);
    state.scrollTop = messages.scrollTop;
    state.scrollHeight = messages.scrollHeight;
    state.followOutput = isNearBottom(messages);
    for (const detail of this.element.querySelectorAll<HTMLDetailsElement>('details[data-detail-id]')) {
      if (detail.open) state.expandedDetails.add(detail.dataset.detailId!); else state.expandedDetails.delete(detail.dataset.detailId!);
    }
    const active = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
      ? document.activeElement : null;
    return {
      tabId: this.renderedTabId, scrollTop: messages.scrollTop, scrollHeight: messages.scrollHeight,
      nearBottom: isNearBottom(messages), focusKey: active?.dataset.focusKey ?? '',
      selectionStart: active?.selectionStart ?? null, selectionEnd: active?.selectionEnd ?? null
    };
  }

  private restoreRenderSnapshot(tabId: string, previous: RenderSnapshot | null): void {
    const messages = this.element.querySelector<HTMLElement>('.native-messages');
    const state = this.nativeState(tabId);
    if (!messages) return;
    this.enhanceMarkdownCopy();
    if ((!state.scrollInitialized || state.renderMode === 'initial') && state.items.length) {
      messages.scrollTop = messages.scrollHeight;
      state.scrollInitialized = true; state.followOutput = true; state.newMessages = false;
    } else if (!state.scrollInitialized) {
      messages.scrollTop = 0;
    } else if (previous?.tabId === tabId) {
      messages.scrollTop = resolveConversationScroll(
        state.renderMode === 'initial' ? 'preserve' : state.renderMode,
        previous.scrollTop, previous.scrollHeight, messages.scrollHeight, previous.nearBottom
      );
      if (state.renderMode === 'append' && !previous.nearBottom) state.newMessages = true;
    } else messages.scrollTop = Math.min(state.scrollTop, messages.scrollHeight);
    state.scrollTop = messages.scrollTop; state.scrollHeight = messages.scrollHeight;
    state.followOutput = isNearBottom(messages); state.renderMode = 'preserve';
    for (const detail of this.element.querySelectorAll<HTMLDetailsElement>('details[data-detail-id]')) {
      detail.open = Boolean(detail.dataset.detailId && state.expandedDetails.has(detail.dataset.detailId));
    }
    if (previous?.tabId === tabId && previous.focusKey) {
      const focus = [...this.element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-focus-key]')]
        .find((value) => value.dataset.focusKey === previous.focusKey);
      focus?.focus();
      if (focus && previous.selectionStart !== null && previous.selectionEnd !== null) focus.setSelectionRange(previous.selectionStart, previous.selectionEnd);
    }
  }

  private enhanceMarkdownCopy(): void {
    for (const pre of this.element.querySelectorAll<HTMLElement>('.native-markdown pre')) {
      if (pre.parentElement?.matches('[data-copy-source]')) continue;
      const wrapper = document.createElement('div'); wrapper.className = 'copy-code-block'; wrapper.dataset.copySource = '';
      const copyValue = document.createElement('span'); copyValue.hidden = true; copyValue.dataset.copyValue = '';
      copyValue.textContent = pre.textContent ?? '';
      const button = document.createElement('button'); button.textContent = 'Copy'; button.dataset.action = 'native-copy'; button.dataset.workspaceAction = '';
      pre.replaceWith(wrapper); wrapper.append(copyValue, button, pre);
    }
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

export function renderConversationRows(items: ConversationItem[], expanded = new Set<string>()): string {
  let html = '';
  const hasTasks = items.some((item) => item.kind === 'task_list');
  for (let index = 0; index < items.length;) {
    if (hasTasks && items[index].kind === 'status' && ['Working', 'Done'].includes(items[index].title)) { index += 1; continue; }
    if (items[index].kind === 'tool') {
      const tools: ConversationItem[] = [];
      while (items[index]?.kind === 'tool') tools.push(items[index++]);
      html += tools.length > 1 ? renderToolGroup(tools) : renderTool(tools[0]);
      continue;
    }
    html += renderConversationItem(items[index++], expanded);
  }
  return html;
}

function terminalDescriptorEqual(left: TerminalTabDescriptor, right: TerminalTabDescriptor): boolean {
  return left.id === right.id && left.sessionId === right.sessionId && left.hostId === right.hostId
    && left.project === right.project && left.internalName === right.internalName && left.label === right.label
    && left.tool === right.tool && left.backend === right.backend && left.viewMode === right.viewMode
    && left.status === right.status && left.statusMessage === right.statusMessage
    && left.failure?.code === right.failure?.code && left.failure?.message === right.failure?.message
    && left.failure?.retryable === right.failure?.retryable;
}

function renderConversationItem(item: ConversationItem, expanded = new Set<string>()): string {
  if (item.kind === 'question') return renderQuestion(item);
  if (item.kind === 'task_list') return renderTaskList(item, expanded.has(`tasks-${item.id}`));
  if (item.kind === 'plan') return `<article class="native-card plan-card" data-conversation-item="${escapeAttr(item.id)}"><small>Plan</small><h3>${escapeHtml(item.title || 'Plan ready')}</h3><div class="plan-preview">${markdown(item.text)}</div><div class="card-actions"><button data-action="native-open-plan" data-workspace-action>Open plan</button></div></article>`;
  if (item.kind === 'approval') return `<article class="native-card approval-card state-${escapeAttr(item.state)}" data-conversation-item="${escapeAttr(item.id)}"><small>Approval</small><h3>${escapeHtml(item.title || 'Approval needed')}</h3>${markdown(item.text || item.detail)}<div class="native-choice-actions">${item.state === 'complete' ? '<b>Answered</b>' : item.choices.map((choice) => `<button class="${/deny|reject|cancel/iu.test(choice.id) ? 'quiet-button' : 'primary-button'}" data-action="native-approve" data-workspace-action data-choice="${escapeAttr(choice.id)}">${escapeHtml(choice.label)}</button>`).join('')}</div></article>`;
  if (item.kind === 'change') return `<article class="native-card change-card"><small>Files changed</small><h3>${escapeHtml(item.title || item.target || 'Change')}</h3>${markdown(item.text || item.detail)}</article>`;
  if (item.kind === 'error') return `<article class="native-card native-error"><strong>${escapeHtml(item.title || 'Error')}</strong>${markdown(item.text || item.detail)}</article>`;
  const role = item.role === 'user' ? 'user' : item.role === 'assistant' ? 'assistant' : 'activity';
  const content = item.text || item.detail;
  if (!content && !item.title) return '';
  return `<article class="native-message ${role}">${item.title && item.title !== content ? `<small>${escapeHtml(item.title)}</small>` : ''}${markdown(content || item.title)}</article>`;
}

function renderTaskList(item: ConversationItem, expanded: boolean): string {
  const tasks = item.tasks ?? [];
  if (!tasks.length) return '';
  const complete = tasks.every((task) => task.state === 'completed');
  const active = tasks.findIndex((task) => task.state === 'in_progress');
  let visible = tasks;
  if (!expanded && !complete && tasks.length > 6) {
    const center = active >= 0 ? active : tasks.findIndex((task) => task.state === 'pending');
    const start = Math.max(0, Math.min(tasks.length - 6, center - 2));
    visible = tasks.slice(start, start + 6);
  }
  const rows = visible.map((task) => `<li class="task-${escapeAttr(task.state)}"><i>${task.state === 'completed' ? '✓' : task.state === 'in_progress' ? '●' : '○'}</i><span><strong>${escapeHtml(task.state === 'in_progress' && task.activeTitle ? task.activeTitle : task.title)}</strong>${task.detail ? `<small>${escapeHtml(task.detail)}</small>` : ''}</span></li>`).join('');
  if (complete && !expanded) return `<article class="native-card task-card complete" data-conversation-item="${escapeAttr(item.id)}"><button class="task-summary" data-action="native-toggle-tasks" data-workspace-action><span>✓</span><strong>All ${tasks.length} tasks complete</strong><b>Show</b></button></article>`;
  return `<article class="native-card task-card" data-conversation-item="${escapeAttr(item.id)}"><small>${complete ? 'Completed tasks' : 'Current work'}</small><h3>${escapeHtml(item.title || 'Tasks')}</h3>${item.text ? `<p>${escapeHtml(item.text)}</p>` : ''}<ol>${rows}</ol>${tasks.length > visible.length || complete ? `<button class="task-toggle" data-action="native-toggle-tasks" data-workspace-action>${expanded ? 'Show less' : `Show all ${tasks.length}`}</button>` : ''}</article>`;
}

function renderQuestion(item: ConversationItem, requestedStep = 0, draftAnswers?: ConversationAnswer[], submitting = false): string {
  const complete = item.state === 'complete';
  const questions = item.questions?.length ? item.questions : fallbackQuestion(item);
  const step = Math.max(0, Math.min(requestedStep, questions.length - 1));
  const answerSource = draftAnswers?.length ? draftAnswers : item.answers;
  const visibleQuestions = complete ? questions : [questions[step]];
  const current = questions[step];
  const explicitAction = !complete && current && (['multi', 'text'].includes(current.type) || current.allowOther);
  const actionLabel = current?.type === 'multi' ? 'Done' : 'Send';
  return `<article class="native-card question-card state-${escapeAttr(item.state)} ${submitting ? 'submitting' : ''}" data-conversation-item="${escapeAttr(item.id)}"><div class="question-scroll"><small>${complete ? 'Answered' : 'Question'}</small><h3>${escapeHtml(item.title || 'Your input is needed')}</h3>${item.text ? markdown(item.text) : ''}
    ${!complete && questions.length > 1 ? `<div class="question-progress"><span>Question ${step + 1} of ${questions.length}</span>${questions.map((_question, index) => `<i class="${index < step ? 'done' : index === step ? 'active' : ''}"></i>`).join('')}</div>` : ''}
    ${visibleQuestions.map((question) => renderQuestionPart(question, item, answerSource)).join('')}
    ${complete ? '<div class="question-complete">Answer submitted</div>' : ''}</div>
    ${complete ? '' : `<div class="question-navigation">${step > 0 ? '<button class="quiet-button" data-action="native-question-back" data-workspace-action>Back</button>' : '<span></span>'}${explicitAction ? `<button class="primary-button question-submit" data-action="native-question-next" data-workspace-action ${submitting ? 'disabled' : ''}>${submitting ? 'Sending…' : actionLabel}</button>` : '<small>Tap an answer to continue</small>'}</div>`}</article>`;
}

function renderQuestionPart(question: ConversationQuestion, item: ConversationItem, answers?: ConversationAnswer[]): string {
  const existing = answers?.find((answer) => answer.questionId === question.id) ?? item.answers?.find((answer) => answer.questionId === question.id);
  const choices = question.type === 'boolean' && !question.options.length
    ? [{ id: 'true', label: 'Yes', description: '' }, { id: 'false', label: 'No', description: '' }]
    : question.options;
  const options = choices.map((option) => `<button type="button" class="question-option ${existing?.choiceIds.includes(option.id) ? 'selected' : ''}" data-action="native-question-choice" data-workspace-action data-choice="${escapeAttr(option.id)}" data-question-id="${escapeAttr(question.id)}"><span><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</span><b>${existing?.choiceIds.includes(option.id) ? '✓' : ''}</b></button>`).join('');
  const textInput = question.type === 'text' || question.allowOther
    ? `<textarea data-question-text data-question-id="${escapeAttr(question.id)}" data-focus-key="question-${escapeAttr(item.id)}-${escapeAttr(question.id)}" placeholder="${question.type === 'text' ? 'Type your answer' : 'Or type another answer'}" enterkeyhint="send">${escapeHtml(existing?.text ?? '')}</textarea>` : '';
  return `<fieldset class="question-part"><legend>${question.header ? `<small>${escapeHtml(question.header)}</small>` : ''}<strong>${escapeHtml(question.prompt)}</strong></legend>${options}${textInput}</fieldset>`;
}

function fallbackQuestion(item: ConversationItem): ConversationQuestion[] {
  return [{ id: 'answer', header: '', prompt: item.text || item.title, type: item.choices.length ? 'single' : 'text', required: true,
    allowOther: !item.choices.length, options: item.choices.map((choice) => ({ ...choice, description: '' })) }];
}

function renderToolGroup(tools: ConversationItem[]): string {
  const running = tools.filter((tool) => tool.state === 'running').length;
  const label = tools.map(toolLabel).filter((value, index, all) => all.indexOf(value) === index).slice(0, 3).join(', ');
  const completed = tools.filter((tool) => tool.state === 'complete').length;
  return `<details class="tool-group" data-detail-id="group-${escapeAttr(tools[0].id)}"><summary><span><strong>${tools.length} tool calls</strong><small>${escapeHtml(label)} · ${completed} done${running ? ` · ${running} running` : ''}</small></span><b>Show</b></summary><div>${tools.map(renderTool).join('')}</div></details>`;
}

function renderTool(item: ConversationItem): string {
  const presentation = item.presentation;
  const title = presentation?.title || humanizeTool(item.tool || item.action || 'Tool');
  const subtitle = presentation?.subtitle || item.target || stateLabel(item.state);
  const inputBlocks = presentation?.inputBlocks?.length ? presentation.inputBlocks : item.input ? [{ title: 'Input', kind: 'json', content: item.input }] : [];
  const resultBlocks = presentation?.resultBlocks?.length ? presentation.resultBlocks : item.result ? [{ title: 'Result', kind: 'text', content: item.result }] : [];
  const duration = toolDuration(item);
  const actions = inputBlocks.length > 1 ? renderToolActions(item, inputBlocks) : '';
  const preview = resultBlocks[0] ?? inputBlocks[0];
  return `<article class="tool-call state-${escapeAttr(item.state)}" data-conversation-item="${escapeAttr(item.id)}"><div class="tool-call-heading"><span class="tool-state"></span><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle || item.target || stateLabel(item.state))}</small></span><span class="tool-summary-meta"><b>${escapeHtml(stateLabel(item.state))}</b>${duration ? `<small>${escapeHtml(duration)}</small>` : ''}</span></div>${actions}${preview ? renderToolPreview(preview) : '<p class="tool-empty">No details reported.</p>'}<div class="card-actions"><button data-action="native-open-tool" data-workspace-action>Details</button></div></article>`;
}

function renderToolActions(item: ConversationItem, blocks: ToolPresentationBlock[]): string {
  return `<div class="tool-actions">${blocks.map((block, index) => {
    const preview = block.content.split(/\r?\n/u).find((line) => line.trim())?.trim() || 'No details';
    const shortened = preview.length > 120 ? `${preview.slice(0, 117)}…` : preview;
    return `<button class="tool-action" data-action="native-open-tool" data-workspace-action data-action-index="${index}" data-conversation-item="${escapeAttr(item.id)}"><span><strong>${index + 1}. ${escapeHtml(block.title)}</strong><small>${escapeHtml(shortened)}</small></span><b>Details</b></button>`;
  }).join('')}</div>`;
}

function renderToolPreview(block: ToolPresentationBlock): string {
  const lines = block.content.split(/\r?\n/u).slice(0, 6);
  let content = lines.join('\n');
  if (content.length > 700) content = `${content.slice(0, 697)}…`;
  if (block.content.split(/\r?\n/u).length > 6) content += '\n…';
  return `<div class="tool-preview"><small>${escapeHtml(block.title)}</small><pre><code>${escapeHtml(content)}</code></pre></div>`;
}

function renderToolBlock(block: ToolPresentationBlock, compact = false, wrap = false): string {
  const controls = compact
    ? `<div class="tool-action-controls"><button data-action="native-copy" data-workspace-action>Copy</button></div>`
    : `<h4><span>${escapeHtml(block.title)}</span><button data-action="native-copy" data-workspace-action>Copy</button></h4>`;
  if (block.kind === 'markdown') return `<section data-copy-source>${controls}<span hidden data-copy-value>${escapeHtml(block.content)}</span>${markdown(block.content)}</section>`;
  const content = block.kind === 'json' ? prettyJson(block.content) : block.content;
  const highlighted = content.length <= 24_000 ? hljs.highlightAuto(content).value : escapeHtml(content);
  const rendered = block.kind === 'diff' ? renderDiff(content)
    : `<pre class="tool-block-${escapeAttr(block.kind)} ${wrap || block.kind === 'terminal' || block.kind === 'text' ? 'wrap' : 'no-wrap'}"><code>${highlighted}</code></pre>`;
  return `<section data-copy-source>${controls}<span hidden data-copy-value>${escapeHtml(content)}</span>${rendered}</section>`;
}

function renderConversationViewer(item: ConversationItem, viewer: { itemId: string; actionIndex: number | null; wrap: boolean }): string {
  if (item.kind === 'plan') return `<div class="native-viewer-backdrop"><section class="native-viewer" data-conversation-item="${escapeAttr(item.id)}"><header><span><small>Plan</small><strong>${escapeHtml(item.title || 'Plan')}</strong></span><div data-copy-source><span hidden data-copy-value>${escapeHtml(item.text)}</span><button data-action="native-copy" data-workspace-action>Copy</button><button class="quiet-button" data-action="native-viewer-close" data-workspace-action>Close</button></div></header><div class="native-viewer-body plan-viewer">${markdown(item.text)}</div></section></div>`;
  const presentation = item.presentation;
  const allInput = presentation?.inputBlocks?.length ? presentation.inputBlocks : item.input ? [{ title: 'Input', kind: 'json', content: item.input }] : [];
  const result = presentation?.resultBlocks?.length ? presentation.resultBlocks : item.result ? [{ title: 'Result', kind: 'text', content: item.result }] : [];
  const selected = viewer.actionIndex === null ? allInput : allInput[viewer.actionIndex] ? [allInput[viewer.actionIndex]] : allInput;
  const raw = [item.input ? { title: 'Raw input', kind: 'json', content: item.input } : null, item.result ? { title: 'Raw result', kind: 'json', content: item.result } : null].filter((value): value is ToolPresentationBlock => Boolean(value));
  const title = presentation?.title || humanizeTool(item.tool || item.action || 'Tool');
  return `<div class="native-viewer-backdrop"><section class="native-viewer" data-conversation-item="${escapeAttr(item.id)}"><header><span><small>${escapeHtml(stateLabel(item.state))}</small><strong>${escapeHtml(title)}</strong></span><div><button data-action="native-viewer-wrap" data-workspace-action>${viewer.wrap ? 'No wrap' : 'Wrap'}</button><button class="quiet-button" data-action="native-viewer-close" data-workspace-action>Close</button></div></header><div class="native-viewer-body">${selected.map((block) => renderToolBlock(block, false, viewer.wrap)).join('')}${result.map((block) => renderToolBlock(block, false, viewer.wrap)).join('')}${raw.length ? `<details class="tool-raw"><summary>Raw data</summary>${raw.map((block) => renderToolBlock(block, false, viewer.wrap)).join('')}</details>` : ''}</div></section></div>`;
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

export function mergeItems(current: ConversationItem[], incoming: ConversationItem[]): ConversationItem[] {
  return mergeConversationItems(current, incoming);
}

function renderLimitCard(item: FleetAttention): string {
  return `<section class="native-limit-card" data-attention-id="${escapeAttr(item.id)}"><div><small>Usage limit detected</small><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div><div><button class="primary-button" data-action="native-limit-schedule" data-workspace-action>Schedule Continue</button><button class="quiet-button" data-action="native-limit-change" data-workspace-action>Change time</button><button class="danger-quiet" data-action="native-limit-dismiss" data-workspace-action>Dismiss</button></div></section>`;
}

function toolDuration(item: ConversationItem): string {
  if (!item.startedAt || !item.completedAt) return '';
  const milliseconds = Date.parse(item.completedAt) - Date.parse(item.startedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
}

function prettyJson(value: string): string {
  try { return JSON.stringify(JSON.parse(value) as unknown, null, 2); }
  catch { return value; }
}

function renderDiff(value: string): string {
  return `<pre class="tool-diff"><code>${value.split('\n').map((line) => {
    const kind = line.startsWith('+') && !line.startsWith('+++') ? 'add'
      : line.startsWith('-') && !line.startsWith('---') ? 'remove'
        : line.startsWith('@@') ? 'range' : 'context';
    return `<span class="diff-${kind}">${escapeHtml(line)}</span>`;
  }).join('\n')}</code></pre>`;
}

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 120;
}

function toLocalDateTimeValue(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function escapeAttr(value: string): string { return escapeHtml(value); }
