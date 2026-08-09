export const MAX_EXTERNAL_LINK_CHARACTERS = 2_048;

const AUTOMATIC_SCHEMES = new Set(['http', 'https']);
const BLOCKED_SCHEMES = new Set([
  'about',
  'android-app',
  'blob',
  'cmd',
  'content',
  'data',
  'file',
  'intent',
  'javascript',
  'ms-appinstaller',
  'ms-msdt',
  'ms-settings',
  'package',
  'powershell',
  'shell',
  'ssh',
  'termux',
  'wtmux'
]);

export type ExternalLinkDecision =
  | { decision: 'open' | 'confirm'; scheme: string; url: string }
  | { decision: 'block'; scheme: string };

/**
 * Classifies an untrusted Markdown target. This is intentionally shared by the
 * renderer and main process: the renderer omits blocked anchors for UX, while
 * the main process repeats the decision at the privileged boundary.
 */
export function classifyExternalLink(value: unknown): ExternalLinkDecision {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || value.length > MAX_EXTERNAL_LINK_CHARACTERS
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)
    || /%(?![0-9A-Fa-f]{2})/u.test(value)
    || /\s/u.test(value)
    || /\\/u.test(value)
    || /^(?:[A-Za-z]:|[/\\]{1,2}|~[\\/])/u.test(value)) {
    return { decision: 'block', scheme: '' };
  }

  const rawScheme = /^([A-Za-z][A-Za-z0-9+.-]{0,31}):/u.exec(value)?.[1]?.toLowerCase() ?? '';
  if (!rawScheme) return { decision: 'block', scheme: '' };
  if (BLOCKED_SCHEMES.has(rawScheme)) return { decision: 'block', scheme: rawScheme };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { decision: 'block', scheme: rawScheme };
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme !== rawScheme || url.username || url.password) return { decision: 'block', scheme };

  if (AUTOMATIC_SCHEMES.has(scheme)) {
    // WHATWG URL accepts https:///path as https://path/. Require the original
    // authority syntax so a path can never be reinterpreted as a remote host.
    if (!validWebAuthority(value, scheme) || !url.hostname) {
      return { decision: 'block', scheme };
    }
    return { decision: 'open', scheme, url: url.href };
  }

  return { decision: 'confirm', scheme, url: url.href };
}

function validWebAuthority(value: string, scheme: string): boolean {
  const prefix = `${scheme}://`;
  if (value.slice(0, prefix.length).toLowerCase() !== prefix) return false;
  const authority = value.slice(prefix.length).split(/[/?#]/u, 1)[0] ?? '';
  if (!authority || authority.includes('@')) return false;
  let port: string | null = null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    const host = authority.slice(1, close);
    if (close <= 1 || !/^[0-9A-Fa-f:.]+$/u.test(host) || !host.includes(':')) return false;
    const suffix = authority.slice(close + 1);
    if (suffix && !suffix.startsWith(':')) return false;
    port = suffix ? suffix.slice(1) : null;
  } else {
    if ((authority.match(/:/gu) ?? []).length > 1) return false;
    const colon = authority.indexOf(':');
    const host = colon < 0 ? authority : authority.slice(0, colon);
    port = colon < 0 ? null : authority.slice(colon + 1);
    if (host.length > 253 || !/^[A-Za-z0-9.-]+$/u.test(host)) return false;
    const labels = host.split('.');
    if (labels.some((label) => !label || label.length > 63
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label))) return false;
    if (labels.every((label) => /^\d+$/u.test(label))
      && (labels.length !== 4 || labels.some((label) => Number(label) > 255))) return false;
  }
  return port === null || (/^\d+$/u.test(port) && Number(port) <= 65_535);
}
