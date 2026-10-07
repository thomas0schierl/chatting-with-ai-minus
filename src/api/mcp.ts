import type { ChatSettings, McpServer, ServerToolCall } from "../types";
import { isRecord } from "../json";

/**
 * Remote MCP servers through the provider (ADR-19): Anthropic's MCP
 * connector and OpenAI's remote MCP tool connect to the server and call
 * its tools themselves; the plugin only names the servers in the request
 * and shows the calls. The ChatGPT plan's route doesn't offer it (siwc
 * preview limitations: "hosted MCP/connectors" unsupported).
 */

/** Anthropic's MCP connector beta. */
export const ANTHROPIC_MCP_BETA = "mcp-client-2025-11-20";

/** A server name the providers accept (letters, digits, `-` and `_`). */
export function validServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

/** A public https address (the providers connect from their side). */
export function validServerUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The servers a request names: switched on, valid, each name once; none for the ChatGPT plan. */
export function activeServers(settings: ChatSettings): McpServer[] {
  if (settings.provider === "chatgpt-oauth") return [];
  const seen = new Set<string>();
  return (settings.mcpServers ?? []).filter((server) => {
    if (!server.enabled || !validServerName(server.name) || !validServerUrl(server.url) || seen.has(server.name)) return false;
    seen.add(server.name);
    return true;
  });
}

/** Anthropic: `mcp_servers` and one `mcp_toolset` per server. */
export function anthropicMcp(servers: McpServer[]): { mcp_servers: Record<string, unknown>[]; toolsets: Record<string, unknown>[] } {
  return {
    mcp_servers: servers.map((server) => ({
      type: "url", url: server.url, name: server.name,
      ...(server.token ? { authorization_token: server.token } : {}),
    })),
    toolsets: servers.map((server) => ({ type: "mcp_toolset", mcp_server_name: server.name })),
  };
}

/** OpenAI: one remote MCP tool per server, its tools called without asking (ADR-19). */
export function openaiMcpTools(servers: McpServer[]): Record<string, unknown>[] {
  return servers.map((server) => ({
    type: "mcp", server_label: server.name, server_url: server.url, require_approval: "never",
    ...(server.token ? { authorization: server.token } : {}),
  }));
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord).map((part) => (typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n");
}

/** Anthropic's `mcp_tool_use` blocks with their `mcp_tool_result`, for the chat. */
export function anthropicServerCalls(blocks: Record<string, unknown>[]): ServerToolCall[] {
  const results = new Map(blocks.filter((block) => block.type === "mcp_tool_result").map((block) => [block.tool_use_id, block]));
  return blocks.filter((block) => block.type === "mcp_tool_use").map((block) => {
    const result = results.get(block.id);
    return {
      server: typeof block.server_name === "string" ? block.server_name : "",
      tool: typeof block.name === "string" ? block.name : "",
      input: isRecord(block.input) ? block.input : {},
      result: result ? resultText(result.content) : "",
      isError: result?.is_error === true,
    };
  });
}

/** OpenAI's `mcp_call` items, for the chat. */
export function openaiServerCalls(items: Record<string, unknown>[]): ServerToolCall[] {
  return items.filter((item) => item.type === "mcp_call").map((item) => {
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
      if (isRecord(parsed)) input = parsed;
    } catch {
      // Shown without parameters.
    }
    const error = item.error;
    return {
      server: typeof item.server_label === "string" ? item.server_label : "",
      tool: typeof item.name === "string" ? item.name : "",
      input,
      result: error ? resultText(error) || (typeof error === "string" ? error : JSON.stringify(error)) : resultText(item.output),
      isError: !!error,
    };
  });
}

/** `{ serverCalls }` for a response, when there are any. */
export function withServerCalls(calls: ServerToolCall[]): { serverCalls?: ServerToolCall[] } {
  return calls.length ? { serverCalls: calls } : {};
}

/** The tool name the chat shows a server's call under (`ui/tool-label.ts`). */
export function serverToolName(call: ServerToolCall): string {
  return `mcp:${call.server}:${call.tool}`;
}
