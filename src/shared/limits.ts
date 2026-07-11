export type ProviderKind = 'codex' | 'claude';
export type CodexProfileId = string;
export type ProviderId = string;
export type LimitWindowId = 'fiveHour' | 'weekly';
export type ProviderStatus = 'loading' | 'ok' | 'stale' | 'unavailable' | 'error';
export type CodexSortMode = 'profileOrder' | 'highestAverageUse';

export const DEFAULT_CODEX_PROFILE_IDS: readonly CodexProfileId[] = ['codex1', 'codex2', 'codex3', 'codex4'];

export interface LimitWindowSnapshot {
  id: LimitWindowId;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: number | null;
  durationMinutes: number | null;
}

export interface ProviderLimitSnapshot {
  id: ProviderId;
  provider: ProviderKind;
  label: string;
  status: ProviderStatus;
  source: string;
  fetchedAt: number | null;
  message?: string;
  windows: Partial<Record<LimitWindowId, LimitWindowSnapshot>>;
}

export interface DiagnosticItem {
  id: ProviderId;
  label: string;
  status: ProviderStatus;
  detail: string;
}

export interface CombinedLimitState {
  updatedAt: number;
  refreshing: boolean;
  providers: ProviderLimitSnapshot[];
  diagnostics: DiagnosticItem[];
}

export const STALE_AFTER_MS = 15 * 60 * 1000;
export const CODEX_REFRESH_MS = 5 * 60 * 1000;
export const CLAUDE_REFRESH_MS = 60 * 1000;
export const WARNING_USED_PERCENT = 70;
export const CRITICAL_USED_PERCENT = 90;

export function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function createLimitWindow(
  id: LimitWindowId,
  usedPercent: number | null,
  resetsAt: number | null,
  durationMinutes: number | null
): LimitWindowSnapshot {
  const used = typeof usedPercent === 'number' ? clampPercent(usedPercent) : null;
  return {
    id,
    label: id === 'fiveHour' ? '5h' : 'Weekly',
    usedPercent: used,
    remainingPercent: used === null ? null : clampPercent(100 - used),
    resetsAt,
    durationMinutes
  };
}

export function emptyProvider(
  id: ProviderId,
  provider: ProviderKind,
  label: string,
  message = 'Waiting for data'
): ProviderLimitSnapshot {
  return {
    id,
    provider,
    label,
    status: 'loading',
    source: 'none',
    fetchedAt: null,
    message,
    windows: {}
  };
}

export function withFreshness(snapshot: ProviderLimitSnapshot, nowMs = Date.now()): ProviderLimitSnapshot {
  if (snapshot.status !== 'ok' || snapshot.fetchedAt === null) return snapshot;
  const ageMs = nowMs - snapshot.fetchedAt * 1000;
  if (ageMs <= STALE_AFTER_MS) return snapshot;
  return {
    ...snapshot,
    status: 'stale',
    message: `Last update was ${Math.round(ageMs / 60000)} minutes ago`
  };
}

export function sortProviderSnapshots(
  providers: readonly ProviderLimitSnapshot[],
  codexOrder: readonly CodexProfileId[] = DEFAULT_CODEX_PROFILE_IDS,
  codexSortMode: CodexSortMode = 'highestAverageUse'
): ProviderLimitSnapshot[] {
  const codexOrderIndex = new Map(codexOrder.map((id, index) => [id, index]));
  const codex = providers
    .filter((provider) => provider.provider === 'codex')
    .sort((left, right) => compareCodexProviders(left, right, codexOrderIndex, codexSortMode));
  const claude = providers.filter((provider) => provider.provider === 'claude');
  return [...codex, ...claude];
}

function compareCodexProviders(
  left: ProviderLimitSnapshot,
  right: ProviderLimitSnapshot,
  codexOrderIndex: ReadonlyMap<CodexProfileId, number>,
  codexSortMode: CodexSortMode
): number {
  if (codexSortMode === 'profileOrder') {
    return getOrderIndex(left.id, codexOrderIndex) - getOrderIndex(right.id, codexOrderIndex);
  }

  const leftGroup = getCodexSortGroup(left);
  const rightGroup = getCodexSortGroup(right);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;

  if (leftGroup === 0) {
    const leftAverageUsed = getAverageUsed(left);
    const rightAverageUsed = getAverageUsed(right);
    if (leftAverageUsed !== rightAverageUsed) return leftAverageUsed > rightAverageUsed ? -1 : 1;
  }

  if (leftGroup === 1) {
    const leftReset = getSoonestReset(left);
    const rightReset = getSoonestReset(right);
    if (leftReset !== rightReset) return leftReset < rightReset ? -1 : 1;
  }

  return getOrderIndex(left.id, codexOrderIndex) - getOrderIndex(right.id, codexOrderIndex);
}

function getCodexSortGroup(snapshot: ProviderLimitSnapshot): number {
  const remaining = Object.values(snapshot.windows)
    .map((window) => window?.remainingPercent)
    .filter((value): value is number => typeof value === 'number');
  if (remaining.length === 0) return 2;
  return remaining.some((value) => value === 0) ? 1 : 0;
}

function getAverageUsed(snapshot: ProviderLimitSnapshot): number {
  const used = Object.values(snapshot.windows)
    .map((window) => window?.usedPercent)
    .filter((value): value is number => typeof value === 'number');
  return used.length > 0 ? used.reduce((total, value) => total + value, 0) / used.length : Number.NEGATIVE_INFINITY;
}

function getSoonestReset(snapshot: ProviderLimitSnapshot): number {
  const resets = Object.values(snapshot.windows)
    .map((window) => window?.resetsAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return resets.length > 0 ? Math.min(...resets) : Number.POSITIVE_INFINITY;
}

function getOrderIndex(id: ProviderId, codexOrderIndex: ReadonlyMap<CodexProfileId, number>): number {
  return codexOrderIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
}
