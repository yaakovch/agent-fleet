import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, createWriteStream, mkdirSync, opendirSync, rmSync, rmdirSync } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { nativeImage } from 'electron';
import { parseConversationProtocolFrame, parseConversationFrame, type ConversationView, type ConversationAnswer, type ConversationEvent, type ConversationFrame, type NativeActionResult, type StagedAttachment } from '../shared/conversation';
import type { PaneScrollbackSnapshot, TerminalTabDescriptor } from '../shared/terminal';
import { activatedRuntimeCommand } from '../shared/runtime';
import { wslProcessOwner, type WslProcessOwnership } from './wsl-process-ownership';

const MAX_FRAME = 256 * 1024;
const MAX_ACTION_OUTPUT = 512 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_DRAFT_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_ORPHAN_DIRECTORIES_SCANNED = 128;
const MAX_ORPHAN_FILES_PER_DIRECTORY = MAX_ATTACHMENTS + 1;

interface StreamState { negotiated: boolean; process: ChildProcess; buffer: string; bufferBytes: number; generation: number }
interface StoredAttachment extends StagedAttachment { path: string; sha256: string }
export interface AttachmentFileSelection { path: string; name: string; mime: string }

export interface ConversationManagerOptions {
  tempPath: string;
  getDistro(): string;
  hostCapabilities?(hostId: string): string[];
  resolveTab(tabId: string): TerminalTabDescriptor | undefined;
  sendTerminalInput(tabId: string, data: string): boolean;
  onEvent(event: ConversationEvent): void;
  logger: { info(...values: unknown[]): void; warn(...values: unknown[]): void };
  spawnProcess?: typeof spawn;
  processOwnership?: WslProcessOwnership;
  toWslPath?: (path: string) => string;
  thumbnail?: (data: Buffer) => string;
}

export class ConversationManager {
  private views = new Map<string, ConversationView>();
  private reads = new Map<string, AbortController>();
  private streams = new Map<string, StreamState>();
  private generations = new Map<string, number>();
  private attachments = new Map<string, StoredAttachment[]>();
  private readonly attachmentGenerations = new Map<string, number>();
  private readonly attachmentTails = new Map<string, Promise<void>>();
  private readonly stagingRoot: string;
  private disposed = false;

  constructor(private readonly options: ConversationManagerOptions) {
    this.stagingRoot = createPrivateStagingRoot(options.tempPath);
  }

