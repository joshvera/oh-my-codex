import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveCanonicalTeamStateRoot,
  resolveWorkerTeamStateRoot,
  resolveWorkerTeamStateRootPath,
} from '../state-root.js';

describe('state-root', () => {
  it('resolveCanonicalTeamStateRoot resolves to leader .omx/state', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project', {}),
      '/tmp/demo/project/.omx/state',
    );
  });

  it('prefers OMX_TEAM_STATE_ROOT when present', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project', {
        OMX_TEAM_STATE_ROOT: '/tmp/shared/team-state',
      }),
      '/tmp/shared/team-state',
    );
  });

  it('resolves relative OMX_TEAM_STATE_ROOT from the leader cwd', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project', {
        OMX_TEAM_STATE_ROOT: '../shared/state',
      }),
      '/tmp/demo/shared/state',
    );
  });

  async function writeIdentity(stateRoot: string, teamName: string, workerName: string, worktreePath: string) {
    const workerDir = join(stateRoot, 'team', teamName, 'workers', workerName);
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, 'identity.json'), JSON.stringify({
      name: workerName,
      index: 1,
      role: 'executor',
      assigned_tasks: ['1'],
      worktree_path: worktreePath,
      team_state_root: stateRoot,
    }, null, 2));
  }

  it('resolves worker root from OMX_TEAM_STATE_ROOT only when identity validates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-env-'));
    const stateRoot = join(root, 'state');
    const worktree = join(root, 'worktree');
    await mkdir(worktree, { recursive: true });
    await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

    assert.equal(
      await resolveWorkerTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMX_TEAM_STATE_ROOT: stateRoot,
      }),
      stateRoot,
    );

    const rejected = await resolveWorkerTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-2' }, {
      OMX_TEAM_STATE_ROOT: stateRoot,
    });
    assert.equal(rejected, null);
  });

  it('resolves from leader cwd state root when worker identity validates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-leader-'));
    const leader = join(root, 'leader');
    const worktree = join(root, 'worker');
    const stateRoot = join(leader, '.omx', 'state');
    await mkdir(worktree, { recursive: true });
    await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

    const resolved = await resolveWorkerTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
      OMX_TEAM_LEADER_CWD: leader,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.stateRoot, stateRoot);
    assert.equal(resolved.source, 'leader_cwd');
  });

  it('allows cwd .omx/state only when identity exists and worktree path matches cwd', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'omx-state-root-cwd-'));
    const stateRoot = join(worktree, '.omx', 'state');
    await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

    const resolved = await resolveWorkerTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {});
    assert.equal(resolved.ok, true);
    assert.equal(resolved.stateRoot, stateRoot);
    assert.equal(resolved.source, 'cwd');
  });

  it('rejects missing identity, ambiguous root, and worktree mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-reject-'));
    const stateRoot = join(root, 'state');
    const worktree = join(root, 'worker');
    const otherWorktree = join(root, 'other-worker');
    await mkdir(worktree, { recursive: true });
    await mkdir(otherWorktree, { recursive: true });

    assert.equal(
      await resolveWorkerTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMX_TEAM_STATE_ROOT: stateRoot,
      }),
      null,
    );

    await writeIdentity(stateRoot, 'team-a', 'worker-1', otherWorktree);
    const mismatch = await resolveWorkerTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
      OMX_TEAM_STATE_ROOT: stateRoot,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'identity_worktree_mismatch');
  });
});
