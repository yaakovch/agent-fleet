import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as nodePty from 'node-pty';
import type { Logger } from 'electron-log';
import { sessionIdentityPresentation, type FleetSession } from '../shared/fleet';
import type {
  SessionViewMode,
  TerminalFailure,
  TerminalFailureCode,
  TerminalHealth,
  TerminalClosedEvent,
  TerminalDataEvent,
  TerminalStatusEvent,
  TerminalTabDescriptor,
  TerminalWorkspaceState,
  TerminalWorkspaceStateV1
} from '../shared/terminal';
import {
  applyWorkspacePreset,
  assignWorkspaceSession,
  clearWorkspacePane,
  closeWorkspacePane,
  defaultRailState,
  emptyWorkspaceLayout,
  focusWorkspacePane,
  focusedPane,
  normalizeRailState,
  normalizeWorkspaceLayout,
  paneForSession,
  resizeWorkspaceSplit,
  setWorkspacePaneView,
  splitWorkspacePane,
  swapWorkspacePanes,
  workspacePanes,
  type WorkspaceCommand,
  type WorkspaceIds,
  type WorkspaceLayout,
  type WorkspaceOpenRequest,
  type WorkspaceRailState
} from '../shared/workspace-layout';
import { buildFleetWslAttachCommand, resolveWslExecutable, WindowsExecutableError } from './fleet-terminal';
import { wslProcessOwner, type WslProcessOwnership } from './wsl-process-ownership';
import {
  ConcurrentFileModificationError,
  durableAtomicWrite,
  quarantineFile,
  quarantinePath,
  quarantineUnreadablePath,
  readFileSnapshot,
  readOptionalFileSnapshot,
  readPathIdentity,
  withCrossProcessLock,
  type FileSnapshot,
  type PathIdentity
} from './durable-file';

const MAX_TABS = 4;
const MAX_INPUT_CHARS = 64 * 1024;
const MAX_OUTPUT_CHARS = 64 * 1024;
const MAX_PENDING_OUTPUT_CHARS = 1024 * 1024;
const MAX_WORKSPACE_STATE_BYTES = 2 * 1024 * 1024;
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
  legacyStatePath?: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  getDistro(): string;
  resolveSession(sessionId: string): FleetSession | undefined;
  isHostAvailable?(hostId: string): boolean;
  onData(event: TerminalDataEvent): void;
  onStatus(event: TerminalStatusEvent): void;
  onClosed(event: TerminalClosedEvent): void;
  onWorkspace?(state: TerminalWorkspaceState): void;
  spawnPty?: (command: string, args: string[], options: nodePty.IPtyForkOptions) => PtyProcess;
  resolveWslExecutable?: () => string;
  processOwnership?: WslProcessOwnership;
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
  bound: boolean;
  pendingOutput: string;
  pendingOutputOverflowed: boolean;
}

export class TerminalManager {
  private readonly tabs = new Map<string, ManagedTab>();
  private readonly ids: WorkspaceIds = {
    pane: () => `pane-${randomUUID()}`,
    split: () => `split-${randomUUID()}`
  };
  private layout: WorkspaceLayout = emptyWorkspaceLayout(this.ids);
  private rail: WorkspaceRailState = defaultRailState();
  private workspaceBroadcastSignature = '';
  private quitting = false;

  constructor(private readonly options: TerminalManagerOptions) {}