  start(tabId: string, view: ConversationView = 'conversation'): boolean {
    const tab = this.options.resolveTab(tabId);
    if (!tab || tab.tool === 'shell') return false;
    const negotiated = this.options.hostCapabilities?.(tab.hostId).includes('conversation.turns.v1') ?? false;
    if (this.streams.has(tabId) && this.views.get(tabId) === view && this.streams.get(tabId)?.negotiated === negotiated) return true;
    this.stop(tabId);
    this.views.set(tabId, view);
    const generation = (this.generations.get(tabId) ?? 0) + 1;
    this.generations.set(tabId, generation);
    const process = (this.options.spawnProcess ?? spawn)('wsl.exe', this.command(tab, 'stream', ['--limit', '20', ...this.viewArgs(tab)]), {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const state: StreamState = { negotiated, process, buffer: '', bufferBytes: 0, generation };
    try {
      this.options.processOwnership?.own(wslProcessOwner('conversation', tabId), process);
    } catch (error) {
      process.once('error', () => undefined);
      try { process.kill(); } catch { /* the failed registration still owns cleanup */ }
      throw error;
    }
    this.streams.set(tabId, state);
    process.stdout?.setEncoding('utf8');
    process.stdout?.on('data', (data: string) => this.consume(tabId, state, data));
    process.stderr?.resume();
    process.once('error', () => this.localError(tabId, 'native_unavailable', 'Native view is unavailable; Terminal remains connected.'));
    process.once('exit', () => {
      if (this.streams.get(tabId) === state) {
        this.streams.delete(tabId);
        this.localError(tabId, 'disconnected', 'Native view disconnected. Retry or use Terminal.');
      }
    });
    return true;
  }

  sync(tabIds: string[], view: ConversationView = 'conversation'): string[] {
    const desired = new Set(tabIds.filter((id, index, values) => values.indexOf(id) === index).slice(0, 4));
    for (const tabId of [...this.streams.keys()]) if (!desired.has(tabId)) this.stop(tabId);
    const started: string[] = [];
    for (const tabId of desired) if (this.start(tabId, view)) started.push(tabId);
    return started;
  }

  cancelRead(tabId: string): void {
    this.reads.get(tabId)?.abort();
    this.reads.delete(tabId);
  }

  stop(tabId: string): void {
    this.cancelRead(tabId);
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
    const stream = this.streams.get(tabId);
    this.streams.delete(tabId);
    if (stream && !this.options.processOwnership?.release(stream.process, 'detach')) stream.process.kill();
  }

  close(tabId: string): void {
    this.stop(tabId);
    this.invalidateDraft(tabId);
  }

  dispose(): void {
    this.disposed = true;
    for (const tabId of this.streams.keys()) this.stop(tabId);
    for (const tabId of this.attachments.keys()) this.invalidateDraft(tabId);
    const pending = [...this.attachmentTails.values()];
    this.removeStagingRoot();
    for (const operation of pending) void operation.then(() => this.removeStagingRoot());
  }

  async page(tabId: string, cursor: string): Promise<NativeActionResult> {
    if (!safeArg(cursor, 512)) return { ok: false, message: 'History cursor is invalid' };
    const tab = this.options.resolveTab(tabId);
    if (!tab) return { ok: false, message: 'Session is no longer open' };
    return this.frameAction(tabId, 'stream', ['--cursor', cursor, '--limit', '20', '--no-follow', ...this.viewArgs(tab)], 15_000);
  }

  private viewArgs(tab: TerminalTabDescriptor): string[] {
    return this.options.hostCapabilities?.(tab.hostId).includes('conversation.turns.v1')
      ? ['--view', this.views.get(tab.id) ?? 'conversation'] : [];
  }

  async activity(tabId: string, turnId: string, cursor: string): Promise<NativeActionResult> {
    const tab = this.options.resolveTab(tabId);
    if (!tab || !this.viewArgs(tab).length || !safeArg(turnId, 160) || !safeArg(cursor, 512))
      return { ok: false, message: 'Update this host to load turn activity' };
    return this.frameAction(tabId, 'activity', ['--turn-id', turnId, '--cursor', cursor, '--limit', '25'], 15_000);
  }

  async history(tabId: string): Promise<NativeActionResult> {
    const tab = this.options.resolveTab(tabId);
    if (!tab || tab.tool === 'shell') return { ok: false, message: 'Terminal history is unavailable for this session' };
    const result = await runBounded('wsl.exe', [
      '-d', this.options.getDistro(), '--cd', '~', '--', activatedRuntimeCommand('wtmux'), 'pane', 'scrollback',
      '--host', tab.hostId, '--session', tab.internalName, '--limit', '2000'
    ], 20_000, this.options.spawnProcess ?? spawn, this.options.processOwnership, actionOwner('history'));
    const line = result.stdout.split(/\r?\n/u).filter(Boolean).at(-1) ?? '';
    const pane = parsePaneScrollback(line, tab.internalName);
    if (result.code === 0 && pane) return { ok: true, message: 'Pane scrollback ready', pane };
    return { ok: false, message: result.stderr.trim().slice(0, 500) || 'Pane scrollback is unavailable' };
  }

  async approve(tabId: string, approval: string, choice: string, revision: string, eventPosition: number): Promise<NativeActionResult> {
    if (![approval, choice, revision].every((value) => safeArg(value, 320)) || !Number.isSafeInteger(eventPosition) || eventPosition < 0) {
      return { ok: false, message: 'Approval changed; refresh it' };
    }
    return this.action(tabId, 'approve', ['--approval', approval, '--choice', choice, '--revision', revision,
      '--event-position', String(eventPosition),
      '--idempotency-key', randomUUID()], 15_000);
  }

  async answer(tabId: string, question: string, revision: string, eventPosition: number, answers: ConversationAnswer[]): Promise<NativeActionResult> {
    if (!safeArg(question, 320) || !safeArg(revision, 320) || !Number.isSafeInteger(eventPosition)
      || eventPosition < 0 || !Array.isArray(answers)) return { ok: false, message: 'Question changed; refresh it' };
    const payload = Buffer.from(JSON.stringify({ answers }), 'utf8');
    if (payload.length > 32 * 1024) return { ok: false, message: 'Answers are too long' };
    return this.action(tabId, 'answer', ['--question', question, '--revision', revision,
      '--event-position', String(eventPosition),
      '--answers-b64', payload.toString('base64url'), '--idempotency-key', randomUUID()], 90_000);
  }

  stage(tabId: string, name: string, mime: string, data: Uint8Array): Promise<StagedAttachment[]> {
    const generation = this.draftGeneration(tabId);
    return this.serializeDraft(tabId, async () => {
      this.assertDraftActive(tabId, generation);
      const current = this.attachments.get(tabId) ?? [];
      this.assertDraftCapacity(current, 1, data.byteLength);
      const item = await this.stageBytes(name, mime, data);
      if (!this.isDraftActive(tabId, generation)) {
        this.deleteStored(item);
        throw new Error('Session closed while the image was being staged');
      }
      const next = [...current, item];
      this.attachments.set(tabId, next);
      return next.map(publicAttachment);
    });
  }

  stageFiles(tabId: string, selections: AttachmentFileSelection[]): Promise<StagedAttachment[]> {
    const generation = this.draftGeneration(tabId);
    return this.serializeDraft(tabId, async () => {
      this.assertDraftActive(tabId, generation);
      const current = this.attachments.get(tabId) ?? [];
      if (!Array.isArray(selections)) throw new Error('Attachment selection is invalid');
      if (!selections.length) return current.map(publicAttachment);
      if (selections.length > MAX_ATTACHMENTS) throw new Error('Up to 8 images can be staged');
      this.assertDraftCapacity(current, selections.length, 0);
      const staged: StoredAttachment[] = [];
      try {
        for (const selection of selections) {
          const item = await this.stageFile(selection);
          staged.push(item);
          this.assertDraftCapacity(current, staged.length, staged.reduce((total, value) => total + value.bytes, 0));
          if (!this.isDraftActive(tabId, generation)) throw new Error('Session closed while images were being staged');
        }
      } catch (error) {
        staged.forEach((item) => this.deleteStored(item));
        throw error;
      }
      const next = [...current, ...staged];
      this.attachments.set(tabId, next);
      return next.map(publicAttachment);
    });
  }

  removeAttachment(tabId: string, attachmentId: string): Promise<StagedAttachment[]> {
    const generation = this.draftGeneration(tabId);
    return this.serializeDraft(tabId, async () => {
      if (!this.isDraftActive(tabId, generation)) return [];
      const current = this.attachments.get(tabId) ?? [];
      const removed = current.filter((item) => item.id === attachmentId);
      const next = current.filter((item) => item.id !== attachmentId);
      removed.forEach((item) => this.deleteStored(item));
      if (next.length) this.attachments.set(tabId, next);
      else this.attachments.delete(tabId);
      return next.map(publicAttachment);
    });
  }

  send(tabId: string, text: string): Promise<NativeActionResult> {
    const generation = this.draftGeneration(tabId);
    return this.serializeDraft(tabId, () => this.sendDraft(tabId, text, generation));
  }

  private async sendDraft(tabId: string, text: string, generation: number): Promise<NativeActionResult> {
    const tab = this.options.resolveTab(tabId);
    if (!this.isDraftActive(tabId, generation) || !tab || typeof text !== 'string'
      || text.length > 32_768) return { ok: false, message: 'Message is invalid' };
    const paths: string[] = [];
    const staged = this.attachments.get(tabId) ?? [];
    try {
      for (const attachment of staged) paths.push(await this.upload(tab, attachment));
    } catch (error) {
      if (!this.isDraftActive(tabId, generation)) staged.forEach((item) => this.deleteStored(item));
      return { ok: false, message: error instanceof Error ? error.message : 'Image upload failed' };
    }
    if (!this.isDraftActive(tabId, generation)) {
      staged.forEach((item) => this.deleteStored(item));
      return { ok: false, message: 'Session closed while images were uploading' };
    }
    const composed = [text.trimEnd(), ...paths].filter(Boolean).join(text.trimEnd() && paths.length ? '\n\n' : '\n');
    if (!this.options.sendTerminalInput(tabId, `${composed}\r`)) return { ok: false, message: 'Session is disconnected' };
    this.attachments.delete(tabId);
    staged.forEach((item) => this.deleteStored(item));
    return { ok: true, message: composed ? 'Sent' : 'Enter sent' };
  }

  private consume(tabId: string, state: StreamState, data: string): void {
    if (this.streams.get(tabId) !== state) return;
    state.bufferBytes += Buffer.byteLength(data, 'utf8');
    if (state.bufferBytes > MAX_FRAME * 2) {
      this.rejectStream(tabId, state, 'oversized_frame', 'The host sent an oversized conversation frame.');
      return;
    }
    state.buffer += data;
    let newline = state.buffer.indexOf('\n');
    while (newline >= 0) {
      const rawLine = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      state.bufferBytes -= Buffer.byteLength(rawLine, 'utf8') + 1;
      if (Buffer.byteLength(rawLine, 'utf8') > MAX_FRAME) {
        this.rejectStream(tabId, state, 'oversized_frame', 'The host sent an oversized conversation frame.');
        return;
      }
      const line = rawLine.trim();
      if (line) {
        const frame = parseConversationFrame(line);
        if (frame) this.options.onEvent({ tabId, frame });
        else this.localError(tabId, 'invalid_frame', 'The host sent an invalid conversation frame.');
      }
      newline = state.buffer.indexOf('\n');
    }
  }

  private rejectStream(tabId: string, state: StreamState, code: string, message: string): void {
    if (this.streams.get(tabId) !== state) return;
    this.streams.delete(tabId);
    state.buffer = '';
    state.bufferBytes = 0;
    if (!this.options.processOwnership?.release(state.process, 'protocol_failure')) state.process.kill();
    this.localError(tabId, code, message);
  }

  private async frameAction(tabId: string, action: string, args: string[], timeout: number): Promise<NativeActionResult> {
    const result = await this.action(tabId, action, args, timeout);
    if (!result.ok) return result;
    return result.frame ? result : { ok: false, message: 'The host returned no conversation frame' };
  }

  private async action(tabId: string, action: string, args: string[], timeout: number): Promise<NativeActionResult> {
    const tab = this.options.resolveTab(tabId);
    if (!tab) return { ok: false, message: 'Session is no longer open' };
    const read = ['stream', 'activity'].includes(action) ? new AbortController() : undefined;
    if (read) { this.reads.get(tabId)?.abort(); this.reads.set(tabId, read); }
    const result = await runBounded(
      'wsl.exe',
      this.command(tab, action, args),
      timeout,
      this.options.spawnProcess ?? spawn,
      this.options.processOwnership,
      actionOwner(action), read?.signal
    );
    if (read && this.reads.get(tabId) === read) this.reads.delete(tabId);
    if (read?.signal.aborted) return { ok: false, message: 'Request cancelled' };
    const line = result.stdout.split(/\r?\n/u).filter(Boolean).at(-1) ?? '';
    const frame = parseConversationFrame(line);
    if (result.code === 0 && (action === 'answer' || action === 'approve')) {
      const receipt = parseConversationProtocolFrame(line);
      const question = action === 'answer';
      const expectedId = args[args.indexOf(question ? '--question' : '--approval') + 1];
      if (!receipt || (receipt.type !== 'question.response' && receipt.type !== 'approval.response')
        || receipt.type !== (question ? 'question.response' : 'approval.response')
        || receipt.session !== tab.internalName
        || (question ? receipt.questionId !== expectedId
          : receipt.approvalId !== expectedId || receipt.choice !== args[args.indexOf('--choice') + 1])) {
        return { ok: false, message: 'The host did not confirm this response. Check again before retrying.' };
      }
    }
    if (result.code === 0) return { ok: true, message: 'Delivered', ...(frame ? { frame } : {}) };
    const structured = safeJson(line)?.error?.message;
    return { ok: false, message: typeof structured === 'string' ? structured.slice(0, 500) : result.stderr.trim().slice(0, 500) || 'The host rejected the action' };
  }

  private command(tab: TerminalTabDescriptor, action: string, extra: string[]): string[] {
    return ['-d', this.options.getDistro(), '--cd', '~', '--', activatedRuntimeCommand('wtmux'), 'conversation', action,
      '--host', tab.hostId, '--session', tab.internalName, ...extra];
  }

  private async upload(tab: TerminalTabDescriptor, attachment: StoredAttachment): Promise<string> {
    await this.verifyStoredAttachment(attachment);
    const linuxPath = (this.options.toWslPath ?? windowsToWslPath)(attachment.path);
    const result = await runBounded('wsl.exe', ['-d', this.options.getDistro(), '--cd', '~', '--', activatedRuntimeCommand('wtmux'),
      'image', 'send', linuxPath, '--host', tab.hostId, '--project', tab.project, '--session', tab.internalName, '--json'],
    35_000, this.options.spawnProcess ?? spawn, this.options.processOwnership, actionOwner('upload'));
    const value = safeJson(result.stdout.split(/\r?\n/u).filter(Boolean).at(-1) ?? '');
    if (result.code !== 0 || typeof value?.path !== 'string') {
      throw new Error('Image upload failed; staged images were kept for retry');
    }
    return value.path;
  }

  private serializeDraft<Result>(tabId: string, task: () => Promise<Result>): Promise<Result> {
    const previous = this.attachmentTails.get(tabId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    const tail = operation.then(() => undefined, () => undefined);
    this.attachmentTails.set(tabId, tail);
    void tail.then(() => {
      if (this.attachmentTails.get(tabId) === tail) this.attachmentTails.delete(tabId);
    });
    return operation;
  }

  private draftGeneration(tabId: string): number {
    return this.attachmentGenerations.get(tabId) ?? 0;
  }

  private isDraftActive(tabId: string, generation: number): boolean {
    return !this.disposed && this.draftGeneration(tabId) === generation && Boolean(this.options.resolveTab(tabId));
  }

  private assertDraftActive(tabId: string, generation: number): void {
    if (!this.isDraftActive(tabId, generation)) throw new Error('Session is no longer open');
  }

  private invalidateDraft(tabId: string): void {
    this.attachmentGenerations.set(tabId, this.draftGeneration(tabId) + 1);
    const staged = this.attachments.get(tabId) ?? [];
    this.attachments.delete(tabId);
    staged.forEach((item) => this.deleteStored(item));
  }

  private assertDraftCapacity(current: StoredAttachment[], addedCount: number, addedBytes: number): void {
    if (current.length + addedCount > MAX_ATTACHMENTS) throw new Error('Up to 8 images can be staged');
    const total = current.reduce((sum, item) => sum + item.bytes, 0) + addedBytes;
    if (total > MAX_DRAFT_BYTES) throw new Error('Staged images are limited to 64 MB per draft');
  }

  private async stageBytes(name: string, mime: string, data: Uint8Array): Promise<StoredAttachment> {
    validateAttachmentMetadata(name, mime);
    if (!(data instanceof Uint8Array) || data.byteLength < 8 || data.byteLength > MAX_IMAGE) {
      throw new Error('Choose an image smaller than 20 MB');
    }
    const buffer = Buffer.from(data);
    validateImage(buffer, mime);
    const item = this.storedAttachment(name, mime, buffer);
    try {
      await writeFile(item.path, buffer, { flag: 'wx', mode: 0o600 });
      return item;
    } catch (error) {
      this.deleteStored(item);
      throw error;
    }
  }

  private async stageFile(selection: AttachmentFileSelection): Promise<StoredAttachment> {
    validateAttachmentMetadata(selection.name, selection.mime);
    if (typeof selection.path !== 'string' || !selection.path || selection.path.length > 32_767
      || selection.path.includes('\u0000')) throw new Error('Selected image path is invalid');
    const id = randomUUID();
    const path = join(this.stagingRoot, `${id}.bin`);
    const source = await open(selection.path, 'r');
    const digest = createHash('sha256');
    let expectedBytes = 0;
    let bytes = 0;
    try {
      const stat = await source.stat();
      if (!stat.isFile() || stat.size < 8 || stat.size > MAX_IMAGE) {
        throw new Error('Choose an image smaller than 20 MB');
      }
      expectedBytes = stat.size;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          digest.update(chunk);
          callback(bytes > MAX_IMAGE ? new Error('Choose an image smaller than 20 MB') : null, chunk);
        }
      });
      await pipeline(
        source.createReadStream({ autoClose: false, start: 0 }),
        limiter,
        createWriteStream(path, { flags: 'wx', mode: 0o600 })
      );
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    } finally {
      await source.close();
    }
    try {
      if (bytes !== expectedBytes) throw new Error('The selected image changed while it was being staged');
      const buffer = await readFile(path);
      const sha256 = digest.digest('hex');
      if (buffer.length !== bytes || createHash('sha256').update(buffer).digest('hex') !== sha256) {
        throw new Error('The selected image changed while it was being staged');
      }
      validateImage(buffer, selection.mime);
      return {
        id,
        name: safeFileName(selection.name),
        mime: selection.mime,
        bytes,
        thumbnail: this.thumbnail(buffer),
        path,
        sha256
      };
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
  }

  private storedAttachment(name: string, mime: string, buffer: Buffer): StoredAttachment {
    const id = randomUUID();
    return {
      id,
      name: safeFileName(name),
      mime,
      bytes: buffer.length,
      thumbnail: this.thumbnail(buffer),
      path: join(this.stagingRoot, `${id}.bin`),
      sha256: createHash('sha256').update(buffer).digest('hex')
    };
  }

  private async verifyStoredAttachment(item: StoredAttachment): Promise<void> {
    const source = await open(item.path, 'r');
    const digest = createHash('sha256');
    let bytes = 0;
    try {
      const stat = await source.stat();
      if (!stat.isFile() || stat.size !== item.bytes || stat.size > MAX_IMAGE) {
        throw new Error('A staged image changed; remove it and attach it again');
      }
      for await (const chunk of source.createReadStream({ autoClose: false, start: 0 })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_IMAGE) throw new Error('A staged image changed; remove it and attach it again');
        digest.update(buffer);
      }
    } finally {
      await source.close();
    }
    if (bytes !== item.bytes || digest.digest('hex') !== item.sha256) {
      throw new Error('A staged image changed; remove it and attach it again');
    }
  }

