import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const INCOMPLETE_LOCK_GRACE_MS = 30_000;

export interface FileSnapshot {
  data: Buffer;
  sha256: string;
  bytes: number;
  device: bigint;
  inode: bigint;
  modifiedNs: bigint;
}

export type FileIdentity = Omit<FileSnapshot, 'data' | 'sha256'>;

export interface PathIdentity {
  bytes: number;
  device: bigint;
  inode: bigint;
  modifiedNs: bigint;
  kind: 'file' | 'directory' | 'symlink' | 'other';
}

interface StableFileStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  isFile(): boolean;
}

export interface DurableWriteHooks {
  afterTempSynced?(): void;
  beforeCommit?(): void;
  afterCommit?(): void;
}

export interface FileLockHooks {
  beforeStaleMove?(lockPath: string, quarantinePath: string): void;
  beforeReleaseMove?(lockPath: string, quarantinePath: string): void;
}

export class ConcurrentFileModificationError extends Error {
  constructor(filePath: string) {
    super(`${basename(filePath)} changed while the operation was in progress`);
    this.name = 'ConcurrentFileModificationError';
  }
}

export class FileLockBusyError extends Error {
  constructor(filePath: string) {
    super(`Another process is updating ${basename(filePath)}`);
    this.name = 'FileLockBusyError';
  }
}

export function readFileSnapshot(filePath: string, maxBytes = DEFAULT_MAX_BYTES): FileSnapshot {
  const beforePath = regularPathStat(filePath, maxBytes);
  const descriptor = openFileWithoutFollowingLinks(filePath);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maxBytes)) throw new Error(`${basename(filePath)} is too large`);
    if (!sameFileState(beforePath, stat)) throw new ConcurrentFileModificationError(filePath);
    const data = readFileSync(descriptor);
    if (data.length > maxBytes) throw new Error(`${basename(filePath)} is too large`);
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = regularPathStat(filePath, maxBytes);
    if (!sameFileState(after, stat) || !sameFileState(afterPath, stat) || data.length !== Number(stat.size)) {
      throw new ConcurrentFileModificationError(filePath);
    }
    return {
      data,
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: data.length,
      device: stat.dev,
      inode: stat.ino,
      modifiedNs: stat.mtimeNs
    };
  } finally {
    closeSync(descriptor);
  }
}

