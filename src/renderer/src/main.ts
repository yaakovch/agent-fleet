import './style.css';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleHelp,
  Download,
  ExternalLink,
  EyeOff,
  FileArchive,
  MousePointer2,
  MousePointerClick,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Undo2,
  Upload,
  Wrench,
  createIcons
} from 'lucide';
import type {
  AppInfo,
  ClaudeIntegrationState,
  SettingsImportSelection,
  UpdaterState,
  WslDiscoveryResult
} from '../../shared/app';
import type { CombinedLimitState, ProviderLimitSnapshot, ProviderStatus } from '../../shared/limits';
import { DashboardPrototype } from './dashboard-view';
import {
  cloneSettings,
  createDefaultSettings,
  createProfileId,
  MIN_OPACITY,
  type CodexProfileSettings,
  type InteractionMode,
  type WidgetSettings
} from '../../shared/settings';
import { renderLimitCell } from './widget-view';

const iconSet = {
  ArrowDown,
  ArrowUp,
  Check,
  CircleHelp,
  Download,
  ExternalLink,
  EyeOff,
  FileArchive,
  MousePointer2,
  MousePointerClick,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Undo2,
  Upload,
  Wrench
};

const appElement = document.querySelector<HTMLDivElement>('#app');
if (!appElement) throw new Error('Missing app root');
const appRoot = appElement;
const view = window.location.hash.slice(1);
const isDashboardView = view === 'dashboard';
const isSettingsView = view === 'settings';
const isOnboardingView = view === 'onboarding';
const isConfigView = isSettingsView || isOnboardingView;

let diagnosticsOpen = false;
let previousHasIssues: boolean | null = null;
let latestState: CombinedLimitState | null = null;
let interactionMode: InteractionMode = 'passive';
let settingsDraft: WidgetSettings | null = null;
let settingsMessage = '';
let appInfo: AppInfo | null = null;
let updaterState: UpdaterState | null = null;
let claudeIntegration: ClaudeIntegrationState | null = null;
let importPreview: SettingsImportSelection | null = null;
let discoveryResult: WslDiscoveryResult | null = null;
let onboardingStep = 0;
const profileTestMessages = new Map<string, string>();
const dashboard = isDashboardView ? new DashboardPrototype(appRoot) : null;

appRoot.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (!action) return;
  void handleAction(action, target);
});

appRoot.addEventListener('input', (event) => {
  if (!isConfigView || !settingsDraft) return;
  updateSettingsFromInput(event.target as HTMLInputElement | HTMLSelectElement);
});

appRoot.addEventListener('change', (event) => {
  if (!isConfigView || !settingsDraft) return;
  updateSettingsFromInput(event.target as HTMLInputElement | HTMLSelectElement);
});

window.limitsWidget.onStateUpdated((state) => {
  latestState = state;
  if (!isConfigView && !isDashboardView) renderWidget(state);
});
window.limitsWidget.onFleetStateUpdated((state) => {
  if (isDashboardView) dashboard?.setFleetState(state);
});
window.limitsWidget.onInteractionModeUpdated((mode) => {
  interactionMode = mode;
  if (!isConfigView && !isDashboardView && latestState) renderWidget(latestState);
});
window.limitsWidget.onUpdaterStateUpdated((state) => {
  updaterState = state;
  if (isConfigView) renderConfigView();
});

if (isDashboardView) {
  dashboard?.render();
  void Promise.all([window.limitsWidget.getFleetState(), window.limitsWidget.getSettings()]).then(([state, settings]) => {
    dashboard?.setSettings(settings.settings);
    dashboard?.setFleetState(state);
  });
}
else if (isConfigView) void loadConfigView();
else {
  void window.limitsWidget.getInteractionMode().then((mode) => {
    interactionMode = mode;
    if (latestState) renderWidget(latestState);
  });
  void window.limitsWidget.getState().then((state) => {
    latestState = state;
    renderWidget(state);
  });
}

