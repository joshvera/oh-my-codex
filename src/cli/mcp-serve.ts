import {
  OMX_FIRST_PARTY_MCP_ENTRYPOINTS,
  OMX_PLUGIN_MCP_SERVE_SUBCOMMAND,
} from "../config/omx-first-party-mcp.js";

type McpServeEntrypoint = (typeof OMX_FIRST_PARTY_MCP_ENTRYPOINTS)[number];

type McpServeLoader = () => Promise<unknown>;

const MCP_SERVE_USAGE = [
  `Usage: omx ${OMX_PLUGIN_MCP_SERVE_SUBCOMMAND} <entrypoint>`,
  "",
  "Launch an OMX stdio MCP server entrypoint via the installed omx CLI.",
  "Intended for plugin-scoped MCP metadata and other runtime launchers.",
  "",
  `Supported entrypoints: ${OMX_FIRST_PARTY_MCP_ENTRYPOINTS.join(", ")}`,
].join("\n");

const MCP_SERVE_LOADERS: Record<McpServeEntrypoint, McpServeLoader> = {
  "state-server.js": async () => await import("../mcp/state-server.js"),
  "memory-server.js": async () => await import("../mcp/memory-server.js"),
  "code-intel-server.js": async () => await import("../mcp/code-intel-server.js"),
  "trace-server.js": async () => await import("../mcp/trace-server.js"),
  "wiki-server.js": async () => await import("../mcp/wiki-server.js"),
};

const MCP_SERVE_TARGET_ALIASES: Record<string, McpServeEntrypoint> = {
  state: "state-server.js",
  "state-server": "state-server.js",
  "state-server.js": "state-server.js",
  memory: "memory-server.js",
  "memory-server": "memory-server.js",
  "memory-server.js": "memory-server.js",
  codeintel: "code-intel-server.js",
  "code-intel": "code-intel-server.js",
  code_intel: "code-intel-server.js",
  "code-intel-server": "code-intel-server.js",
  "code-intel-server.js": "code-intel-server.js",
  trace: "trace-server.js",
  "trace-server": "trace-server.js",
  "trace-server.js": "trace-server.js",
  wiki: "wiki-server.js",
  "wiki-server": "wiki-server.js",
  "wiki-server.js": "wiki-server.js",
};

export function normalizeOmxMcpServeTarget(
  rawTarget: string | undefined,
): McpServeEntrypoint | null {
  if (typeof rawTarget !== "string") return null;
  const normalized = rawTarget.trim().toLowerCase();
  if (!normalized) return null;
  return MCP_SERVE_TARGET_ALIASES[normalized] ?? null;
}

export async function mcpServeCommand(args: string[]): Promise<void> {
  const firstArg = args[0];
  if (!firstArg || firstArg === "--help" || firstArg === "-h" || firstArg === "help") {
    console.log(MCP_SERVE_USAGE);
    return;
  }

  const target = normalizeOmxMcpServeTarget(firstArg);
  if (!target) {
    throw new Error(`Unknown MCP entrypoint: ${firstArg}\n${MCP_SERVE_USAGE}`);
  }

  if (args.length > 1) {
    throw new Error(`Unexpected arguments: ${args.slice(1).join(" ")}\n${MCP_SERVE_USAGE}`);
  }

  await MCP_SERVE_LOADERS[target]();
}
