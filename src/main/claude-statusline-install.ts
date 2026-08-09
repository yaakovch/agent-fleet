import { randomUUID } from 'node:crypto';
import { existsSync, opendirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getWidgetDataDir } from './app-paths';
import {
  ConcurrentFileModificationError,
  durableAtomicWrite,
  durablePublishExclusive,
  matchesFileSnapshot,
  quarantineFile,
  quarantinePath,
  readFileSnapshot,
  readOptionalFileSnapshot,
  syncDirectory,
  withCrossProcessLock,
  type FileSnapshot
} from './durable-file';

export interface ClaudeStatusLinePaths {
  sourceScript: string;
  targetScript: string;
  settingsPath: string;
}

export interface ClaudeStatusLineInstallResult {
  status: 'ready' | 'installed' | 'updated' | 'removed' | 'missing' | 'conflict';
  message: string;
}

export interface ClaudeStatusLineTransactionHooks {
  afterPrepared?(operation: 'install' | 'remove'): void;
  afterScriptCommitted?(operation: 'install' | 'remove'): void;
  beforeSettingsCommit?(operation: 'install' | 'remove'): void;
  afterSettingsCommitted?(operation: 'install' | 'remove'): void;
}

interface ClaudeSettings {
  statusLine?: {
    type?: string;
    command?: string;
    refreshInterval?: number;
    padding?: number;
  };
  [key: string]: unknown;
}

interface SnapshotReference {
  sha256: string;
  bytes: number;
}

interface ClaudeTransactionJournal {
  version: 1;
  id: string;
  operation: 'install' | 'remove';
  expectedSettings: SnapshotReference | null;
  desiredSettings: SnapshotReference;
  settingsTempName: string;
  expectedScript: SnapshotReference | null;
  desiredScript: SnapshotReference | null;
  scriptTempName: string | null;
  result: ClaudeStatusLineInstallResult;
}

const SCRIPT_NAME = 'claude-statusline.ps1';
const MAX_CLAUDE_SETTINGS_BYTES = 1024 * 1024;
const MAX_STATUS_LINE_SCRIPT_BYTES = 4 * 1024 * 1024;

export function getClaudeStatusLinePaths(resourceRoot: string, dataDir = getWidgetDataDir()): ClaudeStatusLinePaths {
  const userProfile = process.env.USERPROFILE ?? process.env.HOME;
  if (!userProfile) throw new Error('Cannot resolve the user profile directory.');
  return {
    sourceScript: join(resourceRoot, 'scripts', SCRIPT_NAME),
    targetScript: join(dataDir, SCRIPT_NAME),
    settingsPath: join(userProfile, '.claude', 'settings.json')
  };
}

export function buildClaudeStatusLineCommand(targetScript: string): string {
  const commandPath = targetScript.replaceAll('\\', '/');
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${commandPath}"`;
}

export function isLimitsWidgetStatusLine(
  command: string | undefined,
  targetScript = join(getWidgetDataDir(), SCRIPT_NAME)
): boolean {
  if (!command) return false;
  const match = /^powershell\.exe -NoProfile -ExecutionPolicy Bypass -File "([^"\r\n]+)"$/iu.exec(command);
  if (!match) return false;
  return ownedStatusLinePaths(targetScript).has(normalizeCommandPath(match[1]));
}

