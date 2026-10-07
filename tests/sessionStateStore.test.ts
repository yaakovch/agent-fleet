import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStateStore } from '../src/main/session-state-store';
import { emptySessionContent, parseSessionIdentity, validSessionContent, type SessionIdentity } from '../src/shared/session-state';
import { questionFormContent } from '../src/shared/session-state';

const directories: string[] = [];
function directory(): string { const path = mkdtempSync(join(tmpdir(), 'fleet-state-')); directories.push(path); return path; }
const identity: SessionIdentity = { schemaVersion: 1, host: 'gaming', session: 'session-1', incarnationId: 'a'.repeat(64), projectRoot: '/projects/fixture', backend: 'linux', tool: 'codex' };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('durable session state', () => {
  it('uses the shared form fingerprint independently of object key order', () => {
    const behavior = JSON.parse(readFileSync(join(__dirname, 'fixtures/saved-session-behavior-v1.json'), 'utf8'));
    const fingerprint = (questions: Parameters<typeof questionFormContent>[0]) => createHash('sha256').update(questionFormContent(questions)).digest('hex');
    expect(fingerprint(behavior.form.questions)).toBe(behavior.form.sha256);
    const reordered = behavior.form.questions.map((question: Record<string, unknown>) => Object.fromEntries(Object.entries(question).reverse()));
    expect(fingerprint(reordered)).toBe(behavior.form.sha256);
    expect(behavior.persistence.restoredMutationsAllowed).toBe(false);
  });
  it('accepts and rejects the same canonical identity and saved-content fixtures as Android', () => {
    const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'contracts', name), 'utf8'));
    const verified = fixture('session-identity-v1.json');
    expect(parseSessionIdentity(verified, verified.host, verified.session)).toEqual(verified);
    for (const name of ['session-identity-unknown-field-v1.json', 'session-identity-incarnation-v1.json']) expect(parseSessionIdentity(fixture(name), verified.host, verified.session)).toBeNull();
    const { schemaVersion: _schema, revision: _revision, identity: _identity, executionTarget: _target, ...content } = fixture('saved-session-v1.json');
    expect(validSessionContent(content)).toBe(true);
    expect(validSessionContent({ ...content, attachments: ['unrestorable'] })).toBe(false);
  });
  it('restores content after restart while keeping authority and attachments outside storage', () => {
    const path = directory(); const store = new SessionStateStore(path);
    store.update(identity, 'ubuntu', 0, { ...emptySessionContent(), message: 'unsent', followOutput: false, anchor: { itemId: 'message-1', offset: 12 } });
    store.flush();
    const restored = new SessionStateStore(path).get(identity, 'ubuntu');
    expect(restored.message).toBe('unsent'); expect(restored.anchor?.itemId).toBe('message-1');
    expect(restored).not.toHaveProperty('providerState'); expect(restored).not.toHaveProperty('attachments');
    expect(JSON.parse(readFileSync(join(path, readdirSync(path)[0]), 'utf8')).revision).toBe(1);
  });
  it('keeps a revisioned tombstone so delayed saves cannot undo Send or Clear', () => {
    const path = directory(); const store = new SessionStateStore(path);
    const draft = { ...emptySessionContent(), message: 'unsent' };
    store.update(identity, 'ubuntu', 0, draft);
    const cleared = store.clear(identity, 'ubuntu', 1);
    expect(cleared.message).toBe(''); expect(cleared.revision).toBe(2);
    expect(store.update(identity, 'ubuntu', 1, draft).message).toBe('');
    expect(new SessionStateStore(path).get(identity, 'ubuntu').message).toBe('');
  });
  it('isolates reused names, projects, execution targets and tools', () => {
    const store = new SessionStateStore(directory());
    store.update(identity, 'ubuntu', 0, { ...emptySessionContent(), message: 'private' });
    for (const changed of [{ ...identity, incarnationId: 'b'.repeat(64) }, { ...identity, projectRoot: '/other' }, { ...identity, tool: 'claude' }]) {
      expect(store.get(changed, 'ubuntu').message).toBe('');
    }
    expect(store.get(identity, 'another-target').message).toBe(''); store.flush();
  });
  it('retains unmatched question drafts and clears only the delivered question', () => {
    const store = new SessionStateStore(directory());
    store.update(identity, 'ubuntu', 0, { ...emptySessionContent(), questions: ['one', 'two'].map((requestId) => ({ requestId, form: 'form', answers: [{ questionId: requestId, choiceIds: [], text: 'answer' }] })) });
    const next = store.clear(identity, 'ubuntu', 1, 'one');
    expect(next.questions.map((draft) => draft.requestId)).toEqual(['two']);
  });
  it('rejects uploads, authority and oversized input in durable content', () => {
    const store = new SessionStateStore(directory());
    expect(() => store.update(identity, 'ubuntu', 0, { ...emptySessionContent(), message: 'x'.repeat(32769) })).toThrow();
    expect(() => store.update(identity, 'ubuntu', 0, { ...emptySessionContent(), attachments: ['private'] } as never)).toThrow();
  });
});
