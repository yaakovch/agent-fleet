import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { CodexProfileSettings } from '../shared/settings';
import type { WslDiscoveryResult, WslDistributionDiscovery } from '../shared/app';
import type { WslProcessOwnership } from './wsl-process-ownership';

export interface WslDiscoveryRunner {
  (args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }>;
}

const DISCOVERY_SCRIPT = [
  "printf 'user=%s\\n' \"$(id -un 2>/dev/null)\"",
  "printf 'home=%s\\n' \"$HOME\"",
  "printf 'executable=%s\\n' \"$(command -v codex 2>/dev/null || true)\"",
  "for dir in \"$HOME\"/.codex*; do [ -d \"$dir\" ] && printf 'codexHome=%s\\n' \"$dir\"; done"
].join('; ');
const MAX_DISTRIBUTIONS = 32;
const DISCOVERY_CONCURRENCY = 4;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_DISCOVERY_VALUES_PER_FIELD = 64;

export async function discoverWslProfiles(
  runner?: WslDiscoveryRunner,
  processOwnership?: WslProcessOwnership
): Promise<WslDiscoveryResult> {
  const execute = runner ?? ((args, timeoutMs) => runWslDiscovery(args, timeoutMs, processOwnership));
  const list = await execute(['--list', '--quiet'], 5000);
  if (
    list.error ||
    list.status !== 0 ||
    Buffer.byteLength(list.stdout, 'utf8') > MAX_STDOUT_BYTES ||
    Buffer.byteLength(list.stderr, 'utf8') > MAX_STDERR_BYTES
  ) {
    return {
      wslAvailable: false,
      distributions: [],
      profiles: [],
      warnings: [safeDiscoveryError(list.error?.message || list.stderr || 'WSL is not available')]
    };
  }

  const listedNames = list.stdout
    .replaceAll('\0', '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const distroNames = [...new Set(listedNames)]
    .filter((name) => /^[\p{L}\p{N} ._-]{1,128}$/u.test(name))
    .slice(0, MAX_DISTRIBUTIONS);
  const distributions = await mapWithConcurrency(
    distroNames,
    DISCOVERY_CONCURRENCY,
    (name) => discoverDistribution(name, execute)
  );
  const warnings = distributions.filter((item) => item.error).map((item) => `${item.name}: ${item.error}`);
  if (listedNames.length !== distroNames.length) warnings.push('Some invalid or excessive WSL distribution records were ignored.');
  const profiles: CodexProfileSettings[] = [];

  for (const distro of distributions) {
    for (const codexHome of distro.codexHomes) {
      const base = codexHome.split('/').filter(Boolean).at(-1) ?? 'codex';
      const idBase = `${distro.name}-${base}`.replace(/[^a-zA-Z0-9._-]+/g, '-').toLowerCase();
      let id = idBase;
      let suffix = 2;
      while (profiles.some((profile) => profile.id === id)) id = `${idBase}-${suffix++}`;
      profiles.push({
        id,
        label: `${distro.name} ${base}`,
        enabled: true,
        order: profiles.length,
        distro: distro.name,
        user: distro.user,
        home: distro.home,
        codexHome,
        executable: distro.executable
      });
    }
  }

  if (distroNames.length === 0) warnings.push('No WSL distributions were found.');
  if (profiles.length === 0 && distroNames.length > 0) warnings.push('No .codex profile directories were found.');
  return { wslAvailable: true, distributions, profiles, warnings };
}

async function discoverDistribution(name: string, runner: WslDiscoveryRunner): Promise<WslDistributionDiscovery> {
  const result = await runner(['--distribution', name, '--exec', 'sh', '-lc', DISCOVERY_SCRIPT], 8000);
  if (
    result.error ||
    result.status !== 0 ||
    Buffer.byteLength(result.stdout, 'utf8') > MAX_STDOUT_BYTES ||
    Buffer.byteLength(result.stderr, 'utf8') > MAX_STDERR_BYTES
  ) {
    return {
      name,
      user: '',
      home: '',
      executable: '',
      codexHomes: [],
      error: safeDiscoveryError(result.error?.message || result.stderr || 'Discovery failed')
    };
  }
  const values = new Map<string, string[]>();
  for (const line of result.stdout.replaceAll('\0', '').split(/\r?\n/)) {
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1).trim();
    if (!value) continue;
    const items = values.get(key) ?? [];
    if (items.length >= MAX_DISCOVERY_VALUES_PER_FIELD) continue;
    items.push(value);
    values.set(key, items);
  }
  return {
    name,
    user: values.get('user')?.[0] ?? '',
    home: values.get('home')?.[0] ?? '',
    executable: values.get('executable')?.[0] ?? '',
    codexHomes: values.get('codexHome') ?? []
  };
}

export function runWslDiscovery(
  args: string[],
  timeoutMs: number,
  processOwnership?: WslProcessOwnership,
  spawnProcess: typeof spawn = spawn
): ReturnType<WslDiscoveryRunner> {
  return new Promise((resolve) => {
    const child = spawnProcess('wsl.exe', args, { windowsHide: true });
    try {
      processOwnership?.own(`discovery:${randomUUID()}`, child);
    } catch (error) {
      child.once('error', () => undefined);
      try { child.kill('SIGKILL'); } catch { /* the failed registration still owns cleanup */ }
      resolve({
        status: null,
        error: error instanceof Error ? error : new Error(String(error)),
        stdout: '',
        stderr: ''
      });
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (result: { status: number | null; error?: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
        stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8')
      });
    };
    const stopForExcessiveOutput = (): void => {
      if (!processOwnership?.release(child, 'protocol_failure')) child.kill();
      finish({ status: null, error: new Error('WSL discovery output exceeded its safety limit') });
    };
    const timer = setTimeout(() => {
      if (!processOwnership?.release(child, 'timeout')) child.kill();
      finish({ status: null, error: new Error('WSL discovery timed out') });
    }, timeoutMs);
    child.stdout.on('data', (value: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (stdoutBytes + chunk.length > MAX_STDOUT_BYTES) {
        stopForExcessiveOutput();
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (value: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (stderrBytes + chunk.length > MAX_STDERR_BYTES) {
        stopForExcessiveOutput();
        return;
      }
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on('error', (error) => {
      processOwnership?.release(child, 'protocol_failure');
      finish({ status: null, error });
    });
    child.on('close', (status) => finish({ status }));
  });
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await transform(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  return results;
}

function safeDiscoveryError(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  return cleaned.slice(0, 512) || 'Discovery failed';
}
