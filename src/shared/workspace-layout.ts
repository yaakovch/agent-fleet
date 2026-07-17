import type { FleetTool } from './fleet';
import type { SessionViewMode } from './terminal';

export const MAX_WORKSPACE_PANES = 4;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;
export const MIN_RAIL_WIDTH = 180;
export const MAX_RAIL_WIDTH = 360;

export type WorkspaceSplitDirection = 'row' | 'column';
export type WorkspacePreset = 'single' | 'two-columns' | 'two-rows' | 'grid';
export type WorkspaceStatusFilter = 'all' | 'active' | 'waiting' | 'favorites';
export type WorkspacePlacement = 'replace' | 'split-right' | 'split-down';

export interface WorkspaceOpenRequest {
  paneId?: string;
  placement?: WorkspacePlacement;
}

export interface WorkspacePane {
  kind: 'pane';
  id: string;
  sessionId: string | null;
  viewMode: SessionViewMode;
}

export interface WorkspaceSplit {
  kind: 'split';
  id: string;
  direction: WorkspaceSplitDirection;
  ratio: number;
  first: WorkspaceNode;
  second: WorkspaceNode;
}

export type WorkspaceNode = WorkspacePane | WorkspaceSplit;

export interface WorkspaceLayout {
  schemaVersion: 1;
  root: WorkspaceNode;
  focusedPaneId: string;
  sessionMru: string[];
}

export interface WorkspaceRailState {
  width: number;
  collapsed: boolean;
  status: WorkspaceStatusFilter;
  hostIds: string[];
  tools: FleetTool[];
  showIdle: boolean;
  hiddenUnavailableSessionIds: string[];
}

export type WorkspaceCommand =
  | { type: 'assign'; paneId: string; sessionId: string }
  | { type: 'split'; paneId: string; direction: WorkspaceSplitDirection }
  | { type: 'close'; paneId: string }
  | { type: 'clear'; paneId: string }
  | { type: 'focus'; paneId: string }
  | { type: 'resize'; splitId: string; ratio: number }
  | { type: 'preset'; preset: WorkspacePreset }
  | { type: 'swap'; firstPaneId: string; secondPaneId: string }
  | { type: 'view'; paneId: string; viewMode: SessionViewMode }
  | { type: 'rail'; rail: WorkspaceRailState };

export interface WorkspaceIds {
  pane(): string;
  split(): string;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,320}$/u;
const DEFAULT_IDS: WorkspaceIds = {
  pane: () => `pane-${crypto.randomUUID()}`,
  split: () => `split-${crypto.randomUUID()}`
};

export function defaultRailState(): WorkspaceRailState {
  return {
    width: 240, collapsed: false, status: 'all', hostIds: [], tools: [], showIdle: true,
    hiddenUnavailableSessionIds: []
  };
}

export function emptyWorkspaceLayout(ids: WorkspaceIds = DEFAULT_IDS): WorkspaceLayout {
  const pane = emptyPane(ids.pane());
  return { schemaVersion: 1, root: pane, focusedPaneId: pane.id, sessionMru: [] };
}

export function emptyPane(id: string): WorkspacePane {
  return { kind: 'pane', id, sessionId: null, viewMode: 'native' };
}

export function workspacePanes(layout: Pick<WorkspaceLayout, 'root'>): WorkspacePane[] {
  const result: WorkspacePane[] = [];
  visit(layout.root, (pane) => result.push(pane));
  return result;
}

export function workspaceSplits(layout: Pick<WorkspaceLayout, 'root'>): WorkspaceSplit[] {
  const result: WorkspaceSplit[] = [];
  const walk = (node: WorkspaceNode): void => {
    if (node.kind === 'pane') return;
    result.push(node);
    walk(node.first);
    walk(node.second);
  };
  walk(layout.root);
  return result;
}

export function focusedPane(layout: WorkspaceLayout): WorkspacePane {
  return workspacePanes(layout).find((pane) => pane.id === layout.focusedPaneId) ?? workspacePanes(layout)[0];
}

