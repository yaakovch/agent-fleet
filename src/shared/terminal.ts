import type { FleetTool } from './fleet';
import type { WorkspaceLayout, WorkspaceRailState } from './workspace-layout';

export type TerminalConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'unavailable' | 'ended';
export type SessionViewMode = 'native' | 'terminal';
export type TerminalFailureCode = 'wsl_not_found' | 'conpty_unavailable' | 'terminal_spawn_failed';

export interface TerminalFailure {
  code: TerminalFailureCode;
  message: string;
  retryable: boolean;
}

export interface TerminalTabDescriptor {
  id: string;
  sessionId: string;
  hostId: string;
  project: string;
  internalName: string;
  label: string;
  tool: FleetTool;
  backend: 'linux' | 'windows';
  viewMode: SessionViewMode;
  status: TerminalConnectionStatus;
  statusMessage: string;
  failure?: TerminalFailure;
}

export interface TerminalOpenResult {
  ok: boolean;
  message: string;
  tab?: TerminalTabDescriptor;
}

export interface TerminalDataEvent {
  tabId: string;
  data: string;
}

export interface PaneScrollbackSnapshot {
  protocolVersion: 1;
  type: 'pane.scrollback';
  session: string;
  columns: number;
  rows: number;
  historyLines: number;
  capturedLines: number;
  truncated: boolean;
  revision: string;
  ansiBase64: string;
}

export interface TerminalStatusEvent {
  tab: TerminalTabDescriptor;
}

export interface TerminalClosedEvent {
  tabId: string;
}

export interface TerminalWorkspaceStateV1 {
  version: 1;
  selectedTabId: string;
  tabs: TerminalTabDescriptor[];
}

export interface TerminalWorkspaceState {
  version: 2;
  layout: WorkspaceLayout;
  rail: WorkspaceRailState;
  tabs: TerminalTabDescriptor[];
}

export interface TerminalHealth {
  wslAvailable: boolean;
  conptyState: 'unknown' | 'ready' | 'unavailable';
  activePtys: number;
  reconnectingPtys: number;
  unavailablePtys: number;
  failureCodes: TerminalFailureCode[];
}