  restore(): TerminalTabDescriptor[] {
    const state = readWorkspaceState(this.options.statePath, this.options.legacyStatePath, this.ids);
    this.layout = state.layout;
    this.rail = state.rail;
    const assigned = new Set(workspacePanes(this.layout).map((pane) => pane.sessionId).filter((id): id is string => Boolean(id)));
    for (const descriptor of state.tabs.filter((tab) => assigned.has(tab.sessionId)).slice(0, MAX_TABS)) {
      const session = this.options.resolveSession(descriptor.sessionId);
      const hostAvailable = session ? this.hostAvailable(session.hostId) : this.hostAvailable(descriptor.hostId);
      const tab = this.createManagedTab({
        ...descriptor,
        ...(session?.internalName && hostAvailable ? {
          hostId: session.hostId,
          project: session.project,
          internalName: session.internalName,
          label: sessionIdentityPresentation(session).primary,
          tool: session.tool,
          backend: session.backend === 'windows' ? 'windows' as const : 'linux' as const,
          viewMode: viewModeForTool(session.tool, descriptor.viewMode),
          status: 'connecting' as const,
          statusMessage: 'Restoring session…'
        } : session?.internalName
          ? { status: 'offline' as const, statusMessage: 'Host unavailable · waiting to reconnect' }
          : hostAvailable
            ? { status: 'ended' as const, statusMessage: 'Session ended' }
            : { status: 'offline' as const, statusMessage: 'Host unavailable · waiting to reconnect' })
      });
      this.tabs.set(tab.descriptor.id, tab);
      if (session?.internalName && hostAvailable) this.start(tab);
    }
    for (const pane of workspacePanes(this.layout)) {
      if (pane.sessionId && ![...this.tabs.values()].some((tab) => tab.descriptor.sessionId === pane.sessionId)) {
        this.layout = clearWorkspacePane(this.layout, pane.id);
      }
    }
    this.persist();
    return this.list();
  }

  reconcileSessions(): number {
    let reconnected = 0;
    for (const tab of this.tabs.values()) {
      if (tab.closed) continue;
      const session = this.options.resolveSession(tab.descriptor.sessionId);
      if (session) {
        const label = sessionIdentityPresentation(session).primary;
        if (tab.descriptor.label !== label) {
          tab.descriptor.label = label;
          this.emitStatus(tab);
        }
      }
      const hostId = session?.hostId ?? tab.descriptor.hostId;
      if (!this.hostAvailable(hostId)) {
        this.stopProcess(tab);
        if (tab.reconnectTimer) clearTimeout(tab.reconnectTimer);
        tab.reconnectTimer = null;
        if (tab.descriptor.status !== 'offline' || tab.descriptor.statusMessage !== 'Host unavailable · waiting to reconnect') {
          tab.descriptor.status = 'offline';
          tab.descriptor.statusMessage = 'Host unavailable · waiting to reconnect';
          delete tab.descriptor.failure;
          this.emitStatus(tab);
        }
        continue;
      }
      if (!session?.internalName) {
        this.stopProcess(tab);
        if (tab.reconnectTimer) clearTimeout(tab.reconnectTimer);
        tab.reconnectTimer = null;
        if (tab.descriptor.status !== 'ended' || tab.descriptor.statusMessage !== 'Session ended') {
          tab.descriptor.status = 'ended';
          tab.descriptor.statusMessage = 'Session ended';
          delete tab.descriptor.failure;
          this.emitStatus(tab);
        }
        continue;
      }
      if (tab.process || !['ended', 'offline', 'reconnecting'].includes(tab.descriptor.status)) continue;
      tab.descriptor = {
        ...tab.descriptor,
        hostId: session.hostId,
        project: session.project,
        internalName: session.internalName,
        label: sessionIdentityPresentation(session).primary,
        tool: session.tool,
        backend: session.backend === 'windows' ? 'windows' : 'linux',
        viewMode: viewModeForTool(session.tool, tab.descriptor.viewMode),
        status: 'connecting',
        statusMessage: 'Session found · connecting…'
      };
      const pane = paneForSession(this.layout, tab.descriptor.sessionId);
      if (pane) this.layout = setWorkspacePaneView(this.layout, pane.id, tab.descriptor.viewMode);
      reconnected += 1;
      this.start(tab);
    }
    if (reconnected) this.persist();
    return reconnected;
  }

