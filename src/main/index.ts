import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerSaveBlocker,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type Rectangle
} from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { IPC_CHANNELS } from '../shared/ipc';
import type { AppInfo, SettingsImportSelection, UpdaterState } from '../shared/app';
import type { CombinedLimitState } from '../shared/limits';
import type { CodexProfileSettings, InteractionMode, SettingsLoadResult, WidgetSettings } from '../shared/settings';
import { cloneSettings, createDefaultSettings, normalizeSettings } from '../shared/settings';
import { getWidgetDataDir, migrateLegacyData } from './app-paths';
import {
  ensureClaudeStatusLineInstalled,
  getClaudeStatusLinePaths,
  inspectClaudeStatusLineInstallation,
  removeClaudeStatusLine
} from './claude-statusline-install';
import { collectCodexProfileLimits, type WslCodexProfile } from './collectors/codex';
import { createDiagnosticsReport, writeDiagnosticsArchive } from './diagnostics';
import { setLaunchOnLogin } from './launch-on-login';
import { configureLogger } from './logger';
import {
  applyImportedSettings,
  createSettingsExport,
  getSettingsPath,
  loadSettings,
  MAX_SETTINGS_IMPORT_BYTES,
  parseSettingsImport,
  rollbackLatestSettings,
  saveSettings
} from './settings-store';
import { readFileSnapshot } from './durable-file';
import { LimitStateManager } from './state-manager';
import { FleetBridgeSupervisor, FleetMutationError, fleetBridgeLaunchFromSettings } from './fleet-bridge';
import { isRetryableFleetErrorCode } from '../shared/fleet-errors';
import { openFleetTerminal, openFleetVscode } from './fleet-terminal';
import { TerminalManager } from './terminal-manager';
import { runPackagedTerminalSmoke } from './terminal-smoke';
import { ConversationManager } from './conversation-manager';
import type { SessionViewMode, TerminalOpenResult } from '../shared/terminal';
import type { WorkspaceCommand, WorkspaceOpenRequest } from '../shared/workspace-layout';
import type { FleetBridgeView, FleetDoctorResult } from '../shared/fleet-protocol';
import { FleetDownloadManager } from './fleet-download';
import { UpdaterManager } from './updater';
import { applyInteractionMode } from './window-mode';
import { loadWindowBounds, loadWindowPosition, saveWindowBounds, saveWindowPosition } from './window-state';
import { discoverWslProfiles } from './wsl-discovery';
import { DownloadPowerPolicy } from './download-power-policy';
import { isFleetSessionAvailable, sessionIdentityPresentation } from '../shared/fleet';
import type { LocalSuggestionSettingsInput } from '../shared/local-suggestions';
import { LocalSuggestionStore } from './local-suggestion-store';
import { LocalSuggestionManager } from './local-suggestion-manager';
import { WslRuntimeManager } from './wsl-runtime-manager';
import { FleetConfigurationStore } from './fleet-configuration-store';
import { FleetReleaseSetAuthority } from './release-set-authority';
import { WslProcessOwnership } from './wsl-process-ownership';
import { awaitBoundedShutdown, RuntimeLifecycleCoordinator } from './runtime-lifecycle';
import type { WslRuntimeState } from '../shared/runtime';
import { assertIpcPayload } from '../shared/ipc-validation';
import {
  RendererAccessPolicy,
  allowedRendererRoles,
  type RendererContentKind,
  type RendererRole
} from './renderer-access-policy';
import { FLEET_NOTIFICATION_PAUSE_MS, FleetNotificationTracker } from './fleet-notification-tracker';
import { routeExternalLink } from './external-link-router';
import type { FleetNotificationTarget } from '../shared/notification';

const APP_ID = 'com.yaakovch.ailimitswidget';
const PRODUCT_NAME = 'Agent Fleet';
const RELEASE_URL = 'https://github.com/yaakovch/agent-fleet/releases/latest';
const dataDirectory = getWidgetDataDir();

app.setName(PRODUCT_NAME);
app.setAppUserModelId(APP_ID);
app.setPath('userData', dataDirectory);

const isUninstallCleanup = process.argv.includes('--uninstall-cleanup');
const isCpuSmoke = process.env.AGENT_FLEET_ENABLE_CPU_SMOKE === '1' && process.argv.includes('--agent-fleet-cpu-smoke');
const terminalSmokeCandidate = process.env.AGENT_FLEET_ENABLE_TERMINAL_SMOKE === '1'
  ? process.argv.find((value) => value.startsWith('--agent-fleet-terminal-smoke='))?.slice('--agent-fleet-terminal-smoke='.length)
  : undefined;
const terminalSmokePath = terminalSmokeCandidate
  && basename(terminalSmokeCandidate) === 'terminal-smoke.json'
  && resolve(dirname(terminalSmokeCandidate)) === resolve(dataDirectory)
  ? terminalSmokeCandidate : undefined;
const powerSmokeCandidate = process.env.AGENT_FLEET_ENABLE_POWER_SMOKE === '1'
  ? process.argv.find((value) => value.startsWith('--agent-fleet-power-smoke='))?.slice('--agent-fleet-power-smoke='.length)
  : undefined;
const powerSmokePath = powerSmokeCandidate
  && basename(powerSmokeCandidate) === 'power-smoke.json'
  && resolve(dirname(powerSmokeCandidate)) === resolve(dataDirectory)
  ? powerSmokeCandidate : undefined;
const hasSingleInstanceLock = isUninstallCleanup || isCpuSmoke || Boolean(terminalSmokePath) || Boolean(powerSmokePath) || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

const migrationResult = migrateLegacyData(dataDirectory);
let settingsLoadResult = loadSettings(getSettingsPath(dataDirectory));
let appSettings = settingsLoadResult.settings;
const logger = configureLogger(dataDirectory);
const stateManager = new LimitStateManager({
  settings: appSettings,
  settingsDiagnostic: settingsLoadResult.recovered ? settingsLoadResult.message : undefined
});
const wslProcessOwnership = new WslProcessOwnership();
const rendererAccess = new RendererAccessPolicy();
const fleetConfigurationStore = new FleetConfigurationStore(join(dataDirectory, 'fleet-configuration'));
const releaseSetAuthority = new FleetReleaseSetAuthority({
  resourcesRoot: join(getResourceRoot(), 'resources'),
  dataRoot: dataDirectory,
  legacyPolicy: 'allow-unconfigured',
  configurationStore: fleetConfigurationStore
});
const wslRuntimeManager = new WslRuntimeManager({
  resourcesRoot: join(getResourceRoot(), 'resources'),
  distro: () => fleetBridgeLaunchFromSettings(appSettings).distro,
  windowsVersion: () => app.getVersion(),
  releaseSetAuthority
});
let fleetBridge = createFleetBridge();
const runtimeLifecycle = new RuntimeLifecycleCoordinator({
  bridge: () => fleetBridge,
  runtimeState: () => wslRuntimeManager.getState()
});
let terminalRestored = false;
const terminalManager = new TerminalManager({
  statePath: join(dataDirectory, 'terminal-workspace-v2.json'),
  legacyStatePath: join(dataDirectory, 'terminal-workspace-v1.json'),
  logger,
  getDistro: () => fleetBridgeLaunchFromSettings(appSettings).distro,
  resolveSession: (sessionId) => getFleetView().snapshot.sessions.find((session) => session.id === sessionId),
  isHostAvailable: (hostId) => {
    const snapshot = getFleetView().snapshot;
    return snapshot.controller.status === 'healthy'
      && snapshot.hosts.some((host) => host.id === hostId && host.status === 'healthy');
  },
  onData: (event) => sendContent(IPC_CHANNELS.terminalData, event, 'terminal', event.tabId),
  onStatus: (event) => sendTabContent(IPC_CHANNELS.terminalStatus, event, event.tab.id),
  onClosed: (event) => {
    sendTabContent(IPC_CHANNELS.terminalClosed, event, event.tabId);
    rendererAccess.revokeTab(event.tabId);
    conversationManager.close(event.tabId);
  },
  onWorkspace: (state) => sendDashboard(IPC_CHANNELS.terminalWorkspaceUpdated, state),
  processOwnership: wslProcessOwnership
});
const conversationManager = new ConversationManager({
  tempPath: join(app.getPath('temp'), 'agent-fleet-attachments'),
  logger,
  getDistro: () => fleetBridgeLaunchFromSettings(appSettings).distro,
  resolveTab: (tabId) => terminalManager.list().find((tab) => tab.id === tabId),
  sendTerminalInput: (tabId, data) => terminalManager.input(tabId, data),
  onEvent: (event) => sendContent(IPC_CHANNELS.conversationEvent, event, 'conversation', event.tabId),
  processOwnership: wslProcessOwnership
});
const localSuggestionStore = new LocalSuggestionStore(
  join(dataDirectory, 'local-suggestions-v1.json'),
  {
    encrypt: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable; leave the bearer token empty.');
      return safeStorage.encryptString(value).toString('base64');
    },
    decrypt: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    }
  }
);
const localSuggestionManager = new LocalSuggestionManager(localSuggestionStore);
const downloadPowerPolicy = new DownloadPowerPolicy(powerSaveBlocker);
const fleetDownloadManager = new FleetDownloadManager({
  distro: () => fleetBridgeLaunchFromSettings(appSettings).distro,
  downloadsDirectory: () => app.getPath('downloads'),
  onUpdate: (job) => {
    downloadPowerPolicy.update(job);
    sendDashboard(IPC_CHANNELS.fleetDownloadUpdated, job);
  },
  onComplete: () => {
    if (Notification.isSupported()) showFleetNotification('Download complete', 'A verified repository download is ready.');
  },
  processOwnership: wslProcessOwnership
});

let mainWindow: BrowserWindow | null = null;
let dashboardWindow: BrowserWindow | null = null;
let dashboardSaveTimer: NodeJS.Timeout | null = null;
let settingsWindow: BrowserWindow | null = null;
let settingsWindowView: 'settings' | 'onboarding' = 'settings';
let tray: Tray | null = null;
let updater: UpdaterManager | null = null;
let isQuitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;
let interactionMode: InteractionMode = 'passive';
const pendingImports = new Map<string, WidgetSettings>();
const fleetNotificationTracker = new FleetNotificationTracker();
const lastDoctorResults = new Map<string, FleetDoctorResult>();

