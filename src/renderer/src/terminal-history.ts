import type { PaneScrollbackSnapshot, TerminalTabDescriptor } from '../../shared/terminal';

export const TERMINAL_HISTORY_QUIET_MS = 900;

export type TerminalHistoryStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface TerminalHistoryState {
  snapshot: PaneScrollbackSnapshot | null;
  status: TerminalHistoryStatus;
  active: boolean;
  error: string;
  updated: boolean;
  generation: number;
}

export function createTerminalHistoryState(): TerminalHistoryState {
  return { snapshot: null, status: 'idle', active: false, error: '', updated: false, generation: 0 };
}

export function terminalHistoryEligible(tab: TerminalTabDescriptor | undefined): boolean {
  return Boolean(tab && !tab.failure && ['codex', 'claude', 'copilot'].includes(tab.tool));
}

export function shouldCaptureTerminalHistoryScroll(
  tab: TerminalTabDescriptor | undefined,
  bufferType: 'normal' | 'alternate',
  state: TerminalHistoryState
): boolean {
  return terminalHistoryEligible(tab) && bufferType === 'alternate' && state.status === 'ready'
    && Boolean(state.snapshot);
}

export function applyTerminalHistorySnapshot(
  state: TerminalHistoryState,
  snapshot: PaneScrollbackSnapshot
): TerminalHistoryState {
  return {
    ...state,
    snapshot,
    status: 'ready',
    active: false,
    error: '',
    updated: false
  };
}

export function terminalHistoryDimensionsMatch(
  snapshot: PaneScrollbackSnapshot | null,
  columns: number,
  rows: number
): boolean {
  return Boolean(snapshot && snapshot.columns === columns && snapshot.rows === rows);
}

export function terminalHistoryAtBottom(viewportY: number, baseY: number): boolean {
  return viewportY >= baseY;
}
