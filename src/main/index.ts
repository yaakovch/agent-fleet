import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type Rectangle
} from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
import { writeDiagnosticsArchive } from './diagnostics';
import { setLaunchOnLogin } from './launch-on-login';
import { configureLogger, getLogPath } from './logger';
import {
  applyImportedSettings,
  createSettingsExport,
  getSettingsPath,
  loadSettings,
  parseSettingsImport,
  rollbackLatestSettings,
  saveSettings
} from './settings-store';
import { LimitStateManager } from './state-manager';
import { FleetBridgeSupervisor, FleetMutationError, fleetBridgeLaunchFromSettings } from './fleet-bridge';
import { openFleetTerminal } from './fleet-terminal';
import type { FleetBridgeView } from '../shared/fleet-protocol';
import { UpdaterManager } from './updater';
import { applyInteractionMode } from './window-mode';
import { loadWindowPosition, saveWindowPosition } from './window-state';
import { discoverWslProfiles } from './wsl-discovery';

const APP_ID = 'com.yaakovch.ailimitswidget';
const PRODUCT_NAME = 'Agent Fleet';
const RELEASE_URL = 'https://github.com/yaakovch/agent-fleet/releases/latest';
const dataDirectory = getWidgetDataDir();

app.setName(PRODUCT_NAME);
app.setAppUserModelId(APP_ID);
app.setPath('userData', dataDirectory);

const isUninstallCleanup = process.argv.includes('--uninstall-cleanup');
const hasSingleInstanceLock = isUninstallCleanup || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

const migrationResult = migrateLegacyData(dataDirectory);
let settingsLoadResult = loadSettings(getSettingsPath(dataDirectory));
let appSettings = settingsLoadResult.settings;
const logger = configureLogger(dataDirectory);
const stateManager = new LimitStateManager({
  settings: appSettings,
  settingsDiagnostic: settingsLoadResult.recovered ? settingsLoadResult.message : undefined
});
let fleetBridge = createFleetBridge();

let mainWindow: BrowserWindow | null = null;
let dashboardWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let settingsWindowView: 'settings' | 'onboarding' = 'settings';
let tray: Tray | null = null;
let updater: UpdaterManager | null = null;
let isQuitting = false;
let interactionMode: InteractionMode = 'passive';
const pendingImports = new Map<string, WidgetSettings>();

function createFleetBridge(): FleetBridgeSupervisor {
  const bridge = new FleetBridgeSupervisor({
    cachePath: join(dataDirectory, 'fleet-cache-v1.json'),
    launch: fleetBridgeLaunchFromSettings(appSettings),
    logger
  });
  bridge.on('changed', () => {
    broadcast(IPC_CHANNELS.fleetStateUpdated, getFleetView());
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
  secureWindow(mainWindow);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
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
  loadRenderer(mainWindow);
  setWidgetInteractionMode('passive');
}

function showDashboard(): void {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }
  dashboardWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    title: PRODUCT_NAME,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: secureWebPreferences()
  });
  secureWindow(dashboardWindow);
  dashboardWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      dashboardWindow?.hide();
    }
  });
  dashboardWindow.on('closed', () => (dashboardWindow = null));
  dashboardWindow.once('ready-to-show', () => {
    dashboardWindow?.show();
    dashboardWindow?.focus();
  });
  loadRenderer(dashboardWindow, 'dashboard');
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
      label: `${host?.name ?? fleetSession.hostId} · ${fleetSession.name}`,
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
        label: mainWindow?.isVisible() ? 'Hide limits overlay' : 'Show limits overlay',
        click: () => {
          if (mainWindow?.isVisible()) mainWindow.hide();
          else setWidgetInteractionMode('passive');
          updateTrayMenu();
        }
      },
      { label: 'Refresh fleet', click: () => { fleetBridge.refresh(); void stateManager.refreshAll(); } },
      { label: 'Pause notifications for 1 hour', click: () => showDashboard() },
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

async function applyAndPersistSettings(settings: WidgetSettings): Promise<SettingsLoadResult> {
  let message: string | undefined;
  const previousLaunch = fleetBridgeLaunchFromSettings(appSettings);
  appSettings = saveSettings(settings, getSettingsPath(dataDirectory));
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
    fleetBridge = createFleetBridge();
    fleetBridge.start();
  }
  updater?.setEnabled(appSettings.automaticUpdates);
  if (mainWindow) applyInteractionMode(mainWindow, interactionMode, appSettings);
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
    releaseUrl: RELEASE_URL
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
    return listener(event, ...(args as never[]));
  });
}

function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, value);
}

