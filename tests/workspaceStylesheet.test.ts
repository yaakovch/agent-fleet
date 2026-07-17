import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workspace stylesheet contract', () => {
  it('keeps dashboard overlays out of grid sizing and stretches pane roots to the full pane tree', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'style.css'), 'utf8')
      .replace(/\s+/gu, ' ');
    expect(css).toContain('.fleet-shell > [data-dashboard-overlays] { display: contents; }');
    expect(css).toContain(
      '.workspace-pane-tree > .workspace-pane, .workspace-pane-tree > .workspace-split { width: 100%; height: 100%; }'
    );
  });

  it('uses compact pane chips and exactly one focused-pane control group', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'style.css'), 'utf8')
      .replace(/\s+/gu, ' ');
    const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'session-workspace.ts'), 'utf8');
    expect(css).toContain('.workspace-pane-chip { position: absolute;');
    expect(css).toContain('.workspace-pane-stage .terminal-session-panel { top: 34px; }');
    expect(css).not.toContain('.workspace-pane-header {');
    expect(source).not.toContain('workspace-pane-header');
    expect(source.match(/data-workspace-mode-controls/gu)).toHaveLength(1);
    expect(source.match(/workspace-actions-menu workspace-toolbar-more/gu)).toHaveLength(1);
    expect(source).toContain('data-pane-chip data-pane-drag');
  });

  it('uses an xterm sidecar for prefetched scrollback without a structured history overlay', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'style.css'), 'utf8')
      .replace(/\s+/gu, ' ');
    const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'session-workspace.ts'), 'utf8');
    expect(css).toContain('.terminal-scrollback-runtime { position: absolute; z-index: 18;');
    expect(css).not.toContain('.terminal-history {');
    expect(source).not.toContain('renderTerminalHistoryRows');
    expect(source).not.toContain('terminal-history-copy');
  });
});
