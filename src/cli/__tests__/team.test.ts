import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTeamStartArgs, teamCommand } from '../team.js';
import { DEFAULT_MAX_WORKERS } from '../../team/state.js';
import { initTeamState } from '../../team/state.js';

describe('parseTeamStartArgs', () => {
  it('parses default team start args without worktree', () => {
    const result = parseTeamStartArgs(['2:executor', 'build', 'feature']);
    assert.deepEqual(result.worktreeMode, { enabled: false });
    assert.equal(result.parsed.workerCount, 2);
    assert.equal(result.parsed.agentType, 'executor');
    assert.equal(result.parsed.task, 'build feature');
    assert.equal(result.parsed.teamName, 'build-feature');
  });

  it('parses detached worktree mode and strips the flag', () => {
    const result = parseTeamStartArgs(['--worktree', '3:debugger', 'fix', 'bug']);
    assert.deepEqual(result.worktreeMode, { enabled: true, detached: true, name: null });
    assert.equal(result.parsed.workerCount, 3);
    assert.equal(result.parsed.agentType, 'debugger');
    assert.equal(result.parsed.task, 'fix bug');
    assert.equal(result.parsed.teamName, 'fix-bug');
  });

  it('parses named worktree mode with ralph prefix', () => {
    const result = parseTeamStartArgs(['ralph', '--worktree=feature/demo', '4:executor', 'ship', 'it']);
    assert.deepEqual(result.worktreeMode, { enabled: true, detached: false, name: 'feature/demo' });
    assert.equal(result.parsed.ralph, true);
    assert.equal(result.parsed.workerCount, 4);
    assert.equal(result.parsed.agentType, 'executor');
    assert.equal(result.parsed.task, 'ship it');
    assert.equal(result.parsed.teamName, 'ship-it');
  });

  it('accepts the maximum supported worker count', () => {
    const result = parseTeamStartArgs([`${DEFAULT_MAX_WORKERS}:executor`, 'ship', 'it']);
    assert.equal(result.parsed.workerCount, DEFAULT_MAX_WORKERS);
  });

  it('rejects worker count above the supported maximum', () => {
    assert.throws(
      () => parseTeamStartArgs([`${DEFAULT_MAX_WORKERS + 1}:executor`, 'ship', 'it']),
      new RegExp(`Expected 1-${DEFAULT_MAX_WORKERS}`),
    );
  });
});

describe('teamCommand shutdown --force parsing', () => {
  it('parses --force flag from shutdown args', () => {
    const teamArgs = ['shutdown', 'my-team', '--force'];
    const force = teamArgs.includes('--force');
    assert.equal(force, true);
  });

  it('does not set force when --force is absent', () => {
    const teamArgs = ['shutdown', 'my-team'];
    const force = teamArgs.includes('--force');
    assert.equal(force, false);
  });

  it('parses --force regardless of position after subcommand', () => {
    const teamArgs = ['shutdown', '--force', 'my-team'];
    const force = teamArgs.includes('--force');
    assert.equal(force, true);
  });
});

