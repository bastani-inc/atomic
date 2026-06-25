import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
import { parseUiPromptHandoff } from "./types.ts";
import { getFailureAgeSeconds } from "./init.ts";
import { findToolByName, formatSchema } from "./tool-metadata.ts";
import { truncateAtWord } from "./utils.ts";
import type { ProxyToolResult } from "./proxy-types.ts";

export function executeUiMessages(state: McpExtensionState): ProxyToolResult {
  const sessions = state.completedUiSessions;

  if (sessions.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No UI session messages available." }],
      details: { sessions: 0 },
    };
  }

  const output: string[] = [];
  output.push(`UI Session Messages (${sessions.length} session${sessions.length > 1 ? "s" : ""}):\n`);

  const allPrompts: string[] = [];
  const allIntents = sessions.flatMap((session) => session.messages.intents);
  const parsedHandoffs: Array<{ intent: string; params: Record<string, unknown>; raw: string }> = [];

  for (const session of sessions) {
    const timestamp = session.completedAt.toLocaleTimeString();
    output.push(`\n## ${session.serverName} / ${session.toolName} (${timestamp}, ${session.reason})`);

    const plainPrompts: string[] = [];
    for (const prompt of session.messages.prompts) {
      allPrompts.push(prompt);
      const handoff = parseUiPromptHandoff(prompt);
      if (handoff) {
        parsedHandoffs.push(handoff);
      } else {
        plainPrompts.push(prompt);
      }
    }

    if (plainPrompts.length > 0) {
      output.push("\n### Prompts:");
      for (const prompt of plainPrompts) {
        output.push(`- ${prompt}`);
      }
    }

    const intentsForSession = [
      ...session.messages.intents,
      ...session.messages.prompts
        .map((prompt) => parseUiPromptHandoff(prompt))
        .filter((handoff): handoff is NonNullable<typeof handoff> => !!handoff)
        .map((handoff) => ({ intent: handoff.intent, params: handoff.params })),
    ];

    if (intentsForSession.length > 0) {
      output.push("\n### Intents:");
      for (const intent of intentsForSession) {
        const params = intent.params ? ` (${JSON.stringify(intent.params)})` : "";
        output.push(`- ${intent.intent}${params}`);
      }
    }

    if (session.messages.notifications.length > 0) {
      output.push("\n### Notifications:");
      for (const notification of session.messages.notifications) {
        output.push(`- ${notification}`);
      }
    }
  }

  const count = sessions.length;
  state.completedUiSessions = [];

  return {
    content: [{ type: "text" as const, text: output.join("\n") }],
    details: {
      sessions: count,
      prompts: allPrompts,
      intents: [...allIntents, ...parsedHandoffs.map(({ intent, params }) => ({ intent, params }))],
      handoffs: parsedHandoffs,
      cleared: true,
    },
  };
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
  const servers: Array<{ name: string; status: string; toolCount: number; failedAgo: number | null }> = [];

  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    if (connection?.status === "connected") {
      status = "connected";
    } else if (connection?.status === "needs-auth") {
      status = "needs-auth";
    } else if (failedAgo !== null) {
      status = "failed";
    } else if (metadata !== undefined) {
      status = "cached";
    }

    servers.push({ name, status, toolCount, failedAgo });
  }

  const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);
  const connectedCount = servers.filter(s => s.status === "connected").length;

  let text = `MCP: ${connectedCount}/${servers.length} servers, ${totalTools} tools\n\n`;
  for (const server of servers) {
    if (server.status === "connected") {
      text += `✓ ${server.name} (${server.toolCount} tools)\n`;
      continue;
    }
    if (server.status === "needs-auth") {
      text += `⚠ ${server.name} (needs auth)\n`;
      continue;
    }
    if (server.status === "cached") {
      text += `○ ${server.name} (${server.toolCount} tools, cached)\n`;
      continue;
    }
    if (server.status === "failed") {
      text += `✗ ${server.name} (failed ${server.failedAgo ?? 0}s ago)\n`;
      continue;
    }
    text += `○ ${server.name} (not connected)\n`;
  }

  if (servers.length > 0) {
    text += `\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search`;
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "status", servers, totalTools, connectedCount },
  };
}