export function paneForSession(layout: WorkspaceLayout, sessionId: string): WorkspacePane | undefined {
  return workspacePanes(layout).find((pane) => pane.sessionId === sessionId);
}

export function normalizeWorkspaceLayout(input: unknown, ids: WorkspaceIds = DEFAULT_IDS): WorkspaceLayout {
  const fallback = emptyWorkspaceLayout(ids);
  if (!input || typeof input !== 'object') return fallback;
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.sessionMru)) return fallback;
  const seenIds = new Set<string>();
  const seenSessions = new Set<string>();
  let leaves = 0;
  const root = parseNode(value.root, 0, seenIds, seenSessions, () => { leaves += 1; });
  if (!root || leaves < 1 || leaves > MAX_WORKSPACE_PANES) return fallback;
  const panes = collectPanes(root);
  const focusedPaneId = typeof value.focusedPaneId === 'string' && panes.some((pane) => pane.id === value.focusedPaneId)
    ? value.focusedPaneId : panes[0].id;
  const sessionMru = value.sessionMru.filter((item): item is string => typeof item === 'string' && SAFE_ID.test(item))
    .filter((item, index, items) => items.indexOf(item) === index).slice(0, 64);
  return { schemaVersion: 1, root, focusedPaneId, sessionMru };
}

export function normalizeRailState(input: unknown): WorkspaceRailState {
  const fallback = defaultRailState();
  if (!input || typeof input !== 'object') return fallback;
  const value = input as Record<string, unknown>;
  const width = typeof value.width === 'number' && Number.isFinite(value.width)
    ? clamp(Math.round(value.width), MIN_RAIL_WIDTH, MAX_RAIL_WIDTH) : fallback.width;
  const status = ['all', 'active', 'waiting', 'favorites'].includes(String(value.status))
    ? value.status as WorkspaceStatusFilter : fallback.status;
  const hostIds = safeIdList(value.hostIds, 32);
  const tools = Array.isArray(value.tools)
    ? value.tools.filter((item): item is FleetTool => ['shell', 'codex', 'claude', 'copilot'].includes(String(item)))
      .filter((item, index, items) => items.indexOf(item) === index)
    : [];
  return {
    width, collapsed: value.collapsed === true, status, hostIds, tools, showIdle: value.showIdle !== false,
    hiddenUnavailableSessionIds: safeIdList(value.hiddenUnavailableSessionIds, 64)
  };
}

export function focusWorkspacePane(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  const pane = workspacePanes(layout).find((item) => item.id === paneId);
  if (!pane) return layout;
  return touchSession({ ...layout, focusedPaneId: paneId }, pane.sessionId);
}

export function assignWorkspaceSession(layout: WorkspaceLayout, paneId: string, sessionId: string): WorkspaceLayout {
  if (!SAFE_ID.test(sessionId)) return layout;
  const existing = paneForSession(layout, sessionId);
  if (existing) return focusWorkspacePane(layout, existing.id);
  const pane = workspacePanes(layout).find((item) => item.id === paneId);
  if (!pane) return layout;
  const root = mapNode(layout.root, (item) => item.id === paneId ? { ...item, sessionId } : item);
  return touchSession({ ...layout, root, focusedPaneId: paneId }, sessionId);
}

export function clearWorkspacePane(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  if (!workspacePanes(layout).some((pane) => pane.id === paneId)) return layout;
  return { ...layout, root: mapNode(layout.root, (pane) => pane.id === paneId ? { ...pane, sessionId: null } : pane) };
}

export function setWorkspacePaneView(layout: WorkspaceLayout, paneId: string, viewMode: SessionViewMode): WorkspaceLayout {
  if (!['native', 'terminal'].includes(viewMode)) return layout;
  return {
    ...layout,
    root: mapNode(layout.root, (pane) => pane.id === paneId ? { ...pane, viewMode } : pane),
    focusedPaneId: workspacePanes(layout).some((pane) => pane.id === paneId) ? paneId : layout.focusedPaneId
  };
}