  open(session: FleetSession, request: WorkspaceOpenRequest = {}): TerminalTabDescriptor {
    if (!session.internalName) throw new Error('Session has no internal tmux identity');
    const existing = [...this.tabs.values()].find((tab) => tab.descriptor.sessionId === session.id && !tab.closed);
    if (existing) {
      const pane = paneForSession(this.layout, session.id);
      const viewMode = viewModeForTool(session.tool, existing.descriptor.viewMode);
      existing.descriptor.viewMode = viewMode;
      if (pane) {
        this.layout = focusWorkspacePane(this.layout, pane.id);
        this.layout = setWorkspacePaneView(this.layout, pane.id, viewMode);
      }
      if (!existing.process && existing.descriptor.status !== 'connecting') this.retry(existing.descriptor.id);
      this.persist();
      return { ...existing.descriptor };
    }
    let targetPane = workspacePanes(this.layout).find((pane) => pane.id === request.paneId) ?? focusedPane(this.layout);
    const placement = request.placement ?? 'replace';
    if (placement !== 'replace') {
      const before = workspacePanes(this.layout).length;
      this.layout = splitWorkspacePane(this.layout, targetPane.id, placement === 'split-right' ? 'row' : 'column', this.ids);
      if (workspacePanes(this.layout).length === before) throw new Error('Up to four sessions can be visible at once');
      targetPane = focusedPane(this.layout);
    }
    if (targetPane.sessionId) this.detachSession(targetPane.sessionId);
    const descriptor: TerminalTabDescriptor = {
      id: randomUUID(),
      sessionId: session.id,
      hostId: session.hostId,
      project: session.project,
      internalName: session.internalName,
      label: sessionIdentityPresentation(session).primary,
      tool: session.tool,
      backend: session.backend === 'windows' ? 'windows' : 'linux',
      viewMode: viewModeForTool(session.tool, 'native'),
      status: 'connecting',
      statusMessage: 'Connecting…'
    };
    const tab = this.createManagedTab(descriptor);
    this.tabs.set(descriptor.id, tab);
    this.layout = assignWorkspaceSession(this.layout, targetPane.id, session.id);
    this.layout = setWorkspacePaneView(this.layout, targetPane.id, descriptor.viewMode);
    this.persist();
    this.start(tab);
    return { ...descriptor };
  }

  list(): TerminalTabDescriptor[] {
    return [...this.tabs.values()].filter((tab) => !tab.closed).map((tab) => ({ ...tab.descriptor }));
  }

  getSelectedTabId(): string {
    const sessionId = focusedPane(this.layout).sessionId;
    return this.list().find((tab) => tab.sessionId === sessionId)?.id ?? '';
  }

  getWorkspaceState(): TerminalWorkspaceState {
    return { version: 2, layout: structuredClone(this.layout), rail: structuredClone(this.rail), tabs: this.list() };
  }

  bind(tabId: string): TerminalTabDescriptor | null {
    this.syncBindings(tabId ? [tabId] : []);
    const tab = this.tabs.get(tabId);
    return tab && !tab.closed ? { ...tab.descriptor } : null;
  }

  syncBindings(tabIds: string[]): TerminalTabDescriptor[] {
    const desired = new Set(tabIds.filter((id, index, values) => values.indexOf(id) === index).slice(0, 4));
    for (const tab of this.tabs.values()) {
      const nextBound = desired.has(tab.descriptor.id);
      const becameBound = nextBound && !tab.bound;
      tab.bound = nextBound;
      if (!becameBound) continue;
      if (tab.pendingOutputOverflowed) {
        tab.pendingOutput = '';
        tab.pendingOutputOverflowed = false;
        this.stopProcess(tab);
        tab.reconnectIndex = 0;
        tab.descriptor.status = 'connecting';
        tab.descriptor.statusMessage = 'Refreshing terminal screen…';
        delete tab.descriptor.failure;
        this.emitStatus(tab);
        this.start(tab);
      } else if (tab.pendingOutput) {
        const data = tab.pendingOutput;
        tab.pendingOutput = '';
        this.emitData(tab, data);
      }
    }
    return this.list().filter((tab) => desired.has(tab.id));
  }

  unbindAll(): void {
    for (const tab of this.tabs.values()) tab.bound = false;
  }

