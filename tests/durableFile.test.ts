import {
  mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConcurrentFileModificationError,
  FileLockBusyError,
  durableAtomicWrite,
  quarantineFile,
  quarantineUnreadablePath,
  readFileSnapshot,
  readPathIdentity,
  withCrossProcessLock
} from '../src/main/durable-file';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('durable file transactions', () => {
  it('leaves a concurrently repaired path untouched during unreadable recovery', () => {
    const path = temporaryFile('repairable.json', 'stale');
    rmSync(path);
    mkdirSync(path);
    const observed = readPathIdentity(path);
    rmSync(path, { recursive: true });
    writeFileSync(path, '{"repaired":true}\n');

    expect(quarantineUnreadablePath(path, observed, 1024, 'corrupt')).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('{"repaired":true}\n');
  });

  it('leaves a complete old or new file at every injected commit phase', () => {
    const path = temporaryFile('state.json', 'old');
    expect(() => durableAtomicWrite(path, 'new', {
      hooks: { afterTempSynced: () => { throw new Error('crash before commit'); } }
    })).toThrow(/crash before commit/u);
    expect(readFileSync(path, 'utf8')).toBe('old');

    expect(() => durableAtomicWrite(path, 'new', {
      hooks: { afterCommit: () => { throw new Error('crash after commit'); } }
    })).toThrow(/crash after commit/u);
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  it('detects an external write immediately before commit and preserves it exactly', () => {
    const path = temporaryFile('settings.json', 'old');
    const expected = {
      bytes: Buffer.byteLength('old'),
      sha256: 'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4'
    };
    expect(() => durableAtomicWrite(path, 'app-write', {
      expected,
      checkExpected: true,
      hooks: { beforeCommit: () => writeFileSync(path, 'user-write', 'utf8') }
    })).toThrow(ConcurrentFileModificationError);
    expect(readFileSync(path, 'utf8')).toBe('user-write');
  });

  it('rejects a live cross-process owner and recovers a dead-owner lock', () => {
    const path = temporaryFile('settings.json', 'old');
    const lock = `${path}.agent-fleet.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token: 'other-process',
      createdAt: Date.now()
    }));
    expect(() => withCrossProcessLock(path, () => undefined)).toThrow(FileLockBusyError);
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({
      pid: 2_147_483_646,
      token: 'dead-process',
      createdAt: 0
    }));

    expect(withCrossProcessLock(path, () => 'recovered')).toBe('recovered');
  });

  it('cannot remove a fresh lock while racing another stale-lock reclaimer', () => {
    const path = temporaryFile('settings.json', 'old');
    const lock = `${path}.agent-fleet.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({
      pid: 2_147_483_646,
      token: 'dead-process',
      createdAt: 0
    }));

    expect(() => withCrossProcessLock(path, () => undefined, Date.now(), {
      beforeStaleMove: (_lockPath, quarantinePath) => {
        renameSync(lock, quarantinePath);
        mkdirSync(lock);
        writeFileSync(join(lock, 'owner.json'), JSON.stringify({
          pid: process.pid,
          token: 'new-live-owner',
          createdAt: Date.now()
        }));
      }
    })).toThrow(FileLockBusyError);
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))).toMatchObject({
      token: 'new-live-owner'
    });
  });

  it('cannot recursively delete a replacement created while releasing its lock', () => {
    const path = temporaryFile('settings.json', 'old');
    const lock = `${path}.agent-fleet.lock`;
    expect(withCrossProcessLock(path, () => 'complete', Date.now(), {
      beforeReleaseMove: (lockPath) => {
        renameSync(lockPath, `${lockPath}.original-owner`);
        mkdirSync(lockPath);
        writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
          pid: process.pid,
          token: 'replacement-owner',
          createdAt: Date.now()
        }));
      }
    })).toBe('complete');
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))).toMatchObject({
      token: 'replacement-owner'
    });
  });

  it('does not follow a symbolic link while taking a trusted snapshot', () => {
    const target = temporaryFile('target.json', 'private');
    const link = join(dirname(target), 'link.json');
    try {
      symlinkSync(target, link);
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    expect(() => readFileSnapshot(link)).toThrow(/regular file|symbolic link|ELOOP/iu);
  });

  it('restores a concurrent replacement instead of quarantining user data', () => {
    const path = temporaryFile('settings.json', 'expected');
    const expected = readFileSnapshot(path);
    const result = quarantineFile(
      path,
      expected,
      'invalid',
      new Date('2026-07-29T12:00:00Z'),
      () => writeFileSync(path, 'concurrent-user-data', 'utf8')
    );
    expect(result).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('concurrent-user-data');
  });
});

function temporaryFile(name: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-fleet-durable-'));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, content, 'utf8');
  return path;
}
