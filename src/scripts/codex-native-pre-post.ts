type CodexHookPayload = Record<string, unknown>;

export interface NormalizedPreToolUsePayload {
  toolName: string;
  toolUseId: string;
  command: string;
  normalizedCommand: string;
  isBash: boolean;
}

export interface NormalizedPostToolUsePayload {
  toolName: string;
  toolUseId: string;
  command: string;
  normalizedCommand: string;
  isBash: boolean;
  rawToolResponse: unknown;
  parsedToolResponse: Record<string, unknown> | null;
  exitCode: number | null;
  stdoutText: string;
  stderrText: string;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function tryParseJsonString(value: unknown): Record<string, unknown> | null {
  const text = safeString(value).trim();
  if (!text) return null;
  try {
    return safeObject(JSON.parse(text));
  } catch {
    return null;
  }
}

function readCommand(payload: CodexHookPayload): string {
  const toolInput = safeObject(payload.tool_input);
  return safeString(toolInput?.command).trim();
}

export function normalizePreToolUsePayload(
  payload: CodexHookPayload,
): NormalizedPreToolUsePayload {
  const toolName = safeString(payload.tool_name).trim();
  const command = readCommand(payload);
  return {
    toolName,
    toolUseId: safeString(payload.tool_use_id).trim(),
    command,
    normalizedCommand: command,
    isBash: toolName === "Bash",
  };
}

export function normalizePostToolUsePayload(
  payload: CodexHookPayload,
): NormalizedPostToolUsePayload {
  const toolName = safeString(payload.tool_name).trim();
  const command = readCommand(payload);
  const rawToolResponse = payload.tool_response;
  const parsedToolResponse = tryParseJsonString(rawToolResponse) ?? safeObject(rawToolResponse);
  const exitCode = safeInteger(parsedToolResponse?.exit_code)
    ?? safeInteger(parsedToolResponse?.exitCode)
    ?? null;
  const rawText = safeString(rawToolResponse).trim();
  const stdoutText = safeString(parsedToolResponse?.stdout).trim() || rawText;
  const stderrText = safeString(parsedToolResponse?.stderr).trim();

  return {
    toolName,
    toolUseId: safeString(payload.tool_use_id).trim(),
    command,
    normalizedCommand: command,
    isBash: toolName === "Bash",
    rawToolResponse,
    parsedToolResponse,
    exitCode,
    stdoutText,
    stderrText,
  };
}

function matchesDestructiveFixture(command: string): boolean {
  return /^\s*rm\s+-rf\s+dist(?:\s|$)/.test(command);
}

export function buildNativePreToolUseOutput(
  payload: CodexHookPayload,
): Record<string, unknown> | null {
  const normalized = normalizePreToolUsePayload(payload);
  if (!normalized.isBash) return null;
  if (!matchesDestructiveFixture(normalized.normalizedCommand)) return null;

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
    },
    systemMessage:
      "Destructive Bash command detected (`rm -rf dist`). Confirm the target and expected side effects before running it.",
  };
}

function containsHardFailure(text: string): boolean {
  return /command not found|permission denied|no such file or directory/i.test(text);
}

export function buildNativePostToolUseOutput(
  payload: CodexHookPayload,
): Record<string, unknown> | null {
  const normalized = normalizePostToolUsePayload(payload);
  if (!normalized.isBash) return null;

  const combined = `${normalized.stderrText}\n${normalized.stdoutText}`.trim();
  if (containsHardFailure(combined)) {
    return {
      decision: "block",
      reason: "The Bash output indicates a command/setup failure that should be fixed before retrying.",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "Bash reported `command not found`, `permission denied`, or a missing file/path. Verify the command, dependency installation, PATH, file permissions, and referenced paths before retrying.",
      },
    };
  }

  if (
    normalized.exitCode !== null
    && normalized.exitCode !== 0
    && combined.length > 0
    && !containsHardFailure(combined)
  ) {
    return {
      decision: "block",
      reason: "The Bash command returned a non-zero exit code but produced useful output that should be reviewed before retrying.",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "The Bash output appears informative despite the non-zero exit code. Review and report the output before retrying instead of assuming the command simply failed.",
      },
    };
  }

  return null;
}
