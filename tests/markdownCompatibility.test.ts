import { describe, expect, it } from 'vitest';
import { renderSafeMarkdownSource } from '../src/renderer/src/safe-markdown';

describe('Native Markdown compatibility', () => {
  it('preserves table headers, cells, alignment, escaped pipes and safe cell links', () => {
    const html = renderSafeMarkdownSource('| Name | Value | Notes |\n|:---|---:|:---:|\n| A\\|B | 15 | [docs](https://example.com) |');
    expect(html).toContain('<table>');
    expect(html).toContain('class="native-markdown-table" role="region" aria-label="Table" tabindex="0"');
    expect(html.match(/<th[ >]/g)).toHaveLength(3);
    expect(html.match(/<td[ >]/g)).toHaveLength(3);
    expect(html).toContain('A|B');
    expect(html).toContain('align="right"');
    expect(html).toContain('data-action="native-open-external"');
  });

  it('retains passive task states after the feed removes form inputs', () => {
    const html = renderSafeMarkdownSource('- [x] Complete\n- [ ] Pending');
    expect(html).not.toContain('<input');
    expect(html).toContain('aria-label="Completed"');
    expect(html).toContain('aria-label="Incomplete"');
    expect(html).toContain('☑');
    expect(html).toContain('☐');
  });

  it('supports strike, soft breaks, URLs, lists, quotes and alternate code fences', () => {
    const html = renderSafeMarkdownSource('~~old~~\nnew https://example.com\n\n> quote\n\n1. First\n2. Second\n\n~~~sh\necho ok\n~~~');
    expect(html).toContain('<del>old</del>');
    expect(html).toContain('<br>');
    expect(html).toContain('data-action="native-open-external"');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<pre><code>echo ok</code></pre>');
  });

  it('keeps raw HTML literal, omits remote images and blocks unsafe links', () => {
    const html = renderSafeMarkdownSource('<b>literal</b>\n\n![diagram](https://example.com/private.png)\n\n[bad](javascript:alert(1))');
    expect(html).toContain('&lt;b&gt;literal&lt;/b&gt;');
    expect(html).toContain('[Image omitted: diagram]');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
  });
});
