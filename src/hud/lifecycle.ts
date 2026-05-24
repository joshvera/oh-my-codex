import { HUD_TMUX_HEIGHT_LINES } from './constants.js';
import {
  acquireTmuxWaitLock,
  buildHudLockChannel,
  createHudWatchPane,
  isHudWatchPane,
  killTmuxPane,
  listCurrentWindowPanes,
  readHudPaneMetadata,
  readHudPaneOwner,
  registerHudResizeHook,
  releaseTmuxWaitLock,
  resizeTmuxPane,
  unregisterHudResizeHook,
  writeHudPaneMetadata,
  type HudPaneMetadata,
  type TmuxPaneSnapshot,
} from './tmux.js';

export type ManagedHudStatus =
  | 'resized'
  | 'recreated'
  | 'replaced_duplicates'
  | 'lock_unavailable'
  | 'failed';

export interface ManagedHudOwner {
  sessionId?: string;
  leaderPaneId?: string;
  root?: string;
}

export interface EnsureManagedHudPaneOptions {
  cwd: string;
  hudCmd: string;
  currentPaneId?: string;
  owner?: ManagedHudOwner;
  heightLines?: number;
  fullWidth?: boolean;
  targetPaneId?: string;
  lockTimeoutMs?: number;
}

export interface EnsureManagedHudPaneResult {
  status: ManagedHudStatus;
  paneId: string | null;
  desiredHeight: number;
  duplicateCount: number;
}

export interface EnsureManagedHudPaneDeps {
  listCurrentWindowPanes?: (currentPaneId?: string) => TmuxPaneSnapshot[];
  createHudWatchPane?: (
    cwd: string,
    hudCmd: string,
    options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string },
  ) => string | null;
  killTmuxPane?: (paneId: string) => boolean;
  resizeTmuxPane?: (paneId: string, heightLines: number) => boolean;
  registerHudResizeHook?: (hudPaneId: string, currentPaneId: string | undefined, heightLines: number) => boolean;
  unregisterHudResizeHook?: (currentPaneId: string | undefined) => boolean;
  readHudPaneMetadata?: (paneId: string) => HudPaneMetadata;
  writeHudPaneMetadata?: (paneId: string, metadata: HudPaneMetadata) => boolean;
  acquireLock?: (channel: string, timeoutMs: number) => boolean;
  releaseLock?: (channel: string) => boolean;
}

type PaneBucket = 'exact_metadata' | 'exact_env' | 'legacy' | 'preserve';

interface ClassifiedPane {
  pane: TmuxPaneSnapshot;
  bucket: PaneBucket;
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized === '' ? undefined : normalized;
}

function metadataHasOwner(metadata: HudPaneMetadata): boolean {
  return Boolean(trimmed(metadata.owner) || trimmed(metadata.sessionId) || trimmed(metadata.leaderPaneId));
}

function metadataMatchesOwner(metadata: HudPaneMetadata, owner: ManagedHudOwner): boolean {
  const wantsSession = Boolean(trimmed(owner.sessionId));
  const wantsLeader = Boolean(trimmed(owner.leaderPaneId));
  if (trimmed(metadata.owner) !== '1') return false;
  if (wantsSession && trimmed(metadata.sessionId) !== trimmed(owner.sessionId)) return false;
  if (wantsLeader && trimmed(metadata.leaderPaneId) !== trimmed(owner.leaderPaneId)) return false;
  return wantsSession || wantsLeader;
}

function envMatchesOwner(pane: TmuxPaneSnapshot, owner: ManagedHudOwner): 'exact' | 'legacy' | 'none' {
  if (!isHudWatchPane(pane)) return 'none';
  const paneOwner = readHudPaneOwner(pane);
  const wantsSession = Boolean(trimmed(owner.sessionId));
  const wantsLeader = Boolean(trimmed(owner.leaderPaneId));
  if (wantsSession && trimmed(paneOwner.sessionId) !== trimmed(owner.sessionId)) return 'none';
  if (wantsLeader && trimmed(paneOwner.leaderPaneId) === trimmed(owner.leaderPaneId)) return 'exact';
  if (wantsSession && wantsLeader && !trimmed(paneOwner.leaderPaneId)) return 'legacy';
  if (!wantsLeader && wantsSession) return 'exact';
  return 'none';
}

function paneLooksLikeLeader(pane: TmuxPaneSnapshot): boolean {
  const command = `${pane.currentCommand} ${pane.startCommand}`.toLowerCase();
  return /\b(codex|omx|claude|gemini)\b/.test(command);
}

function hasCompetingLeader(panes: TmuxPaneSnapshot[], currentPaneId?: string): boolean {
  return panes.some((pane) => pane.paneId !== currentPaneId && !isHudWatchPane(pane) && paneLooksLikeLeader(pane));
}

function classifyPane(
  pane: TmuxPaneSnapshot,
  owner: ManagedHudOwner,
  currentPaneId: string | undefined,
  competingLeader: boolean,
  readMetadata: (paneId: string) => HudPaneMetadata,
): ClassifiedPane {
  if (pane.paneId === currentPaneId) return { pane, bucket: 'preserve' };
  const metadata = readMetadata(pane.paneId);
  if (metadataMatchesOwner(metadata, owner)) return { pane, bucket: 'exact_metadata' };
  if (metadataHasOwner(metadata)) return { pane, bucket: 'preserve' };

  const envMatch = envMatchesOwner(pane, owner);
  if (envMatch === 'exact') return { pane, bucket: 'exact_env' };
  if (envMatch === 'legacy' && !competingLeader) return { pane, bucket: 'legacy' };
  return { pane, bucket: 'preserve' };
}

