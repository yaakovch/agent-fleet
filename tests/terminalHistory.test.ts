import { describe, expect, it } from 'vitest';
import type { PaneScrollbackSnapshot, TerminalTabDescriptor } from '../src/shared/terminal';
import {
  applyTerminalHistorySnapshot,
  createTerminalHistoryState,
  shouldCaptureTerminalHistoryScroll,
  terminalHistoryAtBottom,
  terminalHistoryDimensionsMatch,
  terminalHistoryEligible
} from '../src/renderer/src/terminal-history';

function tab(tool: TerminalTabDescriptor['tool'] = 'codex'): TerminalTabDescriptor {
  return {
    id: 'tab', sessionId: 'gaming:tab', hostId: 'gaming', project: 'wtmux', internalName: 'tab',
    label: 'tab', tool, backend: 'linux', viewMode: 'terminal', status: 'live', statusMessage: 'Live'
  };
}

const snapshot: PaneScrollbackSnapshot = {
  protocolVersion: 1, type: 'pane.scrollback', session: 'tab', columns: 120, rows: 32,
  historyLines: 800, capturedLines: 832, truncated: false, revision: 'a'.repeat(64),
  ansiBase64: 'cm93'
};

describe('terminal pane scrollback state', () => {
  it('captures only supported alternate-screen AI terminals with a ready pane cache', () => {
    const state = applyTerminalHistorySnapshot(createTerminalHistoryState(), snapshot);
    expect(terminalHistoryEligible(tab('codex'))).toBe(true);
    expect(terminalHistoryEligible(tab('shell'))).toBe(false);
    expect(shouldCaptureTerminalHistoryScroll(tab(), 'alternate', state)).toBe(true);
    expect(shouldCaptureTerminalHistoryScroll(tab(), 'normal', state)).toBe(false);
    expect(shouldCaptureTerminalHistoryScroll(tab(), 'alternate', createTerminalHistoryState())).toBe(false);
  });

  it('replaces the memory-only pane frame without conversation rows or modes', () => {
    const result = applyTerminalHistorySnapshot(createTerminalHistoryState(), snapshot);
    expect(result.snapshot).toBe(snapshot);
    expect(result.status).toBe('ready');
    expect(result.active).toBe(false);
    expect(Object.keys(result)).not.toContain('items');
    expect(Object.keys(result)).not.toContain('mode');
  });

  it('requires exact terminal dimensions and returns live at the cached bottom', () => {
    expect(terminalHistoryDimensionsMatch(snapshot, 120, 32)).toBe(true);
    expect(terminalHistoryDimensionsMatch(snapshot, 119, 32)).toBe(false);
    expect(terminalHistoryAtBottom(800, 800)).toBe(true);
    expect(terminalHistoryAtBottom(799, 800)).toBe(false);
  });
});