function createFleetBridge(): FleetBridgeSupervisor {
  const bridge = new FleetBridgeSupervisor({
    cachePath: join(dataDirectory, 'fleet-cache-v1.json'),
    launch: fleetBridgeLaunchFromSettings(appSettings),
    logger,
    processOwnership: wslProcessOwnership
  });
  if (!appSettings.automaticSessionTitles) bridge.purgeSessionTitles();
  bridge.on('changed', () => {
    const view = getFleetView();
    if (!terminalRestored && view.status === 'live') {
      terminalRestored = true;
      try {
        const restored = terminalManager.restore();
        logger.info('Embedded workspace restored', restored.length, 'pane(s)');
      } catch (error) {
        terminalRestored = false;
        logger.error('Embedded workspace restore failed; retrying on the next fleet update', error);
      }
    } else if (terminalRestored) {
      const reconnected = terminalManager.reconcileSessions();
      if (reconnected) logger.info('Reconnected restored workspace sessions', reconnected);
    }
    sendDashboard(IPC_CHANNELS.fleetStateUpdated, view);
    processFleetNotifications(view);
    updateTrayMenu();
    updateTrayTooltip();
  });
  return bridge;
}

function getFleetView(): FleetBridgeView {
  const view = fleetBridge.getView();
  view.snapshot.limits = stateManager.getState().providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    fiveHourRemaining: provider.windows.fiveHour?.remainingPercent ?? null,
    weeklyRemaining: provider.windows.weekly?.remainingPercent ?? null,
    resetsAt: provider.windows.fiveHour?.resetsAt ? new Date(provider.windows.fiveHour.resetsAt * 1000).toISOString() : null,
    status: provider.status === 'ok' ? 'ok' : provider.status === 'stale' ? 'stale' : 'error'
  }));
  return view;
}

