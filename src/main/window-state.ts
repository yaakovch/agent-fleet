import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow, Rectangle } from 'electron';

interface SavedWindowState {
  x?: number;
  y?: number;
}

export interface SavedWindowBounds extends Rectangle {
  maximized: boolean;
}

export function loadWindowPosition(filePath: string): Pick<Rectangle, 'x' | 'y'> | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as SavedWindowState;
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function saveWindowPosition(filePath: string, window: BrowserWindow): void {
  const [x, y] = window.getPosition();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ x, y }, null, 2), 'utf8');
}

export function loadWindowBounds(filePath: string): SavedWindowBounds | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (![value.x, value.y, value.width, value.height].every((item) => typeof item === 'number' && Number.isFinite(item))) return undefined;
    const bounds = value as unknown as SavedWindowBounds;
    if (bounds.width < 640 || bounds.height < 480 || bounds.width > 10_000 || bounds.height > 10_000) return undefined;
    return { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height), maximized: value.maximized === true };
  } catch {
    return undefined;
  }
}

export function saveWindowBounds(filePath: string, window: BrowserWindow): void {
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  const value: SavedWindowBounds = { ...bounds, maximized: window.isMaximized() };
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, filePath);
}