export function splitWorkspacePane(
  layout: WorkspaceLayout,
  paneId: string,
  direction: WorkspaceSplitDirection,
  ids: WorkspaceIds = DEFAULT_IDS
): WorkspaceLayout {
  if (!['row', 'column'].includes(direction) || workspacePanes(layout).length >= MAX_WORKSPACE_PANES) return layout;
  const pane = workspacePanes(layout).find((item) => item.id === paneId);
  if (!pane) return layout;
  const nextPane = emptyPane(ids.pane());
  const replacement: WorkspaceSplit = {
    kind: 'split', id: ids.split(), direction, ratio: 0.5, first: pane, second: nextPane
  };
  return { ...layout, root: replaceNode(layout.root, paneId, replacement), focusedPaneId: nextPane.id };
}

export function closeWorkspacePane(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  const panes = workspacePanes(layout);
  if (!panes.some((pane) => pane.id === paneId)) return layout;
  if (panes.length === 1) {
    return { ...layout, root: { ...panes[0], sessionId: null }, focusedPaneId: panes[0].id };
  }
  const result = removeNode(layout.root, paneId);
  if (!result) return layout;
  const remaining = collectPanes(result);
  const focusedPaneId = layout.focusedPaneId === paneId || !remaining.some((pane) => pane.id === layout.focusedPaneId)
    ? remaining[0].id : layout.focusedPaneId;
  return { ...layout, root: result, focusedPaneId };
}

export function resizeWorkspaceSplit(layout: WorkspaceLayout, splitId: string, ratio: number): WorkspaceLayout {
  if (!Number.isFinite(ratio)) return layout;
  const next = clamp(ratio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO);
  const walk = (node: WorkspaceNode): WorkspaceNode => node.kind === 'pane' ? node : {
    ...node,
    ratio: node.id === splitId ? next : node.ratio,
    first: walk(node.first),
    second: walk(node.second)
  };
  return { ...layout, root: walk(layout.root) };
}

export function swapWorkspacePanes(layout: WorkspaceLayout, firstPaneId: string, secondPaneId: string): WorkspaceLayout {
  if (firstPaneId === secondPaneId) return layout;
  const panes = workspacePanes(layout);
  const first = panes.find((pane) => pane.id === firstPaneId);
  const second = panes.find((pane) => pane.id === secondPaneId);
  if (!first || !second) return layout;
  const root = mapNode(layout.root, (pane) => pane.id === firstPaneId
    ? { ...pane, sessionId: second.sessionId, viewMode: second.viewMode }
    : pane.id === secondPaneId
      ? { ...pane, sessionId: first.sessionId, viewMode: first.viewMode }
      : pane);
  return { ...layout, root, focusedPaneId: secondPaneId };
}

export function applyWorkspacePreset(
  layout: WorkspaceLayout,
  preset: WorkspacePreset,
  ids: WorkspaceIds = DEFAULT_IDS
): WorkspaceLayout {
  const counts: Record<WorkspacePreset, number> = { single: 1, 'two-columns': 2, 'two-rows': 2, grid: 4 };
  if (!(preset in counts)) return layout;
  const current = workspacePanes(layout);
  const focused = focusedPane(layout);
  const assigned = current.filter((pane) => pane.sessionId);
  const ordered = [focused, ...layout.sessionMru.map((sessionId) => assigned.find((pane) => pane.sessionId === sessionId)), ...assigned]
    .filter((pane): pane is WorkspacePane => Boolean(pane?.sessionId))
    .filter((pane, index, panes) => panes.findIndex((item) => item.sessionId === pane.sessionId) === index)
    .slice(0, counts[preset]);
  const panes: WorkspacePane[] = Array.from({ length: counts[preset] }, (_, index) => {
    const source = ordered[index];
    return source ? { ...source, id: ids.pane() } : emptyPane(ids.pane());
  });
  let root: WorkspaceNode;
  if (preset === 'single') root = panes[0];
  else if (preset === 'two-columns') root = makeSplit(ids, 'row', panes[0], panes[1]);
  else if (preset === 'two-rows') root = makeSplit(ids, 'column', panes[0], panes[1]);
  else root = makeSplit(ids, 'column', makeSplit(ids, 'row', panes[0], panes[1]), makeSplit(ids, 'row', panes[2], panes[3]));
  const focusedSession = focused.sessionId;
  const focusedPaneId = collectPanes(root).find((pane) => pane.sessionId === focusedSession)?.id ?? collectPanes(root)[0].id;
  return { ...layout, root, focusedPaneId };
}

