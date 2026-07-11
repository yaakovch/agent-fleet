import { describe, expect, it } from 'vitest';
import { LimitStateManager, mergeCodexResult } from '../src/main/state-manager';
import type { WslCodexProfile } from '../src/main/collectors/codex';
import { createLimitWindow, emptyProvider, sortProviderSnapshots, type ProviderLimitSnapshot } from '../src/shared/limits';
import { createDefaultSettings } from '../src/shared/settings';

describe('multi-profile state manager', () => {
  it('refreshes sequentially, continues after failure, keeps configured profile order, and pins Claude last', async () => {
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
    expect(state.providers.map((provider) => provider.id)).toEqual(['codex1', 'codex2', 'codex3', 'codex4', 'claude']);
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

  it('can explicitly sort Codex profiles by lowest remaining limits', () => {
    const sorted = sortProviderSnapshots(
      [
        makeCodexSnapshot('codex1', 100, 5000),
        makeCodexSnapshot('codex2', 40, 5000),
        makeCodexSnapshot('codex3', 100, 2000),
        makeCodexSnapshot('codex4', 10, 5000),
        {
          ...emptyProvider('claude', 'claude', 'Claude Code'),
          status: 'ok',
          fetchedAt: 100,
          windows: { fiveHour: createLimitWindow('fiveHour', 10, null, 300) }
        }
      ],
      ['codex1', 'codex2', 'codex3', 'codex4'],
      'lowestRemaining'
    );

    expect(sorted.map((provider) => provider.id)).toEqual(['codex2', 'codex4', 'codex3', 'codex1', 'claude']);
  });

  it('sorts Codex profiles by configured order by default', () => {
    const sorted = sortProviderSnapshots(
      [
        makeCodexSnapshot('codex1', 100, 5000),
        makeCodexSnapshot('codex2', 40, 5000),
        makeCodexSnapshot('codex3', 100, 2000),
        makeCodexSnapshot('codex4', 10, 5000)
      ],
      ['codex3', 'codex1', 'codex4', 'codex2']
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
  return {
    id,
    provider: 'codex',
    label: id,
    status: 'ok',
    source: 'test',
    fetchedAt: Math.floor(Date.now() / 1000),
    windows: {
      fiveHour: createLimitWindow('fiveHour', usedPercent, resetAt, 300),
      weekly: createLimitWindow('weekly', usedPercent / 2, resetAt, 10080)
    }
  };
}
