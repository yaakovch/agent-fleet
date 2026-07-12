import {
  Activity,
  Bell,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  CloudOff,
  Command,
  Copy,
  ExternalLink,
  FolderOpen,
  Gauge,
  HeartPulse,
  History,
  House,
  Laptop,
  LayoutDashboard,
  MessageSquareText,
  Monitor,
  MoreHorizontal,
  Network,
  PanelTopOpen,
  Pause,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Star,
  Terminal,
  Trash2,
  UserPlus,
  Wrench,
  X,
  createIcons
} from 'lucide';
import type {
  FleetAttention,
  FleetHost,
  FleetSchedule,
  FleetSession,
  FleetSeverity,
  FleetSnapshot,
  FleetTool
} from '../../shared/fleet';
import type { FleetBridgeView } from '../../shared/fleet-protocol';
import { FLEET_FIXTURE } from './fleet-fixtures';

type DashboardView = 'overview' | 'sessions' | 'launcher' | 'schedules' | 'fleet' | 'settings';
type DashboardScenario = 'live' | 'offline' | 'empty' | 'error';
type ModalState = {
  title: string;
  body: string;
  confirm: string;
  destructive?: boolean;
  action?: { kind: 'kill-session' | 'cancel-schedule' | 'create-schedule'; id: string };
  deliverAt?: string;
} | null;

const dashboardIcons = {
  Activity,
  Bell,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  CloudOff,
  Command,
  Copy,
  ExternalLink,
  FolderOpen,
  Gauge,
  HeartPulse,
  History,
  House,
  Laptop,
  LayoutDashboard,
  MessageSquareText,
  Monitor,
  MoreHorizontal,
  Network,
  PanelTopOpen,
  Pause,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Star,
  Terminal,
  Trash2,
  UserPlus,
  Wrench,
  X
};

const NAV_ITEMS: ReadonlyArray<{ view: DashboardView; label: string; icon: string }> = [
  { view: 'overview', label: 'Overview', icon: 'layout-dashboard' },
  { view: 'sessions', label: 'Sessions', icon: 'square-terminal' },
  { view: 'launcher', label: 'Launcher', icon: 'rocket' },
  { view: 'schedules', label: 'Schedules', icon: 'calendar-clock' },
  { view: 'fleet', label: 'Fleet', icon: 'network' },
  { view: 'settings', label: 'Settings', icon: 'settings' }
];

