import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { LocalSuggestionStore } from '../src/main/local-suggestion-store';

describe('local suggestion machine settings', () => {
  it('stays disabled by default and stores bearer tokens encoded outside exported settings', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agent-fleet-local-')), 'local-suggestions.json');
    const codec = { encrypt: (value: string) => `encoded:${value}`, decrypt: (value: string) => value.replace('encoded:', '') };
    const store = new LocalSuggestionStore(path, codec);
    expect(store.view().enabled).toBe(false);
    store.save({ ...store.view(), enabled: true, backend: 'openAICompatible', external: { ...store.view().external, bearerToken: 'secret-token' } });
    expect(store.view().external.tokenConfigured).toBe(true);
    expect(store.token()).toBe('secret-token');
    const disk = readFileSync(path, 'utf8');
    expect(disk).not.toContain('"secret-token"');
    expect(disk).toContain('encoded:secret-token');
  });
});
