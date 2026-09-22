import { contextBridge, ipcRenderer } from 'electron';
import type { FleetConnectRequest, FleetConnectResult } from '../shared/fleet-connect';
import type {
  AppInfo,
  ClaudeIntegrationState,
  FileOperationResult,
  FleetDirectoryResult,
  FleetModelControlResult,
  FleetDownloadJob,
  FleetDownloadResult,
  FleetRepositoryResult,
  SettingsImportSelection,
  SettingsOperationResult,
  UpdaterState,
  WslDiscoveryResult
} from '../shared/app';
import type { CombinedLimitState } from '../shared/limits';
import type { FleetBridgeView, FleetDoctorResult } from '../shared/fleet-protocol';
import { IPC_CHANNELS } from '../shared/ipc';
import type { CodexProfileSettings, InteractionMode, SettingsLoadResult, WidgetSettings } from '../shared/settings';
import type {
  SessionViewMode, TerminalClosedEvent, TerminalDataEvent, TerminalOpenResult,
  TerminalStatusEvent, TerminalTabDescriptor, TerminalWorkspaceState
} from '../shared/terminal';
import type { WorkspaceCommand, WorkspaceOpenRequest } from '../shared/workspace-layout';
import type {
  ConversationAnswer, ConversationEvent, NativeActionResult, StagedAttachment
} from '../shared/conversation';
import type {
  LocalSuggestionOperationResult, LocalSuggestionRequest, LocalSuggestionResult,
  LocalSuggestionSettingsInput, LocalSuggestionSettingsView
} from '../shared/local-suggestions';
import type { WslRuntimeState } from '../shared/runtime';
import type { LayeredDiagnosticReport } from '../shared/layered-diagnostics';
import type { FleetNotificationTarget } from '../shared/notification';
import { assertIpcEventPayload, assertIpcPayload } from '../shared/ipc-validation';

function invoke<Result>(channel: string, ...args: unknown[]): Promise<Result> {
  assertIpcPayload(channel, args);
  return ipcRenderer.invoke(channel, ...args) as Promise<Result>;
}

