import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { nativeImage } from 'electron';
import type { ConversationAnswer, ConversationEvent, ConversationFrame, NativeActionResult, StagedAttachment } from '../shared/conversation';
import type { PaneScrollbackSnapshot, TerminalTabDescriptor } from '../shared/terminal';

const MAX_FRAME = 256 * 1024;
const MAX_ACTION_OUTPUT = 512 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;

interface StreamState { process: ChildProcess; buffer: string; generation: number }
interface StoredAttachment extends StagedAttachment { data: Buffer }

export interface ConversationManagerOptions {
  tempPath: string;
  getDistro(): string;
  resolveTab(tabId: string): TerminalTabDescriptor | undefined;
  sendTerminalInput(tabId: string, data: string): boolean;
  onEvent(event: ConversationEvent): void;
  logger: { info(...values: unknown[]): void; warn(...values: unknown[]): void };
  spawnProcess?: typeof spawn;
}

export class ConversationManager {
  private streams = new Map<string, StreamState>();
  private generations = new Map<string, number>();
  private attachments = new Map<string, StoredAttachment[]>();

  constructor(private readonly options: ConversationManagerOptions) {}

  start(tabId: string): boolean {
    const tab = this.options.resolveTab(tabId);
    if (!tab || tab.tool === 'shell') return false;
    if (this.streams.has(tabId)) return true;
    this.stop(tabId);
    const generation = (this.generations.get(tabId) ?? 0) + 1;
    this.generations.set(tabId, generation);
    const process = (this.options.spawnProcess ?? spawn)('wsl.exe', this.command(tab, 'stream', ['--limit', '20']), {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const state: StreamState = { process, buffer: '', generation };
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

  sync(tabIds: string[]): string[] {
    const desired = new Set(tabIds.filter((id, index, values) => values.indexOf(id) === index).slice(0, 4));
    for (const tabId of [...this.streams.keys()]) if (!desired.has(tabId)) this.stop(tabId);
    const started: string[] = [];
    for (const tabId of desired) if (this.start(tabId)) started.push(tabId);
    return started;
  }

  stop(tabId: string): void {
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
    const stream = this.streams.get(tabId);
    this.streams.delete(tabId);
    stream?.process.kill();
  }

  close(tabId: string): void {
    this.stop(tabId);
    this.attachments.delete(tabId);
  }

  dispose(): void {
    for (const tabId of this.streams.keys()) this.stop(tabId);
    this.attachments.clear();
  }

  async page(tabId: string, cursor: string): Promise<NativeActionResult> {
    if (!safeArg(cursor, 512)) return { ok: false, message: 'History cursor is invalid' };
    return this.frameAction(tabId, 'stream', ['--cursor', cursor, '--limit', '20', '--no-follow'], 15_000);
  }

  async history(tabId: string): Promise<NativeActionResult> {
    const tab = this.options.resolveTab(tabId);
    if (!tab || tab.tool === 'shell') return { ok: false, message: 'Terminal history is unavailable for this session' };
    const result = await runBounded('wsl.exe', [
      '-d', this.options.getDistro(), '--cd', '~', '--', '.local/bin/wtmux', 'pane', 'scrollback',
      '--host', tab.hostId, '--session', tab.internalName, '--limit', '2000'
    ], 20_000, this.options.spawnProcess ?? spawn);
    const line = result.stdout.split(/\r?\n/u).filter(Boolean).at(-1) ?? '';
    const pane = parsePaneScrollback(line, tab.internalName);
    if (result.code === 0 && pane) return { ok: true, message: 'Pane scrollback ready', pane };
    return { ok: false, message: result.stderr.trim().slice(0, 500) || 'Pane scrollback is unavailable' };
  }

  async approve(tabId: string, approval: string, choice: string, revision: string): Promise<NativeActionResult> {
    if (![approval, choice, revision].every((value) => safeArg(value, 320))) return { ok: false, message: 'Approval changed; refresh it' };
    return this.action(tabId, 'approve', ['--approval', approval, '--choice', choice, '--revision', revision,
      '--idempotency-key', randomUUID()], 15_000);
  }

  async answer(tabId: string, question: string, revision: string, answers: ConversationAnswer[]): Promise<NativeActionResult> {
    if (!safeArg(question, 320) || !safeArg(revision, 320) || !Array.isArray(answers)) return { ok: false, message: 'Question changed; refresh it' };
    const payload = Buffer.from(JSON.stringify({ answers }), 'utf8');
    if (payload.length > 32 * 1024) return { ok: false, message: 'Answers are too long' };
    return this.action(tabId, 'answer', ['--question', question, '--revision', revision,
      '--answers-b64', payload.toString('base64url'), '--idempotency-key', randomUUID()], 35_000);
  }

  stage(tabId: string, name: string, mime: string, data: Uint8Array): StagedAttachment[] {
    if (!this.options.resolveTab(tabId) || !mime.startsWith('image/') || data.byteLength < 8 || data.byteLength > MAX_IMAGE) {
      throw new Error('Choose an image smaller than 20 MB');
    }
    const current = this.attachments.get(tabId) ?? [];
    if (current.length >= MAX_ATTACHMENTS) throw new Error('Up to 8 images can be staged');
    const buffer = Buffer.from(data);
    if (!looksLikeImage(buffer)) throw new Error('The selected file is not a supported image');
    const item: StoredAttachment = {
      id: randomUUID(), name: safeFileName(name), mime, bytes: buffer.length,
      thumbnail: thumbnailDataUrl(buffer), data: buffer
    };
    current.push(item);
    this.attachments.set(tabId, current);
    return current.map(publicAttachment);
  }

  removeAttachment(tabId: string, attachmentId: string): StagedAttachment[] {
    const next = (this.attachments.get(tabId) ?? []).filter((item) => item.id !== attachmentId);
    this.attachments.set(tabId, next);
    return next.map(publicAttachment);
  }

  async send(tabId: string, text: string): Promise<NativeActionResult> {
    const tab = this.options.resolveTab(tabId);
    if (!tab || typeof text !== 'string' || text.length > 32_768) return { ok: false, message: 'Message is invalid' };
    const paths: string[] = [];
    const staged = this.attachments.get(tabId) ?? [];
    try {
      for (const attachment of staged) paths.push(await this.upload(tab, attachment));
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Image upload failed' };
    }
    const composed = [text.trimEnd(), ...paths].filter(Boolean).join(text.trimEnd() && paths.length ? '\n\n' : '\n');
    if (!this.options.sendTerminalInput(tabId, `${composed}\r`)) return { ok: false, message: 'Session is disconnected' };
    this.attachments.delete(tabId);
    return { ok: true, message: composed ? 'Sent' : 'Enter sent' };
  }

  private consume(tabId: string, state: StreamState, data: string): void {
    if (this.streams.get(tabId) !== state) return;
    state.buffer += data;
    if (state.buffer.length > MAX_FRAME * 2) {
      state.process.kill();
      this.localError(tabId, 'oversized_frame', 'The host sent an oversized conversation frame.');
      return;
    }
    let newline = state.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      if (line) {
        const frame = parseFrame(line);
        if (frame) this.options.onEvent({ tabId, frame });
        else this.localError(tabId, 'invalid_frame', 'The host sent an invalid conversation frame.');
      }
      newline = state.buffer.indexOf('\n');
    }
  }

  private async frameAction(tabId: string, action: string, args: string[], timeout: number): Promise<NativeActionResult> {
    const result = await this.action(tabId, action, args, timeout);
    if (!result.ok) return result;
    return result.frame ? result : { ok: false, message: 'The host returned no conversation frame' };
  }

  private async action(tabId: string, action: string, args: string[], timeout: number): Promise<NativeActionResult> {
    const tab = this.options.resolveTab(tabId);
    if (!tab) return { ok: false, message: 'Session is no longer open' };
    const result = await runBounded('wsl.exe', this.command(tab, action, args), timeout, this.options.spawnProcess ?? spawn);
    const line = result.stdout.split(/\r?\n/u).filter(Boolean).at(-1) ?? '';
    const frame = parseFrame(line);
    if (result.code === 0) return { ok: true, message: 'Delivered', ...(frame ? { frame } : {}) };
    const structured = safeJson(line)?.error?.message;
    return { ok: false, message: typeof structured === 'string' ? structured.slice(0, 500) : result.stderr.trim().slice(0, 500) || 'The host rejected the action' };
  }

  private command(tab: TerminalTabDescriptor, action: string, extra: string[]): string[] {
    return ['-d', this.options.getDistro(), '--cd', '~', '--', '.local/bin/wtmux', 'conversation', action,
      '--host', tab.hostId, '--session', tab.internalName, ...extra];
  }

  private async upload(tab: TerminalTabDescriptor, attachment: StoredAttachment): Promise<string> {
    mkdirSync(this.options.tempPath, { recursive: true });
    const path = join(this.options.tempPath, `${attachment.id}-${attachment.name}`);
    writeFileSync(path, attachment.data, { mode: 0o600 });
    try {
      const linuxPath = windowsToWslPath(path);
      const result = await runBounded('wsl.exe', ['-d', this.options.getDistro(), '--cd', '~', '--', '.local/bin/wtmux',
        'image', 'send', linuxPath, '--host', tab.hostId, '--project', tab.project, '--session', tab.internalName, '--json'], 35_000);
      const value = safeJson(result.stdout.split(/\r?\n/u).filter(Boolean).at(-1) ?? '');
      if (result.code !== 0 || typeof value?.path !== 'string') throw new Error('Image upload failed; staged images were kept for retry');
      return value.path;
    } finally {
      rmSync(path, { force: true });
    }
  }

  private localError(tabId: string, code: string, message: string): void {
    this.options.onEvent({ tabId, frame: { protocolVersion: 2, type: 'conversation.error', error: { code, message } } });
  }
}

function parseFrame(line: string): ConversationFrame | null {
  if (line.length < 2 || line.length > MAX_FRAME) return null;
  const value = safeJson(line);
  if (value?.protocolVersion !== 2 || !['conversation.snapshot', 'conversation.event', 'conversation.status', 'conversation.heartbeat', 'conversation.error'].includes(String(value.type))) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'providerActivity')) {
    const activity = value.providerActivity;
    if (activity !== null && (
      typeof activity !== 'object' || typeof activity.label !== 'string' || !activity.label.length || activity.label.length > 80
      || /[\u0000-\u001f\u007f]/u.test(activity.label) || !Number.isInteger(activity.elapsedSeconds)
      || activity.elapsedSeconds < 0 || activity.elapsedSeconds > 7 * 24 * 60 * 60
      || typeof activity.observedAt !== 'string' || activity.observedAt.length < 1 || activity.observedAt.length > 64
      || /[\u0000-\u001f\u007f]/u.test(activity.observedAt)
    )) return null;
  }
  return value as unknown as ConversationFrame;
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
function safeFileName(value: string): string { return value.replace(/[^A-Za-z0-9._-]/gu, '_').slice(-100) || 'image.png'; }
function publicAttachment(value: StoredAttachment): StagedAttachment { const { data: _data, ...result } = value; return result; }
function thumbnailDataUrl(value: Buffer): string {
  const image = nativeImage.createFromBuffer(value);
  if (image.isEmpty()) throw new Error('The selected image could not be decoded');
  const resized = image.resize({ width: 180, height: 120, quality: 'good' }).toPNG();
  return `data:image/png;base64,${resized.toString('base64')}`;
}
function looksLikeImage(value: Buffer): boolean {
  return value.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || value.subarray(0, 3).equals(Buffer.from([255,216,255]))
    || value.subarray(0, 6).toString('ascii').startsWith('GIF8') || value.subarray(0, 4).toString('ascii') === 'RIFF';
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
  spawnProcess: typeof spawn = spawn
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnProcess(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => { if (stdout.length < MAX_ACTION_OUTPUT) stdout += data; });
    child.stderr.on('data', (data: string) => { if (stderr.length < 64 * 1024) stderr += data; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs); timer.unref();
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code: timedOut ? -1 : code ?? -1, stdout, stderr: timedOut ? 'Action timed out' : stderr }); });
  });
}
