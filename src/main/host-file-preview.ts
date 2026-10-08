import { BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { FleetDownloadManager } from './fleet-download';
import { publishVerifiedCopy } from './host-file-save';
import { resolveWslExecutable } from './fleet-terminal';
import { activatedRuntimeCommand } from '../shared/runtime';
import { hostFileTarget, parseHostFileMetadata, type HostFileMetadata } from '../shared/host-file';
import type { WslProcessOwnership } from './wsl-process-ownership';
import type { FleetDownloadJob } from '../shared/app';

protocol.registerSchemesAsPrivileged([{ scheme: 'fleet-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

interface PreviewOptions {
  acquireLinux?: () => () => void;
  readyLinux?: () => Promise<void>;
  cacheDirectory: string;
  downloadsDirectory: () => string;
  distro: () => string;
  processOwnership: WslProcessOwnership;
}
interface Preview {
  id: string;
  window: BrowserWindow;
  session: { id: string; hostId: string; internalName: string };
  reference: string;
  directory: string;
  metadata?: HostFileMetadata;
  manager: FleetDownloadManager;
  job?: FleetDownloadJob;
  message: string;
  generation: number;
  abort?: AbortController;
  busy: boolean;
  closed: boolean;
  operations: Set<Promise<unknown>>;
}

export class HostFilePreviewManager {
  private readonly previews = new Map<number, Preview>();
  constructor(private readonly options: PreviewOptions) {
    ipcMain.handle('hostFilePreview:state', (event) => { const preview = this.owner(event.sender.id, event.senderFrame === event.sender.mainFrame); return this.track(preview, this.state(preview)); });
    ipcMain.handle('hostFilePreview:action', (event, action: unknown) => {
      const preview = this.owner(event.sender.id, event.senderFrame === event.sender.mainFrame);
      return this.track(preview, (async () => {
      if (!['refresh', 'save', 'open', 'close', 'cancel'].includes(String(action))) throw new Error('Invalid preview action');
      if (action === 'close') { preview.window.close(); return; }
      if (action === 'cancel') {
        if (preview.busy && preview.job?.state === 'completed') return this.state(preview);
        ++preview.generation; preview.abort?.abort();
        if (preview.job) await preview.manager.cancel(preview.job.id);
        preview.job = undefined; preview.busy = false;
        await rm(preview.directory, { recursive: true, force: true });
        preview.message = 'Transfer cancelled. Refresh to retry.'; this.update(preview); return this.state(preview);
      }
      if (preview.busy) return this.state(preview);
      if (action === 'refresh') { void this.trackLinux(preview, () => this.refresh(preview)); return this.state(preview); }
      preview.busy = true;
      try {
        const job = preview.job;
        const artifact = job && await preview.manager.verifiedArtifact(job.id);
        if (!job || !artifact) throw new Error('Fetch the current host file before using it.');
        if (action === 'save') {
          const destination = await publishVerifiedCopy(artifact.path, this.options.downloadsDirectory(), job.name, artifact.size, artifact.sha256);
          preview.message = `Saved to ${destination}`;
        } else {
          // External programs may read lazily. Keep a separate, expiring private lease.
          const lease = join(this.options.cacheDirectory, 'external', randomUUID());
          await mkdir(lease, { recursive: true });
          const destination = await publishVerifiedCopy(artifact.path, lease, job.name, artifact.size, artifact.sha256);
          const error = await shell.openPath(destination);
          if (error) { await rm(lease, { recursive: true, force: true }); throw new Error(error); }
          preview.message = 'Opened in another application';
        }
      } catch (error) { preview.message = message(error); }
      finally { preview.busy = false; this.update(preview); }
      return this.state(preview);
      })());
    });
  }

  async open(session: Preview['session'], reference: string): Promise<void> {
    if (this.previews.size >= 4) throw new Error('Close a file preview before opening another.');
    if (!hostFileTarget(reference, true)) throw new Error('This is not a supported host file reference');
    await this.expireLeases();
    const id = randomUUID();
    const directory = join(this.options.cacheDirectory, 'previews', id);
    await mkdir(directory, { recursive: true });
    const window = new BrowserWindow({ width: 1060, height: 780, title: 'Host file preview',
      webPreferences: { preload: join(import.meta.dirname, '../preload/host-file-preview.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
        partition: `host-file-preview-${id}` } });
    const preview: Preview = { id, window, session: { ...session }, reference, directory,
      message: 'Inspecting current host file…', generation: 0, busy: false, closed: false, operations: new Set(),
      manager: new FleetDownloadManager({ distro: this.options.distro, downloadsDirectory: () => directory,
        processOwnership: this.options.processOwnership, acquireLinux: this.options.acquireLinux, maxConcurrent: 1, maxQueued: 0,
        onUpdate: (job) => { preview.job = job; preview.message = job.state === 'completed' ? 'Verified current host file' : job.message; this.update(preview); } }) };
    const senderId = window.webContents.id;
    this.previews.set(senderId, preview);
    const sessionPartition = window.webContents.session;
    sessionPartition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    const rendererRoot = resolve(import.meta.dirname, '../renderer');
    sessionPartition.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const url = new URL(details.url);
      let allowed = !['http:', 'https:', 'ftp:', 'ws:', 'wss:'].includes(url.protocol);
      if (url.protocol === 'file:') {
        const path = resolve(fileURLToPath(url));
        allowed = details.resourceType !== 'subFrame' && (path === join(rendererRoot, 'host-file-preview.html') || path.startsWith(join(rendererRoot, 'assets') + sep));
      }
      callback({ cancel: !allowed });
    });
    sessionPartition.protocol.handle('fleet-preview', async (request) => {
      const url = new URL(request.url);
      const job = preview.job;
      if (url.hostname !== id || url.pathname !== '/content' || !job?.path || job.state !== 'completed' || preview.closed) return new Response(null, { status: 404 });
      const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.get('range') ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), job.total - 1) : job.total - 1;
      if (start < 0 || start > end || end >= job.total) return job.total === 0 ? new Response('') : new Response(null, { status: 416 });
      const headers: Record<string, string> = { 'Content-Type': preview.metadata?.mediaKind === 'pdf' ? 'application/pdf' : imageMime(job.name),
        'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${job.total}`;
      return new Response(Readable.toWeb(createReadStream(job.path, { start, end })) as ReadableStream, { status: range ? 206 : 200, headers });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-frame-navigate', (event) => { if (!['about:blank', 'about:srcdoc'].includes(event.url)) event.preventDefault(); });
    window.on('closed', () => { preview.closed = true; this.previews.delete(senderId); preview.abort?.abort();
      void Promise.allSettled([preview.manager.stop(), ...preview.operations]).then(() => rm(directory, { recursive: true, force: true })); });
    await window.loadFile(join(import.meta.dirname, '../renderer/host-file-preview.html'));
    void this.trackLinux(preview, () => this.refresh(preview));
  }

  async stop(): Promise<void> {
    const previews = [...this.previews.values()];
    for (const preview of previews) { preview.abort?.abort(); if (!preview.window.isDestroyed()) preview.window.close(); }
    await Promise.all(previews.map((preview) => Promise.allSettled([preview.manager.stop(), ...preview.operations])));
  }

  private track<T>(preview: Preview, operation: Promise<T>): Promise<T> {
    preview.operations.add(operation);
    void operation.finally(() => { preview.operations.delete(operation); }).catch(() => undefined);
    return operation;
  }
  private trackLinux<T>(preview: Preview, operation: () => Promise<T>): Promise<T> {
    const release = this.options.acquireLinux?.();
    const pending = (async () => {
      try { await this.options.readyLinux?.(); return await operation(); }
      finally { release?.(); }
    })();
    return this.track(preview, pending);
  }
  private owner(senderId: number, mainFrame: boolean): Preview {
    const preview = this.previews.get(senderId);
    if (!preview || !mainFrame || preview.closed) throw new Error('Preview is no longer available');
    return preview;
  }

  private async refresh(preview: Preview): Promise<void> {
    if (preview.busy || preview.closed) return;
    preview.busy = true;
    const generation = ++preview.generation;
    preview.abort?.abort();
    preview.abort = new AbortController();
    try {
      if (preview.job) await preview.manager.cancel(preview.job.id);
      preview.job = undefined;
      await rm(preview.directory, { recursive: true, force: true });
      await mkdir(preview.directory, { recursive: true });
      preview.message = 'Inspecting current host file…'; this.update(preview);
      const metadata = await this.inspect(preview, preview.abort.signal);
      if (preview.closed || generation !== preview.generation) return;
      preview.metadata = metadata;
      preview.window.setTitle(`${metadata.name} — ${preview.session.hostId}`);
      if (metadata.size > 50 * 1024 * 1024) {
        const answer = await dialog.showMessageBox(preview.window, { type: 'question', buttons: ['Fetch file', 'Cancel'], defaultId: 1, cancelId: 1,
          message: `Fetch ${metadata.name}?`, detail: `This file is ${(metadata.size / 1024 / 1024).toFixed(1)} MiB. It will be copied privately for preview.` });
        if (answer.response !== 0) { preview.message = 'Transfer cancelled. Refresh to retry.'; return; }
      }
      if (preview.closed || preview.abort.signal.aborted || generation !== preview.generation) return;
      preview.job = preview.manager.start({ sessionId: preview.session.id, hostId: preview.session.hostId, internalName: preview.session.internalName,
        relativePath: preview.reference, name: metadata.name, localName: portableHostFileName(metadata.name), size: metadata.size, expectedRevision: metadata.revision });
    } catch (error) { if (!preview.closed && generation === preview.generation) preview.message = message(error); }
    finally { if (generation === preview.generation) preview.busy = false; this.update(preview); }
  }

  private inspect(preview: Preview, signal: AbortSignal): Promise<HostFileMetadata> {
    return new Promise((resolve, reject) => {
      const child = spawn(resolveWslExecutable(), ['-d', this.options.distro(), '--cd', '~', '--', activatedRuntimeCommand('wtmux'), 'file', 'inspect',
        '--host', preview.session.hostId, '--session', preview.session.internalName, '--path', preview.reference], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
      this.options.processOwnership.own(`file-inspect:${preview.id}`, child);
      let output = ''; let overflow = false;
      const decoder = new StringDecoder('utf8');
      const timer = setTimeout(() => { child.kill(); reject(new Error('Host inspection timed out. Refresh to retry.')); }, 30_000);
      child.stdout.on('data', (chunk: Buffer) => { output += decoder.write(chunk); if (output.length > 8192) { overflow = true; child.kill(); } });
      child.stderr.on('data', () => undefined);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => { clearTimeout(timer); try {
        output += decoder.end();
        const value = JSON.parse(output);
        if (overflow || code !== 0) throw new Error(value?.error?.message || 'Host file is unavailable. Refresh to retry.');
        resolve(parseHostFileMetadata(value));
      } catch (error) { reject(error); } });
    });
  }

  private async state(preview: Preview): Promise<unknown> {
    const ready = preview.job?.state === 'completed' && preview.job.path;
    const metadata = preview.metadata;
    let text: string | undefined;
    if (ready && metadata && ['text', 'markdown', 'html'].includes(metadata.mediaKind)) {
      const maximum = metadata.mediaKind === 'html' ? 16 * 1024 * 1024 : 1024 * 1024;
      if (metadata.mediaKind !== 'html' || metadata.size <= maximum) {
        const file = await open(String(ready), 'r');
        try { const buffer = Buffer.alloc(Math.min(metadata.size, maximum)); const result = await file.read(buffer, 0, buffer.length, 0); text = buffer.subarray(0, result.bytesRead).toString('utf8'); }
        finally { await file.close(); }
      }
    }
    return { metadata, message: preview.message, ready: Boolean(ready), busy: preview.busy || preview.job?.state === 'running',
      url: ready ? `fleet-preview://${preview.id}/content?generation=${preview.generation}` : '', text,
      excerpt: metadata && ['text', 'markdown'].includes(metadata.mediaKind) && metadata.size > 1024 * 1024,
      host: preview.session.hostId };
  }

  private update(preview: Preview): void { if (!preview.closed && !preview.window.isDestroyed()) preview.window.webContents.send('hostFilePreview:updated'); }
  private async expireLeases(): Promise<void> {
    const activeIds = new Set([...this.previews.values()].map((preview) => preview.id));
    for (const kind of ['external', 'previews']) {
      const root = join(this.options.cacheDirectory, kind);
      for (const name of await readdir(root).catch(() => [])) {
        if (kind === 'previews' && activeIds.has(name)) continue;
        const path = join(root, name);
        const info = await stat(path).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000) await rm(path, { recursive: true, force: true });
      }
    }
  }
}

function imageMime(name: string): string {
  const extension = name.toLowerCase().split('.').at(-1);
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream';
}
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 400) : 'Host file is unavailable. Refresh to retry.'; }
function portableHostFileName(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/gu, '_').replace(/[. ]+$/u, '');
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)/iu.test(safe) ? `_${safe}` : safe || 'host-file';
}