async function handleAction(action: string, target: HTMLElement): Promise<void> {
  if (dashboard?.handleAction(action, target)) return;
  if (action === 'refresh') await refreshNow();
  if (action === 'diagnostics') {
    diagnosticsOpen = !diagnosticsOpen;
    if (latestState && !isConfigView) renderWidget(latestState);
  }
  if (action === 'hide') await window.limitsWidget.hide();
  if (action === 'settings') await window.limitsWidget.openSettings();
  if (action === 'mode') await toggleInteractionMode();
  if (action === 'save-settings') await saveSettings();
  if (action === 'reset-settings') resetSettings();
  if (action === 'add-profile') addProfile();
  if (action === 'remove-profile') removeProfile(target);
  if (action === 'move-profile-up') moveProfile(target, -1);
  if (action === 'move-profile-down') moveProfile(target, 1);
  if (action === 'test-profile') await testProfile(target);
  if (action === 'discover-wsl') await discoverProfiles();
  if (action === 'preview-import') await previewImport();
  if (action === 'apply-import') await applyImport();
  if (action === 'cancel-import') {
    importPreview = null;
    renderConfigView();
  }
  if (action === 'export-settings') await runFileOperation(() => window.limitsWidget.exportSettings());
  if (action === 'rollback-settings') await rollbackSettings();
  if (action === 'install-claude') await updateClaudeIntegration('install');
  if (action === 'remove-claude') await updateClaudeIntegration('remove');
  if (action === 'check-updates') {
    updaterState = (await window.limitsWidget.checkForUpdates()) ?? updaterState;
    renderConfigView();
  }
  if (action === 'restart-update') await window.limitsWidget.restartToUpdate();
  if (action === 'open-releases') await window.limitsWidget.openReleasePage();
  if (action === 'export-diagnostics') await runFileOperation(() => window.limitsWidget.exportDiagnostics());
  if (action === 'onboarding-back') {
    onboardingStep = Math.max(0, onboardingStep - 1);
    renderOnboarding();
  }
  if (action === 'onboarding-next') {
    onboardingStep = Math.min(3, onboardingStep + 1);
    renderOnboarding();
  }
  if (action === 'finish-onboarding') await finishOnboarding();
}

async function refreshNow(): Promise<void> {
  const state = await window.limitsWidget.refreshNow();
  latestState = state;
  if (!isConfigView) renderWidget(state);
}

async function toggleInteractionMode(): Promise<void> {
  interactionMode = await window.limitsWidget.setInteractionMode(interactionMode === 'active' ? 'passive' : 'active');
  if (latestState) renderWidget(latestState);
}

function renderWidget(state: CombinedLimitState): void {
  const hasIssues = state.diagnostics.some((item) => item.status !== 'ok');
  if (previousHasIssues === null) diagnosticsOpen = hasIssues;
  else if (hasIssues && !previousHasIssues) diagnosticsOpen = true;
  else if (!hasIssues && previousHasIssues) diagnosticsOpen = false;
  previousHasIssues = hasIssues;
  appRoot.innerHTML = `
    <main class="widget widget-${interactionMode}">
      <header class="titlebar">
        <div class="drag-region">
          <div class="title">AI Limits</div>
          <div class="subtitle">${state.refreshing ? 'Refreshing WSL profiles' : `Updated ${formatTime(state.updatedAt)}`}</div>
        </div>
        <div class="actions">
          ${iconButton('mode', interactionMode === 'active' ? 'mouse-pointer-click' : 'mouse-pointer-2', 'Toggle active/passive', 'mode-button')}
          ${iconButton('refresh', 'refresh-cw', 'Refresh now')}
          ${iconButton('diagnostics', 'circle-help', 'Diagnostics', hasIssues ? 'attention' : '')}
          ${iconButton('settings', 'settings', 'Settings')}
          ${iconButton('hide', 'eye-off', 'Hide')}
        </div>
      </header>
      <section class="limit-table" aria-label="Usage limits">
        <div class="table-header" aria-hidden="true"><span>Profile</span><span>5 hour</span><span>Weekly</span></div>
        ${state.providers.length ? state.providers.map(renderProviderRow).join('') : renderEmptyWidget()}
      </section>
      ${diagnosticsOpen ? renderDiagnostics(state) : ''}
    </main>`;
  refreshIcons();
}

function renderEmptyWidget(): string {
  return '<div class="widget-empty">No providers configured. Open Settings to add or discover profiles.</div>';
}

function renderProviderRow(provider: ProviderLimitSnapshot): string {
  return `
    <article class="provider-row provider-${provider.status}">
      <div class="profile-cell"><strong title="${escapeAttr(provider.label)}">${escapeHtml(provider.label)}</strong><span class="status-badge">${formatStatus(provider.status)}</span></div>
      ${renderLimitCell(provider.windows.fiveHour, provider.status)}
      ${renderLimitCell(provider.windows.weekly, provider.status)}
    </article>`;
}