export function executeDescribe(state: McpExtensionState, toolName: string): ProxyToolResult {
  let serverName: string | undefined;
  let toolMeta: ToolMetadata | undefined;

  for (const [server, metadata] of state.toolMetadata.entries()) {
    const found = findToolByName(metadata, toolName);
    if (found) {
      serverName = server;
      toolMeta = found;
      break;
    }
  }

  if (!serverName || !toolMeta) {
    return {
      content: [{ type: "text" as const, text: `Tool "${toolName}" not found. Use mcp({ search: "..." }) to search.` }],
      details: { mode: "describe", error: "tool_not_found", requestedTool: toolName },
    };
  }

  let text = `${toolMeta.name}\n`;
  text += `Server: ${serverName}\n`;
  if (toolMeta.resourceUri) {
    text += `Type: Resource (reads from ${toolMeta.resourceUri})\n`;
  }
  text += `\n${toolMeta.description || "(no description)"}\n`;

  if (toolMeta.inputSchema && !toolMeta.resourceUri) {
    text += `\nParameters:\n${formatSchema(toolMeta.inputSchema)}`;
  } else if (toolMeta.resourceUri) {
    text += `\nNo parameters required (resource tool).`;
  } else {
    text += `\nNo parameters defined.`;
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "describe", tool: toolMeta, server: serverName },
  };
}

export function executeSearch(
  state: McpExtensionState,
  query: string,
  regex?: boolean,
  server?: string,
  includeSchemas?: boolean,
): ProxyToolResult {
  const showSchemas = includeSchemas !== false;

  const matches: Array<{ server: string; tool: ToolMetadata }> = [];

  let pattern: RegExp;
  try {
    if (regex) {
      pattern = new RegExp(query, "i");
    } else {
      const terms = query.trim().split(/\s+/).filter(t => t.length > 0);
      if (terms.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Search query cannot be empty" }],
          details: { mode: "search", error: "empty_query" },
        };
      }
      const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      pattern = new RegExp(escaped.join("|"), "i");
    }
  } catch {
    return {
      content: [{ type: "text" as const, text: `Invalid regex: ${query}` }],
      details: { mode: "search", error: "invalid_pattern", query },
    };
  }

  for (const [serverName, metadata] of state.toolMetadata.entries()) {
    if (server && serverName !== server) continue;
    for (const tool of metadata) {
      if (pattern.test(tool.name) || pattern.test(tool.description)) {
        matches.push({
          server: serverName,
          tool,
        });
      }
    }
  }

  const totalCount = matches.length;

  if (totalCount === 0) {
    const msg = server
      ? `No tools matching "${query}" in "${server}"`
      : `No tools matching "${query}"`;
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "search", matches: [], count: 0, query },
    };
  }

  let text = `Found ${totalCount} tool${totalCount === 1 ? "" : "s"} matching "${query}":\n\n`;

  for (const match of matches) {
    if (showSchemas) {
      text += `${match.tool.name}\n`;
      text += `  ${match.tool.description || "(no description)"}\n`;
      if (match.tool.inputSchema && !match.tool.resourceUri) {
        text += `\n  Parameters:\n${formatSchema(match.tool.inputSchema, "    ")}\n`;
      } else if (match.tool.resourceUri) {
        text += `  No parameters (resource tool).\n`;
      }
      text += "\n";
    } else {
      text += `- ${match.tool.name}`;
      if (match.tool.description) {
        text += ` - ${truncateAtWord(match.tool.description, 50)}`;
      }
      text += "\n";
    }
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: {
      mode: "search",
      matches: matches.map(m => ({ server: m.server, tool: m.tool.name })),
      count: totalCount,
      query,
    },
  };
}

export function executeList(state: McpExtensionState, server: string): ProxyToolResult {
  if (!state.config.mcpServers[server]) {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_found" },
    };
  }

  const metadata = state.toolMetadata.get(server);
  const toolNames = metadata?.map(m => m.name) ?? [];
  const connection = state.manager.getConnection(server);

  if (toolNames.length === 0) {
    if (connection?.status === "connected") {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no tools.` }],
        details: { mode: "list", server, tools: [], count: 0 },
      };
    }
    if (metadata !== undefined) {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no cached tools (not connected).` }],
        details: { mode: "list", server, tools: [], count: 0, cached: true },
      };
    }
    return {
      content: [{ type: "text" as const, text: `Server "${server}" is configured but not connected. Use mcp({ connect: "${server}" }) or /mcp reconnect ${server} to retry.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_connected" },
    };
  }

  const cachedNote = connection?.status === "connected" ? "" : " (not connected, cached)";
  let text = `${server} (${toolNames.length} tools${cachedNote}):\n\n`;

  const descMap = new Map<string, string>();
  if (metadata) {
    for (const m of metadata) {
      descMap.set(m.name, m.description);
    }
  }

  for (const tool of toolNames) {
    const desc = descMap.get(tool) ?? "";
    const truncated = truncateAtWord(desc, 50);
    text += `- ${tool}`;
    if (truncated) text += ` - ${truncated}`;
    text += "\n";
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "list", server, tools: toolNames, count: toolNames.length },
  };
}
