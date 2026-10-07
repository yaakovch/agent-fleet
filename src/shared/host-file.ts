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
    || /[/\\\u0000-\u001f\u007f-\u009f]/u.test(data.name) || data.name === '.' || data.name === '..'
    || typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0 || data.size > 2 ** 31
    || typeof data.modifiedAt !== 'string' || !Number.isFinite(Date.parse(data.modifiedAt))
    || typeof data.revision !== 'string' || !/^[a-f\d]{64}$/u.test(data.revision)
    || typeof data.mediaKind !== 'string'
    || !['image', 'pdf', 'html', 'markdown', 'text', 'other'].includes(data.mediaKind)) {
    throw new Error('Host returned invalid file metadata');
  }
  return data as unknown as HostFileMetadata;
}

export interface HostFileRow { text: string; wrapped?: boolean }
export interface HostFileRowReference extends HostFileReference { row: number }

// Offsets are UTF-16 units, as in the VS Code and xterm APIs. `wrapped` means
// this row continues the previous row. Hard rows require a complete delimiter.
export function hostFileRowReferences(rows: HostFileRow[]): HostFileRowReference[] {
  let text = ''; const locations: ({ row: number; column: number } | null)[] = [];
  for (let row = 0; row < rows.length; row++) {
    if (row && !rows[row].wrapped) { text += '\n'; locations.push(null); }
    for (let column = 0; column < rows[row].text.length; column++) {
      text += rows[row].text[column]; locations.push({ row, column });
    }
    if (text.length > 65536) return [];
  }
  const blocked = new Set(); const result: HostFileRowReference[] = [];
  const emit = (indices: number[], target: string) => {
    let segment: HostFileRowReference | undefined;
    for (const index of indices) {
      const location = locations[index];
      if (!location) continue;
      if (segment && segment.row === location.row && segment.end === location.column) segment.end++;
      else { segment = { row: location.row, start: location.column, end: location.column + 1, target }; result.push(segment); }
    }
  };
  const opening = /[('"`](?=(?:file:\/\/|[A-Za-z]:[/\\]|\.{1,2}[/\\]|\/|[\p{L}\p{N}_.-]+[/\\]))/gu;
  for (const match of text.matchAll(opening)) {
    const start = match.index;
    if (blocked.has(start) || (start && /[\w:/\\~%$]/u.test(text[start - 1]))) continue;
    const close = match[0] === '(' ? ')' : match[0];
    const end = text.indexOf(close, start + 1);
    const stop = end < 0 ? text.length : end + 1;
    for (let i = start; i < stop; i++) blocked.add(i);
    if (end < 0 || end - start > 8192) continue;
    const first = locations[start]; const final = locations[end];
    if (!first || !final || final.row - first.row >= 32) continue;
    const firstText = rows[first.row].text;
    const base = /^ */u.exec(firstText)![0].length;
    const listIndent = /^ *[-*•] /u.exec(firstText)?.[0].length;
    const indices = []; let candidate = ''; let valid = true;
    for (let i = start + 1; i < end; i++) {
      if (text[i] !== '\n') { candidate += text[i]; indices.push(i); continue; }
      // A space at a hard break could be filename data or layout padding.
      if (/\s$/u.test(candidate)) { valid = false; break; }
      let next = i + 1;
      while (next < end && text[next] === ' ') next++;
      const indentation = next - i - 1;
      if (indentation && !(indentation >= 2 && [base, listIndent, first.column + 1].includes(indentation))) { valid = false; break; }
      if (next === end || text[next] === '\n' || text[next] === '\t'
        || (/\.[A-Za-z\d]{1,16}$/u.test(candidate) && /^(?:file:\/\/|[A-Za-z]:[/\\]|\.{1,2}[/\\]|\/|[\p{L}\p{N}_.-]+[/\\])/u.test(text.slice(next)))) { valid = false; break; }
      i = next - 1;
    }
    // Multiple independent paths must never turn into one destination. Spaces
    // within a quoted filename are kept exactly, rather than stripped globally.
    if (!valid || candidate !== candidate.trim() || /[()'"`]/u.test(candidate)
      || /\s+(?:file:\/\/|[A-Za-z]:[/\\]|\.{1,2}[/\\]|\/)/u.test(candidate)
      || /\.[A-Za-z\d]{1,16}\s+[\p{L}\p{N}_.-]+[/\\][^\s]+\.[A-Za-z\d]{1,16}/u.test(candidate)) continue;
    const target = hostFileTarget(candidate);
    if (target) emit(indices, target);
  }
  // Ordinary extraction sees only complete automatic-wrap runs, after all
  // delimited groups (including rejected groups) have reserved their spans.
  for (let first = 0; first < rows.length;) {
    let last = first;
    while (last + 1 < rows.length && rows[last + 1].wrapped) last++;
    if (last - first < 32 && !rows[first].wrapped) {
      const indices = locations.map((location, index) => location && location.row >= first && location.row <= last ? index : -1).filter(index => index >= 0);
      const value = indices.map(index => text[index]).join('');
      for (const ref of value.length <= 8192 ? hostFileReferences(value) : []) {
        const selected = indices.slice(ref.start, ref.end);
        if (selected.every(index => !blocked.has(index))) emit(selected, ref.target);
      }
    }
    first = last + 1;
  }
  return result.sort((a, b) => a.row - b.row || a.start - b.start);
}

