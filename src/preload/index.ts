import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppInfo,
  ClaudeIntegrationState,
  FileOperationResult,
  SettingsImportSelection,
  SettingsOperationResult,
  UpdaterState,
  WslDiscoveryResult
} from '../shared/app';
import type { CombinedLimitState } from '../shared/limits';
import type { FleetBridgeView, FleetDoctorResult } from '../shared/fleet-protocol';
import { IPC_CHANNELS } from '../shared/ipc';
import type { CodexProfileSettings, InteractionMode, SettingsLoadResult, WidgetSettings } from '../shared/settings';

const api = {
  getState: (): Promise<CombinedLimitState> => ipcRenderer.invoke(IPC_CHANNELS.getState),
  refreshNow: (): Promise<CombinedLimitState> => ipcRenderer.invoke(IPC_CHANNELS.refreshNow),
  getFleetState: (): Promise<FleetBridgeView> => ipcRenderer.invoke(IPC_CHANNELS.getFleetState),
  refreshFleet: (): Promise<FleetBridgeView> => ipcRenderer.invoke(IPC_CHANNELS.refreshFleet),
  openFleetSession: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.openFleetSession, sessionId),
  killFleetSession: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.killFleetSession, sessionId),
  renameFleetSession: (sessionId: string, name: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.renameFleetSession, sessionId, name),
  copyFleetAttachCommand: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.copyFleetAttachCommand, sessionId),
  toggleFleetFavorite: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.toggleFleetFavorite, sessionId),
  launchFleetFavorite: (presetId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.launchFleetFavorite, presetId),
  cancelFleetSchedule: (scheduleId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelFleetSchedule, scheduleId),
  createFleetContinueSchedule: (sessionId: string, deliverAt: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.createFleetContinueSchedule, sessionId, deliverAt),
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
    project: string,
    backend: 'linux' | 'windows',
    tool: 'shell' | 'codex' | 'claude' | 'copilot'
  ): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.createFleetSession, hostId, project, backend, tool),
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
  exportDiagnostics: (): Promise<FileOperationResult> => ipcRenderer.invoke(IPC_CHANNELS.exportDiagnostics),
  getUpdaterState: (): Promise<UpdaterState> => ipcRenderer.invoke(IPC_CHANNELS.getUpdaterState),
  checkForUpdates: (): Promise<UpdaterState | undefined> => ipcRenderer.invoke(IPC_CHANNELS.checkForUpdates),
  restartToUpdate: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.restartToUpdate),
  openReleasePage: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openReleasePage),
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
  onInteractionModeUpdated: (callback: (mode: InteractionMode) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: InteractionMode): void => callback(mode);
    ipcRenderer.on(IPC_CHANNELS.interactionModeUpdated, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.interactionModeUpdated, listener);
  },
  onUpdaterStateUpdated: (callback: (state: UpdaterState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdaterState): void => callback(state);
    ipcRenderer.on(IPC_CHANNELS.updaterStateUpdated, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.updaterStateUpdated, listener);
  }
};

contextBridge.exposeInMainWorld('limitsWidget', api);

export type LimitsWidgetApi = typeof api;
