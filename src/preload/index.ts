import { contextBridge, ipcRenderer } from 'electron';
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

const api = {
  getState: (): Promise<CombinedLimitState> => ipcRenderer.invoke(IPC_CHANNELS.getState),
  refreshNow: (): Promise<CombinedLimitState> => ipcRenderer.invoke(IPC_CHANNELS.refreshNow),
  getFleetState: (): Promise<FleetBridgeView> => ipcRenderer.invoke(IPC_CHANNELS.getFleetState),
  refreshFleet: (): Promise<FleetBridgeView> => ipcRenderer.invoke(IPC_CHANNELS.refreshFleet),
  openFleetSession: (sessionId: string, request?: WorkspaceOpenRequest): Promise<TerminalOpenResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.openFleetSession, sessionId, request),
  openFleetSessionExternal: (sessionId: string, target: 'vscode' | 'windowsTerminal'): Promise<TerminalOpenResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.openFleetSessionExternal, sessionId, target),
  listTerminalTabs: (): Promise<TerminalWorkspaceState> => ipcRenderer.invoke(IPC_CHANNELS.terminalList),
  bindTerminalTab: (tabId: string): Promise<TerminalTabDescriptor | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalBind, tabId),
  syncTerminalTabs: (tabIds: string[]): Promise<TerminalTabDescriptor[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalSyncBindings, tabIds),
  applyWorkspaceCommand: (command: WorkspaceCommand): Promise<TerminalWorkspaceState> =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalWorkspaceCommand, command),
  terminalInput: (tabId: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalInput, tabId, data),
  terminalResize: (tabId: string, columns: number, rows: number): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalResize, tabId, columns, rows),
  closeTerminalTab: (tabId: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.terminalClose, tabId),
  retryTerminalTab: (tabId: string): Promise<TerminalTabDescriptor | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalRetry, tabId),
  selectTerminalTab: (tabId: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.terminalSelect, tabId),
  setTerminalView: (tabId: string, viewMode: SessionViewMode): Promise<TerminalTabDescriptor | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalSetView, tabId, viewMode),
  startConversation: (tabId: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.conversationStart, tabId),
  stopConversation: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.conversationStop, tabId),
  syncConversations: (tabIds: string[]): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.conversationSync, tabIds),
  loadTerminalHistory: (tabId: string): Promise<NativeActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationHistory, tabId),
  pageConversation: (tabId: string, cursor: string): Promise<NativeActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationPage, tabId, cursor),
  approveConversation: (tabId: string, approval: string, choice: string, revision: string): Promise<NativeActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationApprove, tabId, approval, choice, revision),
  answerConversation: (tabId: string, question: string, revision: string, answers: ConversationAnswer[]): Promise<NativeActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationAnswer, tabId, question, revision, answers),
  stageAttachmentBytes: (tabId: string, name: string, mime: string, data: Uint8Array): Promise<StagedAttachment[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationStageBytes, tabId, name, mime, data),
  stageClipboardImage: (tabId: string): Promise<StagedAttachment[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationStageClipboard, tabId),
  chooseConversationAttachments: (tabId: string): Promise<StagedAttachment[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationChooseAttachments, tabId),
  removeConversationAttachment: (tabId: string, attachmentId: string): Promise<StagedAttachment[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationRemoveAttachment, tabId, attachmentId),
  sendConversationMessage: (tabId: string, text: string): Promise<NativeActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationSend, tabId, text),
  copyConversationText: (text: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationCopyText, text),
  getLocalSuggestionSettings: (): Promise<LocalSuggestionSettingsView> =>
    ipcRenderer.invoke(IPC_CHANNELS.localSuggestionsGetSettings),
  saveLocalSuggestionSettings: (settings: LocalSuggestionSettingsInput): Promise<LocalSuggestionOperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.localSuggestionsSaveSettings, settings),
  testLocalSuggestions: (): Promise<LocalSuggestionOperationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.localSuggestionsTest),
  chooseLocalSuggestionFile: (kind: 'executable' | 'model'): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.localSuggestionsChooseFile, kind),
  suggestLocalReplies: (request: LocalSuggestionRequest): Promise<LocalSuggestionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.localSuggestionsSuggest, request),
  cancelLocalSuggestions: (requestId?: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.localSuggestionsCancel, requestId),
  killFleetSession: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.killFleetSession, sessionId),
  renameFleetSession: (sessionId: string, name: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.renameFleetSession, sessionId, name),
  resetFleetSessionName: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.resetFleetSessionName, sessionId),
  getFleetSessionModel: (sessionId: string, includeCatalog = false): Promise<FleetModelControlResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.getFleetSessionModel, sessionId, includeCatalog),
  setFleetSessionModel: (
    sessionId: string, modelId: string, effortId: string, custom: boolean, expectedConfigRevision: string,
    historyImpactAcknowledged: boolean
  ): Promise<FleetModelControlResult> => ipcRenderer.invoke(
    IPC_CHANNELS.setFleetSessionModel, sessionId, modelId, effortId, custom, expectedConfigRevision, historyImpactAcknowledged
  ),
  cancelFleetSessionModel: (sessionId: string, expectedConfigRevision: string): Promise<FleetModelControlResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelFleetSessionModel, sessionId, expectedConfigRevision),
  copyFleetAttachCommand: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.copyFleetAttachCommand, sessionId),
  toggleFleetFavorite: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.toggleFleetFavorite, sessionId),
  launchFleetFavorite: (presetId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.launchFleetFavorite, presetId),
  cancelFleetSchedule: (scheduleId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelFleetSchedule, scheduleId),
  createFleetContinueSchedule: (sessionId: string, deliverAt: string, attentionId?: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.createFleetContinueSchedule, sessionId, deliverAt, attentionId),
  dismissFleetAttention: (attentionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.dismissFleetAttention, attentionId),
  updateFleetSchedule: (scheduleId: string, deliverAt: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.updateFleetSchedule, scheduleId, deliverAt),
  runFleetDoctor: (hostId: string): Promise<{ ok: boolean; message: string; doctor?: FleetDoctorResult }> =>
    ipcRenderer.invoke(IPC_CHANNELS.runFleetDoctor, hostId),
  updateFleetHost: (hostId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.updateFleetHost, hostId),
  pauseFleetNotifications: (): Promise<{ ok: boolean; message: string; settings: WidgetSettings }> =>
    ipcRenderer.invoke(IPC_CHANNELS.pauseFleetNotifications),
  createFleetSession: (
    hostId: string,
    label: string,
    backend: 'linux' | 'windows',
    tool: 'shell' | 'codex' | 'claude' | 'copilot',
    path: string,
    locationKind: 'project' | 'custom',
    request?: WorkspaceOpenRequest
  ): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.createFleetSession, hostId, label, backend, tool, path, locationKind, request),
  listFleetDirectory: (hostId: string, backend: 'linux' | 'windows', path: string): Promise<FleetDirectoryResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.listFleetDirectory, hostId, backend, path),
  createFleetDirectory: (hostId: string, backend: 'linux' | 'windows', parentPath: string, name: string): Promise<FleetDirectoryResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.createFleetDirectory, hostId, backend, parentPath, name),
  listFleetRepository: (sessionId: string, relativePath: string, includeHidden: boolean, cursor = ''): Promise<FleetRepositoryResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.listFleetRepository, sessionId, relativePath, includeHidden, cursor),
  searchFleetRepository: (sessionId: string, query: string, includeHidden: boolean): Promise<FleetRepositoryResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.searchFleetRepository, sessionId, query, includeHidden),
  startFleetDownload: (sessionId: string, relativePath: string, name: string, size: number): Promise<FleetDownloadResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.startFleetDownload, sessionId, relativePath, name, size),
  cancelFleetDownload: (jobId: string): Promise<FleetDownloadResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelFleetDownload, jobId),
  openFleetDownload: (jobId: string): Promise<FleetDownloadResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.openFleetDownload, jobId),
  openFleetDownloadFolder: (jobId: string): Promise<FleetDownloadResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.openFleetDownloadFolder, jobId),
  createFleetPairingInvitation: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.createFleetPairingInvitation),
  reviewFleetPairing: (requestId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.reviewFleetPairing, requestId),
  getSettings: (): Promise<SettingsLoadResult> => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  saveSettings: (settings: WidgetSettings): Promise<SettingsLoadResult> => ipcRenderer.invoke(IPC_CHANNELS.saveSettings, settings),
  testCodexProfile: (profile: CodexProfileSettings): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.testCodexProfile, profile),
  discoverWsl: (): Promise<WslDiscoveryResult> => ipcRenderer.invoke(IPC_CHANNELS.discoverWsl),
  previewSettingsImport: (): Promise<SettingsImportSelection | null> => ipcRenderer.invoke(IPC_CHANNELS.previewSettingsImport),
  applySettingsImport: (token: string): Promise<SettingsLoadResult> => ipcRenderer.invoke(IPC_CHANNELS.applySettingsImport, token),
  exportSettings: (): Promise<FileOperationResult> => ipcRenderer.invoke(IPC_CHANNELS.exportSettings),
  rollbackSettings: (): Promise<SettingsOperationResult> => ipcRenderer.invoke(IPC_CHANNELS.rollbackSettings),
  getClaudeIntegration: (): Promise<ClaudeIntegrationState> => ipcRenderer.invoke(IPC_CHANNELS.getClaudeIntegration),
  installClaudeIntegration: (): Promise<ClaudeIntegrationState> => ipcRenderer.invoke(IPC_CHANNELS.installClaudeIntegration),
  removeClaudeIntegration: (): Promise<ClaudeIntegrationState> => ipcRenderer.invoke(IPC_CHANNELS.removeClaudeIntegration),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getDiagnostics: (): Promise<LayeredDiagnosticReport> => ipcRenderer.invoke(IPC_CHANNELS.getDiagnostics),
  exportDiagnostics: (): Promise<FileOperationResult> => ipcRenderer.invoke(IPC_CHANNELS.exportDiagnostics),
  getUpdaterState: (): Promise<UpdaterState> => ipcRenderer.invoke(IPC_CHANNELS.getUpdaterState),
  checkForUpdates: (): Promise<UpdaterState | undefined> => ipcRenderer.invoke(IPC_CHANNELS.checkForUpdates),
  restartToUpdate: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.restartToUpdate),
  openReleasePage: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openReleasePage),
  getRuntimeState: (): Promise<WslRuntimeState> => ipcRenderer.invoke(IPC_CHANNELS.getRuntimeState),
  repairRuntime: (): Promise<WslRuntimeState> => ipcRenderer.invoke(IPC_CHANNELS.repairRuntime),
  rollbackRuntime: (): Promise<WslRuntimeState> => ipcRenderer.invoke(IPC_CHANNELS.rollbackRuntime),
  openSettings: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openSettings),
  getInteractionMode: (): Promise<InteractionMode> => ipcRenderer.invoke(IPC_CHANNELS.getInteractionMode),
  setInteractionMode: (mode: InteractionMode): Promise<InteractionMode> => ipcRenderer.invoke(IPC_CHANNELS.setInteractionMode, mode),
  hide: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.windowHide),
  quit: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.windowQuit),
  onStateUpdated: (callback: (state: CombinedLimitState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: CombinedLimitState): void => callback(state);
    ipcRenderer.on(IPC_CHANNELS.stateUpdated, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.stateUpdated, listener);
  },
  onFleetStateUpdated: (callback: (state: FleetBridgeView) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: FleetBridgeView): void => callback(state);
    ipcRenderer.on(IPC_CHANNELS.fleetStateUpdated, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.fleetStateUpdated, listener);
  },
  onFleetDownloadUpdated: (callback: (job: FleetDownloadJob) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, job: FleetDownloadJob): void => callback(job);
    ipcRenderer.on(IPC_CHANNELS.fleetDownloadUpdated, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.fleetDownloadUpdated, listener);
  },
  onInteractionModeUpdated: (callback: (mode: InteractionMode) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: InteractionMode): void => callback(mode);
    ipcRenderer.on(IPC_CHANNELS.interactionModeUpdated, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.interactionModeUpdated, listener);
  },
  onUpdaterStateUpdated: (callback: (state: UpdaterState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdaterState): void => callback(state);
    ipcRenderer.on(IPC_CHANNELS.updaterStateUpdated, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.updaterStateUpdated, listener);
  },
  onTerminalData: (callback: (event: TerminalDataEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: TerminalDataEvent): void => callback(value);
    ipcRenderer.on(IPC_CHANNELS.terminalData, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.terminalData, listener);
  },
  onTerminalStatus: (callback: (event: TerminalStatusEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: TerminalStatusEvent): void => callback(value);
    ipcRenderer.on(IPC_CHANNELS.terminalStatus, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.terminalStatus, listener);
  },
  onTerminalClosed: (callback: (event: TerminalClosedEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: TerminalClosedEvent): void => callback(value);
    ipcRenderer.on(IPC_CHANNELS.terminalClosed, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.terminalClosed, listener);
  },
  onTerminalOpened: (callback: (tab: TerminalTabDescriptor) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: TerminalTabDescriptor): void => callback(value);
    ipcRenderer.on(IPC_CHANNELS.terminalOpened, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.terminalOpened, listener);
  },
  onWorkspaceUpdated: (callback: (state: TerminalWorkspaceState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: TerminalWorkspaceState): void => callback(value);
    ipcRenderer.on(IPC_CHANNELS.terminalWorkspaceUpdated, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.terminalWorkspaceUpdated, listener);
  },
  onConversationEvent: (callback: (event: ConversationEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: ConversationEvent): void => callback(value);
    ipcRenderer.on(IPC_CHANNELS.conversationEvent, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.conversationEvent, listener);
  },
  onLocalSuggestionSettingsUpdated: (callback: (settings: LocalSuggestionSettingsView) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: LocalSuggestionSettingsView): void => callback(value);
    ipcRenderer.on(IPC_CHANNELS.localSuggestionsSettingsUpdated, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.localSuggestionsSettingsUpdated, listener);
  }
};

contextBridge.exposeInMainWorld('limitsWidget', api);

export type LimitsWidgetApi = typeof api;
