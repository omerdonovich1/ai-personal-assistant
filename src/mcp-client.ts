// MCP client layer — lets the bot consume tools from external MCP servers.
//
// Configure via env MCP_SERVERS, a JSON array of stdio server specs:
//   MCP_SERVERS='[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/data"]}]'
//
// Each connected server's tools are surfaced into the agent loop as
// "mcp__<server>__<tool>" alongside the native tools. Unset env → no-op.
//
// Local dev-environment access (running scripts on the Mac) is intentionally
// NOT wired here: the bot runs on Railway and cannot reach the laptop.
// The path for that is a local bridge process on the Mac that either runs
// this same MCP client against local servers, or exposes an authenticated
// tunnel — tracked as a follow-up, the registry below is transport-agnostic.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";

interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ConnectedServer {
  spec: McpServerSpec;
  client: Client;
}

const servers = new Map<string, ConnectedServer>();
let mcpTools: Anthropic.Tool[] = [];

const SEP = "__";
const prefixed = (server: string, tool: string) => `mcp${SEP}${server}${SEP}${tool}`;

export async function initMcp(): Promise<void> {
  const raw = process.env.MCP_SERVERS;
  if (!raw) return;

  let specs: McpServerSpec[];
  try {
    specs = JSON.parse(raw) as McpServerSpec[];
  } catch {
    console.error("[mcp] MCP_SERVERS is not valid JSON — skipping");
    return;
  }

  for (const spec of specs) {
    try {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        env: { ...process.env as Record<string, string>, ...(spec.env ?? {}) },
      });
      const client = new Client({ name: "assistant-bot", version: "1.0.0" });
      await client.connect(transport);
      servers.set(spec.name, { spec, client });

      const { tools } = await client.listTools();
      for (const t of tools) {
        mcpTools.push({
          name: prefixed(spec.name, t.name),
          description: `[MCP:${spec.name}] ${t.description ?? t.name}`,
          input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
        });
      }
      console.log(`[mcp] connected "${spec.name}" — ${tools.length} tools`);
    } catch (err) {
      console.error(`[mcp] failed to connect "${spec.name}":`, err instanceof Error ? err.message : err);
    }
  }
}

/** Tools contributed by connected MCP servers (empty when none configured). */
export function getMcpTools(): Anthropic.Tool[] {
  return mcpTools;
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(`mcp${SEP}`);
}

export async function executeMcpTool(name: string, input: Record<string, unknown>): Promise<string> {
  const parts = name.split(SEP);
  if (parts.length < 3) return `Error: malformed MCP tool name "${name}"`;
  const serverName = parts[1];
  const toolName = parts.slice(2).join(SEP);
  const server = servers.get(serverName);
  if (!server) return `Error: MCP server "${serverName}" not connected`;

  const result = await server.client.callTool({ name: toolName, arguments: input });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
  return text || JSON.stringify(result);
}
