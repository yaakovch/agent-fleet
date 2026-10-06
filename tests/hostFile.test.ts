import { describe, expect, it } from 'vitest';
import { hostFileTarget, hostFileReferences, parseHostFileMetadata } from '../src/shared/host-file';
import { renderSafeMarkdownSource } from '../src/renderer/src/safe-markdown';
import golden from './fixtures/host-file-behavior-v1.json';
import goodMetadata from './fixtures/contracts/linked-file-v1.json';
import badMetadata from './fixtures/contracts/linked-file-unknown-field-v1.json';

describe('originating host file references', () => {
  it('matches every canonical extraction and metadata fixture', () => {
    for (const row of golden.targets) expect(hostFileTarget(row.value, row.explicit), row.value).toEqual(row.target);
    for (const row of golden.extractions) expect(hostFileReferences(row.text).map((ref) => ref.target), row.text).toEqual(row.targets);
    expect(parseHostFileMetadata(goodMetadata)).toEqual(goodMetadata);
    expect(() => parseHostFileMetadata(badMetadata)).toThrow();
  });
  it('extracts visible POSIX, Windows, relative, URI and quoted-space paths', () => {
    expect(hostFileReferences('See /tmp/report.pdf, "./reports/a b.html" and C:\\out\\result.png then file:///home/me/a.txt').map((ref) => ref.target))
      .toEqual(['/tmp/report.pdf', './reports/a b.html', 'C:\\out\\result.png', 'file:///home/me/a.txt']);
  });
  it('does not reinterpret URLs, authorities or plain prose as paths', () => {
    expect(hostFileReferences('https://example.com/private/file.txt and normal words')).toEqual([]);
    for (const ref of ['file://remote/tmp/x', 'file:///tmp/%00x', 'file:relative', 'file:///tmp/%ff', '//server/share/a', 'javascript:alert(1)', '/tmp/a\n.txt']) {
      expect(hostFileTarget(ref, true), ref).toBeNull();
    }
  });
  it('routes Markdown and code paths internally while preserving the external policy', () => {
    const html = renderSafeMarkdownSource('[Report](/tmp/a.pdf) and `./report.html` and [Docs](https://example.com)');
    expect(html.match(/native-open-file/g)).toHaveLength(2);
    expect(html).toContain('native-open-external');
    expect(renderSafeMarkdownSource('[bad](file://foreign/tmp/a.pdf)')).not.toContain('native-open-file');
  });
  it('rejects changed or incomplete metadata contracts before fetching', () => {
    const valid = { protocolVersion: 1, name: 'report.pdf', size: 123, modifiedAt: '2026-10-06T12:00:00Z', revision: 'a'.repeat(64), mediaKind: 'pdf' };
    expect(parseHostFileMetadata(valid)).toEqual(valid);
    for (const invalid of [{ ...valid, root: '/private' }, { ...valid, name: '../other' }, { ...valid, size: 2 ** 31 + 1 }, { ...valid, revision: '' }, { ...valid, mediaKind: ['pdf'] }, { ...valid, name: 'control\u0085.pdf' }]) {
      expect(() => parseHostFileMetadata(invalid)).toThrow();
    }
  });
  it('keeps explicit targets authoritative and links paths in fenced code', () => {
    const link = renderSafeMarkdownSource('[/tmp/label.txt](/tmp/target.txt)');
    expect(link.match(/native-open-file/g)).toHaveLength(1);
    expect(link).toContain('data-file-reference="/tmp/target.txt"');
    expect(renderSafeMarkdownSource('```sh\ncat /tmp/report.txt\n```')).toContain('data-file-reference="/tmp/report.txt"');
    expect(renderSafeMarkdownSource('a & b')).toContain('a &amp; b');
  });
});
