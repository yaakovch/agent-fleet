import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyImportedSettings,
  createSettingsExport,
  loadSettings,
  parseSettingsImport,
  rollbackLatestSettings,
  saveSettings
} from '../src/main/settings-store';
import { createDefaultSettings, type CodexProfileSettings } from '../src/shared/settings';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('settings store', () => {
  it('loads machine-neutral onboarding defaults when settings are missing', () => {
    const root = makeTempDir();
    const result = loadSettings(join(root, 'settings.json'));
    expect(result.recovered).toBe(false);
    expect(result.settings.codexProfiles).toEqual([]);
    expect(result.settings.claudeEnabled).toBe(false);
    expect(result.settings.codexSortMode).toBe('highestAverageLeft');
    expect(result.settings.onboardingComplete).toBe(false);
    expect(result.settings.fleetControllerDistro).toBe('Ubuntu');
    expect(result.settings.fleetOpenTarget).toBe('windowsTerminal');
    expect(result.settings.fleetNotifications.hostState).toBe(true);
  });

  it('recovers machine-neutral defaults when settings are unreadable', () => {
    const root = makeTempDir();
    const settingsPath = join(root, 'settings.json');
    writeFileSync(settingsPath, '{not-json', 'utf8');
    const result = loadSettings(settingsPath);
    expect(result.recovered).toBe(true);
    expect(result.message).toContain('defaults loaded');
    expect(result.settings.codexProfiles).toEqual([]);
  });

  it('saves normalized settings atomically and allows opacity below 0.2', () => {
    const root = makeTempDir();
    const settingsPath = join(root, 'settings.json');
    const settings = createDefaultSettings();
    settings.passiveOpacity = 0.05;
    settings.activeOpacity = -1;
    settings.codexProfiles = [{ ...testProfile(), label: ' Primary ' }];
    const saved = saveSettings(settings, settingsPath);
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof settings;
    expect(saved.passiveOpacity).toBe(0.05);
    expect(saved.activeOpacity).toBe(0);
    expect(raw.codexProfiles[0].label).toBe('Primary');
  });

  it('migrates a version 1 configuration without losing profiles', () => {
    const root = makeTempDir();
    const settingsPath = join(root, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        version: 1,
        codexProfiles: [testProfile()],
        claudeEnabled: true,
        passiveOpacity: 0.6,
        activeOpacity: 1,
        launchOnLogin: false
      }),
      'utf8'
    );
    const result = loadSettings(settingsPath);
    expect(result.migrated).toBe(true);
    expect(result.settings.version).toBe(3);
    expect(result.settings.codexProfiles[0].codexHome).toBe('/home/testuser/.codex-work');
    expect(result.settings.codexSortMode).toBe('highestAverageLeft');
    expect(result.settings.onboardingComplete).toBe(true);
  });

  it('previews an export, warns on machine startup changes, and rejects oversized input', () => {
    const settings = createDefaultSettings();
    settings.codexProfiles = [testProfile()];
    settings.launchOnLogin = true;
    settings.notificationPauseUntil = '2026-07-11T01:00:00.000Z';
    const envelope = createSettingsExport(settings, '1.0.0', new Date('2026-07-11T00:00:00Z'));
    expect(envelope.settings.notificationPauseUntil).toBeNull();
    const preview = parseSettingsImport(JSON.stringify(envelope), 'other-machine.ai-limits-settings.json');
    expect(preview.fileName).toBe('other-machine.ai-limits-settings.json');
    expect(preview.settings.codexProfiles).toHaveLength(1);
    expect(preview.warnings).toContain('Importing will enable launch on login on this machine.');
    expect(() => parseSettingsImport('x'.repeat(1024 * 1024 + 1))).toThrow('1 MiB');
  });

  it('backs up imported settings and rolls back to the previous configuration', () => {
    const root = makeTempDir();
    const settingsPath = join(root, 'settings.json');
    const initial = createDefaultSettings();
    initial.passiveOpacity = 0.4;
    saveSettings(initial, settingsPath);
    const imported = createDefaultSettings();
    imported.passiveOpacity = 0.9;
    applyImportedSettings(imported, settingsPath, new Date('2026-07-11T01:00:00Z'));
    expect(loadSettings(settingsPath).settings.passiveOpacity).toBe(0.9);
    expect(rollbackLatestSettings(settingsPath)?.passiveOpacity).toBe(0.4);
  });
});

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-limits-settings-'));
  tempDirs.push(root);
  return root;
}

function testProfile(): CodexProfileSettings {
  return {
    id: 'work',
    label: 'Work',
    enabled: true,
    order: 0,
    distro: 'Ubuntu',
    user: 'testuser',
    home: '/home/testuser',
    codexHome: '/home/testuser/.codex-work',
    executable: '/home/testuser/.local/bin/codex'
  };
}
