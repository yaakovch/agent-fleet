import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../src/shared/ipc';
import { RendererAccessPolicy, allowedRendererRoles } from '../src/main/renderer-access-policy';

describe('renderer content access policy', () => {
  it('classifies sensitive invocations by the exact app-window roles that use them', () => {
    expect(allowedRendererRoles('fleet:killSession')).toEqual(['dashboard']);
    expect(allowedRendererRoles('terminal:input')).toEqual(['dashboard']);
    expect(allowedRendererRoles('conversation:stageBytes')).toEqual(['dashboard']);
    expect(allowedRendererRoles(IPC_CHANNELS.conversationCopyText)).toEqual(['dashboard', 'settings']);
    expect(allowedRendererRoles(IPC_CHANNELS.getState)).toEqual(['widget']);
    expect(allowedRendererRoles(IPC_CHANNELS.saveSettings)).toEqual(['dashboard', 'settings']);
    expect(allowedRendererRoles(IPC_CHANNELS.repairRuntime)).toEqual(['settings']);
    expect(allowedRendererRoles('unknown:mutation')).toEqual([]);
  });

  it('fails closed while classifying every registered invocation', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const names = [...source.matchAll(/handle\(IPC_CHANNELS\.([A-Za-z0-9_]+)/gu)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) {
      const channel = IPC_CHANNELS[name as keyof typeof IPC_CHANNELS];
      expect(channel, `unknown IPC channel ${name}`).toBeTypeOf('string');
      expect(allowedRendererRoles(channel), `${channel} has no renderer role`).not.toEqual([]);
    }
  });

  it('allows only the registered dashboard and only for exact bound tabs', () => {
    const policy = new RendererAccessPolicy();
    policy.register(1, 'widget');
    policy.register(2, 'dashboard');
    policy.register(3, 'settings');
    policy.setBindings(2, 'terminal', ['tab-a']);
    policy.setBindings(2, 'conversation', ['tab-b']);

    expect(policy.canAccess(2, 'terminal', 'tab-a')).toBe(true);
    expect(policy.canAccess(2, 'terminal', 'tab-b')).toBe(false);
    expect(policy.canAccess(2, 'conversation', 'tab-b')).toBe(true);
    expect(policy.canAccess(1, 'terminal', 'tab-a')).toBe(false);
    expect(policy.canAccess(3, 'conversation', 'tab-b')).toBe(false);
    expect(() => policy.setBindings(3, 'terminal', ['tab-a'])).toThrow(/dashboard/i);
    expect(() => policy.assertAnyRole(1, ['dashboard', 'settings'])).toThrow(/unavailable/i);
    expect(() => policy.assertAnyRole(2, ['dashboard', 'settings'])).not.toThrow();
  });

  it('bounds grants and clears them on role replacement, tab closure, and window destruction', () => {
    const policy = new RendererAccessPolicy();
    policy.register(7, 'dashboard');
    expect(() => policy.setBindings(7, 'terminal', ['a', 'b', 'c', 'd', 'e'])).toThrow(/invalid/i);
    expect(() => policy.grant(7, 'terminal', '../secret')).toThrow(/invalid/i);
    policy.setBindings(7, 'terminal', ['a', 'b']);
    policy.revokeTab('a');
    expect(policy.canAccess(7, 'terminal', 'a')).toBe(false);
    expect(policy.canAccess(7, 'terminal', 'b')).toBe(true);
    policy.register(7, 'settings');
    expect(policy.canAccess(7, 'terminal', 'b')).toBe(false);
    policy.unregister(7);
    expect(policy.role(7)).toBeNull();
  });
});