export class DashboardPrototype {
  private view: DashboardView = 'overview';
  private scenario: DashboardScenario = 'live';
  private scheduleTab: 'pending' | 'history' = 'pending';
  private search = '';
  private modal: ModalState = null;
  private toast = '';
  private snapshot: FleetSnapshot;
  private cacheSavedAt: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    snapshot: FleetSnapshot = FLEET_FIXTURE
  ) {
    this.snapshot = snapshot;
    root.addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.dashboardSearch === undefined) return;
      this.search = input.value;
      this.render();
    });
    root.addEventListener('change', (event) => {
      const select = event.target as HTMLSelectElement;
      if (select.dataset.dashboardScenario === undefined) return;
      this.scenario = isScenario(select.value) ? select.value : 'live';
      this.modal = null;
      this.toast = '';
      this.render();
    });
  }

  setFleetState(view: FleetBridgeView): void {
    this.snapshot = view.snapshot;
    this.cacheSavedAt = view.cacheSavedAt;
    this.scenario = view.status === 'live'
      ? (view.snapshot.hosts.length ? 'live' : 'empty')
      : view.status === 'error'
        ? 'error'
        : view.snapshot.hosts.length
          ? 'offline'
          : 'empty';
    this.render();
  }

  render(): void {
    this.root.innerHTML = `
      <main class="fleet-shell">
        ${this.renderSidebar()}
        <section class="fleet-workspace">
          ${this.renderHeader()}
          <div class="fleet-content">
            ${this.renderScenarioBanner()}
            ${this.renderCurrentView()}
          </div>
        </section>
        ${this.modal ? this.renderModal(this.modal) : ''}
        ${this.toast ? `<div class="fleet-toast">${icon('circle-check')}<span>${escapeHtml(this.toast)}</span></div>` : ''}
      </main>`;
    createIcons({ icons: dashboardIcons });
  }

  handleAction(action: string, target: HTMLElement): boolean {
    const control = target.closest<HTMLElement>('[data-action]') ?? target;
    if (action === 'dashboard-nav') {
      const view = control.dataset.view;
      if (isDashboardView(view)) this.view = view;
      this.search = '';
      this.render();
      return true;
    }
    if (action === 'dashboard-close') {
      void window.limitsWidget.hide();
      return true;
    }
    if (action === 'schedule-tab') {
      this.scheduleTab = control.dataset.tab === 'history' ? 'history' : 'pending';
      this.render();
      return true;
    }
    if (action === 'dashboard-kill-session') {
      const session = this.sessionFromControl(control);
      if (session) this.confirmKill(session);
      return true;
    }
    if (action === 'dashboard-cancel-schedule') {
      const schedule = this.scheduleFromControl(control);
      if (schedule) this.confirmCancelSchedule(schedule);
      return true;
    }
    if (action === 'dashboard-repair-host') {
      const host = this.hostFromControl(control);
      if (host) this.confirmRepair(host);
      return true;
    }
    if (action === 'modal-cancel') {
      this.modal = null;
      this.render();
      return true;
    }
    if (action === 'modal-confirm') {
      const pending = this.modal?.action;
      const sessionId = this.root.querySelector<HTMLSelectElement>('[data-modal-session]')?.value;
      const localTime = this.root.querySelector<HTMLInputElement>('[data-modal-deliver-at]')?.value;
      this.modal = null;
      this.render();
      if (pending) void this.executeMutation(pending, sessionId, localTime);
      return true;
    }
    if (action === 'dashboard-open-session') {
      const session = this.sessionFromControl(control);
      if (!session) return this.showToast('Session is no longer available');
      void window.limitsWidget.openFleetSession(session.id).then((result) => this.showToast(result.message));
      return true;
    }
    if (action === 'dashboard-copy') return this.showToast('Attach command copied');
    if (action === 'dashboard-launch') return this.showToast('Launcher request validated; live execution is intentionally not wired at Gate 1');
    if (action === 'dashboard-new-schedule') {
      this.openScheduleModal();
      return true;
    }
    if (action === 'dashboard-edit-schedule') return this.showToast('Pending schedule is ready to edit');
    if (action === 'dashboard-pair') return this.showToast('Created a ten-minute pairing invitation preview');
    if (action === 'dashboard-review-pairing') return this.showToast('Pairing proposal review opened');
    if (action === 'dashboard-pause') return this.showToast('Fleet notifications paused on this PC for one hour');
    if (action === 'dashboard-refresh') {
      void window.limitsWidget.refreshFleet();
      return this.showToast('Fleet refresh requested');
    }
    if (action === 'dashboard-attention') {
      const attentionId = control.closest<HTMLElement>('[data-attention-id]')?.dataset.attentionId;
      const item = this.snapshot.attention.find((candidate) => candidate.id === attentionId);
      if (item?.targetSessionId) {
        this.openScheduleModal(item.targetSessionId, item.suggestedAt);
        return true;
      }
      return this.showToast(this.snapshot.attention.length ? 'Choose an attention item' : 'Nothing needs attention');
    }
    if (action === 'dashboard-favorite') return this.showToast('Favorite launcher selected');
    return false;
  }

  private showToast(message: string): true {
    this.toast = message;
    this.render();
    return true;
  }

  private async executeMutation(
    action: NonNullable<ModalState>['action'],
    selectedSessionId?: string,
    localTime?: string
  ): Promise<void> {
    if (!action) return;
    let result: { ok: boolean; message: string };
    if (action.kind === 'kill-session') result = await window.limitsWidget.killFleetSession(action.id);
    else if (action.kind === 'cancel-schedule') result = await window.limitsWidget.cancelFleetSchedule(action.id);
    else if (!selectedSessionId || !localTime) result = { ok: false, message: 'Choose a session and future time' };
    else {
      const instant = new Date(localTime);
      result = Number.isFinite(instant.getTime())
        ? await window.limitsWidget.createFleetContinueSchedule(selectedSessionId, instant.toISOString())
        : { ok: false, message: 'Choose a valid future time' };
    }
    this.showToast(result.message);
  }

  private openScheduleModal(defaultSessionId = '', suggestedAt?: string): void {
    if (!this.snapshot.sessions.length) {
      this.showToast('No live session is available');
      return;
    }
    this.modal = {
      title: 'Schedule continue',
      body: 'Agent Fleet will send the standard continue action once at the selected time. Custom prompt text never crosses the desktop bridge.',
      confirm: 'Schedule continue',
      action: { kind: 'create-schedule', id: defaultSessionId },
      deliverAt: suggestedAt
    };
    this.render();
  }

  private renderSidebar(): string {
    const badges: Partial<Record<DashboardView, number>> = {
      sessions: this.snapshot.sessions.length,
      schedules: this.snapshot.schedules.filter((item) => item.status === 'pending').length,
      fleet: this.snapshot.pairingRequests.filter((item) => item.status === 'awaiting-review').length
    };
    return `<aside class="fleet-sidebar">
      <div class="fleet-brand"><span class="fleet-mark">AF</span><div><strong>Agent Fleet</strong><small>Private beta</small></div></div>
      <nav class="fleet-nav" aria-label="Agent Fleet">
        ${NAV_ITEMS.map((item) => `<button class="${this.view === item.view ? 'active' : ''}" data-action="dashboard-nav" data-view="${item.view}">${icon(item.icon)}<span>${item.label}</span>${badges[item.view] ? `<b>${badges[item.view]}</b>` : ''}</button>`).join('')}
      </nav>
      <div class="fleet-controller">
        <div class="status-dot status-${this.snapshot.controller.status}"></div>
        <div><strong>${escapeHtml(this.snapshot.controller.distro)}</strong><small>Controller · protocol v${this.snapshot.controller.protocolVersion}</small></div>
        ${icon('chevron-right')}
      </div>
    </aside>`;
  }

  private renderHeader(): string {
    const titles: Record<DashboardView, [string, string]> = {
      overview: ['Overview', 'Your coding fleet at a glance'],
      sessions: ['Sessions', 'Open and manage tmux sessions on every host'],
      launcher: ['Launcher', 'Start a safe, explicit tool session'],
      schedules: ['Schedules', 'Pending messages and 30-day delivery history'],
      fleet: ['Fleet', 'Connectivity, versions, pairing, and repair'],
      settings: ['Settings', 'This PC, notifications, overlay, and privacy']
    };
    return `<header class="fleet-header">
      <div><h1>${titles[this.view][0]}</h1><p>${titles[this.view][1]}</p></div>
      <div class="fleet-header-actions">
        <div class="header-quick-actions">
          <button class="quiet-button" data-action="dashboard-nav" data-view="schedules">${icon('calendar-clock')}Schedules</button>
          <button class="primary-button" data-action="dashboard-nav" data-view="launcher">${icon('plus')}New session</button>
        </div>
        <button class="fleet-icon-button notification-button" data-action="dashboard-attention" title="Notifications">${icon('bell')}${this.snapshot.attention.length ? `<span>${this.snapshot.attention.length}</span>` : ''}</button>
        <button class="fleet-icon-button" data-action="dashboard-close" title="Close dashboard">${icon('x')}</button>
      </div>
    </header>`;
  }

  private renderScenarioBanner(): string {
    if (this.scenario === 'live') return '';
    if (this.scenario === 'offline') return `<div class="scenario-banner scenario-offline">${icon('cloud-off')}<div><strong>Controller disconnected</strong><span>Showing verified cache from ${relativeTime(this.cacheSavedAt).toLowerCase()}. Mutations are unavailable until the WSL bridge reconnects.</span></div><button data-action="dashboard-refresh">Retry</button></div>`;
    if (this.scenario === 'error') return `<div class="scenario-banner scenario-error">${icon('circle-x')}<div><strong>Bridge protocol mismatch</strong><span>Hosts remain visible read-only. Update the controller runtime before making changes.</span></div><button data-action="dashboard-repair-host">Review repair</button></div>`;
    return `<div class="scenario-banner scenario-empty">${icon('circle-alert')}<div><strong>No fleet configured yet</strong><span>Local limits still work. Pair a controller or add the first host to start managing sessions.</span></div><button data-action="dashboard-pair">Pair device</button></div>`;
  }

  private renderCurrentView(): string {
    if (this.scenario === 'empty' && this.view !== 'settings') return this.renderEmptyState();
    if (this.view === 'sessions') return this.renderSessions();
    if (this.view === 'launcher') return this.renderLauncher();
    if (this.view === 'schedules') return this.renderSchedules();
    if (this.view === 'fleet') return this.renderFleet();
    if (this.view === 'settings') return this.renderSettings();
    return this.renderOverview();
  }

  private renderOverview(): string {
    const healthyHosts = this.snapshot.hosts.filter((host) => host.status === 'healthy').length;
    const pending = this.snapshot.schedules.filter((item) => item.status === 'pending').length;
    return `<div class="dashboard-stack">
      ${this.snapshot.attention.length ? `<section class="attention-center fleet-card">
        <div class="attention-heading"><div><h2>Needs attention</h2><span>${this.snapshot.attention.length}</span></div><button data-action="dashboard-attention">View all</button></div>
        <div class="attention-list">${this.snapshot.attention.slice(0, 2).map((item) => this.renderAttention(item)).join('')}</div>
      </section>` : ''}
      <section class="fleet-metrics">
        ${metric('network', 'Hosts online', `${healthyHosts} / ${this.snapshot.hosts.length}`, healthyHosts === this.snapshot.hosts.length ? 'All connected' : 'Some hosts are unavailable', healthyHosts === this.snapshot.hosts.length ? 'healthy' : 'offline')}
        ${metric('square-terminal', 'Sessions', String(this.snapshot.sessions.length), `${this.snapshot.sessions.filter((item) => item.activity === 'active').length} active`, 'healthy')}
        ${metric('calendar-clock', 'Scheduled', String(pending), pending ? 'Pending delivery' : 'Nothing pending', 'healthy')}
      </section>
      <section class="overview-grid">
        <article class="fleet-card recent-sessions-card">
          ${cardHeader('Recent sessions', 'Jump back into active work', 'All sessions', 'sessions')}
          <div class="session-list compact">${this.snapshot.sessions.slice(0, 3).map((session) => this.renderSessionRow(session, true)).join('')}</div>
        </article>
        <article class="fleet-card favorites-card">
          <div class="card-heading"><div><h2>Quick launch</h2><p>Your favorite presets</p></div>${icon('star')}</div>
          <div class="favorite-list">${this.snapshot.favorites.map((favorite) => `<button data-action="dashboard-favorite"><span class="tool-icon">${toolIcon(favorite.tool)}</span><span><strong>${escapeHtml(favorite.name)}</strong><small>${escapeHtml(favorite.hostId)} · ${escapeHtml(favorite.project)}</small></span>${icon('play')}</button>`).join('')}</div>
          <button class="favorite-new" data-action="dashboard-nav" data-view="launcher">${icon('plus')}New session</button>
        </article>
        <article class="fleet-card limit-card">
          <div class="card-heading"><div><h2>Usage limits</h2><p>Profiles on this PC</p></div><button class="quiet-button" data-action="dashboard-refresh">${icon('refresh-cw')}Refresh</button></div>
          <div class="dashboard-limits">${this.snapshot.limits.map((limit) => `<div><span><strong>${escapeHtml(limit.label)}</strong><small class="limit-${limit.status}">${limit.status}</small></span>${limitBar('5 hour', limit.fiveHourRemaining)}${limitBar('Weekly', limit.weeklyRemaining)}</div>`).join('')}</div>
        </article>
        <article class="fleet-card host-health-card">
          ${cardHeader('Hosts', 'Current fleet status', 'Manage', 'fleet')}
          <div class="host-list compact">${this.snapshot.hosts.map((host) => this.renderHostRow(host)).join('')}</div>
        </article>
      </section>
    </div>`;
  }

  private renderSessions(): string {
    const needle = this.search.trim().toLowerCase();
    const sessions = this.snapshot.sessions.filter((session) => !needle || [session.name, session.title, session.project, session.hostId, session.tool].some((value) => value.toLowerCase().includes(needle)));
    const grouped = this.snapshot.hosts.map((host) => ({ host, sessions: sessions.filter((session) => session.hostId === host.id) })).filter((group) => group.sessions.length);
    return `<div class="dashboard-stack">
      <div class="view-toolbar"><label class="fleet-search">${icon('search')}<input data-dashboard-search value="${escapeAttr(this.search)}" placeholder="Search session, project, host, or tool"></label><div class="filter-pills"><button class="active">All hosts</button>${this.snapshot.hosts.map((host) => `<button>${escapeHtml(host.name)}</button>`).join('')}</div><button class="primary-button" data-action="dashboard-nav" data-view="launcher">${icon('plus')}New session</button></div>
      ${grouped.length ? grouped.map(({ host, sessions: hostSessions }) => `<section class="fleet-card session-group"><div class="session-group-heading"><div><span class="status-dot status-${host.status}"></span><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.machine)}</small></div><span>${hostSessions.length} session${hostSessions.length === 1 ? '' : 's'}</span></div><div class="session-list">${hostSessions.map((session) => this.renderSessionRow(session, false)).join('')}</div></section>`).join('') : this.renderNoResults('No sessions match this search', 'Try another host, project, or tool name.')}
    </div>`;
  }

  private renderLauncher(): string {
    return `<div class="launcher-layout">
      <section class="fleet-card launcher-form">
        <div class="card-heading"><div><h2>Start a session</h2><p>Every target is explicit and validated before launch</p></div><span class="safe-badge">${icon('shield-check')}Safe argv</span></div>
        <div class="launcher-grid">
          ${selectField('Host', 'work-m', ['work-m · This PC', 'home-m · Laptop'])}
          ${selectField('Backend', 'WSL', ['WSL', 'Linux', 'Windows'])}
          ${selectField('Project', 'wtmux', ['wtmux', 'agent-fleet', 'Choose a folder…'])}
          ${selectField('Tool', 'Codex', ['Codex', 'Claude Code', 'GitHub Copilot', 'Shell'])}
          ${selectField('Codex profile', 'codex2', ['codex2', 'codex3', 'Default'])}
          <label>Session name<input value="fleet-dashboard" maxlength="64"><small>Preview: work-m · wtmux · fleet-dashboard</small></label>
        </div>
        <div class="launcher-summary"><span class="tool-icon">${icon('terminal')}</span><div><strong>Codex in wtmux</strong><p>work-m · WSL · /home/user/projects/wtmux · profile codex2</p></div><button class="primary-button" disabled title="Launcher mutations are coming in the next beta">${icon('rocket')}Coming next</button></div>
      </section>
      <aside class="dashboard-stack">
        <section class="fleet-card"><div class="card-heading"><div><h2>Favorites</h2><p>Synced launcher presets</p></div>${icon('star')}</div><div class="favorite-list">${this.snapshot.favorites.map((favorite) => `<button data-action="dashboard-favorite"><span class="tool-icon">${toolIcon(favorite.tool)}</span><span><strong>${escapeHtml(favorite.name)}</strong><small>${escapeHtml(favorite.hostId)} · ${escapeHtml(favorite.project)}</small></span>${icon('chevron-right')}</button>`).join('')}</div></section>
        <section class="fleet-card launch-safety"><h2>${icon('shield-check')}Launch safety</h2><p>Projects, tools, backends, and profile aliases come from validated registry data. Raw shell text is never evaluated.</p><a>${icon('external-link')}Run host doctor</a></section>
      </aside>
    </div>`;
  }

  private renderSchedules(): string {
    const schedules = this.snapshot.schedules.filter((schedule) => this.scheduleTab === 'pending' ? schedule.status === 'pending' : schedule.status !== 'pending');
    return `<div class="dashboard-stack">
      <div class="view-toolbar"><div class="segmented"><button class="${this.scheduleTab === 'pending' ? 'active' : ''}" data-action="schedule-tab" data-tab="pending">Pending <b>${this.snapshot.schedules.filter((item) => item.status === 'pending').length}</b></button><button class="${this.scheduleTab === 'history' ? 'active' : ''}" data-action="schedule-tab" data-tab="history">30-day history</button></div><span class="toolbar-spacer"></span><button class="primary-button" data-action="dashboard-new-schedule" ${this.scenario === 'live' ? '' : 'disabled'}>${icon('plus')}Schedule continue</button></div>
      <section class="fleet-card schedule-table"><div class="schedule-header"><span>Destination</span><span>Type</span><span>${this.scheduleTab === 'pending' ? 'Delivery' : 'Outcome'}</span><span>Status</span><span></span></div>${schedules.map((schedule) => this.renderScheduleRow(schedule)).join('')}</section>
      <p class="retention-note">${icon('history')}History is retained for 30 days. Times use your local zone; destination host zone is shown alongside.</p>
    </div>`;
  }

  private renderFleet(): string {
    return `<div class="dashboard-stack">
      ${this.snapshot.pairingRequests.map((request) => `<section class="pairing-request"><span class="pairing-icon">${icon('user-plus')}</span><div><strong>Pairing request from ${escapeHtml(request.deviceName)}</strong><p>${escapeHtml(request.platform)} · live peer ${escapeHtml(request.peer)} · expires ${formatTime(request.expiresAt)}</p></div><button data-action="dashboard-review-pairing">Review exact proposal</button></section>`).join('')}
      <section class="fleet-card fleet-host-grid">${this.snapshot.hosts.map((host) => this.renderHostCard(host)).join('')}</section>
      <section class="pairing-layout">
        <article class="fleet-card registry-card"><div class="card-heading"><div><h2>Fleet registry</h2><p>Provider: GitHub · verified cache available</p></div><span class="safe-badge">${icon('check')}Synced</span></div><dl><div><dt>Last sync</dt><dd>${relativeTime(this.snapshot.registrySyncedAt)}</dd></div><div><dt>Checkout</dt><dd>Clean</dd></div><div><dt>Schema</dt><dd>fleet/v1</dd></div><div><dt>Runtime bundle</dt><dd>1.4.0-dev</dd></div></dl><button class="quiet-button" data-action="dashboard-refresh">${icon('refresh-cw')}Check registry</button></article>
      </section>
    </div>`;
  }

  private renderSettings(): string {
    return `<div class="settings-dashboard-grid">
      <section class="fleet-card dashboard-settings-card"><div class="card-heading"><div><h2>This PC</h2><p>Local controller and terminal behavior</p></div>${icon('laptop')}</div><div class="dashboard-form-grid">${selectField('Controller WSL distribution', 'Ubuntu-24.04', ['Ubuntu-24.04', 'Ubuntu', 'Debian'])}${selectField('Open sessions in', 'Windows Terminal', ['Windows Terminal', 'Current VS Code window'])}<label class="toggle-row"><span><strong>Launch Agent Fleet on login</strong><small>Recommended for fleet notifications</small></span><input type="checkbox" checked></label><label class="toggle-row"><span><strong>Show limits overlay</strong><small>Transparent, click-through companion window</small></span><input type="checkbox" checked></label></div></section>
      <section class="fleet-card dashboard-settings-card"><div class="card-heading"><div><h2>Notifications</h2><p>All enabled Agent Fleet PCs may notify for the fleet</p></div>${icon('bell')}</div><div class="dashboard-form-grid"><label class="toggle-row"><span><strong>Hard limits and delivery failures</strong><small>Critical attention</small></span><input type="checkbox" checked></label><label class="toggle-row"><span><strong>Host offline and recovery</strong><small>After three missed heartbeats</small></span><input type="checkbox" checked></label><label class="toggle-row"><span><strong>Schedule delivery success</strong><small>Deduplicated across restarts</small></span><input type="checkbox" checked></label><label class="toggle-row"><span><strong>Version drift and pairing</strong><small>Actionable fleet changes</small></span><input type="checkbox" checked></label></div><button class="quiet-button" data-action="dashboard-pause">${icon('pause')}Pause on this PC for one hour</button></section>
      <section class="fleet-card dashboard-settings-card"><div class="card-heading"><div><h2>Tray appearance</h2><p>Worst unresolved fleet state controls severity</p></div>${icon('gauge')}</div><div class="tray-variants"><span><i class="status-healthy"></i>Healthy</span><span><i class="status-attention"></i>Attention</span><span><i class="status-failure"></i>Failure</span><span><i class="status-offline"></i>Disconnected</span></div></section>
      <section class="fleet-card dashboard-settings-card"><div class="card-heading"><div><h2>Privacy and diagnostics</h2><p>Metadata only, local and bounded</p></div>${icon('shield-check')}</div><p class="privacy-copy">Prompts, responses, transcripts, terminal screens, and credentials are never collected. Diagnostics are generated only when requested and can be previewed before sharing.</p><div class="inline-dashboard-actions"><button class="quiet-button">${icon('folder-open')}Preview diagnostics</button><button class="quiet-button">${icon('wrench')}Run doctor</button></div></section>
    </div>`;
  }

  private renderAttention(item: FleetAttention): string {
    return `<button class="attention-item attention-${item.severity}" data-action="dashboard-attention" data-attention-id="${escapeAttr(item.id)}"><span>${severityIcon(item.severity)}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></span><b>${escapeHtml(item.targetSessionId ? 'Schedule continue' : item.actionLabel)}${icon('chevron-right')}</b></button>`;
  }

  private renderSessionRow(session: FleetSession, compact: boolean): string {
    const host = this.snapshot.hosts.find((item) => item.id === session.hostId);
    return `<div class="session-row ${compact ? 'is-compact' : ''}" data-session-id="${escapeAttr(session.id)}">
      <span class="tool-icon tool-${session.tool}">${toolIcon(session.tool)}</span>
      <span class="session-primary"><strong>${escapeHtml(session.name)}</strong><small>${escapeHtml(session.title || 'Managed tmux session')}</small></span>
      <span class="session-context"><strong>${escapeHtml(session.project)}</strong><small>${escapeHtml(host?.name ?? session.hostId)} · ${escapeHtml(session.backend)}${session.profileAlias ? ` · ${escapeHtml(session.profileAlias)}` : ''}</small></span>
      <span class="activity-label activity-${session.activity}"><i></i>${capitalize(session.activity)}</span>
      <span class="session-time">${relativeTime(session.updatedAt)}${session.attached ? '<small>Attached</small>' : ''}</span>
      <span class="session-actions"><button data-action="dashboard-open-session" title="Open in Windows Terminal">${icon('panel-top-open')}<span>Open</span></button>${compact ? '' : `<button class="danger-quiet" data-action="dashboard-kill-session" title="Kill session">${icon('trash-2')}</button>`}</span>
    </div>`;
  }

  private renderHostRow(host: FleetHost): string {
    return `<div class="host-row"><span class="host-platform">${host.platform === 'termux' ? icon('monitor') : icon('server')}</span><span><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.detail)}</small></span><span class="host-status status-text-${host.status}"><i class="status-dot status-${host.status}"></i>${capitalize(host.status)}</span></div>`;
  }

  private renderHostCard(host: FleetHost): string {
    return `<article class="host-card" data-host-id="${escapeAttr(host.id)}"><div class="host-card-top"><span class="host-platform">${host.platform === 'termux' ? icon('monitor') : icon('server')}</span><div><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.machine)}</small></div><span class="host-status status-text-${host.status}"><i class="status-dot status-${host.status}"></i>${capitalize(host.status)}</span></div><p>${escapeHtml(host.detail)}</p><dl><div><dt>Sessions</dt><dd>${host.sessionCount}</dd></div><div><dt>wtmux</dt><dd>${escapeHtml(host.wtmuxVersion)}</dd></div><div><dt>Last seen</dt><dd>${relativeTime(host.lastSeenAt)}</dd></div><div><dt>Protocol</dt><dd>v${host.protocolVersion}</dd></div></dl><div class="host-card-actions"><button class="quiet-button">${icon('heart-pulse')}Doctor</button>${host.status === 'attention' ? `<button class="primary-button" data-action="dashboard-repair-host">${icon('wrench')}Review update</button>` : `<button class="quiet-button">${icon('more-horizontal')}More</button>`}</div></article>`;
  }

  private renderScheduleRow(schedule: FleetSchedule): string {
    const session = this.snapshot.sessions.find((item) => item.id === schedule.sessionId);
    return `<div class="schedule-row" data-schedule-id="${escapeAttr(schedule.id)}"><span><strong>${escapeHtml(session?.name ?? 'Ended session')}</strong><small>${escapeHtml(schedule.hostId)} · ${escapeHtml(session?.project ?? 'unknown')}</small></span><span><q>${escapeHtml(schedule.summary)}</q><small>Created ${relativeTime(schedule.createdAt)}</small></span><span><strong>${formatDateTime(schedule.completedAt ?? schedule.deliverAt)}</strong><small>${escapeHtml(schedule.hostTimeZone)}</small></span><span><b class="schedule-status schedule-${schedule.status}">${scheduleStatusIcon(schedule.status)}${capitalize(schedule.status)}</b>${schedule.detail ? `<small>${escapeHtml(schedule.detail)}</small>` : ''}</span><span class="schedule-actions">${schedule.status === 'pending' ? `<button class="danger-quiet" data-action="dashboard-cancel-schedule">Cancel</button>` : ''}</span></div>`;
  }

  private renderEmptyState(): string {
    return `<section class="fleet-empty-state"><span>${icon('network')}</span><h2>Your fleet starts here</h2><p>Pair an existing controller, or bootstrap the first controller once. New devices receive a verified runtime and registry without a private clone or GitHub credentials.</p><div><button class="primary-button" data-action="dashboard-pair">${icon('qr-code')}Pair a device</button><button class="quiet-button">${icon('wrench')}Bootstrap first controller</button></div></section>`;
  }

  private renderNoResults(title: string, detail: string): string {
    return `<section class="fleet-empty-state compact-empty"><span>${icon('search')}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></section>`;
  }

  private confirmKill(session: FleetSession): void {
    const pending = session.pendingScheduleCount;
    this.modal = {
      title: `Kill ${session.name} on ${session.hostId}?`,
      body: `${session.project} · ${session.title} · ${capitalize(session.activity)}. ${pending ? `${pending} pending schedule will be cancelled atomically before the session is killed.` : 'No pending schedules are attached.'}`,
      confirm: 'Kill session',
      destructive: true,
      action: { kind: 'kill-session', id: session.id }
    };
    this.render();
  }

  private confirmCancelSchedule(schedule: FleetSchedule): void {
    const session = this.snapshot.sessions.find((item) => item.id === schedule.sessionId);
    this.modal = {
      title: 'Cancel scheduled message?',
      body: `${session?.hostId ?? schedule.hostId} · ${session?.project ?? 'unknown'} · ${session?.name ?? 'ended session'} · delivery ${formatDateTime(schedule.deliverAt)}. The message contents are not shown outside the local schedule editor.`,
      confirm: 'Cancel schedule',
      destructive: true,
      action: { kind: 'cancel-schedule', id: schedule.id }
    };
    this.render();
  }

  private confirmRepair(host: FleetHost): void {
    this.modal = {
      title: `Update runtime on ${host.name}?`,
      body: `${host.machine}. Installed ${host.wtmuxVersion}; controller offers 1.4.0-dev. The checksummed runtime activates atomically and rolls back if its self-check fails.`,
      confirm: 'Update and verify'
    };
    this.render();
  }

  private renderModal(modal: NonNullable<ModalState>): string {
    const scheduleForm = modal.action?.kind === 'create-schedule'
      ? `<div class="dashboard-form-grid"><label>Session<select data-modal-session>${this.snapshot.sessions.map((session) => `<option value="${escapeAttr(session.id)}" ${session.id === modal.action?.id ? 'selected' : ''}>${escapeHtml(session.name)} · ${escapeHtml(session.hostId)}</option>`).join('')}</select></label><label>Deliver at<input data-modal-deliver-at type="datetime-local" value="${defaultScheduleTime(modal.deliverAt)}"></label></div>`
      : '';
    return `<div class="fleet-modal-backdrop"><section class="fleet-modal" role="dialog" aria-modal="true" aria-labelledby="fleet-modal-title"><span class="modal-symbol ${modal.destructive ? 'danger' : ''}">${modal.destructive ? icon('circle-alert') : icon('calendar-clock')}</span><h2 id="fleet-modal-title">${escapeHtml(modal.title)}</h2><p>${escapeHtml(modal.body)}</p>${scheduleForm}<div><button class="quiet-button" data-action="modal-cancel">Keep current state</button><button class="${modal.destructive ? 'danger-button' : 'primary-button'}" data-action="modal-confirm">${escapeHtml(modal.confirm)}</button></div></section></div>`;
  }

  private sessionFromControl(control: HTMLElement): FleetSession | undefined {
    const id = control.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId;
    return this.snapshot.sessions.find((item) => item.id === id);
  }

  private scheduleFromControl(control: HTMLElement): FleetSchedule | undefined {
    const id = control.closest<HTMLElement>('[data-schedule-id]')?.dataset.scheduleId;
    return this.snapshot.schedules.find((item) => item.id === id);
  }

  private hostFromControl(control: HTMLElement): FleetHost | undefined {
    const id = control.closest<HTMLElement>('[data-host-id]')?.dataset.hostId ?? 'home-m';
    return this.snapshot.hosts.find((item) => item.id === id);
  }
}