function renderDiagnostics(state: CombinedLimitState): string {
  const issues = state.diagnostics.filter((item) => item.status !== 'ok');
  const items = (issues.length ? issues : state.diagnostics)
    .map((item) => `<li class="${item.status}"><span>${escapeHtml(item.label)}</span><small title="${escapeAttr(item.detail)}">${escapeHtml(item.detail)}</small></li>`)
    .join('');
  return `<section class="diagnostics" aria-label="Diagnostics"><div class="diagnostics-title">Self-check</div><ul>${items}</ul></section>`;
}

async function loadConfigView(): Promise<void> {
  const [settingsResult, info, update, claude] = await Promise.all([
    window.limitsWidget.getSettings(),
    window.limitsWidget.getAppInfo(),
    window.limitsWidget.getUpdaterState(),
    window.limitsWidget.getClaudeIntegration()
  ]);
  settingsDraft = cloneSettings(settingsResult.settings);
  settingsMessage = settingsResult.message ?? '';
  appInfo = info;
  updaterState = update;
  claudeIntegration = claude;
  renderConfigView();
}

function renderConfigView(): void {
  if (isOnboardingView) renderOnboarding();
  else renderSettings();
}

function renderSettings(): void {
  if (!settingsDraft) return;
  appRoot.innerHTML = `
    <main class="settings-shell">
      <header class="settings-header">
        <div><h1>Agent Fleet</h1><p>${escapeHtml(settingsMessage || 'Providers, overlay appearance, transfer, updates, and support.')}</p></div>
        <div class="settings-actions"><button data-action="reset-settings">${icon('rotate-ccw')}Reset</button><button class="primary" data-action="save-settings">${icon('save')}Save</button></div>
      </header>
      ${renderTransferSection()}
      ${renderWidgetSettingsSection()}
      ${renderClaudeSection()}
      ${renderProfilesSection()}
      ${renderSupportSection()}
    </main>`;
  refreshIcons();
}

function renderTransferSection(): string {
  return `
    <section class="settings-section">
      <div class="section-title-row"><h2>Settings transfer</h2><div class="inline-actions"><button data-action="preview-import">${icon('upload')}Import</button><button data-action="export-settings">${icon('download')}Export</button><button data-action="rollback-settings">${icon('undo-2')}Rollback</button></div></div>
      ${renderImportPreview()}
    </section>`;
}

