import type { McpExtensionState } from "./state.ts";
import { updateMetadataCache, updateStatusBar } from "./init.ts";
import { buildToolMetadata } from "./tool-metadata.ts";
import { attemptAutoAuth, getAuthRequiredMessage } from "./proxy-auth.ts";
import { executeList } from "./proxy-info-modes.ts";
import type { ProxyToolResult } from "./proxy-types.ts";

export async function executeConnect(state: McpExtensionState, serverName: string): Promise<ProxyToolResult> {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "connect", error: "not_found", server: serverName },
    };
  }

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    }
    let connection = await state.manager.connect(serverName, definition);
    if (connection.status === "needs-auth") {
      const autoAuth = await attemptAutoAuth(state, serverName);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { mode: "connect", error: "auth_required", server: serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await state.manager.close(serverName);
        connection = await state.manager.connect(serverName, definition);
      }
      if (connection.status === "needs-auth") {
        const message = getAuthRequiredMessage(state, serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { mode: "connect", error: "auth_required", server: serverName, message },
        };
      }
    }
    const prefix = state.config.settings?.toolPrefix ?? "server";
    const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
    state.toolMetadata.set(serverName, metadata);
    updateMetadataCache(state, serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
    return executeList(state, serverName);
  } catch (error) {
    state.failureTracker.set(serverName, Date.now());
    updateStatusBar(state);
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
      details: { mode: "connect", error: "connect_failed", server: serverName, message },
    };
  }
}