  getHealth(): TerminalHealth {
    const tabs = [...this.tabs.values()].filter((tab) => !tab.closed);
    const failureCodes = [...new Set(tabs.map((tab) => tab.descriptor.failure?.code).filter((code): code is TerminalFailureCode => Boolean(code)))];
    return {
      wslAvailable: !failureCodes.includes('wsl_not_found'),
      conptyState: failureCodes.includes('conpty_unavailable') ? 'unavailable' : tabs.some((tab) => tab.process) ? 'ready' : 'unknown',
      activePtys: tabs.filter((tab) => Boolean(tab.process)).length,
      reconnectingPtys: tabs.filter((tab) => tab.descriptor.status === 'reconnecting' || tab.descriptor.status === 'offline').length,
      unavailablePtys: tabs.filter((tab) => tab.descriptor.status === 'unavailable').length,
      failureCodes
    };
  }

  select(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    const pane = tab ? paneForSession(this.layout, tab.descriptor.sessionId) : undefined;
    if (!pane) return false;
    this.layout = focusWorkspacePane(this.layout, pane.id);
    this.persist();
    return true;
  }

  setViewMode(tabId: string, viewMode: SessionViewMode): TerminalTabDescriptor | null {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.closed) return null;
    const normalized = viewModeForTool(tab.descriptor.tool, viewMode);
    tab.descriptor.viewMode = normalized;
    const pane = paneForSession(this.layout, tab.descriptor.sessionId);
    if (pane) this.layout = setWorkspacePaneView(this.layout, pane.id, normalized);
    this.persist();
    this.emitStatus(tab);
    return { ...tab.descriptor };
  }

  applyWorkspaceCommand(command: WorkspaceCommand): TerminalWorkspaceState {
    if (command.type === 'focus') this.layout = focusWorkspacePane(this.layout, command.paneId);
    else if (command.type === 'split') this.layout = splitWorkspacePane(this.layout, command.paneId, command.direction, this.ids);
    else if (command.type === 'close') this.closePane(command.paneId);
    else if (command.type === 'clear') {
      const pane = workspacePanes(this.layout).find((item) => item.id === command.paneId);
      if (pane?.sessionId) this.detachSession(pane.sessionId);
      this.layout = clearWorkspacePane(this.layout, command.paneId);
    }
    else if (command.type === 'resize') this.layout = resizeWorkspaceSplit(this.layout, command.splitId, command.ratio);
    else if (command.type === 'swap') this.layout = swapWorkspacePanes(this.layout, command.firstPaneId, command.secondPaneId);
    else if (command.type === 'view') {
      const pane = workspacePanes(this.layout).find((item) => item.id === command.paneId);
      const tab = pane?.sessionId ? this.tabForSession(pane.sessionId) : undefined;
      if (pane && tab) {
        const normalized = viewModeForTool(tab.descriptor.tool, command.viewMode);
        tab.descriptor.viewMode = normalized;
        this.layout = setWorkspacePaneView(this.layout, pane.id, normalized);
        this.emitStatus(tab);
      }
    } else if (command.type === 'preset') {
      const before = new Set(workspacePanes(this.layout).map((pane) => pane.sessionId).filter((id): id is string => Boolean(id)));
      this.layout = applyWorkspacePreset(this.layout, command.preset, this.ids);
      const after = new Set(workspacePanes(this.layout).map((pane) => pane.sessionId).filter((id): id is string => Boolean(id)));
      for (const sessionId of before) if (!after.has(sessionId)) this.detachSession(sessionId);
    } else if (command.type === 'rail') this.rail = normalizeRailState(command.rail);
    this.persist();
    return this.getWorkspaceState();
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
    delete tab.descriptor.failure;
    this.emitStatus(tab);
    this.start(tab);
    return { ...tab.descriptor };
  }

  close(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const pane = paneForSession(this.layout, tab.descriptor.sessionId);
    if (pane) this.layout = closeWorkspacePane(this.layout, pane.id);
    this.closeManagedTab(tab);
    this.persist();
    return true;
  }

  closePane(paneId: string): boolean {
    const pane = workspacePanes(this.layout).find((item) => item.id === paneId);
    if (!pane) return false;
    if (pane.sessionId) this.detachSession(pane.sessionId);
    this.layout = closeWorkspacePane(this.layout, paneId);
    this.persist();
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
      generation: 0, closed: false, columns: 120, rows: 36,
      bound: false, pendingOutput: '', pendingOutputOverflowed: false
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
    if (!this.hostAvailable(session.hostId)) {
      tab.descriptor.status = 'offline';
      tab.descriptor.statusMessage = 'Host unavailable · waiting to reconnect';
      delete tab.descriptor.failure;
      this.emitStatus(tab);
      return;
    }
    tab.descriptor = {
      ...tab.descriptor,
      hostId: session.hostId,
      project: session.project,
      internalName: session.internalName,
      label: sessionIdentityPresentation(session).primary,
      tool: session.tool,
      backend: session.backend === 'windows' ? 'windows' : 'linux',
      viewMode: viewModeForTool(session.tool, tab.descriptor.viewMode),
      status: tab.reconnectIndex ? 'reconnecting' : 'connecting',
      statusMessage: tab.reconnectIndex ? 'Reconnecting…' : 'Connecting…',
      failure: undefined
    };
    const pane = paneForSession(this.layout, tab.descriptor.sessionId);
    if (pane) this.layout = setWorkspacePaneView(this.layout, pane.id, tab.descriptor.viewMode);
    this.emitStatus(tab);
    const launch = buildFleetWslAttachCommand({
      id: session.id,
      hostId: session.hostId,
      project: session.project,
      sessionName: session.internalName,
      label: sessionIdentityPresentation(session).primary
    }, this.options.getDistro());
    const generation = ++tab.generation;
    let spawnedProcess: PtyProcess | null = null;
    try {
      const executable = this.options.resolveWslExecutable?.() ?? resolveWslExecutable();
      const spawn = this.options.spawnPty ?? ((command, args, options) => nodePty.spawn(command, args, options));
      const process = spawn(executable, launch.args, {
        name: 'xterm-256color',
        cols: tab.columns,
        rows: tab.rows,
        cwd: processCwd(),
        env: terminalEnvironment()
      });
      spawnedProcess = process;
      try {
        this.options.processOwnership?.own(wslProcessOwner('terminal', tab.descriptor.id), process);
      } catch (error) {
        try { process.kill(); } catch { /* the failed registration still owns cleanup */ }
        spawnedProcess = null;
        throw error;
      }
      tab.process = process;
      tab.reconnectIndex = 0;
      tab.descriptor.status = 'live';
      tab.descriptor.statusMessage = 'Live';
      process.onData((data) => {
        if (tab.closed || generation !== tab.generation) return;
        if (tab.bound) this.emitData(tab, data);
        else this.bufferData(tab, data);
      });
      process.onExit(({ exitCode }) => {
        this.options.processOwnership?.forget(process);
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
      if (spawnedProcess && tab.process === spawnedProcess) {
        tab.process = null;
        tab.generation += 1;
        if (!this.options.processOwnership?.release(spawnedProcess, 'protocol_failure')) {
          try { spawnedProcess.kill(); } catch { /* process already exited */ }
        }
      }
      const failure = terminalFailure(error);
      tab.descriptor.status = 'unavailable';
      tab.descriptor.statusMessage = failure.message;
      tab.descriptor.failure = failure;
      this.options.logger.warn('Embedded terminal unavailable', failure.code);
      this.emitStatus(tab);
      this.persist();
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
    tab.generation += 1;
    const cause = tab.closed ? 'tmux_kill' : this.quitting ? 'app_shutdown' : 'host_restart';
    if (!this.options.processOwnership?.release(process, cause)) {
      try { process.kill(); } catch { /* already exited */ }
    }
  }

  private bufferData(tab: ManagedTab, data: string): void {
    if (tab.pendingOutputOverflowed) return;
    if (tab.pendingOutput.length + data.length > MAX_PENDING_OUTPUT_CHARS) {
      tab.pendingOutput = '';
      tab.pendingOutputOverflowed = true;
      return;
    }
    tab.pendingOutput += data;
  }

  private emitData(tab: ManagedTab, data: string): void {
    for (let offset = 0; offset < data.length; offset += MAX_OUTPUT_CHARS) {
      this.options.onData({ tabId: tab.descriptor.id, data: data.slice(offset, offset + MAX_OUTPUT_CHARS) });
    }
  }

  private emitStatus(tab: ManagedTab): void {
    this.options.onStatus({ tab: { ...tab.descriptor } });
  }

  private persist(): void {
    const state: TerminalWorkspaceState = {
      version: 2,
      layout: this.layout,
      rail: this.rail,
      tabs: this.list().map((tab) => persistedDescriptor(tab))
    };
    writeWorkspaceState(this.options.statePath, state);
    const signature = JSON.stringify({
      layout: this.layout,
      rail: this.rail,
      tabs: state.tabs.map((tab) => ({ id: tab.id, sessionId: tab.sessionId, viewMode: tab.viewMode }))
    });
    if (signature !== this.workspaceBroadcastSignature) {
      this.workspaceBroadcastSignature = signature;
      this.options.onWorkspace?.(this.getWorkspaceState());
    }
  }

  private tabForSession(sessionId: string): ManagedTab | undefined {
    return [...this.tabs.values()].find((tab) => tab.descriptor.sessionId === sessionId && !tab.closed);
  }

  private detachSession(sessionId: string): void {
    const tab = this.tabForSession(sessionId);
    if (tab) this.closeManagedTab(tab);
  }

  private closeManagedTab(tab: ManagedTab): void {
    const tabId = tab.descriptor.id;
    tab.closed = true;
    tab.generation += 1;
    if (tab.reconnectTimer) clearTimeout(tab.reconnectTimer);
    this.stopProcess(tab);
    this.tabs.delete(tabId);
    this.options.onClosed({ tabId });
  }

  private hostAvailable(hostId: string): boolean {
    return this.options.isHostAvailable?.(hostId) ?? true;
  }
}

function terminalFailure(error: unknown): TerminalFailure {
  if (error instanceof WindowsExecutableError) return { code: error.code, message: error.message, retryable: false };
  const message = error instanceof Error ? error.message : String(error);
  if (/conpty|native module|\.node|dll/i.test(message)) {
    return { code: 'conpty_unavailable', message: 'The embedded Windows terminal is unavailable.', retryable: false };
  }
  if (/file not found|enoent|cannot find/i.test(message)) {
    return { code: 'wsl_not_found', message: 'Windows Subsystem for Linux could not be started.', retryable: false };
  }
  return { code: 'terminal_spawn_failed', message: 'The embedded terminal could not be started.', retryable: false };
}

function persistedDescriptor(tab: TerminalTabDescriptor): TerminalTabDescriptor {
  const { failure: _failure, ...descriptor } = tab;
  return { ...descriptor, status: 'connecting', statusMessage: 'Restoring session…' };
}

export function readWorkspaceState(
  path: string,
  legacyPath?: string,
  ids: WorkspaceIds = { pane: () => `pane-${randomUUID()}`, split: () => `split-${randomUUID()}` },
  now = new Date()
): TerminalWorkspaceState {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = existsSync(path) ? path : legacyPath && existsSync(legacyPath) ? legacyPath : '';
    if (!candidate) return emptyWorkspaceState(ids);
    let snapshot: FileSnapshot;
    try {
      snapshot = readFileSnapshot(candidate, MAX_WORKSPACE_STATE_BYTES);
    } catch (error) {
      if (error instanceof ConcurrentFileModificationError) continue;
      const observed = observedWorkspacePathIdentity(candidate);
      if (!observed) continue;
      const quarantined = withCrossProcessLock(candidate, () =>
        quarantineUnreadablePath(
          candidate,
          observed,
          MAX_WORKSPACE_STATE_BYTES,
          'corrupt-workspace',
          now
        ));
      if (!quarantined) continue;
      return emptyWorkspaceState(ids);
    }
    try {
      return parseWorkspaceSnapshot(snapshot, ids);
    } catch {
      const quarantined = withCrossProcessLock(candidate, () =>
        quarantineFile(candidate, snapshot, 'corrupt-workspace', now));
      if (!quarantined) continue;
      return emptyWorkspaceState(ids);
    }
  }
  throw new ConcurrentFileModificationError(path);
}

function parseWorkspaceSnapshot(snapshot: FileSnapshot, ids: WorkspaceIds): TerminalWorkspaceState {
  const raw = JSON.parse(snapshot.data.toString('utf8')) as unknown;
  if (!raw || typeof raw !== 'object') throw new Error('state is not an object');
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.tabs)) throw new Error('workspace tabs are invalid');
  const parsedTabs = value.tabs.map(parseDescriptor);
  if (parsedTabs.some((tab) => !tab)) throw new Error('workspace contains an invalid tab');
  const tabs = parsedTabs as TerminalTabDescriptor[];
  if (value.version === 2) {
    assertExactFields(value, ['version', 'layout', 'rail', 'tabs'], 'workspace state');
    assertValidWorkspaceLayout(value.layout);
    assertValidRailState(value.rail);
    let layout = normalizeWorkspaceLayout(value.layout, ids);
    for (const pane of workspacePanes(layout)) {
      const tab = tabs.find((item) => item.sessionId === pane.sessionId);
      if (tab) layout = setWorkspacePaneView(layout, pane.id, viewModeForTool(tab.tool, pane.viewMode));
    }
    const assigned = new Set(workspacePanes(layout).map((pane) => pane.sessionId).filter((id): id is string => Boolean(id)));
    return {
      version: 2,
      layout,
      rail: normalizeRailState(value.rail),
      tabs: tabs.filter((tab) => assigned.has(tab.sessionId)).slice(0, MAX_TABS)
    };
  }
  if (value.version !== 1) throw new Error('workspace version is unsupported');
  const selectedTabId = typeof value.selectedTabId === 'string' && tabs.some((tab) => tab.id === value.selectedTabId)
    ? value.selectedTabId : tabs.at(-1)?.id ?? '';
  const legacy: TerminalWorkspaceStateV1 = { version: 1, selectedTabId, tabs };
  const selected = legacy.tabs.find((tab) => tab.id === legacy.selectedTabId);
  let layout = emptyWorkspaceLayout(ids);
  if (selected) {
    layout = assignWorkspaceSession(layout, layout.focusedPaneId, selected.sessionId);
    layout = setWorkspacePaneView(layout, layout.focusedPaneId, selected.viewMode);
  }
  return { version: 2, layout, rail: defaultRailState(), tabs: selected ? [selected] : [] };
}

