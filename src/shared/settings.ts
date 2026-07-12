import type { CodexProfileId, CodexSortMode } from './limits';

export type InteractionMode = 'passive' | 'active';
export type FleetOpenTarget = 'windowsTerminal' | 'vscode';

export interface FleetNotificationSettings {
  hardLimits: boolean;
  deliveryFailures: boolean;
  deliverySuccess: boolean;
  hostState: boolean;
  versionDrift: boolean;
  pairing: boolean;
}

export interface CodexProfileSettings {
  id: CodexProfileId;
  label: string;
  enabled: boolean;
  order: number;
  distro: string;
  user: string;
  home: string;
  codexHome: string;
  executable: string;
}

export interface WidgetSettings {
  version: 3;
  codexProfiles: CodexProfileSettings[];
  codexSortMode: CodexSortMode;
  claudeEnabled: boolean;
  passiveOpacity: number;
  activeOpacity: number;
  launchOnLogin: boolean;
  automaticUpdates: boolean;
  onboardingComplete: boolean;
  fleetControllerDistro: string;
  fleetOpenTarget: FleetOpenTarget;
  limitsOverlayEnabled: boolean;
  fleetNotifications: FleetNotificationSettings;
  notificationPauseUntil: string | null;
}

export interface SettingsLoadResult {
  settings: WidgetSettings;
  recovered: boolean;
  migrated?: boolean;
  message?: string;
}

export interface SettingsExportEnvelope {
  format: 'ai-limits-widget-settings';
  exportVersion: 1;
  exportedAt: string;
  appVersion: string;
  settings: WidgetSettings;
}

export interface SettingsImportPreview {
  token: string;
  fileName: string;
  settings: WidgetSettings;
  warnings: string[];
}

export const SETTINGS_VERSION = 3;
export const SETTINGS_EXPORT_FORMAT = 'ai-limits-widget-settings';
export const SETTINGS_EXPORT_VERSION = 1;
export const MIN_OPACITY = 0;
export const DEFAULT_PASSIVE_OPACITY = 0.8;
export const DEFAULT_ACTIVE_OPACITY = 1;

export function createDefaultFleetNotifications(): FleetNotificationSettings {
  return {
    hardLimits: true,
    deliveryFailures: true,
    deliverySuccess: true,
    hostState: true,
    versionDrift: true,
    pairing: true
  };
}

export function createDefaultSettings(): WidgetSettings {
  return {
    version: SETTINGS_VERSION,
    codexProfiles: [],
    codexSortMode: 'highestAverageLeft',
    claudeEnabled: false,
    passiveOpacity: DEFAULT_PASSIVE_OPACITY,
    activeOpacity: DEFAULT_ACTIVE_OPACITY,
    launchOnLogin: false,
    automaticUpdates: true,
    onboardingComplete: false,
    fleetControllerDistro: 'Ubuntu',
    fleetOpenTarget: 'windowsTerminal',
    limitsOverlayEnabled: true,
    fleetNotifications: createDefaultFleetNotifications(),
    notificationPauseUntil: null
  };
}

