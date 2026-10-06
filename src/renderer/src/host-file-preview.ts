import * as pdfjs from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { HostFileMetadata } from '../../shared/host-file';
import './host-file-preview.css';
pdfjs.GlobalWorkerOptions.workerSrc = worker;
interface State { metadata?: HostFileMetadata; message: string; ready: boolean; busy: boolean; url: string; text?: string; excerpt: boolean; host: string }
const api = (window as unknown as { hostFilePreview: { state(): Promise<State>; action(action: string): Promise<void>; updated(callback: () => void): void } }).hostFilePreview;
const content = document.querySelector<HTMLElement>('#content')!;
let rendered = ''; let refreshNumber = 0;
let pdf: pdfjs.PDFDocumentProxy | undefined;
let observer: IntersectionObserver | undefined;
document.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => button.addEventListener('click', () => void api.action(button.dataset.action!).then(refresh)));
api.updated(() => void refresh());
document.querySelector<HTMLInputElement>('#zoom')!.addEventListener('input', (event) => {
  const image = content.querySelector('img');
  if (image) { image.style.maxWidth = 'none'; image.style.maxHeight = 'none'; image.style.width = `${(content.clientWidth - 32) * Number((event.target as HTMLInputElement).value) / 100}px`; }
});
document.querySelector<HTMLInputElement>('#page')!.addEventListener('change', (event) => {
  const page = Math.max(1, Math.min(pdf?.numPages ?? 1, Number((event.target as HTMLInputElement).value) || 1));
  (event.target as HTMLInputElement).value = String(page);
  content.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'start' });
});
async function refresh(): Promise<void> {
  const number = ++refreshNumber;
  const state = await api.state();
  if (number !== refreshNumber) return;
  document.querySelector('#title')!.textContent = state.metadata ? `${state.metadata.name} · ${state.host}` : 'Host file preview';
  document.querySelector('#status')!.textContent = state.message + (state.excerpt ? ' · First 1 MiB shown. Save keeps the complete file.' : '');
  document.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
    button.disabled = button.dataset.action === 'close' ? false : button.dataset.action === 'cancel' ? !state.busy : state.busy || (['save', 'open'].includes(button.dataset.action!) && !state.ready);
  });
  const key = state.ready ? state.url : '';
  if (key === rendered) return;
  rendered = key; observer?.disconnect(); void pdf?.loadingTask.destroy(); pdf = undefined;
  content.replaceChildren();
  document.querySelector<HTMLElement>('#viewer-controls')!.hidden = !state.ready || !['image', 'pdf'].includes(state.metadata?.mediaKind ?? '');
  document.querySelector<HTMLElement>('#zoom-control')!.hidden = state.metadata?.mediaKind !== 'image';
  document.querySelector<HTMLElement>('#page-control')!.hidden = state.metadata?.mediaKind !== 'pdf';
  if (!state.ready || !state.metadata) return;
  if (state.metadata.mediaKind === 'image') {
    const image = document.createElement('img'); image.src = state.url; image.alt = state.metadata.name; content.append(image);
  } else if (state.metadata.mediaKind === 'html' && state.text !== undefined) {
    const frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts'); frame.title = state.metadata.name;
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">${state.text}`;
    content.append(frame);
  } else if (state.metadata.mediaKind === 'pdf') {
    const documentTask = pdfjs.getDocument({ url: state.url, disableAutoFetch: true, disableStream: true });
    let document: pdfjs.PDFDocumentProxy;
    try { document = await documentTask.promise; }
    catch { content.textContent = 'PDF preview is unavailable. Refresh, Save, or open it externally.'; return; }
    if (rendered !== key) { void document.loadingTask.destroy(); return; }
    pdf = document;
    window.document.querySelector('#pages')!.textContent = `of ${document.numPages}`;
    window.document.querySelector<HTMLInputElement>('#page')!.max = String(document.numPages);
    observer = new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) {
      observer?.unobserve(entry.target); void renderPage(document, entry.target as HTMLElement).catch(() => { entry.target.textContent = 'Page could not be rendered'; });
    } }, { root: content, rootMargin: '500px' });
    for (let page = 1; page <= document.numPages; page++) {
      const holder = window.document.createElement('section'); holder.className = 'pdf-page'; holder.dataset.page = String(page); holder.textContent = `Page ${page}`;
      content.append(holder); observer.observe(holder);
    }
  } else if (state.metadata.mediaKind === 'markdown') {
    const article = document.createElement('article');
    article.innerHTML = DOMPurify.sanitize(marked.parse(state.text ?? '', { async: false }), { FORBID_TAGS: ['img', 'iframe', 'object', 'embed', 'form', 'input', 'script', 'style'], FORBID_ATTR: ['style'] });
    article.querySelectorAll('a').forEach((link) => { link.removeAttribute('href'); }); content.append(article);
  } else if (state.metadata.mediaKind === 'text') {
    const text = document.createElement('pre'); text.textContent = state.text ?? ''; content.append(text);
  } else {
    content.textContent = state.metadata.mediaKind === 'html' ? 'This HTML file exceeds the 16 MiB preview limit. Save it or open it externally.' : 'Save this file or open it in another application.';
  }
}
async function renderPage(document: pdfjs.PDFDocumentProxy, holder: HTMLElement): Promise<void> {
  holder.setAttribute('aria-busy', 'true');
  const page = await document.getPage(Number(holder.dataset.page));
  if (!holder.isConnected) return;
  const original = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2, Math.max(0.2, (content.clientWidth - 48) / original.width)) });
  const canvas = window.document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
  holder.replaceChildren(canvas); await page.render({ canvas, viewport }).promise;
  holder.setAttribute('aria-busy', 'false');
}
void refresh();
