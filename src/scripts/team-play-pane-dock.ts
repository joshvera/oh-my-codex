#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface CliOptions {
  gameCwd: string;
  windowTitle: string;
  logicalWidth: number;
  logicalHeight: number;
}

interface XWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FrameExtents {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface PaneMetrics {
  paneLeft: number;
  paneTop: number;
  paneWidth: number;
  paneHeight: number;
  windowWidth: number;
  windowHeight: number;
}

function parseArgs(argv: string[]): CliOptions {
  let gameCwd = '';
  let windowTitle = 'Rust Dino';
  let logicalWidth = 1280;
  let logicalHeight = 360;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--game-cwd' && next) {
      gameCwd = next;
      i += 1;
    } else if (arg === '--window-title' && next) {
      windowTitle = next;
      i += 1;
    } else if (arg === '--logical-width' && next) {
      logicalWidth = Number.parseInt(next, 10) || logicalWidth;
      i += 1;
    } else if (arg === '--logical-height' && next) {
      logicalHeight = Number.parseInt(next, 10) || logicalHeight;
      i += 1;
    }
  }
  if (!gameCwd) {
    throw new Error('missing required --game-cwd');
  }
  return { gameCwd, windowTitle, logicalWidth, logicalHeight };
}

function commandExists(command: string): boolean {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], {
    encoding: 'utf-8',
    stdio: 'ignore',
  });
  return (result.status ?? 1) === 0;
}

function runText(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    }).trim();
  } catch {
    return null;
  }
}