function renderImportPreview(): string {
  if (!importPreview) return '<p class="section-note">Exports contain provider and widget configuration only. Authentication and usage data are never included.</p>';
  const warnings = importPreview.warnings.length
    ? `<ul class="warning-list">${importPreview.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
    : '<p class="success-note">The file passed validation with no warnings.</p>';
  return `<div class="import-preview"><strong>${escapeHtml(importPreview.fileName)}</strong><span>${importPreview.profileCount} Codex profile(s)</span>${warnings}<div class="inline-actions"><button data-action="cancel-import">Cancel</button><button class="primary" data-action="apply-import">Replace settings</button></div></div>`;
}

function renderWidgetSettingsSection(): string {
  if (!settingsDraft) return '';
  return `
    <section class="settings-section"><h2>Widget</h2><div class="settings-grid">
      <label>Passive opacity<input data-setting="passiveOpacity" type="number" min="${MIN_OPACITY}" max="1" step="0.05" value="${settingsDraft.passiveOpacity}"></label>
      <label>Active opacity<input data-setting="activeOpacity" type="number" min="${MIN_OPACITY}" max="1" step="0.05" value="${settingsDraft.activeOpacity}"></label>
      <label>Codex row order<select data-setting="codexSortMode"><option value="highestAverageLeft" ${settingsDraft.codexSortMode === 'highestAverageLeft' ? 'selected' : ''}>Highest average left</option><option value="profileOrder" ${settingsDraft.codexSortMode === 'profileOrder' ? 'selected' : ''}>Configured order</option></select></label>
      <label class="checkbox-row"><input data-setting="launchOnLogin" type="checkbox" ${settingsDraft.launchOnLogin ? 'checked' : ''} ${appInfo?.portable ? 'disabled' : ''}>Launch on login</label>
      <label class="checkbox-row"><input data-setting="automaticUpdates" type="checkbox" ${settingsDraft.automaticUpdates ? 'checked' : ''} ${appInfo?.packaged && !appInfo.portable ? '' : 'disabled'}>Automatic update checks</label>
    </div>${appInfo?.portable ? '<p class="section-note">Launch on login and automatic installation are unavailable in the portable build.</p>' : ''}</section>`;
}

function renderClaudeSection(): string {
  if (!settingsDraft) return '';
  const ready = claudeIntegration?.status === 'ready' || claudeIntegration?.status === 'installed' || claudeIntegration?.status === 'updated';
  return `
    <section class="settings-section">
      <div class="section-title-row"><div><h2>Claude Code</h2><p class="section-note">${escapeHtml(claudeIntegration?.message ?? 'Inspecting integration...')}</p></div><div class="inline-actions">${ready ? `<button data-action="remove-claude">${icon('trash-2')}Remove integration</button>` : `<button class="primary" data-action="install-claude" ${claudeIntegration?.status === 'conflict' ? 'disabled' : ''}>${icon('wrench')}Install / repair</button>`}</div></div>
      <label class="checkbox-row"><input data-setting="claudeEnabled" type="checkbox" ${settingsDraft.claudeEnabled ? 'checked' : ''}>Show Claude Code row</label>
    </section>`;
}

function renderProfilesSection(): string {
  if (!settingsDraft) return '';
  const profiles = settingsDraft.codexProfiles.slice().sort((a, b) => a.order - b.order);
  return `
    <section class="settings-section"><div class="section-title-row"><h2>Codex profiles</h2><div class="inline-actions"><button data-action="discover-wsl">${icon('search')}Discover</button><button data-action="add-profile">${icon('plus')}Add</button></div></div>
      ${discoveryResult?.warnings.length ? `<ul class="warning-list">${discoveryResult.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}
      <div class="profile-settings-list">${profiles.length ? profiles.map(renderProfileSettings).join('') : '<div class="empty-panel">No Codex profiles configured.</div>'}</div>
    </section>`;
}

function renderSupportSection(): string {
  const update = updaterState ?? { status: 'disabled', currentVersion: appInfo?.version ?? '' };
  return `
    <section class="settings-section support-section"><div class="section-title-row"><div><h2>About and support</h2><p class="section-note">Version ${escapeHtml(appInfo?.version ?? '')} · ${appInfo?.portable ? 'Portable' : appInfo?.packaged ? 'Installed' : 'Development'}</p></div><span class="status-pill status-${update.status}">${escapeHtml(formatUpdateState(update))}</span></div>
      <div class="inline-actions support-actions">
        <button data-action="${update.status === 'downloaded' ? 'restart-update' : 'check-updates'}">${icon('refresh-cw')}${update.status === 'downloaded' ? 'Restart to update' : 'Check for updates'}</button>
        <button data-action="open-releases">${icon('external-link')}Releases</button>
        <button data-action="export-diagnostics">${icon('file-archive')}Export diagnostics</button>
      </div>
      <p class="data-path">Data: ${escapeHtml(appInfo?.dataDirectory ?? '')}</p>
    </section>`;
}

function renderProfileSettings(profile: CodexProfileSettings, index: number, profiles: CodexProfileSettings[]): string {
  const message = profileTestMessages.get(profile.id) ?? '';
  return `
    <article class="profile-settings" data-profile-id="${escapeAttr(profile.id)}">
      <div class="profile-settings-title"><label class="checkbox-row"><input data-profile-field="enabled" type="checkbox" ${profile.enabled ? 'checked' : ''}><strong>${escapeHtml(profile.label)}</strong></label>
        <div class="profile-buttons">${smallIconButton('move-profile-up', 'arrow-up', 'Move up', index === 0)}${smallIconButton('move-profile-down', 'arrow-down', 'Move down', index === profiles.length - 1)}${smallIconButton('test-profile', 'shield-check', 'Test profile')}${smallIconButton('remove-profile', 'trash-2', 'Remove profile')}</div></div>
      <div class="profile-grid">${renderProfileInput('label', 'Label', profile.label)}${renderProfileInput('distro', 'WSL distro', profile.distro)}${renderProfileInput('user', 'Linux user', profile.user)}${renderProfileInput('home', 'HOME', profile.home)}${renderProfileInput('codexHome', 'CODEX_HOME', profile.codexHome)}${renderProfileInput('executable', 'Executable', profile.executable)}</div>
      ${message ? `<div class="profile-test-result">${escapeHtml(message)}</div>` : ''}
    </article>`;
}

function renderOnboarding(): void {
  if (!settingsDraft) return;
  const steps = ['Start', 'Codex', 'Claude', 'Finish'];
  appRoot.innerHTML = `
    <main class="settings-shell onboarding-shell">
      <header class="settings-header"><div><h1>Set up Agent Fleet</h1><p>${escapeHtml(settingsMessage || 'Configure local providers. No authentication data leaves this computer.')}</p></div></header>
      <nav class="stepper" aria-label="Setup progress">${steps.map((label, index) => `<span class="${index === onboardingStep ? 'current' : index < onboardingStep ? 'complete' : ''}">${index < onboardingStep ? icon('check') : index + 1}<small>${label}</small></span>`).join('')}</nav>
      <section class="onboarding-content">${renderOnboardingStep()}</section>
      <footer class="onboarding-footer">${onboardingStep > 0 ? '<button data-action="onboarding-back">Back</button>' : '<span></span>'}${onboardingStep < 3 ? '<button class="primary" data-action="onboarding-next">Continue</button>' : `<button class="primary" data-action="finish-onboarding">${icon('check')}Finish setup</button>`}</footer>
    </main>`;
  refreshIcons();
}

function renderOnboardingStep(): string {
  if (!settingsDraft) return '';
  if (onboardingStep === 0) {
    return `<div class="onboarding-intro"><h2>Bring settings or discover this PC</h2><p>Import a configuration from another machine, or scan WSL for Codex profiles. Both paths remain editable before setup finishes.</p><div class="choice-grid"><button data-action="preview-import">${icon('upload')}<strong>Import settings</strong><span>Preview and safely replace configuration</span></button><button data-action="discover-wsl">${icon('search')}<strong>Discover WSL</strong><span>Find distros, Codex, and profile homes</span></button></div>${renderImportPreview()}${discoveryResult ? `<p class="success-note">Found ${discoveryResult.profiles.length} profile(s) in ${discoveryResult.distributions.length} distribution(s).</p>` : ''}</div>`;
  }
  if (onboardingStep === 1) return `<div><div class="section-title-row"><div><h2>Codex profiles</h2><p class="section-note">Review, edit, and test the profiles that will be shown.</p></div><div class="inline-actions"><button data-action="discover-wsl">${icon('search')}Scan again</button><button data-action="add-profile">${icon('plus')}Add</button></div></div><div class="profile-settings-list">${settingsDraft.codexProfiles.length ? settingsDraft.codexProfiles.map(renderProfileSettings).join('') : '<div class="empty-panel">No profiles selected. You can continue and add them later.</div>'}</div></div>`;
  if (onboardingStep === 2) return `<div><h2>Claude Code integration</h2><p>The app reads Claude limits through a local status-line collector. Installation backs up Claude settings and never replaces a different status line.</p><div class="integration-panel"><span class="status-pill status-${claudeIntegration?.status ?? 'missing'}">${escapeHtml(claudeIntegration?.status ?? 'checking')}</span><p>${escapeHtml(claudeIntegration?.message ?? '')}</p><div class="inline-actions">${claudeIntegration?.status === 'ready' ? `<button data-action="remove-claude">${icon('trash-2')}Remove</button>` : `<button class="primary" data-action="install-claude" ${claudeIntegration?.status === 'conflict' ? 'disabled' : ''}>${icon('wrench')}Install / repair</button>`}</div></div><label class="checkbox-row"><input data-setting="claudeEnabled" type="checkbox" ${settingsDraft.claudeEnabled ? 'checked' : ''}>Show Claude Code in the widget</label></div>`;
  return `<div><h2>Widget preferences</h2><div class="settings-grid"><label>Passive opacity<input data-setting="passiveOpacity" type="number" min="0" max="1" step="0.05" value="${settingsDraft.passiveOpacity}"></label><label>Active opacity<input data-setting="activeOpacity" type="number" min="0" max="1" step="0.05" value="${settingsDraft.activeOpacity}"></label><label>Codex row order<select data-setting="codexSortMode"><option value="highestAverageLeft" ${settingsDraft.codexSortMode === 'highestAverageLeft' ? 'selected' : ''}>Highest average left</option><option value="profileOrder" ${settingsDraft.codexSortMode === 'profileOrder' ? 'selected' : ''}>Configured order</option></select></label><label class="checkbox-row"><input data-setting="launchOnLogin" type="checkbox" ${settingsDraft.launchOnLogin ? 'checked' : ''} ${appInfo?.portable ? 'disabled' : ''}>Launch on login</label><label class="checkbox-row"><input data-setting="automaticUpdates" type="checkbox" ${settingsDraft.automaticUpdates ? 'checked' : ''} ${appInfo?.packaged && !appInfo.portable ? '' : 'disabled'}>Automatic update checks</label></div><div class="setup-summary"><strong>Ready to finish</strong><span>${settingsDraft.codexProfiles.length} Codex profile(s)</span><span>Claude ${settingsDraft.claudeEnabled ? 'enabled' : 'disabled'}</span><span>Settings remain local in ${escapeHtml(appInfo?.dataDirectory ?? '')}</span></div></div>`;
}

function renderProfileInput(field: keyof CodexProfileSettings, label: string, value: string): string {
  return `<label>${escapeHtml(label)}<input data-profile-field="${field}" value="${escapeAttr(value)}"></label>`;
}

function updateSettingsFromInput(input: HTMLInputElement | HTMLSelectElement): void {
  if (!settingsDraft) return;
  const setting = input.dataset.setting as keyof WidgetSettings | undefined;
  if (setting === 'passiveOpacity' || setting === 'activeOpacity') {
    settingsDraft[setting] = clampNumber((input as HTMLInputElement).valueAsNumber, MIN_OPACITY, 1);
  }
  if (setting === 'codexSortMode') settingsDraft.codexSortMode = input.value === 'profileOrder' ? 'profileOrder' : 'highestAverageLeft';
  if (setting === 'launchOnLogin' || setting === 'claudeEnabled' || setting === 'automaticUpdates') {
    settingsDraft[setting] = (input as HTMLInputElement).checked;
  }
  const field = input.dataset.profileField as keyof CodexProfileSettings | undefined;
  const profile = findProfileElement(input);
  if (!field || !profile) return;
  if (field === 'enabled') profile.enabled = (input as HTMLInputElement).checked;
  else if (field !== 'order') profile[field] = input.value;
}

async function saveSettings(): Promise<void> {
  if (!settingsDraft) return;
  normalizeProfileOrder(settingsDraft);
  const result = await window.limitsWidget.saveSettings(settingsDraft);
  settingsDraft = cloneSettings(result.settings);
  settingsMessage = result.message ?? 'Settings saved and refresh started.';
  renderConfigView();
}

function resetSettings(): void {
  const defaults = createDefaultSettings();
  defaults.onboardingComplete = true;
  settingsDraft = defaults;
  profileTestMessages.clear();
  settingsMessage = 'Defaults restored locally. Save to apply.';
  renderConfigView();
}

function addProfile(): void {
  if (!settingsDraft) return;
  const id = createProfileId(settingsDraft.codexProfiles.map((profile) => profile.id));
  settingsDraft.codexProfiles.push({ id, label: id, enabled: true, order: settingsDraft.codexProfiles.length, distro: 'Ubuntu', user: '', home: '', codexHome: '', executable: 'codex' });
  renderConfigView();
}

function removeProfile(target: HTMLElement): void {
  if (!settingsDraft) return;
  const id = target.closest<HTMLElement>('[data-profile-id]')?.dataset.profileId;
  if (!id) return;
  settingsDraft.codexProfiles = settingsDraft.codexProfiles.filter((profile) => profile.id !== id);
  profileTestMessages.delete(id);
  normalizeProfileOrder(settingsDraft);
  renderConfigView();
}

function moveProfile(target: HTMLElement, delta: number): void {
  if (!settingsDraft) return;
  const id = target.closest<HTMLElement>('[data-profile-id]')?.dataset.profileId;
  if (!id) return;
  const profiles = settingsDraft.codexProfiles.slice().sort((a, b) => a.order - b.order);
  const index = profiles.findIndex((profile) => profile.id === id);
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= profiles.length) return;
  [profiles[index], profiles[nextIndex]] = [profiles[nextIndex], profiles[index]];
  settingsDraft.codexProfiles = profiles.map((profile, order) => ({ ...profile, order }));
  renderConfigView();
}

