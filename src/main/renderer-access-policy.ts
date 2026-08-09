export type RendererRole = 'widget' | 'dashboard' | 'settings';
export type RendererContentKind = 'terminal' | 'conversation';

interface RendererGrant {
  role: RendererRole;
  terminal: Set<string>;
  conversation: Set<string>;
}

const SAFE_TAB_ID = /^[A-Za-z0-9._:-]{1,320}$/u;
const MAX_VISIBLE_TABS = 4;
const DASHBOARD_ONLY = ['dashboard'] as const;
const SETTINGS_ONLY = ['settings'] as const;
const WIDGET_ONLY = ['widget'] as const;
const DASHBOARD_AND_SETTINGS = ['dashboard', 'settings'] as const;
const APP_WINDOWS = ['widget', 'dashboard', 'settings'] as const;

export function allowedRendererRoles(channel: string): readonly RendererRole[] {
  if (/^(?:fleet|terminal):/u.test(channel)) return DASHBOARD_ONLY;
  if (channel.startsWith('conversation:')) {
    return channel === 'conversation:copyText' ? DASHBOARD_AND_SETTINGS : DASHBOARD_ONLY;
  }
  if (channel.startsWith('runtime:')) return SETTINGS_ONLY;
  if (channel.startsWith('localSuggestions:')) {
    if (['localSuggestions:getSettings'].includes(channel)) return DASHBOARD_AND_SETTINGS;
    if (['localSuggestions:suggest', 'localSuggestions:cancel'].includes(channel)) return DASHBOARD_ONLY;
    return SETTINGS_ONLY;
  }
  if (['limits:getSettings', 'limits:saveSettings'].includes(channel)) return DASHBOARD_AND_SETTINGS;
  if ([
    'limits:testCodexProfile', 'limits:discoverWsl', 'limits:previewSettingsImport',
    'limits:applySettingsImport', 'limits:exportSettings', 'limits:rollbackSettings',
    'limits:getClaudeIntegration', 'limits:installClaudeIntegration', 'limits:removeClaudeIntegration',
    'limits:getAppInfo', 'limits:getDiagnostics', 'limits:exportDiagnostics', 'limits:getUpdaterState',
    'limits:checkForUpdates', 'limits:restartToUpdate', 'limits:openReleasePage'
  ].includes(channel)) return SETTINGS_ONLY;
  if (['limits:getState', 'limits:refreshNow', 'limits:openSettings',
    'limits:getInteractionMode', 'limits:setInteractionMode', 'limits:windowQuit'].includes(channel)) {
    return WIDGET_ONLY;
  }
  if (channel === 'limits:windowHide') return APP_WINDOWS;
  return [];
}

/**
 * Renderer identity and content subscriptions are main-process state. A
 * renderer cannot acquire a tab simply by knowing its id: only a registered
 * dashboard may receive a grant, and grants are replaced as workspace panes
 * change.
 */
export class RendererAccessPolicy {
  private readonly renderers = new Map<number, RendererGrant>();

  register(senderId: number, role: RendererRole): void {
    if (!Number.isSafeInteger(senderId) || senderId < 1) throw new Error('Renderer identity is invalid');
    this.renderers.set(senderId, { role, terminal: new Set(), conversation: new Set() });
  }

  unregister(senderId: number): void {
    this.renderers.delete(senderId);
  }

  role(senderId: number): RendererRole | null {
    return this.renderers.get(senderId)?.role ?? null;
  }

  assertRole(senderId: number, role: RendererRole): void {
    if (this.renderers.get(senderId)?.role !== role) throw new Error(`IPC requires the ${role} window`);
  }

  assertAnyRole(senderId: number, roles: readonly RendererRole[]): void {
    const role = this.renderers.get(senderId)?.role;
    if (!role || !roles.includes(role)) throw new Error('IPC is unavailable from this app window');
  }

  setBindings(senderId: number, kind: RendererContentKind, tabIds: readonly string[]): string[] {
    this.assertRole(senderId, 'dashboard');
    if (!Array.isArray(tabIds) || tabIds.length > MAX_VISIBLE_TABS
      || tabIds.some((tabId) => !SAFE_TAB_ID.test(tabId))) {
      throw new Error('Renderer tab bindings are invalid');
    }
    const unique = [...new Set(tabIds)];
    this.renderers.get(senderId)![kind] = new Set(unique);
    return unique;
  }

  grant(senderId: number, kind: RendererContentKind, tabId: string): void {
    this.assertRole(senderId, 'dashboard');
    if (!SAFE_TAB_ID.test(tabId)) throw new Error('Renderer tab binding is invalid');
    const grant = this.renderers.get(senderId)!;
    if (!grant[kind].has(tabId) && grant[kind].size >= MAX_VISIBLE_TABS) {
      throw new Error('Renderer has too many content bindings');
    }
    grant[kind].add(tabId);
  }

  revoke(senderId: number, kind: RendererContentKind, tabId: string): void {
    this.renderers.get(senderId)?.[kind].delete(tabId);
  }

  revokeTab(tabId: string): void {
    for (const grant of this.renderers.values()) {
      grant.terminal.delete(tabId);
      grant.conversation.delete(tabId);
    }
  }

  canAccess(senderId: number, kind: RendererContentKind, tabId: string): boolean {
    const grant = this.renderers.get(senderId);
    return grant?.role === 'dashboard' && grant[kind].has(tabId);
  }

  bindings(senderId: number, kind: RendererContentKind): string[] {
    this.assertRole(senderId, 'dashboard');
    return [...this.renderers.get(senderId)![kind]];
  }
}
