import { writeFileSync } from 'node:fs';
import * as nodePty from 'node-pty';
import { resolveWslExecutable } from './fleet-terminal';

const MARKER = 'AGENT_FLEET_CONPTY_OK';

export async function runPackagedTerminalSmoke(destination: string): Promise<boolean> {
  const active: { pty?: nodePty.IPty } = {};
  let output = '';
  try {
    const executable = resolveWslExecutable();
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { active.pty?.kill(); } catch { /* already stopped */ }
        finish(false);
      }, 20_000);
      active.pty = nodePty.spawn(executable, ['--exec', 'sh', '-lc', `printf ${MARKER}`], {
        name: 'xterm-256color', cols: 80, rows: 24,
        cwd: process.env.USERPROFILE || process.cwd(), env: process.env
      });
      active.pty.onData((data) => {
        if (output.length < 64 * 1024) output += data;
      });
      active.pty.onExit(({ exitCode }) => finish(exitCode === 0 && output.includes(MARKER)));
    });
    writeFileSync(destination, `${JSON.stringify({ status: ok ? 'ok' : 'failed', marker: ok })}\n`, { mode: 0o600 });
    return ok;
  } catch (error) {
    const message = error instanceof Error ? error.message.split(/\r?\n/u)[0].slice(0, 240) : 'terminal smoke failed';
    writeFileSync(destination, `${JSON.stringify({ status: 'error', marker: false, message })}\n`, { mode: 0o600 });
    return false;
  } finally {
    try { active.pty?.kill(); } catch { /* already stopped */ }
  }
}
