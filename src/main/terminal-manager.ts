import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as nodePty from 'node-pty';
import type { Logger } from 'electron-log';
import type { FleetSession } from '../shared/fleet';
import type {
  SessionViewMode,
  TerminalClosedEvent,
  TerminalDataEvent,
  TerminalStatusEvent,
  TerminalTabDescriptor,
  TerminalWorkspaceState
} from '../shared/terminal';
import { buildFleetWslAttachCommand } from './fleet-terminal';

const MAX_TABS = 32;
const MAX_INPUT_CHARS = 64 * 1024;
const MAX_OUTPUT_CHARS = 64 * 1024;
const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,320}$/u;
const SAFE_SESSION = /^[A-Za-z0-9._-]{1,128}$/u;

export interface PtyProcess {
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface TerminalManagerOptions {
  statePath: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  getDistro(): string;
  resolveSession(sessionId: string): FleetSession | undefined;
  onData(event: TerminalDataEvent): void;
  onStatus(event: TerminalStatusEvent): void;
  onClosed(event: TerminalClosedEvent): void;
  spawnPty?: (command: string, args: string[], options: nodePty.IPtyForkOptions) => PtyProcess;
}

interface ManagedTab {
  descriptor: TerminalTabDescriptor;
  process: PtyProcess | null;
  reconnectIndex: number;
  reconnectTimer: NodeJS.Timeout | null;
  generation: number;
  closed: boolean;
  columns: number;
  rows: number;
}

export class TerminalManager {
  private readonly tabs = new Map<string, ManagedTab>();
  private selectedTabId = '';
  private quitting = false;

  constructor(private readonly options: TerminalManagerOptions) {}

  restore(): TerminalTabDescriptor[] {
    const state = readWorkspaceState(this.options.statePath);
    this.selectedTabId = state.selectedTabId;
    for (const descriptor of state.tabs.slice(0, MAX_TABS)) {
      const session = this.options.resolveSession(descriptor.sessionId);
      if (!session?.internalName) continue;
      const tab = this.createManagedTab({
        ...descriptor,
        hostId: session.hostId,
        project: session.project,
        internalName: session.internalName,
        label: session.name,
        tool: session.tool,
        backend: session.backend === 'windows' ? 'windows' : 'linux',
        status: 'connecting',
        statusMessage: 'Restoring session…'
      });
      this.tabs.set(tab.descriptor.id, tab);
      this.start(tab);
    }
    this.persist();
    return this.list();
  }

  open(session: FleetSession): TerminalTabDescriptor {
    if (!session.internalName) throw new Error('Session has no internal tmux identity');
    const existing = [...this.tabs.values()].find((tab) => tab.descriptor.sessionId === session.id && !tab.closed);
    if (existing) {
      this.selectedTabId = existing.descriptor.id;
      if (!existing.process && existing.descriptor.status !== 'connecting') this.retry(existing.descriptor.id);
      this.persist();
      return { ...existing.descriptor };
    }
    if (this.tabs.size >= MAX_TABS) throw new Error(`Close a session tab before opening more than ${MAX_TABS}`);
    const descriptor: TerminalTabDescriptor = {
      id: randomUUID(),
      sessionId: session.id,
      hostId: session.hostId,
      project: session.project,
      internalName: session.internalName,
      label: session.name,
      tool: session.tool,
      backend: session.backend === 'windows' ? 'windows' : 'linux',
      viewMode: 'native',
      status: 'connecting',
      statusMessage: 'Connecting…'
    };
    const tab = this.createManagedTab(descriptor);
    this.tabs.set(descriptor.id, tab);
    this.selectedTabId = descriptor.id;
    this.persist();
    this.start(tab);
    return { ...descriptor };
  }

  list(): TerminalTabDescriptor[] {
    return [...this.tabs.values()].filter((tab) => !tab.closed).map((tab) => ({ ...tab.descriptor }));
  }

  getSelectedTabId(): string {
    return this.selectedTabId;
  }

  select(tabId: string): boolean {
    if (!this.tabs.has(tabId)) return false;
    this.selectedTabId = tabId;
    this.persist();
    return true;
  }

