import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@bastani/atomic";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpExtensionState } from "./state.js";
import type { DirectToolSpec, McpContent } from "./types.js";
import { getFailureAgeSeconds, lazyConnect } from "./init.js";
import { formatSchema } from "./tool-metadata.js";
import { transformMcpContent } from "./tool-registrar.js";
import { maybeStartUiSession, type UiSessionRuntime } from "./ui-session.js";
import { authenticate, supportsOAuth } from "./mcp-auth-flow.js";
import { formatAuthRequiredMessage, unflattenToolArguments } from "./utils.js";
import { waitForCaller, waitForCallerWithLateCleanup } from "./caller-wait.js";
import { notifyUiCancellation, rethrowHostAbortAfterUiCancellation } from "./apps-cancellation.js";
import { asCallToolResult } from "./call-tool-result.js";

interface DirectToolStateChangedDetails extends Record<string, unknown> {
  error: "state_changed";
  message: string;
}

type DirectToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<Record<string, unknown>>>;

type IsActiveStateOwner = (candidate: McpExtensionState) => boolean;
type StartUiSession = typeof maybeStartUiSession;

export interface DirectToolExecutorOptions {
  readonly startUiSession?: StartUiSession;
  readonly startAutoAuth?: (state: McpExtensionState, serverName: string) => Promise<DirectAutoAuthResult>;
}

export type DirectAutoAuthResult =
  | { status: "skipped" }
  | { status: "success" }
  | { status: "failed"; message: string };

function getDirectAuthRequiredMessage(
  state: McpExtensionState,
  serverName: string,
  defaultMessage = `MCP server "${serverName}" requires OAuth authentication. Run /mcp-auth ${serverName} first.`,
): string {
  return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getDirectAuthFailedMessage(state: McpExtensionState, serverName: string, message: string): string {
  const customGuidance = state.config.settings?.authRequiredMessage;
  if (customGuidance) {
    return `OAuth authentication failed for "${serverName}": ${message}. ${getDirectAuthRequiredMessage(state, serverName)}`;
  }
  return `OAuth authentication failed for "${serverName}": ${message}. Run /mcp-auth ${serverName} first.`;
}

async function attemptDirectAutoAuth(
  state: McpExtensionState,
  serverName: string,
): Promise<DirectAutoAuthResult> {
  if (state.config.settings?.autoAuth !== true) return { status: "skipped" };

  const definition = state.config.mcpServers[serverName];
  if (!definition || !supportsOAuth(definition) || !definition.url) return { status: "skipped" };

  const grantType = definition.oauth ? definition.oauth.grantType ?? "authorization_code" : "authorization_code";
  if (!state.ui && grantType !== "client_credentials") {
    return {
      status: "failed",
      message: getDirectAuthRequiredMessage(
        state,
        serverName,
        `MCP server "${serverName}" requires OAuth authentication. Run /mcp-auth ${serverName} in an interactive session.`,
      ),
    };
  }

  try {
    await authenticate(serverName, definition.url, definition);
    return { status: "success" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", message: getDirectAuthFailedMessage(state, serverName, message) };
  }
}

function stateChangedResult(): AgentToolResult<DirectToolStateChangedDetails> {
  const message = "MCP session changed before direct tool execution completed";
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: "state_changed", message },
  };
}

