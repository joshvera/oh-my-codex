import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureManagedHudPane } from '../lifecycle.js';
import { OMX_TMUX_HUD_LEADER_PANE_ENV, type HudPaneMetadata, type TmuxPaneSnapshot } from '../tmux.js';

function pane(paneId: string, startCommand: string, currentCommand = 'node'): TmuxPaneSnapshot {
  return { paneId, currentCommand, startCommand };
}

describe('ensureManagedHudPane', () => {
  it('collapses duplicate metadata-owned panes and preserves other leaders', () => {
    const killed: string[] = [];
    const tagged: Array<{ paneId: string; metadata: HudPaneMetadata }> = [];
    const result = ensureManagedHudPane({
      cwd: '/repo',
      hudCmd: 'node omx hud --watch',
      currentPaneId: '%1',
      owner: { sessionId: 'sess-a', leaderPaneId: '%1' },
    }, {
      acquireLock: () => true,
      releaseLock: () => true,
      listCurrentWindowPanes: () => [
        pane('%1', 'codex', 'codex'),
        pane('%2', 'node omx hud --watch'),
        pane('%3', 'node omx hud --watch'),
        pane('%4', 'node omx hud --watch'),
      ],
      readHudPaneMetadata: (paneId) => {
        if (paneId === '%4') return { owner: '1', sessionId: 'sess-b', leaderPaneId: '%9' };
        return paneId === '%2' || paneId === '%3'
          ? { owner: '1', sessionId: 'sess-a', leaderPaneId: '%1' }
          : {};
      },
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: () => true,
      registerHudResizeHook: () => true,
      writeHudPaneMetadata: (paneId, metadata) => {
        tagged.push({ paneId, metadata });
        return true;
      },
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%2');
    assert.deepEqual(killed, ['%3']);
    assert.deepEqual(tagged.map((entry) => entry.paneId), ['%2']);
  });

  it('preserves manual HUD panes without metadata or owner env', () => {
    const created: string[] = [];
    const killed: string[] = [];
    const result = ensureManagedHudPane({
      cwd: '/repo',
      hudCmd: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
      currentPaneId: '%1',
      owner: { sessionId: 'sess-a', leaderPaneId: '%1' },
    }, {
      acquireLock: () => true,
      releaseLock: () => true,
      listCurrentWindowPanes: () => [
        pane('%1', 'codex', 'codex'),
        pane('%2', 'node omx hud --watch'),
      ],
      readHudPaneMetadata: () => ({}),
      createHudWatchPane: () => {
        created.push('created');
        return '%3';
      },
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: () => true,
      registerHudResizeHook: () => true,
      writeHudPaneMetadata: () => true,
    });

    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%3');
    assert.deepEqual(created, ['created']);
    assert.deepEqual(killed, []);
  });

  it('uses exact env fallback and upgrades the pane with metadata', () => {
    const tagged: Array<{ paneId: string; metadata: HudPaneMetadata }> = [];
    const result = ensureManagedHudPane({
      cwd: '/repo',
      hudCmd: 'node omx hud --watch',
      currentPaneId: '%1',
      owner: { sessionId: 'sess-a', leaderPaneId: '%1' },
    }, {
      acquireLock: () => true,
      releaseLock: () => true,
      listCurrentWindowPanes: () => [
        pane('%1', 'codex', 'codex'),
        pane('%2', `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`),
      ],
      readHudPaneMetadata: () => ({}),
      resizeTmuxPane: () => true,
      registerHudResizeHook: () => true,
      writeHudPaneMetadata: (paneId, metadata) => {
        tagged.push({ paneId, metadata });
        return true;
      },
    });

    assert.equal(result.status, 'resized');
    assert.equal(result.paneId, '%2');
    assert.equal(tagged[0]?.paneId, '%2');
    assert.equal(tagged[0]?.metadata.sessionId, 'sess-a');
    assert.equal(tagged[0]?.metadata.leaderPaneId, '%1');
  });

  it('does not reclaim a legacy unscoped pane when another leader is present', () => {
    const killed: string[] = [];
    const result = ensureManagedHudPane({
      cwd: '/repo',
      hudCmd: 'node omx hud --watch',
      currentPaneId: '%1',
      owner: { sessionId: 'sess-a', leaderPaneId: '%1' },
    }, {
      acquireLock: () => true,
      releaseLock: () => true,
      listCurrentWindowPanes: () => [
        pane('%1', 'codex', 'codex'),
        pane('%2', "env OMX_SESSION_ID='sess-a' node omx hud --watch"),
        pane('%3', 'codex --resume', 'codex'),
      ],
      readHudPaneMetadata: () => ({}),
      createHudWatchPane: () => '%4',
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: () => true,
      registerHudResizeHook: () => true,
      writeHudPaneMetadata: () => true,
    });

    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%4');
    assert.deepEqual(killed, []);
  });

  it('does not create or kill panes when the lock is unavailable', () => {
    let created = false;
    let killed = false;
    const result = ensureManagedHudPane({
      cwd: '/repo',
      hudCmd: 'node omx hud --watch',
      currentPaneId: '%1',
      owner: { sessionId: 'sess-a', leaderPaneId: '%1' },
    }, {
      acquireLock: () => false,
      releaseLock: () => {
        throw new Error('must not release an unacquired lock');
      },
      createHudWatchPane: () => {
        created = true;
        return '%2';
      },
      killTmuxPane: () => {
        killed = true;
        return true;
      },
    });

    assert.equal(result.status, 'lock_unavailable');
    assert.equal(result.paneId, null);
    assert.equal(created, false);
    assert.equal(killed, false);
  });

  it('reports failure when duplicate cleanup cannot remove a managed pane', () => {
    const result = ensureManagedHudPane({
      cwd: '/repo',
      hudCmd: 'node omx hud --watch',
      currentPaneId: '%1',
      owner: { sessionId: 'sess-a', leaderPaneId: '%1' },
    }, {
      acquireLock: () => true,
      releaseLock: () => true,
      listCurrentWindowPanes: () => [
        pane('%1', 'codex', 'codex'),
        pane('%2', 'node omx hud --watch'),
        pane('%3', 'node omx hud --watch'),
      ],
      readHudPaneMetadata: (paneId) => paneId === '%2' || paneId === '%3'
        ? { owner: '1', sessionId: 'sess-a', leaderPaneId: '%1' }
        : {},
      killTmuxPane: () => false,
      resizeTmuxPane: () => true,
      registerHudResizeHook: () => true,
      writeHudPaneMetadata: () => true,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.paneId, '%2');
    assert.equal(result.duplicateCount, 1);
  });

  it('reports failure when a newly created managed pane cannot be resized', () => {
    const result = ensureManagedHudPane({
      cwd: '/repo',
      hudCmd: 'node omx hud --watch',
      currentPaneId: '%1',
      owner: { sessionId: 'sess-a', leaderPaneId: '%1' },
    }, {
      acquireLock: () => true,
      releaseLock: () => true,
      listCurrentWindowPanes: () => [pane('%1', 'codex', 'codex')],
      readHudPaneMetadata: () => ({}),
      createHudWatchPane: () => '%2',
      resizeTmuxPane: () => false,
      registerHudResizeHook: () => true,
      writeHudPaneMetadata: () => true,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.paneId, '%2');
  });
});
