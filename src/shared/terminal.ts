import type { FleetTool } from './fleet';

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

export interface TerminalStatusEvent {
  tab: TerminalTabDescriptor;
}

export interface TerminalClosedEvent {
  tabId: string;
}

export interface TerminalWorkspaceState {
  version: 1;
  selectedTabId: string;
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