export function ensureClaudeStatusLineInstalled(
  paths: ClaudeStatusLinePaths,
  now = new Date(),
  hooks: ClaudeStatusLineTransactionHooks = {}
): ClaudeStatusLineInstallResult {
  if (!existsSync(paths.sourceScript)) throw new Error(`Claude status-line source is missing: ${paths.sourceScript}`);
  return withCrossProcessLock(paths.settingsPath, () => {
    recoverClaudeTransaction(paths, hooks);
    const source = readFileSnapshot(paths.sourceScript, MAX_STATUS_LINE_SCRIPT_BYTES);
    const settingsSnapshot = readOptionalFileSnapshot(paths.settingsPath, MAX_CLAUDE_SETTINGS_BYTES);
    const settings = parseClaudeSettings(settingsSnapshot);
    const existingCommand = settings.statusLine?.command;
    const expectedCommand = buildClaudeStatusLineCommand(paths.targetScript);
    if (existingCommand && existingCommand !== expectedCommand
      && !isLimitsWidgetStatusLine(existingCommand, paths.targetScript)) {
      return { status: 'conflict', message: 'Claude Code already has a different status line configured' };
    }

    const target = readOptionalFileSnapshot(paths.targetScript, MAX_STATUS_LINE_SCRIPT_BYTES);
    const settingsReady = existingCommand === expectedCommand
      && settings.statusLine?.type === 'command'
      && settings.statusLine.refreshInterval === 60;
    const scriptReady = Boolean(target && target.bytes === source.bytes && target.sha256 === source.sha256);
    if (settingsReady && scriptReady) {
      return { status: 'ready', message: 'Claude status-line collector is installed' };
    }

    const desiredSettings: ClaudeSettings = {
      ...settings,
      statusLine: {
        type: 'command',
        command: expectedCommand,
        refreshInterval: 60,
        padding: 0
      }
    };
    if (settingsSnapshot && !settingsReady) backupClaudeSettings(paths.settingsPath, settingsSnapshot, now);
    const result: ClaudeStatusLineInstallResult = settingsReady
      ? { status: 'ready', message: 'Claude status-line collector is installed' }
      : settingsSnapshot
        ? { status: 'updated', message: 'Claude status-line collector was updated' }
        : { status: 'installed', message: 'Claude status-line collector was installed' };
    const journal = prepareClaudeTransaction(
      paths,
      'install',
      settingsSnapshot,
      Buffer.from(serialize(desiredSettings)),
      target,
      source,
      result
    );
    hooks.afterPrepared?.('install');
    return commitClaudeTransaction(paths, journal, hooks);
  });
}

export function removeClaudeStatusLine(
  paths: ClaudeStatusLinePaths,
  now = new Date(),
  hooks: ClaudeStatusLineTransactionHooks = {}
): ClaudeStatusLineInstallResult {
  return withCrossProcessLock(paths.settingsPath, () => {
    recoverClaudeTransaction(paths, hooks);
    const settingsSnapshot = readOptionalFileSnapshot(paths.settingsPath, MAX_CLAUDE_SETTINGS_BYTES);
    const settings = parseClaudeSettings(settingsSnapshot);
    const command = settings.statusLine?.command;
    if (command && command !== buildClaudeStatusLineCommand(paths.targetScript)
      && !isLimitsWidgetStatusLine(command, paths.targetScript)) {
      return { status: 'conflict', message: 'Claude Code is using a different status line; no settings were changed' };
    }
    const target = readOptionalFileSnapshot(paths.targetScript, MAX_STATUS_LINE_SCRIPT_BYTES);
    if (!command && !target) {
      return { status: 'missing', message: 'Claude status-line collector is not installed' };
    }
    if (!command && target) {
      if (!matchesFileSnapshot(paths.targetScript, target, MAX_STATUS_LINE_SCRIPT_BYTES)) {
        throw new ConcurrentFileModificationError(paths.targetScript);
      }
      rmSync(paths.targetScript, { force: true });
      syncDirectory(dirname(paths.targetScript));
      return { status: 'removed', message: 'Claude status-line collector was removed' };
    }
    const desiredSettings = { ...settings };
    delete desiredSettings.statusLine;
    if (settingsSnapshot && command) backupClaudeSettings(paths.settingsPath, settingsSnapshot, now);
    const journal = prepareClaudeTransaction(
      paths,
      'remove',
      settingsSnapshot,
      Buffer.from(serialize(desiredSettings)),
      target,
      null,
      { status: 'removed', message: 'Claude status-line collector was removed' }
    );
    hooks.afterPrepared?.('remove');
    return commitClaudeTransaction(paths, journal, hooks);
  });
}