export function readOptionalFileSnapshot(filePath: string, maxBytes = DEFAULT_MAX_BYTES): FileSnapshot | null {
  try {
    return readFileSnapshot(filePath, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function matchesFileSnapshot(
  filePath: string,
  expected: Pick<FileSnapshot, 'sha256' | 'bytes'> | null,
  maxBytes = DEFAULT_MAX_BYTES
): boolean {
  try {
    const current = readOptionalFileSnapshot(filePath, maxBytes);
    return expected === null
      ? current === null
      : current !== null && current.bytes === expected.bytes && current.sha256 === expected.sha256;
  } catch {
    return false;
  }
}

export function readFileIdentity(filePath: string): FileIdentity {
  const beforePath = regularPathStat(filePath);
  const descriptor = openFileWithoutFollowingLinks(filePath);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    const afterPath = regularPathStat(filePath);
    if (!stat.isFile() || !sameFileState(beforePath, stat) || !sameFileState(afterPath, stat)) {
      throw new ConcurrentFileModificationError(filePath);
    }
    return {
      bytes: Number(stat.size),
      device: stat.dev,
      inode: stat.ino,
      modifiedNs: stat.mtimeNs
    };
  } finally {
    closeSync(descriptor);
  }
}

export function matchesFileIdentity(filePath: string, expected: FileIdentity): boolean {
  try {
    const current = readFileIdentity(filePath);
    return current.bytes === expected.bytes
      && current.device === expected.device
      && current.inode === expected.inode
      && current.modifiedNs === expected.modifiedNs;
  } catch {
    return false;
  }
}

export function readPathIdentity(filePath: string): PathIdentity {
  const stat = lstatSync(filePath, { bigint: true });
  return {
    bytes: Number(stat.size),
    device: stat.dev,
    inode: stat.ino,
    modifiedNs: stat.mtimeNs,
    kind: stat.isFile() ? 'file'
      : stat.isDirectory() ? 'directory'
        : stat.isSymbolicLink() ? 'symlink'
          : 'other'
  };
}

export function matchesPathIdentity(filePath: string, expected: PathIdentity): boolean {
  try {
    return samePathIdentity(readPathIdentity(filePath), expected);
  } catch {
    return false;
  }
}

export function durableAtomicWrite(
  filePath: string,
  data: string | Buffer,
  options: {
    expected?: Pick<FileSnapshot, 'sha256' | 'bytes'> | null;
    checkExpected?: boolean;
    mode?: number;
    hooks?: DurableWriteHooks;
  } = {}
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeDurableTemporary(temporary, data, options.mode);
    options.hooks?.afterTempSynced?.();
    if (options.checkExpected && !matchesFileSnapshot(filePath, options.expected ?? null)) {
      throw new ConcurrentFileModificationError(filePath);
    }
    options.hooks?.beforeCommit?.();
    if (options.checkExpected && !matchesFileSnapshot(filePath, options.expected ?? null)) {
      throw new ConcurrentFileModificationError(filePath);
    }
    renameSync(temporary, filePath);
    syncDirectory(dirname(filePath));
    options.hooks?.afterCommit?.();
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function durablePublishExclusive(filePath: string, data: string | Buffer, mode = 0o600): boolean {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeDurableTemporary(temporary, data, mode);
    try {
      linkSync(temporary, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    syncDirectory(dirname(filePath));
    return true;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function publishPreparedFileExclusive(preparedPath: string, filePath: string): boolean {
  try {
    linkSync(preparedPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  syncDirectory(dirname(filePath));
  return true;
}

export function quarantineFile(
  filePath: string,
  expected: Pick<FileSnapshot, 'sha256' | 'bytes'> | FileIdentity,
  label: string,
  now = new Date(),
  beforeMove?: () => void
): string | null {
  const digest = 'sha256' in expected ? expected.sha256.slice(0, 12) : 'oversized';
  const matchesExpected = (path: string): boolean => (
    'sha256' in expected ? matchesFileSnapshot(path, expected) : matchesFileIdentity(path, expected)
  );
  if (!matchesExpected(filePath)) return null;
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  const safeLabel = label.replace(/[^a-z0-9-]/giu, '-').slice(0, 32) || 'quarantine';
  const quarantinePath = `${filePath}.${safeLabel}-${stamp}-${digest}-${randomUUID()}`;
  beforeMove?.();
  try {
    renameSync(filePath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!matchesExpected(quarantinePath)) {
    restoreUnexpectedQuarantine(filePath, quarantinePath);
    return null;
  }
  syncDirectory(dirname(filePath));
  return quarantinePath;
}

/**
 * Preserves an unreadable filesystem entry without following it. This is used
 * for directories, symbolic links, oversized files, and other paths for which
 * a regular-file snapshot cannot be obtained safely.
 */
export function quarantinePath(
  filePath: string,
  label: string,
  now = new Date(),
  beforeMove?: () => void
): string | null {
  let expected: PathIdentity;
  try {
    expected = readPathIdentity(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return quarantinePathIfUnchanged(filePath, expected, label, now, beforeMove);
}

export function quarantinePathIfUnchanged(
  filePath: string,
  expected: PathIdentity,
  label: string,
  now = new Date(),
  beforeMove?: () => void
): string | null {
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  const safeLabel = label.replace(/[^a-z0-9-]/giu, '-').slice(0, 32) || 'quarantine';
  const quarantinePath = `${filePath}.${safeLabel}-${stamp}-${expected.kind}-${expected.inode}-${randomUUID()}`;
  if (!matchesPathIdentity(filePath, expected)) return null;
  beforeMove?.();
  try {
    renameSync(filePath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!matchesPathIdentity(quarantinePath, expected)) {
    restoreUnexpectedPathQuarantine(filePath, quarantinePath);
    return null;
  }
  syncDirectory(dirname(filePath));
  return quarantinePath;
}

/**
 * Revalidates an entry while its cross-process lock is held. A path that was
 * concurrently replaced or repaired is left untouched; only the exact
 * filesystem entry that is still unreadable is eligible for quarantine.
 */
export function quarantineUnreadablePath(
  filePath: string,
  expected: PathIdentity,
  maxBytes: number,
  label: string,
  now = new Date()
): string | null {
  if (!matchesPathIdentity(filePath, expected)) return null;
  try {
    readOptionalFileSnapshot(filePath, maxBytes);
    return null;
  } catch (error) {
    if (error instanceof ConcurrentFileModificationError) return null;
  }
  return quarantinePathIfUnchanged(filePath, expected, label, now);
}

export function withCrossProcessLock<Result>(
  filePath: string,
  task: () => Result,
  nowMs = Date.now(),
  hooks: FileLockHooks = {}
): Result {
  const lockPath = `${filePath}.agent-fleet.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  acquireLock(lockPath, token, nowMs, hooks);
  try {
    return task();
  } finally {
    releaseLock(lockPath, token, hooks);
  }
}

export function syncDirectory(directoryPath: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directoryPath, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeDurableTemporary(filePath: string, data: string | Buffer, mode = 0o600): void {
  const descriptor = openSync(filePath, 'wx', mode);
  try {
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function openFileWithoutFollowingLinks(filePath: string): number {
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  return openSync(filePath, constants.O_RDONLY | noFollow);
}

function regularPathStat(filePath: string, maxBytes?: number): StableFileStat {
  const stat = lstatSync(filePath, { bigint: true });
  if (!stat.isFile()) throw new Error(`${basename(filePath)} is not a regular file`);
  if (maxBytes !== undefined && stat.size > BigInt(maxBytes)) {
    throw new Error(`${basename(filePath)} is too large`);
  }
  return stat;
}

function sameFileState(left: StableFileStat, right: StableFileStat): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function restoreUnexpectedQuarantine(filePath: string, quarantinePath: string): void {
  try {
    linkSync(quarantinePath, filePath);
    rmSync(quarantinePath, { force: true });
  } catch {
    // Preserve the unexpected bytes at the quarantine path when an exclusive
    // restore cannot be proven safe, including when a newer path already exists.
  } finally {
    syncDirectory(dirname(filePath));
  }
}

function restoreUnexpectedPathQuarantine(filePath: string, quarantinePath: string): void {
  try {
    lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        renameSync(quarantinePath, filePath);
      } catch {
        // Preserve the unexpected entry at the quarantine path.
      }
    }
  } finally {
    syncDirectory(dirname(filePath));
  }
}

function acquireLock(lockPath: string, token: string, nowMs: number, hooks: FileLockHooks): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const ownerPath = join(lockPath, 'owner.json');
      writeDurableTemporary(ownerPath, `${JSON.stringify({ pid: process.pid, token, createdAt: nowMs })}\n`, 0o600);
      syncDirectory(lockPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = attempt === 0 ? staleLock(lockPath, nowMs) : null;
      if (stale) {
        const quarantinePath = staleLockQuarantinePath(lockPath, stale);
        hooks.beforeStaleMove?.(lockPath, quarantinePath);
        try {
          renameSync(lockPath, quarantinePath);
        } catch (moveError) {
          if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(
            (moveError as NodeJS.ErrnoException).code ?? ''
          )) {
            throw new FileLockBusyError(lockPath.replace(/\.agent-fleet\.lock$/u, ''));
          }
          throw moveError;
        }
        if (!matchesPathIdentity(quarantinePath, stale)) {
          restoreUnexpectedPathQuarantine(lockPath, quarantinePath);
          throw new FileLockBusyError(lockPath.replace(/\.agent-fleet\.lock$/u, ''));
        }
        syncDirectory(dirname(lockPath));
        continue;
      }
      throw new FileLockBusyError(lockPath.replace(/\.agent-fleet\.lock$/u, ''));
    }
  }
}

function staleLock(lockPath: string, nowMs: number): PathIdentity | null {
  try {
    const identity = readPathIdentity(lockPath);
    if (identity.kind !== 'directory') return null;
    const owner = JSON.parse(
      readFileSnapshot(join(lockPath, 'owner.json'), 16 * 1024).data.toString('utf8')
    ) as {
      pid?: unknown;
      createdAt?: unknown;
    };
    if (!matchesPathIdentity(lockPath, identity)) return null;
    if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      return processIsAlive(owner.pid) ? null : identity;
    }
    return typeof owner.createdAt === 'number' && nowMs - owner.createdAt > INCOMPLETE_LOCK_GRACE_MS
      ? identity : null;
  } catch {
    try {
      const identity = readPathIdentity(lockPath);
      return identity.kind === 'directory' && nowMs - statSync(lockPath).mtimeMs > INCOMPLETE_LOCK_GRACE_MS
        ? identity : null;
    } catch {
      return null;
    }
  }
}

function staleLockQuarantinePath(lockPath: string, identity: PathIdentity): string {
  return `${lockPath}.stale-${identity.device}-${identity.inode}-${identity.modifiedNs}`;
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.bytes === right.bytes
    && left.modifiedNs === right.modifiedNs
    && left.kind === right.kind;
}

function releaseLock(lockPath: string, token: string, hooks: FileLockHooks): void {
  let identity: PathIdentity;
  try {
    identity = readPathIdentity(lockPath);
    if (identity.kind !== 'directory') return;
    const owner = JSON.parse(
      readFileSnapshot(join(lockPath, 'owner.json'), 16 * 1024).data.toString('utf8')
    ) as { token?: unknown };
    if (owner.token !== token || !matchesPathIdentity(lockPath, identity)) return;
  } catch {
    // Never remove a lock whose ownership cannot be proven.
    return;
  }
  const quarantinePath = `${lockPath}.released-${identity.device}-${identity.inode}-${token}`;
  hooks.beforeReleaseMove?.(lockPath, quarantinePath);
  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // Leaving a lock behind is safer than deleting a path that may now belong
    // to another process.
    return;
  }
  if (!matchesPathIdentity(quarantinePath, identity)) {
    restoreUnexpectedPathQuarantine(lockPath, quarantinePath);
    return;
  }
  try {
    rmSync(quarantinePath, { recursive: true, force: true });
    syncDirectory(dirname(lockPath));
  } catch {
    // A verified release tombstone may remain as evidence, but the live lock
    // path is never recursively deleted after an ownership race.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