async function testProfile(target: HTMLElement): Promise<void> {
  const profile = findProfileElement(target);
  if (!profile) return;
  profileTestMessages.set(profile.id, 'Testing...');
  renderConfigView();
  const result = await window.limitsWidget.testCodexProfile(profile);
  profileTestMessages.set(profile.id, result.message);
  renderConfigView();
}

async function discoverProfiles(): Promise<void> {
  settingsMessage = 'Scanning WSL distributions...';
  renderConfigView();
  discoveryResult = await window.limitsWidget.discoverWsl();
  if (settingsDraft && discoveryResult.profiles.length) settingsDraft.codexProfiles = discoveryResult.profiles.map((profile) => ({ ...profile }));
  settingsMessage = discoveryResult.wslAvailable ? `Found ${discoveryResult.profiles.length} Codex profile(s).` : 'WSL is not available.';
  if (isOnboardingView && discoveryResult.wslAvailable) onboardingStep = 1;
  renderConfigView();
}

async function previewImport(): Promise<void> {
  try {
    importPreview = await window.limitsWidget.previewSettingsImport();
    settingsMessage = importPreview ? 'Review the import before replacing settings.' : 'Import canceled.';
  } catch (error) {
    settingsMessage = error instanceof Error ? error.message : String(error);
  }
  renderConfigView();
}