export function normalizeSettings(input: unknown): SettingsLoadResult {
  const defaults = createDefaultSettings();
  if (!input || typeof input !== 'object') {
    return { settings: defaults, recovered: true, message: 'Settings were missing or invalid; defaults loaded' };
  }

  const raw = input as Record<string, unknown>;
  if (raw.version !== 1 && raw.version !== 2 && raw.version !== SETTINGS_VERSION) {
    return { settings: defaults, recovered: true, message: 'Settings version was unsupported; defaults loaded' };
  }

  const profiles = Array.isArray(raw.codexProfiles) ? normalizeProfiles(raw.codexProfiles) : [];
  const migrated = raw.version !== SETTINGS_VERSION;
  const claudeEnabled = typeof raw.claudeEnabled === 'boolean' ? raw.claudeEnabled : defaults.claudeEnabled;
  return {
    settings: {
      version: SETTINGS_VERSION,
      codexProfiles: profiles,
      codexSortMode: normalizeCodexSortMode(raw.codexSortMode, defaults.codexSortMode),
      claudeEnabled,
      passiveOpacity: clampOpacity(raw.passiveOpacity, defaults.passiveOpacity),
      activeOpacity: clampOpacity(raw.activeOpacity, defaults.activeOpacity),
      launchOnLogin: typeof raw.launchOnLogin === 'boolean' ? raw.launchOnLogin : defaults.launchOnLogin,
      automaticUpdates:
        typeof raw.automaticUpdates === 'boolean' ? raw.automaticUpdates : defaults.automaticUpdates,
      onboardingComplete:
        typeof raw.onboardingComplete === 'boolean'
          ? raw.onboardingComplete
          : migrated
            ? profiles.length > 0 || claudeEnabled
            : defaults.onboardingComplete,
      fleetControllerDistro: normalizeRequiredText(raw.fleetControllerDistro, defaults.fleetControllerDistro),
      fleetOpenTarget: raw.fleetOpenTarget === 'vscode' ? 'vscode' : 'windowsTerminal',
      limitsOverlayEnabled:
        typeof raw.limitsOverlayEnabled === 'boolean' ? raw.limitsOverlayEnabled : defaults.limitsOverlayEnabled,
      fleetNotifications: normalizeFleetNotifications(raw.fleetNotifications, defaults.fleetNotifications),
      notificationPauseUntil: normalizeInstantOrNull(raw.notificationPauseUntil)
    },
    recovered: false,
    migrated,
    message: migrated ? 'Settings were migrated to version 3' : undefined
  };
}

export function cloneSettings(settings: WidgetSettings): WidgetSettings {
  return {
    ...settings,
    codexProfiles: settings.codexProfiles.map((profile) => ({ ...profile })),
    fleetNotifications: { ...settings.fleetNotifications }
  };
}

function normalizeFleetNotifications(
  value: unknown,
  defaults: FleetNotificationSettings
): FleetNotificationSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    hardLimits: typeof raw.hardLimits === 'boolean' ? raw.hardLimits : defaults.hardLimits,
    deliveryFailures: typeof raw.deliveryFailures === 'boolean' ? raw.deliveryFailures : defaults.deliveryFailures,
    deliverySuccess: typeof raw.deliverySuccess === 'boolean' ? raw.deliverySuccess : defaults.deliverySuccess,
    hostState: typeof raw.hostState === 'boolean' ? raw.hostState : defaults.hostState,
    versionDrift: typeof raw.versionDrift === 'boolean' ? raw.versionDrift : defaults.versionDrift,
    pairing: typeof raw.pairing === 'boolean' ? raw.pairing : defaults.pairing
  };
}

function normalizeInstantOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

export function createProfileId(existingIds: readonly string[]): string {
  const used = new Set(existingIds);
  let index = 1;
  while (used.has(`codex-custom-${index}`)) index += 1;
  return `codex-custom-${index}`;
}

function normalizeProfiles(input: unknown[]): CodexProfileSettings[] {
  const profiles: CodexProfileSettings[] = [];
  const usedIds = new Set<string>();

  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const rawId = normalizeRequiredText(raw.id, `codex-${index + 1}`);
    const id = rawId.replace(/[^a-zA-Z0-9._-]+/g, '-');
    if (!id || usedIds.has(id)) continue;
    usedIds.add(id);

    profiles.push({
      id,
      label: normalizeRequiredText(raw.label, id),
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : index,
      distro: normalizeOptionalText(raw.distro),
      user: normalizeOptionalText(raw.user),
      home: normalizeOptionalText(raw.home),
      codexHome: normalizeOptionalText(raw.codexHome),
      executable: normalizeOptionalText(raw.executable)
    });
  }

  return profiles.sort((left, right) => left.order - right.order).map((profile, index) => ({ ...profile, order: index }));
}

function normalizeRequiredText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeOptionalText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampOpacity(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_OPACITY, Math.min(1, value));
}

function normalizeCodexSortMode(value: unknown, fallback: CodexSortMode): CodexSortMode {
  if (value === 'lowestRemaining' || value === 'highestAverageUse') return 'highestAverageLeft';
  return value === 'highestAverageLeft' || value === 'profileOrder' ? value : fallback;
}
