import { existsSync, readdirSync, rmSync } from 'node:fs';
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
import {
  ConcurrentFileModificationError,
  durableAtomicWrite,
  durablePublishExclusive,
  matchesFileSnapshot,
  quarantineFile,
  quarantinePath,
  quarantineUnreadablePath,
  readFileSnapshot,
  readOptionalFileSnapshot,
  readPathIdentity,
  syncDirectory,
  withCrossProcessLock,
  type FileSnapshot,
  type PathIdentity
} from './durable-file';

export const MAX_SETTINGS_IMPORT_BYTES = 1024 * 1024;
const MAX_SETTINGS_BACKUPS = 5;

export function getSettingsPath(dataDir = getWidgetDataDir()): string {
  return join(dataDir, 'settings.json');
}

export function loadSettings(settingsPath = getSettingsPath(), now = new Date()): SettingsLoadResult {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let snapshot: FileSnapshot | null;
    try {
      snapshot = readOptionalFileSnapshot(settingsPath, MAX_SETTINGS_IMPORT_BYTES);
    } catch (error) {
      if (error instanceof ConcurrentFileModificationError) continue;
      const observed = observedPathIdentity(settingsPath);
      if (!observed) continue;
      const quarantined = withCrossProcessLock(settingsPath, () =>
        quarantineUnreadablePath(
          settingsPath,
          observed,
          MAX_SETTINGS_IMPORT_BYTES,
          'corrupt-settings',
          now
        ));
      if (!quarantined) continue;
      return {
        settings: createDefaultSettings(),
        recovered: true,
        message: `Settings were unreadable; evidence was preserved as ${basename(quarantined)} and defaults loaded`
      };
    }
    if (!snapshot) return { settings: createDefaultSettings(), recovered: false };
    try {
      const result = parseStoredSettings(snapshot);
      if (result.migrated && !persistSettingsMigration(settingsPath, snapshot, result.settings, now)) continue;
      return result;
    } catch (error) {
      if (error instanceof ConcurrentFileModificationError) continue;
      const quarantined = withCrossProcessLock(settingsPath, () =>
        quarantineFile(settingsPath, snapshot, 'corrupt-settings', now));
      if (!quarantined) continue;
      return {
        settings: createDefaultSettings(),
        recovered: true,
        message: `Settings were invalid; evidence was preserved as ${basename(quarantined)} and defaults loaded`
      };
    }
  }
  throw new ConcurrentFileModificationError(settingsPath);
}

export function saveSettings(settings: WidgetSettings, settingsPath = getSettingsPath()): WidgetSettings {
  const normalized = normalizeSettings(settings).settings;
  withCrossProcessLock(settingsPath, () => {
    const current = currentSettingsForReplacement(settingsPath);
    durableAtomicWrite(settingsPath, serializeJson(normalized), {
      expected: current,
      checkExpected: true,
      mode: 0o600
    });
  });
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
  const normalized = normalizeSettings(settings).settings;
  withCrossProcessLock(settingsPath, () => {
    const current = currentSettingsForReplacement(settingsPath, now);
    if (current) createSettingsBackup(current, settingsPath, now);
    durableAtomicWrite(settingsPath, serializeJson(normalized), {
      expected: current,
      checkExpected: true,
      mode: 0o600
    });
    pruneSettingsBackups(settingsPath);
  });
  return cloneSettings(normalized);
}

