import { describe, expect, it } from 'vitest';
import { LimitStateManager, mergeCodexResult } from '../src/main/state-manager';
import type { WslCodexProfile } from '../src/main/collectors/codex';
import { createLimitWindow, emptyProvider, sortProviderSnapshots, type ProviderLimitSnapshot } from '../src/shared/limits';
import { createDefaultSettings } from '../src/shared/settings';

describe('multi-profile state manager', () => {
  it('refreshes sequentially, continues after failure, sorts by average remaining, and pins Claude last', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const usedById = { codex1: 10, codex3: 60, codex4: 30 } as const;
    const manager = new LimitStateManager({
      profiles: TEST_PROFILES,
      claudeEnabled: true,
      collectCodexProfile: async (profile) => {
        order.push(profile.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (profile.id === 'codex2') throw new Error('token invalidated');
        return makeCodexSnapshot(profile.id, usedById[profile.id as keyof typeof usedById]);
      },
      collectClaude: () => ({
        ...emptyProvider('claude', 'claude', 'Claude Code'),
        status: 'ok',
        fetchedAt: 100,
        windows: { fiveHour: createLimitWindow('fiveHour', 99, null, 300) }
      }),
      loadCache: () => ({}),
      saveCache: () => undefined
    });

    await manager.refreshAll();
    const state = manager.getState();

    expect(order).toEqual(TEST_PROFILES.map((profile) => profile.id));
    expect(maxActive).toBe(1);
    expect(state.providers.map((provider) => provider.id)).toEqual(['codex1', 'codex4', 'codex3', 'codex2', 'claude']);
    expect(state.providers.find((provider) => provider.id === 'codex2')?.status).toBe('error');
  });

  it('retains last-good windows when a later refresh fails', () => {
    const previous = makeCodexSnapshot('codex1', 20);
    const failed: ProviderLimitSnapshot = {
      id: 'codex1',
      provider: 'codex',
      label: 'codex1',
      status: 'error',
      source: 'test',
      fetchedAt: null,
      message: 'offline',
      windows: {}
    };

    const merged = mergeCodexResult(failed, previous);
    expect(merged.status).toBe('error');
    expect(merged.windows.fiveHour?.remainingPercent).toBe(80);
    expect(merged.fetchedAt).toBe(previous.fetchedAt);
  });

  it('applies settings-backed profiles and can hide Claude', () => {
    const settings = createDefaultSettings();
    settings.codexProfiles = [
      {
        id: 'custom-profile',
        label: 'Custom Profile',
        enabled: true,
        order: 0,
        distro: 'Ubuntu',
        user: 'testuser',
        home: '/home/testuser',
        codexHome: '/home/testuser/.codex-custom',
        executable: '/home/testuser/.local/bin/codex'
      }
    ];
    settings.claudeEnabled = false;
    const manager = new LimitStateManager({
      settings,
      loadCache: () => ({}),
      saveCache: () => undefined
    });

    const state = manager.getState();
    expect(state.providers.map((provider) => provider.id)).toEqual(['custom-profile']);
    expect(state.providers[0].label).toBe('Custom Profile');
  });

  it('sorts Codex profiles by highest average remaining and sends exhausted profiles below usable profiles', () => {
    const sorted = sortProviderSnapshots(
      [
        makeCodexSnapshotWithUsage('codex1', 80, 0, 5000),
        makeCodexSnapshotWithUsage('codex2', 45, 45, 5000),
        makeCodexSnapshotWithUsage('codex3', 100, 10, 2000),
        makeCodexSnapshotWithUsage('codex4', 30, 10, 5000),
        {
          ...emptyProvider('claude', 'claude', 'Claude Code'),
          status: 'ok',
          fetchedAt: 100,
          windows: { fiveHour: createLimitWindow('fiveHour', 10, null, 300) }
        }
      ],
      ['codex1', 'codex2', 'codex3', 'codex4']
    );

    expect(sorted.map((provider) => provider.id)).toEqual(['codex4', 'codex1', 'codex2', 'codex3', 'claude']);
  });

  it('can explicitly sort Codex profiles by configured order', () => {
    const sorted = sortProviderSnapshots(
      [
        makeCodexSnapshot('codex1', 100, 5000),
        makeCodexSnapshot('codex2', 40, 5000),
        makeCodexSnapshot('codex3', 100, 2000),
        makeCodexSnapshot('codex4', 10, 5000)
      ],
      ['codex3', 'codex1', 'codex4', 'codex2'],
      'profileOrder'
    );

    expect(sorted.map((provider) => provider.id)).toEqual(['codex3', 'codex1', 'codex4', 'codex2']);
  });
});

const TEST_PROFILES: readonly WslCodexProfile[] = [1, 2, 3, 4].map((number) => ({
  id: `codex${number}`,
  label: `codex${number}`,
  distro: 'Ubuntu',
  user: 'testuser',
  home: '/home/testuser',
  codexHome: `/home/testuser/.codex-${number}`,
  executable: '/home/testuser/.local/bin/codex'
}));

function makeCodexSnapshot(id: string, usedPercent: number, resetAt: number | null = null): ProviderLimitSnapshot {
  return makeCodexSnapshotWithUsage(id, usedPercent, usedPercent / 2, resetAt);
}

function makeCodexSnapshotWithUsage(
  id: string,
  fiveHourUsedPercent: number,
  weeklyUsedPercent: number,
  resetAt: number | null = null
): ProviderLimitSnapshot {
  return {
    id,
    provider: 'codex',
    label: id,
    status: 'ok',
    source: 'test',
    fetchedAt: Math.floor(Date.now() / 1000),
    windows: {
      fiveHour: createLimitWindow('fiveHour', fiveHourUsedPercent, resetAt, 300),
      weekly: createLimitWindow('weekly', weeklyUsedPercent, resetAt, 10080)
    }
  };
}