function selectCanonical(classified: ClassifiedPane[]): ClassifiedPane | undefined {
  return (
    classified.find((entry) => entry.bucket === 'exact_metadata') ??
    classified.find((entry) => entry.bucket === 'exact_env') ??
    classified.find((entry) => entry.bucket === 'legacy')
  );
}

function managedMetadata(owner: ManagedHudOwner): HudPaneMetadata {
  return {
    owner: '1',
    sessionId: trimmed(owner.sessionId),
    leaderPaneId: trimmed(owner.leaderPaneId),
    root: owner.root,
  };
}

export function ensureManagedHudPane(
  options: EnsureManagedHudPaneOptions,
  deps: EnsureManagedHudPaneDeps = {},
): EnsureManagedHudPaneResult {
  const desiredHeight = Math.max(1, Math.floor(options.heightLines ?? HUD_TMUX_HEIGHT_LINES));
  const owner = options.owner ?? {};
  const lockChannel = buildHudLockChannel(owner.sessionId, owner.leaderPaneId);
  const acquireLock = deps.acquireLock ?? acquireTmuxWaitLock;
  const releaseLock = deps.releaseLock ?? releaseTmuxWaitLock;
  const lockAcquired = acquireLock(lockChannel, options.lockTimeoutMs ?? 2_000);
  if (!lockAcquired) {
    return { status: 'lock_unavailable', paneId: null, desiredHeight, duplicateCount: 0 };
  }

  try {
    const listPanes = deps.listCurrentWindowPanes ?? ((paneId) => listCurrentWindowPanes(undefined, paneId));
    const readMetadata = deps.readHudPaneMetadata ?? ((paneId) => readHudPaneMetadata(paneId));
    const writeMetadata = deps.writeHudPaneMetadata ?? ((paneId, metadata) => writeHudPaneMetadata(paneId, metadata));
    const resizePane = deps.resizeTmuxPane ?? ((paneId, height) => resizeTmuxPane(paneId, height));
    const createPane = deps.createHudWatchPane ?? ((cwd, hudCmd, createOptions) => createHudWatchPane(cwd, hudCmd, createOptions));
    const killPane = deps.killTmuxPane ?? ((paneId) => killTmuxPane(paneId));
    const registerHook = deps.registerHudResizeHook ?? registerHudResizeHook;
    const unregisterHook = deps.unregisterHudResizeHook ?? unregisterHudResizeHook;

    const panes = listPanes(options.currentPaneId);
    const competingLeader = hasCompetingLeader(panes, options.currentPaneId);
    const classified = panes.map((pane) => classifyPane(pane, owner, options.currentPaneId, competingLeader, readMetadata));
    const candidates = classified.filter((entry) => entry.bucket !== 'preserve');
    const canonical = selectCanonical(classified);
    const duplicateCount = canonical ? Math.max(0, candidates.length - 1) : 0;
    const metadata = managedMetadata(owner);

    if (canonical && candidates.length === 1) {
      const paneId = canonical.pane.paneId;
      const resized = resizePane(paneId, desiredHeight);
      if (resized) {
        registerHook(paneId, options.currentPaneId, desiredHeight);
        writeMetadata(paneId, metadata);
      }
      return {
        status: resized ? 'resized' : 'failed',
        paneId,
        desiredHeight,
        duplicateCount,
      };
    }

    if (canonical && candidates.length > 1) {
      unregisterHook(options.currentPaneId);
      let removedDuplicates = true;
      for (const candidate of candidates) {
        if (candidate.pane.paneId !== canonical.pane.paneId && candidate.pane.paneId !== options.currentPaneId) {
          removedDuplicates = killPane(candidate.pane.paneId) && removedDuplicates;
        }
      }
      const resized = resizePane(canonical.pane.paneId, desiredHeight);
      if (resized) {
        registerHook(canonical.pane.paneId, options.currentPaneId, desiredHeight);
        writeMetadata(canonical.pane.paneId, metadata);
      }
      return {
        status: removedDuplicates && resized ? 'replaced_duplicates' : 'failed',
        paneId: canonical.pane.paneId,
        desiredHeight,
        duplicateCount,
      };
    }

    const paneId = createPane(options.cwd, options.hudCmd, {
      heightLines: desiredHeight,
      fullWidth: options.fullWidth,
      targetPaneId: options.targetPaneId ?? options.currentPaneId,
    });
    if (!paneId) {
      return { status: 'failed', paneId: null, desiredHeight, duplicateCount };
    }

    const resized = resizePane(paneId, desiredHeight);
    if (resized) {
      registerHook(paneId, options.currentPaneId, desiredHeight);
      writeMetadata(paneId, metadata);
    }
    return { status: resized ? 'recreated' : 'failed', paneId, desiredHeight, duplicateCount };
  } finally {
    try {
      releaseLock(lockChannel);
    } catch {
      // Reconciliation is best effort; a release failure should not mask the
      // actual pane lifecycle result or cause a retry storm.
    }
  }
}