async function pauseFleetNotifications(): Promise<{ ok: true; message: string; settings: WidgetSettings }> {
  const until = new Date(Date.now() + FLEET_NOTIFICATION_PAUSE_MS).toISOString();
  const result = await applyAndPersistSettings({ ...cloneSettings(appSettings), notificationPauseUntil: until });
  return { ok: true, message: `Notifications paused until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, settings: result.settings };
}

function processFleetNotifications(view: FleetBridgeView): void {
  const paused = Boolean(appSettings.notificationPauseUntil
    && Date.parse(appSettings.notificationPauseUntil) > Date.now());
  const notifications = fleetNotificationTracker.process(view, appSettings.fleetNotifications, {
    emit: !paused && Notification.isSupported(),
    expectedHostRuntimeVersion: wslRuntimeManager.expectedHostRuntimeVersion()
  });
  for (const notification of notifications) {
    showFleetNotification(notification.title, notification.body, notification.target);
  }
}

function showFleetNotification(title: string, body: string, target?: FleetNotificationTarget): void {
  const notification = new Notification({ title, body, silent: false });
  notification.on('click', () => showDashboard(target));
  notification.show();
}

function createWindow(): void {
  const width = 540;
  const height = 500;
  const savedPosition = loadWindowPosition(join(dataDirectory, 'window-state.json'));
  const position = savedPosition ? clampWindowPosition(savedPosition, width, height) : undefined;
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: width,
    minHeight: height,
    resizable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    ...(position ?? {}),
    webPreferences: secureWebPreferences()
  });
  registerRenderer(mainWindow, 'widget');
  secureWindow(mainWindow);
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.on('moved', () => {
    if (mainWindow) saveWindowPosition(join(dataDirectory, 'window-state.json'), mainWindow);
  });
  mainWindow.on('blur', () => {
    if (interactionMode === 'active') setWidgetInteractionMode('passive');
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (isCpuSmoke) logger.info('CPU smoke renderer ready');
  });
  loadRenderer(mainWindow);
  setWidgetInteractionMode('passive');
}

function showDashboard(target?: FleetNotificationTarget): void {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    if (target) dashboardWindow.webContents.send(IPC_CHANNELS.fleetNotificationTarget, target);
    return;
  }
  const dashboardStatePath = join(dataDirectory, 'dashboard-window-state.json');
  const saved = loadWindowBounds(dashboardStatePath);
  const bounds = saved ? clampDashboardBounds(saved) : { width: 1440, height: 900 };
  dashboardWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1200,
    minHeight: 720,
    title: PRODUCT_NAME,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: secureWebPreferences()
  });
  registerRenderer(dashboardWindow, 'dashboard');
  const dashboardSenderId = dashboardWindow.webContents.id;
  const clearDashboardContent = (): void => {
    if (rendererAccess.role(dashboardSenderId) !== 'dashboard') return;
    rendererAccess.setBindings(dashboardSenderId, 'terminal', []);
    rendererAccess.setBindings(dashboardSenderId, 'conversation', []);
    terminalManager.unbindAll();
    conversationManager.sync([]);
  };
  dashboardWindow.on('hide', clearDashboardContent);
  dashboardWindow.webContents.on('did-start-loading', clearDashboardContent);
  secureWindow(dashboardWindow);
  const scheduleSave = (): void => {
    if (dashboardSaveTimer) clearTimeout(dashboardSaveTimer);
    dashboardSaveTimer = setTimeout(() => {
      dashboardSaveTimer = null;
      if (dashboardWindow && !dashboardWindow.isDestroyed()) saveWindowBounds(dashboardStatePath, dashboardWindow);
    }, 250);
  };
  dashboardWindow.on('move', scheduleSave);
  dashboardWindow.on('resize', scheduleSave);
  dashboardWindow.on('maximize', scheduleSave);
  dashboardWindow.on('unmaximize', scheduleSave);
  dashboardWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (dashboardWindow) saveWindowBounds(dashboardStatePath, dashboardWindow);
      dashboardWindow?.hide();
    }
  });
  dashboardWindow.on('closed', () => {
    if (dashboardSaveTimer) clearTimeout(dashboardSaveTimer);
    dashboardSaveTimer = null;
    dashboardWindow = null;
  });
  dashboardWindow.once('ready-to-show', () => {
    if (saved?.maximized) dashboardWindow?.maximize();
    dashboardWindow?.show();
    dashboardWindow?.focus();
    if (target) dashboardWindow?.webContents.send(IPC_CHANNELS.fleetNotificationTarget, target);
  });
  loadRenderer(dashboardWindow, 'dashboard');
}

function clampDashboardBounds(saved: { x: number; y: number; width: number; height: number }): Rectangle {
  const display = screen.getDisplayMatching(saved);
  const area = display.workArea;
  const width = Math.min(Math.max(saved.width, 1200), area.width);
  const height = Math.min(Math.max(saved.height, 720), area.height);
  const x = Math.min(Math.max(saved.x, area.x), area.x + Math.max(0, area.width - width));
  const y = Math.min(Math.max(saved.y, area.y), area.y + Math.max(0, area.height - height));
  return { x, y, width, height };
}

function createSettingsWindow(view: 'settings' | 'onboarding' = 'settings'): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindowView !== view) {
      settingsWindowView = view;
      loadRenderer(settingsWindow, view);
    }
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindowView = view;
  settingsWindow = new BrowserWindow({
    width: 760,
    height: 800,
    minWidth: 660,
    minHeight: 680,
    title: view === 'onboarding' ? 'Set up Agent Fleet' : 'Agent Fleet Settings',
    backgroundColor: '#111318',
    webPreferences: secureWebPreferences()
  });
  registerRenderer(settingsWindow, 'settings');
  secureWindow(settingsWindow);
  settingsWindow.on('closed', () => (settingsWindow = null));
  loadRenderer(settingsWindow, view);
}

function secureWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  };
}

function secureWindow(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function registerRenderer(window: BrowserWindow, role: RendererRole): void {
  const senderId = window.webContents.id;
  rendererAccess.register(senderId, role);
  window.once('closed', () => rendererAccess.unregister(senderId));
}

function loadRenderer(window: BrowserWindow, hash?: string): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void window.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
    return;
  }
  void window.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined);
}

function clampWindowPosition(position: Pick<Rectangle, 'x' | 'y'>, width: number, height: number): Pick<Rectangle, 'x' | 'y'> {
  const display = screen.getDisplayNearestPoint(position);
  const bounds = display.workArea;
  return {
    x: Math.max(bounds.x, Math.min(position.x, bounds.x + bounds.width - width)),
    y: Math.max(bounds.y, Math.min(position.y, bounds.y + bounds.height - height))
  };
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.on('click', () => showDashboard());
  updateTrayMenu();
  updateTrayTooltip();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const isActive = interactionMode === 'active';
  const updateState = updater?.getState();
  const fleet = getFleetView().snapshot;
  const recentSessions: Electron.MenuItemConstructorOptions[] = fleet.sessions.slice(0, 5).map((fleetSession) => {
    const host = fleet.hosts.find((item) => item.id === fleetSession.hostId);
    return {
      label: `${host?.name ?? fleetSession.hostId} · ${sessionIdentityPresentation(fleetSession).primary}`,
      click: () => void openFleetSessionById(fleetSession.id)
    };
  });
  if (!recentSessions.length) recentSessions.push({ label: 'No sessions available', enabled: false });
  const pendingSchedules = fleet.schedules.filter((item) => item.status === 'pending').length;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Agent Fleet', click: () => showDashboard() },
      { type: 'separator' as const },
      { label: 'Recent sessions', enabled: false },
      ...recentSessions,
      { label: `Scheduled messages: ${pendingSchedules}`, click: () => showDashboard() },
      { type: 'separator' as const },
      {
        label: isActive ? 'Make limits overlay passive' : 'Make limits overlay active',
        click: () => setWidgetInteractionMode(isActive ? 'passive' : 'active')
      },
      {
        label: 'Show limits overlay',
        type: 'checkbox',
        checked: appSettings.limitsOverlayEnabled,
        click: () => {
          void applyAndPersistSettings({
            ...cloneSettings(appSettings),
            limitsOverlayEnabled: !appSettings.limitsOverlayEnabled
          });
        }
      },
      { label: 'Refresh fleet', click: () => { fleetBridge.refresh(); void stateManager.refreshAll(); } },
      { label: 'Pause notifications for 1 hour', click: () => void pauseFleetNotifications() },
      { label: 'Settings', click: () => createSettingsWindow() },
      ...(!appSettings.onboardingComplete
        ? [{ label: 'Finish setup', click: () => createSettingsWindow('onboarding') }]
        : []),
      { type: 'separator' as const },
      {
        label: updateState?.status === 'downloaded' ? 'Restart to update' : 'Check for updates',
        click: () => (updateState?.status === 'downloaded' ? updater?.restartToUpdate() : void updater?.checkNow())
      },
      { label: 'View releases', click: () => void shell.openExternal(RELEASE_URL) },
      {
        label: 'Launch on login',
        type: 'checkbox',
        enabled: !isPortableBuild(),
        checked: !isPortableBuild() && appSettings.launchOnLogin,
        click: (menuItem) => void applyAndPersistSettings({ ...cloneSettings(appSettings), launchOnLogin: menuItem.checked })
      },
      { type: 'separator' as const },
      { label: `About ${PRODUCT_NAME} ${app.getVersion()}`, click: () => createSettingsWindow() },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function updateTrayTooltip(state: CombinedLimitState = stateManager.getState()): void {
  if (!tray) return;
  const fleet = getFleetView().snapshot;
  const healthyHosts = fleet.hosts.filter((host) => host.status === 'healthy').length;
  const worst = findWorstLimit(state);
  const limitDetail = worst ? `${worst.label} ${formatTooltipPercent(worst.remaining)} left` : 'limits pending';
  tray.setToolTip(`${PRODUCT_NAME} · ${healthyHosts}/${fleet.hosts.length} hosts · ${fleet.sessions.length} sessions · ${limitDetail}`);
}

function findWorstLimit(state: CombinedLimitState): { label: string; remaining: number } | null {
  let worst: { label: string; remaining: number } | null = null;
  for (const provider of state.providers) {
    for (const window of Object.values(provider.windows)) {
      if (typeof window?.remainingPercent !== 'number') continue;
      if (!worst || window.remainingPercent < worst.remaining) worst = { label: provider.label, remaining: window.remainingPercent };
    }
  }
  return worst;
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatTooltipPercent(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function createTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(join(getResourceRoot(), 'resources', 'tray-icon.png'));
  if (icon.isEmpty()) throw new Error('Tray icon asset could not be loaded');
  return icon.resize({ width: 32, height: 32, quality: 'best' });
}

function getResourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function isPortableBuild(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
}

function setWidgetInteractionMode(mode: InteractionMode): InteractionMode {
  interactionMode = mode;
  if (mainWindow) applyInteractionMode(mainWindow, mode, appSettings);
  broadcast(IPC_CHANNELS.interactionModeUpdated, mode);
  updateTrayMenu();
  updateTrayTooltip();
  return mode;
}

async function maintainWslRuntime(operation: () => Promise<WslRuntimeState>): Promise<WslRuntimeState> {
  return runtimeLifecycle.maintain(operation);
}

async function applyAndPersistSettings(settings: WidgetSettings): Promise<SettingsLoadResult> {
  let message: string | undefined;
  const previousLaunch = fleetBridgeLaunchFromSettings(appSettings);
  const titlesWereEnabled = appSettings.automaticSessionTitles;
  const overlayWasEnabled = appSettings.limitsOverlayEnabled;
  appSettings = saveSettings(settings, getSettingsPath(dataDirectory));
  if (titlesWereEnabled && !appSettings.automaticSessionTitles) fleetBridge.purgeSessionTitles();
  try {
    applyLaunchOnLogin(appSettings.launchOnLogin);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
    logger.error('Launch-on-login update failed', error);
  }
  settingsLoadResult = { settings: appSettings, recovered: Boolean(message), message };
  stateManager.applySettings(appSettings, message);
  const nextLaunch = fleetBridgeLaunchFromSettings(appSettings);
  if (JSON.stringify(previousLaunch) !== JSON.stringify(nextLaunch)) {
    fleetBridge.stop();
    fleetNotificationTracker.reset();
    fleetBridge = createFleetBridge();
    try {
      await maintainWslRuntime(() => wslRuntimeManager.ensure());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      logger.error('WSL runtime provisioning failed after distribution change', error);
    }
  }
  updater?.setEnabled(appSettings.automaticUpdates);
  if (mainWindow) applyInteractionMode(mainWindow, interactionMode, appSettings);
  if (mainWindow && !appSettings.limitsOverlayEnabled) mainWindow.hide();
  else if (mainWindow && !overlayWasEnabled && appSettings.limitsOverlayEnabled) setWidgetInteractionMode('passive');
  updateTrayMenu();
  updateTrayTooltip();
  void stateManager.refreshAll();
  return getSettingsResult();
}

function applyLaunchOnLogin(enabled: boolean): void {
  if (isPortableBuild()) return;
  if (app.isPackaged) {
    setLaunchOnLogin(false, app.getAppPath());
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
    return;
  }
  setLaunchOnLogin(enabled, app.getAppPath());
}

function getSettingsResult(): SettingsLoadResult {
  return { settings: cloneSettings(appSettings), recovered: settingsLoadResult.recovered, migrated: settingsLoadResult.migrated, message: settingsLoadResult.message };
}

function codexProfileFromSettings(profile: CodexProfileSettings): WslCodexProfile {
  return { ...profile };
}

function getAppInfo(): AppInfo {
  return {
    name: PRODUCT_NAME,
    version: app.getVersion(),
    packaged: app.isPackaged,
    portable: isPortableBuild(),
    dataDirectory,
    releaseUrl: RELEASE_URL,
    powerPolicy: downloadPowerPolicy.status()
  };
}

function getDialogOwner(): BrowserWindow {
  const owner = settingsWindow && !settingsWindow.isDestroyed()
    ? settingsWindow
    : dashboardWindow && !dashboardWindow.isDestroyed()
      ? dashboardWindow
      : mainWindow;
  if (!owner) throw new Error('No application window is available for the dialog');
  return owner;
}

function isTrustedEvent(event: IpcMainInvokeEvent): boolean {
  return BrowserWindow.getAllWindows().some((window) => window.webContents === event.sender);
}

function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedEvent(event)) throw new Error('Rejected IPC from an untrusted sender');
    assertIpcPayload(channel, args);
    rendererAccess.assertAnyRole(event.sender.id, allowedRendererRoles(channel));
    return listener(event, ...(args as never[]));
  });
}

function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, value);
}

function sendDashboard(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (rendererAccess.role(window.webContents.id) === 'dashboard') window.webContents.send(channel, value);
  }
}

function sendContent(
  channel: string,
  value: unknown,
  kind: RendererContentKind,
  tabId: string
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (rendererAccess.canAccess(window.webContents.id, kind, tabId)) window.webContents.send(channel, value);
  }
}

function sendTabContent(channel: string, value: unknown, tabId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const senderId = window.webContents.id;
    if (rendererAccess.canAccess(senderId, 'terminal', tabId)
      || rendererAccess.canAccess(senderId, 'conversation', tabId)) {
      window.webContents.send(channel, value);
    }
  }
}

function requireDashboard(event: IpcMainInvokeEvent): number {
  rendererAccess.assertRole(event.sender.id, 'dashboard');
  return event.sender.id;
}

function requireContent(event: IpcMainInvokeEvent, kind: RendererContentKind, tabId: unknown): string {
  if (typeof tabId !== 'string' || !rendererAccess.canAccess(event.sender.id, kind, tabId)) {
    throw new Error(`Renderer is not authorized for this ${kind} tab`);
  }
  return tabId;
}

function requireTabAccess(event: IpcMainInvokeEvent, tabId: unknown): string {
  if (typeof tabId !== 'string'
    || !rendererAccess.canAccess(event.sender.id, 'terminal', tabId)
      && !rendererAccess.canAccess(event.sender.id, 'conversation', tabId)) {
    throw new Error('Renderer is not authorized for this workspace tab');
  }
  return tabId;
}

handle(IPC_CHANNELS.getState, () => stateManager.getState());
handle(IPC_CHANNELS.refreshNow, () => stateManager.refreshAll());
handle(IPC_CHANNELS.getFleetState, (event) => {
  requireDashboard(event);
  return getFleetView();
});
handle(IPC_CHANNELS.refreshFleet, (event) => {
  requireDashboard(event);
  fleetBridge.refresh();
  return getFleetView();
});
handle(IPC_CHANNELS.openFleetSession, async (event, sessionId, request) => {
  requireDashboard(event);
  if (typeof sessionId !== 'string') return { ok: false, message: 'Session is invalid' };
  return openFleetSessionById(sessionId, parseWorkspaceOpenRequest(request));
});
handle(IPC_CHANNELS.openFleetSessionExternal, async (event, sessionId, target) => {
  requireDashboard(event);
  if (typeof sessionId !== 'string' || (target !== 'vscode' && target !== 'windowsTerminal')) {
    return { ok: false, message: 'Session target is invalid' };
  }
  return openFleetSessionExternallyById(sessionId, target);
});
handle(IPC_CHANNELS.openExternalLink, async (event, url) => {
  requireDashboard(event);
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) return { ok: false, message: 'The dashboard is no longer available.' };
  return routeExternalLink(url, {
    applicationName: (target) => app.getApplicationNameForProtocol(target),
    confirm: async ({ scheme, applicationName }) => {
      const choice = await dialog.showMessageBox(owner, {
        type: 'warning',
        title: 'Open external link?',
        message: `Open a ${scheme}: link with ${applicationName}?`,
        detail: 'This link came from session content. Continue only if you trust its source.',
        buttons: ['Cancel', 'Open'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      return choice.response === 1;
    },
    open: (target) => shell.openExternal(target, { activate: true })
  });
});
handle(IPC_CHANNELS.terminalList, (event) => {
  const senderId = requireDashboard(event);
  rendererAccess.setBindings(senderId, 'terminal', []);
  rendererAccess.setBindings(senderId, 'conversation', []);
  terminalManager.unbindAll();
  conversationManager.sync([]);
  return terminalManager.getWorkspaceState();
});
handle(IPC_CHANNELS.terminalBind, (event, tabId) => {
  const senderId = requireDashboard(event);
  const exists = typeof tabId === 'string'
    && terminalManager.list().some((tab) => tab.id === tabId && tab.viewMode === 'terminal');
  rendererAccess.setBindings(senderId, 'terminal', exists ? [tabId] : []);
  const tab = exists ? terminalManager.bind(tabId) : null;
  rendererAccess.setBindings(senderId, 'terminal', tab ? [tab.id] : []);
  return tab;
});
handle(IPC_CHANNELS.terminalSyncBindings, (event, tabIds) => {
  const senderId = requireDashboard(event);
  const values: unknown = tabIds;
  if (!Array.isArray(values) || values.length > 4 || !values.every((id) => typeof id === 'string')) {
    rendererAccess.setBindings(senderId, 'terminal', []);
    terminalManager.syncBindings([]);
    return [];
  }
  const existing = new Set(terminalManager.list()
    .filter((tab) => tab.viewMode === 'terminal')
    .map((tab) => tab.id));
  const requested = values.filter((id): id is string => typeof id === 'string' && existing.has(id));
  rendererAccess.setBindings(senderId, 'terminal', requested);
  const tabs = terminalManager.syncBindings(requested);
  rendererAccess.setBindings(senderId, 'terminal', tabs.map((tab) => tab.id));
  return tabs;
});
handle(IPC_CHANNELS.terminalWorkspaceCommand, (event, command) => {
  const senderId = requireDashboard(event);
  const value: unknown = command;
  if (!isWorkspaceCommand(value)) return terminalManager.getWorkspaceState();
  const parsed = value;
  if (parsed.type === 'assign') {
    const snapshot = getFleetView().snapshot;
    const session = snapshot.sessions.find((item) => item.id === parsed.sessionId);
    if (session?.internalName && isFleetSessionAvailable(snapshot, session)) {
      terminalManager.open(session, { paneId: parsed.paneId, placement: 'replace' });
    }
  } else terminalManager.applyWorkspaceCommand(parsed);
  const tabs = terminalManager.list();
  const terminalIds = new Set(tabs.filter((tab) => tab.viewMode === 'terminal').map((tab) => tab.id));
  const conversationIds = new Set(tabs
    .filter((tab) => tab.viewMode === 'native' && tab.tool !== 'shell')
    .map((tab) => tab.id));
  const retainedTerminal = rendererAccess.bindings(senderId, 'terminal').filter((id) => terminalIds.has(id));
  const retainedConversation = rendererAccess.bindings(senderId, 'conversation').filter((id) => conversationIds.has(id));
  rendererAccess.setBindings(senderId, 'terminal', retainedTerminal);
  rendererAccess.setBindings(senderId, 'conversation', retainedConversation);
  terminalManager.syncBindings(retainedTerminal);
  conversationManager.sync(retainedConversation);
  return terminalManager.getWorkspaceState();
});
handle(IPC_CHANNELS.terminalInput, (event, tabId, data) =>
  typeof data === 'string' && terminalManager.input(requireTabAccess(event, tabId), data));
handle(IPC_CHANNELS.terminalResize, (event, tabId, columns, rows) =>
  typeof columns === 'number' && typeof rows === 'number'
    && terminalManager.resize(requireContent(event, 'terminal', tabId), columns, rows));
handle(IPC_CHANNELS.terminalClose, (event, tabId) => {
  const authorized = requireTabAccess(event, tabId);
  const closed = terminalManager.close(authorized);
  if (!closed) rendererAccess.revokeTab(authorized);
  return closed;
});
handle(IPC_CHANNELS.terminalRetry, (event, tabId) =>
  terminalManager.retry(requireTabAccess(event, tabId)));
handle(IPC_CHANNELS.terminalSelect, (event, tabId) =>
  terminalManager.select(requireTabAccess(event, tabId)));
handle(IPC_CHANNELS.terminalSetView, (event, tabId, viewMode) => {
  if (viewMode !== 'native' && viewMode !== 'terminal') return null;
  const authorized = requireTabAccess(event, tabId);
  const tab = terminalManager.setViewMode(authorized, viewMode as SessionViewMode);
  if (tab?.viewMode === 'native') {
    rendererAccess.revoke(event.sender.id, 'terminal', authorized);
    terminalManager.syncBindings(rendererAccess.bindings(event.sender.id, 'terminal'));
  } else if (tab) {
    rendererAccess.revoke(event.sender.id, 'conversation', authorized);
    conversationManager.stop(authorized);
  }
  return tab;
});
handle(IPC_CHANNELS.conversationStart, (event, tabId) => {
  const senderId = requireDashboard(event);
  if (typeof tabId !== 'string' || !terminalManager.list()
    .some((tab) => tab.id === tabId && tab.viewMode === 'native' && tab.tool !== 'shell')) return false;
  rendererAccess.grant(senderId, 'conversation', tabId);
  const started = conversationManager.start(tabId);
  if (!started) rendererAccess.revoke(senderId, 'conversation', tabId);
  return started;
});
handle(IPC_CHANNELS.conversationStop, (event, tabId) => {
  const authorized = requireContent(event, 'conversation', tabId);
  conversationManager.stop(authorized);
  rendererAccess.revoke(event.sender.id, 'conversation', authorized);
});
handle(IPC_CHANNELS.localSuggestionsGetSettings, () => localSuggestionManager.settings());
handle(IPC_CHANNELS.localSuggestionsSaveSettings, async (_event, input) => {
  if (!input || typeof input !== 'object') throw new Error('Local suggestion settings are invalid.');
  const result = await localSuggestionManager.save(input as LocalSuggestionSettingsInput);
  broadcast(IPC_CHANNELS.localSuggestionsSettingsUpdated, result.settings);
  return result;
});
handle(IPC_CHANNELS.localSuggestionsTest, () => localSuggestionManager.test());
handle(IPC_CHANNELS.localSuggestionsChooseFile, async (_event, kind) => {
  if (kind !== 'executable' && kind !== 'model') return null;
  const result = await dialog.showOpenDialog(getDialogOwner(), {
    title: kind === 'executable' ? 'Choose llama-server executable' : 'Choose GGUF model',
    properties: ['openFile'],
    filters: kind === 'executable'
      ? [{ name: 'llama.cpp server', extensions: ['exe'] }]
      : [{ name: 'GGUF model', extensions: ['gguf'] }]
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
handle(IPC_CHANNELS.localSuggestionsSuggest, (_event, input) => localSuggestionManager.suggest(input));
handle(IPC_CHANNELS.localSuggestionsCancel, (_event, requestId) => {
  localSuggestionManager.cancel(typeof requestId === 'string' ? requestId : undefined);
});
handle(IPC_CHANNELS.conversationSync, (event, tabIds) => {
  const senderId = requireDashboard(event);
  const values: unknown = tabIds;
  if (!Array.isArray(values) || values.length > 4 || !values.every((id) => typeof id === 'string')) {
    rendererAccess.setBindings(senderId, 'conversation', []);
    conversationManager.sync([]);
    return [];
  }
  const eligible = new Set(terminalManager.list()
    .filter((tab) => tab.viewMode === 'native' && tab.tool !== 'shell')
    .map((tab) => tab.id));
  const requested = values.filter((id): id is string => typeof id === 'string' && eligible.has(id));
  rendererAccess.setBindings(senderId, 'conversation', requested);
  const started = conversationManager.sync(requested);
  rendererAccess.setBindings(senderId, 'conversation', started);
  return started;
});
handle(IPC_CHANNELS.conversationHistory, (event, tabId) =>
  conversationManager.history(requireContent(event, 'conversation', tabId)));
handle(IPC_CHANNELS.conversationPage, (event, tabId, cursor) =>
  typeof cursor === 'string'
    ? conversationManager.page(requireContent(event, 'conversation', tabId), cursor)
    : { ok: false, message: 'History request is invalid' });
handle(IPC_CHANNELS.conversationApprove, (event, tabId, approval, choice, revision, eventPosition) =>
  [approval, choice, revision].every((value) => typeof value === 'string') && typeof eventPosition === 'number'
    ? conversationManager.approve(
      requireContent(event, 'conversation', tabId), approval, choice, revision, eventPosition
    )
    : { ok: false, message: 'Approval is invalid' });
handle(IPC_CHANNELS.conversationAnswer, (event, tabId, question, revision, eventPosition, answers) => {
  const values: unknown = answers;
  return typeof question === 'string' && typeof revision === 'string'
    && typeof eventPosition === 'number' && Array.isArray(values) && values.length <= 8
    ? conversationManager.answer(
      requireContent(event, 'conversation', tabId), question, revision, eventPosition, values
    )
    : { ok: false, message: 'Answer is invalid' };
});
handle(IPC_CHANNELS.conversationStageBytes, (event, tabId, name, mime, data) => {
  const bytes = data as unknown;
  const imageName: unknown = name;
  const imageMime: unknown = mime;
  if (typeof imageName !== 'string' || imageName.length > 255
    || typeof imageMime !== 'string' || imageMime.length > 64
    || !(bytes instanceof Uint8Array) || bytes.byteLength > 20 * 1024 * 1024) {
    throw new Error('Image data is invalid');
  }
  return conversationManager.stage(requireContent(event, 'conversation', tabId), imageName, imageMime, bytes);
});
handle(IPC_CHANNELS.conversationStageClipboard, (event, tabId) => {
  const authorized = requireContent(event, 'conversation', tabId);
  const image = clipboard.readImage();
  if (image.isEmpty()) throw new Error('The clipboard does not contain an image');
  const dimensions = image.getSize();
  if (dimensions.width < 1 || dimensions.height < 1
    || dimensions.width * dimensions.height > 25_000_000) {
    throw new Error('Clipboard image dimensions are too large');
  }
  const data = image.toPNG();
  if (data.byteLength > 20 * 1024 * 1024) throw new Error('Clipboard image is larger than 20 MB');
  return conversationManager.stage(authorized, `clipboard-${Date.now()}.png`, 'image/png', data);
});
handle(IPC_CHANNELS.conversationChooseAttachments, async (event, tabId) => {
  const authorized = requireContent(event, 'conversation', tabId);
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) throw new Error('Dashboard window is unavailable');
  const result = await dialog.showOpenDialog(owner, {
    title: 'Attach images', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
  });
  const selected = result.filePaths.slice(0, 8).map((path) => {
    const extension = path.split('.').at(-1)?.toLowerCase();
    const mime = extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif'
      : extension === 'webp' ? 'image/webp' : 'image/jpeg';
    return { path, name: basename(path), mime };
  });
  return conversationManager.stageFiles(authorized, selected);
});
handle(IPC_CHANNELS.conversationRemoveAttachment, (event, tabId, attachmentId) => {
  const id: unknown = attachmentId;
  return typeof id === 'string' && id.length <= 128
    ? conversationManager.removeAttachment(
      requireContent(event, 'conversation', tabId), id
    ) : [];
});
handle(IPC_CHANNELS.conversationSend, (event, tabId, text) =>
  typeof text === 'string'
    ? conversationManager.send(requireContent(event, 'conversation', tabId), text)
    : { ok: false, message: 'Message is invalid' });
handle(IPC_CHANNELS.conversationCopyText, (_event, text) => {
  if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > 128 * 1024) {
    return { ok: false, message: 'Copy content is invalid or too large' };
  }
  clipboard.writeText(text);
  return { ok: true, message: 'Copied' };
});
handle(IPC_CHANNELS.killFleetSession, async (_event, sessionId) => {
  if (typeof sessionId !== 'string') return { ok: false, message: 'Session is invalid' };
  let snapshot = getFleetView().snapshot;
  let session = snapshot.sessions.find((item) => item.id === sessionId);
  if (!session) return { ok: false, message: 'Session is no longer available' };
  if (!isFleetSessionAvailable(snapshot, session)) {
    return { ok: false, message: `${session.name}'s host is offline; no changes were made`, retryable: true };
  }
  const idempotencyKey = randomUUID();
  try {
    let result;
    try {
      result = await fleetBridge.mutate('session.kill', {
        hostId: session.hostId,
        sessionId: session.id,
        idempotencyKey
      });
    } catch (error) {
      if (!(error instanceof FleetMutationError) || error.code !== 'stale_revision') throw error;
      snapshot = (await fleetBridge.refreshAndWait()).snapshot;
      session = snapshot.sessions.find((item) => item.id === sessionId);
      if (!session) return { ok: true, message: 'Session was already closed' };
      if (!isFleetSessionAvailable(snapshot, session)) {
        return { ok: false, message: `${session.name}'s host is offline; no changes were made`, retryable: true };
      }
      result = await fleetBridge.mutate('session.kill', {
      hostId: session.hostId,
      sessionId: session.id,
        idempotencyKey
      });
    }
    return { ok: true, message: result.status === 'already-absent' ? 'Session was already closed' : `${session.name} was killed` };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.renameFleetSession, async (_event, sessionId, name) => {
  if (typeof sessionId !== 'string' || typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/u.test(name)) {
    return { ok: false, message: 'Choose a short session name using letters, numbers, spaces, dots, dashes, or underscores' };
  }
  const snapshot = getFleetView().snapshot;
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  if (!session) return { ok: false, message: 'Session is no longer available' };
  if (!isFleetSessionAvailable(snapshot, session)) return { ok: false, message: 'Session host is offline; no changes were made' };
  try {
    await fleetBridge.mutate('session.rename', {
      hostId: session.hostId, sessionId: session.id, name, idempotencyKey: randomUUID()
    });
    return { ok: true, message: `Session renamed to ${name}` };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.resetFleetSessionName, async (_event, sessionId) => {
  if (typeof sessionId !== 'string') return { ok: false, message: 'Session is invalid' };
  const snapshot = getFleetView().snapshot;
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  if (!session) return { ok: false, message: 'Session is no longer available' };
  if (!isFleetSessionAvailable(snapshot, session)) return { ok: false, message: 'Session host is offline; no changes were made' };
  try {
    await fleetBridge.mutate('session.name.reset', {
      hostId: session.hostId, sessionId: session.id, idempotencyKey: randomUUID()
    });
    return { ok: true, message: 'Automatic session title restored' };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.getFleetSessionModel, async (_event, sessionId, includeCatalog) => {
  if (typeof sessionId !== 'string' || typeof includeCatalog !== 'boolean') {
    return { ok: false, message: 'Model control request is invalid' };
  }
  const snapshot = getFleetView().snapshot;
  const selected = snapshot.sessions.find((item) => item.id === sessionId);
  if (!selected || !isFleetSessionAvailable(snapshot, selected)) {
    return { ok: false, message: 'Session host is offline or no longer available', retryable: true };
  }
  if (!['codex', 'claude', 'copilot'].includes(selected.tool)) {
    return { ok: false, message: 'This session does not support model controls' };
  }
  try {
    const state = await fleetBridge.mutate('session.model.get', {
      hostId: selected.hostId, sessionId: selected.id, includeCatalog
    });
    return { ok: true, message: 'Model selection loaded', state };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.setFleetSessionModel, async (
  _event, sessionId, modelId, effortId, custom, expectedConfigRevision, historyImpactAcknowledged
) => {
  if (typeof sessionId !== 'string' || typeof modelId !== 'string' || typeof effortId !== 'string'
    || typeof custom !== 'boolean' || typeof expectedConfigRevision !== 'string'
    || typeof historyImpactAcknowledged !== 'boolean'
    || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\\-]{0,159}$/u.test(modelId)
    || !/^[A-Za-z0-9][A-Za-z0-9._+\\-]{0,63}$/u.test(effortId)
    || !/^[a-f0-9]{16}$/u.test(expectedConfigRevision)) {
    return { ok: false, message: 'Model or effort selection is invalid' };
  }
  const snapshot = getFleetView().snapshot;
  const selected = snapshot.sessions.find((item) => item.id === sessionId);
  if (!selected || !isFleetSessionAvailable(snapshot, selected)) {
    return { ok: false, message: 'Session host is offline or no longer available', retryable: true };
  }
  try {
    const result = await fleetBridge.mutate('session.model.set', {
      hostId: selected.hostId, sessionId: selected.id, modelId, effortId, custom,
      expectedConfigRevision, historyImpactAcknowledged, idempotencyKey: randomUUID()
    });
    return {
      ok: true,
      message: result.status === 'queued' ? 'Model change queued until the session is idle' : 'Model selection updated',
      state: result.modelControl
    };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.cancelFleetSessionModel, async (_event, sessionId, expectedConfigRevision) => {
  if (typeof sessionId !== 'string' || typeof expectedConfigRevision !== 'string'
    || !/^[a-f0-9]{16}$/u.test(expectedConfigRevision)) {
    return { ok: false, message: 'Model control request is invalid' };
  }
  const snapshot = getFleetView().snapshot;
  const selected = snapshot.sessions.find((item) => item.id === sessionId);
  if (!selected || !isFleetSessionAvailable(snapshot, selected)) {
    return { ok: false, message: 'Session host is offline or no longer available', retryable: true };
  }
  try {
    const result = await fleetBridge.mutate('session.model.cancel', {
      hostId: selected.hostId, sessionId: selected.id, expectedConfigRevision, idempotencyKey: randomUUID()
    });
    return { ok: true, message: result.status === 'already-clear' ? 'No model change was queued' : 'Queued model change cancelled', state: result.modelControl };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.copyFleetAttachCommand, (_event, sessionId) => {
  if (typeof sessionId !== 'string') return { ok: false, message: 'Session is invalid' };
  const snapshot = getFleetView().snapshot;
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  if (!session?.internalName) return { ok: false, message: 'Session is no longer available' };
  const command = [
    'wtmux', '--host', shellWord(session.hostId), '--project', shellWord(session.project),
    '--session', shellWord(session.internalName), '--fast'
  ].join(' ');
  clipboard.writeText(command);
  return { ok: true, message: 'Attach command copied' };
});
handle(IPC_CHANNELS.toggleFleetFavorite, async (_event, sessionId) => {
  if (typeof sessionId !== 'string') return { ok: false, message: 'Session is invalid' };
  const fleet = getFleetView().snapshot;
  const session = fleet.sessions.find((item) => item.id === sessionId);
  if (!session) return { ok: false, message: 'Session is no longer available' };
  if (!isFleetSessionAvailable(fleet, session)) return { ok: false, message: 'Session host is offline; no changes were made' };
  const existing = fleet.favorites.find((item) => item.hostId === session.hostId && item.project === session.project
    && item.backend === session.backend && item.tool === session.tool);
  try {
    if (existing) {
      await fleetBridge.mutate('preset.delete', { presetId: existing.id, idempotencyKey: randomUUID() });
      return { ok: true, message: 'Favorite removed' };
    }
    await fleetBridge.mutate('preset.upsert', {
      preset: {
        id: `favorite-${randomUUID()}`,
        name: `${session.project} · ${session.tool}`,
        hostId: session.hostId,
        project: session.project,
        backend: session.backend,
        tool: session.tool,
        profileAlias: session.profileAlias ?? ''
      },
      idempotencyKey: randomUUID()
    });
    return { ok: true, message: 'Favorite saved to the fleet preset registry' };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.launchFleetFavorite, async (_event, presetId) => {
  if (typeof presetId !== 'string') return { ok: false, message: 'Favorite is invalid' };
  const fleet = getFleetView().snapshot;
  const preset = fleet.favorites.find((item) => item.id === presetId);
  const host = preset ? fleet.hosts.find((item) => item.id === preset.hostId && item.status === 'healthy') : undefined;
  if (!preset || !host) return { ok: false, message: 'Favorite host is offline or no longer available' };
  try {
    const result = await fleetBridge.mutate('session.create', {
      hostId: preset.hostId,
      project: preset.project,
      backend: preset.backend === 'windows' ? 'windows' : 'linux',
      tool: preset.tool,
      idempotencyKey: randomUUID()
    });
    if (!result.sessionId) return { ok: true, message: `Created ${preset.name}` };
    const opened = await openFleetSessionById(result.sessionId);
    return { ok: opened.ok, message: opened.ok ? `Created and opened ${preset.name}` : `Created ${preset.name}; ${opened.message}` };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.cancelFleetSchedule, async (_event, scheduleId) => {
  if (typeof scheduleId !== 'string') return { ok: false, message: 'Schedule is invalid' };
  const schedule = getFleetView().snapshot.schedules.find((item) => item.id === scheduleId);
  if (!schedule || schedule.status !== 'pending') return { ok: false, message: 'Pending schedule is no longer available' };
  try {
    await fleetBridge.mutate('schedule.cancel', {
      hostId: schedule.hostId,
      scheduleId: schedule.id,
      idempotencyKey: randomUUID()
    });
    return { ok: true, message: 'Scheduled message was cancelled' };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.createFleetContinueSchedule, async (_event, sessionId, deliverAt, attentionId) => {
  if (typeof sessionId !== 'string' || typeof deliverAt !== 'string') {
    return { ok: false, message: 'Schedule target or time is invalid' };
  }
  const snapshot = getFleetView().snapshot;
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  const instant = Date.parse(deliverAt);
  if (!session) return { ok: false, message: 'Session is no longer available' };
  if (!isFleetSessionAvailable(snapshot, session)) return { ok: false, message: 'Session host is offline; no changes were made' };
  const attention = typeof attentionId === 'string'
    ? getFleetView().snapshot.attention.find((item) => item.id === attentionId) : undefined;
  if (attentionId !== undefined && (!attention || attention.targetSessionId !== session.id || attention.hostId !== session.hostId)) {
    return { ok: false, message: 'Hard-limit attention is no longer available for this session' };
  }
  if (!Number.isFinite(instant) || instant <= Date.now()) return { ok: false, message: 'Choose a future delivery time' };
  try {
    const result = await fleetBridge.mutate('schedule.create', {
      hostId: session.hostId,
      sessionId: session.id,
      deliverAt: new Date(instant).toISOString(),
      action: 'continue',
      ...(attention ? { attentionId: attention.id } : {}),
      idempotencyKey: randomUUID()
    });
    return {
      ok: true,
      message: result.scheduleId ? `Continue scheduled (${result.scheduleId})` : 'Continue scheduled'
    };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.dismissFleetAttention, async (_event, attentionId) => {
  if (typeof attentionId !== 'string') return { ok: false, message: 'Attention item is invalid' };
  const attention = getFleetView().snapshot.attention.find((item) => item.id === attentionId);
  if (!attention?.hostId) return { ok: false, message: 'Attention item is no longer available' };
  try {
    const result = await fleetBridge.mutate('attention.dismiss', {
      hostId: attention.hostId, attentionId: attention.id, idempotencyKey: randomUUID()
    });
    const message = result.status === 'already-dismissed'
      ? 'Limit offer was already dismissed'
      : result.status === 'already-resolved' ? 'Limit offer is already gone' : 'Limit offer dismissed';
    return { ok: true, message };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.updateFleetSchedule, async (_event, scheduleId, deliverAt) => {
  if (typeof scheduleId !== 'string' || typeof deliverAt !== 'string') {
    return { ok: false, message: 'Schedule or time is invalid' };
  }
  const schedule = getFleetView().snapshot.schedules.find((item) => item.id === scheduleId);
  const instant = Date.parse(deliverAt);
  if (!schedule || schedule.status !== 'pending') return { ok: false, message: 'Pending schedule is no longer available' };
  if (!Number.isFinite(instant) || instant <= Date.now()) return { ok: false, message: 'Choose a future delivery time' };
  try {
    await fleetBridge.mutate('schedule.update', {
      hostId: schedule.hostId,
      scheduleId: schedule.id,
      deliverAt: new Date(instant).toISOString(),
      idempotencyKey: randomUUID()
    });
    return { ok: true, message: 'Scheduled delivery time updated' };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.runFleetDoctor, async (_event, hostId) => {
  if (typeof hostId !== 'string') return { ok: false, message: 'Host is invalid' };
  const host = getFleetView().snapshot.hosts.find((item) => item.id === hostId);
  if (!host) return { ok: false, message: 'Host is no longer available' };
  try {
    const result = await fleetBridge.mutate('host.doctor', { hostId, idempotencyKey: randomUUID() });
    if (!result.doctor) return { ok: false, message: 'Host returned no diagnostic result' };
    lastDoctorResults.set(hostId, result.doctor);
    return { ok: true, message: `Doctor completed: ${result.doctor.status}`, doctor: result.doctor };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.updateFleetHost, async (_event, hostId) => {
  if (typeof hostId !== 'string') return { ok: false, message: 'Host is invalid' };
  const host = getFleetView().snapshot.hosts.find((item) => item.id === hostId);
  if (!host) return { ok: false, message: 'Host is no longer available' };
  try {
    const result = await wslRuntimeManager.connectHost({ action: 'repair', hostId });
    if (result.ok && fleetBridge.isRunning()) { fleetBridge.stop(); fleetBridge.start(); }
    return result;
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.connectFleetHost, async (_event, request) => {
  try {
    const result = await wslRuntimeManager.connectHost(request);
    if (result.ok && result.hostId && fleetBridge.isRunning()) { fleetBridge.stop(); fleetBridge.start(); }
    return result;
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.pauseFleetNotifications, () => pauseFleetNotifications());
handle(IPC_CHANNELS.listFleetDirectory, async (_event, hostId, backend, path) => {
  if (typeof hostId !== 'string' || (backend !== 'linux' && backend !== 'windows') || typeof path !== 'string') {
    return { ok: false, message: 'Directory request is invalid' };
  }
  const host = getFleetView().snapshot.hosts.find((item) => item.id === hostId && item.status === 'healthy');
  if (!host) return { ok: false, message: 'Host is offline or no longer available' };
  if (!validFleetPath(path, backend, true)) return { ok: false, message: 'Directory path is invalid' };
  try {
    const listing = await fleetBridge.mutate('directory.list', { hostId, backend, path, idempotencyKey: randomUUID() });
    return { ok: true, message: 'Directory loaded', listing };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.createFleetDirectory, async (_event, hostId, backend, parentPath, name) => {
  if (typeof hostId !== 'string' || (backend !== 'linux' && backend !== 'windows')
    || typeof parentPath !== 'string' || typeof name !== 'string') {
    return { ok: false, message: 'New folder request is invalid' };
  }
  const host = getFleetView().snapshot.hosts.find((item) => item.id === hostId && item.status === 'healthy');
  if (!host || !validFleetPath(parentPath, backend, false)
    || !/^[^./\\][^/\\]{0,126}$/.test(name) || /[ .]$/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, message: 'Host, parent folder, or folder name is invalid' };
  }
  try {
    const result = await fleetBridge.mutate('directory.create', {
      hostId, backend, parentPath, name, idempotencyKey: randomUUID()
    });
    return { ok: true, message: `Created ${name}`, path: result.path };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.listFleetRepository, async (_event, sessionId, relativePath, includeHidden, cursor) => {
  if (typeof sessionId !== 'string' || typeof relativePath !== 'string' || typeof includeHidden !== 'boolean'
    || typeof cursor !== 'string' || !validRepositoryPath(relativePath, true) || !validRepositoryCursor(cursor)) {
    return { ok: false, message: 'Repository request is invalid' };
  }
  const snapshot = getFleetView().snapshot;
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  if (!session || !isFleetSessionAvailable(snapshot, session)) return { ok: false, message: 'Session host is offline or no longer available' };
  try {
    const page = await fleetBridge.mutate('repository.list', {
      hostId: session.hostId, sessionId, relativePath, includeHidden, cursor, idempotencyKey: randomUUID()
    });
    return { ok: true, message: 'Repository loaded', page };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.searchFleetRepository, async (_event, sessionId, query, includeHidden) => {
  const queryValue: unknown = query;
  if (typeof sessionId !== 'string' || typeof queryValue !== 'string' || typeof includeHidden !== 'boolean'
    || queryValue.trim().length < 2 || queryValue.length > 160 || /[\u0000-\u001f\u007f]/u.test(queryValue)) {
    return { ok: false, message: 'Search needs at least two characters' };
  }
  const snapshot = getFleetView().snapshot;
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  if (!session || !isFleetSessionAvailable(snapshot, session)) return { ok: false, message: 'Session host is offline or no longer available' };
  try {
    const page = await fleetBridge.mutate('repository.search', {
      hostId: session.hostId, sessionId, query: queryValue.trim(), includeHidden, idempotencyKey: randomUUID()
    });
    return { ok: true, message: 'Search complete', page };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.startFleetDownload, (_event, sessionId, relativePath, name, size) => {
  if (typeof sessionId !== 'string' || typeof relativePath !== 'string' || typeof name !== 'string'
    || typeof size !== 'number' || !validRepositoryPath(relativePath, false)) {
    return { ok: false, message: 'Download request is invalid' };
  }
  const session = getFleetView().snapshot.sessions.find((item) => item.id === sessionId);
  const host = session && getFleetView().snapshot.hosts.find((item) => item.id === session.hostId && item.status === 'healthy');
  if (!session || !host || !session.internalName) return { ok: false, message: 'Session host is offline or no longer available' };
  try {
    const job = fleetDownloadManager.start({
      sessionId, hostId: session.hostId, internalName: session.internalName, relativePath, name, size
    });
    return { ok: true, message: 'Download started', job };
  } catch (error) {
    logger.warn('Could not start repository download', error);
    return { ok: false, message: error instanceof Error ? error.message : 'Download could not be started' };
  }
});
handle(IPC_CHANNELS.cancelFleetDownload, async (_event, jobId) => {
  const job = typeof jobId === 'string' ? await fleetDownloadManager.cancel(jobId) : undefined;
  return job ? { ok: true, message: job.message, job } : { ok: false, message: 'Download is no longer available' };
});
handle(IPC_CHANNELS.openFleetDownload, async (_event, jobId) => {
  const job = typeof jobId === 'string' ? await fleetDownloadManager.verifyForUse(jobId) : undefined;
  if (!job?.path || job.state !== 'completed') {
    return {
      ok: false,
      message: job?.state === 'failed' ? job.message : 'Downloaded file is not available',
      job
    };
  }
  const message = await shell.openPath(job.path);
  return message ? { ok: false, message, job } : { ok: true, message: `Opened ${job.name}`, job };
});
handle(IPC_CHANNELS.openFleetDownloadFolder, (_event, jobId) => {
  const job = typeof jobId === 'string' ? fleetDownloadManager.get(jobId) : undefined;
  if (!job?.path || job.state !== 'completed') return { ok: false, message: 'Downloaded file is not available', job };
  shell.showItemInFolder(job.path);
  return { ok: true, message: 'Opened Downloads', job };
});
handle(IPC_CHANNELS.createFleetSession, async (_event, hostId, project, backend, tool, path, locationKind, request) => {
  if (![hostId, project, backend, tool, path, locationKind].every((value) => typeof value === 'string')) {
    return { ok: false, message: 'Launcher selection is invalid' };
  }
  const fleet = getFleetView().snapshot;
  const host = fleet.hosts.find((item) => item.id === hostId && item.status === 'healthy');
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(project)) {
    return { ok: false, message: 'Host or session label is invalid' };
  }
  if (backend !== 'linux' && backend !== 'windows') return { ok: false, message: 'Backend is invalid' };
  if (!['shell', 'codex', 'claude', 'copilot'].includes(tool)) return { ok: false, message: 'Tool is invalid' };
  if ((locationKind !== 'project' && locationKind !== 'custom') || !validFleetPath(path, backend, false)) {
    return { ok: false, message: 'Selected folder is invalid' };
  }
  if (backend === 'windows' && host.platform !== 'wsl') return { ok: false, message: 'Windows backend requires a WSL host' };
  try {
    const result = await fleetBridge.mutate('session.create', {
      hostId,
      project,
      backend,
      tool,
      path,
      locationKind,
      idempotencyKey: randomUUID()
    });
    if (result.sessionId) {
    const opened = await openFleetSessionById(result.sessionId, parseWorkspaceOpenRequest(request));
      return { ok: opened.ok, message: opened.ok ? `Created and opened ${project}` : `Created ${project}; ${opened.message}` };
    }
    return { ok: true, message: `Created ${project}` };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});

function validFleetPath(value: string, backend: string, empty: boolean): boolean {
  if (value.length > 2048 || (!empty && !value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (!value) return empty;
  return backend === 'linux'
    ? value.startsWith('/')
    : !value.startsWith('\\\\') && !value.startsWith('//') && /^[A-Za-z]:[\\/]/.test(value);
}

function validRepositoryPath(value: string, empty: boolean): boolean {
  if (value.length > 2048 || (!empty && !value) || value.startsWith('/') || value.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (!value) return empty;
  return value.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..');
}

function validRepositoryCursor(value: string): boolean {
  return value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
}
handle(IPC_CHANNELS.createFleetPairingInvitation, async () => {
  try {
    const result = await fleetBridge.mutate('pairing.invite', { idempotencyKey: randomUUID() });
    if (!result.invitation) return { ok: false, message: 'Controller returned no invitation' };
    clipboard.writeText(result.invitation.termuxCommand);
    return {
      ok: true,
      message: `Termux pairing command copied · code ${result.invitation.shortCode} · expires in 10 minutes`
    };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});
handle(IPC_CHANNELS.reviewFleetPairing, async (_event, requestId) => {
  if (typeof requestId !== 'string') return { ok: false, message: 'Pairing request is invalid' };
  const current = getFleetView().snapshot.pairingRequests.find((item) => item.id === requestId && item.status === 'awaiting-review');
  if (!current) return { ok: false, message: 'Pairing request is no longer awaiting review' };
  try {
    const reviewed = await fleetBridge.mutate('pairing.review', { pairingRequestId: requestId, idempotencyKey: randomUUID() });
    if (!reviewed.pairingRequest) return { ok: false, message: 'Controller returned no pairing proposal' };
    const reviewOptions = {
      type: 'warning',
      title: 'Review exact pairing proposal',
      message: `${reviewed.pairingRequest.deviceName} requests fleet access`,
      detail: `Verified live peer: ${reviewed.pairingRequest.peer} (${reviewed.pairingRequest.peerIp})\n\n${JSON.stringify(reviewed.pairingRequest.proposal, null, 2)}`,
      buttons: ['Approve', 'Reject', 'Cancel'],
      defaultId: 2,
      cancelId: 2,
      noLink: true
    } satisfies MessageBoxOptions;
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const choice = focusedWindow
      ? await dialog.showMessageBox(focusedWindow, reviewOptions)
      : await dialog.showMessageBox(reviewOptions);
    if (choice.response === 2) return { ok: false, message: 'Pairing review cancelled' };
    const decision = choice.response === 0 ? 'pairing.approve' : 'pairing.reject';
    await fleetBridge.mutate(decision, { pairingRequestId: requestId, idempotencyKey: randomUUID() });
    return { ok: true, message: choice.response === 0 ? 'Pairing approved; private registry and install artifacts are ready' : 'Pairing proposal rejected' };
  } catch (error) {
    return fleetMutationFailure(error);
  }
});

function fleetMutationFailure(error: unknown): { ok: false; message: string; retryable: boolean } {
  logger.warn('Fleet mutation failed', error);
  if (error instanceof FleetMutationError) {
    if (error.code === 'stale_revision') return { ok: false, message: 'Fleet changed; refresh and try again', retryable: false };
    if (error.code === 'host_offline') {
      return { ok: false, message: 'Host is offline; no changes were made', retryable: true };
    }
    return { ok: false, message: error.message, retryable: isRetryableFleetErrorCode(error.code) };
  }
  return { ok: false, message: 'Action failed safely; refresh before retrying', retryable: false };
}

async function openFleetSessionById(sessionId: string, request: WorkspaceOpenRequest = {}): Promise<TerminalOpenResult> {
  const snapshot = getFleetView().snapshot;
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  if (!session || !session.internalName) return { ok: false, message: 'Session is no longer available' };
  if (!isFleetSessionAvailable(snapshot, session)) return { ok: false, message: 'Session host is offline; no changes were made' };
  try {
    const sessionTitle = sessionIdentityPresentation(session).primary;
    const target = {
      id: session.id,
      hostId: session.hostId,
      project: session.project,
      sessionName: session.internalName,
      label: sessionTitle
    };
    const distro = fleetBridgeLaunchFromSettings(appSettings).distro;
    if (appSettings.fleetOpenTarget === 'agentFleet') {
      const tab = terminalManager.open(session, request);
      showDashboard();
      sendDashboard(IPC_CHANNELS.terminalOpened, tab);
      return { ok: true, message: `Opened ${sessionTitle}`, tab };
    }
    if (appSettings.fleetOpenTarget === 'vscode') {
      try {
        await openFleetVscode(target, distro);
        return { ok: true, message: `Opening ${sessionTitle} in VS Code` };
      } catch (error) {
        logger.warn('VS Code wtmux integration unavailable; falling back to Windows Terminal', error);
        await openFleetTerminal(target, distro);
        return { ok: true, message: `Opening ${sessionTitle} in Windows Terminal · repair the wtmux VS Code extension to use the current window` };
      }
    }
    await openFleetTerminal(target, distro);
    return { ok: true, message: `Opening ${sessionTitle}` };
  } catch (error) {
    logger.warn('Could not open fleet session terminal', error);
    return { ok: false, message: 'Windows Terminal could not be opened' };
  }
}

function parseWorkspaceOpenRequest(value: unknown): WorkspaceOpenRequest {
  if (!value || typeof value !== 'object') return {};
  const input = value as Record<string, unknown>;
  const paneId = typeof input.paneId === 'string' ? input.paneId : undefined;
  const placement = ['replace', 'split-right', 'split-down'].includes(String(input.placement))
    ? input.placement as WorkspaceOpenRequest['placement'] : undefined;
  return { ...(paneId ? { paneId } : {}), ...(placement ? { placement } : {}) };
}

function isWorkspaceCommand(value: unknown): value is WorkspaceCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Record<string, unknown>;
  if (command.type === 'assign') return typeof command.paneId === 'string' && typeof command.sessionId === 'string';
  if (command.type === 'split') return typeof command.paneId === 'string' && ['row', 'column'].includes(String(command.direction));
  if (command.type === 'close' || command.type === 'clear' || command.type === 'focus') return typeof command.paneId === 'string';
  if (command.type === 'resize') return typeof command.splitId === 'string' && typeof command.ratio === 'number';
  if (command.type === 'preset') return ['single', 'two-columns', 'two-rows', 'grid'].includes(String(command.preset));
  if (command.type === 'swap') return typeof command.firstPaneId === 'string' && typeof command.secondPaneId === 'string';
  if (command.type === 'view') return typeof command.paneId === 'string' && ['native', 'terminal'].includes(String(command.viewMode));
  if (command.type === 'rail') return Boolean(command.rail && typeof command.rail === 'object');
  return false;
}

async function openFleetSessionExternallyById(
  sessionId: string,
  target: 'vscode' | 'windowsTerminal'
): Promise<TerminalOpenResult> {
  const snapshot = getFleetView().snapshot;
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  if (!session?.internalName) return { ok: false, message: 'Session is no longer available' };
  if (!isFleetSessionAvailable(snapshot, session)) return { ok: false, message: 'Session host is offline; no changes were made' };
  const value = {
    id: session.id,
    hostId: session.hostId,
    project: session.project,
    sessionName: session.internalName,
    label: sessionIdentityPresentation(session).primary
  };
  const distro = fleetBridgeLaunchFromSettings(appSettings).distro;
  try {
    if (target === 'vscode') {
      await openFleetVscode(value, distro);
      return { ok: true, message: `Opening ${session.name} in VS Code` };
    }
    await openFleetTerminal(value, distro);
    return { ok: true, message: `Opening ${session.name} in Windows Terminal` };
  } catch (error) {
    logger.warn('External terminal fallback failed', target, error);
    return { ok: false, message: target === 'vscode' ? 'VS Code could not open this session' : 'Windows Terminal could not open this session' };
  }
}
handle(IPC_CHANNELS.getSettings, () => getSettingsResult());
handle(IPC_CHANNELS.saveSettings, (_event, input) => applyAndPersistSettings(normalizeSettings(input).settings));
handle(IPC_CHANNELS.testCodexProfile, async (_event, profile) => {
  if (!profile || typeof profile !== 'object') return { ok: false, message: 'Profile is invalid' };
  const normalized = normalizeSettings({ ...createDefaultSettings(), codexProfiles: [profile] }).settings.codexProfiles[0];
  if (!normalized) return { ok: false, message: 'Profile is invalid' };
  const result = await collectCodexProfileLimits(codexProfileFromSettings(normalized));
  return { ok: result.status === 'ok', message: result.status === 'ok' ? 'Profile test succeeded' : result.message ?? result.status };
});
handle(IPC_CHANNELS.discoverWsl, () => discoverWslProfiles(undefined, wslProcessOwnership));
handle(IPC_CHANNELS.previewSettingsImport, async () => {
  const result = await dialog.showOpenDialog(getDialogOwner(), {
    title: 'Import AI Limits Widget settings',
    properties: ['openFile'],
    filters: [{ name: 'AI Limits settings', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const importPath = result.filePaths[0];
  const preview = parseSettingsImport(
    readFileSnapshot(importPath, MAX_SETTINGS_IMPORT_BYTES).data,
    importPath
  );
  const token = randomUUID();
  pendingImports.set(token, preview.settings);
  setTimeout(() => pendingImports.delete(token), 10 * 60 * 1000).unref();
  return { ...preview, token, profileCount: preview.settings.codexProfiles.length } satisfies SettingsImportSelection;
});
handle(IPC_CHANNELS.applySettingsImport, async (_event, token) => {
  if (typeof token !== 'string') throw new Error('Import token is invalid');
  const imported = pendingImports.get(token);
  if (!imported) throw new Error('Import preview expired; choose the file again');
  pendingImports.delete(token);
  const next = applyImportedSettings({ ...imported, onboardingComplete: true }, getSettingsPath(dataDirectory));
  return applyAndPersistSettings(next);
});
handle(IPC_CHANNELS.exportSettings, async () => {
  const result = await dialog.showSaveDialog(getDialogOwner(), {
    title: 'Export AI Limits Widget settings',
    defaultPath: join(app.getPath('documents'), `ai-limits-settings-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'AI Limits settings', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true, message: 'Export canceled' };
  mkdirSync(dirname(result.filePath), { recursive: true });
  writeFileSync(result.filePath, `${JSON.stringify(createSettingsExport(appSettings, app.getVersion()), null, 2)}\n`, 'utf8');
  return { canceled: false, message: `Settings exported to ${basename(result.filePath)}`, path: result.filePath };
});
handle(IPC_CHANNELS.rollbackSettings, async () => {
  const restored = rollbackLatestSettings(getSettingsPath(dataDirectory));
  if (!restored) return { canceled: true, message: 'No settings backup is available' };
  await applyAndPersistSettings(restored);
  return { canceled: false, message: 'The latest settings backup was restored', settings: restored };
});
handle(IPC_CHANNELS.getClaudeIntegration, () => {
  const paths = getClaudeStatusLinePaths(getResourceRoot(), dataDirectory);
  return inspectClaudeStatusLineInstallation(paths.targetScript, paths.settingsPath, paths.sourceScript);
});
handle(IPC_CHANNELS.installClaudeIntegration, async () => {
  const result = ensureClaudeStatusLineInstalled(getClaudeStatusLinePaths(getResourceRoot(), dataDirectory));
  if (result.status !== 'conflict') await applyAndPersistSettings({ ...appSettings, claudeEnabled: true });
  return result;
});
handle(IPC_CHANNELS.removeClaudeIntegration, async () => {
  const result = removeClaudeStatusLine(getClaudeStatusLinePaths(getResourceRoot(), dataDirectory));
  if (result.status !== 'conflict') await applyAndPersistSettings({ ...appSettings, claudeEnabled: false });
  return result;
});
handle(IPC_CHANNELS.getAppInfo, () => getAppInfo());
handle(IPC_CHANNELS.getDiagnostics, () => createDiagnosticsReport({
  app: getAppInfo(),
  fleet: getFleetView(),
  doctors: [...lastDoctorResults.values()],
  terminal: terminalManager.getHealth(),
  wslRuntime: wslRuntimeManager.getState(),
  updateConfigured: appSettings.automaticUpdates,
  processOwnership: wslProcessOwnership.snapshot()
}));
handle(IPC_CHANNELS.exportDiagnostics, async () => {
  const result = await dialog.showSaveDialog(getDialogOwner(), {
    title: 'Export diagnostics',
    defaultPath: join(app.getPath('documents'), `ai-limits-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`),
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true, message: 'Diagnostics export canceled' };
  await writeDiagnosticsArchive(result.filePath, {
    app: getAppInfo(),
    fleet: getFleetView(),
    doctors: [...lastDoctorResults.values()],
    terminal: terminalManager.getHealth(),
    wslRuntime: wslRuntimeManager.getState(),
    updateConfigured: appSettings.automaticUpdates,
    processOwnership: wslProcessOwnership.snapshot()
  });
  return { canceled: false, message: `Diagnostics exported to ${basename(result.filePath)}`, path: result.filePath };
});
handle(IPC_CHANNELS.getUpdaterState, () => updater?.getState() ?? ({ status: 'disabled', currentVersion: app.getVersion() } satisfies UpdaterState));
handle(IPC_CHANNELS.checkForUpdates, () => updater?.checkNow());
handle(IPC_CHANNELS.restartToUpdate, () => updater?.restartToUpdate());
handle(IPC_CHANNELS.openReleasePage, () => shell.openExternal(RELEASE_URL));
handle(IPC_CHANNELS.getRuntimeState, () => wslRuntimeManager.inspect());
handle(IPC_CHANNELS.repairRuntime, () => maintainWslRuntime(() => wslRuntimeManager.repair()));
handle(IPC_CHANNELS.rollbackRuntime, () => maintainWslRuntime(() => wslRuntimeManager.rollback()));
handle(IPC_CHANNELS.openSettings, () => createSettingsWindow());
handle(IPC_CHANNELS.getInteractionMode, () => interactionMode);
handle(IPC_CHANNELS.setInteractionMode, (_event, mode) => setWidgetInteractionMode(mode === 'active' ? 'active' : 'passive'));
handle(IPC_CHANNELS.windowHide, (event) => {
  BrowserWindow.fromWebContents(event.sender)?.hide();
  updateTrayMenu();
});
handle(IPC_CHANNELS.windowQuit, () => {
  isQuitting = true;
  app.quit();
});

stateManager.on('changed', (state) => {
  broadcast(IPC_CHANNELS.stateUpdated, state);
  sendDashboard(IPC_CHANNELS.fleetStateUpdated, getFleetView());
  updateTrayTooltip(state);
});

if (terminalSmokePath) {
  app.whenReady().then(async () => {
    const ok = await runPackagedTerminalSmoke(terminalSmokePath);
    app.exit(ok ? 0 : 1);
  });
} else if (powerSmokePath) {
  app.whenReady().then(() => {
    const writePhase = (phase: string): void => writeFileSync(powerSmokePath, `${JSON.stringify({ phase, pid: process.pid })}\n`, 'utf8');
    writePhase('idle');
    setTimeout(() => {
      downloadPowerPolicy.update({ id: 'power-smoke-download', state: 'running' });
      writePhase('active-download');
      setTimeout(() => {
        downloadPowerPolicy.update({ id: 'power-smoke-download', state: 'completed' });
        writePhase('released');
        setTimeout(() => app.exit(0), 4_000).unref();
      }, 7_000).unref();
    }, 7_000).unref();
  });
} else if (isUninstallCleanup) {
  app.whenReady().then(() => {
    try {
      removeClaudeStatusLine(getClaudeStatusLinePaths(getResourceRoot(), dataDirectory));
    } catch (error) {
      logger.error('Uninstall Claude cleanup failed', error);
    }
    app.quit();
  });
} else if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!appSettings.onboardingComplete) createSettingsWindow('onboarding');
    else showDashboard();
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    applyLaunchOnLogin(appSettings.launchOnLogin);
    createWindow();
    createTray();
    updater = new UpdaterManager({
      currentVersion: app.getVersion(),
      eligible: app.isPackaged && !isPortableBuild(),
      prerelease: app.getVersion().includes('-'),
      logger,
      releaseSetAuthority,
      verifiedUpdateRoot: join(dataDirectory, 'verified-updates')
    });
    updater.on('changed', async (state: UpdaterState) => {
      broadcast(IPC_CHANNELS.updaterStateUpdated, state);
      updateTrayMenu();
      if (state.status === 'downloaded' && !isQuitting) {
        const response = await dialog.showMessageBox({
          type: 'info',
          title: 'Update ready',
          message: `${PRODUCT_NAME} ${state.availableVersion ?? ''} is ready to install.`,
          detail: 'Restart now, or choose Later and restart from the update control when convenient.',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          cancelId: 1
        });
        if (response.response === 0) updater?.restartToUpdate();
      }
    });
    updater.setEnabled(appSettings.automaticUpdates);
    stateManager.start();
    try {
      await maintainWslRuntime(() => wslRuntimeManager.ensure());
    } catch (error) {
      logger.error('Verified WSL runtime provisioning failed', error);
    }
    if (!appSettings.onboardingComplete) createSettingsWindow('onboarding');
    if (!app.isPackaged) showDashboard();
    logger.info(PRODUCT_NAME, app.getVersion(), app.isPackaged ? 'packaged' : 'development', migrationResult);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      showDashboard();
    });
  });
}

app.on('before-quit', (event) => {
  isQuitting = true;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownPromise) return;
  shutdownPromise = (async () => {
    const cleanup = (label: string, operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        logger.warn(`Shutdown cleanup failed: ${label}`, error);
      }
    };
    cleanup('updater', () => updater?.stop());
    cleanup('state manager', () => stateManager.stop());
    cleanup('fleet bridge', () => fleetBridge.stop());
    cleanup('terminal manager', () => terminalManager.dispose());
    cleanup('conversation manager', () => conversationManager.dispose());
    cleanup('local suggestion manager', () => localSuggestionManager.dispose());

    let downloadsStopped: Promise<unknown>;
    try {
      downloadsStopped = fleetDownloadManager.stop();
    } catch (error) {
      logger.warn('Shutdown cleanup failed: downloads', error);
      downloadsStopped = Promise.resolve();
    }
    const processesStopped = wslProcessOwnership.releaseAllAndWait('app_shutdown', 5_000);
    const drained = await awaitBoundedShutdown([downloadsStopped, processesStopped], 6_500);
    cleanup('download power policy', () => downloadPowerPolicy.dispose());
    if (!drained) logger.warn('Shutdown cleanup reached its deadline; exiting with best-effort cleanup');
  })();
  const finishQuit = (): void => {
    shutdownComplete = true;
    app.quit();
  };
  void shutdownPromise.then(finishQuit, (error) => {
    logger.error('Unexpected shutdown cleanup failure', error);
    finishQuit();
  });
});

app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});
