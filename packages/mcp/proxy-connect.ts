import type { McpExtensionState } from "./state.js";
import { updateMetadataCache, updateStatusBar } from "./init.js";
import { buildToolMetadata } from "./tool-metadata.js";
import { attemptAutoAuth, getAuthRequiredMessage, type AutoAuthResult } from "./proxy-auth.js";
import { executeList } from "./proxy-info-modes.js";
import type { ProxyToolResult } from "./proxy-types.js";
import { waitForCaller } from "./caller-wait.js";
import { assertMcpStateLease, type AssertMcpStateLease } from "./state-lease.js";

export async function executeConnect(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
  startAutoAuth: (state: McpExtensionState, serverName: string) => Promise<AutoAuthResult> = attemptAutoAuth,
  assertActive?: AssertMcpStateLease,
): Promise<ProxyToolResult> {
  signal?.throwIfAborted();
  assertMcpStateLease(assertActive);
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "connect", error: "not_found", server: serverName },
    };
  }

  try {
    assertMcpStateLease(assertActive);
    if (state.ui) state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    let connection = await waitForCaller(() => state.manager.connect(serverName, definition), signal);
    signal?.throwIfAborted();
    assertMcpStateLease(assertActive);
    if (connection.status === "needs-auth") {
      const autoAuth = await waitForCaller(() => startAutoAuth(state, serverName), signal);
      signal?.throwIfAborted();
      assertMcpStateLease(assertActive);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { mode: "connect", error: "auth_required", server: serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await waitForCaller(() => state.manager.close(serverName), signal);
        signal?.throwIfAborted();
        assertMcpStateLease(assertActive);
        connection = await waitForCaller(() => state.manager.connect(serverName, definition), signal);
        signal?.throwIfAborted();
        assertMcpStateLease(assertActive);
      }
      if (connection.status === "needs-auth") {
        const message = getAuthRequiredMessage(state, serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { mode: "connect", error: "auth_required", server: serverName, message },
        };
      }
    }
    assertMcpStateLease(assertActive);
    const prefix = state.config.settings?.toolPrefix ?? "server";
    const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
    state.toolMetadata.set(serverName, metadata);
    updateMetadataCache(state, serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
    return executeList(state, serverName, signal, assertActive);
  } catch (error) {
    signal?.throwIfAborted();
    assertMcpStateLease(assertActive);
    state.failureTracker.set(serverName, Date.now());
    updateStatusBar(state);
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
      details: { mode: "connect", error: "connect_failed", server: serverName, message },
    };
  }
}
