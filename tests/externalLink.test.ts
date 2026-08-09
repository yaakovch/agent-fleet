import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyExternalLink, MAX_EXTERNAL_LINK_CHARACTERS } from '../src/shared/external-link';
import { renderSafeMarkdownSource } from '../src/renderer/src/safe-markdown';

interface LinkFixture {
  externalLinks: {
    maxCharacters: number;
    lengthMetric: string;
    automaticSchemes: string[];
    blockedSchemes: string[];
    otherRegisteredSchemes: string;
    cases: Array<{ id: string; value: string; decision: 'open' | 'confirm' | 'block'; scheme: string }>;
  };
}

const fixture = JSON.parse(readFileSync('tests/fixtures/client-behavior-v1.json', 'utf8')) as LinkFixture;

describe('external link policy', () => {
  it('matches every canonical client behavior case', () => {
    expect(MAX_EXTERNAL_LINK_CHARACTERS).toBe(fixture.externalLinks.maxCharacters);
    for (const item of fixture.externalLinks.cases) {
      const result = classifyExternalLink(item.value);
      expect({ decision: result.decision, scheme: result.scheme }, item.id).toEqual({
        decision: item.decision,
        scheme: item.scheme
      });
    }
    for (const scheme of fixture.externalLinks.blockedSchemes) {
      const result = classifyExternalLink(`${scheme}:example`);
      expect({ decision: result.decision, scheme: result.scheme }, scheme).toEqual({ decision: 'block', scheme });
    }
    for (const scheme of fixture.externalLinks.automaticSchemes) {
      const result = classifyExternalLink(`${scheme}://example.com`);
      expect({ decision: result.decision, scheme: result.scheme }, scheme).toEqual({ decision: 'open', scheme });
    }
    expect(fixture.externalLinks.otherRegisteredSchemes).toBe('confirm-every-time');
  });

  it('bounds targets before URL parsing', () => {
    const prefix = 'https://example.com/';
    expect(fixture.externalLinks.lengthMetric).toBe('utf16-code-units');
    expect(classifyExternalLink(`${prefix}${'a'.repeat(MAX_EXTERNAL_LINK_CHARACTERS - prefix.length)}`).decision).toBe('open');
    expect(classifyExternalLink(`${prefix}${'a'.repeat(MAX_EXTERNAL_LINK_CHARACTERS + 1 - prefix.length)}`).decision).toBe('block');
    expect(classifyExternalLink(`${prefix}${'😀'.repeat(1_014)}`).decision).toBe('open');
    expect(classifyExternalLink(`${prefix}${'😀'.repeat(1_015)}`).decision).toBe('block');
    expect(classifyExternalLink('C:private.txt').decision).toBe('block');
  });
});

describe('safe Markdown source rendering', () => {
  it('routes accepted Markdown links through the privileged external-link action', () => {
    const html = renderSafeMarkdownSource('[Documentation](https://example.com/docs?q=a&b=c)');
    expect(html).toContain('data-action="native-open-external"');
    expect(html).toContain('data-workspace-action');
    expect(html).toContain('href="#"');
    expect(html).not.toContain('href="https://');
    expect(html).toContain('title="Open example.com in your browser"');
    expect(html).toContain('data-external-url="https://example.com/docs?q=a&amp;b=c"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders unsafe targets as text instead of anchors', () => {
    const html = renderSafeMarkdownSource('[Run this](javascript:alert(1)) and [pair](wtmux://pair)');
    expect(html).toContain('Run this');
    expect(html).toContain('pair');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('wtmux://');
  });

  it('never parses raw HTML or loads Markdown images', () => {
    const html = renderSafeMarkdownSource('<a href="https://example.com">raw</a>\n\n<script>alert(1)</script>\n\n![private](https://example.com/tracker.png)');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<a href="https://example.com">raw</a>');
    expect(html).toContain('&lt;a href=&quot;https://example.com&quot;&gt;raw&lt;/a&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('Image omitted: private');
  });
});
