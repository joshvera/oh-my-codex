/**
 * Team execution stage adapter for pipeline orchestrator.
 *
 * Wraps the existing team mode (tmux-based Codex CLI workers) into a
 * PipelineStage. The execution backend is always teams — this is the
 * canonical OMX execution surface.
 */

import { join } from 'node:path';
import type { PipelineStage, StageContext, StageResult } from '../types.js';
import { buildRepoAwareTeamExecutionPlan, type TeamDecompositionMetadata } from '../../team/repo-aware-decomposition.js';
import { buildTeamExecutionPlan, parseTeamArgs } from '../../cli/team.js';
import {
  buildFollowupStaffingPlan,
  resolveAvailableAgentTypes,
} from '../../team/followup-planner.js';
import { packageRoot } from '../../utils/paths.js';

export interface TeamExecStageOptions {
  /** Number of Codex CLI workers to launch. Defaults to 2. */
  workerCount?: number;

  /** Agent type/role for workers. Defaults to 'executor'. */
  agentType?: string;

  /** Whether to use git worktrees for worker isolation. */
  useWorktrees?: boolean;

  /** Additional environment variables for worker launch. */
  extraEnv?: Record<string, string>;
}

interface BuildTeamInstructionOptions {
  platform?: NodeJS.Platform;
}

interface TeamRuntimeCliTaskInput {
  subject: string;
  description: string;
  owner?: string;
  blocked_by?: string[];
  depends_on?: string[];
  symbolic_depends_on?: string[];
  role?: string;
  requires_code_change?: boolean;
  filePaths?: string[];
  domains?: string[];
  lane?: string;
  allocation_reason?: string;
  symbolic_id?: string;
}

interface TeamRuntimeCliLaunchInput {
  teamName: string;
  workerCount: number;
  agentType: string;
  tasks: TeamRuntimeCliTaskInput[];
  cwd: string;
  decompositionMetadata?: TeamDecompositionMetadata;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

function quoteShellArg(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? quoteWindowsCmdArg(value) : quotePosixShellArg(value);
}

function buildTeamRuntimeCliLaunchInput(descriptor: TeamExecDescriptor): TeamRuntimeCliLaunchInput {
  const parsed = parseTeamArgs(
    [`${descriptor.workerCount}:${descriptor.agentType}`, descriptor.task],
    descriptor.cwd,
  );
  const executionPlan = buildRepoAwareTeamExecutionPlan({
    task: parsed.task,
    workerCount: parsed.workerCount,
    agentType: parsed.agentType,
    explicitAgentType: parsed.explicitAgentType,
    explicitWorkerCount: parsed.explicitWorkerCount,
    cwd: descriptor.cwd,
    buildLegacyPlan: buildTeamExecutionPlan,
    allowDagHandoff: parsed.allowRepoAwareDagHandoff,
    approvedRepositoryContextSummary: parsed.approvedRepositoryContextSummary,
  });
  return {
    teamName: parsed.teamName,
    workerCount: executionPlan.workerCount,
    agentType: descriptor.agentType,
    tasks: executionPlan.tasks.map(({
      subject,
      description,
      owner,
      blocked_by,
      depends_on,
      symbolic_depends_on,
      role,
      requires_code_change,
      filePaths,
      domains,
      lane,
      allocation_reason,
      symbolic_id,
    }) => ({
      subject,
      description,
      ...(owner ? { owner } : {}),
      ...(blocked_by?.length ? { blocked_by } : {}),
      ...(depends_on?.length ? { depends_on } : {}),
      ...(symbolic_depends_on?.length ? { symbolic_depends_on } : {}),
      ...(role ? { role } : {}),
      ...(requires_code_change ? { requires_code_change } : {}),
      ...(filePaths?.length ? { filePaths } : {}),
      ...(domains?.length ? { domains } : {}),
      ...(lane ? { lane } : {}),
      ...(allocation_reason ? { allocation_reason } : {}),
      ...(symbolic_id ? { symbolic_id } : {}),
    })),
    cwd: descriptor.cwd,
    ...(executionPlan.metadata ? { decompositionMetadata: executionPlan.metadata } : {}),
  };
}

/**
 * Create a team-exec pipeline stage.
 *
 * This stage delegates to the existing `omx team` infrastructure, which
 * starts real Codex CLI workers in tmux panes. The stage collects the
 * plan artifacts from the previous RALPLAN stage and passes them as
 * the team task description.
 */
export function createTeamExecStage(options: TeamExecStageOptions = {}): PipelineStage {
  const workerCount = options.workerCount ?? 2;
  const agentType = options.agentType ?? 'executor';

  return {
    name: 'team-exec',

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();

      try {
        // Extract plan context from previous stage artifacts
        const ralplanArtifacts = ctx.artifacts['ralplan'] as Record<string, unknown> | undefined;
        const planContext = ralplanArtifacts
          ? `Plan from RALPLAN stage:\n${JSON.stringify(ralplanArtifacts, null, 2)}\n\nTask: ${ctx.task}`
          : ctx.task;
        const availableAgentTypes = await resolveAvailableAgentTypes(ctx.cwd);
        const staffingPlan = buildFollowupStaffingPlan('team', ctx.task, availableAgentTypes, {
          workerCount,
          fallbackRole: agentType,
        });

        // Build team execution descriptor
        const teamDescriptor: TeamExecDescriptor = {
          task: planContext,
          workerCount,
          agentType,
          availableAgentTypes,
          staffingPlan,
          useWorktrees: options.useWorktrees ?? false,
          cwd: ctx.cwd,
          extraEnv: options.extraEnv,
        };

        return {
          status: 'completed',
          artifacts: {
            teamDescriptor,
            workerCount,
            agentType,
            availableAgentTypes,
            staffingPlan,
            stage: 'team-exec',
            instruction: buildTeamInstruction(teamDescriptor),
          },
          duration_ms: Date.now() - startTime,
        };
      } catch (err) {
        return {
          status: 'failed',
          artifacts: {},
          duration_ms: Date.now() - startTime,
          error: `Team execution stage failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Team execution descriptor
// ---------------------------------------------------------------------------

/**
 * Descriptor for a team execution run, consumed by the team runtime.
 */
export interface TeamExecDescriptor {
  task: string;
  workerCount: number;
  agentType: string;
  availableAgentTypes: string[];
  staffingPlan: ReturnType<typeof buildFollowupStaffingPlan>;
  useWorktrees: boolean;
  cwd: string;
  extraEnv?: Record<string, string>;
}

/**
 * Build the `omx team` CLI instruction from a descriptor.
 */
export function buildTeamInstruction(
  descriptor: TeamExecDescriptor,
  options: BuildTeamInstructionOptions = {},
): string {
  const runtimeCliInput = buildTeamRuntimeCliLaunchInput(descriptor);
  const runtimeCliPath = join(packageRoot(), 'dist', 'team', 'runtime-cli.js');
  const platform = options.platform ?? process.platform;
  const encodedInput = Buffer.from(JSON.stringify(runtimeCliInput), 'utf-8').toString('base64url');
  const launchCommand = `${quoteShellArg(process.execPath, platform)} ${quoteShellArg(runtimeCliPath, platform)} --input-json-base64 ${encodedInput}`;
  if (platform === 'win32') {
    return launchCommand;
  }
  return `${launchCommand} # staffing=${descriptor.staffingPlan.staffingSummary} # verify=${descriptor.staffingPlan.verificationPlan.summary}`;
}