  setViewMode(tabId: string, viewMode: SessionViewMode): TerminalTabDescriptor | null {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.closed) return null;
    tab.descriptor.viewMode = viewMode;
    this.selectedTabId = tabId;
    this.persist();
    this.emitStatus(tab);
    return { ...tab.descriptor };
  }

  input(tabId: string, data: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab?.process || typeof data !== 'string' || !data || data.length > MAX_INPUT_CHARS) return false;
    tab.process.write(data);
    return true;
  }

  resize(tabId: string, columns: number, rows: number): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab || !Number.isInteger(columns) || !Number.isInteger(rows)
      || columns < 2 || columns > 500 || rows < 2 || rows > 300) return false;
    tab.columns = columns;
    tab.rows = rows;
    tab.process?.resize(columns, rows);
    return true;
  }

  retry(tabId: string): TerminalTabDescriptor | null {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.closed) return null;
    this.stopProcess(tab);
    if (tab.reconnectTimer) clearTimeout(tab.reconnectTimer);
    tab.reconnectTimer = null;
    tab.reconnectIndex = 0;
    tab.descriptor.status = 'connecting';
    tab.descriptor.statusMessage = 'Connecting…';
    this.emitStatus(tab);
    this.start(tab);
    return { ...tab.descriptor };
  }

  close(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    tab.closed = true;
    tab.generation += 1;
    if (tab.reconnectTimer) clearTimeout(tab.reconnectTimer);
    this.stopProcess(tab);
    this.tabs.delete(tabId);
    if (this.selectedTabId === tabId) this.selectedTabId = this.list().at(-1)?.id ?? '';
    this.persist();
    this.options.onClosed({ tabId });
    return true;
  }

  dispose(): void {
    this.quitting = true;
    this.persist();
    for (const tab of this.tabs.values()) {
      tab.generation += 1;
      if (tab.reconnectTimer) clearTimeout(tab.reconnectTimer);
      this.stopProcess(tab);
    }
  }

  private createManagedTab(descriptor: TerminalTabDescriptor): ManagedTab {
    return {
      descriptor: { ...descriptor }, process: null, reconnectIndex: 0, reconnectTimer: null,
      generation: 0, closed: false, columns: 120, rows: 36
    };
  }

  private start(tab: ManagedTab): void {
    if (this.quitting || tab.closed || tab.process) return;
    const session = this.options.resolveSession(tab.descriptor.sessionId);
    if (!session?.internalName) {
      tab.descriptor.status = 'ended';
      tab.descriptor.statusMessage = 'Session ended';
      this.emitStatus(tab);
      return;
    }
    tab.descriptor = {
      ...tab.descriptor,
      hostId: session.hostId,
      project: session.project,
      internalName: session.internalName,
      label: session.name,
      tool: session.tool,
      backend: session.backend === 'windows' ? 'windows' : 'linux',
      status: tab.reconnectIndex ? 'reconnecting' : 'connecting',
      statusMessage: tab.reconnectIndex ? 'Reconnecting…' : 'Connecting…'
    };
    this.emitStatus(tab);
    const launch = buildFleetWslAttachCommand({
      id: session.id,
      hostId: session.hostId,
      project: session.project,
      sessionName: session.internalName,
      label: session.name
    }, this.options.getDistro());
    const generation = ++tab.generation;
    try {
      const spawn = this.options.spawnPty ?? ((command, args, options) => nodePty.spawn(command, args, options));
      const process = spawn(launch.command, launch.args, {
        name: 'xterm-256color',
        cols: tab.columns,
        rows: tab.rows,
        cwd: processCwd(),
        env: terminalEnvironment()
      });
      tab.process = process;
      tab.reconnectIndex = 0;
      tab.descriptor.status = 'live';
      tab.descriptor.statusMessage = 'Live';
      process.onData((data) => {
        if (tab.closed || generation !== tab.generation) return;
        for (let offset = 0; offset < data.length; offset += MAX_OUTPUT_CHARS) {
          this.options.onData({ tabId: tab.descriptor.id, data: data.slice(offset, offset + MAX_OUTPUT_CHARS) });
        }
      });
      process.onExit(({ exitCode }) => {
        if (generation !== tab.generation || tab.closed || this.quitting) return;
        tab.process = null;
        const stillExists = Boolean(this.options.resolveSession(tab.descriptor.sessionId)?.internalName);
        if (!stillExists || exitCode === 0) {
          tab.descriptor.status = 'ended';
          tab.descriptor.statusMessage = stillExists ? 'Detached · Retry to reconnect' : 'Session ended';
          this.emitStatus(tab);
          return;
        }
        this.scheduleReconnect(tab);
      });
      this.emitStatus(tab);
      this.persist();
      this.options.logger.info('Embedded terminal connected', tab.descriptor.id, tab.descriptor.sessionId);
    } catch (error) {
      this.options.logger.warn('Embedded terminal spawn failed', error);
      this.scheduleReconnect(tab);
    }
  }

  private scheduleReconnect(tab: ManagedTab): void {
    if (tab.closed || this.quitting) return;
    const delay = RECONNECT_DELAYS[Math.min(tab.reconnectIndex, RECONNECT_DELAYS.length - 1)];
    tab.reconnectIndex = Math.min(tab.reconnectIndex + 1, RECONNECT_DELAYS.length - 1);
    tab.descriptor.status = 'offline';
    tab.descriptor.statusMessage = `Disconnected · retrying in ${Math.ceil(delay / 1_000)}s`;
    this.emitStatus(tab);
    tab.reconnectTimer = setTimeout(() => {
      tab.reconnectTimer = null;
      this.start(tab);
    }, delay);
    tab.reconnectTimer.unref();
  }

  private stopProcess(tab: ManagedTab): void {
    const process = tab.process;
    tab.process = null;
    if (!process) return;
    try { process.kill(); } catch { /* already exited */ }
  }

  private emitStatus(tab: ManagedTab): void {
    this.options.onStatus({ tab: { ...tab.descriptor } });
  }

  private persist(): void {
    const state: TerminalWorkspaceState = {
      version: 1,
      selectedTabId: this.selectedTabId,
      tabs: this.list().map((tab) => ({ ...tab, status: 'connecting', statusMessage: 'Restoring session…' }))
    };
    writeWorkspaceState(this.options.statePath, state);
  }
}