export function rollbackLatestSettings(settingsPath = getSettingsPath()): WidgetSettings | null {
  return withCrossProcessLock(settingsPath, () => {
    let restored: WidgetSettings | null = null;
    for (const backupPath of listSettingsBackups(settingsPath)) {
      let snapshot: FileSnapshot;
      try {
        snapshot = readFileSnapshot(backupPath, MAX_SETTINGS_IMPORT_BYTES);
      } catch {
        quarantinePath(backupPath, 'corrupt-backup');
        continue;
      }
      try {
        restored = parseStoredSettings(snapshot).settings;
        break;
      } catch {
        quarantineFile(backupPath, snapshot, 'corrupt-backup');
      }
    }
    if (!restored) return null;
    const current = currentSettingsForReplacement(settingsPath);
    if (current) createSettingsBackup(current, settingsPath);
    durableAtomicWrite(settingsPath, serializeJson(restored), {
      expected: current,
      checkExpected: true,
      mode: 0o600
    });
    pruneSettingsBackups(settingsPath);
    return cloneSettings(restored);
  });
}

export function listSettingsBackups(settingsPath = getSettingsPath()): string[] {
  const backupDir = join(dirname(settingsPath), 'backups');
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => /^settings-.*\.json$/i.test(name))
    .sort((left, right) => right.localeCompare(left))
    .map((name) => join(backupDir, name));
}

function createSettingsBackup(snapshot: FileSnapshot, settingsPath: string, now = new Date()): string {
  const backupDir = join(dirname(settingsPath), 'backups');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let backupPath = join(backupDir, `settings-${stamp}.json`);
  if (!durablePublishExclusive(backupPath, snapshot.data)) {
    backupPath = join(backupDir, `settings-${stamp}-${snapshot.sha256.slice(0, 12)}.json`);
    if (!durablePublishExclusive(backupPath, snapshot.data)) {
      if (matchesFileSnapshot(backupPath, snapshot, MAX_SETTINGS_IMPORT_BYTES)) return backupPath;
      throw new Error('A settings backup with the same name already exists');
    }
  }
  return backupPath;
}

function pruneSettingsBackups(settingsPath: string): void {
  for (const oldBackup of listSettingsBackups(settingsPath).slice(MAX_SETTINGS_BACKUPS)) rmSync(oldBackup, { force: true });
  const backupDir = join(dirname(settingsPath), 'backups');
  if (existsSync(backupDir)) syncDirectory(backupDir);
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

function parseStoredSettings(snapshot: FileSnapshot): SettingsLoadResult {
  const raw = snapshot.data.toString('utf8').replace(/^\uFEFF/u, '');
  const result = normalizeSettings(JSON.parse(raw));
  if (result.recovered) throw new Error(result.message ?? 'Settings are invalid');
  return result;
}

function isValidStoredSettings(snapshot: FileSnapshot): boolean {
  try {
    parseStoredSettings(snapshot);
    return true;
  } catch {
    return false;
  }
}

function currentSettingsForReplacement(settingsPath: string, now = new Date()): FileSnapshot | null {
  let current: FileSnapshot | null;
  try {
    current = readOptionalFileSnapshot(settingsPath, MAX_SETTINGS_IMPORT_BYTES);
  } catch {
    const quarantined = quarantinePath(settingsPath, 'corrupt-settings', now);
    if (!quarantined) throw new ConcurrentFileModificationError(settingsPath);
    return null;
  }
  if (!current || isValidStoredSettings(current)) return current;
  const quarantined = quarantineFile(settingsPath, current, 'corrupt-settings', now);
  if (!quarantined) throw new ConcurrentFileModificationError(settingsPath);
  return null;
}

function persistSettingsMigration(
  settingsPath: string,
  source: FileSnapshot,
  settings: WidgetSettings,
  now: Date
): boolean {
  return withCrossProcessLock(settingsPath, () => {
    if (!matchesFileSnapshot(settingsPath, source, MAX_SETTINGS_IMPORT_BYTES)) return false;
    createSettingsBackup(source, settingsPath, now);
    durableAtomicWrite(settingsPath, serializeJson(settings), {
      expected: source,
      checkExpected: true,
      mode: 0o600
    });
    pruneSettingsBackups(settingsPath);
    return true;
  });
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function observedPathIdentity(path: string): PathIdentity | null {
  try {
    return readPathIdentity(path);
  } catch {
    return null;
  }
}
