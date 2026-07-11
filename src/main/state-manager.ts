import { EventEmitter } from 'node:events';
import { loadCodexCache, saveCodexCache, type CachedProfile } from './codex-cache';
import { collectClaudeLimits } from './collectors/claude';
import {
  collectCodexProfileLimits,
  type WslCodexProfile
} from './collectors/codex';
import {
  CLAUDE_REFRESH_MS,
  CODEX_REFRESH_MS,
  emptyProvider,
  sortProviderSnapshots,
  type CodexProfileId,
  type CodexSortMode,
  type CombinedLimitState,
  type DiagnosticItem,
  type ProviderLimitSnapshot,
  withFreshness
} from '../shared/limits';
import { createDefaultSettings, type WidgetSettings } from '../shared/settings';

interface StateManagerDependencies {
  settings?: WidgetSettings;
  settingsDiagnostic?: string;
  profiles?: readonly WslCodexProfile[];
  claudeEnabled?: boolean;
  collectCodexProfile?: (profile: WslCodexProfile) => Promise<ProviderLimitSnapshot>;
  collectClaude?: () => ProviderLimitSnapshot;
  loadCache?: () => Partial<Record<CodexProfileId, CachedProfile>>;
  saveCache?: (snapshots: readonly ProviderLimitSnapshot[]) => void;
}

export class LimitStateManager extends EventEmitter {
  private profiles: readonly WslCodexProfile[];
  private codexSortMode: CodexSortMode;
  private claudeEnabled: boolean;
  private settingsDiagnostic: string | undefined;
  private readonly collectCodexProfile: (profile: WslCodexProfile) => Promise<ProviderLimitSnapshot>;
  private readonly collectClaude: () => ProviderLimitSnapshot;
  private readonly loadCache: () => Partial<Record<CodexProfileId, CachedProfile>>;
  private readonly saveCache: (snapshots: readonly ProviderLimitSnapshot[]) => void;
  private codexProviders: Partial<Record<CodexProfileId, ProviderLimitSnapshot>> = {};
  private claudeProvider: ProviderLimitSnapshot;
  private refreshing = false;
  private codexRefreshPromise: Promise<void> | null = null;
  private codexTimer: NodeJS.Timeout | null = null;
  private claudeTimer: NodeJS.Timeout | null = null;

  constructor(dependencies: StateManagerDependencies = {}) {
    super();
    const settings = dependencies.settings ?? createDefaultSettings();
    this.profiles = dependencies.profiles ?? codexProfilesFromSettings(settings);
    this.codexSortMode = settings.codexSortMode;
    this.claudeEnabled = dependencies.claudeEnabled ?? settings.claudeEnabled;
    this.settingsDiagnostic = dependencies.settingsDiagnostic;
    this.collectCodexProfile = dependencies.collectCodexProfile ?? collectCodexProfileLimits;
    this.collectClaude = dependencies.collectClaude ?? collectClaudeLimits;
    this.loadCache = dependencies.loadCache ?? loadCodexCache;
    this.saveCache = dependencies.saveCache ?? saveCodexCache;
    const cachedProfiles = this.loadCache();

    this.codexProviders = initializeCodexProviders(this.profiles, cachedProfiles);
    this.claudeProvider = emptyProvider('claude', 'claude', 'Claude Code', 'Claude status-line cache has not been read yet');
  }

  start(): void {
    void this.refreshAll();
    this.codexTimer = setInterval(() => void this.refreshCodex(), CODEX_REFRESH_MS);
    this.claudeTimer = setInterval(() => {
      this.refreshClaude();
      this.emitChanged();
    }, CLAUDE_REFRESH_MS);
  }

  stop(): void {
    if (this.codexTimer) clearInterval(this.codexTimer);
    if (this.claudeTimer) clearInterval(this.claudeTimer);
    this.codexTimer = null;
    this.claudeTimer = null;
  }

  getState(): CombinedLimitState {
    const providers = sortProviderSnapshots([
      ...this.profiles.map((profile) => withFreshness(this.codexProviders[profile.id]!)),
      ...(this.claudeEnabled ? [withFreshness(this.claudeProvider)] : [])
    ], this.profiles.map((profile) => profile.id), this.codexSortMode);
    return {
      updatedAt: Math.floor(Date.now() / 1000),
      refreshing: this.refreshing,
      providers,
      diagnostics: this.createDiagnostics(providers)
    };
  }

  async refreshAll(): Promise<CombinedLimitState> {
    if (this.claudeEnabled) this.refreshClaude();
    await this.refreshCodex();
    return this.getState();
  }