async function applyImport(): Promise<void> {
  if (!importPreview) return;
  const result = await window.limitsWidget.applySettingsImport(importPreview.token);
  settingsDraft = cloneSettings(result.settings);
  settingsMessage = 'Settings imported. Review provider integrations on this machine.';
  importPreview = null;
  claudeIntegration = await window.limitsWidget.getClaudeIntegration();
  if (isOnboardingView) onboardingStep = 1;
  renderConfigView();
}

async function rollbackSettings(): Promise<void> {
  const result = await window.limitsWidget.rollbackSettings();
  settingsMessage = result.message;
  if (result.settings) settingsDraft = cloneSettings(result.settings);
  renderConfigView();
}

async function updateClaudeIntegration(action: 'install' | 'remove'): Promise<void> {
  claudeIntegration = action === 'install' ? await window.limitsWidget.installClaudeIntegration() : await window.limitsWidget.removeClaudeIntegration();
  const result = await window.limitsWidget.getSettings();
  settingsDraft = cloneSettings(result.settings);
  settingsMessage = claudeIntegration.message;
  renderConfigView();
}

async function finishOnboarding(): Promise<void> {
  if (!settingsDraft) return;
  settingsDraft.onboardingComplete = true;
  normalizeProfileOrder(settingsDraft);
  await window.limitsWidget.saveSettings(settingsDraft);
  window.close();
}

