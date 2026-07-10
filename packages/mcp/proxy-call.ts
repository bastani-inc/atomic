import type { ToolInfo } from "@bastani/atomic";
import type { McpExtensionState } from "./state.js";
import type { McpContent, ToolMetadata } from "./types.js";
import { getServerPrefix } from "./types.js";
import { lazyConnect, updateServerMetadata, updateMetadataCache, getFailureAgeSeconds, updateStatusBar } from "./init.js";
import { getToolNames, findToolByName, formatSchema } from "./tool-metadata.js";
import { transformMcpContent } from "./tool-registrar.js";
import { maybeStartUiSession, type UiSessionRuntime } from "./ui-session.js";
import { unflattenToolArguments } from "./utils.js";
import { attemptAutoAuth, getAuthRequiredMessage, type AutoAuthResult } from "./proxy-auth.js";
import type { ProxyToolResult } from "./proxy-types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { waitForCaller, waitForCallerWithLateCleanup } from "./caller-wait.js";
import { notifyUiCancellation, rethrowHostAbortAfterUiCancellation } from "./apps-cancellation.js";
import { asCallToolResult } from "./call-tool-result.js";
import { assertMcpStateLease, McpStateChangedError, type AssertMcpStateLease } from "./state-lease.js";

export async function executeCall(
  state: McpExtensionState,
  toolName: string,
  args?: Record<string, unknown>,
  serverOverride?: string,
  getPiTools?: () => ToolInfo[],
  signal?: AbortSignal,
  startAutoAuth: (state: McpExtensionState, serverName: string) => Promise<AutoAuthResult> = attemptAutoAuth,
  assertActive?: AssertMcpStateLease,
): Promise<ProxyToolResult> {
  signal?.throwIfAborted();
  assertMcpStateLease(assertActive);
  let serverName: string | undefined = serverOverride;
  let toolMeta: ToolMetadata | undefined;
  let autoAuthAttempted = false;
  const prefixMode = state.config.settings?.toolPrefix ?? "server";

  if (serverName && !state.config.mcpServers[serverName]) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "call", error: "server_not_found", server: serverName },
    };
  }

  if (serverName) {
    toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
  } else {
    for (const [server, metadata] of state.toolMetadata.entries()) {
      const found = findToolByName(metadata, toolName);
      if (found) {
        serverName = server;
        toolMeta = found;
        break;
      }
    }
  }

  if (serverName && !toolMeta) {
    const connected = await waitForCaller(() => lazyConnect(state, serverName!), signal);
    signal?.throwIfAborted();
    assertMcpStateLease(assertActive);
    if (connected) {
      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
    } else {
      const needsAuthConnection = state.manager.getConnection(serverName);
      if (needsAuthConnection?.status === "needs-auth") {
        autoAuthAttempted = true;
        const autoAuth = await waitForCaller(() => startAutoAuth(state, serverName!), signal);
        signal?.throwIfAborted();
        assertMcpStateLease(assertActive);
        if (autoAuth.status === "failed") {
          return {
            content: [{ type: "text" as const, text: autoAuth.message }],
            details: { mode: "call", error: "auth_required", server: serverName, message: autoAuth.message },
          };
        }
        if (autoAuth.status === "success") {
          await waitForCaller(() => state.manager.close(serverName!), signal);
          signal?.throwIfAborted();
          assertMcpStateLease(assertActive);
          state.failureTracker.delete(serverName);
          const connectedAfterAuth = await waitForCaller(() => lazyConnect(state, serverName!), signal);
          signal?.throwIfAborted();
          assertMcpStateLease(assertActive);
          if (connectedAfterAuth) {
            toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
            if (!toolMeta) {
              return {
                content: [{ type: "text" as const, text: `Tool "${toolName}" not found on "${serverName}" after reconnect.` }],
                details: { mode: "call", error: "tool_not_found_after_reconnect", requestedTool: toolName },
              };
            }
          }
        }

        if (!toolMeta && state.manager.getConnection(serverName)?.status === "needs-auth") {
          const message = getAuthRequiredMessage(state, serverName);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { mode: "call", error: "auth_required", server: serverName, message },
          };
        }
      }

      if (!toolMeta) {
        const failedAgo = getFailureAgeSeconds(state, serverName);
        if (failedAgo !== null) {
          return {
            content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],
            details: { mode: "call", error: "server_backoff", server: serverName },
          };
        }
      }
    }
  }

  let prefixMatchedServer: string | undefined;

  if (!serverName && !toolMeta && prefixMode !== "none") {
    const candidates = Object.keys(state.config.mcpServers)
      .map(name => ({ name, prefix: getServerPrefix(name, prefixMode) }))
      .filter(c => c.prefix && toolName.startsWith(c.prefix + "_"))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    for (const { name: configuredServer } of candidates) {
      const existingConnection = state.manager.getConnection(configuredServer);
      const failedAgo = getFailureAgeSeconds(state, configuredServer);
      if (failedAgo !== null && existingConnection?.status !== "needs-auth") continue;

      let connected = await waitForCaller(() => lazyConnect(state, configuredServer), signal);
      signal?.throwIfAborted();
      assertMcpStateLease(assertActive);
      if (!connected && state.manager.getConnection(configuredServer)?.status === "needs-auth" && !autoAuthAttempted) {
        autoAuthAttempted = true;
        const autoAuth = await waitForCaller(() => startAutoAuth(state, configuredServer), signal);
        signal?.throwIfAborted();
        assertMcpStateLease(assertActive);
        if (autoAuth.status === "failed") {
          return {
            content: [{ type: "text" as const, text: autoAuth.message }],
            details: { mode: "call", error: "auth_required", server: configuredServer, message: autoAuth.message },
          };
        }
        if (autoAuth.status === "success") {
          await waitForCaller(() => state.manager.close(configuredServer), signal);
          signal?.throwIfAborted();
          assertMcpStateLease(assertActive);
          state.failureTracker.delete(configuredServer);
          connected = await waitForCaller(() => lazyConnect(state, configuredServer), signal);
          signal?.throwIfAborted();
          assertMcpStateLease(assertActive);
        }
      }

      if (!connected) continue;
      if (!prefixMatchedServer) prefixMatchedServer = configuredServer;
      toolMeta = findToolByName(state.toolMetadata.get(configuredServer), toolName);
      if (toolMeta) {
        serverName = configuredServer;
        break;
      }
    }
  }

  if (!serverName || !toolMeta) {
    const nativeTool = !serverOverride
      ? getPiTools?.().find((tool) => tool.name === toolName && tool.name !== "mcp")
      : undefined;
    if (nativeTool) {
      return {
        content: [{ type: "text" as const, text: `"${toolName}" is a native Pi tool. Call ${toolName} directly instead of using mcp({ tool: "${toolName}" }).` }],
        details: { mode: "call", error: "native_tool", requestedTool: toolName },
      };
    }

    const hintServer = serverName ?? prefixMatchedServer;
    const available = hintServer ? getToolNames(state, hintServer) : [];
    let msg = `Tool "${toolName}" not found.`;
    if (available.length > 0) {
      msg += ` Server "${hintServer}" has: ${available.join(", ")}`;
    } else {
      msg += ` Use mcp({ search: "..." }) to search.`;
    }
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "call", error: "tool_not_found", requestedTool: toolName, hintServer },
    };
  }

  let connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    if (!autoAuthAttempted) {
      autoAuthAttempted = true;
      const autoAuth = await waitForCaller(() => startAutoAuth(state, serverName!), signal);
      signal?.throwIfAborted();
      assertMcpStateLease(assertActive);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { mode: "call", error: "auth_required", server: serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await waitForCaller(() => state.manager.close(serverName!), signal);
        signal?.throwIfAborted();
        assertMcpStateLease(assertActive);
        state.failureTracker.delete(serverName);
        connection = state.manager.getConnection(serverName);
      }
    }

    if (connection?.status === "needs-auth") {
      const message = getAuthRequiredMessage(state, serverName);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { mode: "call", error: "auth_required", server: serverName, message },
      };
    }
  }
  if (!connection || connection.status !== "connected") {
    const failedAgo = getFailureAgeSeconds(state, serverName);
    if (failedAgo !== null) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],
        details: { mode: "call", error: "server_backoff", server: serverName },
      };
    }

    const definition = state.config.mcpServers[serverName];
    if (!definition) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not connected` }],
        details: { mode: "call", error: "server_not_connected", server: serverName },
      };
    }

    try {
      assertMcpStateLease(assertActive);
      if (state.ui) {
        state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
      }
      connection = await waitForCaller(() => state.manager.connect(serverName, definition), signal);
      signal?.throwIfAborted();
      assertMcpStateLease(assertActive);
      if (connection.status === "needs-auth") {
        if (!autoAuthAttempted) {
          autoAuthAttempted = true;
          const autoAuth = await waitForCaller(() => startAutoAuth(state, serverName!), signal);
          signal?.throwIfAborted();
          assertMcpStateLease(assertActive);
          if (autoAuth.status === "failed") {
            return {
              content: [{ type: "text" as const, text: autoAuth.message }],
              details: { mode: "call", error: "auth_required", server: serverName, message: autoAuth.message },
            };
          }
          if (autoAuth.status === "success") {
            await waitForCaller(() => state.manager.close(serverName!), signal);
            signal?.throwIfAborted();
            assertMcpStateLease(assertActive);
            connection = await waitForCaller(() => state.manager.connect(serverName, definition), signal);
            signal?.throwIfAborted();
            assertMcpStateLease(assertActive);
          }
        }

        if (connection.status === "needs-auth") {
          const message = getAuthRequiredMessage(state, serverName);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { mode: "call", error: "auth_required", server: serverName, message },
          };
        }
      }
      assertMcpStateLease(assertActive);
      state.failureTracker.delete(serverName);
      updateServerMetadata(state, serverName);
      updateMetadataCache(state, serverName);
      updateStatusBar(state);
      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
      if (!toolMeta) {
        const available = getToolNames(state, serverName);
        const hint = available.length > 0
          ? `Available tools on "${serverName}": ${available.join(", ")}`
          : `Server "${serverName}" has no tools.`;
        return {
          content: [{ type: "text" as const, text: `Tool "${toolName}" not found on "${serverName}" after reconnect. ${hint}` }],
          details: { mode: "call", error: "tool_not_found_after_reconnect", requestedTool: toolName },
        };
      }
    } catch (error) {
      signal?.throwIfAborted();
      assertMcpStateLease(assertActive);
      state.failureTracker.set(serverName, Date.now());
      updateStatusBar(state);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
        details: { mode: "call", error: "connect_failed", message },
      };
    }
  }

  let uiSession: UiSessionRuntime | null = null;

  try {
    assertMcpStateLease(assertActive);
    state.manager.touch(serverName);
    state.manager.incrementInFlight(serverName);

    if (toolMeta.resourceUri) {
      assertMcpStateLease(assertActive);
      const result = await connection.client.readResource({ uri: toolMeta.resourceUri }, { signal });
      signal?.throwIfAborted();
      assertMcpStateLease(assertActive);
      const content = (result.contents ?? []).map(c => ({
        type: "text" as const,
        text: "text" in c ? c.text : ("blob" in c ? `[Binary data: ${(c as { mimeType?: string }).mimeType ?? "unknown"}]` : JSON.stringify(c)),
      }));
      return {
        content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }],
        details: { mode: "call", resourceUri: toolMeta.resourceUri, server: serverName },
      };
    }

    uiSession = toolMeta.uiResourceUri
      ? await waitForCallerWithLateCleanup(
          () => maybeStartUiSession(state, {
            serverName,
            toolName: toolMeta.originalName,
            toolArgs: args ?? {},
            uiResourceUri: toolMeta.uiResourceUri!,
            streamMode: toolMeta.uiStreamMode,
          }),
          signal,
          (lateSession) => {
            if (lateSession && !lateSession.reused) lateSession.close("caller cancelled during UI startup");
          },
        )
      : null;
    signal?.throwIfAborted();
    assertMcpStateLease(assertActive);

    assertMcpStateLease(assertActive);
    const resultPromise = connection.client.callTool({
      name: toolMeta.originalName,
      // Normalize provider-flattened argument keys (e.g. Gemini's `keywords[0]`)
      // back into arrays/objects before the MCP server validates them.
      // Schema-aware: literal dotted property names (e.g. `filter.name`) are
      // preserved unless the schema proves the head is a container.
      arguments: unflattenToolArguments(args, toolMeta.inputSchema),
      _meta: uiSession?.requestMeta,
    }, CallToolResultSchema, { signal });

    if (toolMeta.uiResourceUri) {
      const sdkResult = await resultPromise;
      signal?.throwIfAborted();
      assertMcpStateLease(assertActive);
      const result = asCallToolResult(sdkResult);
      uiSession?.sendToolResult(result);
      const mcpContent = (result.content ?? []) as McpContent[];
      const content = transformMcpContent(mcpContent);

      const mcpText = content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n");

      if (result.isError) {
        let errorWithSchema = `Error: ${mcpText || "Tool execution failed"}`;
        if (toolMeta.inputSchema) {
          errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`;
        }
        return {
          content: [{ type: "text" as const, text: errorWithSchema }],
          details: { mode: "call", error: "tool_error", mcpResult: result },
        };
      }

      const resultText = mcpText || "(empty result)";
      const uiMessage = uiSession?.reused
        ? "Updated the open UI."
        : "📺 Interactive UI is now open in your browser. I'll respond to your prompts and intents as you interact with it.";
      return {
        content: [{ type: "text" as const, text: `${resultText}\n\n${uiMessage}` }],
        details: { mode: "call", mcpResult: result, server: serverName, tool: toolMeta.originalName, uiOpen: true },
      };
    }

    const sdkResult = await resultPromise;
    signal?.throwIfAborted();
    assertMcpStateLease(assertActive);
    const result = asCallToolResult(sdkResult);

    const mcpContent = (result.content ?? []) as McpContent[];
    const content = transformMcpContent(mcpContent);

    if (result.isError) {
      const errorText = content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n") || "Tool execution failed";

      let errorWithSchema = `Error: ${errorText}`;
      if (toolMeta.inputSchema) {
        errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`;
      }

      return {
        content: [{ type: "text" as const, text: errorWithSchema }],
        details: { mode: "call", error: "tool_error", mcpResult: result },
      };
    }

    return {
      content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }],
      details: { mode: "call", mcpResult: result, server: serverName, tool: toolMeta.originalName },
    };
  } catch (error) {
    await rethrowHostAbortAfterUiCancellation(signal, uiSession);
    const message = error instanceof Error ? error.message : String(error);
    await notifyUiCancellation(uiSession, message);
    signal?.throwIfAborted();
    assertMcpStateLease(assertActive);

    let errorWithSchema = `Failed to call tool: ${message}`;
    if (toolMeta.inputSchema) {
      errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`;
    }

    return {
      content: [{ type: "text" as const, text: errorWithSchema }],
      details: { mode: "call", error: "call_failed", message },
    };
  } finally {
    let staleState = false;
    try {
      assertMcpStateLease(assertActive);
    } catch (error) {
      if (error instanceof McpStateChangedError) staleState = true;
      else throw error;
    }
    if (uiSession && (uiSession.reused || staleState)) {
      uiSession.close(staleState ? "stale MCP session" : undefined);
    }
    state.manager.decrementInFlight(serverName);
    if (!staleState) state.manager.touch(serverName);
  }
}
