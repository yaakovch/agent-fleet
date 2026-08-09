import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyData } from '../src/main/app-paths';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('legacy data migration', () => {
  it('copies supported files once and preserves the legacy source', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-limits-migration-'));
    roots.push(root);
    const legacy = join(root, 'legacy');
    const target = join(root, 'new');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'settings.json'), '{"version":1}', 'utf8');
    const first = migrateLegacyData(target, legacy, new Date('2026-07-11T00:00:00Z'));
    const second = migrateLegacyData(target, legacy);
    expect(first.migrated).toBe(true);
    expect(second.copiedFiles).toEqual(['settings.json']);
    expect(readFileSync(join(target, 'settings.json'), 'utf8')).toContain('version');
    expect(existsSync(join(legacy, 'settings.json'))).toBe(true);
  });

  it('recovers a crash after preparation without exposing a partial target', () => {
    const { legacy, target } = migrationPaths();
    writeFileSync(join(legacy, 'settings.json'), '{"version":1}', 'utf8');
    expect(() => migrateLegacyData(target, legacy, new Date('2026-07-29T10:00:00Z'), {
      afterPrepared: () => { throw new Error('simulated crash after prepare'); }
    })).toThrow(/simulated crash/u);
    expect(existsSync(join(target, 'settings.json'))).toBe(false);
    expect(existsSync(join(target, '.legacy-migration-v1.transaction.json'))).toBe(true);

    const recovered = migrateLegacyData(target, legacy);
    expect(recovered.copiedFiles).toEqual(['settings.json']);
    expect(readFileSync(join(target, 'settings.json'), 'utf8')).toBe('{"version":1}');
    expect(existsSync(join(target, '.legacy-migration-v1.transaction.json'))).toBe(false);
  });

  it('finishes a partial crash transaction without overwriting a concurrent user file', () => {
    const { legacy, target } = migrationPaths();
    writeFileSync(join(legacy, 'settings.json'), '{"version":1}', 'utf8');
    writeFileSync(join(legacy, 'window-state.json'), '{"x":10}', 'utf8');
    expect(() => migrateLegacyData(target, legacy, new Date('2026-07-29T11:00:00Z'), {
      afterFileCommitted: (fileName) => {
        if (fileName !== 'settings.json') return;
        writeFileSync(join(target, 'window-state.json'), '{"x":999,"user":true}', 'utf8');
        throw new Error('simulated crash after first commit');
      }
    })).toThrow(/simulated crash/u);

    const recovered = migrateLegacyData(target, legacy);
    expect(recovered.copiedFiles).toEqual(['settings.json']);
    expect(readFileSync(join(target, 'window-state.json'), 'utf8')).toBe('{"x":999,"user":true}');
    expect(JSON.parse(readFileSync(join(target, 'legacy-migration-v1.json'), 'utf8')).copiedFiles)
      .toEqual(['settings.json']);
  });

  it('quarantines a corrupt completion marker and preserves its bytes', () => {
    const { legacy, target } = migrationPaths();
    writeFileSync(join(legacy, 'settings.json'), '{"version":1}', 'utf8');
    migrateLegacyData(target, legacy);
    writeFileSync(join(target, 'legacy-migration-v1.json'), '{corrupt-marker', 'utf8');

    expect(migrateLegacyData(target, legacy).migrated).toBe(false);
    const evidence = readdirSync(target).find((name) => name.includes('corrupt-migration-marker'));
    expect(evidence).toBeTruthy();
    expect(readFileSync(join(target, evidence!), 'utf8')).toBe('{corrupt-marker');
  });

  it('preserves an unsafe migration marker directory and continues startup migration', () => {
    const { legacy, target } = migrationPaths();
    mkdirSync(target, { recursive: true });
    const markerPath = join(target, 'legacy-migration-v1.json');
    mkdirSync(markerPath);
    writeFileSync(join(markerPath, 'evidence.txt'), 'unexpected marker directory', 'utf8');

    expect(migrateLegacyData(target, legacy, new Date('2026-07-29T13:15:00Z'))).toMatchObject({
      migrated: false,
      copiedFiles: []
    });
    const evidence = readdirSync(target).find((name) => name.startsWith(
      'legacy-migration-v1.json.corrupt-migration-marker-'
    ));
    expect(evidence).toBeTruthy();
    expect(readFileSync(join(target, evidence!, 'evidence.txt'), 'utf8')).toBe('unexpected marker directory');
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ migrated: false });
  });

  it('ignores an unsafe legacy source entry without mutating it or blocking startup', () => {
    const { legacy, target } = migrationPaths();
    const unsafeSource = join(legacy, 'settings.json');
    mkdirSync(unsafeSource);
    writeFileSync(join(unsafeSource, 'evidence.txt'), 'legacy directory', 'utf8');

    expect(migrateLegacyData(target, legacy)).toMatchObject({ migrated: false, copiedFiles: [] });
    expect(readFileSync(join(unsafeSource, 'evidence.txt'), 'utf8')).toBe('legacy directory');
    expect(JSON.parse(readFileSync(join(target, 'legacy-migration-v1.json'), 'utf8')))
      .toMatchObject({ migrated: false, copiedFiles: [] });
  });
});

function migrationPaths(): { legacy: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), 'ai-limits-migration-'));
  roots.push(root);
  const legacy = join(root, 'legacy');
  const target = join(root, 'new');
  mkdirSync(legacy, { recursive: true });
  return { legacy, target };
}