export function inspectClaudeStatusLineInstallation(
  targetScript = join(getWidgetDataDir(), SCRIPT_NAME),
  settingsPath = getDefaultClaudeSettingsPath(),
  sourceScript?: string
): ClaudeStatusLineInstallResult {
  if (existsSync(transactionPath(settingsPath))) {
    return { status: 'conflict', message: 'Claude collector installation was interrupted; retry Install or Remove to recover it' };
  }
  if (!existsSync(settingsPath)) return { status: 'missing', message: 'Claude collector is not installed' };
  try {
    const settings = parseClaudeSettings(readFileSnapshot(settingsPath, MAX_CLAUDE_SETTINGS_BYTES));
    const command = settings.statusLine?.command;
    if (!command) return { status: 'missing', message: 'Claude collector is not installed' };
    const expectedCommand = buildClaudeStatusLineCommand(targetScript);
    if (command !== expectedCommand && !isLimitsWidgetStatusLine(command, targetScript)) {
      return { status: 'conflict', message: 'Claude Code is using a different status line' };
    }
    if (expectedCommand !== command) {
      return { status: 'missing', message: 'Claude collector needs to be installed or repaired for this app' };
    }
    const target = readOptionalFileSnapshot(targetScript, MAX_STATUS_LINE_SCRIPT_BYTES);
    if (!target) {
      return { status: 'missing', message: 'Claude collector needs to be installed or repaired for this app' };
    }
    if (sourceScript) {
      const source = readFileSnapshot(sourceScript, MAX_STATUS_LINE_SCRIPT_BYTES);
      if (!matchesReference(target, reference(source))) {
        return { status: 'missing', message: 'Claude collector needs to be installed or repaired for this app' };
      }
    }
    return { status: 'ready', message: 'Claude status-line collector is installed' };
  } catch (error) {
    return { status: 'conflict', message: error instanceof Error ? error.message : String(error) };
  }
}

function prepareClaudeTransaction(
  paths: ClaudeStatusLinePaths,
  operation: 'install' | 'remove',
  expectedSettings: FileSnapshot | null,
  desiredSettings: Buffer,
  expectedScript: FileSnapshot | null,
  desiredScript: FileSnapshot | null,
  result: ClaudeStatusLineInstallResult
): ClaudeTransactionJournal {
  const id = randomUUID();
  const settingsTempName = `.${basename(paths.settingsPath)}.agent-fleet-${id}.prepared`;
  const settingsTempPath = join(dirname(paths.settingsPath), settingsTempName);
  durableAtomicWrite(settingsTempPath, desiredSettings, { expected: null, checkExpected: true, mode: 0o600 });
  const desiredSettingsSnapshot = readFileSnapshot(settingsTempPath, MAX_CLAUDE_SETTINGS_BYTES);
  let scriptTempName: string | null = null;
  if (desiredScript) {
    scriptTempName = `.${basename(paths.targetScript)}.agent-fleet-${id}.prepared`;
    durableAtomicWrite(join(dirname(paths.targetScript), scriptTempName), desiredScript.data, {
      expected: null,
      checkExpected: true,
      mode: 0o600
    });
  }
  const journal: ClaudeTransactionJournal = {
    version: 1,
    id,
    operation,
    expectedSettings: reference(expectedSettings),
    desiredSettings: reference(desiredSettingsSnapshot)!,
    settingsTempName,
    expectedScript: reference(expectedScript),
    desiredScript: reference(desiredScript),
    scriptTempName,
    result
  };
  try {
    durableAtomicWrite(transactionPath(paths.settingsPath), serialize(journal), {
      expected: null,
      checkExpected: true,
      mode: 0o600
    });
    return journal;
  } catch (error) {
    cleanupClaudeTemps(paths, journal);
    throw error;
  }
}