function makeSplit(ids: WorkspaceIds, direction: WorkspaceSplitDirection, first: WorkspaceNode, second: WorkspaceNode): WorkspaceSplit {
  return { kind: 'split', id: ids.split(), direction, ratio: 0.5, first, second };
}

function parseNode(
  input: unknown,
  depth: number,
  seenIds: Set<string>,
  seenSessions: Set<string>,
  onPane: () => void
): WorkspaceNode | null {
  if (!input || typeof input !== 'object' || depth > 4) return null;
  const value = input as Record<string, unknown>;
  if (typeof value.id !== 'string' || !SAFE_ID.test(value.id) || seenIds.has(value.id)) return null;
  seenIds.add(value.id);
  if (value.kind === 'pane') {
    onPane();
    const sessionId = value.sessionId === null ? null
      : typeof value.sessionId === 'string' && SAFE_ID.test(value.sessionId) && !seenSessions.has(value.sessionId)
        ? value.sessionId : undefined;
    if (sessionId === undefined || !['native', 'terminal'].includes(String(value.viewMode))) return null;
    if (sessionId) seenSessions.add(sessionId);
    return { kind: 'pane', id: value.id, sessionId, viewMode: value.viewMode as SessionViewMode };
  }
  if (value.kind !== 'split' || !['row', 'column'].includes(String(value.direction))
    || typeof value.ratio !== 'number' || value.ratio < MIN_SPLIT_RATIO || value.ratio > MAX_SPLIT_RATIO) return null;
  const first = parseNode(value.first, depth + 1, seenIds, seenSessions, onPane);
  const second = parseNode(value.second, depth + 1, seenIds, seenSessions, onPane);
  return first && second ? { kind: 'split', id: value.id, direction: value.direction as WorkspaceSplitDirection, ratio: value.ratio, first, second } : null;
}

function visit(node: WorkspaceNode, callback: (pane: WorkspacePane) => void): void {
  if (node.kind === 'pane') callback(node);
  else { visit(node.first, callback); visit(node.second, callback); }
}

function collectPanes(root: WorkspaceNode): WorkspacePane[] {
  const panes: WorkspacePane[] = [];
  visit(root, (pane) => panes.push(pane));
  return panes;
}

function mapNode(node: WorkspaceNode, callback: (pane: WorkspacePane) => WorkspacePane): WorkspaceNode {
  return node.kind === 'pane' ? callback(node) : { ...node, first: mapNode(node.first, callback), second: mapNode(node.second, callback) };
}

function replaceNode(node: WorkspaceNode, id: string, replacement: WorkspaceNode): WorkspaceNode {
  if (node.id === id) return replacement;
  return node.kind === 'pane' ? node : { ...node, first: replaceNode(node.first, id, replacement), second: replaceNode(node.second, id, replacement) };
}

function removeNode(node: WorkspaceNode, id: string): WorkspaceNode | null {
  if (node.id === id) return null;
  if (node.kind === 'pane') return node;
  const first = removeNode(node.first, id);
  const second = removeNode(node.second, id);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function touchSession(layout: WorkspaceLayout, sessionId: string | null): WorkspaceLayout {
  if (!sessionId) return layout;
  return { ...layout, sessionMru: [sessionId, ...layout.sessionMru.filter((item) => item !== sessionId)].slice(0, 64) };
}

function safeIdList(input: unknown, max: number): string[] {
  return Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string' && SAFE_ID.test(item))
    .filter((item, index, items) => items.indexOf(item) === index).slice(0, max) : [];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
