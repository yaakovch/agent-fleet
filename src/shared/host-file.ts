export interface HostFileMetadata {
  protocolVersion: 1;
  name: string;
  size: number;
  modifiedAt: string;
  revision: string;
  mediaKind: 'image' | 'pdf' | 'html' | 'markdown' | 'text' | 'other';
}

export interface HostFileReference { start: number; end: number; target: string }

/** Recognizes syntax only. The originating managed host resolves the path. */
export function hostFileTarget(value: string, explicit = false): string | null {
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  if (value.startsWith('\\\\') || value.startsWith('//')) return null;
  if (/^file:/iu.test(value)) {
    try {
      const uri = new URL(value);
      if (!value.match(/^file:\/\//iu) || uri.protocol !== 'file:' || !['', 'localhost'].includes(uri.hostname)
        || uri.search || uri.hash || /%(?![\da-f]{2})/iu.test(value)) return null;
      const decoded = decodeURIComponent(uri.pathname);
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(decoded) || decoded.startsWith('//')) return null;
      return value;
    } catch { return null; }
  }
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value) && !/^[A-Za-z]:[/\\]/u.test(value)) return null;
  if (value.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(value) || /^(?:\.\.?)[/\\]/u.test(value)) return value;
  if ((explicit || /[/\\]/u.test(value)) && /^[^<>"|?*]+\.[A-Za-z\d]{1,16}$/u.test(value)) return value;
  return null;
}

export function hostFileReferences(text: string): HostFileReference[] {
  const results: HostFileReference[] = [];
  const pattern = /(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`)|(?:file:\/\/[^\s<>"'`]+|[A-Za-z]:[/\\][^\s<>"'`]+|(?:\.{1,2}\/|\/)[^\s<>"'`]+|[A-Za-z\d_.-]+(?:[/\\][A-Za-z\d_.-]+)+\.[A-Za-z\d]{1,16})/gu;
  for (const match of text.matchAll(pattern)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    const candidate = quoted ?? match[0].replace(/[.,;:!?)\]}]+$/u, '');
    const target = hostFileTarget(candidate);
    if (!target) continue;
    const start = match.index! + (quoted === undefined ? 0 : 1);
    if (start > 0 && /[\w:/\\~%$]/u.test(text[start - 1])) continue;
    results.push({ start, end: start + candidate.length, target });
    if (results.length >= 256) break;
  }
  return results;
}

export function parseHostFileMetadata(value: unknown): HostFileMetadata {
  if (!value || typeof value !== 'object') throw new Error('Host file inspection failed');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'mediaKind,modifiedAt,name,protocolVersion,revision,size'
    || data.protocolVersion !== 1 || typeof data.name !== 'string' || !data.name || data.name.length > 255
    || /[/\\\u0000-\u001f\u007f]/u.test(data.name) || data.name === '.' || data.name === '..'
    || typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0 || data.size > 2 ** 31
    || typeof data.modifiedAt !== 'string' || !Number.isFinite(Date.parse(data.modifiedAt))
    || typeof data.revision !== 'string' || !/^[a-f\d]{64}$/u.test(data.revision)
    || !['image', 'pdf', 'html', 'markdown', 'text', 'other'].includes(String(data.mediaKind))) {
    throw new Error('Host returned invalid file metadata');
  }
  return data as unknown as HostFileMetadata;
}
