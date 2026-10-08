import { afterEach, expect, it, vi } from 'vitest';
import { TerminalPresentation } from '../src/renderer/src/terminal-presentation';
afterEach(() => vi.useRealTimers());

it('waits for current dimensions, parser acknowledgement and 150ms of quiet', async () => {
  vi.useFakeTimers();
  const frames: string[] = [], acks: Array<() => void> = [];
  const display = vi.fn();
  const presentation = new TerminalPresentation((data, done) => { frames.push(data); acks.push(done); }, display);
  presentation.dimensions();
  presentation.output('\x1b[31'); presentation.output('mשלום 😀\x1b[0m');
  await vi.advanceTimersByTimeAsync(200);
  expect(display).not.toHaveBeenCalledWith(false, false);
  acks.shift()!(); acks.shift()!();
  await vi.advanceTimersByTimeAsync(149);
  expect(display).not.toHaveBeenCalledWith(false, false);
  await vi.advanceTimersByTimeAsync(1);
  expect(display).toHaveBeenLastCalledWith(false, false);
  expect(frames.join('')).toBe('\x1b[31mשלום 😀\x1b[0m');
  presentation.dispose();
});

it('offers Show live for a busy terminal and reveals failures immediately', async () => {
  vi.useFakeTimers();
  const display = vi.fn();
  const presentation = new TerminalPresentation(() => {}, display);
  presentation.output('busy');
  await vi.advanceTimersByTimeAsync(2000);
  expect(display).toHaveBeenLastCalledWith(true, true);
  presentation.showLive();
  expect(display).toHaveBeenLastCalledWith(false, false);
  presentation.begin(); presentation.fail();
  expect(display).toHaveBeenLastCalledWith(false, false);
  presentation.dispose();
});

it('keeps paints hidden while new dimensions are still settling', async () => {
  vi.useFakeTimers();
  const display = vi.fn();
  const presentation = new TerminalPresentation((_data, done) => done(), display);
  presentation.dimensions(); presentation.output('initial');
  await vi.advanceTimersByTimeAsync(150);
  presentation.prepareDimensions(); presentation.output('old-size redraw');
  await vi.advanceTimersByTimeAsync(500);
  expect(display).toHaveBeenLastCalledWith(true, false);
  presentation.dimensions();
  await vi.advanceTimersByTimeAsync(150);
  expect(display).toHaveBeenLastCalledWith(false, false);
  presentation.dispose();
});
