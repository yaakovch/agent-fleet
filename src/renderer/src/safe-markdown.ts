import { marked } from 'marked';
import { classifyExternalLink } from '../../shared/external-link';
import { hostFileTarget, hostFileReferences } from '../../shared/host-file';

const SAFE_MARKDOWN_RENDERER = new marked.Renderer();
let linkLabelDepth = 0;
SAFE_MARKDOWN_RENDERER.html = ({ text }) => escapeHtml(text);
SAFE_MARKDOWN_RENDERER.image = ({ text }) => `<span class="native-markdown-image-omitted">[Image omitted: ${escapeHtml(text || 'remote image')}]</span>`;
SAFE_MARKDOWN_RENDERER.link = function ({ href, tokens }) {
  let label: string;
  ++linkLabelDepth;
  try { label = this.parser.parseInline(tokens); } finally { --linkLabelDepth; }
  const file = hostFileTarget(href, true);
  if (file) return fileAnchor(file, label);
  const target = classifyExternalLink(href);
  if (target.decision === 'block') return label;
  const safeUrl = escapeAttribute(target.url);
  const hint = target.decision === 'open'
    ? `Open ${new URL(target.url).hostname} in your browser`
    : `Confirm opening a ${target.scheme}: link in another application`;
  return `<a href="#" title="${escapeAttribute(hint)}" data-action="native-open-external" data-workspace-action data-external-url="${safeUrl}" rel="noopener noreferrer">${label}</a>`;
};
SAFE_MARKDOWN_RENDERER.codespan = ({ text }) => `<code>${linkLabelDepth ? escapeHtml(text) : linkedText(text)}</code>`;
SAFE_MARKDOWN_RENDERER.text = (token) => 'escaped' in token && token.escaped ? token.text : linkLabelDepth ? escapeHtml(token.text) : linkedText(token.text);
SAFE_MARKDOWN_RENDERER.code = ({ text }) => `<pre><code>${linkedText(text)}</code></pre>`;

function fileAnchor(target: string, label: string): string {
  return `<a href="#" title="Preview file from this session's host" data-action="native-open-file" data-workspace-action data-file-reference="${escapeAttribute(target)}">${label}</a>`;
}

export function linkedText(text: string): string {
  let end = 0;
  let html = '';
  for (const ref of hostFileReferences(text)) {
    html += escapeHtml(text.slice(end, ref.start)) + fileAnchor(ref.target, escapeHtml(text.slice(ref.start, ref.end)));
    end = ref.end;
  }
  return html + escapeHtml(text.slice(end));
}

/**
 * Produces Markdown HTML with no raw-HTML execution path, no remote images,
 * and anchors only for targets accepted by the shared external-link policy.
 * The caller still sanitizes the result as a second line of defense.
 */
export function renderSafeMarkdownSource(value: string): string {
  return marked.parse(value, { async: false, gfm: true, breaks: true, renderer: SAFE_MARKDOWN_RENDERER });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
