import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClaudeStatusLineCommand,
  ensureClaudeStatusLineInstalled,
  inspectClaudeStatusLineInstallation,
  isLimitsWidgetStatusLine,
  removeClaudeStatusLine,
  type ClaudeStatusLinePaths
} from '../src/main/claude-statusline-install';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Claude status-line installation', () => {
  it('uses a Git Bash-safe Windows path', () => {
    expect(buildClaudeStatusLineCommand('C:\\Users\\Test User\\limits-widget\\claude-statusline.ps1')).toBe(
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:/Users/Test User/limits-widget/claude-statusline.ps1"'
    );
  });

  it('recognizes only the exact current or legacy app-owned command', () => {
    const target = 'C:\\Users\\Test\\AppData\\Roaming\\AI Limits Widget\\claude-statusline.ps1';
    expect(isLimitsWidgetStatusLine(buildClaudeStatusLineCommand(target), target)).toBe(true);
    expect(isLimitsWidgetStatusLine(
      buildClaudeStatusLineCommand('C:\\Users\\Test\\AppData\\Roaming\\limits-widget\\claude-statusline.ps1'),
      target
    )).toBe(true);
    expect(isLimitsWidgetStatusLine(
      'cmd.exe /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:/Users/Test/AppData/Roaming/AI Limits Widget/claude-statusline.ps1"',
      target
    )).toBe(false);
    expect(isLimitsWidgetStatusLine(
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:/evil/AI Limits Widget/claude-statusline.ps1"',
      target
    )).toBe(false);
    expect(isLimitsWidgetStatusLine(`${buildClaudeStatusLineCommand(target)} -Unexpected`, target)).toBe(false);
  });

  it('installs the collector while preserving other Claude settings', () => {
    const paths = createPaths();
    mkdirSync(join(paths.settingsPath, '..'), { recursive: true });
    writeFileSync(paths.settingsPath, '{"model":"opus"}\n', 'utf8');

    const result = ensureClaudeStatusLineInstalled(paths, new Date('2026-07-10T12:00:00Z'));
    const settings = JSON.parse(readFileSync(paths.settingsPath, 'utf8')) as {
      model: string;
      statusLine: { command: string };
    };

    expect(result.status).toBe('updated');
    expect(settings.model).toBe('opus');
    expect(settings.statusLine.command).toContain('/widget/claude-statusline.ps1');
    expect(existsSync(paths.targetScript)).toBe(true);
    expect(existsSync(`${paths.settingsPath}.ai-limits-widget-backup-2026-07-10T12-00-00-000Z`)).toBe(true);
  });

  it('does not replace an unrelated custom status line', () => {
    const paths = createPaths();
    mkdirSync(join(paths.settingsPath, '..'), { recursive: true });
    writeFileSync(
      paths.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'my-custom-statusline.exe' } }),
      'utf8'
    );

    const result = ensureClaudeStatusLineInstalled(paths);
    const settings = JSON.parse(readFileSync(paths.settingsPath, 'utf8')) as {
      statusLine: { command: string };
    };

    expect(result.status).toBe('conflict');
    expect(settings.statusLine.command).toBe('my-custom-statusline.exe');
  });

  it('recovers an install crash after the script commit and preserves the old settings until recovery', () => {
    const paths = createPaths();
    mkdirSync(join(paths.settingsPath, '..'), { recursive: true });
    writeFileSync(paths.settingsPath, '{"model":"opus"}\n', 'utf8');
    expect(() => ensureClaudeStatusLineInstalled(paths, new Date('2026-07-29T10:00:00Z'), {
      afterScriptCommitted: () => { throw new Error('simulated script-commit crash'); }
    })).toThrow(/simulated script-commit crash/u);
    expect(JSON.parse(readFileSync(paths.settingsPath, 'utf8'))).toEqual({ model: 'opus' });
    expect(existsSync(paths.targetScript)).toBe(true);
    expect(existsSync(`${paths.settingsPath}.ai-limits-widget-transaction.json`)).toBe(true);

    expect(ensureClaudeStatusLineInstalled(paths).status).toBe('ready');
    expect(JSON.parse(readFileSync(paths.settingsPath, 'utf8'))).toMatchObject({
      model: 'opus',
      statusLine: { type: 'command', refreshInterval: 60 }
    });
    expect(existsSync(`${paths.settingsPath}.ai-limits-widget-transaction.json`)).toBe(false);
  });

  it('never overwrites a concurrent user settings edit', () => {
    const paths = createPaths();
    mkdirSync(join(paths.settingsPath, '..'), { recursive: true });
    writeFileSync(paths.settingsPath, '{"model":"opus"}\n', 'utf8');
    const concurrent = '{"model":"sonnet","userEdit":true}\n';
    expect(() => ensureClaudeStatusLineInstalled(paths, new Date('2026-07-29T11:00:00Z'), {
      beforeSettingsCommit: () => writeFileSync(paths.settingsPath, concurrent, 'utf8')
    })).toThrow(/changed while/u);
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(concurrent);
    const evidence = readdirSync(dirname(paths.settingsPath))
      .find((name) => name.includes('transaction.json.concurrent-write'));
    expect(evidence).toBeTruthy();

    ensureClaudeStatusLineInstalled(paths);
    expect(JSON.parse(readFileSync(paths.settingsPath, 'utf8'))).toMatchObject({
      model: 'sonnet',
      userEdit: true,
      statusLine: { type: 'command' }
    });
  });

  it('does not report an install as successful after a concurrent target replacement', () => {
    const paths = createPaths();
    mkdirSync(dirname(paths.settingsPath), { recursive: true });
    writeFileSync(paths.settingsPath, '{"model":"opus"}\n', 'utf8');

    expect(() => ensureClaudeStatusLineInstalled(paths, new Date('2026-07-29T11:30:00Z'), {
      beforeSettingsCommit: () => writeFileSync(paths.targetScript, 'concurrent replacement\n', 'utf8')
    })).toThrow(/changed while/u);

    expect(readFileSync(paths.targetScript, 'utf8')).toBe('concurrent replacement\n');
    expect(JSON.parse(readFileSync(paths.settingsPath, 'utf8'))).toMatchObject({
      model: 'opus',
      statusLine: { type: 'command' }
    });
    expect(readdirSync(dirname(paths.settingsPath))
      .some((name) => name.includes('transaction.json.concurrent-write'))).toBe(true);
  });

  it('preserves corrupt Claude settings and makes no partial installation', () => {
    const paths = createPaths();
    mkdirSync(join(paths.settingsPath, '..'), { recursive: true });
    writeFileSync(paths.settingsPath, '{corrupt-claude-settings', 'utf8');

    expect(() => ensureClaudeStatusLineInstalled(paths)).toThrow();
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe('{corrupt-claude-settings');
    expect(existsSync(paths.targetScript)).toBe(false);
  });

  it('recovers a remove crash after settings commit before deleting the script', () => {
    const paths = createPaths();
    ensureClaudeStatusLineInstalled(paths);
    expect(() => removeClaudeStatusLine(paths, new Date('2026-07-29T12:00:00Z'), {
      afterSettingsCommitted: () => { throw new Error('simulated settings-commit crash'); }
    })).toThrow(/simulated settings-commit crash/u);
    expect(JSON.parse(readFileSync(paths.settingsPath, 'utf8'))).not.toHaveProperty('statusLine');
    expect(existsSync(paths.targetScript)).toBe(true);

    removeClaudeStatusLine(paths);
    expect(existsSync(paths.targetScript)).toBe(false);
    expect(existsSync(`${paths.settingsPath}.ai-limits-widget-transaction.json`)).toBe(false);
  });

  it('does not delete or accept a concurrently replaced target during removal', () => {
    const paths = createPaths();
    ensureClaudeStatusLineInstalled(paths);

    expect(() => removeClaudeStatusLine(paths, new Date('2026-07-29T12:30:00Z'), {
      afterSettingsCommitted: () => writeFileSync(paths.targetScript, 'user replacement\n', 'utf8')
    })).toThrow(/changed while/u);

    expect(readFileSync(paths.targetScript, 'utf8')).toBe('user replacement\n');
    expect(JSON.parse(readFileSync(paths.settingsPath, 'utf8'))).not.toHaveProperty('statusLine');
    expect(readdirSync(dirname(paths.settingsPath))
      .some((name) => name.includes('transaction.json.concurrent-write'))).toBe(true);
  });

  it('does not report a directory or oversized target as an installed collector', () => {
    const paths = createPaths();
    mkdirSync(dirname(paths.settingsPath), { recursive: true });
    writeFileSync(paths.settingsPath, JSON.stringify({
      statusLine: {
        type: 'command',
        command: buildClaudeStatusLineCommand(paths.targetScript),
        refreshInterval: 60
      }
    }));
    mkdirSync(paths.targetScript, { recursive: true });
    expect(inspectClaudeStatusLineInstallation(paths.targetScript, paths.settingsPath)).toMatchObject({
      status: 'conflict'
    });
  });

  it('requires the installed target to match the packaged source when it is available', () => {
    const paths = createPaths();
    ensureClaudeStatusLineInstalled(paths);
    writeFileSync(paths.targetScript, 'replaced after installation\n', 'utf8');

    expect(inspectClaudeStatusLineInstallation(
      paths.targetScript,
      paths.settingsPath,
      paths.sourceScript
    )).toMatchObject({ status: 'missing' });
  });
});

function createPaths(): ClaudeStatusLinePaths {
  const root = mkdtempSync(join(tmpdir(), 'limits-widget-'));
  tempDirs.push(root);
  const sourceScript = join(root, 'source', 'claude-statusline.ps1');
  mkdirSync(join(sourceScript, '..'), { recursive: true });
  writeFileSync(sourceScript, 'Write-Output "test"\n', 'utf8');

  return {
    sourceScript,
    targetScript: join(root, 'widget', 'claude-statusline.ps1'),
    settingsPath: join(root, 'profile', '.claude', 'settings.json')
  };
}
