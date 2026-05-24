import { readHudConfig } from './state.js';
import { HUD_TMUX_HEIGHT_LINES } from './constants.js';
import {
  ensureManagedHudPane,
  type EnsureManagedHudPaneDeps,
} from './lifecycle.js';
import {
  buildHudWatchCommand,
  isHudWatchPane,
  listCurrentWindowPanes,
  OMX_TMUX_HUD_OWNER_ENV,
  type TmuxPaneSnapshot,
} from './tmux.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

export { OMX_TMUX_HUD_OWNER_ENV } from './tmux.js';

function isExplicitOmxOwnedTmuxEnv(env: NodeJS.ProcessEnv): boolean {
  return env[OMX_TMUX_HUD_OWNER_ENV] === '1';
}

export interface ReconcileHudForPromptSubmitResult {
  status:
    | 'skipped_not_tmux'
    | 'skipped_no_entry'
    | 'skipped_not_omx_owned_tmux'
    | 'resized'
    | 'recreated'
    | 'replaced_duplicates'
    | 'lock_unavailable'
    | 'failed';
  paneId: string | null;
  desiredHeight: number | null;
  duplicateCount: number;
}

export interface ReconcileHudForPromptSubmitDeps {
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  listCurrentWindowPanes?: (currentPaneId?: string) => TmuxPaneSnapshot[];
  createHudWatchPane?: (
    cwd: string,
    hudCmd: string,
    options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string },
  ) => string | null;
  killTmuxPane?: (paneId: string) => boolean;
  resizeTmuxPane?: (paneId: string, heightLines: number) => boolean;
  readHudConfig?: typeof readHudConfig;
  resolveOmxCliEntryPath?: typeof resolveOmxCliEntryPath;
  registerHudResizeHook?: (hudPaneId: string, currentPaneId: string | undefined, heightLines: number) => boolean;
  unregisterHudResizeHook?: (currentPaneId: string | undefined) => boolean;
  readHudPaneMetadata?: EnsureManagedHudPaneDeps['readHudPaneMetadata'];
  writeHudPaneMetadata?: EnsureManagedHudPaneDeps['writeHudPaneMetadata'];
  acquireLock?: EnsureManagedHudPaneDeps['acquireLock'];
  releaseLock?: EnsureManagedHudPaneDeps['releaseLock'];
}

export async function reconcileHudForPromptSubmit(
  cwd: string,
  deps: ReconcileHudForPromptSubmitDeps = {},
): Promise<ReconcileHudForPromptSubmitResult> {
  const env = deps.env ?? process.env;
  if (!env.TMUX) {
    return {
      status: 'skipped_not_tmux',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  if (!isExplicitOmxOwnedTmuxEnv(env)) {
    return {
      status: 'skipped_not_omx_owned_tmux',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const resolveOmxCliEntryPathFn = deps.resolveOmxCliEntryPath ?? resolveOmxCliEntryPath;
  const omxBin = resolveOmxCliEntryPathFn();
  if (!omxBin) {
    return {
      status: 'skipped_no_entry',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const currentPaneId = env.TMUX_PANE?.trim();
  const resolvedSessionId = deps.sessionId?.trim() || env.OMX_SESSION_ID?.trim() || undefined;
  const desiredHeight = HUD_TMUX_HEIGHT_LINES;

  const readHudConfigFn = deps.readHudConfig ?? readHudConfig;
  const hudConfig = await readHudConfigFn(cwd).catch(() => null);
  const preset = hudConfig?.preset;
  const hudCmd = buildHudWatchCommand(omxBin, preset, resolvedSessionId, env.OMX_ROOT, currentPaneId);
  const listPanes = deps.listCurrentWindowPanes ?? ((paneId?: string) => listCurrentWindowPanes(undefined, paneId));
  const panes = listPanes(currentPaneId);
  const nonHudPaneCount = panes.filter((pane) => !isHudWatchPane(pane)).length;

  return ensureManagedHudPane({
    cwd,
    hudCmd,
    currentPaneId,
    owner: { sessionId: resolvedSessionId, leaderPaneId: currentPaneId, root: env.OMX_ROOT },
    heightLines: desiredHeight,
    fullWidth: nonHudPaneCount > 1,
    targetPaneId: currentPaneId,
  }, {
    listCurrentWindowPanes: () => panes,
    createHudWatchPane: deps.createHudWatchPane,
    killTmuxPane: deps.killTmuxPane,
    resizeTmuxPane: deps.resizeTmuxPane,
    registerHudResizeHook: deps.registerHudResizeHook,
    unregisterHudResizeHook: deps.unregisterHudResizeHook,
    readHudPaneMetadata: deps.readHudPaneMetadata,
    writeHudPaneMetadata: deps.writeHudPaneMetadata,
    acquireLock: deps.acquireLock,
    releaseLock: deps.releaseLock,
  });
}
