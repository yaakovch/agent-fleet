import type {
  TerminalConnectionStatus,
  TerminalTabDescriptor,
  TerminalWorkspaceState
} from '../../shared/terminal';
import type { WorkspaceNode, WorkspacePane } from '../../shared/workspace-layout';

export type WorkspacePaneRenderState = 'empty' | 'opening' | 'native' | 'terminal' | 'terminal-failure';

export interface WorkspacePanePresentation {
  renderState: WorkspacePaneRenderState;
  title: string;
  context: string;
  modeBadge: 'N' | 'T';
  status: TerminalConnectionStatus | 'empty';
  nativeEnabled: boolean;
  terminalEnabled: boolean;
  retryVisible: boolean;
  hasSessionActions: boolean;
}

export interface WorkspacePanePresentationOptions {
  sessionName?: string;
  unavailable?: boolean;
}

export function workspacePaneRenderState(
  pane: WorkspacePane,
  tabs: ReadonlyArray<TerminalTabDescriptor>
): WorkspacePaneRenderState {
  if (!pane.sessionId) return 'empty';
  const tab = tabs.find((item) => item.sessionId === pane.sessionId);
  if (!tab) return 'opening';
  if (pane.viewMode === 'terminal' && tab.failure) return 'terminal-failure';
  return pane.viewMode;
}

export function workspacePanePresentation(
  pane: WorkspacePane,
  tabs: ReadonlyArray<TerminalTabDescriptor>,
  options: WorkspacePanePresentationOptions = {}
): WorkspacePanePresentation {
  const renderState = workspacePaneRenderState(pane, tabs);
  const modeBadge = pane.viewMode === 'native' ? 'N' : 'T';
  const tab = pane.sessionId ? tabs.find((item) => item.sessionId === pane.sessionId) : undefined;
  if (!pane.sessionId) {
    return {
      renderState, title: 'Empty pane', context: 'Choose a session from the rail', modeBadge,
      status: 'empty', nativeEnabled: false, terminalEnabled: false, retryVisible: false,
      hasSessionActions: false
    };
  }
  if (!tab) {
    return {
      renderState, title: options.sessionName || 'Opening session…',
      context: `Preparing the ${pane.viewMode === 'native' ? 'Native conversation' : 'Terminal'} view`,
      modeBadge, status: 'connecting', nativeEnabled: false, terminalEnabled: false,
      retryVisible: false, hasSessionActions: false
    };
  }
  return {
    renderState, title: tab.label, context: `${tab.hostId} · ${tab.project} · ${tab.statusMessage}`,
    modeBadge, status: tab.status, nativeEnabled: tab.tool !== 'shell', terminalEnabled: true,
    retryVisible: !options.unavailable && tab.status !== 'live' && tab.status !== 'ended',
    hasSessionActions: true
  };
}

export function workspaceStructureSignature(state: TerminalWorkspaceState): string {
  const tabsBySession = new Map(state.tabs.map((tab) => [tab.sessionId, tab]));
  return nodeStructureSignature(state.layout.root, tabsBySession);
}

export function workspaceStructureChanged(
  previous: TerminalWorkspaceState,
  next: TerminalWorkspaceState
): boolean {
  return workspaceStructureSignature(previous) !== workspaceStructureSignature(next);
}

function nodeStructureSignature(
  node: WorkspaceNode,
  tabsBySession: ReadonlyMap<string, TerminalTabDescriptor>
): string {
  if (node.kind === 'split') {
    return JSON.stringify([
      'split', node.id, node.direction,
      nodeStructureSignature(node.first, tabsBySession),
      nodeStructureSignature(node.second, tabsBySession)
    ]);
  }
  const tab = node.sessionId ? tabsBySession.get(node.sessionId) : undefined;
  return JSON.stringify([
    'pane', node.id, node.sessionId, node.viewMode,
    tab ? [
      tab.id, tab.sessionId, tab.hostId, tab.internalName, tab.tool, tab.backend, tab.viewMode,
      tab.failure ? [tab.failure.code, tab.failure.message, tab.failure.retryable] : null
    ] : null
  ]);
}
