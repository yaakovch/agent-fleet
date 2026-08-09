import { marked } from 'marked';
import { classifyExternalLink } from '../../shared/external-link';

const SAFE_MARKDOWN_RENDERER = new marked.Renderer();
SAFE_MARKDOWN_RENDERER.html = ({ text }) => escapeHtml(text);
SAFE_MARKDOWN_RENDERER.image = ({ text }) => `<span class="native-markdown-image-omitted">[Image omitted: ${escapeHtml(text || 'remote image')}]</span>`;
SAFE_MARKDOWN_RENDERER.link = function ({ href, tokens }) {
  const label = this.parser.parseInline(tokens);
  const target = classifyExternalLink(href);
  if (target.decision === 'block') return label;
  const safeUrl = escapeAttribute(target.url);
  const hint = target.decision === 'open'
    ? `Open ${new URL(target.url).hostname} in your browser`
    : `Confirm opening a ${target.scheme}: link in another application`;
  return `<a href="#" title="${escapeAttribute(hint)}" data-action="native-open-external" data-workspace-action data-external-url="${safeUrl}" rel="noopener noreferrer">${label}</a>`;
};

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
