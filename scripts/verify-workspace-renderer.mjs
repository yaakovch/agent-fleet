import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const port = Number(process.argv[2] ?? 9222);
const outputDirectory = resolve(process.argv[3] ?? 'dist');
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.endsWith('#dashboard'));
if (!target?.webSocketDebuggerUrl) throw new Error('Agent Fleet dashboard debugging target was not found');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolveCommand, reject) => {
    pending.set(id, { resolve: resolveCommand, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result.value;
}

const pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));

async function click(selector) {
  const clicked = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`);
  if (!clicked) throw new Error(`Renderer control not found: ${selector}`);
  await pause(900);
}

async function openWorkspace() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await evaluate("Boolean(document.querySelector('.workspace-pane-tree'))")) {
      await pause(900);
      return;
    }
    if (await evaluate("Boolean(document.querySelector('[data-action=\"dashboard-nav\"][data-view=\"workspace\"]'))")) {
      await click('[data-action="dashboard-nav"][data-view="workspace"]');
    } else await pause(750);
  }
  throw new Error('Session Workspace did not become available');
}

async function report(label) {
  const value = await evaluate(`(() => {
    const shell = document.querySelector('.fleet-shell');
    const fleetWorkspace = document.querySelector('.fleet-workspace');
    const content = document.querySelector('.fleet-content.is-workspace');
    const mount = document.querySelector('.workspace-mount');
    const session = document.querySelector('.session-workspace');
    const tree = document.querySelector('.workspace-pane-tree');
    const root = tree?.firstElementChild;
    const pane = document.querySelector('.workspace-pane.focused') ?? document.querySelector('.workspace-pane');
    const stage = pane?.querySelector('.workspace-pane-stage');
    const activeMode = document.querySelector('[data-workspace-mode-controls] button.active')?.dataset.mode ?? '';
    const panel = activeMode === 'terminal'
      ? pane.querySelector('.terminal-session-panel') : pane?.querySelector('.native-session-panel');
    const runtime = pane?.querySelector('.xterm-runtime');
    const rect = (element) => element ? {
      x: element.getBoundingClientRect().x,
      y: element.getBoundingClientRect().y,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height
    } : null;
    const style = tree ? getComputedStyle(tree) : null;
    const contentStyle = content ? getComputedStyle(content) : null;
    const contentInner = content && contentStyle ? {
      x: content.getBoundingClientRect().x + parseFloat(contentStyle.paddingLeft),
      y: content.getBoundingClientRect().y + parseFloat(contentStyle.paddingTop),
      width: content.clientWidth - parseFloat(contentStyle.paddingLeft) - parseFloat(contentStyle.paddingRight),
      height: content.clientHeight - parseFloat(contentStyle.paddingTop) - parseFloat(contentStyle.paddingBottom)
    } : null;
    const inner = tree && style ? {
      width: tree.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: tree.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    } : null;
    return {
      label: ${JSON.stringify(label)},
      viewport: { width: innerWidth, height: innerHeight },
      panes: document.querySelectorAll('.workspace-pane').length,
      assigned: document.querySelectorAll('.workspace-pane[data-tab-id]').length,
      chips: document.querySelectorAll('[data-pane-chip]').length,
      paneHeaders: document.querySelectorAll('.workspace-pane-header').length,
      modeControls: document.querySelectorAll('[data-workspace-mode-controls]').length,
      moreMenus: document.querySelectorAll('.workspace-toolbar-more').length,
      historyModeControls: document.querySelectorAll('.terminal-history-modes').length,
      historyMode: document.querySelector('.terminal-history-modes button.active')?.dataset.historyMode ?? '',
      historyOpen: Boolean(pane?.querySelector('[data-terminal-history]')),
      historyRuntimePreserved: !globalThis.__agentFleetHistoryRuntime || globalThis.__agentFleetHistoryRuntime === runtime,
      rootKind: root?.classList.contains('workspace-split') ? root.dataset.splitDirection : root?.classList.contains('workspace-pane') ? 'pane' : '',
      activeMode,
      status: document.querySelector('[data-workspace-toolbar-context]')?.textContent ?? '',
      shell: rect(shell), fleetWorkspace: rect(fleetWorkspace), contentInner,
      mount: rect(mount), session: rect(session),
      treeInner: inner, moreActions: [...document.querySelectorAll('.workspace-toolbar-more button')].map((item) => item.textContent?.trim()),
      root: rect(root), pane: rect(pane), chip: rect(pane?.querySelector('[data-pane-chip]')), stage: rect(stage), panel: rect(panel), runtime: rect(runtime),
      terminalSurface: rect(pane?.querySelector('.xterm')),
      terminalScreen: rect(pane?.querySelector('.xterm-screen')),
      opening: Boolean(pane?.querySelector('.workspace-opening-session'))
    };
  })()`);
  assertFullRoot(value);
  return value;
}

function assertFullRoot(value) {
  if (!value.shell || !value.fleetWorkspace || Math.abs(value.viewport.height - value.shell.height) > 1
    || Math.abs(value.viewport.height - value.fleetWorkspace.height) > 1) {
    throw new Error(`${value.label}: workspace shell does not fill the viewport: ${JSON.stringify(value)}`);
  }
  if (!value.contentInner || !value.mount || !value.session
    || Math.abs(value.contentInner.width - value.mount.width) > 1
    || Math.abs(value.contentInner.height - value.mount.height) > 1
    || Math.abs(value.contentInner.x - value.mount.x) > 1
    || Math.abs(value.contentInner.y - value.mount.y) > 1
    || Math.abs(value.mount.width - value.session.width) > 1
    || Math.abs(value.mount.height - value.session.height) > 1) {
    throw new Error(`${value.label}: workspace mount does not fill dashboard content: ${JSON.stringify(value)}`);
  }
  if (!value.treeInner || !value.root || Math.abs(value.treeInner.width - value.root.width) > 1
    || Math.abs(value.treeInner.height - value.root.height) > 1) {
    throw new Error(`${value.label}: pane-tree root does not fill its available area: ${JSON.stringify(value)}`);
  }
  if (value.modeControls !== 1 || value.moreMenus !== 1 || value.paneHeaders !== 0 || value.chips !== value.panes) {
    throw new Error(`${value.label}: focused-pane chrome was duplicated or incomplete: ${JSON.stringify(value)}`);
  }
  if (!value.stage || value.stage.width < 200 || value.stage.height < 200 || !value.panel
    || Math.abs(value.stage.width - value.panel.width) > 1) {
    throw new Error(`${value.label}: active pane content does not fill the pane stage: ${JSON.stringify(value)}`);
  }
  const expectedInset = value.activeMode === 'terminal' ? 34 : 0;
  if (Math.abs(value.stage.height - value.panel.height - expectedInset) > 1
    || Math.abs(value.panel.y - value.stage.y - expectedInset) > 1
    || value.activeMode === 'terminal' && value.chip && value.panel.y < value.chip.y + value.chip.height) {
    throw new Error(`${value.label}: pane chip clearance is incorrect: ${JSON.stringify(value)}`);
  }
}

async function screenshot(name) {
  const result = await command('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(join(outputDirectory, name), Buffer.from(result.data, 'base64'));
}

await openWorkspace();
let initial = await report('initial');
if (initial.panes !== 1 || initial.assigned !== 1) {
  await click('[data-action="workspace-preset"][data-preset="single"]');
  initial = await report('initial-single');
}
if (initial.panes !== 1 || initial.assigned !== 1) {
  throw new Error(`Live layout could not enter one assigned pane: ${JSON.stringify(initial)}`);
}
const originalMode = initial.activeMode;
const results = [initial];

try {
  if (!initial.moreActions.includes('Detach from pane')) throw new Error(`Focused More menu lacks Detach: ${JSON.stringify(initial)}`);
  if (initial.activeMode !== 'native') await click('[data-workspace-mode-controls] [data-mode="native"]');
  results.push(await report('native'));
  await screenshot('workspace-beta15-gaming-native.png');

  await click('[data-workspace-mode-controls] [data-mode="terminal"]');
  const terminal = await report('terminal');
  if (!terminal.runtime || !terminal.terminalSurface || !terminal.terminalScreen) throw new Error(`Terminal runtime was not mounted: ${JSON.stringify(terminal)}`);
  if (terminal.historyModeControls !== 1 || terminal.historyMode !== 'history') {
    throw new Error(`Eligible terminal lacks one focused History/Remote control: ${JSON.stringify(terminal)}`);
  }
  results.push(terminal);
  await screenshot('workspace-beta15-gaming-terminal.png');

  const captured = await evaluate(`(() => {
    const runtime = document.querySelector('.workspace-pane.focused .xterm-runtime');
    if (!(runtime instanceof HTMLElement)) return false;
    globalThis.__agentFleetHistoryRuntime = runtime;
    const event = new WheelEvent('wheel', { deltaY: -180, bubbles: true, cancelable: true });
    runtime.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  if (!captured) await click('.terminal-history-modes [data-history-mode="history"]');
  await pause(500);
  const history = await report('local-history');
  if (!history.historyOpen || !history.historyRuntimePreserved) {
    throw new Error(`Local History did not open without replacing xterm: ${JSON.stringify(history)}`);
  }
  history.scrollCaptured = captured;
  results.push(history);
  await screenshot('workspace-beta15-gaming-history.png');
  await click('[data-terminal-history] [data-action="terminal-history-remote"]');
  const remote = await report('remote-scroll-mode');
  if (remote.historyOpen || remote.historyMode !== 'remote' || !remote.historyRuntimePreserved) {
    throw new Error(`Remote mode did not restore the live xterm: ${JSON.stringify(remote)}`);
  }
  results.push(remote);
  await click('.terminal-history-modes [data-history-mode="history"]');
  const reopenedHistory = await report('history-button');
  if (!reopenedHistory.historyOpen || !reopenedHistory.historyRuntimePreserved) {
    throw new Error(`History button did not reopen the preserved local reader: ${JSON.stringify(reopenedHistory)}`);
  }
  results.push(reopenedHistory);
  await click('[data-terminal-history] [data-action="terminal-history-live"]');

  await command('Emulation.setDeviceMetricsOverride', { width: 1180, height: 760, deviceScaleFactor: 1, mobile: false });
  await pause(900);
  const compact = await report('compact-resize');
  await command('Emulation.setDeviceMetricsOverride', { width: 1500, height: 960, deviceScaleFactor: 1, mobile: false });
  await pause(900);
  const expanded = await report('expanded-resize');
  if (compact.runtime?.width === expanded.runtime?.width && compact.runtime?.height === expanded.runtime?.height) {
    throw new Error('Visible xterm dimensions did not change after window resize');
  }
  results.push(compact, expanded);

  await click('[data-action="workspace-rail-collapse"]');
  const collapsedRail = await report('collapsed-rail');
  if (collapsedRail.runtime?.width === expanded.runtime?.width) {
    throw new Error('Visible xterm width did not change after session-rail resize');
  }
  results.push(collapsedRail);
  await click('[data-action="workspace-rail-collapse"]');

  await command('Page.reload');
  await pause(3_000);
  await openWorkspace();
  const reloaded = await report('reload-reconnect');
  if (!reloaded.runtime || reloaded.opening) throw new Error(`Terminal did not restore after reload: ${JSON.stringify(reloaded)}`);
  results.push(reloaded);

  for (const [preset, expectedKind, expectedPanes] of [
    ['two-columns', 'row', 2], ['two-rows', 'column', 2], ['grid', 'column', 4]
  ]) {
    await click(`[data-action="workspace-preset"][data-preset="${preset}"]`);
    const layout = await report(preset);
    if (layout.rootKind !== expectedKind || layout.panes !== expectedPanes) {
      throw new Error(`${preset} layout did not render as expected: ${JSON.stringify(layout)}`);
    }
    results.push(layout);
  }
  await screenshot('workspace-beta15-gaming-grid.png');
} finally {
  if (await evaluate("Boolean(document.querySelector('[data-action=\"workspace-preset\"][data-preset=\"single\"]'))")) {
    await click('[data-action="workspace-preset"][data-preset="single"]');
  }
  if (originalMode === 'native' && await evaluate("Boolean(document.querySelector('[data-workspace-mode-controls] [data-mode=\"native\"]'))")) {
    await click('[data-workspace-mode-controls] [data-mode="native"]');
  }
  await command('Emulation.clearDeviceMetricsOverride');
  socket.close();
}

console.log(JSON.stringify({ passed: true, results }, null, 2));
