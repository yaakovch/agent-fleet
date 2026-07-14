import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export interface FleetSessionOpenTarget {
  id: string;
  hostId: string;
  project: string;
  sessionName: string;
  label: string;
}

export interface FleetTerminalCommand {
  command: 'wt.exe';
  args: string[];
}

export interface FleetWslAttachCommand {
  command: string;
  args: string[];
}

export class WindowsExecutableError extends Error {
  constructor(readonly code: 'wsl_not_found', message: string) {
    super(message);
    this.name = 'WindowsExecutableError';
  }
}

const VSCODE_EXTENSION_ID = 'wtmux.wtmux-image-paste';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,320}$/u;
const SAFE_SESSION = /^[A-Za-z0-9._-]{1,128}$/u;

export function buildFleetTerminalCommand(target: FleetSessionOpenTarget, distro: string): FleetTerminalCommand {
  const attach = buildFleetWslAttachCommand(target, distro);
  return {
    command: 'wt.exe',
    args: ['new-tab', '--title', target.label, attach.command, ...attach.args]
  };
}

export function buildFleetWslAttachCommand(target: FleetSessionOpenTarget, distro: string): FleetWslAttachCommand {
  if (!SAFE_ID.test(target.id) || !SAFE_ID.test(target.hostId)) throw new Error('Session identity is invalid');
  if (!SAFE_SESSION.test(target.sessionName)) throw new Error('Session name is invalid');
  if (!safeText(target.project, 256) || !safeText(target.label, 128) || !safeText(distro, 64)) {
    throw new Error('Session terminal metadata is invalid');
  }
  return {
    command: 'wsl.exe',
    args: [
      '-d', distro, '--cd', '~', '--',
      '.local/bin/wtmux', '--host', target.hostId, '--project', target.project,
      '--session', target.sessionName, '--fast'
    ]
  };
}

export function resolveWslExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): string {
  const systemRoot = environment.SystemRoot || environment.WINDIR;
  if (!systemRoot || /[\u0000-\u001f\u007f]/u.test(systemRoot)) {
    throw new WindowsExecutableError('wsl_not_found', 'Windows Subsystem for Linux could not be located.');
  }
  const executable = win32.join(systemRoot, 'System32', 'wsl.exe');
  if (!exists(executable)) {
    throw new WindowsExecutableError('wsl_not_found', 'Windows Subsystem for Linux is not installed or is unavailable.');
  }
  return executable;
}

export function openFleetTerminal(
  target: FleetSessionOpenTarget,
  distro: string,
  spawnProcess: typeof spawn = spawn
): Promise<void> {
  const launch = buildFleetTerminalCommand(target, distro);
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(launch.command, launch.args, { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

export function buildFleetVscodeUri(target: FleetSessionOpenTarget, distro: string): string {
  buildFleetTerminalCommand(target, distro);
  const query = new URLSearchParams({
    host: target.hostId,
    project: target.project,
    session: target.sessionName,
    distro
  });
  return `vscode://${VSCODE_EXTENSION_ID}/open?${query.toString()}`;
}

export async function openFleetVscode(
  target: FleetSessionOpenTarget,
  distro: string,
  execProcess: typeof execFile = execFile,
  spawnProcess: typeof spawn = spawn
): Promise<void> {
  const extensions = await new Promise<string>((resolve, reject) => {
    execProcess('code.cmd', ['--list-extensions'], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
  if (!extensions.split(/\r?\n/u).some((value) => value.trim().toLowerCase() === VSCODE_EXTENSION_ID)) {
    throw new Error('wtmux VS Code integration is not installed');
  }
  const uri = buildFleetVscodeUri(target, distro);
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess('code.cmd', ['--reuse-window', '--open-url', uri], {
      detached: true, stdio: 'ignore', windowsHide: false
    });
    child.once('spawn', () => { child.unref(); resolve(); });
    child.once('error', reject);
  });
}

function safeText(value: string, maximum: number): boolean {
  return Boolean(value) && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}