function recoverClaudeTransaction(paths: ClaudeStatusLinePaths, hooks: ClaudeStatusLineTransactionHooks): void {
  const journalPath = transactionPath(paths.settingsPath);
  if (!existsSync(journalPath)) {
    cleanupOrphanClaudeTemps(paths);
    return;
  }
  let snapshot: FileSnapshot;
  try {
    snapshot = readFileSnapshot(journalPath, 64 * 1024);
  } catch {
    quarantinePath(journalPath, 'corrupt-transaction');
    cleanupOrphanClaudeTemps(paths);
    return;
  }
  let journal: ClaudeTransactionJournal;
  try {
    journal = parseClaudeJournal(snapshot, paths);
    validateClaudePreparedState(paths, journal);
  } catch {
    quarantineFile(journalPath, snapshot, 'corrupt-transaction');
    cleanupOrphanClaudeTemps(paths);
    return;
  }
  commitClaudeTransaction(paths, journal, hooks);
}

function commitClaudeTransaction(
  paths: ClaudeStatusLinePaths,
  journal: ClaudeTransactionJournal,
  hooks: ClaudeStatusLineTransactionHooks
): ClaudeStatusLineInstallResult {
  const journalPath = transactionPath(paths.settingsPath);
  try {
    const desiredSettings = readPreparedOrCommittedSettings(paths, journal);
    let currentSettings = readOptionalFileSnapshot(paths.settingsPath, MAX_CLAUDE_SETTINGS_BYTES);
    const settingsCommitted = matchesReference(currentSettings, journal.desiredSettings);
    if (!settingsCommitted && !matchesReference(currentSettings, journal.expectedSettings)) {
      throw new ConcurrentFileModificationError(paths.settingsPath);
    }

    if (journal.operation === 'install') {
      const currentScript = readOptionalFileSnapshot(paths.targetScript, MAX_STATUS_LINE_SCRIPT_BYTES);
      if (!matchesReference(currentScript, journal.desiredScript)) {
        if (!matchesReference(currentScript, journal.expectedScript)) {
          throw new ConcurrentFileModificationError(paths.targetScript);
        }
        const preparedScript = readFileSnapshot(
          join(dirname(paths.targetScript), journal.scriptTempName!),
          MAX_STATUS_LINE_SCRIPT_BYTES
        );
        durableAtomicWrite(paths.targetScript, preparedScript.data, {
          expected: currentScript,
          checkExpected: true,
          mode: 0o600
        });
      }
      hooks.afterScriptCommitted?.('install');
    } else {
      const currentScript = readOptionalFileSnapshot(paths.targetScript, MAX_STATUS_LINE_SCRIPT_BYTES);
      if (currentScript && !matchesReference(currentScript, journal.expectedScript)) {
        throw new ConcurrentFileModificationError(paths.targetScript);
      }
    }

    if (!settingsCommitted) {
      hooks.beforeSettingsCommit?.(journal.operation);
      durableAtomicWrite(paths.settingsPath, desiredSettings.data, {
        expected: currentSettings,
        checkExpected: true,
        mode: 0o600
      });
      currentSettings = readFileSnapshot(paths.settingsPath, MAX_CLAUDE_SETTINGS_BYTES);
      if (!matchesReference(currentSettings, journal.desiredSettings)) {
        throw new Error('Claude settings commit failed verification');
      }
    }
    hooks.afterSettingsCommitted?.(journal.operation);

    if (journal.operation === 'remove') {
      const currentScript = readOptionalFileSnapshot(paths.targetScript, MAX_STATUS_LINE_SCRIPT_BYTES);
      if (currentScript) {
        if (!matchesReference(currentScript, journal.expectedScript)) {
          throw new ConcurrentFileModificationError(paths.targetScript);
        }
        rmSync(paths.targetScript, { force: true });
        syncDirectory(dirname(paths.targetScript));
      }
      hooks.afterScriptCommitted?.('remove');
    }
    assertFinalScriptState(paths, journal);
    cleanupClaudeTemps(paths, journal);
    rmSync(journalPath, { force: true });
    syncDirectory(dirname(journalPath));
    return journal.result;
  } catch (error) {
    if (error instanceof ConcurrentFileModificationError && existsSync(journalPath)) {
      const snapshot = readFileSnapshot(journalPath, 64 * 1024);
      quarantineFile(journalPath, snapshot, 'concurrent-write');
      cleanupClaudeTemps(paths, journal);
    }
    throw error;
  }
}

