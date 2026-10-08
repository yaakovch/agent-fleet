import { spawn } from 'node:child_process';
import { resolveWslExecutable } from './fleet-terminal';

/** Fixed runtime commands never consume input; keep their pipes and deadline bounded. */
export function runRuntimeCommand(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' && command === 'wsl.exe' ? resolveWslExecutable() : command;
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try { child.kill(); } catch { /* only this command's process is owned */ }
        reject(error);
      } else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => finish(new Error(`Runtime command timed out after ${timeoutMs} ms`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const accept = (value: string, error: boolean): void => {
      if (settled) return;
      bytes += Buffer.byteLength(value);
      if (bytes > 512 * 1024) { finish(new Error('Runtime command output exceeded its limit')); return; }
      if (error) stderr += value; else stdout += value;
    };
    child.stdout.on('data', (value: string) => accept(value, false));
    child.stderr.on('data', (value: string) => accept(value, true));
    child.once('error', finish);
    child.once('close', (code, signal) => finish(code === 0 ? undefined
      : new Error(`Runtime command failed (${signal || code}): ${stderr.slice(0, 500).trim()}`)));
  });
}