async function runFileOperation(operation: () => Promise<{ message: string }>): Promise<void> {
  try {
    settingsMessage = (await operation()).message;
  } catch (error) {
    settingsMessage = error instanceof Error ? error.message : String(error);
  }
  renderConfigView();
}

function findProfileElement(element: HTMLElement): CodexProfileSettings | undefined {
  const id = element.closest<HTMLElement>('[data-profile-id]')?.dataset.profileId;
  return settingsDraft?.codexProfiles.find((profile) => profile.id === id);
}

function normalizeProfileOrder(settings: WidgetSettings): void {
  settings.codexProfiles = settings.codexProfiles.slice().sort((a, b) => a.order - b.order).map((profile, order) => ({ ...profile, order }));
}

function clampNumber(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

function formatStatus(status: ProviderStatus): string {
  if (status === 'unavailable') return 'NO DATA';
  if (status === 'loading') return 'WAIT';
  return status.toUpperCase();
}

function formatUpdateState(state: UpdaterState): string {
  if (state.status === 'downloading') return `Downloading ${Math.round(state.progressPercent ?? 0)}%`;
  if (state.status === 'downloaded') return `${state.availableVersion ?? 'Update'} ready`;
  if (state.status === 'up-to-date') return 'Up to date';
  return state.status.replaceAll('-', ' ');
}

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function icon(name: string): string {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function iconButton(action: string, iconName: string, label: string, className = ''): string {
  return `<button class="icon-button ${className}" data-action="${action}" title="${label}" aria-label="${label}">${icon(iconName)}</button>`;
}

function smallIconButton(action: string, iconName: string, label: string, disabled = false): string {
  return `<button class="small-icon-button" data-action="${action}" title="${label}" aria-label="${label}" ${disabled ? 'disabled' : ''}>${icon(iconName)}</button>`;
}

function refreshIcons(): void {
  createIcons({ icons: iconSet });
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
