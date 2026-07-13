import type { FleetTool } from './fleet';

export type TerminalConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'ended';
export type SessionViewMode = 'native' | 'terminal';

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