export function createDirectToolExecutor(
  ensureInitialized: () => Promise<McpExtensionState>,
  isActiveStateOwner: IsActiveStateOwner,
  spec: DirectToolSpec,
  options: DirectToolExecutorOptions = {},
): DirectToolExecute {
  const startUiSession = options.startUiSession ?? maybeStartUiSession;
  const startAutoAuth = options.startAutoAuth ?? attemptDirectAutoAuth;
  return async function execute(_toolCallId, params, signal) {
    signal?.throwIfAborted();
    let state: McpExtensionState;
    try {
      state = await waitForCaller(ensureInitialized, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
        details: { error: "init_failed", message },
      };
    }
    signal?.throwIfAborted();
    if (!isActiveStateOwner(state)) return stateChangedResult();

    let connected = await waitForCaller(() => lazyConnect(state, spec.serverName), signal);
    signal?.throwIfAborted();
    if (!isActiveStateOwner(state)) return stateChangedResult();
    let autoAuthAttempted = false;

    if (!connected && state.manager.getConnection(spec.serverName)?.status === "needs-auth") {
      autoAuthAttempted = true;
      const autoAuth = await waitForCaller(() => startAutoAuth(state, spec.serverName), signal);
      signal?.throwIfAborted();
      if (!isActiveStateOwner(state)) return stateChangedResult();
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { error: "auth_required", server: spec.serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await waitForCaller(() => state.manager.close(spec.serverName), signal);
        signal?.throwIfAborted();
        if (!isActiveStateOwner(state)) return stateChangedResult();
        state.failureTracker.delete(spec.serverName);
        connected = await waitForCaller(() => lazyConnect(state, spec.serverName), signal);
        signal?.throwIfAborted();
        if (!isActiveStateOwner(state)) return stateChangedResult();
      }
    }

    if (!connected) {
      const authConnection = state.manager.getConnection(spec.serverName);
      if (authConnection?.status === "needs-auth") {
        const message = getDirectAuthRequiredMessage(state, spec.serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "auth_required", server: spec.serverName, message, autoAuthAttempted },
        };
      }
      const failedAgo = getFailureAgeSeconds(state, spec.serverName);
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not available${failedAgo !== null ? ` (failed ${failedAgo}s ago)` : ""}` }],
        details: { error: "server_unavailable", server: spec.serverName },
      };
    }

    const connection = state.manager.getConnection(spec.serverName);
    if (!connection || connection.status !== "connected") {
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not connected` }],
        details: { error: "not_connected", server: spec.serverName },
      };
    }

    let uiSession: UiSessionRuntime | null = null;
    let closeUiForStaleState = false;
    let inFlightStarted = false;
    const staleStateResult = (): AgentToolResult<DirectToolStateChangedDetails> => {
      if (uiSession && !uiSession.reused) closeUiForStaleState = true;
      return stateChangedResult();
    };
    const cancelStaleUi = async (): Promise<AgentToolResult<DirectToolStateChangedDetails>> => {
      await notifyUiCancellation(uiSession, "MCP session changed during direct tool execution");
      signal?.throwIfAborted();
      return staleStateResult();
    };

    try {
      if (!isActiveStateOwner(state)) return staleStateResult();
      state.manager.touch(spec.serverName);
      state.manager.incrementInFlight(spec.serverName);
      inFlightStarted = true;

      if (spec.resourceUri) {
        const result = await connection.client.readResource({ uri: spec.resourceUri }, { signal });
        signal?.throwIfAborted();
        if (!isActiveStateOwner(state)) return stateChangedResult();
        const content = (result.contents ?? []).map((item) => ({
          type: "text" as const,
          text: "text" in item
            ? item.text
            : ("blob" in item ? `[Binary data: ${item.mimeType ?? "unknown"}]` : JSON.stringify(item)),
        }));
        return {
          content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }],
          details: { server: spec.serverName, resourceUri: spec.resourceUri },
        };
      }

      const hasUi = !!spec.uiResourceUri;
      uiSession = hasUi
        ? await waitForCallerWithLateCleanup(
            () => startUiSession(state, {
              serverName: spec.serverName,
              toolName: spec.originalName,
              toolArgs: params,
              uiResourceUri: spec.uiResourceUri!,
              streamMode: spec.uiStreamMode,
            }),
            signal,
            (lateSession) => {
              if (lateSession && !lateSession.reused) lateSession.close("caller cancelled during UI startup");
            },
          )
        : null;
      signal?.throwIfAborted();
      if (!isActiveStateOwner(state)) return cancelStaleUi();

      const sdkResult = await connection.client.callTool({
        name: spec.originalName,
        arguments: unflattenToolArguments(params, spec.inputSchema),
        _meta: uiSession?.requestMeta,
      }, CallToolResultSchema, { signal });
      signal?.throwIfAborted();
      if (!isActiveStateOwner(state)) return cancelStaleUi();
      const result = asCallToolResult(sdkResult);
      uiSession?.sendToolResult(result);

      const content = transformMcpContent((result.content ?? []) as McpContent[]);
      if (result.isError) {
        let errorText = content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "Tool execution failed";
        if (spec.inputSchema) errorText += `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}`;
        return {
          content: [{ type: "text" as const, text: `Error: ${errorText}` }],
          details: { error: "tool_error", server: spec.serverName },
        };
      }

      const resultText = content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "(empty result)";
      if (hasUi) {
        const uiMessage = uiSession?.reused
          ? "Updated the open UI."
          : "📺 Interactive UI is now open in your browser. I'll respond to your prompts and intents as you interact with it.";
        return {
          content: [{ type: "text" as const, text: `${resultText}\n\n${uiMessage}` }],
          details: { server: spec.serverName, tool: spec.originalName, uiOpen: true },
        };
      }

      return {
        content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }],
        details: { server: spec.serverName, tool: spec.originalName },
      };
    } catch (error) {
      await rethrowHostAbortAfterUiCancellation(signal, uiSession);
      const message = error instanceof Error ? error.message : String(error);
      await notifyUiCancellation(uiSession, message);
      signal?.throwIfAborted();
      if (!isActiveStateOwner(state)) return staleStateResult();
      let errorText = `Failed to call tool: ${message}`;
      if (spec.inputSchema) errorText += `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}`;
      return {
        content: [{ type: "text" as const, text: errorText }],
        details: { error: "call_failed", server: spec.serverName },
      };
    } finally {
      if (uiSession && (uiSession.reused || closeUiForStaleState)) uiSession.close(closeUiForStaleState ? "stale MCP session" : undefined);
      if (inFlightStarted) {
        state.manager.decrementInFlight(spec.serverName);
        if (isActiveStateOwner(state)) state.manager.touch(spec.serverName);
      }
    }
  };
}
