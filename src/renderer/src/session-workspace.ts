import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import hljs from 'highlight.js';
import type { WidgetSettings } from '../../shared/settings';
import type { TerminalTabDescriptor, TerminalWorkspaceState } from '../../shared/terminal';
import type { FleetAttention, FleetSession, FleetSnapshot } from '../../shared/fleet';
import type { FleetModelControlState, FleetModelOption } from '../../shared/fleet-protocol';
import { isFleetSessionAvailable, reconcileHiddenUnavailableSessions, sessionIdentityPresentation } from '../../shared/fleet';
import type {
  ConversationAnswer, ConversationFrame, ConversationItem, ConversationQuestion, ProviderActivity, StagedAttachment,
  ToolPresentationBlock
} from '../../shared/conversation';
import { mergeConversationItems, resolveConversationScroll } from '../../shared/conversation';
import {
  canSuggestForComposer,
  canSuggestForQuestion,
  conversationSuggestionContext,
  createDefaultLocalSuggestionSettings,
  localSuggestionRevision,
  localSuggestionsEnabled,
  shouldStartAutomaticSuggestion,
  type LocalSuggestionSettingsView,
  type LocalSuggestionTarget
} from '../../shared/local-suggestions';
import {
  applyWorkspacePreset,
  defaultRailState,
  emptyWorkspaceLayout,
  focusedPane,
  paneForSession,
  workspacePanes,
  type WorkspacePane,
  type WorkspacePreset,
  type WorkspaceRailState,
  type WorkspaceSplit,
  type WorkspaceNode,
  type WorkspaceCommand
} from '../../shared/workspace-layout';
import {
  workspacePanePresentation,
  workspacePaneRenderState,
  workspaceStructureSignature
} from './workspace-render-state';
import {
  applyTerminalHistorySnapshot,
  createTerminalHistoryState,
  shouldCaptureTerminalHistoryScroll,
  terminalHistoryAtBottom,
  terminalHistoryDimensionsMatch,
  terminalHistoryEligible,
  TERMINAL_HISTORY_QUIET_MS,
  type TerminalHistoryState
} from './terminal-history';

interface TerminalRuntime {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  element: HTMLElement;
  historyTerminal?: Terminal;
  historyFit?: FitAddon;
  historyElement?: HTMLElement;
}

interface NativeState {
  items: ConversationItem[];
  interactionMode: string;
  connection: string;
  providerActivity: ProviderActivity | null;
  providerActivityReceivedAt: number;
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
  suggestion: {
    requestId: string;
    revision: string;
    target: LocalSuggestionTarget | null;
    loading: boolean;
    values: string[];
    error: string;
    automatic: boolean;
  };
  automaticSuggestionKey: string;
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
  private workspaceState: TerminalWorkspaceState = {
    version: 2,
    layout: emptyWorkspaceLayout(),
    rail: defaultRailState(),
    tabs: []
  };
  private selectedId = '';
  private mounted = false;
  private boundTerminalIds = new Set<string>();
  private fleetSnapshot: FleetSnapshot | null = null;
  private dismissedAttention = new Set<string>();
  private settings: WidgetSettings;
  private resizeObserver: ResizeObserver;
  private nativeRenderQueued = new Set<string>();
  private draggedPaneId = '';
  private terminalHistories = new Map<string, TerminalHistoryState>();
  private terminalHistoryTimers = new Map<string, number>();
  private terminalHistoryQueue: Array<{ tabId: string; generation: number }> = [];
  private terminalHistoryRequestActive = false;
  private terminalHistoryQueued = new Set<string>();
  private localSuggestionSettings: LocalSuggestionSettingsView = createDefaultLocalSuggestionSettings();
  private modelStates = new Map<string, FleetModelControlState>();
  private modelPollTimer = 0;
  private providerActivityTimer = 0;
  private modelPollActive = false;
  private modelDialogSessionId = '';
  private modelDialogLoading = false;
  private modelDialogError = '';
  private modelDialogModelId = '';
  private modelDialogEffortId = '';
  private modelDialogCustom = false;

