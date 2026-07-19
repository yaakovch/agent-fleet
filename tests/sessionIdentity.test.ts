import { describe, expect, it } from 'vitest';
import { sessionIdentityPresentation, type FleetSession } from '../src/shared/fleet';

const session: FleetSession = {
  id: 'host:wtmux-demo-1', hostId: 'host', internalName: 'wtmux-demo-1', name: 'demo:1',
  title: 'Fix Android session titles', nameMode: 'automatic', project: 'demo', projectPath: '/demo',
  tool: 'codex', backend: 'linux', activity: 'active', attached: true, updatedAt: null,
  pendingScheduleCount: 0, favorite: false
};

describe('session identity presentation', () => {
  it('uses the provider-aware title as primary only for automatic names', () => {
    expect(sessionIdentityPresentation(session)).toEqual({
      primary: 'Fix Android session titles', secondary: 'demo:1 · host · demo', stableName: 'demo:1'
    });
    expect(sessionIdentityPresentation({ ...session, name: 'Release work', nameMode: 'manual' })).toEqual({
      primary: 'Release work', secondary: 'host · demo', stableName: 'Release work'
    });
  });

  it('falls back to the stable name when a title is unavailable', () => {
    expect(sessionIdentityPresentation({ ...session, title: '' }).primary).toBe('demo:1');
  });
});
