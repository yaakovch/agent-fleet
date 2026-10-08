import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as nodePty from 'node-pty';
import { resolveWslExecutable } from './fleet-terminal';

const MARKER = 'AGENT_FLEET_CONPTY_OK';

interface SmokeCommand {
  executable: string;
  arguments: string[];
  backend: 'wsl' | 'conpty';
}

function smokeCommand(): SmokeCommand {
  const wsl = resolveWslExecutable();
  const distributions = spawnSync(wsl, ['--list', '--quiet'], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024
  });
  if (distributions.status === 0 && distributions.stdout.replace(/\u0000/gu, '').trim()) {
    return { executable: wsl, arguments: ['--exec', 'sh', '-lc', `printf ${MARKER}`], backend: 'wsl' };
  }
  const powershell = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  return {
    executable: powershell,
    arguments: ['-NoProfile', '-NonInteractive', '-Command', `[Console]::Write('${MARKER}')`],
    backend: 'conpty'
  };
}

export async function runPackagedTerminalSmoke(destination: string): Promise<boolean> {
  const active: { pty?: nodePty.IPty } = {};
  let output = '';
  let processExitCode: number | undefined;
  try {
    const command = smokeCommand();
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        const pty = active.pty; active.pty = undefined;
        try { pty?.kill(); } catch { /* already stopped */ }
        finish(false);
      }, 20_000);
      active.pty = nodePty.spawn(command.executable, command.arguments, {
        name: 'xterm-256color', cols: 80, rows: 24,
        cwd: process.env.USERPROFILE || process.cwd(), env: process.env
      });
      active.pty.onData((data) => {
        if (output.length < 64 * 1024) output += data;
      });
      active.pty.onExit(({ exitCode }) => {
        // A completed ConPTY handle must not be killed again in finally. Let
        // the final queued pipe data arrive before checking its marker.
        active.pty = undefined;
        processExitCode = exitCode;
        setTimeout(() => finish(exitCode === 0 && output.includes(MARKER)), 100);
      });
    });
    writeFileSync(destination, `${JSON.stringify({ status: ok ? 'ok' : 'failed', marker: output.includes(MARKER), backend: command.backend, exitCode: processExitCode, output: output.slice(-1024) })}\n`, { mode: 0o600 });
    return ok;
  } catch (error) {
    const message = error instanceof Error ? error.message.split(/\r?\n/u)[0].slice(0, 240) : 'terminal smoke failed';
    writeFileSync(destination, `${JSON.stringify({ status: 'error', marker: false, message })}\n`, { mode: 0o600 });
    return false;
  } finally {
    try { active.pty?.kill(); } catch { /* already stopped */ }
  }
}
