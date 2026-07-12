import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  cloneSettings,
  createDefaultSettings,
  normalizeSettings,
  SETTINGS_EXPORT_FORMAT,
  SETTINGS_EXPORT_VERSION,
  type SettingsExportEnvelope,
  type SettingsImportPreview,
  type SettingsLoadResult,
  type WidgetSettings
} from '../shared/settings';
import { getWidgetDataDir } from './app-paths';

export const MAX_SETTINGS_IMPORT_BYTES = 1024 * 1024;
const MAX_SETTINGS_BACKUPS = 5;

export function getSettingsPath(dataDir = getWidgetDataDir()): string {
  return join(dataDir, 'settings.json');
}

export function loadSettings(settingsPath = getSettingsPath()): SettingsLoadResult {
  if (!existsSync(settingsPath)) return { settings: createDefaultSettings(), recovered: false };

  try {
    const raw = readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '');
    const result = normalizeSettings(JSON.parse(raw));
    if (result.migrated) saveSettings(result.settings, settingsPath);
    return result;
  } catch {
    return {
      settings: createDefaultSettings(),
      recovered: true,
      message: 'Settings file could not be read; defaults loaded'
    };
  }
}

export function saveSettings(settings: WidgetSettings, settingsPath = getSettingsPath()): WidgetSettings {
  const normalized = normalizeSettings(settings).settings;
  atomicWriteJson(settingsPath, normalized);
  return cloneSettings(normalized);
}

export function createSettingsExport(settings: WidgetSettings, appVersion: string, now = new Date()): SettingsExportEnvelope {
  return {
    format: SETTINGS_EXPORT_FORMAT,
    exportVersion: SETTINGS_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    appVersion,
    settings: { ...cloneSettings(normalizeSettings(settings).settings), notificationPauseUntil: null }
  };
}

export function parseSettingsImport(content: string | Buffer, fileName = 'settings.json'): Omit<SettingsImportPreview, 'token'> {
  const byteLength = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
  if (byteLength > MAX_SETTINGS_IMPORT_BYTES) throw new Error('Settings import exceeds the 1 MiB limit');
  const text = typeof content === 'string' ? content.replace(/^\uFEFF/, '') : content.toString('utf8').replace(/^\uFEFF/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Settings import is not valid JSON');
  }
  if (!raw || typeof raw !== 'object') throw new Error('Settings import envelope is invalid');
  const envelope = raw as Partial<SettingsExportEnvelope>;
  if (envelope.format !== SETTINGS_EXPORT_FORMAT || envelope.exportVersion !== SETTINGS_EXPORT_VERSION) {
    throw new Error('Settings import format or version is unsupported');
  }
  const normalized = normalizeSettings(envelope.settings);
  if (normalized.recovered) throw new Error(normalized.message ?? 'Settings import is invalid');
  return {
    fileName: basename(fileName),
    settings: normalized.settings,
    warnings: getImportWarnings(normalized.settings)
  };
}

export function applyImportedSettings(settings: WidgetSettings, settingsPath = getSettingsPath(), now = new Date()): WidgetSettings {
  createSettingsBackup(settingsPath, now);
  return saveSettings(settings, settingsPath);
}

export function rollbackLatestSettings(settingsPath = getSettingsPath()): WidgetSettings | null {
  const backups = listSettingsBackups(settingsPath);
  const latest = backups[0];
  if (!latest) return null;
  const restored = loadSettings(latest).settings;
  createSettingsBackup(settingsPath);
  return saveSettings(restored, settingsPath);
}

export function listSettingsBackups(settingsPath = getSettingsPath()): string[] {
  const backupDir = join(dirname(settingsPath), 'backups');
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => /^settings-.*\.json$/i.test(name))
    .sort((left, right) => right.localeCompare(left))
    .map((name) => join(backupDir, name));
}

function createSettingsBackup(settingsPath: string, now = new Date()): void {
  if (!existsSync(settingsPath)) return;
  const backupDir = join(dirname(settingsPath), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(backupDir, `settings-${stamp}.json`), readFileSync(settingsPath));
  for (const oldBackup of listSettingsBackups(settingsPath).slice(MAX_SETTINGS_BACKUPS)) rmSync(oldBackup, { force: true });
}

function getImportWarnings(settings: WidgetSettings): string[] {
  const warnings: string[] = [];
  if (settings.codexProfiles.length === 0) warnings.push('The file contains no Codex profiles.');
  for (const profile of settings.codexProfiles) {
    const missing = [profile.distro, profile.user, profile.home, profile.codexHome, profile.executable].some((value) => !value);
    if (missing) warnings.push(`${profile.label} has incomplete WSL paths and must be reviewed.`);
    if (profile.executable && !/(^|\/)codex$/.test(profile.executable)) {
      warnings.push(`${profile.label} uses a non-standard executable path: ${profile.executable}`);
    }
  }
  if (settings.launchOnLogin) warnings.push('Importing will enable launch on login on this machine.');
  return warnings;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tempPath, filePath);
}
