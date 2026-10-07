import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptySessionContent, parseSessionIdentity, validSessionContent,
  type SavedSessionContent, type SavedSessionState, type SessionIdentity } from '../shared/session-state';

/** App-private data only. This store is never included in diagnostics or host indexes. */
export class SessionStateStore {
  private readonly records = new Map<string, SavedSessionState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly failed = new Set<string>();
  constructor(private readonly directory: string, private readonly onWriteError?: (state: SavedSessionState) => void) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  private path(identity: SessionIdentity, executionTarget: string): string {
    return join(this.directory, createHash('sha256').update(JSON.stringify([
      identity.host, executionTarget, identity.projectRoot, identity.backend, identity.tool, identity.incarnationId
    ])).digest('hex') + '.json');
  }
  get(identity: SessionIdentity, executionTarget: string): SavedSessionState {
    const fallback = { ...emptySessionContent(), schemaVersion: 1 as const, revision: 0, identity, executionTarget };
    const path = this.path(identity, executionTarget);
    const cached = this.records.get(path);
    if (cached) return cached;
    try {
      if (statSync(path).size > 16 * 1024 * 1024) return fallback;
      const value = JSON.parse(readFileSync(path, 'utf8')) as SavedSessionState;
      const { schemaVersion, revision, identity: storedIdentity, executionTarget: storedTarget, ...content } = value;
      if (schemaVersion !== 1 || !Number.isSafeInteger(revision) || revision < 0
        || !parseSessionIdentity(storedIdentity, identity.host, identity.session)
        || this.path(storedIdentity, storedTarget) !== path || storedTarget !== executionTarget
        || !validSessionContent(content)) return fallback;
      this.records.set(path, value);
      return value;
    } catch { return fallback; }
  }
  update(identity: SessionIdentity, executionTarget: string, expectedRevision: number,
    content: SavedSessionContent): SavedSessionState {
    if (!validSessionContent(content)) throw new Error('Saved session content is invalid.');
    const previous = this.get(identity, executionTarget);
    if (previous.revision !== expectedRevision) return previous;
    const next: SavedSessionState = { ...content, schemaVersion: 1, revision: previous.revision + 1, identity, executionTarget };
    const path = this.path(identity, executionTarget);
    this.records.set(path, JSON.parse(JSON.stringify(next)) as SavedSessionState);
    const timer = this.timers.get(path);
    if (timer) clearTimeout(timer);
    this.timers.set(path, setTimeout(() => {
      try { this.flushPath(path); }
      catch { this.failed.add(path); this.onWriteError?.(this.records.get(path)!); }
    }, 300));
    return next;
  }
  private flushPath(path: string): void {
    const timer = this.timers.get(path);
    if (timer) clearTimeout(timer);
    this.timers.delete(path);
    const next = this.records.get(path);
    if (!next) return;
    const temporary = path + '.' + randomUUID();
    try {
      writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
      this.failed.delete(path);
    } finally { rmSync(temporary, { force: true }); }
  }
  flush(): void { for (const path of new Set([...this.timers.keys(), ...this.failed])) this.flushPath(path); }
  clear(identity: SessionIdentity, target: string, expectedRevision: number, questionId?: string, form?: string): SavedSessionState {
    const prior = this.get(identity, target);
    const { schemaVersion: _schema, revision: _revision, identity: _identity, executionTarget: _target, ...content } = prior;
    const next = this.update(identity, target, expectedRevision, questionId
      ? { ...content, questions: content.questions.filter((question) => question.requestId !== questionId || (form !== undefined && question.form !== form)) }
      : { ...content, message: '' });
    this.flushPath(this.path(identity, target));
    return next;
  }
}
