import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyWorkspacePreset,
  assignWorkspaceSession,
  closeWorkspacePane,
  emptyWorkspaceLayout,
  focusWorkspacePane,
  normalizeWorkspaceLayout,
  normalizeRailState,
  resizeWorkspaceSplit,
  splitWorkspacePane,
  swapWorkspacePanes,
  workspacePanes,
  workspaceSplits,
  type WorkspaceIds
} from '../src/shared/workspace-layout';

function ids(): WorkspaceIds {
  let pane = 0; let split = 0;
  return { pane: () => `pane-${++pane}`, split: () => `split-${++split}` };
}

describe('workspace layout contract', () => {
  it('accepts the shared golden split tree', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'workspace_layout_v1.json'), 'utf8')) as unknown;
    const layout = normalizeWorkspaceLayout(fixture, ids());
    expect(workspacePanes(layout)).toHaveLength(3);
    expect(workspacePanes(layout).map((pane) => pane.sessionId)).toEqual([
      'gaming-desktop-ubuntu:codex-one', 'work-m-ubuntu:claude-two', null
    ]);
    expect(layout.focusedPaneId).toBe('pane-2');
  });

  it('splits in both directions, assigns unique sessions, swaps, and closes without killing the final leaf', () => {
    const factory = ids();
    let layout = emptyWorkspaceLayout(factory);
    layout = assignWorkspaceSession(layout, layout.focusedPaneId, 'host:one');
    layout = splitWorkspacePane(layout, layout.focusedPaneId, 'row', factory);
    layout = assignWorkspaceSession(layout, layout.focusedPaneId, 'host:two');
    layout = splitWorkspacePane(layout, layout.focusedPaneId, 'column', factory);
    layout = assignWorkspaceSession(layout, layout.focusedPaneId, 'host:three');
    expect(workspacePanes(layout)).toHaveLength(3);
    expect(workspaceSplits(layout).map((split) => split.direction)).toEqual(['row', 'column']);
    const [first, second] = workspacePanes(layout);
    layout = swapWorkspacePanes(layout, first.id, second.id);
    expect(workspacePanes(layout)[0].sessionId).toBe('host:two');
    layout = closeWorkspacePane(layout, second.id);
    expect(workspacePanes(layout)).toHaveLength(2);
    layout = closeWorkspacePane(layout, workspacePanes(layout)[1].id);
    layout = closeWorkspacePane(layout, workspacePanes(layout)[0].id);
    expect(workspacePanes(layout)).toMatchObject([{ sessionId: null }]);
  });

  it('focuses duplicate assignments instead of showing a session twice', () => {
    const factory = ids();
    let layout = emptyWorkspaceLayout(factory);
    layout = assignWorkspaceSession(layout, layout.focusedPaneId, 'host:one');
    layout = splitWorkspacePane(layout, layout.focusedPaneId, 'row', factory);
    const empty = layout.focusedPaneId;
    layout = assignWorkspaceSession(layout, empty, 'host:one');
    expect(workspacePanes(layout).filter((pane) => pane.sessionId === 'host:one')).toHaveLength(1);
    expect(layout.focusedPaneId).not.toBe(empty);
  });

  it('keeps the focused and recent sessions when a preset reduces panes', () => {
    const factory = ids();
    let layout = emptyWorkspaceLayout(factory);
    layout = assignWorkspaceSession(layout, layout.focusedPaneId, 'host:one');
    for (const session of ['host:two', 'host:three', 'host:four']) {
      layout = splitWorkspacePane(layout, layout.focusedPaneId, 'row', factory);
      layout = assignWorkspaceSession(layout, layout.focusedPaneId, session);
    }
    layout = focusWorkspacePane(layout, workspacePanes(layout).find((pane) => pane.sessionId === 'host:two')!.id);
    layout = applyWorkspacePreset(layout, 'two-rows', factory);
    expect(workspacePanes(layout).map((pane) => pane.sessionId)).toEqual(['host:two', 'host:four']);
    expect(workspaceSplits(layout)[0].direction).toBe('column');
  });

  it('bounds ratios and fails corrupt or over-deep state closed', () => {
    const factory = ids();
    let layout = emptyWorkspaceLayout(factory);
    layout = splitWorkspacePane(layout, layout.focusedPaneId, 'row', factory);
    layout = resizeWorkspaceSplit(layout, workspaceSplits(layout)[0].id, 2);
    expect(workspaceSplits(layout)[0].ratio).toBe(0.8);
    expect(normalizeWorkspaceLayout({ schemaVersion: 1, root: { kind: 'pane' }, focusedPaneId: '', sessionMru: [] }, factory))
      .toMatchObject({ schemaVersion: 1, root: { kind: 'pane', sessionId: null } });
  });

  it('normalizes and bounds locally hidden unavailable session identities', () => {
    const ids = Array.from({ length: 70 }, (_, index) => `host:session-${index}`);
    const rail = normalizeRailState({ hiddenUnavailableSessionIds: [...ids, ids[0], '', '../bad'] });
    expect(rail.hiddenUnavailableSessionIds).toHaveLength(64);
    expect(rail.hiddenUnavailableSessionIds[0]).toBe('host:session-0');
    expect(new Set(rail.hiddenUnavailableSessionIds).size).toBe(64);
  });
});
