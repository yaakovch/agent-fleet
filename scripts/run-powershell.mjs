import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..');

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function windowsPath(path) {
  const match = path.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!match) return path;
  return `${match[1].toUpperCase()}:\\${match[2].replaceAll('/', '\\')}`;
}

export function resolvePowerShellLaunch(options = {}) {
  const platform = options.platform ?? process.platform;
  const marker = options.marker ?? process.env.AGENT_FLEET_INTEROP_MARKER ?? '/proc/sys/fs/binfmt_misc/WSLInterop';
  const launcher = options.launcher ?? process.env.AGENT_FLEET_INTEROP_LAUNCHER ?? '/init';
  const powershell = options.powershell ?? process.env.AGENT_FLEET_POWERSHELL ??
    (platform === 'win32' ? 'powershell.exe' : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  const markerExists = options.markerExists ?? existsSync(marker);
  const launcherExecutable = options.launcherExecutable ?? executable(launcher);
  const powershellExecutable = options.powershellExecutable ?? (platform === 'win32' || executable(powershell));

  if (!powershellExecutable) throw new Error('Windows PowerShell is unavailable.');
  if (platform !== 'win32' && !markerExists) {
    if (!launcherExecutable) throw new Error('WSL interoperability and /init fallback are unavailable.');
    return { command: launcher, prefixArguments: [powershell] };
  }
  return { command: powershell, prefixArguments: [] };
}

export function runPowerShell(script, extraArguments = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const scriptPath = isAbsolute(script) ? script : resolve(REPOSITORY_ROOT, script);
  const launch = resolvePowerShellLaunch({ ...options, platform });
  const fileArgument = platform === 'win32' ? scriptPath : windowsPath(scriptPath);
  return spawnSync(
    launch.command,
    [...launch.prefixArguments, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileArgument, ...extraArguments],
    { cwd: REPOSITORY_ROOT, stdio: 'inherit', windowsHide: true }
  );
}

function main() {
  const [script, ...extraArguments] = process.argv.slice(2);
  if (!script) {
    console.error('usage: node scripts/run-powershell.mjs SCRIPT.ps1 [ARG ...]');
    return 2;
  }
  try {
    const result = runPowerShell(script, extraArguments);
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (error) {
    console.error(`[agent-fleet][powershell][error] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