  constructor(
    settings: WidgetSettings,
    private readonly openRepository: (sessionId: string) => void = () => undefined,
    private readonly openSessionMenu: (sessionId: string) => void = () => undefined
  ) {
    this.settings = settings;
    this.element.className = 'session-workspace';
    this.applyAppearance();
    this.resizeObserver = new ResizeObserver(() => this.fitVisible());
    this.resizeObserver.observe(this.element);
    window.limitsWidget.onTerminalData(({ tabId, data }) => {
      this.runtimes.get(tabId)?.terminal.write(data);
      this.noteTerminalHistoryActivity(tabId, false);
    });
    window.limitsWidget.onTerminalStatus(({ tab }) => {
      const previous = this.tabs.get(tab.id);
      if (previous && terminalDescriptorEqual(previous, tab)) return;
      this.upsertTab(tab);
    });
    window.limitsWidget.onTerminalClosed(({ tabId }) => this.remove(tabId));
    window.limitsWidget.onTerminalOpened((tab) => this.open(tab));
    window.limitsWidget.onWorkspaceUpdated((state) => this.applyWorkspaceState(state));
    window.limitsWidget.onConversationEvent(({ tabId, frame }) => this.applyConversationFrame(tabId, frame));
    window.limitsWidget.onLocalSuggestionSettingsUpdated((settings) => {
      const changed = settings.mode !== this.localSuggestionSettings.mode;
      this.localSuggestionSettings = settings;
      if (changed) for (const [tabId] of this.nativeStates) {
        this.clearSuggestions(tabId, true);
        this.baselineAutomaticSuggestion(tabId);
      }
      for (const tabId of this.nativeStates.keys()) this.queueNativeRender(tabId);
    });
    void window.limitsWidget.getLocalSuggestionSettings().then((settings) => {
      this.localSuggestionSettings = settings;
      for (const [tabId] of this.nativeStates) this.baselineAutomaticSuggestion(tabId);
      for (const tabId of this.nativeStates.keys()) this.queueNativeRender(tabId);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) for (const [tabId] of this.nativeStates) {
        this.clearSuggestions(tabId, true);
        this.baselineAutomaticSuggestion(tabId);
      }
      else if (this.selectedId) this.baselineAutomaticSuggestion(this.selectedId);
      this.syncConversation();
      this.syncTerminal();
      if (!document.hidden) for (const tabId of this.boundTerminalIds) this.scheduleTerminalHistory(tabId);
      if (!document.hidden) void this.pollVisibleModelStates();
    });
    window.addEventListener('keydown', (event) => {
      if (!this.mounted || document.hidden || event.defaultPrevented) return;
      if (event.altKey && event.shiftKey && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) {
        event.preventDefault();
        void this.splitFocused(event.key === 'ArrowRight' ? 'row' : 'column');
      } else if (event.altKey && !event.ctrlKey && !event.shiftKey && /^[1-4]$/u.test(event.key)) {
        const pane = workspacePanes(this.workspaceState.layout)[Number(event.key) - 1];
        if (pane) { event.preventDefault(); void this.focusPane(pane.id, true); }
      }
    });
    this.element.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return;
      const divider = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-split-divider]') : null;
      if (divider) {
        const direction = divider.dataset.direction;
        const splitId = divider.dataset.splitId;
        const split = splitId ? findWorkspaceSplit(this.workspaceState.layout.root, splitId) : undefined;
        const delta = direction === 'row' && event.key === 'ArrowLeft' || direction === 'column' && event.key === 'ArrowUp' ? -0.05
          : direction === 'row' && event.key === 'ArrowRight' || direction === 'column' && event.key === 'ArrowDown' ? 0.05 : 0;
        if (split && delta) {
          event.preventDefault();
          void this.applyCommand({ type: 'resize', splitId: split.id, ratio: split.ratio + delta });
          return;
        }
      }
      if (event.altKey && event.shiftKey && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) {
        event.preventDefault();
        void this.splitFocused(event.key === 'ArrowRight' ? 'row' : 'column');
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.shiftKey && /^[1-4]$/u.test(event.key)) {
        const pane = workspacePanes(this.workspaceState.layout)[Number(event.key) - 1];
        if (pane) { event.preventDefault(); void this.focusPane(pane.id, true); }
        return;
      }
      const control = event.target instanceof HTMLElement ? event.target : null;
      if (control) this.selectFromControl(control, false);
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
      if (input instanceof HTMLInputElement && input.matches('[data-workspace-search]')) {
        this.patchRail(input.value);
      } else if (input instanceof HTMLTextAreaElement && input.matches('[data-native-message]')) {
        const tabId = this.tabIdFromControl(input);
        if (tabId) {
          this.nativeState(tabId).draft = input.value; this.clearSuggestions(tabId, true);
          input.closest('.native-composer')?.querySelector('.local-suggestions')?.remove();
        }
      } else if (input instanceof HTMLTextAreaElement && input.matches('[data-question-text]')) {
        this.selectFromControl(input, false);
        this.captureQuestionDraft(input);
        this.clearSuggestions(this.selectedId, true);
        input.closest('.question-part')?.querySelector('.local-suggestions')?.remove();
      } else if (input instanceof HTMLInputElement && input.matches('[data-model-custom-id]')) {
        this.modelDialogModelId = input.value.trim();
      }
    });
    this.element.addEventListener('change', (event) => {
      const input = event.target;
      if (input instanceof HTMLSelectElement && input.matches('[data-model-picker]')) {
        this.modelDialogModelId = input.value;
        const selected = this.modelDialogState()?.catalog?.models.find((item) => item.id === input.value);
        this.modelDialogEffortId = selected?.defaultEffort ?? 'automatic';
        this.patchModelDialog();
      } else if (input instanceof HTMLSelectElement && input.matches('[data-effort-picker]')) {
        this.modelDialogEffortId = input.value;
      } else if (input instanceof HTMLInputElement && input.matches('[data-model-custom-toggle]')) {
        this.modelDialogCustom = input.checked;
        if (!input.checked) {
          const selected = this.modelDialogState()?.catalog?.models[0];
          this.modelDialogModelId = selected?.id ?? 'auto';
          this.modelDialogEffortId = selected?.defaultEffort ?? 'automatic';
        }
        this.patchModelDialog();
      }
    });
    this.element.addEventListener('scroll', (event) => {
      const messages = event.target;
      if (!(messages instanceof HTMLElement)) return;
      if (!messages.matches('.native-messages')) return;
      const tabId = messages.dataset.nativeScrollTab;
      if (!tabId) return;
      const state = this.nativeState(tabId);
      state.scrollTop = messages.scrollTop;
      state.scrollHeight = messages.scrollHeight;
      state.followOutput = isNearBottom(messages);
      if (state.followOutput && state.newMessages) {
        state.newMessages = false;
        messages.closest('[data-pane-id]')?.querySelector('[data-new-messages]')?.remove();
      }
    }, true);
    this.element.addEventListener('toggle', (event) => {
      const detail = event.target;
      if (!(detail instanceof HTMLDetailsElement) || !detail.dataset.detailId) return;
      const tabId = this.tabIdFromControl(detail);
      if (!tabId) return;
      const expanded = this.nativeState(tabId).expandedDetails;
      if (detail.open) expanded.add(detail.dataset.detailId); else expanded.delete(detail.dataset.detailId);
    }, true);
    this.element.addEventListener('paste', (event) => {
      const image = [...event.clipboardData?.items ?? []].find((item) => item.type.startsWith('image/'))?.getAsFile();
      if (image && event.target instanceof HTMLElement) {
        this.selectFromControl(event.target, false);
        event.preventDefault();
        void this.stageFile(image);
      }
    });
    this.element.addEventListener('dragover', (event) => event.preventDefault());
    this.element.addEventListener('drop', (event) => {
      event.preventDefault();
      const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-pane-id]') : null;
      const paneId = target?.dataset.paneId;
      const sessionId = event.dataTransfer?.getData('application/x-agent-fleet-session');
      const sourcePaneId = event.dataTransfer?.getData('application/x-agent-fleet-pane') || this.draggedPaneId;
      if (paneId && sessionId) { void this.assignSession(paneId, sessionId); return; }
      if (paneId && sourcePaneId && sourcePaneId !== paneId) {
        void this.applyCommand({ type: 'swap', firstPaneId: sourcePaneId, secondPaneId: paneId });
        return;
      }
      if (target) this.selectFromControl(target, false);
      for (const file of [...event.dataTransfer?.files ?? []].filter((item) => item.type.startsWith('image/')).slice(0, 8)) void this.stageFile(file);
    });
    this.element.addEventListener('dragstart', (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const sessionId = target?.closest<HTMLElement>('[data-rail-session-id]')?.dataset.railSessionId;
      const paneId = target?.closest<HTMLElement>('[data-pane-drag]')?.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId;
      if (sessionId) event.dataTransfer?.setData('application/x-agent-fleet-session', sessionId);
      else if (paneId) {
        this.draggedPaneId = paneId;
        event.dataTransfer?.setData('application/x-agent-fleet-pane', paneId);
      }
    });
    this.element.addEventListener('dragend', () => { this.draggedPaneId = ''; });
    this.element.addEventListener('pointerdown', (event) => this.beginPointerResize(event));
    void window.limitsWidget.listTerminalTabs().then((state) => {
      this.applyWorkspaceState(state);
    });
  }

  setSettings(settings: WidgetSettings): void {
    this.settings = settings;
    this.applyAppearance();
    for (const runtime of this.runtimes.values()) Object.assign(runtime.terminal.options, this.terminalOptions());
    this.patchRail();
  }

  setFleetSnapshot(snapshot: FleetSnapshot): void {
    this.fleetSnapshot = snapshot;
    const hiddenUnavailableSessionIds = reconcileHiddenUnavailableSessions(
      snapshot, this.workspaceState.rail.hiddenUnavailableSessionIds
    );
    if (hiddenUnavailableSessionIds.join('\n') !== this.workspaceState.rail.hiddenUnavailableSessionIds.join('\n')) {
      const rail = { ...this.workspaceState.rail, hiddenUnavailableSessionIds };
      this.workspaceState = { ...this.workspaceState, rail };
      void this.updateRail(rail);
    }
    for (const id of this.dismissedAttention) {
      if (!snapshot.attention.some((item) => item.id === id)) this.dismissedAttention.delete(id);
    }
    this.patchRail();
    for (const pane of workspacePanes(this.workspaceState.layout)) {
      this.patchPaneChip(pane);
      const tab = this.tabForPane(pane);
      if (tab) this.patchLimitCard(tab);
    }
    this.patchFocusedToolbar();
    for (const sessionId of this.modelStates.keys()) {
      if (!snapshot.sessions.some((session) => session.id === sessionId)) this.modelStates.delete(sessionId);
    }
    void this.pollVisibleModelStates();
  }

  private applyAppearance(): void {
    this.element.style.setProperty('--terminal-padding', `${this.settings.terminalAppearance.padding}px`);
  }

  mount(container: Element | null): void {
    if (!container) return;
    this.mounted = true;
    container.append(this.element);
    this.renderStructure();
    this.startModelPolling();
    if (!this.providerActivityTimer) {
      this.providerActivityTimer = window.setInterval(() => this.patchProviderActivityStatuses(), 1_000);
    }
  }

  detach(): void {
    this.mounted = false;
    this.element.remove();
    for (const timer of this.terminalHistoryTimers.values()) window.clearTimeout(timer);
    this.terminalHistoryTimers.clear();
    if (this.modelPollTimer) window.clearInterval(this.modelPollTimer);
    this.modelPollTimer = 0;
    if (this.providerActivityTimer) window.clearInterval(this.providerActivityTimer);
    this.providerActivityTimer = 0;
    for (const [tabId] of this.nativeStates) this.clearSuggestions(tabId, true);
    this.syncConversation();
    this.syncTerminal();
  }

  open(tab: TerminalTabDescriptor): void {
    this.upsertTab(tab);
  }

  async openSession(sessionId: string): Promise<void> {
    await this.assignSession(focusedPane(this.workspaceState.layout).id, sessionId);
  }

  confirmPlacement(placement: 'replace' | 'split-right' | 'split-down'): boolean {
    if (placement !== 'replace') return workspacePanes(this.workspaceState.layout).length < 4;
    const pane = focusedPane(this.workspaceState.layout);
    const tab = this.tabForPane(pane);
    return !tab || !this.hasUnsaved(tab.id)
      || window.confirm('Replace this pane and discard its unsent draft and staged attachments?');
  }

  async clearSession(sessionId: string): Promise<void> {
    const pane = paneForSession(this.workspaceState.layout, sessionId);
    if (pane) await this.applyCommand({ type: 'clear', paneId: pane.id });
  }

  isSessionHidden(sessionId: string): boolean {
    return this.workspaceState.rail.hiddenUnavailableSessionIds.includes(sessionId);
  }

  hideUnavailableSession(sessionId: string): boolean {
    const session = this.fleetSnapshot?.sessions.find((item) => item.id === sessionId);
    if (!session || !this.fleetSnapshot || isFleetSessionAvailable(this.fleetSnapshot, session)) return false;
    const hiddenUnavailableSessionIds = [
      sessionId,
      ...this.workspaceState.rail.hiddenUnavailableSessionIds.filter((item) => item !== sessionId)
    ].slice(0, 64);
    const rail = { ...this.workspaceState.rail, hiddenUnavailableSessionIds };
    this.workspaceState = { ...this.workspaceState, rail };
    this.patchRail();
    void this.updateRail(rail);
    return true;
  }

  handleAction(action: string, target: HTMLElement): boolean {
    const control = target.closest<HTMLElement>('[data-workspace-action]') ?? target;
    this.selectFromControl(control, action !== 'workspace-pane-close');
    if (action === 'workspace-rail-session') {
      const sessionId = control.closest<HTMLElement>('[data-rail-session-id]')?.dataset.railSessionId;
      const paneId = focusedPane(this.workspaceState.layout).id;
      const session = this.fleetSnapshot?.sessions.find((item) => item.id === sessionId);
      if (sessionId && session && this.fleetSnapshot && isFleetSessionAvailable(this.fleetSnapshot, session)) {
        void this.assignSession(paneId, sessionId);
      }
      return true;
    }
    if (action === 'workspace-rail-more') {
      const sessionId = control.closest<HTMLElement>('[data-rail-session-id]')?.dataset.railSessionId;
      if (sessionId) this.openSessionMenu(sessionId);
      return true;
    }
    if (action === 'workspace-rail-collapse') {
      void this.updateRail({ ...this.workspaceState.rail, collapsed: !this.workspaceState.rail.collapsed });
      return true;
    }
    if (action === 'workspace-rail-filter') {
      const status = control.dataset.status;
      if (status && ['all', 'active', 'waiting', 'favorites'].includes(status)) {
        void this.updateRail({ ...this.workspaceState.rail, status: status as WorkspaceRailState['status'] });
      }
      return true;
    }
    if (action === 'workspace-filter-host') {
      const id = control.dataset.hostId;
      if (id) {
        const hostIds = this.workspaceState.rail.hostIds.includes(id)
          ? this.workspaceState.rail.hostIds.filter((item) => item !== id) : [...this.workspaceState.rail.hostIds, id];
        void this.updateRail({ ...this.workspaceState.rail, hostIds });
      }
      return true;
    }
    if (action === 'workspace-filter-tool') {
      const tool = control.dataset.tool as WorkspaceRailState['tools'][number] | undefined;
      if (tool && ['codex', 'claude', 'copilot', 'shell'].includes(tool)) {
        const tools = this.workspaceState.rail.tools.includes(tool)
          ? this.workspaceState.rail.tools.filter((item) => item !== tool) : [...this.workspaceState.rail.tools, tool];
        void this.updateRail({ ...this.workspaceState.rail, tools });
      }
      return true;
    }
    if (action === 'workspace-filter-idle') {
      void this.updateRail({ ...this.workspaceState.rail, showIdle: !this.workspaceState.rail.showIdle });
      return true;
    }
    if (action === 'workspace-pane-focus') {
      const paneId = control.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId;
      if (paneId) void this.focusPane(paneId, true);
      return true;
    }
    if (action === 'workspace-split-right' || action === 'workspace-split-down') {
      void this.splitFocused(action === 'workspace-split-right' ? 'row' : 'column');
      return true;
    }
    if (action === 'workspace-preset') {
      const preset = control.dataset.preset;
      if (preset && ['single', 'two-columns', 'two-rows', 'grid'].includes(preset)) void this.applyPreset(preset as WorkspacePreset);
      return true;
    }
    if (action === 'workspace-pane-close' || action === 'workspace-close') {
      const paneId = control.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId ?? focusedPane(this.workspaceState.layout).id;
      void this.closePane(paneId);
      return true;
    }
    if (action === 'workspace-kill') {
      const tab = this.focusedTab();
      if (tab) void this.killTab(tab);
      return true;
    }
    if (action === 'workspace-download') {
      const tab = this.focusedTab();
      if (tab) this.openRepository(tab.sessionId);
      return true;
    }
    if (action === 'workspace-retry') {
      const tab = this.focusedTab();
      if (tab) void window.limitsWidget.retryTerminalTab(tab.id);
      return true;
    }
    if (action === 'workspace-open-vscode' || action === 'workspace-open-windows') {
      const tab = this.focusedTab();
      if (tab) void window.limitsWidget.openFleetSessionExternal(
        tab.sessionId,
        action === 'workspace-open-vscode' ? 'vscode' : 'windowsTerminal'
      );
      return true;
    }
    if (action === 'workspace-view') {
      const mode = control.dataset.mode === 'terminal' ? 'terminal' : 'native';
      const pane = focusedPane(this.workspaceState.layout);
      const tab = this.tabForPane(pane);
      if (tab && pane) void this.applyCommand({ type: 'view', paneId: pane.id, viewMode: mode });
      return true;
    }
    if (action === 'workspace-search') {
      const query = window.prompt('Find in terminal');
      const tab = this.focusedTab();
      if (query && tab) this.runtimes.get(tab.id)?.search.findNext(query);
      return true;
    }
    if (action === 'workspace-model-open') {
      const sessionId = this.focusedTab()?.sessionId;
      if (sessionId) void this.openModelDialog(sessionId);
      return true;
    }
    if (action === 'model-control-close') {
      this.closeModelDialog();
      return true;
    }
    if (action === 'model-control-retry') {
      if (this.modelDialogSessionId) void this.openModelDialog(this.modelDialogSessionId);
      return true;
    }
    if (action === 'model-control-apply') {
      void this.applyModelDialog();
      return true;
    }
    if (action === 'model-control-cancel-pending') {
      void this.cancelPendingModelChange();
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
      if (item) { this.nativeState(this.selectedId).questionSheetId = item.id; this.renderSelectedNative(); }
      return true;
    }
    if (action === 'native-question-close') {
      this.nativeState(this.selectedId).questionSheetId = '';
      this.renderSelectedNative();
      return true;
    }
    if (action === 'native-question-back') {
      const item = this.itemFromControl(control);
      if (item) {
        const state = this.nativeState(this.selectedId);
        state.questionSteps.set(item.id, Math.max(0, (state.questionSteps.get(item.id) ?? 0) - 1));
        state.renderMode = 'preserve';
        this.maybeStartAutomaticSuggestion(this.selectedId);
        this.renderSelectedNative();
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
        this.renderSelectedNative();
      }
      return true;
    }
    if (action === 'native-viewer-close') {
      this.nativeState(this.selectedId).viewer = null;
      this.renderSelectedNative();
      return true;
    }
    if (action === 'native-viewer-wrap') {
      const viewer = this.nativeState(this.selectedId).viewer;
      if (viewer) { viewer.wrap = !viewer.wrap; this.renderSelectedNative(); }
      return true;
    }
    if (action === 'native-toggle-tasks') {
      const item = this.itemFromControl(control);
      if (item) {
        const key = `tasks-${item.id}`;
        const expanded = this.nativeState(this.selectedId).expandedDetails;
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        this.renderSelectedNative();
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
          else { state.notice = 'Choose a valid future time'; this.renderSelectedNative(); }
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
    if (action === 'native-suggest') { void this.requestSuggestions(control); return true; }
    if (action === 'native-suggestion-regenerate') {
      const suggestion = this.nativeState(this.selectedId).suggestion;
      if (suggestion.target) void this.requestSuggestionTarget(this.selectedId, suggestion.target, suggestion.automatic);
      return true;
    }
    if (action === 'native-suggestion-use') { this.useSuggestion(control); return true; }
    if (action === 'native-suggestion-cancel') { this.clearSuggestions(this.selectedId, true); this.renderSelectedNative(); return true; }
    if (action === 'native-shift-tab') { void window.limitsWidget.terminalInput(this.selectedId, '\u001b[Z'); return true; }
    if (action === 'native-control-c') { void window.limitsWidget.terminalInput(this.selectedId, '\u0003'); return true; }
    return false;
  }

  private remove(tabId: string): void {
    const previousStructure = this.currentStructureSignature();
    this.tabs.delete(tabId);
    this.workspaceState = { ...this.workspaceState, tabs: [...this.tabs.values()] };
    this.clearTerminalHistory(tabId);
    this.runtimes.get(tabId)?.terminal.dispose();
    this.runtimes.delete(tabId);
    this.nativeStates.delete(tabId);
    this.conversationStarted.delete(tabId);
    if (this.selectedId === tabId) this.selectedId = [...this.tabs.keys()].at(-1) ?? '';
    if (this.mounted && previousStructure !== this.currentStructureSignature()) this.renderStructure();
    this.syncConversation();
    this.syncTerminal();
  }

  private applyWorkspaceState(state: TerminalWorkspaceState): void {
    const previousStructure = this.currentStructureSignature();
    const nextIds = new Set(state.tabs.map((tab) => tab.id));
    for (const [id, runtime] of this.runtimes) {
      if (!nextIds.has(id)) { this.clearTerminalHistory(id); runtime.terminal.dispose(); this.runtimes.delete(id); }
    }
    for (const id of this.nativeStates.keys()) if (!nextIds.has(id)) this.nativeStates.delete(id);
    for (const id of this.terminalHistories.keys()) if (!nextIds.has(id)) this.clearTerminalHistory(id);
    this.tabs = new Map(state.tabs.map((tab) => [tab.id, tab]));
    this.workspaceState = state;
    const previousSelectedId = this.selectedId;
    const sessionId = focusedPane(state.layout).sessionId;
    this.selectedId = state.tabs.find((tab) => tab.sessionId === sessionId)?.id ?? '';
    if (previousSelectedId !== this.selectedId) {
      if (previousSelectedId) this.clearSuggestions(previousSelectedId, true);
      if (this.selectedId) this.baselineAutomaticSuggestion(this.selectedId);
    }
    if (!this.mounted) return;
    if (previousStructure !== workspaceStructureSignature(state)) this.renderStructure();
    else {
      this.patchFocusedPane();
      this.patchSplitRatios();
      this.patchRail();
      for (const tab of state.tabs) this.patchPaneChrome(tab);
      this.syncConversation();
      this.syncTerminal();
    }
  }

  private upsertTab(tab: TerminalTabDescriptor): void {
    const previousStructure = this.currentStructureSignature();
    this.tabs.set(tab.id, tab);
    this.workspaceState = { ...this.workspaceState, tabs: [...this.tabs.values()] };
    if (this.mounted && previousStructure !== this.currentStructureSignature()) this.renderStructure();
    else this.patchPaneChrome(tab);
  }

  private currentStructureSignature(): string {
    return workspaceStructureSignature({ ...this.workspaceState, tabs: [...this.tabs.values()] });
  }

  private renderStructure(): void {
    const previous = new Map<string, RenderSnapshot>();
    for (const pane of workspacePanes(this.workspaceState.layout)) {
      const tab = this.tabForPane(pane);
      const snapshot = tab ? this.captureRenderSnapshot(tab.id) : null;
      if (snapshot) previous.set(tab!.id, snapshot);
    }
    for (const runtime of this.runtimes.values()) runtime.element.remove();
    const rail = this.workspaceState.rail;
    this.element.classList.toggle('rail-collapsed', rail.collapsed);
    this.element.style.setProperty('--workspace-rail-width', `${rail.collapsed ? 64 : rail.width}px`);
    this.element.innerHTML = `
      <aside class="workspace-session-rail">
        <div class="workspace-rail-heading"><span><strong>Sessions</strong><small data-rail-count></small></span><button data-action="workspace-rail-collapse" data-workspace-action title="${rail.collapsed ? 'Expand sessions' : 'Collapse sessions'}">${rail.collapsed ? '»' : '«'}</button></div>
        <label class="workspace-rail-search"><span>⌕</span><input data-workspace-search placeholder="Search sessions" aria-label="Search sessions"></label>
        <div class="workspace-rail-chips">${(['all', 'active', 'waiting', 'favorites'] as const).map((status) => `<button data-action="workspace-rail-filter" data-workspace-action data-status="${status}" class="${rail.status === status ? 'active' : ''}">${status === 'all' ? 'All' : capitalize(status)}</button>`).join('')}</div>
        ${this.renderRailFilters()}
        <div class="workspace-rail-list" data-workspace-rail-list></div>
        <div class="workspace-rail-resizer" data-rail-resizer aria-label="Resize session rail"></div>
      </aside>
      <section class="workspace-pane-area">
        <div class="workspace-layout-toolbar">
          <div class="workspace-focused-toolbar" data-workspace-focused-toolbar>${this.renderFocusedToolbar()}</div>
          <button data-action="workspace-split-right" data-workspace-action ${workspacePanes(this.workspaceState.layout).length >= 4 ? 'disabled' : ''}>Split right</button>
          <button data-action="workspace-split-down" data-workspace-action ${workspacePanes(this.workspaceState.layout).length >= 4 ? 'disabled' : ''}>Split down</button>
          <details class="workspace-preset-menu"><summary>Layout</summary><div>${this.renderPresetButtons()}</div></details>
          <button class="primary-button" data-action="workspace-new-session">+ New session</button>
        </div>
        <div class="workspace-pane-tree">${this.renderWorkspaceNode(this.workspaceState.layout.root)}</div>
      </section>
      <div data-model-control-host>${this.renderModelDialog()}</div>`;
    this.patchRail('');
    for (const pane of workspacePanes(this.workspaceState.layout)) {
      const tab = this.tabForPane(pane);
      if (tab && pane.viewMode === 'terminal') this.mountTerminal(pane, tab);
    }
    this.syncConversation();
    this.syncTerminal();
    queueMicrotask(() => {
      for (const [tabId, snapshot] of previous) if (this.tabs.has(tabId)) this.restoreRenderSnapshot(tabId, snapshot);
      this.fitVisible();
    });
  }

  private renderWorkspaceNode(node: WorkspaceNode): string {
    if (node.kind === 'pane') return this.renderWorkspacePane(node);
    const template = node.direction === 'row'
      ? `grid-template-columns:${node.ratio}fr 7px ${1 - node.ratio}fr`
      : `grid-template-rows:${node.ratio}fr 7px ${1 - node.ratio}fr`;
    return `<div class="workspace-split split-${node.direction}" data-split-id="${escapeAttr(node.id)}" data-split-direction="${node.direction}" style="${template}">
      ${this.renderWorkspaceNode(node.first)}
      <div class="workspace-divider" role="separator" tabindex="0" data-split-divider data-split-id="${escapeAttr(node.id)}" data-direction="${node.direction}" aria-label="Resize panes"></div>
      ${this.renderWorkspaceNode(node.second)}
    </div>`;
  }

  private renderWorkspacePane(pane: WorkspacePane): string {
    const panes = workspacePanes(this.workspaceState.layout);
    const number = panes.findIndex((item) => item.id === pane.id) + 1;
    const tab = this.tabForPane(pane);
    const session = pane.sessionId ? this.fleetSnapshot?.sessions.find((item) => item.id === pane.sessionId) : undefined;
    const unavailable = Boolean(session && this.fleetSnapshot && !isFleetSessionAvailable(this.fleetSnapshot, session));
    const focused = pane.id === this.workspaceState.layout.focusedPaneId;
    const renderState = workspacePaneRenderState(pane, [...this.tabs.values()]);
    if (renderState === 'opening') return `<section class="workspace-pane opening ${focused ? 'focused' : ''}" data-pane-id="${escapeAttr(pane.id)}" data-pane-number="${number}" tabindex="-1">
      ${this.renderPaneChip(pane, number, session ? sessionIdentityPresentation(session).primary : undefined, unavailable)}
      <div class="workspace-opening-session" role="status"><span>&gt;_</span><strong>Opening session…</strong><small>Preparing the ${pane.viewMode === 'native' ? 'Native conversation' : 'Terminal'} view.</small></div>
    </section>`;
    if (!tab) return `<section class="workspace-pane empty ${focused ? 'focused' : ''}" data-pane-id="${escapeAttr(pane.id)}" data-pane-number="${number}" tabindex="-1">
      ${this.renderPaneChip(pane, number)}
      <button class="workspace-choose-session" data-action="workspace-pane-focus" data-workspace-action><span>&gt;_</span><strong>Choose a session</strong><small>Click a session on the left or drag it here.</small></button>
    </section>`;
    return `<section class="workspace-pane ${focused ? 'focused' : ''}" data-pane-id="${escapeAttr(pane.id)}" data-pane-number="${number}" data-tab-id="${escapeAttr(tab.id)}" tabindex="-1">
      ${this.renderPaneChip(pane, number, session?.name, unavailable)}
      <div class="workspace-pane-stage">
        <div class="native-session-panel ${pane.viewMode === 'native' ? '' : 'hidden'}" data-native-host="${escapeAttr(tab.id)}">${pane.viewMode === 'native' ? this.renderNative(tab) : ''}</div>
        <div class="terminal-session-panel ${pane.viewMode === 'terminal' ? '' : 'hidden'}" data-terminal-host="${escapeAttr(pane.id)}"></div>
      </div>
    </section>`;
  }

  private panePresentation(pane: WorkspacePane, sessionName?: string, unavailable?: boolean) {
    const session = pane.sessionId && (sessionName === undefined || unavailable === undefined)
      ? this.fleetSnapshot?.sessions.find((item) => item.id === pane.sessionId)
      : undefined;
    return workspacePanePresentation(pane, [...this.tabs.values()], {
      sessionName: sessionName ?? (session ? sessionIdentityPresentation(session).primary : undefined),
      unavailable: unavailable ?? Boolean(session && this.fleetSnapshot
        && !isFleetSessionAvailable(this.fleetSnapshot, session))
    });
  }

  private renderPaneChip(
    pane: WorkspacePane,
    number: number,
    sessionName?: string,
    unavailable?: boolean
  ): string {
    const presentation = this.panePresentation(pane, sessionName, unavailable);
    const mode = pane.viewMode === 'native' ? 'Native' : 'Terminal';
    const description = `Pane ${number} · ${presentation.title} · ${mode} · ${presentation.context}`;
    return `<button class="workspace-pane-chip" data-pane-chip data-pane-drag data-action="workspace-pane-focus" data-workspace-action draggable="true" title="${escapeAttr(description)}" aria-label="${escapeAttr(description)}">
      <b>${number}</b><i class="terminal-status status-${presentation.status}" data-pane-status></i><strong data-pane-label>${escapeHtml(presentation.title)}</strong><span data-pane-mode>${presentation.modeBadge}</span>
    </button>`;
  }

  private renderFocusedToolbar(): string {
    const panes = workspacePanes(this.workspaceState.layout);
    const pane = focusedPane(this.workspaceState.layout);
    const number = panes.findIndex((item) => item.id === pane.id) + 1;
    const session = pane.sessionId
      ? this.fleetSnapshot?.sessions.find((item) => item.id === pane.sessionId)
      : undefined;
    const unavailable = Boolean(session && this.fleetSnapshot
      && !isFleetSessionAvailable(this.fleetSnapshot, session));
    const presentation = this.panePresentation(pane, session?.name, unavailable);
    const modelState = session ? this.modelStates.get(session.id) : undefined;
    const modelSelection = modelState?.pending
      ? { modelLabel: modelState.pending.modelId, effortLabel: modelState.pending.effortId }
      : modelState?.effective ?? modelState?.selected;
    const modelLabel = modelSelection
      ? `${modelSelection.modelLabel} · ${modelSelection.effortLabel}${modelState?.pending ? ' · queued' : ''}`
      : 'Model · Effort';
    const modelControl = session && ['codex', 'claude', 'copilot'].includes(session.tool)
      ? `<button class="workspace-model-control status-${escapeAttr(modelState?.status ?? 'unknown')}" data-action="workspace-model-open" data-workspace-action ${unavailable ? 'disabled' : ''} title="Change model and reasoning effort for this session"><span>${escapeHtml(modelLabel)}</span></button>`
      : '';
    const more = presentation.hasSessionActions
      ? `<button data-action="workspace-search" data-workspace-action>Find terminal</button><button data-action="workspace-download" data-workspace-action ${unavailable ? 'disabled' : ''}>Download a file…</button><button data-action="workspace-open-vscode" data-workspace-action ${unavailable ? 'disabled' : ''}>Open in VS Code</button><button data-action="workspace-open-windows" data-workspace-action ${unavailable ? 'disabled' : ''}>Open in Windows Terminal</button><button data-action="workspace-pane-close" data-workspace-action>Detach from pane</button><button class="danger-quiet" data-action="workspace-kill" data-workspace-action ${unavailable ? 'disabled' : ''}>Kill session…</button>`
      : '<button data-action="workspace-pane-close" data-workspace-action>Close pane</button>';
    return `<div class="workspace-focused-identity" title="${escapeAttr(presentation.context)}">
        <b>${number}</b><i class="terminal-status status-${presentation.status}" data-workspace-toolbar-status></i><span><strong data-workspace-toolbar-title>${escapeHtml(presentation.title)}</strong><small data-workspace-toolbar-context>${escapeHtml(presentation.context)}</small></span>
      </div>
      ${modelControl}
      <div class="workspace-pane-modes" data-workspace-mode-controls><button data-action="workspace-view" data-workspace-action data-mode="native" class="${pane.viewMode === 'native' ? 'active' : ''}" ${presentation.nativeEnabled ? '' : 'disabled'}>Native</button><button data-action="workspace-view" data-workspace-action data-mode="terminal" class="${pane.viewMode === 'terminal' ? 'active' : ''}" ${presentation.terminalEnabled ? '' : 'disabled'}>Terminal</button></div>
      <button class="primary-button workspace-toolbar-retry ${presentation.retryVisible ? '' : 'invisible'}" data-action="workspace-retry" data-workspace-action ${presentation.retryVisible ? '' : 'disabled'}>Retry</button>
      <details class="workspace-actions-menu workspace-toolbar-more"><summary aria-label="More actions for ${escapeAttr(presentation.title)}">•••</summary><div>${more}</div></details>`;
  }

  private mountTerminal(pane: WorkspacePane, tab: TerminalTabDescriptor): void {
    const host = this.element.querySelector<HTMLElement>(`[data-terminal-host="${CSS.escape(pane.id)}"]`);
    if (!host || pane.viewMode !== 'terminal') return;
    if (tab.failure) {
      host.insertAdjacentHTML('beforeend', `<section class="terminal-unavailable"><strong>Terminal unavailable</strong><p>${escapeHtml(tab.failure.message)}</p><small>Use Retry or More in the focused-pane toolbar.</small></section>`);
      return;
    }
    let runtime = this.runtimes.get(tab.id);
    if (!runtime) {
      const terminal = new Terminal(this.terminalOptions());
      const fit = new FitAddon();
      const search = new SearchAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(search);
      terminal.onData((data) => {
        if (this.terminalHistoryState(tab.id).active) this.closeTerminalHistory(tab.id);
        this.noteTerminalHistoryActivity(tab.id, true);
        void window.limitsWidget.terminalInput(tab.id, data);
      });
      const element = document.createElement('div');
      element.className = 'xterm-runtime';
      terminal.open(element);
      element.addEventListener('wheel', (event) => {
        const state = this.terminalHistoryState(tab.id);
        if (event.deltaY >= 0 || !shouldCaptureTerminalHistoryScroll(tab, terminal.buffer.active.type, state)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.openTerminalHistory(tab.id, event.deltaY);
      }, { capture: true, passive: false });
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type === 'keydown' && event.shiftKey && event.key === 'PageUp'
            && shouldCaptureTerminalHistoryScroll(tab, terminal.buffer.active.type, this.terminalHistoryState(tab.id))) {
          this.openTerminalHistory(tab.id, -Math.max(240, element.clientHeight * .8));
          return false;
        }
        return true;
      });
      runtime = { terminal, fit, search, element };
      this.runtimes.set(tab.id, runtime);
    }
    host.append(runtime.element);
    this.scheduleTerminalHistory(tab.id);
    queueMicrotask(() => this.fitRuntime(runtime!));
  }

  private renderPresetButtons(): string {
    return `<button data-action="workspace-preset" data-workspace-action data-preset="single">Single</button><button data-action="workspace-preset" data-workspace-action data-preset="two-columns">Two columns</button><button data-action="workspace-preset" data-workspace-action data-preset="two-rows">Two rows</button><button data-action="workspace-preset" data-workspace-action data-preset="grid">2 × 2</button>`;
  }

  private renderRailFilters(): string {
    const rail = this.workspaceState.rail;
    const hosts = this.fleetSnapshot?.hosts ?? [];
    const tools = ['codex', 'claude', 'copilot', 'shell'] as const;
    return `<details class="workspace-rail-filters"><summary>Filters</summary><div><strong>Hosts</strong>${hosts.map((host) => `<button data-action="workspace-filter-host" data-workspace-action data-host-id="${escapeAttr(host.id)}" class="${rail.hostIds.includes(host.id) ? 'active' : ''}">${escapeHtml(host.name)}</button>`).join('') || '<small>No hosts</small>'}<strong>Tools</strong>${tools.map((tool) => `<button data-action="workspace-filter-tool" data-workspace-action data-tool="${tool}" class="${rail.tools.includes(tool) ? 'active' : ''}">${capitalize(tool)}</button>`).join('')}<button data-action="workspace-filter-idle" data-workspace-action class="${rail.showIdle ? 'active' : ''}">${rail.showIdle ? 'Idle shown' : 'Idle hidden'}</button></div></details>`;
  }

  private patchRail(searchValue?: string): void {
    const host = this.element.querySelector<HTMLElement>('[data-workspace-rail-list]');
    if (!host) return;
    const rail = this.workspaceState.rail;
    const previousWidth = this.element.style.getPropertyValue('--workspace-rail-width');
    const nextWidth = `${rail.collapsed ? 64 : rail.width}px`;
    this.element.classList.toggle('rail-collapsed', rail.collapsed);
    this.element.style.setProperty('--workspace-rail-width', nextWidth);
    if (previousWidth && previousWidth !== nextWidth) queueMicrotask(() => this.fitVisible());
    for (const button of this.element.querySelectorAll<HTMLElement>('[data-action="workspace-rail-filter"]')) {
      button.classList.toggle('active', button.dataset.status === rail.status);
    }
    for (const button of this.element.querySelectorAll<HTMLElement>('[data-action="workspace-filter-host"]')) {
      button.classList.toggle('active', Boolean(button.dataset.hostId && rail.hostIds.includes(button.dataset.hostId)));
    }
    for (const button of this.element.querySelectorAll<HTMLElement>('[data-action="workspace-filter-tool"]')) {
      button.classList.toggle('active', Boolean(button.dataset.tool && rail.tools.includes(button.dataset.tool as WorkspaceRailState['tools'][number])));
    }
    this.element.querySelector<HTMLElement>('[data-action="workspace-filter-idle"]')?.classList.toggle('active', rail.showIdle);
    const collapse = this.element.querySelector<HTMLButtonElement>('[data-action="workspace-rail-collapse"]');
    if (collapse) { collapse.textContent = rail.collapsed ? '»' : '«'; collapse.title = rail.collapsed ? 'Expand sessions' : 'Collapse sessions'; }
    const input = this.element.querySelector<HTMLInputElement>('[data-workspace-search]');
    const query = searchValue ?? input?.value ?? '';
    const sessions = this.filteredRailSessions(query);
    host.innerHTML = sessions.length ? sessions.map((session) => this.renderRailSession(session)).join('')
      : '<div class="workspace-rail-empty">No matching sessions</div>';
    const count = this.element.querySelector<HTMLElement>('[data-rail-count]');
    if (count) count.textContent = `${sessions.length} available`;
  }

  private filteredRailSessions(query: string): FleetSession[] {
    const rail = this.workspaceState.rail;
    const assigned = new Set(workspacePanes(this.workspaceState.layout).map((pane) => pane.sessionId));
    const needle = query.trim().toLowerCase();
    const mruIndex = (id: string): number => {
      const index = this.workspaceState.layout.sessionMru.indexOf(id);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    return [...(this.fleetSnapshot?.sessions ?? [])]
      .filter((session) => !rail.hiddenUnavailableSessionIds.includes(session.id))
      .filter((session) => session.activity !== 'exited' || assigned.has(session.id))
      .filter((session) => rail.status === 'all' || rail.status === 'favorites' && session.favorite
        || rail.status === 'active' && session.activity === 'active' || rail.status === 'waiting' && session.activity === 'waiting')
      .filter((session) => rail.showIdle || session.activity !== 'idle')
      .filter((session) => !rail.hostIds.length || rail.hostIds.includes(session.hostId))
      .filter((session) => !rail.tools.length || rail.tools.includes(session.tool))
      .filter((session) => !needle || [session.name, session.title, session.project, session.hostId, session.tool].some((value) => value.toLowerCase().includes(needle)))
      .sort((left, right) => Number(right.favorite) - Number(left.favorite)
        || mruIndex(left.id) - mruIndex(right.id)
        || (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0));
  }

  private renderRailSession(session: FleetSession): string {
    const pane = paneForSession(this.workspaceState.layout, session.id);
    const paneNumber = pane ? workspacePanes(this.workspaceState.layout).findIndex((item) => item.id === pane.id) + 1 : 0;
    const attention = this.fleetSnapshot?.attention.filter((item) => item.targetSessionId === session.id).length ?? 0;
    const unavailable = Boolean(this.fleetSnapshot && !isFleetSessionAvailable(this.fleetSnapshot, session));
    const identity = sessionIdentityPresentation(session);
    return `<div class="workspace-rail-session ${pane ? 'visible' : ''} ${unavailable ? 'unavailable' : ''}" data-rail-session-id="${escapeAttr(session.id)}" draggable="${unavailable ? 'false' : 'true'}">
      <button data-action="workspace-rail-session" data-workspace-action title="${unavailable ? 'Host unavailable' : `Open ${escapeAttr(identity.primary)}`}" ${unavailable ? 'disabled' : ''}><span class="rail-tool rail-tool-${session.tool}">${session.tool.slice(0, 1).toUpperCase()}</span><span><strong>${escapeHtml(identity.primary)}</strong><small>${escapeHtml(unavailable ? `Unavailable · ${session.hostId}` : identity.secondary)}</small></span>${paneNumber ? `<b class="rail-pane-number">${paneNumber}</b>` : ''}${attention && !unavailable ? `<b class="rail-attention">${attention}</b>` : ''}<i class="${unavailable ? 'activity-unavailable' : `activity-${session.activity}`}"></i></button>
      <button class="rail-more" data-action="workspace-rail-more" data-workspace-action title="More actions">•••</button>
    </div>`;
  }

  private tabForPane(pane: WorkspacePane): TerminalTabDescriptor | undefined {
    return pane.sessionId ? [...this.tabs.values()].find((tab) => tab.sessionId === pane.sessionId) : undefined;
  }

  private focusedTab(): TerminalTabDescriptor | undefined {
    return this.tabForPane(focusedPane(this.workspaceState.layout));
  }

  private tabIdFromControl(control: HTMLElement): string {
    const tabId = control.closest<HTMLElement>('[data-tab-id]')?.dataset.tabId;
    return tabId && this.tabs.has(tabId) ? tabId : '';
  }

  private selectFromControl(control: HTMLElement, persistFocus: boolean): void {
    const paneId = control.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId;
    if (!paneId) return;
    const pane = workspacePanes(this.workspaceState.layout).find((item) => item.id === paneId);
    const tab = pane ? this.tabForPane(pane) : undefined;
    const previousSelectedId = this.selectedId;
    this.selectedId = tab?.id ?? '';
    if (previousSelectedId !== this.selectedId) {
      if (previousSelectedId) this.clearSuggestions(previousSelectedId, true);
      if (this.selectedId) this.baselineAutomaticSuggestion(this.selectedId);
    }
    if (paneId !== this.workspaceState.layout.focusedPaneId) void this.focusPane(paneId, persistFocus);
  }

  private async focusPane(paneId: string, focusContent: boolean): Promise<void> {
    const pane = workspacePanes(this.workspaceState.layout).find((item) => item.id === paneId);
    if (!pane) return;
    this.workspaceState = {
      ...this.workspaceState,
      layout: { ...this.workspaceState.layout, focusedPaneId: paneId }
    };
    const previousSelectedId = this.selectedId;
    const tab = this.tabForPane(pane);
    this.selectedId = tab?.id ?? '';
    if (previousSelectedId !== this.selectedId) {
      if (previousSelectedId) this.clearSuggestions(previousSelectedId, true);
      if (this.selectedId) this.baselineAutomaticSuggestion(this.selectedId);
    }
    this.patchFocusedPane();
    void this.pollVisibleModelStates();
    if (focusContent) queueMicrotask(() => {
      if (pane.viewMode === 'terminal' && tab) this.runtimes.get(tab.id)?.terminal.focus();
      else this.element.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(pane.id)}"] textarea, [data-pane-id="${CSS.escape(pane.id)}"] button`)?.focus();
    });
    await this.applyCommand({ type: 'focus', paneId });
  }

  private patchFocusedPane(): void {
    for (const element of this.element.querySelectorAll<HTMLElement>('[data-pane-id]')) {
      element.classList.toggle('focused', element.dataset.paneId === this.workspaceState.layout.focusedPaneId);
    }
    this.patchFocusedToolbar();
    this.patchRail();
  }

  private patchSplitRatios(): void {
    let resized = false;
    const update = (node: WorkspaceNode): void => {
      if (node.kind === 'pane') return;
      const element = this.element.querySelector<HTMLElement>(`[data-split-id="${CSS.escape(node.id)}"]`);
      if (element) {
        if (node.direction === 'row') {
          const template = `${node.ratio}fr 7px ${1 - node.ratio}fr`;
          if (element.style.gridTemplateColumns !== template) { element.style.gridTemplateColumns = template; resized = true; }
        } else {
          const template = `${node.ratio}fr 7px ${1 - node.ratio}fr`;
          if (element.style.gridTemplateRows !== template) { element.style.gridTemplateRows = template; resized = true; }
        }
      }
      update(node.first); update(node.second);
    };
    update(this.workspaceState.layout.root);
    if (resized) queueMicrotask(() => this.fitVisible());
  }

  private async applyCommand(command: WorkspaceCommand): Promise<void> {
    const state = await window.limitsWidget.applyWorkspaceCommand(command);
    this.applyWorkspaceState(state);
  }

  private async assignSession(paneId: string, sessionId: string): Promise<void> {
    const visible = paneForSession(this.workspaceState.layout, sessionId);
    if (visible) { await this.focusPane(visible.id, true); return; }
    const target = workspacePanes(this.workspaceState.layout).find((pane) => pane.id === paneId);
    const tab = target ? this.tabForPane(target) : undefined;
    if (tab && this.hasUnsaved(tab.id) && !window.confirm('Replace this pane and discard its unsent draft and staged attachments?')) return;
    await this.applyCommand({ type: 'assign', paneId, sessionId });
  }

  private async closePane(paneId: string): Promise<void> {
    const pane = workspacePanes(this.workspaceState.layout).find((item) => item.id === paneId);
    const tab = pane ? this.tabForPane(pane) : undefined;
    if (tab && this.hasUnsaved(tab.id) && !window.confirm('Detach this pane and discard its unsent draft and staged attachments?')) return;
    await this.applyCommand({ type: 'close', paneId });
  }

  private async splitFocused(direction: 'row' | 'column'): Promise<void> {
    if (workspacePanes(this.workspaceState.layout).length >= 4) return;
    await this.applyCommand({ type: 'split', paneId: this.workspaceState.layout.focusedPaneId, direction });
  }

  private async applyPreset(preset: WorkspacePreset): Promise<void> {
    const preview = applyWorkspacePreset(this.workspaceState.layout, preset);
    const retained = new Set(workspacePanes(preview).map((pane) => pane.sessionId));
    const discarded = workspacePanes(this.workspaceState.layout).filter((pane) => pane.sessionId && !retained.has(pane.sessionId));
    if (discarded.some((pane) => {
      const tab = this.tabForPane(pane);
      return tab && this.hasUnsaved(tab.id);
    }) && !window.confirm('Change layout and discard unsent drafts or staged attachments in removed panes?')) return;
    await this.applyCommand({ type: 'preset', preset });
  }

  private async updateRail(rail: WorkspaceRailState): Promise<void> {
    await this.applyCommand({ type: 'rail', rail });
  }

  private hasUnsaved(tabId: string): boolean {
    const state = this.nativeStates.get(tabId);
    return Boolean(state?.draft.trim() || state?.attachments.length);
  }

  private patchPaneChrome(tab: TerminalTabDescriptor): void {
    const pane = paneForSession(this.workspaceState.layout, tab.sessionId);
    if (!pane) return;
    const root = this.element.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(pane.id)}"]`);
    if (!root) return;
    this.patchPaneChip(pane);
    root.classList.toggle('session-ended', tab.status === 'ended');
    if (pane.id === this.workspaceState.layout.focusedPaneId) this.patchFocusedToolbar();
  }

  private patchPaneChip(pane: WorkspacePane): void {
    const root = this.element.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(pane.id)}"]`);
    const chip = root?.querySelector<HTMLButtonElement>('[data-pane-chip]');
    if (!root || !chip) return;
    const presentation = this.panePresentation(pane);
    const number = Number.parseInt(root.dataset.paneNumber ?? '0', 10);
    const mode = pane.viewMode === 'native' ? 'Native' : 'Terminal';
    const description = `Pane ${number} · ${presentation.title} · ${mode} · ${presentation.context}`;
    chip.title = description;
    chip.setAttribute('aria-label', description);
    const status = chip.querySelector<HTMLElement>('[data-pane-status]');
    if (status) status.className = `terminal-status status-${presentation.status}`;
    const label = chip.querySelector<HTMLElement>('[data-pane-label]');
    if (label) label.textContent = presentation.title;
    const modeBadge = chip.querySelector<HTMLElement>('[data-pane-mode]');
    if (modeBadge) modeBadge.textContent = presentation.modeBadge;
  }

  private startModelPolling(): void {
    if (this.modelPollTimer) return;
    void this.pollVisibleModelStates();
    this.modelPollTimer = window.setInterval(() => {
      if (this.mounted && !document.hidden) void this.pollVisibleModelStates();
    }, 10_000);
  }

  private async pollVisibleModelStates(): Promise<void> {
    if (this.modelPollActive || !this.mounted || document.hidden || !this.fleetSnapshot) return;
    this.modelPollActive = true;
    try {
      const sessionIds = [...new Set(workspacePanes(this.workspaceState.layout).map((pane) => pane.sessionId).filter(Boolean))];
      for (const sessionId of sessionIds) {
        const session = this.fleetSnapshot.sessions.find((item) => item.id === sessionId);
        if (!session || !['codex', 'claude', 'copilot'].includes(session.tool)
          || !isFleetSessionAvailable(this.fleetSnapshot, session)) continue;
        const result = await window.limitsWidget.getFleetSessionModel(session.id, false);
        if (!result.ok || !result.state) continue;
        const previous = this.modelStates.get(session.id);
        this.modelStates.set(session.id, { ...result.state, catalog: result.state.catalog ?? previous?.catalog ?? null });
      }
      this.patchFocusedToolbar();
      if (this.modelDialogSessionId) this.patchModelDialog();
    } finally {
      this.modelPollActive = false;
    }
  }

  private modelDialogState(): FleetModelControlState | undefined {
    return this.modelStates.get(this.modelDialogSessionId);
  }

  private async openModelDialog(sessionId: string): Promise<void> {
    this.modelDialogSessionId = sessionId;
    this.modelDialogLoading = true;
    this.modelDialogError = '';
    this.patchModelDialog();
    const result = await window.limitsWidget.getFleetSessionModel(sessionId, true);
    if (this.modelDialogSessionId !== sessionId) return;
    this.modelDialogLoading = false;
    if (!result.ok || !result.state?.catalog) {
      this.modelDialogError = result.message || 'Model options could not be loaded';
      this.patchModelDialog();
      return;
    }
    this.modelStates.set(sessionId, result.state);
    const requested = result.state.pending ?? result.state.selected;
    const catalogModel = result.state.catalog.models.find((item) => item.id === requested.modelId);
    this.modelDialogCustom = !catalogModel;
    this.modelDialogModelId = requested.modelId;
    this.modelDialogEffortId = requested.effortId;
    if (catalogModel && !catalogModel.efforts.some((item) => item.id === this.modelDialogEffortId)) {
      this.modelDialogEffortId = catalogModel.defaultEffort;
    }
    this.patchFocusedToolbar();
    this.patchModelDialog();
  }

  private closeModelDialog(): void {
    this.modelDialogSessionId = '';
    this.modelDialogLoading = false;
    this.modelDialogError = '';
    this.patchModelDialog();
  }

  private renderModelDialog(): string {
    if (!this.modelDialogSessionId) return '';
    const session = this.fleetSnapshot?.sessions.find((item) => item.id === this.modelDialogSessionId);
    const state = this.modelDialogState();
    if (this.modelDialogLoading) return `<div class="model-control-backdrop"><section class="model-control-dialog" role="dialog" aria-modal="true" aria-label="Loading model controls"><div class="model-control-loading">Loading model options…</div></section></div>`;
    if (this.modelDialogError || !state?.catalog || !session) return `<div class="model-control-backdrop"><section class="model-control-dialog" role="dialog" aria-modal="true">
      <header><div><small>Session model</small><h2>Could not load model options</h2></div><button data-action="model-control-close" data-workspace-action aria-label="Close">×</button></header>
      <div class="model-control-error">${escapeHtml(this.modelDialogError || 'The session is no longer available')}</div>
      <footer><button data-action="model-control-close" data-workspace-action>Close</button><button class="primary-button" data-action="model-control-retry" data-workspace-action>Retry</button></footer>
    </section></div>`;
    const catalog = state.catalog;
    const selectedModel = catalog.models.find((item) => item.id === this.modelDialogModelId);
    const efforts = selectedModel?.efforts ?? this.customEffortOptions(catalog.models);
    const configurableEffort = efforts.some((item) => item.id !== 'automatic');
    const effortAvailable = efforts.some((item) => item.id === this.modelDialogEffortId);
    const effective = state.effective ?? state.selected;
    const hasHistory = this.sessionHasCompletedAssistantReply(session.id);
    const pending = state.pending;
    const validModel = /^[A-Za-z0-9][A-Za-z0-9._:/@+\\-]{0,159}$/u.test(this.modelDialogModelId);
    return `<div class="model-control-backdrop"><section class="model-control-dialog" role="dialog" aria-modal="true" aria-labelledby="model-control-title">
      <header><div><small>${escapeHtml(session.tool)} · current session only</small><h2 id="model-control-title">${escapeHtml(sessionIdentityPresentation(session).primary)}</h2><p>Effective: ${escapeHtml(effective.modelLabel)} · ${escapeHtml(effective.effortLabel)}</p></div><button data-action="model-control-close" data-workspace-action aria-label="Close">×</button></header>
      ${pending ? `<div class="model-control-pending"><span><strong>Queued for idle</strong><small>${escapeHtml(pending.modelId)} · ${escapeHtml(pending.effortId)} · expires ${escapeHtml(new Date(pending.expiresAt).toLocaleTimeString())}</small></span><button data-action="model-control-cancel-pending" data-workspace-action>Cancel queued change</button></div>` : ''}
      <label class="model-control-field"><span>Model</span><select data-model-picker ${this.modelDialogCustom ? 'disabled' : ''}>${catalog.models.map((item) => `<option value="${escapeAttr(item.id)}" ${item.id === this.modelDialogModelId ? 'selected' : ''}>${escapeHtml(item.label)}${item.isDefault ? ' (Default)' : ''}</option>`).join('')}</select><small>${escapeHtml(selectedModel?.description ?? 'Enter a provider model ID exposed to your account.')}</small></label>
      ${catalog.customAllowed ? `<label class="model-control-custom"><input type="checkbox" data-model-custom-toggle ${this.modelDialogCustom ? 'checked' : ''}><span>Other model ID</span></label>${this.modelDialogCustom ? `<label class="model-control-field"><span>Provider model ID</span><input data-model-custom-id value="${escapeAttr(this.modelDialogModelId)}" maxlength="160" autocomplete="off" spellcheck="false"><small>Letters, numbers, dots, slashes, colons, @, +, underscores, and dashes only.</small></label>` : ''}` : ''}
      <label class="model-control-field"><span>Reasoning effort</span><select data-effort-picker ${configurableEffort ? '' : 'disabled'}>${efforts.length ? efforts.map((item) => `<option value="${escapeAttr(item.id)}" ${item.id === this.modelDialogEffortId ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('') : '<option value="automatic">Automatic</option>'}</select><small>${configurableEffort ? 'Options come from the installed provider and selected model.' : 'This provider does not expose session-only effort control for the selected model.'}</small></label>
      <div class="model-control-note ${hasHistory ? 'warning' : ''}">${hasHistory ? '<strong>Changing model or effort can reduce prompt-cache reuse and change cost for the rest of this session.</strong>' : 'The change applies only to this running session. Global and project defaults are unchanged.'}</div>
      ${state.detail ? `<div class="model-control-error">${escapeHtml(state.detail)}</div>` : ''}
      <footer><span>${escapeHtml(state.status === 'queued' || state.status === 'applying' ? 'A newer confirmed choice replaces the queued request.' : 'Changes wait safely if the agent is busy.')}</span><button data-action="model-control-close" data-workspace-action>Close</button><button class="primary-button" data-action="model-control-apply" data-workspace-action ${!validModel || !effortAvailable ? 'disabled' : ''}>Apply</button></footer>
    </section></div>`;
  }

  private customEffortOptions(models: FleetModelOption[]): Array<{ id: string; label: string }> {
    const values = new Map<string, string>([['automatic', 'Automatic']]);
    for (const model of models) for (const item of model.efforts) values.set(item.id, item.label);
    return [...values].map(([id, label]) => ({ id, label }));
  }

  private patchModelDialog(): void {
    const host = this.element.querySelector<HTMLElement>('[data-model-control-host]');
    if (host) host.innerHTML = this.renderModelDialog();
  }

  private sessionHasCompletedAssistantReply(sessionId: string): boolean {
    const tab = [...this.tabs.values()].find((item) => item.sessionId === sessionId);
    const items = tab ? this.nativeStates.get(tab.id)?.items ?? [] : [];
    const observedReply = items.some((item) => item.role === 'assistant'
      && (item.state === 'complete' || Boolean(item.completedAt) || item.kind === 'message')
      && Boolean(item.text || item.detail));
    // Terminal mode intentionally does not fetch conversation content. Warn
    // conservatively there so an existing reply never bypasses the cache/cost
    // acknowledgement merely because Native history has not been opened.
    return observedReply || workspacePanes(this.workspaceState.layout)
      .some((pane) => pane.sessionId === sessionId && pane.viewMode === 'terminal');
  }

  private async applyModelDialog(): Promise<void> {
    const sessionId = this.modelDialogSessionId;
    const state = this.modelDialogState();
    if (!sessionId || !state || !this.modelDialogModelId || !this.modelDialogEffortId) return;
    const acknowledged = !this.sessionHasCompletedAssistantReply(sessionId) || window.confirm(
      'Changing model or effort after a reply can reduce prompt-cache reuse and change cost. Apply to this session?'
    );
    if (!acknowledged) return;
    this.modelDialogLoading = true;
    this.patchModelDialog();
    const result = await window.limitsWidget.setFleetSessionModel(
      sessionId, this.modelDialogModelId, this.modelDialogEffortId, this.modelDialogCustom,
      state.configRevision, acknowledged
    );
    this.modelDialogLoading = false;
    if (!result.ok || !result.state) {
      this.modelDialogError = result.message || 'The model change could not be queued';
      this.patchModelDialog();
      return;
    }
    this.modelStates.set(sessionId, { ...result.state, catalog: state.catalog });
    this.patchFocusedToolbar();
    this.patchModelDialog();
    void this.pollVisibleModelStates();
  }

  private async cancelPendingModelChange(): Promise<void> {
    const sessionId = this.modelDialogSessionId;
    const state = this.modelDialogState();
    if (!sessionId || !state?.pending) return;
    this.modelDialogLoading = true;
    this.patchModelDialog();
    const result = await window.limitsWidget.cancelFleetSessionModel(sessionId, state.configRevision);
    this.modelDialogLoading = false;
    if (!result.ok || !result.state) {
      this.modelDialogError = result.message || 'The queued change could not be cancelled';
    } else {
      this.modelStates.set(sessionId, { ...result.state, catalog: state.catalog });
    }
    this.patchFocusedToolbar();
    this.patchModelDialog();
  }

  private patchFocusedToolbar(): void {
    const toolbar = this.element.querySelector<HTMLElement>('[data-workspace-focused-toolbar]');
    if (toolbar) toolbar.innerHTML = this.renderFocusedToolbar();
  }

  private patchLimitCard(tab: TerminalTabDescriptor): void {
    const host = this.element.querySelector<HTMLElement>(`[data-native-host="${CSS.escape(tab.id)}"] [data-native-limit-host]`);
    if (!host) return;
    const attention = this.fleetSnapshot?.attention.find((item) => item.kind === 'hard-limit'
      && item.targetSessionId === tab.sessionId && !this.dismissedAttention.has(item.id));
    host.innerHTML = attention ? renderLimitCard(attention) : '';
  }

  private beginPointerResize(event: PointerEvent): void {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const railHandle = target?.closest<HTMLElement>('[data-rail-resizer]');
    if (railHandle) {
      event.preventDefault();
      const start = event.clientX;
      const initial = this.workspaceState.rail.width;
      let width = initial;
      const move = (next: PointerEvent): void => {
        width = Math.min(360, Math.max(180, initial + next.clientX - start));
        this.element.style.setProperty('--workspace-rail-width', `${width}px`);
        this.fitVisible();
      };
      const up = (): void => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        void this.updateRail({ ...this.workspaceState.rail, width: Math.round(width), collapsed: false });
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once: true });
      return;
    }
    const divider = target?.closest<HTMLElement>('[data-split-divider]');
    const split = divider?.parentElement;
    const splitId = divider?.dataset.splitId;
    const direction = divider?.dataset.direction;
    if (!divider || !split || !splitId || (direction !== 'row' && direction !== 'column')) {
      const paneId = target?.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId;
      if (paneId && paneId !== this.workspaceState.layout.focusedPaneId) void this.focusPane(paneId, false);
      return;
    }
    event.preventDefault();
    const rect = split.getBoundingClientRect();
    let ratio = 0.5;
    const move = (next: PointerEvent): void => {
      ratio = direction === 'row' ? (next.clientX - rect.left) / rect.width : (next.clientY - rect.top) / rect.height;
      ratio = Math.min(0.8, Math.max(0.2, ratio));
      if (direction === 'row') split.style.gridTemplateColumns = `${ratio}fr 7px ${1 - ratio}fr`;
      else split.style.gridTemplateRows = `${ratio}fr 7px ${1 - ratio}fr`;
      this.fitVisible();
    };
    const up = (): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      void this.applyCommand({ type: 'resize', splitId, ratio });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
  }

  private nativeState(tabId: string): NativeState {
    let state = this.nativeStates.get(tabId);
    if (!state) {
      state = { items: [], interactionMode: 'unknown', connection: 'Connecting…', providerActivity: null,
        providerActivityReceivedAt: 0, nextCursor: null,
        hasMore: false, loadingOlder: false, error: '', attachments: [], notice: '', draft: '',
        scrollTop: 0, scrollHeight: 0, scrollInitialized: false, followOutput: true, newMessages: false,
        renderMode: 'initial', questionDrafts: new Map(), questionSteps: new Map(),
        submittingQuestions: new Set(), expandedDetails: new Set(), questionSheetId: '', viewer: null,
        suggestion: { requestId: '', revision: '', target: null, loading: false, values: [], error: '', automatic: false },
        automaticSuggestionKey: '' };
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
        this.renderNativePanel(tab.id);
      }
    });
  }

  private syncConversation(): void {
    const desired = this.mounted && !document.hidden ? workspacePanes(this.workspaceState.layout)
      .filter((pane) => pane.viewMode === 'native')
      .map((pane) => this.tabForPane(pane))
      .filter((tab): tab is TerminalTabDescriptor => Boolean(tab && tab.tool !== 'shell'))
      .map((tab) => tab.id) : [];
    const signature = desired.join('\0');
    if (signature === [...this.conversationStarted].join('\0')) return;
    this.conversationStarted = new Set(desired);
    void window.limitsWidget.syncConversations(desired);
  }

  private syncTerminal(): void {
    const desired = this.mounted && !document.hidden ? workspacePanes(this.workspaceState.layout)
      .filter((pane) => pane.viewMode === 'terminal')
      .map((pane) => this.tabForPane(pane))
      .filter((tab): tab is TerminalTabDescriptor => Boolean(tab && !tab.failure))
      .map((tab) => tab.id) : [];
    const signature = desired.join('\0');
    if (signature === [...this.boundTerminalIds].join('\0')) return;
    this.boundTerminalIds = new Set(desired);
    void window.limitsWidget.syncTerminalTabs(desired);
  }

  private applyConversationFrame(tabId: string, frame: ConversationFrame): void {
    if (!this.tabs.has(tabId)) return;
    const state = this.nativeState(tabId);
    const suggestionRevisionBefore = this.suggestionRevision(state, state.suggestion.target);
    const pendingBefore = [...state.items].reverse().find((item) => ['question', 'approval'].includes(item.kind) && item.state !== 'complete')?.id ?? '';
    if (frame.type === 'conversation.snapshot') {
      const firstSnapshot = !state.scrollInitialized && !state.items.length;
      state.items = mergeItems([], frame.items ?? []);
      state.renderMode = firstSnapshot ? 'initial' : 'preserve';
      state.interactionMode = frame.interactionMode ?? 'unknown';
      state.providerActivity = Object.prototype.hasOwnProperty.call(frame, 'providerActivity') ? frame.providerActivity ?? null : null;
      state.providerActivityReceivedAt = state.providerActivity ? Date.now() : 0;
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
      const hasProviderActivity = Object.prototype.hasOwnProperty.call(frame, 'providerActivity');
      const providerChanged = hasProviderActivity && !sameProviderActivity(state.providerActivity, frame.providerActivity ?? null);
      if (connection === state.connection && interactionMode === state.interactionMode && !providerChanged) return;
      state.connection = connection;
      state.interactionMode = interactionMode;
      if (hasProviderActivity) {
        state.providerActivity = frame.providerActivity ?? null;
        state.providerActivityReceivedAt = state.providerActivity ? Date.now() : 0;
      }
    }
    const activeQuestionIds = new Set(state.items.filter((item) => item.kind === 'question' && item.state !== 'complete').map((item) => item.id));
    for (const id of state.submittingQuestions) if (!activeQuestionIds.has(id)) state.submittingQuestions.delete(id);
    const pendingAfter = [...state.items].reverse().find((item) => ['question', 'approval'].includes(item.kind) && item.state !== 'complete')?.id ?? '';
    if (!pendingAfter) state.questionSheetId = '';
    else if (pendingAfter !== pendingBefore && state.followOutput && !state.viewer) state.questionSheetId = pendingAfter;
    if (state.suggestion.target && suggestionRevisionBefore !== this.suggestionRevision(state, state.suggestion.target)) {
      this.clearSuggestions(tabId, true);
    }
    this.maybeStartAutomaticSuggestion(tabId, frame.type === 'conversation.snapshot');
    this.queueNativeRender(tabId);
  }

  private queueNativeRender(tabId: string): void {
    if (this.nativeRenderQueued.has(tabId)) return;
    this.nativeRenderQueued.add(tabId);
    requestAnimationFrame(() => {
      this.nativeRenderQueued.delete(tabId);
      this.renderNativePanel(tabId);
    });
  }

  private patchProviderActivityStatuses(): void {
    for (const element of this.element.querySelectorAll<HTMLElement>('[data-provider-activity-tab]')) {
      const tabId = element.dataset.providerActivityTab ?? '';
      const state = this.nativeStates.get(tabId);
      const tab = this.tabs.get(tabId);
      if (!state || !tab) continue;
      const value = providerActivityText(tab.tool, state.providerActivity, state.providerActivityReceivedAt) || state.connection;
      if (element.textContent !== value) element.textContent = value;
    }
  }

  private renderSelectedNative(): void {
    if (this.selectedId) this.renderNativePanel(this.selectedId);
  }

  private renderNativePanel(tabId: string): void {
    const tab = this.tabs.get(tabId);
    const pane = tab ? paneForSession(this.workspaceState.layout, tab.sessionId) : undefined;
    const host = this.element.querySelector<HTMLElement>(`[data-native-host="${CSS.escape(tabId)}"]`);
    if (!tab || !pane || !host || pane.viewMode !== 'native') return;
    const previous = this.captureRenderSnapshot(tabId);
    host.innerHTML = this.renderNative(tab);
    queueMicrotask(() => this.restoreRenderSnapshot(tab.id, previous));
  }

  private renderNative(tab: TerminalTabDescriptor): string {
    if (tab.tool === 'shell') return `<div class="native-shell"><div class="native-shell-intro"><strong>Friendly shell</strong><span>Use short navigation commands here. Switch to Terminal for full-screen programs.</span></div>${this.renderComposer(tab, this.nativeState(tab.id))}</div>`;
    const state = this.nativeState(tab.id);
    const pending = [...state.items].reverse().find((item) => ['question', 'approval'].includes(item.kind) && item.state !== 'complete');
    const feedItems = pending ? state.items.filter((item) => item.id !== pending.id) : state.items;
    const viewerItem = state.viewer ? state.items.find((item) => item.id === state.viewer?.itemId) : undefined;
    const attention = this.fleetSnapshot?.attention.find((item) =>
      item.kind === 'hard-limit' && item.targetSessionId === tab.sessionId && !this.dismissedAttention.has(item.id)
    );
    return `<div class="native-conversation ${state.interactionMode === 'plan' ? 'planning' : ''}" data-native-tab="${escapeAttr(tab.id)}">
      <div class="native-conversation-header"><span><i class="terminal-status status-${state.connection === 'Live' ? 'live' : 'offline'}"></i><span data-provider-activity-tab="${escapeAttr(tab.id)}">${escapeHtml(providerActivityText(tab.tool, state.providerActivity, state.providerActivityReceivedAt) || state.connection)}</span></span>${state.interactionMode === 'plan' ? '<b>Planning mode</b>' : ''}</div>
      <div class="native-messages" data-native-scroll-tab="${escapeAttr(tab.id)}">
        ${state.hasMore ? `<button class="load-older" data-action="native-load-older" data-workspace-action ${state.loadingOlder ? 'disabled' : ''}>${state.loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>` : ''}
        ${state.error ? `<div class="native-error"><strong>Native view needs attention</strong><span>${escapeHtml(state.error)}</span><button data-action="native-retry" data-workspace-action>Retry</button></div>` : ''}
        ${renderConversationRows(feedItems, state.expandedDetails)}
        ${!state.items.length && !state.error ? '<div class="native-empty"><strong>Loading conversation…</strong><span>The newest messages appear first; older history loads only when requested.</span></div>' : ''}
      </div>
      ${state.newMessages ? '<button class="new-messages-button" data-new-messages data-action="native-new-messages" data-workspace-action>New messages ↓</button>' : ''}
      <div data-native-limit-host>${attention ? renderLimitCard(attention) : ''}</div>
      ${pending ? this.renderPendingAction(pending, state) : this.renderComposer(tab, state)}
      ${viewerItem && state.viewer ? renderConversationViewer(viewerItem, state.viewer) : ''}
    </div>`;
  }

  private renderPendingAction(item: ConversationItem, state: NativeState): string {
    const content = item.kind === 'question'
      ? renderQuestion(item, state.questionSteps.get(item.id) ?? 0, state.questionDrafts.get(item.id), state.submittingQuestions.has(item.id),
        localSuggestionsEnabled(this.localSuggestionSettings.mode) ? state.suggestion : undefined, this.localSuggestionSettings.mode)
      : renderConversationItem(item);
    const label = item.kind === 'question' ? (item.title || 'Answer needed') : (item.title || 'Approval needed');
    return `<section class="native-answer-bar ${state.interactionMode === 'plan' ? 'planning' : ''}" data-conversation-item="${escapeAttr(item.id)}"><button data-action="native-question-open" data-workspace-action><span><strong>${escapeHtml(label)}</strong><small>Tap to respond</small></span><b>Open</b></button></section>
      ${state.questionSheetId === item.id ? `<div class="native-sheet-backdrop"><section class="native-question-sheet"><header><span><strong>Action needed</strong><small>Complete this to continue the session</small></span><button class="quiet-button" data-action="native-question-close" data-workspace-action aria-label="Close">×</button></header>${content}</section></div>` : ''}`;
  }

  private renderComposer(tab: TerminalTabDescriptor, state: NativeState): string {
    const canSuggest = localSuggestionsEnabled(this.localSuggestionSettings.mode) && !state.attachments.length
      && canSuggestForComposer(state.items, state.draft);
    const suggestionLabel = this.localSuggestionSettings.mode === 'automatic' ? 'Regenerate' : 'Suggest';
    return `<div class="native-composer ${state.interactionMode === 'plan' ? 'planning' : ''}" data-composer-tab="${escapeAttr(tab.id)}">
      ${state.attachments.length ? `<div class="attachment-strip">${state.attachments.map((item) => `<button data-action="native-remove-attachment" data-workspace-action data-attachment-id="${escapeAttr(item.id)}" title="Remove ${escapeAttr(item.name)}"><img src="${item.thumbnail}" alt=""><span>${escapeHtml(item.name)}</span><b>×</b></button>`).join('')}</div>` : ''}
      ${state.notice ? `<small class="composer-notice">${escapeHtml(state.notice)}</small>` : ''}
      <textarea data-native-message data-focus-key="native-message" maxlength="32768" placeholder="Message ${escapeAttr(tab.tool)}… (Ctrl+Enter to send)">${escapeHtml(state.draft)}</textarea>
      ${state.suggestion.target?.kind === 'composer' ? renderSuggestionChoices(state.suggestion) : ''}
      <div class="composer-actions"><button data-action="native-attach" data-workspace-action title="Choose images">Attach</button><button data-action="native-clipboard" data-workspace-action title="Paste image from clipboard">Paste image</button><button data-action="native-shift-tab" data-workspace-action>Shift+Tab</button><button data-action="native-control-c" data-workspace-action>Ctrl+C</button>${canSuggest && !state.suggestion.target ? `<button data-action="native-suggest" data-workspace-action data-suggestion-target="composer">${suggestionLabel}</button>` : ''}<span></span><button class="primary-button" data-action="native-send" data-workspace-action>Send</button></div>
    </div>`;
  }

  private async requestSuggestions(control: HTMLElement): Promise<void> {
    const tabId = this.selectedId;
    if (!tabId || !localSuggestionsEnabled(this.localSuggestionSettings.mode)) return;
    const state = this.nativeState(tabId);
    let target: LocalSuggestionTarget = { kind: 'composer' };
    if (control.dataset.suggestionTarget === 'question') {
      const item = this.itemFromControl(control);
      const questionId = control.dataset.questionId;
      const question = item?.questions?.find((value) => value.id === questionId);
      const draft = item && question ? state.questionDrafts.get(item.id)?.find((answer) => answer.questionId === question.id)?.text ?? '' : '';
      if (!item || !question || !canSuggestForQuestion(question, draft)) return;
      target = { kind: 'question', itemId: item.id, questionId: question.id, prompt: question.prompt };
    } else if (!canSuggestForComposer(state.items, state.draft) || state.attachments.length) return;
    await this.requestSuggestionTarget(tabId, target, false);
  }

  private async requestSuggestionTarget(tabId: string, target: LocalSuggestionTarget, automatic: boolean): Promise<void> {
    if (!localSuggestionsEnabled(this.localSuggestionSettings.mode)) return;
    const state = this.nativeState(tabId);
    this.clearSuggestions(tabId, true);
    const requestId = globalThis.crypto.randomUUID();
    const revision = this.suggestionRevision(state, target);
    state.suggestion = { requestId, revision, target, loading: true, values: [], error: '', automatic };
    if (this.selectedId === tabId) this.renderSelectedNative();
    let result;
    try {
      result = await window.limitsWidget.suggestLocalReplies({
        requestId, tabId, revision, target, messages: conversationSuggestionContext(state.items)
      });
    } catch (error) {
      result = { ok: false, requestId, revision, suggestions: [], message: error instanceof Error ? error.message : 'Local suggestion failed.' };
    }
    if (state.suggestion.requestId !== requestId || revision !== this.suggestionRevision(state, target)) return;
    state.suggestion.loading = false;
    if (result.ok && result.revision === revision) state.suggestion.values = result.suggestions;
    else state.suggestion.error = automatic ? 'Couldn’t prepare replies locally.' : result.message;
    if (this.selectedId === tabId) this.renderSelectedNative();
  }

  private useSuggestion(control: HTMLElement): void {
    const state = this.nativeState(this.selectedId);
    const index = Number.parseInt(control.dataset.suggestionIndex ?? '', 10);
    const value = state.suggestion.values[index];
    const target = state.suggestion.target;
    if (!value || !target) return;
    if (target.kind === 'composer') {
      state.draft = value;
    } else {
      const answers = [...(state.questionDrafts.get(target.itemId) ?? [])];
      const index = answers.findIndex((answer) => answer.questionId === target.questionId);
      const answer = { questionId: target.questionId, choiceIds: index >= 0 ? answers[index].choiceIds : [], text: value };
      if (index >= 0) answers[index] = answer; else answers.push(answer);
      state.questionDrafts.set(target.itemId, answers);
    }
    this.clearSuggestions(this.selectedId);
    state.renderMode = 'preserve';
    this.renderSelectedNative();
  }

  private clearSuggestions(tabId: string, cancel = false): void {
    const state = this.nativeStates.get(tabId);
    if (!state) return;
    const requestId = state.suggestion.requestId;
    if (cancel && state.suggestion.loading && requestId) void window.limitsWidget.cancelLocalSuggestions(requestId);
    state.suggestion = { requestId: '', revision: '', target: null, loading: false, values: [], error: '', automatic: false };
  }

  private suggestionRevision(state: NativeState, target: LocalSuggestionTarget | null): string {
    return localSuggestionRevision(state.items, target);
  }

  private automaticSuggestionTarget(tabId: string): LocalSuggestionTarget | null {
    const state = this.nativeState(tabId);
    const pending = [...state.items].reverse().find((item) => ['question', 'approval'].includes(item.kind) && item.state !== 'complete');
    if (pending?.kind === 'question') {
      const questions = pending.questions?.length ? pending.questions : fallbackQuestion(pending);
      const step = Math.min(state.questionSteps.get(pending.id) ?? 0, questions.length - 1);
      const question = questions[step];
      const draft = state.questionDrafts.get(pending.id)?.find((answer) => answer.questionId === question?.id)?.text
        ?? pending.answers?.find((answer) => answer.questionId === question?.id)?.text ?? '';
      if (question && canSuggestForQuestion(question, draft)) {
        return { kind: 'question', itemId: pending.id, questionId: question.id, prompt: question.prompt };
      }
      return null;
    }
    if (pending || state.attachments.length || !canSuggestForComposer(state.items, state.draft)) return null;
    return { kind: 'composer' };
  }

  private automaticSuggestionActive(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    const pane = tab ? paneForSession(this.workspaceState.layout, tab.sessionId) : undefined;
    return this.mounted && !document.hidden && this.selectedId === tabId && pane?.viewMode === 'native';
  }

  private baselineAutomaticSuggestion(tabId: string): void {
    const state = this.nativeState(tabId);
    const target = this.automaticSuggestionTarget(tabId);
    state.automaticSuggestionKey = target ? this.suggestionRevision(state, target) : '';
  }

  private maybeStartAutomaticSuggestion(tabId: string, historicalFrame = false): void {
    const state = this.nativeState(tabId);
    const target = this.automaticSuggestionTarget(tabId);
    const currentKey = target ? this.suggestionRevision(state, target) : '';
    const active = this.localSuggestionSettings.mode === 'automatic' && this.automaticSuggestionActive(tabId);
    const start = shouldStartAutomaticSuggestion(state.automaticSuggestionKey, currentKey, active, historicalFrame);
    state.automaticSuggestionKey = currentKey;
    if (start && target) void this.requestSuggestionTarget(tabId, target, true);
  }

  private async loadOlder(): Promise<void> {
    const state = this.nativeState(this.selectedId);
    if (!state.nextCursor || state.loadingOlder) return;
    state.loadingOlder = true; this.renderSelectedNative();
    const result = await window.limitsWidget.pageConversation(this.selectedId, state.nextCursor);
    state.loadingOlder = false;
    if (result.frame?.type === 'conversation.snapshot') {
      state.items = mergeItems(result.frame.items ?? [], state.items);
      state.nextCursor = result.frame.nextCursor ?? null; state.hasMore = Boolean(result.frame.hasMore);
      state.renderMode = 'prepend';
    } else state.notice = result.message;
    this.renderSelectedNative();
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
    this.renderSelectedNative();
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
        this.maybeStartAutomaticSuggestion(this.selectedId);
        this.renderSelectedNative(); return;
      }
    }
    state.submittingQuestions.add(item.id);
    state.notice = 'Submitting answers…';
    this.renderSelectedNative();
    const result = await window.limitsWidget.answerConversation(this.selectedId, item.id, item.revision, answers);
    state.notice = result.message;
    if (result.ok) state.items = mergeItems(state.items, [{ ...item, state: 'running', title: 'Answer sent…', answers }]);
    else state.submittingQuestions.delete(item.id);
    this.renderSelectedNative();
  }

  private captureQuestionDraft(input: HTMLInputElement | HTMLTextAreaElement): void {
    const card = input.closest<HTMLElement>('[data-conversation-item]');
    if (!card?.dataset.conversationItem) return;
    this.captureVisibleQuestionDraft(card.dataset.conversationItem);
  }

  private captureVisibleQuestionDraft(itemId: string): void {
    const root = this.element.querySelector<HTMLElement>(`[data-native-host="${CSS.escape(this.selectedId)}"]`);
    const candidates = [...(root?.querySelectorAll<HTMLElement>('[data-conversation-item]') ?? [])]
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
    if (question.type === 'multi') { this.renderSelectedNative(); return; }
    if (step < item.questions.length - 1) {
      state.questionSteps.set(item.id, step + 1);
      state.renderMode = 'preserve';
      this.maybeStartAutomaticSuggestion(this.selectedId);
      this.renderSelectedNative();
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
      this.renderSelectedNative();
      return;
    }
    if (step >= item.questions.length - 1) { await this.submitQuestion(item); return; }
    state.questionSteps.set(item.id, step + 1);
    state.renderMode = 'preserve';
    this.maybeStartAutomaticSuggestion(this.selectedId);
    this.renderSelectedNative();
  }

  private async closeTab(tabId: string): Promise<void> {
    const state = this.nativeStates.get(tabId);
    if ((state?.draft.trim() || state?.attachments.length) && !window.confirm('Close this tab and discard its unsent draft and staged attachments?')) return;
    await window.limitsWidget.closeTerminalTab(tabId);
  }

  private async killTab(tab: TerminalTabDescriptor): Promise<void> {
    const session = this.fleetSnapshot?.sessions.find((item) => item.id === tab.sessionId);
    if (!session || !this.fleetSnapshot || !isFleetSessionAvailable(this.fleetSnapshot, session)) {
      const state = this.nativeState(tab.id);
      state.notice = `${tab.label}'s host is offline; no changes were made`;
      this.renderSelectedNative();
      return;
    }
    if (!window.confirm(`Kill “${tab.label}” on ${tab.hostId}? This destroys the tmux session and cancels its pending schedules.`)) return;
    const result = await window.limitsWidget.killFleetSession(tab.sessionId);
    const state = this.nativeState(tab.id);
    state.notice = result.message;
    if (result.ok) await this.clearSession(tab.sessionId);
    else this.renderSelectedNative();
  }

  private attentionFromControl(control: HTMLElement): FleetAttention | undefined {
    const id = control.closest<HTMLElement>('[data-attention-id]')?.dataset.attentionId;
    return this.fleetSnapshot?.attention.find((item) => item.id === id);
  }

  private async scheduleLimit(attention: FleetAttention, deliverAt: string): Promise<void> {
    if (!attention.targetSessionId) return;
    const state = this.nativeState(this.selectedId);
    state.notice = 'Scheduling Continue…';
    this.renderSelectedNative();
    const result = await window.limitsWidget.createFleetContinueSchedule(attention.targetSessionId, deliverAt, attention.id);
    state.notice = result.message;
    this.renderSelectedNative();
  }

  private async dismissLimit(attention: FleetAttention): Promise<void> {
    const tabId = this.selectedId;
    const state = this.nativeState(tabId);
    this.dismissedAttention.add(attention.id);
    state.notice = 'Dismissing limit offer…';
    this.renderSelectedNative();
    const result = await window.limitsWidget.dismissFleetAttention(attention.id);
    if (!result.ok) this.dismissedAttention.delete(attention.id);
    state.notice = result.message;
    if (this.selectedId === tabId) this.renderSelectedNative();
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
    const root = this.element.querySelector<HTMLElement>(`[data-native-host="${CSS.escape(this.selectedId)}"]`);
    const messages = root?.querySelector<HTMLElement>('.native-messages');
    if (!messages) return;
    messages.scrollTop = messages.scrollHeight;
    const state = this.nativeState(this.selectedId);
    state.followOutput = true; state.newMessages = false; state.scrollTop = messages.scrollTop;
    root?.querySelector('[data-new-messages]')?.remove();
  }

  private captureRenderSnapshot(tabId: string): RenderSnapshot | null {
    const root = this.element.querySelector<HTMLElement>(`[data-native-host="${CSS.escape(tabId)}"]`);
    if (!root) return null;
    const messages = root.querySelector<HTMLElement>('.native-messages');
    if (!messages) return null;
    const state = this.nativeState(tabId);
    state.scrollTop = messages.scrollTop;
    state.scrollHeight = messages.scrollHeight;
    state.followOutput = isNearBottom(messages);
    for (const detail of root.querySelectorAll<HTMLDetailsElement>('details[data-detail-id]')) {
      if (detail.open) state.expandedDetails.add(detail.dataset.detailId!); else state.expandedDetails.delete(detail.dataset.detailId!);
    }
    const active = (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)
      && root.contains(document.activeElement) ? document.activeElement : null;
    return {
      tabId, scrollTop: messages.scrollTop, scrollHeight: messages.scrollHeight,
      nearBottom: isNearBottom(messages), focusKey: active?.dataset.focusKey ?? '',
      selectionStart: active?.selectionStart ?? null, selectionEnd: active?.selectionEnd ?? null
    };
  }

  private restoreRenderSnapshot(tabId: string, previous: RenderSnapshot | null): void {
    const root = this.element.querySelector<HTMLElement>(`[data-native-host="${CSS.escape(tabId)}"]`);
    if (!root) return;
    const messages = root.querySelector<HTMLElement>('.native-messages');
    const state = this.nativeState(tabId);
    if (!messages) return;
    this.enhanceMarkdownCopy(root);
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
    for (const detail of root.querySelectorAll<HTMLDetailsElement>('details[data-detail-id]')) {
      detail.open = Boolean(detail.dataset.detailId && state.expandedDetails.has(detail.dataset.detailId));
    }
    if (previous?.tabId === tabId && previous.focusKey) {
      const focus = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-focus-key]')]
        .find((value) => value.dataset.focusKey === previous.focusKey);
      focus?.focus();
      if (focus && previous.selectionStart !== null && previous.selectionEnd !== null) focus.setSelectionRange(previous.selectionStart, previous.selectionEnd);
    }
  }

  private enhanceMarkdownCopy(root: HTMLElement): void {
    for (const pre of root.querySelectorAll<HTMLElement>('.native-markdown pre')) {
      if (pre.parentElement?.matches('[data-copy-source]')) continue;
      const wrapper = document.createElement('div'); wrapper.className = 'copy-code-block'; wrapper.dataset.copySource = '';
      const copyValue = document.createElement('span'); copyValue.hidden = true; copyValue.dataset.copyValue = '';
      copyValue.textContent = pre.textContent ?? '';
      const button = document.createElement('button'); button.textContent = 'Copy'; button.dataset.action = 'native-copy'; button.dataset.workspaceAction = '';
      pre.replaceWith(wrapper); wrapper.append(copyValue, button, pre);
    }
  }

  private async stageFile(file: File): Promise<void> {
    const tabId = this.selectedId;
    this.clearSuggestions(tabId, true);
    try {
      const attachments = await window.limitsWidget.stageAttachmentBytes(tabId, file.name, file.type, new Uint8Array(await file.arrayBuffer()));
      this.nativeState(tabId).attachments = attachments;
    } catch (error) { this.nativeState(tabId).notice = error instanceof Error ? error.message : 'Image could not be staged'; }
    if (this.selectedId === tabId) this.renderSelectedNative();
  }
  private async stageClipboard(): Promise<void> { await this.updateAttachments(() => window.limitsWidget.stageClipboardImage(this.selectedId)); }
  private async chooseAttachments(): Promise<void> { await this.updateAttachments(() => window.limitsWidget.chooseConversationAttachments(this.selectedId)); }
  private async removeAttachment(id: string): Promise<void> { await this.updateAttachments(() => window.limitsWidget.removeConversationAttachment(this.selectedId, id)); }
  private async updateAttachments(action: () => Promise<StagedAttachment[]>): Promise<void> {
    const tabId = this.selectedId;
    this.clearSuggestions(tabId, true);
    try { this.nativeState(tabId).attachments = await action(); }
    catch (error) { this.nativeState(tabId).notice = error instanceof Error ? error.message : 'Attachment action failed'; }
    if (this.selectedId === tabId) this.renderSelectedNative();
  }
  private async sendMessage(): Promise<void> {
    if (!this.selectedId) return;
    const input = this.element.querySelector<HTMLTextAreaElement>(`[data-native-host="${CSS.escape(this.selectedId)}"] [data-native-message]`);
    const text = input?.value ?? '';
    const result = await window.limitsWidget.sendConversationMessage(this.selectedId, text);
    const state = this.nativeState(this.selectedId); state.notice = result.message;
    if (result.ok) { state.attachments = []; state.draft = ''; if (input) input.value = ''; }
    this.renderSelectedNative();
  }

  private terminalHistoryState(tabId: string): TerminalHistoryState {
    let state = this.terminalHistories.get(tabId);
    if (!state) {
      state = createTerminalHistoryState();
      this.terminalHistories.set(tabId, state);
    }
    return state;
  }

  private clearTerminalHistory(tabId: string): void {
    const state = this.terminalHistories.get(tabId);
    if (state) {
      state.updated = false;
      state.generation += 1;
    }
    this.closeTerminalHistory(tabId);
    const timer = this.terminalHistoryTimers.get(tabId);
    if (timer !== undefined) window.clearTimeout(timer);
    this.terminalHistoryTimers.delete(tabId);
    this.terminalHistories.delete(tabId);
    this.terminalHistoryQueue = this.terminalHistoryQueue.filter((request) => request.tabId !== tabId);
    this.terminalHistoryQueued.delete(tabId);
  }

  private noteTerminalHistoryActivity(tabId: string, input: boolean): void {
    const tab = this.tabs.get(tabId);
    if (!terminalHistoryEligible(tab)) return;
    const state = this.terminalHistoryState(tabId);
    const timer = this.terminalHistoryTimers.get(tabId);
    if (timer !== undefined) window.clearTimeout(timer);
    this.terminalHistoryTimers.delete(tabId);
    if (state.status === 'error') state.status = 'idle';
    if (!input && state.status === 'ready' && state.snapshot) {
      state.updated = true;
    }
    if (!state.active) this.scheduleTerminalHistory(tabId);
  }

  private scheduleTerminalHistory(tabId: string, immediate = false): void {
    const tab = this.tabs.get(tabId);
    const pane = tab ? paneForSession(this.workspaceState.layout, tab.sessionId) : undefined;
    const state = this.terminalHistoryState(tabId);
    if (!this.mounted || document.hidden || !terminalHistoryEligible(tab) || pane?.viewMode !== 'terminal') return;
    if (state.active || state.status === 'loading' || state.status === 'error' ||
        state.status === 'ready' && !state.updated) return;
    const previous = this.terminalHistoryTimers.get(tabId);
    if (previous !== undefined) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      this.terminalHistoryTimers.delete(tabId);
      const runtime = this.runtimes.get(tabId);
      if (!runtime || runtime.terminal.buffer.active.type !== 'alternate') return;
      this.enqueueTerminalHistory(tabId);
    }, immediate ? 0 : TERMINAL_HISTORY_QUIET_MS);
    this.terminalHistoryTimers.set(tabId, timer);
  }

  private enqueueTerminalHistory(tabId: string): void {
    const state = this.terminalHistoryState(tabId);
    if (this.terminalHistoryQueued.has(tabId)) return;
    state.generation += 1;
    state.status = 'loading';
    state.error = '';
    const request = { tabId, generation: state.generation };
    this.terminalHistoryQueued.add(tabId);
    if (tabId === this.selectedId) this.terminalHistoryQueue.unshift(request);
    else this.terminalHistoryQueue.push(request);
    void this.drainTerminalHistoryQueue();
  }

  private async drainTerminalHistoryQueue(): Promise<void> {
    if (this.terminalHistoryRequestActive) return;
    this.terminalHistoryRequestActive = true;
    try {
      while (this.terminalHistoryQueue.length) {
        const request = this.terminalHistoryQueue.shift()!;
        const state = this.terminalHistories.get(request.tabId);
        const tab = this.tabs.get(request.tabId);
        if (!state || !terminalHistoryEligible(tab) || state.generation !== request.generation) {
          this.terminalHistoryQueued.delete(request.tabId);
          continue;
        }
        const result = await window.limitsWidget.loadTerminalHistory(request.tabId);
        this.terminalHistoryQueued.delete(request.tabId);
        if (!this.terminalHistories.has(request.tabId) || state.generation !== request.generation) continue;
        if (!result.ok || !result.pane) {
          state.status = 'error';
          state.error = result.message || 'Pane scrollback could not be loaded.';
        } else {
          const next = applyTerminalHistorySnapshot(state, result.pane);
          Object.assign(state, next);
        }
      }
    } finally {
      this.terminalHistoryRequestActive = false;
      if (this.terminalHistoryQueue.length) void this.drainTerminalHistoryQueue();
    }
  }

  private openTerminalHistory(tabId: string, scrollDelta = 0): void {
    const tab = this.tabs.get(tabId);
    const runtime = this.runtimes.get(tabId);
    if (!terminalHistoryEligible(tab) || !runtime) return;
    const state = this.terminalHistoryState(tabId);
    if (state.active && runtime.historyTerminal) {
      this.scrollTerminalHistory(tabId, scrollDelta);
      return;
    }
    if (state.snapshot && !terminalHistoryDimensionsMatch(
      state.snapshot, runtime.terminal.cols, runtime.terminal.rows
    )) {
      state.snapshot = null;
      state.status = 'idle';
    }
    if (!state.snapshot || state.status !== 'ready') {
      if (state.status === 'idle') this.enqueueTerminalHistory(tabId);
      return;
    }
    const host = runtime.element.parentElement;
    if (!host) return;
    const historyTerminal = new Terminal({
      ...this.terminalOptions(),
      cursorBlink: false,
      scrollback: Math.max(5_000, this.settings.terminalAppearance.scrollback)
    });
    const historyFit = new FitAddon();
    historyTerminal.loadAddon(historyFit);
    const historyElement = document.createElement('div');
    historyElement.className = 'xterm-runtime terminal-scrollback-runtime';
    host.append(historyElement);
    historyTerminal.open(historyElement);
    historyFit.fit();
    if (!terminalHistoryDimensionsMatch(state.snapshot, historyTerminal.cols, historyTerminal.rows)) {
      historyTerminal.dispose();
      historyElement.remove();
      state.snapshot = null;
      state.status = 'idle';
      this.enqueueTerminalHistory(tabId);
      return;
    }
    historyTerminal.onData((data) => {
      this.closeTerminalHistory(tabId);
      void window.limitsWidget.terminalInput(tabId, data);
    });
    historyElement.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.scrollTerminalHistory(tabId, event.deltaY);
    }, { capture: true, passive: false });
    runtime.historyTerminal = historyTerminal;
    runtime.historyFit = historyFit;
    runtime.historyElement = historyElement;
    state.active = true;
    historyTerminal.write(decodePaneAnsi(state.snapshot.ansiBase64), () => {
      if (!state.active) return;
      historyTerminal.scrollToBottom();
      this.scrollTerminalHistory(tabId, scrollDelta || -3);
      historyTerminal.focus();
    });
  }

  private closeTerminalHistory(tabId: string): void {
    const state = this.terminalHistories.get(tabId);
    if (state) state.active = false;
    const runtime = this.runtimes.get(tabId);
    runtime?.historyTerminal?.dispose();
    runtime?.historyElement?.remove();
    if (runtime) {
      delete runtime.historyTerminal;
      delete runtime.historyFit;
      delete runtime.historyElement;
      runtime.terminal.focus();
    }
    if (state?.updated) {
      state.status = 'idle';
      this.scheduleTerminalHistory(tabId);
    }
  }

  private scrollTerminalHistory(tabId: string, deltaY: number): void {
    const runtime = this.runtimes.get(tabId);
    const terminal = runtime?.historyTerminal;
    if (!terminal) return;
    const rows = Math.max(3, Math.ceil(Math.abs(deltaY) / 40));
    terminal.scrollLines(deltaY < 0 ? -rows : rows);
    if (deltaY > 0 && terminalHistoryAtBottom(terminal.buffer.active.viewportY, terminal.buffer.active.baseY)) {
      this.closeTerminalHistory(tabId);
    }
  }

  private fitRuntime(runtime: TerminalRuntime): void {
    if (!runtime || !this.element.isConnected) return;
    try {
      const tabId = [...this.runtimes.entries()].find(([, value]) => value === runtime)?.[0];
      const previousColumns = runtime.terminal.cols;
      const previousRows = runtime.terminal.rows;
      if (tabId && runtime.historyTerminal) this.closeTerminalHistory(tabId);
      runtime.fit.fit();
      if (tabId) {
        if (runtime.terminal.cols !== previousColumns || runtime.terminal.rows !== previousRows) {
          const state = this.terminalHistories.get(tabId);
          if (state) {
            state.snapshot = null;
            state.status = 'idle';
            state.updated = false;
            state.generation += 1;
          }
          this.scheduleTerminalHistory(tabId);
        }
        void window.limitsWidget.terminalResize(tabId, runtime.terminal.cols, runtime.terminal.rows);
      }
    } catch { /* the terminal is temporarily hidden */ }
  }

  private fitVisible(): void {
    for (const [tabId, runtime] of this.runtimes) {
      if (this.boundTerminalIds.has(tabId) && runtime.element.isConnected) this.fitRuntime(runtime);
    }
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
    if (hasTasks && items[index].kind === 'status' && ['Working', 'Done'].includes(items[index].title)
      && !providerWorkDuration(items[index])) { index += 1; continue; }
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
  if (item.kind === 'status' && ['Done', 'Turn Duration'].includes(item.title)) {
    const duration = providerWorkDuration(item);
    if (duration) return `<article class="native-message activity"><small>✓</small>${markdown(`Worked for ${duration}`)}</article>`;
  }
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

function renderQuestion(
  item: ConversationItem,
  requestedStep = 0,
  draftAnswers?: ConversationAnswer[],
  submitting = false,
  suggestion?: NativeState['suggestion'],
  suggestionMode: LocalSuggestionSettingsView['mode'] = 'off'
): string {
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
    ${visibleQuestions.map((question) => renderQuestionPart(question, item, answerSource, suggestion, suggestionMode)).join('')}
    ${complete ? '<div class="question-complete">Answer submitted</div>' : ''}</div>
    ${complete ? '' : `<div class="question-navigation">${step > 0 ? '<button class="quiet-button" data-action="native-question-back" data-workspace-action>Back</button>' : '<span></span>'}${explicitAction ? `<button class="primary-button question-submit" data-action="native-question-next" data-workspace-action ${submitting ? 'disabled' : ''}>${submitting ? 'Sending…' : actionLabel}</button>` : '<small>Tap an answer to continue</small>'}</div>`}</article>`;
}

function renderQuestionPart(
  question: ConversationQuestion,
  item: ConversationItem,
  answers?: ConversationAnswer[],
  suggestion?: NativeState['suggestion'],
  suggestionMode: LocalSuggestionSettingsView['mode'] = 'off'
): string {
  const existing = answers?.find((answer) => answer.questionId === question.id) ?? item.answers?.find((answer) => answer.questionId === question.id);
  const choices = question.type === 'boolean' && !question.options.length
    ? [{ id: 'true', label: 'Yes', description: '' }, { id: 'false', label: 'No', description: '' }]
    : question.options;
  const options = choices.map((option) => `<button type="button" class="question-option ${existing?.choiceIds.includes(option.id) ? 'selected' : ''}" data-action="native-question-choice" data-workspace-action data-choice="${escapeAttr(option.id)}" data-question-id="${escapeAttr(question.id)}"><span><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</span><b>${existing?.choiceIds.includes(option.id) ? '✓' : ''}</b></button>`).join('');
  const textInput = question.type === 'text' || question.allowOther
    ? `<textarea data-question-text data-question-id="${escapeAttr(question.id)}" data-focus-key="question-${escapeAttr(item.id)}-${escapeAttr(question.id)}" placeholder="${question.type === 'text' ? 'Type your answer' : 'Or type another answer'}" enterkeyhint="send">${escapeHtml(existing?.text ?? '')}</textarea>` : '';
  const canSuggest = Boolean(suggestion) && canSuggestForQuestion(question, existing?.text ?? '');
  const activeSuggestion = suggestion?.target?.kind === 'question'
    && suggestion.target.itemId === item.id && suggestion.target.questionId === question.id ? suggestion : undefined;
  const suggestionLabel = suggestionMode === 'automatic' ? 'Regenerate' : 'Suggest';
  return `<fieldset class="question-part"><legend>${question.header ? `<small>${escapeHtml(question.header)}</small>` : ''}<strong>${escapeHtml(question.prompt)}</strong></legend>${options}${textInput}${activeSuggestion ? renderSuggestionChoices(activeSuggestion) : ''}${canSuggest && !activeSuggestion ? `<button type="button" class="suggest-button" data-action="native-suggest" data-workspace-action data-suggestion-target="question" data-question-id="${escapeAttr(question.id)}">${suggestionLabel}</button>` : ''}</fieldset>`;
}

function renderSuggestionChoices(suggestion: NativeState['suggestion']): string {
  if (suggestion.loading) return `<div class="local-suggestions"><small>${suggestion.automatic ? 'Preparing replies locally…' : 'Thinking locally…'}</small><button type="button" data-action="native-suggestion-cancel" data-workspace-action>Cancel</button></div>`;
  if (suggestion.error) return `<div class="local-suggestions error"><small>${escapeHtml(suggestion.error)}</small><button type="button" data-action="native-suggestion-regenerate" data-workspace-action>Retry</button><button type="button" data-action="native-suggestion-cancel" data-workspace-action>Dismiss</button></div>`;
  if (!suggestion.values.length) return '';
  return `<div class="local-suggestions"><small>Local suggestions · tap to edit</small>${suggestion.values.map((value, index) => `<button type="button" class="local-suggestion-choice" data-action="native-suggestion-use" data-workspace-action data-suggestion-index="${index}">${escapeHtml(value)}</button>`).join('')}<button type="button" data-action="native-suggestion-regenerate" data-workspace-action>Regenerate</button><button type="button" class="quiet-button" data-action="native-suggestion-cancel" data-workspace-action>Dismiss</button></div>`;
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

function providerWorkDuration(item: ConversationItem): string {
  if (!item.startedAt || !item.completedAt) return '';
  const milliseconds = Date.parse(item.completedAt) - Date.parse(item.startedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function sameProviderActivity(left: ProviderActivity | null, right: ProviderActivity | null): boolean {
  return left?.label === right?.label && left?.elapsedSeconds === right?.elapsedSeconds && left?.observedAt === right?.observedAt;
}

export function providerActivityText(
  tool: string,
  activity: ProviderActivity | null,
  receivedAt: number,
  now = Date.now()
): string {
  if (!activity || !Number.isInteger(activity.elapsedSeconds) || activity.elapsedSeconds < 0 || !receivedAt) return '';
  const extraSeconds = Math.max(0, Math.floor((now - receivedAt) / 1_000));
  const totalSeconds = activity.elapsedSeconds + extraSeconds;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const duration = hours > 0 ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  const provider = tool ? `${tool.charAt(0).toUpperCase()}${tool.slice(1)}` : 'Agent';
  return `${provider} · ${activity.label} (${duration})`;
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

function decodePaneAnsi(value: string): Uint8Array {
  const binary = atob(value);
  let end = binary.length;
  while (end > 0 && ['\r', '\n'].includes(binary[end - 1])) end -= 1;
  const bytes: number[] = [];
  for (let index = 0; index < end; index += 1) {
    const byte = binary.charCodeAt(index);
    if (byte === 10 && (index === 0 || binary.charCodeAt(index - 1) !== 13)) bytes.push(13);
    bytes.push(byte);
  }
  bytes.push(27, 91, 63, 50, 53, 108);
  return Uint8Array.from(bytes);
}

function toLocalDateTimeValue(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function findWorkspaceSplit(node: WorkspaceNode, id: string): WorkspaceSplit | undefined {
  if (node.kind === 'pane') return undefined;
  return node.id === id ? node : findWorkspaceSplit(node.first, id) ?? findWorkspaceSplit(node.second, id);
}

function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function escapeAttr(value: string): string { return escapeHtml(value); }
