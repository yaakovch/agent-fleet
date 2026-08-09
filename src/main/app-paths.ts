import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, opendirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  durableAtomicWrite,
  matchesFileSnapshot,
  publishPreparedFileExclusive,
  quarantineFile,
  quarantinePath,
  readFileSnapshot,
  syncDirectory,
  withCrossProcessLock,
  type FileSnapshot
} from './durable-file';

export const PRODUCT_DATA_DIRECTORY = 'AI Limits Widget';
export const LEGACY_DATA_DIRECTORY = 'limits-widget';

const MIGRATION_MARKER = 'legacy-migration-v1.json';
const MIGRATION_JOURNAL = '.legacy-migration-v1.transaction.json';
const MIGRATABLE_FILES = ['settings.json', 'codex-profiles.json', 'claude-limits.json', 'window-state.json'] as const;
const MAX_MIGRATION_FILE_BYTES = 16 * 1024 * 1024;

export interface DataMigrationResult {
  migrated: boolean;
  copiedFiles: string[];
  message?: string;
}

export interface DataMigrationHooks {
  afterPrepared?(): void;
  afterFileCommitted?(fileName: string): void;
  afterMarkerCommitted?(): void;
}

interface MigrationJournal {
  version: 1;
  id: string;
  completedAt: string;
  entries: Array<{ fileName: typeof MIGRATABLE_FILES[number]; tempName: string; sha256: string; bytes: number }>;
}

export function getAppDataRoot(): string {
  return process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming');
}

export function getWidgetDataDir(appDataRoot = getAppDataRoot()): string {
  return process.env.AI_LIMITS_DATA_DIR || join(appDataRoot, PRODUCT_DATA_DIRECTORY);
}

export function getLegacyWidgetDataDir(appDataRoot = getAppDataRoot()): string {
  return join(appDataRoot, LEGACY_DATA_DIRECTORY);
}

export function migrateLegacyData(
  targetDir = getWidgetDataDir(),
  legacyDir = getLegacyWidgetDataDir(),
  now = new Date(),
  hooks: DataMigrationHooks = {}
): DataMigrationResult {
  const markerPath = join(targetDir, MIGRATION_MARKER);
  return withCrossProcessLock(markerPath, () => {
    mkdirSync(targetDir, { recursive: true });
    const recovered = recoverMigration(targetDir, markerPath, hooks);
    if (recovered) return recovered;
    cleanupOrphanMigrationTemps(targetDir);
    const existing = readValidMarker(markerPath, now);
    if (existing) return existing;

    const id = randomUUID();
    const entries: MigrationJournal['entries'] = [];
    try {
      if (existsSync(legacyDir)) {
        for (const fileName of MIGRATABLE_FILES) {
          const source = join(legacyDir, fileName);
          const target = join(targetDir, fileName);
          if (existsSync(target) || !existsSync(source)) continue;
          let snapshot: FileSnapshot;
          try {
            snapshot = readFileSnapshot(source, MAX_MIGRATION_FILE_BYTES);
          } catch {
            // Legacy data is never followed or mutated when it is not a regular,
            // bounded file. Preserve it in place and continue startup.
            continue;
          }
          const tempName = `.legacy-migration-${id}-${fileName}.prepared`;
          durableAtomicWrite(join(targetDir, tempName), snapshot.data, {
            expected: null,
            checkExpected: true,
            mode: 0o600
          });
          entries.push({ fileName, tempName, sha256: snapshot.sha256, bytes: snapshot.bytes });
        }
      }
    } catch (error) {
      for (const entry of entries) rmSync(join(targetDir, entry.tempName), { force: true });
      throw error;
    }

    const journal: MigrationJournal = {
      version: 1,
      id,
      completedAt: now.toISOString(),
      entries
    };
    durableAtomicWrite(join(targetDir, MIGRATION_JOURNAL), serialize(journal), {
      expected: null,
      checkExpected: true,
      mode: 0o600
    });
    hooks.afterPrepared?.();
    return commitMigration(targetDir, markerPath, journal, hooks);
  });
}

function recoverMigration(
  targetDir: string,
  markerPath: string,
  hooks: DataMigrationHooks
): DataMigrationResult | null {
  const journalPath = join(targetDir, MIGRATION_JOURNAL);
  if (!existsSync(journalPath)) return null;
  let snapshot: FileSnapshot;
  try {
    snapshot = readFileSnapshot(journalPath, 64 * 1024);
  } catch {
    quarantinePath(journalPath, 'corrupt-migration');
    return null;
  }
  let journal: MigrationJournal;
  try {
    journal = parseJournal(snapshot);
    for (const entry of journal.entries) {
      const preparedPath = join(targetDir, entry.tempName);
      const targetPath = join(targetDir, entry.fileName);
      if (!existsSync(preparedPath)) {
        if (matchesFileSnapshot(targetPath, entry, MAX_MIGRATION_FILE_BYTES)) continue;
        throw new Error('Prepared migration file failed verification');
      }
      const prepared = readFileSnapshot(preparedPath, MAX_MIGRATION_FILE_BYTES);
      if (prepared.bytes !== entry.bytes || prepared.sha256 !== entry.sha256) {
        throw new Error('Prepared migration file failed verification');
      }
    }
  } catch {
    quarantineFile(journalPath, snapshot, 'corrupt-migration');
    return null;
  }
  return commitMigration(targetDir, markerPath, journal, hooks);
}