handle(IPC_CHANNELS.getState, () => stateManager.getState());
handle(IPC_CHANNELS.refreshNow, () => stateManager.refreshAll());
handle(IPC_CHANNELS.getFleetState, () => getFleetView());
handle(IPC_CHANNELS.refreshFleet, () => {
  fleetBridge.refresh();
  return getFleetView();
});
handle(IPC_CHANNELS.openFleetSession, async (_event, sessionId) => {
  if (typeof sessionId !== 'string') return { ok: false, message: 'Session is invalid' };
  return openFleetSessionById(sessionId);
});
handle(IPC_CHANNELS.killFleetSession, async (_event, sessionId) => {
  if (typeof sessionId !== 'string') return { ok: false, message: 'Session is invalid' };
  const session = getFleetView().snapshot.sessions.find((item) => item.id === sessionId);
  if (!session) return { ok: false, message: 'Session is no longer available' };
  try {
    const result = await fleetBridge.mutate('session.kill', {
      hostId: session.hostId,
      sessionId: session.id,
      idempotencyKey: randomUUID()
    });
    return { ok: true, message: result.status === 'already-absent' ? 'Session was already closed' : `${session.name} was killed` };
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
handle(IPC_CHANNELS.createFleetContinueSchedule, async (_event, sessionId, deliverAt) => {
  if (typeof sessionId !== 'string' || typeof deliverAt !== 'string') {
    return { ok: false, message: 'Schedule target or time is invalid' };
  }
  const session = getFleetView().snapshot.sessions.find((item) => item.id === sessionId);
  const instant = Date.parse(deliverAt);
  if (!session) return { ok: false, message: 'Session is no longer available' };
  if (!Number.isFinite(instant) || instant <= Date.now()) return { ok: false, message: 'Choose a future delivery time' };
  try {
    const result = await fleetBridge.mutate('schedule.create', {
      hostId: session.hostId,
      sessionId: session.id,
      deliverAt: new Date(instant).toISOString(),
      action: 'continue',
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

function fleetMutationFailure(error: unknown): { ok: false; message: string } {
  logger.warn('Fleet mutation failed', error);
  if (error instanceof FleetMutationError) {
    if (error.code === 'stale_revision') return { ok: false, message: 'Fleet changed; refresh and try again' };
    if (error.code === 'host_offline') return { ok: false, message: 'Host is offline; no changes were made' };
    if (error.code === 'conflict') return { ok: false, message: error.message };
    if (error.code === 'timeout') return { ok: false, message: error.message };
  }
  return { ok: false, message: 'Action failed safely; refresh before retrying' };
}

async function openFleetSessionById(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = getFleetView().snapshot.sessions.find((item) => item.id === sessionId);
  if (!session || !session.internalName) return { ok: false, message: 'Session is no longer available' };
  try {
    await openFleetTerminal({
      id: session.id,
      hostId: session.hostId,
      project: session.project,
      sessionName: session.internalName,
      label: session.name
    }, fleetBridgeLaunchFromSettings(appSettings).distro);
    return { ok: true, message: `Opening ${session.name}` };
  } catch (error) {
    logger.warn('Could not open fleet session terminal', error);
    return { ok: false, message: 'Windows Terminal could not be opened' };
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
handle(IPC_CHANNELS.discoverWsl, () => discoverWslProfiles());
handle(IPC_CHANNELS.previewSettingsImport, async () => {
  const result = await dialog.showOpenDialog(getDialogOwner(), {
    title: 'Import AI Limits Widget settings',
    properties: ['openFile'],
    filters: [{ name: 'AI Limits settings', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const preview = parseSettingsImport(readFileSync(result.filePaths[0]), result.filePaths[0]);
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
handle(IPC_CHANNELS.getClaudeIntegration, () => inspectClaudeStatusLineInstallation());
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
handle(IPC_CHANNELS.exportDiagnostics, async () => {
  const result = await dialog.showSaveDialog(getDialogOwner(), {
    title: 'Export diagnostics',
    defaultPath: join(app.getPath('documents'), `ai-limits-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`),
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true, message: 'Diagnostics export canceled' };
  await writeDiagnosticsArchive(result.filePath, {
    app: getAppInfo(),
    settings: appSettings,
    state: stateManager.getState(),
    logPath: getLogPath(dataDirectory)
  });
  return { canceled: false, message: `Diagnostics exported to ${basename(result.filePath)}`, path: result.filePath };
});
handle(IPC_CHANNELS.getUpdaterState, () => updater?.getState() ?? ({ status: 'disabled', currentVersion: app.getVersion() } satisfies UpdaterState));
handle(IPC_CHANNELS.checkForUpdates, () => updater?.checkNow());
handle(IPC_CHANNELS.restartToUpdate, () => updater?.restartToUpdate());
handle(IPC_CHANNELS.openReleasePage, () => shell.openExternal(RELEASE_URL));
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
  broadcast(IPC_CHANNELS.fleetStateUpdated, getFleetView());
  updateTrayTooltip(state);
});

if (isUninstallCleanup) {
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

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    applyLaunchOnLogin(appSettings.launchOnLogin);
    createWindow();
    createTray();
    updater = new UpdaterManager({
      currentVersion: app.getVersion(),
      eligible: app.isPackaged && !isPortableBuild(),
      prerelease: app.getVersion().includes('-'),
      logger
    });
    updater.on('changed', async (state: UpdaterState) => {
      broadcast(IPC_CHANNELS.updaterStateUpdated, state);
      updateTrayMenu();
      if (state.status === 'downloaded' && !isQuitting) {
        const response = await dialog.showMessageBox({
          type: 'info',
          title: 'Update ready',
          message: `${PRODUCT_NAME} ${state.availableVersion ?? ''} is ready to install.`,
          detail: 'Restart now, or choose Later to install when you quit the app.',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          cancelId: 1
        });
        if (response.response === 0) updater?.restartToUpdate();
      }
    });
    updater.setEnabled(appSettings.automaticUpdates);
    stateManager.start();
    fleetBridge.start();
    if (!appSettings.onboardingComplete) createSettingsWindow('onboarding');
    if (!app.isPackaged) showDashboard();
    logger.info(PRODUCT_NAME, app.getVersion(), app.isPackaged ? 'packaged' : 'development', migrationResult);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      showDashboard();
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  updater?.stop();
  stateManager.stop();
  fleetBridge.stop();
});

app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});