function observedWorkspacePathIdentity(path: string): PathIdentity | null {
  try {
    return readPathIdentity(path);
  } catch {
    return null;
  }
}

function assertValidWorkspaceLayout(input: unknown): void {
  const fallbackId = '!invalid-workspace-layout';
  const parsed = normalizeWorkspaceLayout(input, { pane: () => fallbackId, split: () => fallbackId });
  if (parsed.root.id === fallbackId) throw new Error('workspace layout is invalid');
  const raw = input as Record<string, unknown>;
  if (typeof raw.focusedPaneId !== 'string'
    || !workspacePanes(parsed).some((pane) => pane.id === raw.focusedPaneId)
    || !Array.isArray(raw.sessionMru) || raw.sessionMru.length > 64
    || raw.sessionMru.some((item) => typeof item !== 'string' || !SAFE_ID.test(item))
    || new Set(raw.sessionMru).size !== raw.sessionMru.length) {
    throw new Error('workspace layout focus or history is invalid');
  }
}

function assertValidRailState(input: unknown): void {
  if (!input || typeof input !== 'object') throw new Error('workspace rail is invalid');
  const raw = input as Record<string, unknown>;
  assertExactFields(raw, [
    'width', 'collapsed', 'status', 'hostIds', 'tools', 'showIdle', 'hiddenUnavailableSessionIds'
  ], 'workspace rail');
  if (typeof raw.width !== 'number' || !Number.isFinite(raw.width)
    || raw.width < 180 || raw.width > 360 || typeof raw.collapsed !== 'boolean'
    || !['all', 'active', 'waiting', 'favorites'].includes(String(raw.status))
    || typeof raw.showIdle !== 'boolean'
    || !validUniqueIdArray(raw.hostIds, 32)
    || !validUniqueIdArray(raw.hiddenUnavailableSessionIds, 64)
    || !Array.isArray(raw.tools) || raw.tools.length > 4
    || raw.tools.some((tool) => !['shell', 'codex', 'claude', 'copilot'].includes(String(tool)))
    || new Set(raw.tools).size !== raw.tools.length) {
    throw new Error('workspace rail is invalid');
  }
}