  async refreshCodex(): Promise<void> {
    if (this.codexRefreshPromise) return this.codexRefreshPromise;
    this.refreshing = true;
    this.emitChanged();
    this.codexRefreshPromise = this.performCodexRefresh();
    try {
      await this.codexRefreshPromise;
    } finally {
      this.codexRefreshPromise = null;
      this.refreshing = false;
      this.emitChanged();
    }
  }

  refreshClaude(): void {
    if (!this.claudeEnabled) return;
    this.claudeProvider = this.collectClaude();
  }

  applySettings(settings: WidgetSettings, settingsDiagnostic?: string): void {
    this.profiles = codexProfilesFromSettings(settings);
    this.codexSortMode = settings.codexSortMode;
    this.claudeEnabled = settings.claudeEnabled;
    this.settingsDiagnostic = settingsDiagnostic;
    this.codexProviders = initializeCodexProviders(this.profiles, this.loadCache(), this.codexProviders);
    if (!this.claudeEnabled) {
      this.claudeProvider = emptyProvider('claude', 'claude', 'Claude Code', 'Claude collector is disabled');
    }
    this.emitChanged();
  }

  private async performCodexRefresh(): Promise<void> {
    const nextProviders: Partial<Record<CodexProfileId, ProviderLimitSnapshot>> = {};
    for (const profile of this.profiles) {
      let result: ProviderLimitSnapshot;
      try {
        result = await this.collectCodexProfile(profile);
      } catch (error) {
        result = {
          id: profile.id,
          provider: 'codex',
          label: profile.label,
          status: 'error',
          source: 'WSL Codex app-server',
          fetchedAt: null,
          message: error instanceof Error ? error.message : String(error),
          windows: {}
        };
      }
      nextProviders[profile.id] = mergeCodexResult(result, this.codexProviders[profile.id]);
    }

    this.codexProviders = nextProviders;
    try {
      this.saveCache(this.profiles.map((profile) => nextProviders[profile.id]!));
    } catch (error) {
      console.error('Could not save Codex profile cache:', error);
    }
  }

  private emitChanged(): void {
    this.emit('changed', this.getState());
  }

  private createDiagnostics(providers: readonly ProviderLimitSnapshot[]): DiagnosticItem[] {
    const diagnostics = providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      status: provider.status,
      detail: provider.message ?? `Updated from ${provider.source}`
    }));
    if (this.settingsDiagnostic) {
      diagnostics.unshift({
        id: 'settings',
        label: 'Settings',
        status: 'error',
        detail: this.settingsDiagnostic
      });
    }
    return diagnostics;
  }
}

export function mergeCodexResult(
  result: ProviderLimitSnapshot,
  previous: ProviderLimitSnapshot | undefined
): ProviderLimitSnapshot {
  if (result.status === 'ok' || !previous || previous.fetchedAt === null || Object.keys(previous.windows).length === 0) {
    return result;
  }
  return {
    ...result,
    fetchedAt: previous.fetchedAt,
    windows: previous.windows
  };
}

function snapshotFromCache(profile: WslCodexProfile, cached: CachedProfile): ProviderLimitSnapshot {
  return {
    id: profile.id,
    provider: 'codex',
    label: profile.label,
    status: 'ok',
    source: 'Codex latest cache',
    fetchedAt: cached.fetchedAt,
    windows: cached.windows
  };
}

function initializeCodexProviders(
  profiles: readonly WslCodexProfile[],
  cachedProfiles: Partial<Record<CodexProfileId, CachedProfile>>,
  previousProviders: Partial<Record<CodexProfileId, ProviderLimitSnapshot>> = {}
): Partial<Record<CodexProfileId, ProviderLimitSnapshot>> {
  const providers: Partial<Record<CodexProfileId, ProviderLimitSnapshot>> = {};
  for (const profile of profiles) {
    const previous = previousProviders[profile.id];
    if (previous) {
      providers[profile.id] = { ...previous, label: profile.label };
      continue;
    }

    const cached = cachedProfiles[profile.id];
    providers[profile.id] = cached
      ? snapshotFromCache(profile, cached)
      : emptyProvider(profile.id, 'codex', profile.label, 'WSL Codex collector has not run yet');
  }
  return providers;
}

export function codexProfilesFromSettings(settings: WidgetSettings): WslCodexProfile[] {
  return settings.codexProfiles
    .filter((profile) => profile.enabled)
    .sort((left, right) => left.order - right.order)
    .map((profile) => ({
      id: profile.id,
      label: profile.label,
      distro: profile.distro,
      user: profile.user,
      home: profile.home,
      codexHome: profile.codexHome,
      executable: profile.executable
    }));
}
