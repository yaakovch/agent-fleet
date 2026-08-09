import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FleetBridgeSupervisor,
  fleetBridgeLaunchFromSettings,
  parsePairingProposalReview,
  redactSessionTitles
} from '../src/main/fleet-bridge';
import { createDefaultSettings } from '../src/shared/settings';
import type { FleetBridgeView } from '../src/shared/fleet-protocol';

const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'fleet-snapshot-v1.json'), 'utf8'));
const temporaryDirectories: string[] = [];
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('fleet bridge supervisor', () => {
  it('rejects bidi-format controls in an exact pairing proposal review', () => {
    const proposal = pairingProposalReview();
    proposal.proposal.hostCommand = 'safe\u202Etxt.exe';
    expect(() => parsePairingProposalReview(proposal)).toThrow(/proposal field is invalid/i);
    expect(() => parsePairingProposalReview({
      ...pairingProposalReview(),
      proposal: { ...pairingProposalReview().proposal, schemaVersion: 1.5 }
    })).toThrow(/proposal schema is invalid/i);
  });
  it('binds an exact pairing proposal to its verified review envelope and peer', () => {
    const valid = pairingProposalReview();
    expect(parsePairingProposalReview(valid)?.id).toBe('pair-1');
    expect(parsePairingProposalReview({
      ...valid,
      proposal: { ...valid.proposal, tailscaleNode: '' }
    })?.id).toBe('pair-1');

    for (const mismatched of [
      { ...valid, deviceId: 'other-phone' },
      { ...valid, deviceName: 'Other phone' },
      { ...valid, platform: 'Other platform' },
      { ...valid, reviewedAt: '2026-08-01T00:30:00Z' },
      { ...valid, publicationRef: 'published' },
      { ...valid, proposal: { ...valid.proposal, tailscaleNode: 'other.tailnet.ts.net' } },
      { ...valid, proposal: { ...valid.proposal, roles: ['client', 'client'] } }
    ]) {
      expect(() => parsePairingProposalReview(mismatched)).toThrow(/pairing proposal/i);
    }
  });
  it('uses a direct WSL argv launch without interpolated shell text', () => {
    const launch = fleetBridgeLaunchFromSettings(createDefaultSettings());
    expect(launch).toEqual({
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', '~', '--', '.local/share/agent-fleet/wtmux/current/scripts/wtmux-bridge', '--stdio', '--pairing', '--identity-graph', '--session-titles'],
      distro: 'Ubuntu'
    });
  });

  it('purges negotiated titles and their presentation revision from cached state', () => {
    const enhanced = structuredClone(fixture);
    enhanced.presentationRevision = 'title-revision';
    enhanced.sessions[0].title = 'Fix the release picker';
    enhanced.sessions[0].nameMode = 'automatic';
    const redacted = redactSessionTitles(enhanced);
    expect(redacted.presentationRevision).toBeUndefined();
    expect(redacted.sessions[0]).toMatchObject({ name: 'project:1', title: '', nameMode: 'automatic' });
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

  it('returns transient directory data without putting it in the snapshot cache', async () => {
    const directory = temporaryDirectory();
    const cachePath = join(directory, 'fleet-cache-v1.json');
    const supervisor = new FleetBridgeSupervisor({
      cachePath,
      launch: { command: process.execPath, args: [writeFakeBridge(directory, fixture)], distro: 'Test Linux' },
      logger
    });
    const live = waitForStatus(supervisor, 'live');
    supervisor.start();
    await live;
    const listing = await supervisor.mutate('directory.list', {
      hostId: 'test-host', backend: 'linux', path: '', idempotencyKey: 'directory-1'
    });
    expect(listing.entries[0]).toEqual({ name: 'private-work', path: '/home/test/private-work' });
    expect(readFileSync(cachePath, 'utf8')).not.toContain('private-work');
    supervisor.stop();
  }, 20_000);

  it('returns repository pages without putting file names in the snapshot cache', async () => {
    const directory = temporaryDirectory();
    const cachePath = join(directory, 'fleet-cache-v1.json');
    const supervisor = new FleetBridgeSupervisor({
      cachePath,
      launch: { command: process.execPath, args: [writeFakeBridge(directory, fixture)], distro: 'Test Linux' },
      logger
    });
    const live = waitForStatus(supervisor, 'live');
    supervisor.start();
    await live;
    const page = await supervisor.mutate('repository.list', {
      hostId: 'test-host', sessionId: 'test-host:session-1', relativePath: '', includeHidden: false,
      cursor: '', idempotencyKey: 'repository-1'
    });
    expect(page.entries[0]?.relativePath).toBe('private-report.pdf');
    expect(readFileSync(cachePath, 'utf8')).not.toContain('private-report.pdf');
    supervisor.stop();
  }, 20_000);

  it('uses the dedicated session revision for model control and never caches it in the fleet snapshot', async () => {
    const directory = temporaryDirectory();
    const cachePath = join(directory, 'fleet-cache-v1.json');
    const supervisor = new FleetBridgeSupervisor({
      cachePath,
      launch: { command: process.execPath, args: [writeFakeBridge(directory, fixture)], distro: 'Test Linux' },
      logger
    });
    const live = waitForStatus(supervisor, 'live');
    supervisor.start();
    await live;
    const state = await supervisor.mutate('session.model.get', {
      hostId: 'test-host', sessionId: 'test-host:session-1', includeCatalog: true
    });
    expect(state).toMatchObject({ configRevision: '0123456789abcdef', tool: 'codex' });
    const changed = await supervisor.mutate('session.model.set', {
      hostId: 'test-host', sessionId: 'test-host:session-1', modelId: 'provider/model-2', effortId: 'high',
      custom: false, expectedConfigRevision: state.configRevision, idempotencyKey: 'model-operation-1',
      historyImpactAcknowledged: true
    });
    expect(changed).toMatchObject({ status: 'queued', modelControl: { sessionId: 'test-host:session-1' } });
    expect(readFileSync(cachePath, 'utf8')).not.toContain('provider/model-2');
    supervisor.stop();
  }, 20_000);

  it('waits for a cached controller to become live before a repository read', async () => {
    const directory = temporaryDirectory();
    const cachePath = join(directory, 'fleet-cache-v1.json');
    writeFileSync(cachePath, JSON.stringify({
      cacheVersion: 1, protocolVersion: 1, savedAt: '2026-07-12T04:01:00Z', snapshot: fixture
    }));
    const supervisor = new FleetBridgeSupervisor({
      cachePath,
      launch: { command: process.execPath, args: [writeFakeBridge(directory, fixture, 100)], distro: 'Test Linux' },
      logger
    });
    supervisor.start();
    const page = await supervisor.mutate('repository.list', {
      hostId: 'test-host', sessionId: 'test-host:session-1', relativePath: '', includeHidden: false,
      cursor: '', idempotencyKey: 'repository-while-cached'
    });
    expect(page.entries[0]?.relativePath).toBe('private-report.pdf');
    supervisor.stop();
  }, 20_000);

  it('preserves a permanent repository failure code and message', async () => {
    const directory = temporaryDirectory();
    const supervisor = new FleetBridgeSupervisor({
      cachePath: join(directory, 'fleet-cache-v1.json'),
      launch: { command: process.execPath, args: [writeFakeBridge(directory, fixture)], distro: 'Test Linux' },
      logger
    });
    const live = waitForStatus(supervisor, 'live');
    supervisor.start();
    await live;
    await expect(supervisor.mutate('repository.list', {
      hostId: 'test-host', sessionId: 'test-host:session-1', relativePath: 'missing', includeHidden: false,
      cursor: '', idempotencyKey: 'repository-missing'
    })).rejects.toMatchObject({
      code: 'repository_unavailable', message: 'Repository path is unavailable for this session'
    });
    supervisor.stop();
  }, 20_000);

  it('returns an invitation secret only to the caller and never writes it to the fleet cache', async () => {
    const directory = temporaryDirectory();
    const cachePath = join(directory, 'fleet-cache-v1.json');
    const supervisor = new FleetBridgeSupervisor({
      cachePath,
      launch: { command: process.execPath, args: [writeFakeBridge(directory, fixture)], distro: 'Test Linux' },
      logger
    });
    const live = waitForStatus(supervisor, 'live');
    supervisor.start();
    await live;
    const result = await supervisor.mutate('pairing.invite', { idempotencyKey: 'pair-invite-1' });
    expect(result.invitation?.shortCode.split('-')).toHaveLength(6);
    expect(result.invitation?.link).toContain('psecretToken1234567890A');
    expect(readFileSync(cachePath, 'utf8')).not.toContain('psecretToken1234567890A');
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

  it('reuses one control process and applies bounded backpressure to concurrent requests', async () => {
    const directory = temporaryDirectory();
    const supervisor = new FleetBridgeSupervisor({
      cachePath: join(directory, 'fleet-cache-v1.json'),
      launch: {
        command: process.execPath,
        args: [writeFakeBridge(directory, fixture, 75)],
        distro: 'Test Linux'
      },
      logger
    });
    const live = waitForStatus(supervisor, 'live');
    supervisor.start();
    await live;
    const first = supervisor.mutate('directory.list', {
      hostId: 'test-host', backend: 'linux', path: '', idempotencyKey: 'directory-first'
    });
    await expect(supervisor.mutate('directory.list', {
      hostId: 'test-host', backend: 'linux', path: '', idempotencyKey: 'directory-second'
    })).rejects.toMatchObject({ code: 'backpressure' });
    await first;
    supervisor.refresh();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(supervisor.getSupervisorMetrics()).toMatchObject({
      processStarts: 1,
      currentControlProcesses: 1,
      connectionGeneration: 1
    });
    expect(supervisor.getSupervisorState()).toMatchObject({ phase: 'ready', health: 'healthy' });
    expect(supervisor.getSupervisorMetrics().lastRequestDurationMs).not.toBeNull();
    expect(supervisor.getSupervisorMetrics().lastSnapshotDurationMs).not.toBeNull();
    supervisor.setForeground(false);
    expect(supervisor.getSupervisorState()).toMatchObject({ foreground: false, controlProcessCount: 1 });
    supervisor.setForeground(true);
    expect(supervisor.getSupervisorMetrics().processStarts).toBe(1);
    supervisor.stop();
    expect(supervisor.getSupervisorState()).toMatchObject({ phase: 'stopped', controlProcessCount: 0 });
  }, 20_000);

  it('ignores delayed events from a stopped child after a replacement starts', () => {
    const directory = temporaryDirectory();
    const first = createRespondingChild(fixture);
    const second = createRespondingChild(fixture);
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child);
    const supervisor = new FleetBridgeSupervisor({
      cachePath: join(directory, 'fleet-cache-v1.json'),
      launch: { command: 'fake-bridge', args: [], distro: 'Test Linux' },
      logger,
      spawnProcess: spawnProcess as never
    });

    supervisor.start();
    expect(supervisor.getView().status).toBe('live');
    supervisor.stop();
    supervisor.start();
    expect(supervisor.getView().status).toBe('live');
    const secondWrites = second.writes.mock.calls.length;

    first.stdout.write('stale output\n');
    first.child.emit('error', new Error('delayed old child error'));
    first.child.emit('exit', 1, null);
    supervisor.refresh();

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(second.writes).toHaveBeenCalledTimes(secondWrites + 1);
    expect(supervisor.getSupervisorMetrics()).toMatchObject({
      processStarts: 2,
      currentControlProcesses: 1
    });
    expect(supervisor.getView().status).toBe('live');
    supervisor.stop();
  });

  it('reconnects after a protocol-failed child ignores termination and never exits', async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const first = createRespondingChild(fixture);
    const second = createRespondingChild(fixture);
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child);
    const supervisor = new FleetBridgeSupervisor({
      cachePath: join(directory, 'fleet-cache-v1.json'),
      launch: { command: 'fake-bridge', args: [], distro: 'Test Linux' },
      logger,
      spawnProcess: spawnProcess as never,
      terminationTimeoutMs: 10
    });
    try {
      supervisor.start();
      expect(supervisor.getView().status).toBe('live');
      first.stdout.write('{}\n');
      expect(first.child.kill).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_011);

      expect(spawnProcess).toHaveBeenCalledTimes(2);
      expect(supervisor.getView().status).toBe('live');
      expect(supervisor.getSupervisorMetrics()).toMatchObject({
        processStarts: 2,
        currentControlProcesses: 1
      });
    } finally {
      supervisor.stop();
      vi.useRealTimers();
    }
  });

  it('never trusts later frames from a protocol-failed bridge generation', () => {
    const directory = temporaryDirectory();
    const controlled = createControlledChild();
    const cachePath = join(directory, 'fleet-cache-v1.json');
    const supervisor = new FleetBridgeSupervisor({
      cachePath,
      launch: { command: 'fake-bridge', args: [], distro: 'Test Linux' },
      logger,
      spawnProcess: vi.fn(() => controlled.child) as never,
      terminationTimeoutMs: 10_000
    });
    supervisor.start();
    const initialRequest = controlled.requests[0];
    controlled.respond(initialRequest, fixture);
    expect(supervisor.getView().status).toBe('live');

    supervisor.refresh();
    const pendingRequest = controlled.requests[1];
    const poisoned = structuredClone(fixture);
    poisoned.revision = 'must-not-be-trusted';
    const refreshOnFailure = vi.fn((view: FleetBridgeView) => {
      if (view.status === 'error') supervisor.refresh();
    });
    supervisor.on('changed', refreshOnFailure);
    controlled.stdout.write('{}\n');
    controlled.respond(pendingRequest, poisoned);

    expect(controlled.child.kill).toHaveBeenCalledOnce();
    expect(controlled.requests).toHaveLength(2);
    expect(supervisor.getView()).toMatchObject({
      status: 'error',
      errorCode: 'protocol_error',
      snapshot: { revision: 'fixture-revision' }
    });
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).snapshot.revision).toBe('fixture-revision');
    supervisor.stop();
  });

  it('parses a highly fragmented frame with one bounded assembly', () => {
    const directory = temporaryDirectory();
    const controlled = createControlledChild();
    const supervisor = new FleetBridgeSupervisor({
      cachePath: join(directory, 'fleet-cache-v1.json'),
      launch: { command: 'fake-bridge', args: [], distro: 'Test Linux' },
      logger,
      spawnProcess: vi.fn(() => controlled.child) as never
    });
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      supervisor.start();
      const frame = controlled.responseFrame(controlled.requests[0], fixture);
      for (const byte of frame) controlled.stdout.write(Buffer.from([byte]));
      expect(supervisor.getView().status).toBe('live');
      expect(concat.mock.calls.length).toBeLessThan(32);
    } finally {
      concat.mockRestore();
      supervisor.stop();
    }
  });

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

  it('accepts a validated connecting snapshot after the bounded settle budget and keeps refreshing', async () => {
    vi.useFakeTimers();
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
    const healthy = structuredClone(fixture);
    healthy.revision = 'healthy-after-settle';
    let currentSnapshot = settling;
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          const request = JSON.parse(chunk.toString('utf8'));
          stdout.write(`${JSON.stringify({
            protocolVersion: 1,
            type: 'response',
            requestId: request.requestId,
            timestamp: new Date().toISOString(),
            ok: true,
            result: currentSnapshot
          })}\n`);
          callback();
        }
      }),
      killed: false,
      kill: vi.fn(() => true)
    });
    const supervisor = new FleetBridgeSupervisor({
      cachePath,
      launch: { command: 'fake-bridge', args: [], distro: 'Test Linux' },
      logger,
      spawnProcess: vi.fn(() => child) as never
    });
    try {
      supervisor.start();
      expect(supervisor.getView().status).toBe('cached');

      await vi.advanceTimersByTimeAsync(10_001);

      expect(supervisor.getView()).toMatchObject({
        status: 'live',
        snapshot: { revision: 'settling', sessions: [] }
      });
      expect(JSON.parse(readFileSync(cachePath, 'utf8')).snapshot.revision).toBe('fixture-revision');

      currentSnapshot = healthy;
      supervisor.refresh();
      expect(supervisor.getView()).toMatchObject({
        status: 'live',
        snapshot: { revision: 'healthy-after-settle' }
      });
      expect(JSON.parse(readFileSync(cachePath, 'utf8')).snapshot.revision).toBe('healthy-after-settle');
    } finally {
      supervisor.stop();
      vi.useRealTimers();
    }
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
  if (request.method === 'repository.list' && request.params.relativePath === 'missing') {
    emit({ protocolVersion: 1, type: 'response', requestId: request.requestId,
      timestamp: new Date().toISOString(), ok: false,
      error: { code: 'repository_unavailable', message: 'Repository path is unavailable for this session' } });
    return;
  }
  if (request.method.startsWith('session.model.') && Object.hasOwn(request.params, 'expectedRevision')) {
    emit({ protocolVersion: 1, type: 'response', requestId: request.requestId,
      timestamp: new Date().toISOString(), ok: false,
      error: { code: 'invalid_request', message: 'fleet revision must not be sent for model control' } });
    return;
  }
  const result = request.method === 'fleet.snapshot' ? snapshot : request.method === 'directory.list' ? {
    backend: 'linux', path: '/home/test', parentPath: '/home', truncated: false,
    entries: [{ name: 'private-work', path: '/home/test/private-work' }],
    shortcuts: [{ id: 'home', label: 'Home', path: '/home/test' }]
  } : request.method === 'repository.list' ? {
    rootName: 'project', relativePath: '', parentPath: null, nextCursor: null, truncated: false,
    entries: [{ name: 'private-report.pdf', relativePath: 'private-report.pdf', kind: 'file', size: 12,
      modifiedAt: '2026-07-14T12:00:00Z', hidden: false, isLink: false }]
  } : request.method === 'session.model.get' ? {
    sessionId: 'test-host:session-1', configRevision: '0123456789abcdef', tool: 'codex', status: 'ready',
    selected: { modelId: 'auto', modelLabel: 'Auto', effortId: 'automatic', effortLabel: 'Automatic' },
    effective: null, pending: null,
    catalog: { customAllowed: true, models: [
      { id: 'auto', label: 'Auto', description: 'Provider default', isDefault: true,
        efforts: [{ id: 'automatic', label: 'Automatic' }], defaultEffort: 'automatic' },
      { id: 'provider/model-2', label: 'Provider Model 2', description: 'Discovered', isDefault: false,
        efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high' }
    ] }, detail: ''
  } : request.method === 'session.model.set' || request.method === 'session.model.cancel' ? {
    operationId: request.params.idempotencyKey, status: request.method === 'session.model.set' ? 'queued' : 'cancelled',
    modelControl: { sessionId: 'test-host:session-1', configRevision: 'fedcba9876543210', tool: 'codex', status: 'ready',
      selected: { modelId: 'auto', modelLabel: 'Auto', effortId: 'automatic', effortLabel: 'Automatic' },
      effective: null, pending: null, catalog: null, detail: '' }
  } : {
    operationId: request.params.idempotencyKey,
    status: request.method === 'session.create' ? 'created' : request.method === 'session.kill' ? 'killed' : 'cancelled',
    snapshot,
    ...(request.method === 'session.create' ? { sessionId: 'test-host:session-1' } : {}),
    ...(request.method === 'pairing.invite' ? { invitation: {
      invitationId: 'invite-1', shortCode: 'baba-bebe-bibi-bobo-dada-dede',
      bootstrapPeer: 'controller.tailnet.ts.net', bootstrapUser: 'controller', expiresAt: '2026-07-12T05:10:00Z',
      link: 'wtmux://pair?token=psecretToken1234567890A',
      termuxCommand: 'wtmux-pair-client pair --invitation wtmux://pair?token=psecretToken1234567890A',
      file: { pairingVersion: 1, bootstrapPeer: 'controller.tailnet.ts.net', bootstrapUser: 'controller',
        token: 'psecretToken1234567890A', expiresAt: '2026-07-12T05:10:00Z' }
    }} : {})
  };
  setTimeout(() => emit({ protocolVersion: 1, type: 'response', requestId: request.requestId,
    timestamp: new Date().toISOString(), ok: true, result }), responseDelayMs);
});
`, 'utf8');
  return script;
}

function createRespondingChild(snapshot: unknown): {
  child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  stdout: PassThrough;
  writes: ReturnType<typeof vi.fn>;
} {
  const stdout = new PassThrough();
  const writes = vi.fn((chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
    const request = JSON.parse(chunk.toString()) as { requestId: string };
    stdout.write(`${JSON.stringify({
      protocolVersion: 1,
      type: 'response',
      requestId: request.requestId,
      timestamp: new Date().toISOString(),
      ok: true,
      result: snapshot
    })}\n`);
    callback();
  });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    stdin: new Writable({ write: writes }),
    killed: false,
    kill: vi.fn(() => true)
  });
  return { child, stdout, writes };
}

function createControlledChild(): {
  child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  stdout: PassThrough;
  requests: string[];
  responseFrame(requestId: string, result: unknown): Buffer;
  respond(requestId: string, result: unknown): void;
} {
  const stdout = new PassThrough();
  const requests: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        requests.push((JSON.parse(chunk.toString()) as { requestId: string }).requestId);
        callback();
      }
    }),
    killed: false,
    kill: vi.fn(() => true)
  });
  const responseFrame = (requestId: string, result: unknown): Buffer => Buffer.from(`${JSON.stringify({
    protocolVersion: 1,
    type: 'response',
    requestId,
    timestamp: new Date().toISOString(),
    ok: true,
    result
  })}\n`);
  return {
    child,
    stdout,
    requests,
    responseFrame,
    respond: (requestId, result) => stdout.write(responseFrame(requestId, result))
  };
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

function pairingProposalReview() {
  return {
    id: 'pair-1',
    invitationId: 'invite-1',
    deviceId: 'phone-1',
    deviceName: 'Phone',
    platform: 'Android',
    peer: 'phone.tailnet.ts.net',
    peerIp: '100.64.0.10',
    requestedAt: '2026-08-01T00:00:00Z',
    expiresAt: '2026-08-01T01:00:00Z',
    reviewedAt: null,
    status: 'awaiting-review',
    publicationRef: null,
    proposal: {
      schemaVersion: 1,
      id: 'phone-1',
      name: 'Phone',
      roles: ['client'],
      platform: 'Android',
      linuxUsername: '',
      tailscaleNode: 'phone.tailnet.ts.net',
      projectsRoot: '',
      transport: 'tailscale',
      wslDistro: '',
      fallback: { sshHost: '', ip: '' },
      hostCommand: ''
    }
  };
}