function subscribe<Value>(channel: string, callback: (value: Value) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: Value): void => {
    try {
      assertIpcEventPayload(channel, value);
    } catch {
      return;
    }
    callback(value);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api = {
  connectFleetHost: (request: FleetConnectRequest): Promise<FleetConnectResult> => invoke(IPC_CHANNELS.connectFleetHost, request),
  getState: (): Promise<CombinedLimitState> => invoke(IPC_CHANNELS.getState),
  refreshNow: (): Promise<CombinedLimitState> => invoke(IPC_CHANNELS.refreshNow),
  getFleetState: (): Promise<FleetBridgeView> => invoke(IPC_CHANNELS.getFleetState),
  refreshFleet: (): Promise<FleetBridgeView> => invoke(IPC_CHANNELS.refreshFleet),
  openFleetSession: (sessionId: string, request?: WorkspaceOpenRequest): Promise<TerminalOpenResult> =>
    invoke(IPC_CHANNELS.openFleetSession, sessionId, request),
  openFleetSessionExternal: (sessionId: string, target: 'vscode' | 'windowsTerminal'): Promise<TerminalOpenResult> =>
    invoke(IPC_CHANNELS.openFleetSessionExternal, sessionId, target),
  openExternalLink: (url: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.openExternalLink, url),
  listTerminalTabs: (): Promise<TerminalWorkspaceState> => invoke(IPC_CHANNELS.terminalList),
  bindTerminalTab: (tabId: string): Promise<TerminalTabDescriptor | null> =>
    invoke(IPC_CHANNELS.terminalBind, tabId),
  syncTerminalTabs: (tabIds: string[]): Promise<TerminalTabDescriptor[]> =>
    invoke(IPC_CHANNELS.terminalSyncBindings, tabIds),
  applyWorkspaceCommand: (command: WorkspaceCommand): Promise<TerminalWorkspaceState> =>
    invoke(IPC_CHANNELS.terminalWorkspaceCommand, command),
  terminalInput: (tabId: string, data: string): Promise<boolean> =>
    invoke(IPC_CHANNELS.terminalInput, tabId, data),
  terminalResize: (tabId: string, columns: number, rows: number): Promise<boolean> =>
    invoke(IPC_CHANNELS.terminalResize, tabId, columns, rows),
  closeTerminalTab: (tabId: string): Promise<boolean> => invoke(IPC_CHANNELS.terminalClose, tabId),
  retryTerminalTab: (tabId: string): Promise<TerminalTabDescriptor | null> =>
    invoke(IPC_CHANNELS.terminalRetry, tabId),
  selectTerminalTab: (tabId: string): Promise<boolean> => invoke(IPC_CHANNELS.terminalSelect, tabId),
  setTerminalView: (tabId: string, viewMode: SessionViewMode): Promise<TerminalTabDescriptor | null> =>
    invoke(IPC_CHANNELS.terminalSetView, tabId, viewMode),
  startConversation: (tabId: string, view: 'conversation' | 'detailed' = 'conversation'): Promise<boolean> => invoke(IPC_CHANNELS.conversationStart, tabId, view),
  stopConversation: (tabId: string): Promise<void> => invoke(IPC_CHANNELS.conversationStop, tabId),
  syncConversations: (tabIds: string[], view: 'conversation' | 'detailed' = 'conversation'): Promise<string[]> => invoke(IPC_CHANNELS.conversationSync, tabIds, view),
  loadTerminalHistory: (tabId: string): Promise<NativeActionResult> =>
    invoke(IPC_CHANNELS.conversationHistory, tabId),
  pageConversation: (tabId: string, cursor: string): Promise<NativeActionResult> =>
    invoke(IPC_CHANNELS.conversationPage, tabId, cursor),
  cancelConversationRead: (tabId: string): Promise<void> => invoke(IPC_CHANNELS.conversationCancelRead, tabId),
  conversationActivity: (tabId: string, turnId: string, cursor: string): Promise<NativeActionResult> =>
    invoke(IPC_CHANNELS.conversationActivity, tabId, turnId, cursor),
  approveConversation: (tabId: string, approval: string, choice: string, revision: string, eventPosition: number): Promise<NativeActionResult> =>
    invoke(IPC_CHANNELS.conversationApprove, tabId, approval, choice, revision, eventPosition),
  answerConversation: (tabId: string, question: string, revision: string, eventPosition: number, answers: ConversationAnswer[]): Promise<NativeActionResult> =>
    invoke(IPC_CHANNELS.conversationAnswer, tabId, question, revision, eventPosition, answers),
  stageAttachmentBytes: (tabId: string, name: string, mime: string, data: Uint8Array): Promise<StagedAttachment[]> =>
    invoke(IPC_CHANNELS.conversationStageBytes, tabId, name, mime, data),
  stageClipboardImage: (tabId: string): Promise<StagedAttachment[]> =>
    invoke(IPC_CHANNELS.conversationStageClipboard, tabId),
  chooseConversationAttachments: (tabId: string): Promise<StagedAttachment[]> =>
    invoke(IPC_CHANNELS.conversationChooseAttachments, tabId),
  removeConversationAttachment: (tabId: string, attachmentId: string): Promise<StagedAttachment[]> =>
    invoke(IPC_CHANNELS.conversationRemoveAttachment, tabId, attachmentId),
  sendConversationMessage: (tabId: string, text: string): Promise<NativeActionResult> =>
    invoke(IPC_CHANNELS.conversationSend, tabId, text),
  copyConversationText: (text: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.conversationCopyText, text),
  getLocalSuggestionSettings: (): Promise<LocalSuggestionSettingsView> =>
    invoke(IPC_CHANNELS.localSuggestionsGetSettings),
  saveLocalSuggestionSettings: (settings: LocalSuggestionSettingsInput): Promise<LocalSuggestionOperationResult> =>
    invoke(IPC_CHANNELS.localSuggestionsSaveSettings, settings),
  testLocalSuggestions: (): Promise<LocalSuggestionOperationResult> =>
    invoke(IPC_CHANNELS.localSuggestionsTest),
  chooseLocalSuggestionFile: (kind: 'executable' | 'model'): Promise<string | null> =>
    invoke(IPC_CHANNELS.localSuggestionsChooseFile, kind),
  suggestLocalReplies: (request: LocalSuggestionRequest): Promise<LocalSuggestionResult> =>
    invoke(IPC_CHANNELS.localSuggestionsSuggest, request),
  cancelLocalSuggestions: (requestId?: string): Promise<void> =>
    invoke(IPC_CHANNELS.localSuggestionsCancel, requestId),
  killFleetSession: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.killFleetSession, sessionId),
  renameFleetSession: (sessionId: string, name: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.renameFleetSession, sessionId, name),
  resetFleetSessionName: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.resetFleetSessionName, sessionId),
  getFleetSessionModel: (sessionId: string, includeCatalog = false): Promise<FleetModelControlResult> =>
    invoke(IPC_CHANNELS.getFleetSessionModel, sessionId, includeCatalog),
  setFleetSessionModel: (
    sessionId: string, modelId: string, effortId: string, custom: boolean, expectedConfigRevision: string,
    historyImpactAcknowledged: boolean
  ): Promise<FleetModelControlResult> => invoke(
    IPC_CHANNELS.setFleetSessionModel, sessionId, modelId, effortId, custom, expectedConfigRevision, historyImpactAcknowledged
  ),
  cancelFleetSessionModel: (sessionId: string, expectedConfigRevision: string): Promise<FleetModelControlResult> =>
    invoke(IPC_CHANNELS.cancelFleetSessionModel, sessionId, expectedConfigRevision),
  copyFleetAttachCommand: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.copyFleetAttachCommand, sessionId),
  toggleFleetFavorite: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.toggleFleetFavorite, sessionId),
  launchFleetFavorite: (presetId: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.launchFleetFavorite, presetId),
  cancelFleetSchedule: (scheduleId: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.cancelFleetSchedule, scheduleId),
  createFleetContinueSchedule: (sessionId: string, deliverAt: string, attentionId?: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.createFleetContinueSchedule, sessionId, deliverAt, attentionId),
  dismissFleetAttention: (attentionId: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.dismissFleetAttention, attentionId),
  updateFleetSchedule: (scheduleId: string, deliverAt: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.updateFleetSchedule, scheduleId, deliverAt),
  runFleetDoctor: (hostId: string): Promise<{ ok: boolean; message: string; doctor?: FleetDoctorResult }> =>
    invoke(IPC_CHANNELS.runFleetDoctor, hostId),
  updateFleetHost: (hostId: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.updateFleetHost, hostId),
  pauseFleetNotifications: (): Promise<{ ok: boolean; message: string; settings: WidgetSettings }> =>
    invoke(IPC_CHANNELS.pauseFleetNotifications),
  createFleetSession: (
    hostId: string,
    label: string,
    backend: 'linux' | 'windows',
    tool: 'shell' | 'codex' | 'claude' | 'copilot',
    path: string,
    locationKind: 'project' | 'custom',
    request?: WorkspaceOpenRequest
  ): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.createFleetSession, hostId, label, backend, tool, path, locationKind, request),
  listFleetDirectory: (hostId: string, backend: 'linux' | 'windows', path: string): Promise<FleetDirectoryResult> =>
    invoke(IPC_CHANNELS.listFleetDirectory, hostId, backend, path),
  createFleetDirectory: (hostId: string, backend: 'linux' | 'windows', parentPath: string, name: string): Promise<FleetDirectoryResult> =>
    invoke(IPC_CHANNELS.createFleetDirectory, hostId, backend, parentPath, name),
  listFleetRepository: (sessionId: string, relativePath: string, includeHidden: boolean, cursor = ''): Promise<FleetRepositoryResult> =>
    invoke(IPC_CHANNELS.listFleetRepository, sessionId, relativePath, includeHidden, cursor),
  searchFleetRepository: (sessionId: string, query: string, includeHidden: boolean): Promise<FleetRepositoryResult> =>
    invoke(IPC_CHANNELS.searchFleetRepository, sessionId, query, includeHidden),
  startFleetDownload: (sessionId: string, relativePath: string, name: string, size: number): Promise<FleetDownloadResult> =>
    invoke(IPC_CHANNELS.startFleetDownload, sessionId, relativePath, name, size),
  cancelFleetDownload: (jobId: string): Promise<FleetDownloadResult> =>
    invoke(IPC_CHANNELS.cancelFleetDownload, jobId),
  openFleetDownload: (jobId: string): Promise<FleetDownloadResult> =>
    invoke(IPC_CHANNELS.openFleetDownload, jobId),
  openFleetDownloadFolder: (jobId: string): Promise<FleetDownloadResult> =>
    invoke(IPC_CHANNELS.openFleetDownloadFolder, jobId),
  createFleetPairingInvitation: (): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.createFleetPairingInvitation),
  reviewFleetPairing: (requestId: string): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.reviewFleetPairing, requestId),
  getSettings: (): Promise<SettingsLoadResult> => invoke(IPC_CHANNELS.getSettings),
  saveSettings: (settings: WidgetSettings): Promise<SettingsLoadResult> => invoke(IPC_CHANNELS.saveSettings, settings),
  testCodexProfile: (profile: CodexProfileSettings): Promise<{ ok: boolean; message: string }> =>
    invoke(IPC_CHANNELS.testCodexProfile, profile),
  discoverWsl: (): Promise<WslDiscoveryResult> => invoke(IPC_CHANNELS.discoverWsl),
  previewSettingsImport: (): Promise<SettingsImportSelection | null> => invoke(IPC_CHANNELS.previewSettingsImport),
  applySettingsImport: (token: string): Promise<SettingsLoadResult> => invoke(IPC_CHANNELS.applySettingsImport, token),
  exportSettings: (): Promise<FileOperationResult> => invoke(IPC_CHANNELS.exportSettings),
  rollbackSettings: (): Promise<SettingsOperationResult> => invoke(IPC_CHANNELS.rollbackSettings),
  getClaudeIntegration: (): Promise<ClaudeIntegrationState> => invoke(IPC_CHANNELS.getClaudeIntegration),
  installClaudeIntegration: (): Promise<ClaudeIntegrationState> => invoke(IPC_CHANNELS.installClaudeIntegration),
  removeClaudeIntegration: (): Promise<ClaudeIntegrationState> => invoke(IPC_CHANNELS.removeClaudeIntegration),
  getAppInfo: (): Promise<AppInfo> => invoke(IPC_CHANNELS.getAppInfo),
  getDiagnostics: (): Promise<LayeredDiagnosticReport> => invoke(IPC_CHANNELS.getDiagnostics),
  exportDiagnostics: (): Promise<FileOperationResult> => invoke(IPC_CHANNELS.exportDiagnostics),
  getUpdaterState: (): Promise<UpdaterState> => invoke(IPC_CHANNELS.getUpdaterState),
  checkForUpdates: (): Promise<UpdaterState | undefined> => invoke(IPC_CHANNELS.checkForUpdates),
  restartToUpdate: (): Promise<void> => invoke(IPC_CHANNELS.restartToUpdate),
  openReleasePage: (): Promise<void> => invoke(IPC_CHANNELS.openReleasePage),
  getRuntimeState: (): Promise<WslRuntimeState> => invoke(IPC_CHANNELS.getRuntimeState),
  repairRuntime: (): Promise<WslRuntimeState> => invoke(IPC_CHANNELS.repairRuntime),
  rollbackRuntime: (): Promise<WslRuntimeState> => invoke(IPC_CHANNELS.rollbackRuntime),
  openSettings: (): Promise<void> => invoke(IPC_CHANNELS.openSettings),
  getInteractionMode: (): Promise<InteractionMode> => invoke(IPC_CHANNELS.getInteractionMode),
  setInteractionMode: (mode: InteractionMode): Promise<InteractionMode> => invoke(IPC_CHANNELS.setInteractionMode, mode),
  hide: (): Promise<void> => invoke(IPC_CHANNELS.windowHide),
  quit: (): Promise<void> => invoke(IPC_CHANNELS.windowQuit),
  onStateUpdated: (callback: (state: CombinedLimitState) => void): (() => void) =>
    subscribe(IPC_CHANNELS.stateUpdated, callback),
  onFleetStateUpdated: (callback: (state: FleetBridgeView) => void): (() => void) =>
    subscribe(IPC_CHANNELS.fleetStateUpdated, callback),
  onFleetNotificationTarget: (callback: (target: FleetNotificationTarget) => void): (() => void) =>
    subscribe(IPC_CHANNELS.fleetNotificationTarget, callback),
  onFleetDownloadUpdated: (callback: (job: FleetDownloadJob) => void): (() => void) =>
    subscribe(IPC_CHANNELS.fleetDownloadUpdated, callback),
  onInteractionModeUpdated: (callback: (mode: InteractionMode) => void): (() => void) =>
    subscribe(IPC_CHANNELS.interactionModeUpdated, callback),
  onUpdaterStateUpdated: (callback: (state: UpdaterState) => void): (() => void) =>
    subscribe(IPC_CHANNELS.updaterStateUpdated, callback),
  onTerminalData: (callback: (event: TerminalDataEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.terminalData, callback),
  onTerminalStatus: (callback: (event: TerminalStatusEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.terminalStatus, callback),
  onTerminalClosed: (callback: (event: TerminalClosedEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.terminalClosed, callback),
  onTerminalOpened: (callback: (tab: TerminalTabDescriptor) => void): (() => void) =>
    subscribe(IPC_CHANNELS.terminalOpened, callback),
  onWorkspaceUpdated: (callback: (state: TerminalWorkspaceState) => void): (() => void) =>
    subscribe(IPC_CHANNELS.terminalWorkspaceUpdated, callback),
  onConversationEvent: (callback: (event: ConversationEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.conversationEvent, callback),
  onLocalSuggestionSettingsUpdated: (callback: (settings: LocalSuggestionSettingsView) => void): (() => void) =>
    subscribe(IPC_CHANNELS.localSuggestionsSettingsUpdated, callback)
};

contextBridge.exposeInMainWorld('limitsWidget', api);

export type LimitsWidgetApi = typeof api;