function assertFinalScriptState(paths: ClaudeStatusLinePaths, journal: ClaudeTransactionJournal): void {
  const currentScript = readOptionalFileSnapshot(paths.targetScript, MAX_STATUS_LINE_SCRIPT_BYTES);
  if (!matchesReference(currentScript, journal.desiredScript)) {
    throw new ConcurrentFileModificationError(paths.targetScript);
  }
}

function readPreparedOrCommittedSettings(
  paths: ClaudeStatusLinePaths,
  journal: ClaudeTransactionJournal
): FileSnapshot {
  const preparedPath = join(dirname(paths.settingsPath), journal.settingsTempName);
  if (existsSync(preparedPath)) {
    const prepared = readFileSnapshot(preparedPath, MAX_CLAUDE_SETTINGS_BYTES);
    if (!matchesReference(prepared, journal.desiredSettings)) throw new Error('Prepared Claude settings failed verification');
    return prepared;
  }
  const current = readFileSnapshot(paths.settingsPath, MAX_CLAUDE_SETTINGS_BYTES);
  if (!matchesReference(current, journal.desiredSettings)) throw new Error('Prepared Claude settings are missing');
  return current;
}

function validateClaudePreparedState(paths: ClaudeStatusLinePaths, journal: ClaudeTransactionJournal): void {
  readPreparedOrCommittedSettings(paths, journal);
  if (journal.operation !== 'install') return;
  const scriptPath = join(dirname(paths.targetScript), journal.scriptTempName!);
  if (existsSync(scriptPath)) {
    const prepared = readFileSnapshot(scriptPath, MAX_STATUS_LINE_SCRIPT_BYTES);
    if (!matchesReference(prepared, journal.desiredScript)) throw new Error('Prepared status-line script failed verification');
    return;
  }
  const current = readFileSnapshot(paths.targetScript, MAX_STATUS_LINE_SCRIPT_BYTES);
  if (!matchesReference(current, journal.desiredScript)) throw new Error('Prepared status-line script is missing');
}

function parseClaudeJournal(snapshot: FileSnapshot, paths: ClaudeStatusLinePaths): ClaudeTransactionJournal {
  const value = JSON.parse(snapshot.data.toString('utf8')) as Partial<ClaudeTransactionJournal>;
  if (value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.id)
    || (value.operation !== 'install' && value.operation !== 'remove')
    || value.settingsTempName !== `.${basename(paths.settingsPath)}.agent-fleet-${value.id}.prepared`
    || !validReference(value.expectedSettings, true) || !validReference(value.desiredSettings, false)
    || !validReference(value.expectedScript, true) || !validReference(value.desiredScript, true)
    || !value.result || !['ready', 'installed', 'updated', 'removed'].includes(value.result.status)
    || typeof value.result.message !== 'string') {
    throw new Error('Claude transaction journal is invalid');
  }
  if (value.operation === 'install') {
    if (!value.desiredScript
      || value.scriptTempName !== `.${basename(paths.targetScript)}.agent-fleet-${value.id}.prepared`) {
      throw new Error('Claude install transaction is invalid');
    }
  } else if (value.desiredScript !== null || value.scriptTempName !== null) {
    throw new Error('Claude remove transaction is invalid');
  }
  return value as ClaudeTransactionJournal;
}