function metric(iconName: string, label: string, value: string, detail: string, severity: FleetSeverity): string {
  return `<article class="metric-card"><span class="metric-icon status-${severity}">${icon(iconName)}</span><div><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong><p>${escapeHtml(detail)}</p></div></article>`;
}

function cardHeader(title: string, detail: string, actionLabel: string, view: DashboardView): string {
  return `<div class="card-heading"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></div><button class="quiet-link" data-action="dashboard-nav" data-view="${view}">${escapeHtml(actionLabel)}${icon('chevron-right')}</button></div>`;
}

function limitBar(label: string, remaining: number | null): string {
  const safe = remaining === null ? 0 : Math.max(0, Math.min(100, remaining));
  return `<div class="dashboard-limit-row"><small>${escapeHtml(label)}</small><div><i style="width:${safe}%"></i></div><strong>${remaining === null ? '—' : `${safe}%`}</strong></div>`;
}

function selectField(label: string, selected: string, options: readonly string[]): string {
  return `<label>${escapeHtml(label)}<select>${options.map((option) => `<option ${option === selected ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
}

function toolIcon(tool: FleetTool): string {
  if (tool === 'codex') return icon('terminal');
  if (tool === 'claude') return icon('message-square-text');
  if (tool === 'copilot') return icon('command');
  return icon('square-terminal');
}

function severityIcon(severity: FleetAttention['severity']): string {
  if (severity === 'failure') return icon('circle-x');
  if (severity === 'offline') return icon('cloud-off');
  return icon('circle-alert');
}

function eventIcon(kind: string): string {
  if (kind === 'schedule') return icon('calendar-clock');
  if (kind === 'host') return icon('server');
  if (kind === 'limit') return icon('gauge');
  if (kind === 'pairing') return icon('user-plus');
  return icon('terminal');
}

function scheduleStatusIcon(status: FleetSchedule['status']): string {
  if (status === 'delivered') return icon('circle-check');
  if (status === 'pending') return icon('clock');
  if (status === 'failed') return icon('circle-x');
  return icon('circle-alert');
}

function relativeTime(value: string | null): string {
  if (!value) return 'Never';
  const reference = Date.now();
  const difference = Math.max(0, reference - new Date(value).getTime());
  const minutes = Math.floor(difference / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function defaultScheduleTime(suggestedAt?: string): string {
  const suggested = suggestedAt ? new Date(suggestedAt) : null;
  const date = suggested && Number.isFinite(suggested.getTime()) && suggested.getTime() > Date.now()
    ? suggested
    : new Date(Date.now() + 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('-', ' ');
}

function icon(name: string): string {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function isDashboardView(value: string | undefined): value is DashboardView {
  return value === 'overview' || value === 'sessions' || value === 'launcher' || value === 'schedules' || value === 'fleet' || value === 'settings';
}

function isScenario(value: string): value is DashboardScenario {
  return value === 'live' || value === 'offline' || value === 'empty' || value === 'error';
}
