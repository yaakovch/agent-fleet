import type { PaneScrollbackSnapshot, TerminalTabDescriptor } from '../../shared/terminal';

export const TERMINAL_HISTORY_QUIET_MS = 900;
export const TERMINAL_HISTORY_MIN_INTERVAL_MS = 5_000;

export type TerminalHistoryStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface TerminalHistoryState {
  snapshot: PaneScrollbackSnapshot | null;
  status: TerminalHistoryStatus;
  active: boolean;
  error: string;
  updated: boolean;
  generation: number;
  capturedAt: number;
  dirtyVersion: number;
  binding: string;
  pendingSnapshot: PaneScrollbackSnapshot | null;
}

export function createTerminalHistoryState(): TerminalHistoryState {
  return { snapshot: null, status: 'idle', active: false, error: '', updated: false, generation: 0,
    capturedAt: 0, dirtyVersion: 0, binding: '', pendingSnapshot: null };
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
  if (state.active) return { ...state, status: 'ready', error: '', updated: true, pendingSnapshot: snapshot };
  const unchanged = state.snapshot?.revision === snapshot.revision &&
    terminalHistoryDimensionsMatch(state.snapshot, snapshot.columns, snapshot.rows);
  return {
    ...state,
    snapshot: unchanged ? state.snapshot : snapshot,
    status: 'ready',
    active: false,
    error: '',
    updated: false,
    pendingSnapshot: null
  };
}

export function terminalHistoryDimensionsMatch(
  snapshot: PaneScrollbackSnapshot | null,
  columns: number,
  rows: number
): boolean {
  return Boolean(snapshot && snapshot.columns === columns && snapshot.rows === rows);
}

/** tmux status/border rows reduce the pane height without changing its wrapping width. */
export function terminalHistoryFitsViewport(
  snapshot: PaneScrollbackSnapshot | null,
  columns: number,
  rows: number
): boolean {
  return Boolean(snapshot && snapshot.columns === columns && snapshot.rows > 0 && snapshot.rows <= rows);
}

export function terminalHistoryAtBottom(viewportY: number, baseY: number): boolean {
  return viewportY >= baseY;
}
