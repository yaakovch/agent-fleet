import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer/src/session-workspace', () => ({ SessionWorkspace: class {} }));
import { DashboardPrototype } from '../src/renderer/src/dashboard-view';
import { FLEET_FIXTURE } from '../src/renderer/src/fleet-fixtures';

afterEach(() => vi.unstubAllGlobals());

function launcher() {
  const host = FLEET_FIXTURE.physicalHosts.find((host) => host.executionTargetIds.includes('windows'))!;
  const view = Object.assign(Object.create(DashboardPrototype.prototype), {
    snapshot: structuredClone(FLEET_FIXTURE), scenario: 'live', launcherHostId: host.id,
    launcherBackend: 'windows', launcherLocation: 'project', launcherTool: 'codex',
    launcherSelectedPath: 'C:\\projects\\Example', launcherLabel: 'Example',
    launcherDirectory: { path: 'C:\\projects\\Example', parentPath: null, entries: [], shortcuts: [], truncated: false },
    launcherDirectoryLoading: false, launcherDirectoryError: '', launcherCreating: false,
    launcherCreationError: '', launcherCreationMayHaveCompleted: false, launcherDrawer: true,
    root: { querySelector: () => ({ value: 'Example' }) },
    workspace: { handleAction: () => false, confirmPlacement: () => true },
    render: vi.fn(), showToast: vi.fn(), rememberLauncherPath: vi.fn()
  });
  return view;
}
const control = { dataset: { placement: 'replace' }, closest: () => null } as unknown as HTMLElement;

describe('session launcher recovery', () => {
  it('keeps the chosen Windows folder and target when the host goes offline', () => {
    const view = launcher();
    view.snapshot.physicalHosts.find((host: { id: string }) => host.id === view.launcherHostId).status = 'offline';
    const html = view.renderLauncher();
    expect(view.launcherSelectedPath).toBe('C:\\projects\\Example');
    expect(view.launcherBackend).toBe('windows');
    expect(html).toContain('value="windows" selected');
    expect(html).toMatch(/data-action="dashboard-launch"[^>]*disabled/);
  });

  it('keeps the drawer and selections after a safe rejection and submits only once while busy', async () => {
    const view = launcher();
    let resolve!: (result: { ok: boolean; message: string }) => void;
    const create = vi.fn(() => new Promise<{ ok: boolean; message: string }>((done) => { resolve = done; }));
    vi.stubGlobal('window', { limitsWidget: { createFleetSession: create } });
    view.handleAction('dashboard-launch', control);
    view.handleAction('dashboard-launch', control);
    view.handleAction('launcher-close', control);
    expect(create).toHaveBeenCalledTimes(1);
    expect(view.launcherCreating).toBe(true);
    expect(view.launcherDrawer).toBe(true);
    expect(view.renderLauncher()).toContain('class="launcher-fields" disabled');
    resolve({ ok: false, message: 'Fleet changed' });
    await Promise.resolve();
    expect(view.launcherCreating).toBe(false);
    expect(view.launcherCreationError).toBe('Fleet changed');
    expect(view.launcherSelectedPath).toBe('C:\\projects\\Example');
    expect(view.launcherDrawer).toBe(true);
    expect(view.rememberLauncherPath).not.toHaveBeenCalled();
    expect(view.renderLauncher()).toContain('role="alert">Fleet changed');
  });

  it('blocks resubmission after an uncertain outcome and directs the user to Sessions', async () => {
    const view = launcher();
    const create = vi.fn().mockResolvedValue({ ok: false, message: 'Result unknown', creationMayHaveCompleted: true });
    vi.stubGlobal('window', { limitsWidget: { createFleetSession: create } });
    view.handleAction('dashboard-launch', control);
    await Promise.resolve();
    view.handleAction('dashboard-launch', control);
    expect(create).toHaveBeenCalledTimes(1);
    expect(view.renderLauncher()).toContain('Check Sessions before starting another session.');
    expect(view.renderLauncher()).toMatch(/data-action="dashboard-launch"[^>]*disabled/);
  });
});
