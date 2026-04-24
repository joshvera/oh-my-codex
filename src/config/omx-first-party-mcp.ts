import { join } from "path";
import type { UnifiedMcpRegistryServer } from "./mcp-registry.js";

export const OMX_PLUGIN_MCP_COMMAND = "omx";
export const OMX_PLUGIN_MCP_SERVE_SUBCOMMAND = "mcp-serve";

type OmxFirstPartyMcpSpec = {
  name: string;
  title: string;
  entrypoint: string;
  startupTimeoutSec: number;
};

const OMX_FIRST_PARTY_MCP_SPECS: readonly OmxFirstPartyMcpSpec[] = [
  {
    name: "omx_state",
    title: "# OMX State Management MCP Server",
    entrypoint: "state-server.js",
    startupTimeoutSec: 5,
  },
  {
    name: "omx_memory",
    title: "# OMX Project Memory MCP Server",
    entrypoint: "memory-server.js",
    startupTimeoutSec: 5,
  },
  {
    name: "omx_code_intel",
    title: "# OMX Code Intelligence MCP Server (LSP diagnostics, AST search)",
    entrypoint: "code-intel-server.js",
    startupTimeoutSec: 10,
  },
  {
    name: "omx_trace",
    title: "# OMX Trace MCP Server (agent flow timeline & statistics)",
    entrypoint: "trace-server.js",
    startupTimeoutSec: 5,
  },
  {
    name: "omx_wiki",
    title: "# OMX Wiki MCP Server (persistent project knowledge base)",
    entrypoint: "wiki-server.js",
    startupTimeoutSec: 5,
  },
] as const;

export const OMX_FIRST_PARTY_MCP_SERVER_NAMES = OMX_FIRST_PARTY_MCP_SPECS.map(
  (spec) => spec.name,
);

export const OMX_FIRST_PARTY_MCP_ENTRYPOINTS = OMX_FIRST_PARTY_MCP_SPECS.map(
  (spec) => spec.entrypoint,
);

export function getOmxFirstPartySetupMcpServers(
  pkgRoot: string,
): Array<UnifiedMcpRegistryServer & { title: string }> {
  return OMX_FIRST_PARTY_MCP_SPECS.map((spec) => ({
    name: spec.name,
    title: spec.title,
    command: "node",
    args: [join(pkgRoot, "dist", "mcp", spec.entrypoint)],
    enabled: true,
    startupTimeoutSec: spec.startupTimeoutSec,
  }));
}

export function buildOmxPluginMcpManifest(): {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      enabled: boolean;
    }
  >;
} {
  return {
    mcpServers: Object.fromEntries(
      OMX_FIRST_PARTY_MCP_SPECS.map((spec) => [
        spec.name,
        {
          command: OMX_PLUGIN_MCP_COMMAND,
          args: [OMX_PLUGIN_MCP_SERVE_SUBCOMMAND, spec.entrypoint],
          enabled: true,
        },
      ]),
    ),
  };
}