function commitMigration(
  targetDir: string,
  markerPath: string,
  journal: MigrationJournal,
  hooks: DataMigrationHooks
): DataMigrationResult {
  const copiedFiles: string[] = [];
  for (const entry of journal.entries) {
    const preparedPath = join(targetDir, entry.tempName);
    const targetPath = join(targetDir, entry.fileName);
    if (existsSync(preparedPath)) publishPreparedFileExclusive(preparedPath, targetPath);
    try {
      if (matchesFileSnapshot(targetPath, entry, MAX_MIGRATION_FILE_BYTES)) copiedFiles.push(entry.fileName);
    } finally {
      rmSync(preparedPath, { force: true });
    }
    hooks.afterFileCommitted?.(entry.fileName);
  }
  const result: DataMigrationResult = {
    migrated: copiedFiles.length > 0,
    copiedFiles,
    message: copiedFiles.length > 0 ? `Migrated ${copiedFiles.length} legacy data file(s)` : undefined
  };
  const currentMarker = readValidMarker(markerPath, new Date(journal.completedAt));
  if (!currentMarker) {
    durableAtomicWrite(markerPath, serialize({ ...result, completedAt: journal.completedAt }), {
      expected: null,
      checkExpected: true,
      mode: 0o600
    });
  }
  hooks.afterMarkerCommitted?.();
  rmSync(join(targetDir, MIGRATION_JOURNAL), { force: true });
  syncDirectory(targetDir);
  return currentMarker ?? result;
}

function readValidMarker(markerPath: string, now: Date): DataMigrationResult | null {
  if (!existsSync(markerPath)) return null;
  let snapshot: FileSnapshot;
  try {
    snapshot = readFileSnapshot(markerPath, 64 * 1024);
  } catch {
    quarantinePath(markerPath, 'corrupt-migration-marker', now);
    return null;
  }
  try {
    return parseMigrationMarker(snapshot);
  } catch {
    quarantineFile(markerPath, snapshot, 'corrupt-migration-marker', now);
    return null;
  }
}

function parseMigrationMarker(snapshot: FileSnapshot): DataMigrationResult {
  const value = JSON.parse(snapshot.data.toString('utf8')) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || typeof value.migrated !== 'boolean'
    || !Array.isArray(value.copiedFiles) || value.copiedFiles.some((item) => !isMigratableFile(item))) {
    throw new Error('Legacy migration marker is invalid');
  }
  const copiedFiles = [...new Set(value.copiedFiles as string[])];
  return {
    migrated: value.migrated,
    copiedFiles,
    message: typeof value.message === 'string' ? value.message : undefined
  };
}

function parseJournal(snapshot: FileSnapshot): MigrationJournal {
  const value = JSON.parse(snapshot.data.toString('utf8')) as Partial<MigrationJournal>;
  if (value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.id)
    || typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt))
    || !Array.isArray(value.entries) || value.entries.length > MIGRATABLE_FILES.length) {
    throw new Error('Legacy migration journal is invalid');
  }
  const entries = value.entries.map((entry) => {
    if (!entry || !isMigratableFile(entry.fileName)
      || entry.tempName !== `.legacy-migration-${value.id}-${entry.fileName}.prepared`
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_MIGRATION_FILE_BYTES) {
      throw new Error('Legacy migration journal entry is invalid');
    }
    return entry;
  });
  if (new Set(entries.map((entry) => entry.fileName)).size !== entries.length) {
    throw new Error('Legacy migration journal contains duplicates');
  }
  return { version: 1, id: value.id, completedAt: value.completedAt, entries };
}

function cleanupOrphanMigrationTemps(targetDir: string): void {
  const directory = opendirSync(targetDir);
  try {
    for (let scanned = 0; scanned < 32; scanned += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      if (entry.isFile() && /^\.legacy-migration-[a-f0-9-]{36}-(?:settings|codex-profiles|claude-limits|window-state)\.json\.prepared$/u.test(entry.name)) {
        rmSync(join(targetDir, entry.name), { force: true });
      }
    }
  } finally {
    directory.closeSync();
  }
}

function isMigratableFile(value: unknown): value is typeof MIGRATABLE_FILES[number] {
  return typeof value === 'string' && (MIGRATABLE_FILES as readonly string[]).includes(value);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