export function readWorkspaceState(path: string): TerminalWorkspaceState {
  if (!existsSync(path)) return { version: 1, selectedTabId: '', tabs: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') throw new Error('state is not an object');
    const value = raw as Record<string, unknown>;
    const tabs = Array.isArray(value.tabs) ? value.tabs.map(parseDescriptor).filter((tab): tab is TerminalTabDescriptor => Boolean(tab)) : [];
    const selectedTabId = typeof value.selectedTabId === 'string' && tabs.some((tab) => tab.id === value.selectedTabId)
      ? value.selectedTabId : tabs.at(-1)?.id ?? '';
    return { version: 1, selectedTabId, tabs: tabs.slice(0, MAX_TABS) };
  } catch {
    return { version: 1, selectedTabId: '', tabs: [] };
  }
}

function parseDescriptor(value: unknown): TerminalTabDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (![raw.id, raw.sessionId, raw.hostId].every((item) => typeof item === 'string' && SAFE_ID.test(item))) return null;
  if (typeof raw.internalName !== 'string' || !SAFE_SESSION.test(raw.internalName)) return null;
  if (![raw.project, raw.label].every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(item))) return null;
  if (!['codex', 'claude', 'copilot', 'shell'].includes(String(raw.tool))) return null;
  if (raw.backend !== 'linux' && raw.backend !== 'windows') return null;
  return {
    id: raw.id as string,
    sessionId: raw.sessionId as string,
    hostId: raw.hostId as string,
    project: raw.project as string,
    internalName: raw.internalName,
    label: raw.label as string,
    tool: raw.tool as TerminalTabDescriptor['tool'],
    backend: raw.backend,
    viewMode: raw.viewMode === 'terminal' ? 'terminal' : 'native',
    status: 'connecting',
    statusMessage: 'Restoring session…'
  };
}

function writeWorkspaceState(path: string, state: TerminalWorkspaceState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function terminalEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function processCwd(): string {
  return process.env.USERPROFILE || process.env.HOME || process.cwd();
}
