import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ data: (_text: string) => {}, exit: (_event: {exitCode: number}) => {}, kill: vi.fn(), save: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: () => ({ kill: fixture.kill,
  onData: (callback: typeof fixture.data) => { fixture.data = callback; },
  onExit: (callback: typeof fixture.exit) => { fixture.exit = callback; } }) }));
vi.mock('node:child_process', () => ({ spawnSync: () => ({ status: 0, stdout: 'Ubuntu' }) }));
vi.mock('node:fs', () => ({ writeFileSync: fixture.save }));
vi.mock('../src/main/fleet-terminal', () => ({ resolveWslExecutable: () => 'wsl.exe' }));
import { runPackagedTerminalSmoke } from '../src/main/terminal-smoke';
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it('accepts final pipe data after exit without killing an exited ConPTY', async () => {
  vi.useFakeTimers();
  const result = runPackagedTerminalSmoke('receipt.json');
  fixture.exit({exitCode:0}); fixture.data('AGENT_FLEET_CONPTY_OK');
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBe(true);
  expect(fixture.kill).not.toHaveBeenCalled();
  expect(JSON.parse(fixture.save.mock.calls[0][1]).status).toBe('ok');
});
it('kills a timed-out ConPTY once', async () => {
  vi.useFakeTimers();
  const result = runPackagedTerminalSmoke('receipt.json');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await result).toBe(false);
  expect(fixture.kill).toHaveBeenCalledOnce();
});