function parseIntStrict(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readActiveWindowId(): string | null {
  const raw = runText('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
  const match = raw?.match(/window id # (0x[0-9a-f]+)/i);
  return match?.[1] ?? null;
}

function readXWindowGeometry(windowId: string): XWindowGeometry | null {
  const raw = runText('xwininfo', ['-id', windowId]);
  if (!raw) return null;
  const x = parseIntStrict(raw.match(/Absolute upper-left X:\s+(-?\d+)/)?.[1]);
  const y = parseIntStrict(raw.match(/Absolute upper-left Y:\s+(-?\d+)/)?.[1]);
  const width = parseIntStrict(raw.match(/Width:\s+(\d+)/)?.[1]);
  const height = parseIntStrict(raw.match(/Height:\s+(\d+)/)?.[1]);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function readPaneMetrics(paneId: string): PaneMetrics | null {
  const raw = runText('tmux', [
    'display-message',
    '-p',
    '-t',
    paneId,
    '#{pane_left} #{pane_top} #{pane_width} #{pane_height} #{window_width} #{window_height}',
  ]);
  if (!raw) return null;
  const [paneLeft, paneTop, paneWidth, paneHeight, windowWidth, windowHeight] = raw
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));
  const values = [paneLeft, paneTop, paneWidth, paneHeight, windowWidth, windowHeight];
  if (values.some((value) => !Number.isFinite(value))) return null;
  return { paneLeft, paneTop, paneWidth, paneHeight, windowWidth, windowHeight };
}

function fitAspectWithinRect(rect: XWindowGeometry, logicalWidth: number, logicalHeight: number): XWindowGeometry {
  const aspect = logicalWidth / logicalHeight;
  let width = rect.width;
  let height = Math.round(width / aspect);
  if (height > rect.height) {
    height = rect.height;
    width = Math.round(height * aspect);
  }
  width = Math.max(320, Math.min(width, rect.width));
  height = Math.max(90, Math.min(height, rect.height));
  const x = rect.x + Math.floor((rect.width - width) / 2);
  const y = rect.y + Math.floor((rect.height - height) / 2);
  return { x, y, width, height };
}

function defaultFrameExtents(): FrameExtents {
  return { left: 14, right: 14, top: 49, bottom: 17 };
}

function fitInnerWindowWithinOuterRect(
  outerRect: XWindowGeometry,
  logicalWidth: number,
  logicalHeight: number,
  extents: FrameExtents,
): XWindowGeometry {
  const innerBounds: XWindowGeometry = {
    x: outerRect.x + extents.left,
    y: outerRect.y + extents.top,
    width: Math.max(320, outerRect.width - extents.left - extents.right),
    height: Math.max(90, outerRect.height - extents.top - extents.bottom),
  };
  return fitAspectWithinRect(innerBounds, logicalWidth, logicalHeight);
}

function expandInnerRectToOuterRect(innerRect: XWindowGeometry, extents: FrameExtents): XWindowGeometry {
  return {
    x: innerRect.x - extents.left,
    y: innerRect.y - extents.top,
    width: innerRect.width + extents.left + extents.right,
    height: innerRect.height + extents.top + extents.bottom,
  };
}

function resolveTargetRect(terminalWindowId: string, paneId: string, logicalWidth: number, logicalHeight: number): XWindowGeometry | null {
  const terminal = readXWindowGeometry(terminalWindowId);
  const pane = readPaneMetrics(paneId);
  if (!terminal || !pane || pane.windowWidth <= 0 || pane.windowHeight <= 0) return null;
  const paneRect = {
    x: terminal.x + Math.round((terminal.width * pane.paneLeft) / pane.windowWidth),
    y: terminal.y + Math.round((terminal.height * pane.paneTop) / pane.windowHeight),
    width: Math.round((terminal.width * pane.paneWidth) / pane.windowWidth),
    height: Math.round((terminal.height * pane.paneHeight) / pane.windowHeight),
  };
  if (paneRect.width <= 0 || paneRect.height <= 0) return null;
  return fitAspectWithinRect(paneRect, logicalWidth, logicalHeight);
}

function readRustDinoWindowIds(windowTitle: string): string[] {
  const raw = runText('wmctrl', ['-lx']) ?? '';
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => line.includes(windowTitle))
    .filter((line) => line.toLowerCase().includes('miniquad-application'))
    .map((line) => line.split(/\s+/)[0] ?? '')
    .filter((value) => /^0x[0-9a-f]+$/i.test(value))
    .sort((left, right) => Number.parseInt(right, 16) - Number.parseInt(left, 16));
}

function resolveObservedFrameExtents(windowTitle: string): FrameExtents {
  const geometries = readRustDinoWindowIds(windowTitle)
    .map((windowId) => readXWindowGeometry(windowId))
    .filter((value): value is XWindowGeometry => value !== null)
    .sort((left, right) => (right.width * right.height) - (left.width * left.height));
  if (geometries.length < 2) return defaultFrameExtents();

  const outer = geometries[0]!;
  const inner = geometries[geometries.length - 1]!;
  if (outer.width < inner.width || outer.height < inner.height) return defaultFrameExtents();

  const extents = {
    left: Math.max(0, inner.x - outer.x),
    top: Math.max(0, inner.y - outer.y),
    right: Math.max(0, (outer.x + outer.width) - (inner.x + inner.width)),
    bottom: Math.max(0, (outer.y + outer.height) - (inner.y + inner.height)),
  };
  if (extents.top === 0 && extents.bottom === 0 && extents.left === 0 && extents.right === 0) {
    return defaultFrameExtents();
  }
  return extents;
}

function applyWindowDock(windowId: string, rect: XWindowGeometry): void {
  spawnSync('wmctrl', ['-ir', windowId, '-b', 'remove,maximized_vert,maximized_horz'], {
    stdio: 'ignore',
    env: process.env,
  });
  spawnSync('wmctrl', ['-ir', windowId, '-e', `0,${rect.x},${rect.y},${rect.width},${rect.height}`], {
    stdio: 'ignore',
    env: process.env,
  });
}

function supportsDocking(): boolean {
  if (!process.env.DISPLAY) return false;
  if (!process.env.TMUX_PANE) return false;
  return ['wmctrl', 'xprop', 'xwininfo', 'tmux'].every(commandExists);
}

function runCargoBuild(gameCwd: string): void {
  const result = spawnSync('cargo', ['build'], {
    cwd: gameCwd,
    stdio: 'inherit',
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(options.gameCwd, 'Cargo.toml'))) {
    throw new Error(`missing Cargo.toml in ${options.gameCwd}`);
  }

  const terminalWindowId = supportsDocking()
    ? (process.env.OMX_TEAM_PLAY_TARGET_WINDOW_ID ?? readActiveWindowId())
    : null;
  const paneId = process.env.TMUX_PANE ?? '';
  const initialRect = terminalWindowId
    ? resolveTargetRect(terminalWindowId, paneId, options.logicalWidth, options.logicalHeight)
    : null;

  runCargoBuild(options.gameCwd);
  const binaryPath = join(options.gameCwd, 'target', 'debug', 'dino-game');
  if (!existsSync(binaryPath)) {
    throw new Error(`missing built dino binary at ${binaryPath}`);
  }

  const initialExtents = defaultFrameExtents();
  const initialInnerRect = initialRect
    ? fitInnerWindowWithinOuterRect(initialRect, options.logicalWidth, options.logicalHeight, initialExtents)
    : null;
  const childEnv = {
    ...process.env,
    DINO_WINDOW_WIDTH: String(initialInnerRect?.width ?? options.logicalWidth),
    DINO_WINDOW_HEIGHT: String(initialInnerRect?.height ?? options.logicalHeight),
  };
  const child = spawn(binaryPath, {
    cwd: options.gameCwd,
    stdio: 'inherit',
    env: childEnv,
  });

  let knownWindowId: string | null = null;
  const timer = setInterval(() => {
    if (!terminalWindowId) return;
    const rect = resolveTargetRect(terminalWindowId, paneId, options.logicalWidth, options.logicalHeight);
    if (!rect) return;
    if (!knownWindowId) {
      knownWindowId = readRustDinoWindowIds(options.windowTitle)[0] ?? null;
    }
    if (!knownWindowId) return;
    const extents = resolveObservedFrameExtents(options.windowTitle);
    const innerRect = fitInnerWindowWithinOuterRect(rect, options.logicalWidth, options.logicalHeight, extents);
    applyWindowDock(knownWindowId, expandInnerRectToOuterRect(innerRect, extents));
  }, 500);

  const stop = (code: number | null, signal: NodeJS.Signals | null): void => {
    clearInterval(timer);
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      clearInterval(timer);
      if (!child.killed) {
        child.kill(signal);
      }
    });
  }

  child.on('exit', stop);
  child.on('error', (error) => {
    clearInterval(timer);
    console.error(`[team-play-pane-dock] failed to launch dino-game: ${error.message}`);
    process.exit(1);
  });
}

main();
