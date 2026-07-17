import { describe, expect, it } from 'vitest';
import type { TerminalTabDescriptor, TerminalWorkspaceState } from '../src/shared/terminal';
import {
  assignWorkspaceSession,
  defaultRailState,
  emptyWorkspaceLayout,
  focusedPane,
  setWorkspacePaneView,
  type WorkspaceLayout
} from '../src/shared/workspace-layout';
import {
  workspacePaneRenderState,
  workspacePanePresentation,
  workspaceStructureChanged
} from '../src/renderer/src/workspace-render-state';

const SESSION_ID = 'gaming:wtmux-renderer';

function emptyState(): TerminalWorkspaceState {
  return {
    version: 2,
    layout: emptyWorkspaceLayout({ pane: () => 'pane-root', split: () => 'split-unused' }),
    rail: defaultRailState(),
    tabs: []
  };
}

function assignedLayout(viewMode: 'native' | 'terminal'): WorkspaceLayout {
  const empty = emptyState().layout;
  const assigned = assignWorkspaceSession(empty, empty.focusedPaneId, SESSION_ID);
  return setWorkspacePaneView(assigned, assigned.focusedPaneId, viewMode);
}

function tab(value: Partial<TerminalTabDescriptor> = {}): TerminalTabDescriptor {
  return {
    id: 'tab-renderer',
    sessionId: SESSION_ID,
    hostId: 'gaming',
    project: 'agent-fleet',
    internalName: 'wtmux-renderer',
    label: 'Renderer',
    tool: 'codex',
    backend: 'linux',
    viewMode: 'native',
    status: 'live',
    statusMessage: 'Live',
    ...value
  };
}

function state(layout: WorkspaceLayout, tabs: TerminalTabDescriptor[]): TerminalWorkspaceState {
  return { version: 2, layout, rail: defaultRailState(), tabs };
}

describe('workspace renderer state', () => {
  it('structurally changes from an empty pane to one Native session', () => {
    const previous = emptyState();
    const next = state(assignedLayout('native'), [tab()]);
    expect(workspaceStructureChanged(previous, next)).toBe(true);
    expect(workspacePaneRenderState(focusedPane(next.layout), next.tabs)).toBe('native');
  });

  it('structurally changes from an empty pane to one Terminal session', () => {
    const previous = emptyState();
    const next = state(assignedLayout('terminal'), [tab({ viewMode: 'terminal' })]);
    expect(workspaceStructureChanged(previous, next)).toBe(true);
    expect(workspacePaneRenderState(focusedPane(next.layout), next.tabs)).toBe('terminal');
  });

  it('represents an assigned session without a descriptor as opening', () => {
    const next = state(assignedLayout('native'), []);
    expect(workspacePaneRenderState(focusedPane(next.layout), next.tabs)).toBe('opening');
    expect(workspacePanePresentation(focusedPane(next.layout), next.tabs, { sessionName: 'Renderer' })).toEqual(
      expect.objectContaining({ title: 'Renderer', modeBadge: 'N', status: 'connecting', nativeEnabled: false, terminalEnabled: false })
    );
  });

  it('keeps empty pane controls stable but disabled', () => {
    const next = emptyState();
    expect(workspacePanePresentation(focusedPane(next.layout), next.tabs)).toEqual(expect.objectContaining({
      renderState: 'empty', title: 'Empty pane', status: 'empty', modeBadge: 'N',
      nativeEnabled: false, terminalEnabled: false, retryVisible: false, hasSessionActions: false
    }));
  });

  it('renders exactly once when the awaited descriptor arrives', () => {
    const opening = state(assignedLayout('native'), []);
    const opened = state(opening.layout, [tab()]);
    const duplicate = state(opening.layout, [tab()]);
    const structuralRenders = [
      workspaceStructureChanged(opening, opened),
      workspaceStructureChanged(opened, duplicate)
    ].filter(Boolean).length;
    expect(structuralRenders).toBe(1);
  });

  it('patches ordinary status and heartbeat text without a structural render', () => {
    const layout = assignedLayout('native');
    const live = state(layout, [tab()]);
    const reconnecting = state(layout, [tab({ status: 'reconnecting', statusMessage: 'Reconnecting in 2s' })]);
    expect(workspaceStructureChanged(live, reconnecting)).toBe(false);
    expect(workspacePanePresentation(focusedPane(reconnecting.layout), reconnecting.tabs)).toEqual(
      expect.objectContaining({ status: 'reconnecting', retryVisible: true, hasSessionActions: true })
    );
  });

  it('patches focus without structurally rerendering pane content', () => {
    const first = emptyState();
    const split = {
      ...first.layout,
      root: {
        kind: 'split' as const, id: 'split-root', direction: 'row' as const, ratio: 0.5,
        first: first.layout.root,
        second: { kind: 'pane' as const, id: 'pane-second', sessionId: null, viewMode: 'terminal' as const }
      }
    };
    const focusedSecond = { ...split, focusedPaneId: 'pane-second' };
    expect(workspaceStructureChanged(state(split, []), state(focusedSecond, []))).toBe(false);
  });

  it('structurally renders Native/Terminal switches and terminal failure transitions', () => {
    const native = state(assignedLayout('native'), [tab()]);
    const terminal = state(assignedLayout('terminal'), [tab({ viewMode: 'terminal' })]);
    const failed = state(terminal.layout, [tab({
      viewMode: 'terminal', status: 'unavailable', statusMessage: 'Terminal unavailable',
      failure: { code: 'conpty_unavailable', message: 'ConPTY could not start', retryable: true }
    })]);
    const recovered = state(terminal.layout, [tab({ viewMode: 'terminal' })]);
    expect(workspaceStructureChanged(native, terminal)).toBe(true);
    expect(workspaceStructureChanged(terminal, failed)).toBe(true);
    expect(workspacePaneRenderState(focusedPane(failed.layout), failed.tabs)).toBe('terminal-failure');
    expect(workspacePanePresentation(focusedPane(failed.layout), failed.tabs)).toEqual(expect.objectContaining({
      renderState: 'terminal-failure', modeBadge: 'T', retryVisible: true
    }));
    expect(workspaceStructureChanged(failed, recovered)).toBe(true);
  });

  it('disables Native for shell tabs and retry while the host is unavailable', () => {
    const layout = assignedLayout('terminal');
    const pane = focusedPane(layout);
    expect(workspacePanePresentation(pane, [tab({ tool: 'shell', status: 'offline' })], { unavailable: true }))
      .toEqual(expect.objectContaining({ nativeEnabled: false, terminalEnabled: true, retryVisible: false }));
  });

  it('structurally renders descriptor disappearance and identity replacement', () => {
    const layout = assignedLayout('native');
    const opened = state(layout, [tab()]);
    const replaced = state(layout, [tab({ id: 'tab-replacement' })]);
    const missing = state(layout, []);
    expect(workspaceStructureChanged(opened, replaced)).toBe(true);
    expect(workspaceStructureChanged(replaced, missing)).toBe(true);
  });
});