function cleanupClaudeTemps(paths: ClaudeStatusLinePaths, journal: ClaudeTransactionJournal): void {
  rmSync(join(dirname(paths.settingsPath), journal.settingsTempName), { force: true });
  if (journal.scriptTempName) rmSync(join(dirname(paths.targetScript), journal.scriptTempName), { force: true });
}

function cleanupOrphanClaudeTemps(paths: ClaudeStatusLinePaths): void {
  // A valid transaction owns its prepared files. Without one, only exact
  // app-generated names adjacent to these two known targets are removable.
  for (const [directory, fileName] of [
    [dirname(paths.settingsPath), basename(paths.settingsPath)],
    [dirname(paths.targetScript), basename(paths.targetScript)]
  ] as const) {
    if (!existsSync(directory)) continue;
    const prefix = `.${fileName}.agent-fleet-`;
    const entries = opendirSync(directory);
    try {
      for (let scanned = 0; scanned < 32; scanned += 1) {
        const entry = entries.readSync();
        if (!entry) break;
        const suffix = entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : '';
        if (entry.isFile() && /^[a-f0-9-]{36}\.prepared$/u.test(suffix)) {
          rmSync(join(directory, entry.name), { force: true });
        }
      }
    } finally {
      entries.closeSync();
    }
  }
}

function backupClaudeSettings(settingsPath: string, snapshot: FileSnapshot, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  let backupPath = `${settingsPath}.ai-limits-widget-backup-${stamp}`;
  if (!durablePublishExclusive(backupPath, snapshot.data)) {
    backupPath = `${backupPath}-${snapshot.sha256.slice(0, 12)}`;
    if (!durablePublishExclusive(backupPath, snapshot.data)
      && !matchesFileSnapshot(backupPath, snapshot, MAX_CLAUDE_SETTINGS_BYTES)) {
      throw new Error('A Claude settings backup with the same name already exists');
    }
  }
  return backupPath;
}

function parseClaudeSettings(snapshot: FileSnapshot | null): ClaudeSettings {
  if (!snapshot) return {};
  const raw = snapshot.data.toString('utf8').trim();
  if (!raw) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude settings are invalid');
  return value as ClaudeSettings;
}

function reference(snapshot: FileSnapshot | null): SnapshotReference | null {
  return snapshot ? { sha256: snapshot.sha256, bytes: snapshot.bytes } : null;
}

function matchesReference(snapshot: FileSnapshot | null, expected: SnapshotReference | null | undefined): boolean {
  return expected === null
    ? snapshot === null
    : Boolean(snapshot && expected && snapshot.bytes === expected.bytes && snapshot.sha256 === expected.sha256);
}

function validReference(value: unknown, nullable: boolean): boolean {
  if (nullable && value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<SnapshotReference>;
  return typeof raw.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(raw.sha256)
    && Number.isSafeInteger(raw.bytes) && Number(raw.bytes) >= 0;
}

function transactionPath(settingsPath: string): string {
  return `${settingsPath}.ai-limits-widget-transaction.json`;
}

function getDefaultClaudeSettingsPath(): string {
  const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  return join(userProfile, '.claude', 'settings.json');
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeCommandPath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/\/+/gu, '/').toLowerCase();
}

function ownedStatusLinePaths(targetScript: string): Set<string> {
  const normalized = normalizeCommandPath(targetScript);
  const owned = new Set([normalized]);
  const parts = normalized.split('/');
  if (parts.length < 2 || parts.at(-1) !== SCRIPT_NAME.toLowerCase()) return owned;
  const directoryIndex = parts.length - 2;
  if (parts[directoryIndex] === 'ai limits widget') {
    const legacy = [...parts];
    legacy[directoryIndex] = 'limits-widget';
    owned.add(legacy.join('/'));
  } else if (parts[directoryIndex] === 'limits-widget') {
    const current = [...parts];
    current[directoryIndex] = 'ai limits widget';
    owned.add(current.join('/'));
  }
  return owned;
}