  private deleteStored(item: StoredAttachment): void {
    try {
      rmSync(item.path, { force: true });
    } catch (error) {
      this.options.logger.warn('Could not remove a private staged attachment', readableError(error));
    }
  }

  private removeStagingRoot(): void {
    try {
      rmSync(this.stagingRoot, { recursive: true, force: true });
    } catch (error) {
      this.options.logger.warn('Could not remove the private attachment staging directory', readableError(error));
    }
  }

  private thumbnail(data: Buffer): string {
    return (this.options.thumbnail ?? thumbnailDataUrl)(data);
  }

  private localError(tabId: string, code: string, message: string): void {
    this.options.onEvent({ tabId, frame: { protocolVersion: 2, type: 'conversation.error', error: { code, message } } });
  }
}

function parsePaneScrollback(line: string, session: string): PaneScrollbackSnapshot | null {
  if (line.length < 2 || line.length > 6 * 1024 * 1024) return null;
  const value = safeJson(line);
  if (value?.protocolVersion !== 1 || value?.type !== 'pane.scrollback' || value?.session !== session
      || !Number.isInteger(value.columns) || value.columns < 4 || value.columns > 1_000
      || !Number.isInteger(value.rows) || value.rows < 4 || value.rows > 1_000
      || !Number.isInteger(value.historyLines) || value.historyLines < 0
      || !Number.isInteger(value.capturedLines) || value.capturedLines < 0
      || typeof value.truncated !== 'boolean' || !/^[a-f0-9]{64}$/u.test(String(value.revision))
      || typeof value.ansiBase64 !== 'string' || value.ansiBase64.length > 6 * 1024 * 1024) return null;
  const ansi = Buffer.from(value.ansiBase64, 'base64');
  if (!ansi.length || ansi.length > 4 * 1024 * 1024 || ansi.toString('base64') !== value.ansiBase64
      || createHash('sha256').update(ansi).digest('hex') !== value.revision) return null;
  return value as unknown as PaneScrollbackSnapshot;
}
function safeJson(value: string): Record<string, any> | null { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; } }
function safeArg(value: string, max: number): boolean { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
function validateAttachmentMetadata(name: string, mime: string): void {
  if (typeof name !== 'string' || !name || name.length > 255 || /[\u0000-\u001f\u007f]/u.test(name)
    || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) {
    throw new Error('Image name or type is invalid');
  }
}
function safeFileName(value: string): string { return value.replace(/[^A-Za-z0-9._-]/gu, '_').slice(-100) || 'image.png'; }
function publicAttachment(value: StoredAttachment): StagedAttachment {
  const { path: _path, sha256: _sha256, ...result } = value;
  return result;
}
function thumbnailDataUrl(value: Buffer): string {
  const image = nativeImage.createFromBuffer(value);
  if (image.isEmpty()) throw new Error('The selected image could not be decoded');
  const resized = image.resize({ width: 180, height: 120, quality: 'good' }).toPNG();
  return `data:image/png;base64,${resized.toString('base64')}`;
}
function validateImage(value: Buffer, declaredMime: string): void {
  const detected = imageIdentity(value);
  if (!detected || detected.mime !== declaredMime) throw new Error('The selected file is not a supported image');
  if (detected.width < 1 || detected.height < 1
    || detected.width * detected.height > MAX_IMAGE_PIXELS) {
    throw new Error('The selected image dimensions are too large');
  }
}
function imageIdentity(value: Buffer): { mime: string; width: number; height: number } | null {
  if (value.length >= 24 && value.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    return { mime: 'image/png', width: value.readUInt32BE(16), height: value.readUInt32BE(20) };
  }
  if (value.length >= 10 && value.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return { mime: 'image/gif', width: value.readUInt16LE(6), height: value.readUInt16LE(8) };
  }
  if (value.length >= 12 && value.subarray(0, 4).toString('ascii') === 'RIFF'
    && value.subarray(8, 12).toString('ascii') === 'WEBP') {
    const dimensions = webpDimensions(value);
    return dimensions ? { mime: 'image/webp', ...dimensions } : null;
  }
  if (value.length >= 4 && value[0] === 0xff && value[1] === 0xd8) {
    const dimensions = jpegDimensions(value);
    return dimensions ? { mime: 'image/jpeg', ...dimensions } : null;
  }
  return null;
}
function jpegDimensions(value: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < value.length) {
    if (value[offset] !== 0xff) { offset += 1; continue; }
    while (value[offset] === 0xff) offset += 1;
    const marker = value[offset++];
    if (marker === 0xd8 || marker === 0xd9 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > value.length) return null;
    const length = value.readUInt16BE(offset);
    if (length < 2 || offset + length > value.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
      && length >= 7) {
      return { height: value.readUInt16BE(offset + 3), width: value.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}
function webpDimensions(value: Buffer): { width: number; height: number } | null {
  const kind = value.subarray(12, 16).toString('ascii');
  if (kind === 'VP8X' && value.length >= 30) {
    return {
      width: 1 + value.readUIntLE(24, 3),
      height: 1 + value.readUIntLE(27, 3)
    };
  }
  if (kind === 'VP8L' && value.length >= 25 && value[20] === 0x2f) {
    const bits = value.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (kind === 'VP8 ' && value.length >= 30
    && value[23] === 0x9d && value[24] === 0x01 && value[25] === 0x2a) {
    return { width: value.readUInt16LE(26) & 0x3fff, height: value.readUInt16LE(28) & 0x3fff };
  }
  return null;
}
function createPrivateStagingRoot(basePath: string): string {
  mkdirSync(basePath, { recursive: true, mode: 0o700 });
  chmodSync(basePath, 0o700);
  const directory = opendirSync(basePath);
  try {
    for (let scanned = 0; scanned < MAX_ORPHAN_DIRECTORIES_SCANNED; scanned += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      const match = /^run-(\d+)-[a-f0-9-]{36}$/u.exec(entry.name);
      if (!entry.isDirectory() || !match) continue;
      const ownerPid = Number(match[1]);
      if (ownerPid === process.pid || processIsAlive(ownerPid)) continue;
      removeAbandonedStagingRoot(join(basePath, entry.name));
    }
  } finally {
    directory.closeSync();
  }
  const root = join(basePath, `run-${process.pid}-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}
function removeAbandonedStagingRoot(root: string): void {
  const directory = opendirSync(root);
  const files: string[] = [];
  let complete = false;
  try {
    for (let scanned = 0; scanned <= MAX_ORPHAN_FILES_PER_DIRECTORY; scanned += 1) {
      const entry = directory.readSync();
      if (!entry) {
        complete = true;
        break;
      }
      if (scanned === MAX_ORPHAN_FILES_PER_DIRECTORY
        || !entry.isFile() || !/^[a-f0-9-]{36}\.bin$/u.test(entry.name)) return;
      files.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  if (!complete) return;
  for (const file of files) rmSync(join(root, file), { force: true });
  try {
    rmdirSync(root);
  } catch {
    // A concurrent writer or unexpected entry keeps the directory quarantined.
  }
}
function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function windowsToWslPath(path: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(path);
  if (!match) throw new Error('Temporary image path is unavailable to WSL');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}
async function runBounded(
  command: string,
  args: string[],
  timeoutMs: number,
  spawnProcess: typeof spawn = spawn,
  processOwnership?: WslProcessOwnership,
  owner = actionOwner('bounded'),
  signal?: AbortSignal
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnProcess(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      processOwnership?.own(owner, child);
    } catch (error) {
      child.once('error', () => undefined);
      try { child.kill(); } catch { /* the failed registration still owns cleanup */ }
      resolve({ code: -1, stdout: '', stderr: readableError(error) });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let termination: 'timeout' | 'output' | 'cancel' | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (code: number, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const stdoutText = Buffer.concat(stdout, stdoutBytes).toString('utf8');
      const stderrText = termination === 'timeout'
        ? 'Action timed out'
        : termination === 'output'
          ? 'Action output exceeded the safety limit'
          : error?.message ?? Buffer.concat(stderr, stderrBytes).toString('utf8');
      resolve({ code: termination || error ? -1 : code, stdout: stdoutText, stderr: stderrText });
    };
    const terminate = (cause: 'timeout' | 'output' | 'cancel'): void => {
      if (termination) return;
      termination = cause;
      const releaseCause = cause === 'timeout' ? 'timeout' : 'protocol_failure';
      if (!processOwnership?.release(child, releaseCause)) {
        try {
          child.kill();
        } catch {
          // The process exited between the bound check and termination.
        }
      }
      finish(-1);
    };
    const abort = (): void => terminate('cancel');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    const append = (chunks: Buffer[], data: Buffer | string, used: number, maximum: number): number => {
      if (termination) return used;
      const value = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      const remaining = maximum - used;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      if (value.length > remaining) terminate('output');
      return used + Math.min(value.length, Math.max(remaining, 0));
    };
    child.stdout?.on('data', (data: Buffer | string) => {
      stdoutBytes = append(stdout, data, stdoutBytes, MAX_ACTION_OUTPUT);
    });
    child.stderr?.on('data', (data: Buffer | string) => {
      stderrBytes = append(stderr, data, stderrBytes, 64 * 1024);
    });
    timer = setTimeout(() => {
      terminate('timeout');
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      if (!termination) processOwnership?.release(child, 'protocol_failure');
      finish(-1, error);
    });
    child.once('exit', (code) => finish(code ?? -1));
  });
}

function actionOwner(action: string): string {
  const safeAction = action.replace(/[^a-z0-9._-]/giu, '-').slice(0, 32) || 'bounded';
  return `conversation-action:${safeAction}:${randomUUID()}`;
}
