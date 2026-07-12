import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetBridgeSupervisor, fleetBridgeLaunchFromSettings } from '../src/main/fleet-bridge';
import { createDefaultSettings } from '../src/shared/settings';
import type { FleetBridgeView } from '../src/shared/fleet-protocol';

const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'fleet-snapshot-v1.json'), 'utf8'));
const temporaryDirectories: string[] = [];
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('fleet bridge supervisor', () => {
  it('uses a direct WSL argv launch without interpolated shell text', () => {
    const launch = fleetBridgeLaunchFromSettings(createDefaultSettings());
    expect(launch).toEqual({
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', '~', '--', '.local/bin/wtmux-bridge', '--stdio'],
      distro: 'Ubuntu'
    });
  });

  it('accepts a correlated snapshot and saves only the verified cache', async () => {
    const directory = temporaryDirectory();
    const script = writeFakeBridge(directory, fixture);
    const cachePath = join(directory, 'fleet-cache-v1.json');
    const supervisor = new FleetBridgeSupervisor({
      cachePath,
      launch: { command: process.execPath, args: [script], distro: 'Test Linux' },
      logger
    });
    const live = waitForStatus(supervisor, 'live');
    supervisor.start();
    const view = await live;
    expect(view.snapshot.sessions[0]?.name).toBe('project:1');
    expect(view.snapshot.schedules[0]?.summary).toBe('Scheduled message');
    const cache = readFileSync(cachePath, 'utf8');
    expect(cache).not.toContain('continue');
    expect(cache).not.toContain('private pane title');
    supervisor.stop();
  }, 20_000);

  it('sends a revisioned mutation and accepts only the returned aggregate snapshot', async () => {
    const directory = temporaryDirectory();
    const script = writeFakeBridge(directory, fixture);
    const supervisor = new FleetBridgeSupervisor({
      cachePath: join(directory, 'fleet-cache-v1.json'),
      launch: { command: process.execPath, args: [script], distro: 'Test Linux' },
      logger
    });
    const live = waitForStatus(supervisor, 'live');
    supervisor.start();
    await live;
    const result = await supervisor.mutate('session.kill', {
      hostId: 'test-host',
      sessionId: 'test-host:session-1',
      idempotencyKey: 'operation-1'
    });
    expect(result.operationId).toBe('operation-1');
    expect(result.status).toBe('killed');
    expect(result.snapshot.revision).toBe('fixture-revision');
    supervisor.stop();
  }, 20_000);

  it('accepts the created session identity from a typed launcher mutation', async () => {
    const directory = temporaryDirectory();
    const supervisor = new FleetBridgeSupervisor({
      cachePath: join(directory, 'fleet-cache-v1.json'),
      launch: { command: process.execPath, args: [writeFakeBridge(directory, fixture)], distro: 'Test Linux' },
      logger
    });
    const live = waitForStatus(supervisor, 'live');
    supervisor.start();
    await live;
    const result = await supervisor.mutate('session.create', {
      hostId: 'test-host', project: 'project', backend: 'linux', tool: 'codex', idempotencyKey: 'launch-1'
    });
    expect(result.status).toBe('created');
    expect(result.sessionId).toBe('test-host:session-1');
    supervisor.stop();
  }, 20_000);

  it('resets the stream when a mutation times out so its late response cannot poison correlation', async () => {
    const directory = temporaryDirectory();
    const script = writeFakeBridge(directory, fixture, 100);
    const supervisor = new FleetBridgeSupervisor({
      cachePath: join(directory, 'fleet-cache-v1.json'),
      launch: { command: process.execPath, args: [script], distro: 'Test Linux' },
      logger,
      mutationTimeoutMs: 20
    });
    const live = waitForStatus(supervisor, 'live');
    supervisor.start();
    await live;
    await expect(supervisor.mutate('session.kill', {
      hostId: 'test-host', sessionId: 'test-host:session-1', idempotencyKey: 'operation-timeout'
    })).rejects.toMatchObject({ code: 'timeout' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(supervisor.getView().status).not.toBe('error');
    supervisor.stop();
  }, 20_000);

  it('loads a previously verified snapshot when the bridge is offline', async () => {
    const directory = temporaryDirectory();
    const cachePath = join(directory, 'fleet-cache-v1.json');
    writeFileSync(cachePath, JSON.stringify({
      cacheVersion: 1,
      protocolVersion: 1,
      savedAt: '2026-07-12T04:01:00Z',
      snapshot: fixture
    }));
    const supervisor = new FleetBridgeSupervisor({
      cachePath,
      launch: { command: join(directory, 'missing-command'), args: [], distro: 'Test Linux' },
      logger
    });
    expect(supervisor.getView().status).toBe('cached');
    expect(supervisor.getView().snapshot.hosts[0]?.name).toBe('Test Host');
    supervisor.start();
    const view = await waitForAnyStatus(supervisor, ['cached', 'offline']);
    expect(view.snapshot.sessions).toHaveLength(1);
    supervisor.stop();
  });

  it('keeps verified host data visible while a new bridge connection settles', async () => {
    const directory = temporaryDirectory();
    const cachePath = join(directory, 'fleet-cache-v1.json');
    writeFileSync(cachePath, JSON.stringify({
      cacheVersion: 1, protocolVersion: 1, savedAt: '2026-07-12T04:01:00Z', snapshot: fixture
    }));
    const settling = structuredClone(fixture);
    settling.revision = 'settling';
    settling.hosts[0].status = 'connecting';
    settling.hosts[0].lastSeenAt = null;
    settling.sessions = [];
    settling.schedules = [];
    const script = writeFakeBridge(directory, settling);
    const supervisor = new FleetBridgeSupervisor({
      cachePath,
      launch: { command: process.execPath, args: [script], distro: 'Test Linux' },
      logger
    });
    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(supervisor.getView().status).toBe('cached');
    expect(supervisor.getView().snapshot.sessions).toHaveLength(1);
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).snapshot.revision).toBe('fixture-revision');
    supervisor.stop();
  });

  it('rejects a privacy-expanding frame without replacing cache', async () => {
    const directory = temporaryDirectory();
    const malicious = structuredClone(fixture);
    malicious.sessions[0].title = 'private pane title';
    const script = writeFakeBridge(directory, malicious);
    const cachePath = join(directory, 'fleet-cache-v1.json');
    const supervisor = new FleetBridgeSupervisor({
      cachePath,
      launch: { command: process.execPath, args: [script], distro: 'Test Linux' },
      logger
    });
    const failed = waitForStatus(supervisor, 'error');
    supervisor.start();
    const view = await failed;
    expect(view.errorCode).toBe('protocol_error');
    expect(view.snapshot.sessions).toHaveLength(0);
    expect(() => readFileSync(cachePath, 'utf8')).toThrow();
    supervisor.stop();
  }, 20_000);
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agent-fleet-bridge-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFakeBridge(directory: string, snapshot: unknown, responseDelayMs = 0): string {
  const script = join(directory, 'fake-bridge.cjs');
  writeFileSync(script, `
const readline = require('node:readline');
const snapshot = ${JSON.stringify(snapshot)};
const responseDelayMs = ${responseDelayMs};
function emit(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
emit({ protocolVersion: 1, type: 'event', eventId: 'event-1', event: 'fleet.heartbeat',
  timestamp: new Date().toISOString(), revision: snapshot.revision, data: { hostCount: snapshot.hosts.length } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  const result = request.method === 'fleet.snapshot' ? snapshot : {
    operationId: request.params.idempotencyKey,
    status: request.method === 'session.create' ? 'created' : request.method === 'session.kill' ? 'killed' : 'cancelled',
    snapshot,
    ...(request.method === 'session.create' ? { sessionId: 'test-host:session-1' } : {})
  };
  setTimeout(() => emit({ protocolVersion: 1, type: 'response', requestId: request.requestId,
    timestamp: new Date().toISOString(), ok: true, result }), responseDelayMs);
});
`, 'utf8');
  return script;
}

function waitForStatus(supervisor: FleetBridgeSupervisor, status: FleetBridgeView['status']): Promise<FleetBridgeView> {
  return waitForAnyStatus(supervisor, [status]);
}

function waitForAnyStatus(supervisor: FleetBridgeSupervisor, statuses: FleetBridgeView['status'][]): Promise<FleetBridgeView> {
  const current = supervisor.getView();
  if (statuses.includes(current.status)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${statuses.join(', ')}`)), 15_000);
    supervisor.on('changed', (view: FleetBridgeView) => {
      if (!statuses.includes(view.status)) return;
      clearTimeout(timeout);
      resolve(view);
    });
  });
}