describe('teamCommand api', () => {
  it('prints team-specific help for omx team --help', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['--help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team \[ralph\] \[N:agent-type\]/);
      assert.match(logs[0] ?? '', /omx team api <operation>/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints team-specific help for omx team help alias', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team \[ralph\] \[N:agent-type\]/);
      assert.match(logs[0] ?? '', /omx team api <operation>/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints team-api-specific help for omx team api --help', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', '--help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api <operation>/);
      assert.match(logs[0] ?? '', /send-message/);
      assert.match(logs[0] ?? '', /transition-task-status/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints team-api-specific help for omx team api help alias', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', 'help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api <operation>/);
      assert.match(logs[0] ?? '', /send-message/);
      assert.match(logs[0] ?? '', /transition-task-status/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints operation-specific help for omx team api <operation> --help', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', 'send-message', '--help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api send-message --input <json> \[--json\]/);
      assert.match(logs[0] ?? '', /Required input fields/);
      assert.match(logs[0] ?? '', /from_worker/);
      assert.match(logs[0] ?? '', /to_worker/);
      assert.match(logs[0] ?? '', /body/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints operation-specific help for omx team api <operation> help alias', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', 'claim-task', 'help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api claim-task --input <json> \[--json\]/);
      assert.match(logs[0] ?? '', /expected_version/);
    } finally {
      console.log = originalLog;
    }
  });

  it('executes CLI interop operation with stable JSON envelope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('api-team', 'api test', 'executor', 1, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'send-message',
        '--input',
        JSON.stringify({
          team_name: 'api-team',
          from_worker: 'worker-1',
          to_worker: 'leader-fixed',
          body: 'ACK',
        }),
        '--json',
      ]);

      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        schema_version?: string;
        timestamp?: string;
        command?: string;
        ok?: boolean;
        operation?: string;
        data?: { message?: { body?: string } };
      };
      assert.equal(envelope.schema_version, '1.0');
      assert.equal(typeof envelope.timestamp, 'string');
      assert.equal(envelope.command, 'omx team api send-message');
      assert.equal(envelope.ok, true);
      assert.equal(envelope.operation, 'send-message');
      assert.equal(envelope.data?.message?.body, 'ACK');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns deterministic JSON errors for invalid api usage with --json', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      process.exitCode = 0;
      await teamCommand(['api', 'unknown-operation', '--json']);
      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        schema_version?: string;
        timestamp?: string;
        command?: string;
        ok?: boolean;
        operation?: string;
        error?: { code?: string; message?: string };
      };
      assert.equal(envelope.schema_version, '1.0');
      assert.equal(typeof envelope.timestamp, 'string');
      assert.equal(envelope.command, 'omx team api');
      assert.equal(envelope.ok, false);
      assert.equal(envelope.operation, 'unknown');
      assert.equal(envelope.error?.code, 'invalid_input');
      assert.match(envelope.error?.message ?? '', /Usage: omx team api/);
      assert.equal(process.exitCode, 1);
    } finally {
      console.log = originalLog;
      process.exitCode = 0;
    }
  });

  it('supports claim-safe lifecycle via CLI api (create -> claim -> transition)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-lifecycle-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('lifecycle-team', 'lifecycle test', 'executor', 1, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'create-task',
        '--input',
        JSON.stringify({
          team_name: 'lifecycle-team',
          subject: 'Lifecycle task',
          description: 'Created through CLI interop',
        }),
        '--json',
      ]);
      const created = JSON.parse(logs.at(-1) ?? '{}') as {
        ok?: boolean;
        data?: { task?: { id?: string } };
      };
      assert.equal(created.ok, true);
      const taskId = created.data?.task?.id;
      assert.equal(typeof taskId, 'string');

      await teamCommand([
        'api',
        'claim-task',
        '--input',
        JSON.stringify({
          team_name: 'lifecycle-team',
          task_id: taskId,
          worker: 'worker-1',
          expected_version: 1,
        }),
        '--json',
      ]);
      const claimed = JSON.parse(logs.at(-1) ?? '{}') as {
        ok?: boolean;
        data?: { claimToken?: string };
      };
      assert.equal(claimed.ok, true);
      const claimToken = claimed.data?.claimToken;
      assert.equal(typeof claimToken, 'string');

      await teamCommand([
        'api',
        'transition-task-status',
        '--input',
        JSON.stringify({
          team_name: 'lifecycle-team',
          task_id: taskId,
          from: 'in_progress',
          to: 'completed',
          claim_token: claimToken,
        }),
        '--json',
      ]);
      const transitioned = JSON.parse(logs.at(-1) ?? '{}') as {
        ok?: boolean;
        data?: { ok?: boolean; task?: { status?: string } };
      };
      assert.equal(transitioned.ok, true);
      assert.equal(transitioned.data?.ok, true);
      assert.equal(transitioned.data?.task?.status, 'completed');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });
});