function validUniqueIdArray(value: unknown, max: number): boolean {
  return Array.isArray(value) && value.length <= max
    && value.every((item) => typeof item === 'string' && SAFE_ID.test(item))
    && new Set(value).size === value.length;
}

function assertExactFields(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function emptyWorkspaceState(ids: WorkspaceIds): TerminalWorkspaceState {
  return { version: 2, layout: emptyWorkspaceLayout(ids), rail: defaultRailState(), tabs: [] };
}

function parseDescriptor(value: unknown): TerminalTabDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  try {
    assertExactFields(raw, [
      'id', 'sessionId', 'hostId', 'project', 'internalName', 'label',
      'tool', 'backend', 'viewMode', 'status', 'statusMessage'
    ], 'workspace tab');
  } catch {
    return null;
  }
  if (![raw.id, raw.sessionId, raw.hostId].every((item) => typeof item === 'string' && SAFE_ID.test(item))) return null;
  if (typeof raw.internalName !== 'string' || !SAFE_SESSION.test(raw.internalName)) return null;
  if (![raw.project, raw.label].every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(item))) return null;
  if (!['codex', 'claude', 'copilot', 'shell'].includes(String(raw.tool))) return null;
  if (raw.backend !== 'linux' && raw.backend !== 'windows') return null;
  if (raw.viewMode !== 'native' && raw.viewMode !== 'terminal') return null;
  if (typeof raw.status !== 'string' || typeof raw.statusMessage !== 'string') return null;
  return {
    id: raw.id as string,
    sessionId: raw.sessionId as string,
    hostId: raw.hostId as string,
    project: raw.project as string,
    internalName: raw.internalName,
    label: raw.label as string,
    tool: raw.tool as TerminalTabDescriptor['tool'],
    backend: raw.backend,
    viewMode: viewModeForTool(
      raw.tool as TerminalTabDescriptor['tool'],
      raw.viewMode === 'terminal' ? 'terminal' : 'native'
    ),
    status: 'connecting',
    statusMessage: 'Restoring session…'
  };
}

function viewModeForTool(tool: TerminalTabDescriptor['tool'], requested: SessionViewMode): SessionViewMode {
  return tool === 'shell' ? 'terminal' : requested;
}

function writeWorkspaceState(path: string, state: TerminalWorkspaceState): void {
  withCrossProcessLock(path, () => {
    let current: FileSnapshot | null;
    try {
      current = readOptionalFileSnapshot(path, MAX_WORKSPACE_STATE_BYTES);
    } catch {
      const quarantined = quarantinePath(path, 'corrupt-workspace');
      if (!quarantined) throw new ConcurrentFileModificationError(path);
      current = null;
    }
    if (current) {
      try {
        parseWorkspaceSnapshot(current, {
          pane: () => `validation-pane-${randomUUID()}`,
          split: () => `validation-split-${randomUUID()}`
        });
      } catch {
        const quarantined = quarantineFile(path, current, 'corrupt-workspace');
        if (!quarantined) throw new ConcurrentFileModificationError(path);
        current = null;
      }
    }
    durableAtomicWrite(path, `${JSON.stringify(state, null, 2)}\n`, {
      expected: current,
      checkExpected: true,
      mode: 0o600
    });
  });
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
