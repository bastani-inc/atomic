import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ToolInfo } from "@bastani/atomic";
import type { McpExtensionState } from "./state.ts";
import type { McpConfig } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { Type } from "typebox";
import { loadMcpConfig } from "./config.ts";
import { getConfigPathFromArgv } from "./utils.ts";
import { renderMcpToolResult } from "./tool-result-renderer.ts";

/**
 * Marker substring from the host's stale-context error (see ExtensionRunner.invalidate).
 * A captured `pi`/`ctx` becomes stale when its backing session is disposed (e.g. a
 * workflow child stage session, or a reload/replace) without emitting `session_shutdown`.
 */
const STALE_EXTENSION_CONTEXT_MARKER = "extension ctx is stale";

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STALE_EXTENSION_CONTEXT_MARKER);
}

/**
 * Probe whether a captured extension context is still active. Every `ctx` getter runs
 * the host's `assertActive()` guard, so a cheap property read surfaces staleness without
 * mutating anything. Returns false when the context has been invalidated by a dispose.
 */
function isContextActive(ctx: ExtensionContext): boolean {
  try {
    void ctx.cwd;
    return true;
  } catch (error) {
    if (isStaleExtensionContextError(error)) return false;
    throw error;
  }
}

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let lifecycleGeneration = 0;
  let registeredDirectToolNames = new Set<string>();
  let registeredProxyTool = false;
  let startupWarmupCancel: (() => void) | null = null;

  async function registerDirectToolsFromConfig(
    config: McpConfig,
    cache: MetadataCache | null,
  ): Promise<{ directToolCount: number; missingConfiguredDirectToolServers: string[] }> {
    const [{ resolveDirectTools, createDirectToolExecutor, getMissingConfiguredDirectToolServers }, { truncateAtWord }] = await Promise.all([
      import("./direct-tools.ts"),
      import("./utils.ts"),
    ]);
    const prefix = config.settings?.toolPrefix ?? "server";
    const envRaw = process.env.MCP_DIRECT_TOOLS;
    const directSpecs = envRaw === "__none__"
      ? []
      : resolveDirectTools(
          config,
          cache,
          prefix,
          envRaw?.split(",").map(s => s.trim()).filter(Boolean),
        );
    for (const spec of directSpecs) {
      if (registeredDirectToolNames.has(spec.prefixedName)) continue;
      registeredDirectToolNames.add(spec.prefixedName);
      (pi.registerTool as (tool: unknown) => unknown)({
        name: spec.prefixedName,
        label: `MCP: ${spec.originalName}`,
        description: spec.description || "(no description)",
        promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
        parameters: Type.Unsafe((spec.inputSchema || { type: "object", properties: {} }) as never),
        execute: createDirectToolExecutor(() => state, () => initPromise, spec),
        renderResult: renderMcpToolResult,
      });
    }
    const refreshTools = (pi as { refreshTools?: () => void }).refreshTools;
    refreshTools?.();
    return {
      directToolCount: directSpecs.length,
      missingConfiguredDirectToolServers: getMissingConfiguredDirectToolServers(config, cache),
    };
  }

  async function registerDirectTools(nextState: McpExtensionState): Promise<{ directToolCount: number; missingConfiguredDirectToolServers: string[] }> {
    const { loadMetadataCache } = await import("./metadata-cache.ts");
    return registerDirectToolsFromConfig(nextState.config, loadMetadataCache());
  }

  async function shutdownOAuthFlow(): Promise<void> {
    const { shutdownOAuth } = await import("./mcp-auth-flow.ts");
    await shutdownOAuth();
  }

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) return;

    if (currentState.uiServer) {
      currentState.uiServer.close(reason);
      currentState.uiServer = null;
    }

    let flushError: unknown;
    try {
      const { flushMetadataCache } = await import("./init.ts");
      flushMetadataCache(currentState);
    } catch (error) {
      flushError = error;
    }

    try {
      await currentState.lifecycle.gracefulShutdown();
    } catch (error) {
      if (flushError) {
        console.error("MCP: graceful shutdown failed after metadata flush error", error);
      } else {
        throw error;
      }
    }

    if (flushError) {
      throw flushError;
    }
  }

  const earlyConfigPath = getConfigPathFromArgv();

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  function cancelStartupWarmup(): void {
    startupWarmupCancel?.();
    startupWarmupCancel = null;
  }

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousState = state;
    state = null;
    initPromise = null;
    registeredDirectToolNames = new Set<string>();
    cancelStartupWarmup();

    try {
      const config = loadMcpConfig(earlyConfigPath, ctx.cwd);
      const { loadMetadataCache } = await import("./metadata-cache.ts");
      const directToolState = await registerDirectToolsFromConfig(config, loadMetadataCache());
      if (
        config.settings?.disableProxyTool !== true
        || directToolState.directToolCount === 0
        || directToolState.missingConfiguredDirectToolServers.length > 0
      ) {
        registerProxyTool();
      }
    } catch (error) {
      if (isStaleExtensionContextError(error)) return;
      console.error("MCP: failed to register cached startup tools; enabling MCP proxy fallback", error);
      registerProxyTool();
    }

    const promiseRef: { current: Promise<McpExtensionState> | null } = { current: null };
    const promise = (async () => {
      try {
        await Promise.all([
          shutdownState(previousState, "session_restart"),
          shutdownOAuthFlow(),
        ]);
      } catch (error) {
        console.error("MCP: failed to shut down previous session state", error);
      }

      if (generation !== lifecycleGeneration || !isContextActive(ctx)) {
        throw new Error("Stale MCP session initialization cancelled before startup");
      }

      const [{ initializeMcp, updateStatusBar }, { scheduleMcpStartupWarmup }] = await Promise.all([
        import("./init.ts"),
        import("./startup-warmup.ts"),
      ]);
      if (generation !== lifecycleGeneration || !isContextActive(ctx)) {
        throw new Error("Stale MCP session initialization cancelled before startup");
      }

      const nextState = await initializeMcp(pi, ctx);
      if (generation !== lifecycleGeneration || initPromise !== promiseRef.current || !isContextActive(ctx)) {
        try {
          await shutdownState(nextState, "stale_session_start");
        } catch (error) {
          console.error("MCP: failed to clean stale session state", error);
        }
        throw new Error("Stale MCP session initialization cancelled after startup");
      }

      state = nextState;
      updateStatusBar(nextState);
      const directToolState = await registerDirectTools(nextState);
      if (
        nextState.config.settings?.disableProxyTool !== true
        || directToolState.directToolCount === 0
        || directToolState.missingConfiguredDirectToolServers.length > 0
      ) {
        registerProxyTool();
      }
      const warmup = scheduleMcpStartupWarmup(nextState, {
        shouldContinue: () => generation === lifecycleGeneration && state === nextState,
        onDirectToolsChanged: async () => {
          if (generation !== lifecycleGeneration || state !== nextState) return;
          await registerDirectTools(nextState);
        },
        onSettled: () => {
          if (generation === lifecycleGeneration && state === nextState && startupWarmupCancel === cancelWarmup) {
            startupWarmupCancel = null;
          }
        },
      });
      const cancelWarmup = () => warmup.cancel();
      startupWarmupCancel = cancelWarmup;
      if (initPromise === promiseRef.current) {
        initPromise = null;
      }
      return nextState;
    })();
    promiseRef.current = promise;
    initPromise = promise;
    promise.catch((err) => {
      if (generation !== lifecycleGeneration) {
        return;
      }
      if (initPromise !== promise && initPromise !== null) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (
        !message.startsWith("Stale MCP session initialization cancelled") &&
        !isStaleExtensionContextError(err)
      ) {
        console.error("MCP initialization failed:", err);
      }
      if (initPromise === promise) {
        initPromise = null;
      }
    });
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentState = state;
    state = null;
    initPromise = null;
    registeredDirectToolNames = new Set<string>();
    cancelStartupWarmup();

    try {
      await Promise.all([
        shutdownState(currentState, "session_shutdown"),
        shutdownOAuthFlow(),
      ]);
    } catch (error) {
      console.error("MCP: session shutdown cleanup failed", error);
    }
  });

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const { showStatus, showTools, reconnectServers, logoutServer, openMcpPanel, openMcpSetup } = await import("./commands.ts");
      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "reconnect":
          await reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await showTools(state, ctx);
          break;
        case "setup": {
          const result = await openMcpSetup(state, pi, ctx, earlyConfigPath, "setup");
          if (result?.configChanged) {
            await ctx.reload();
            return;
          }
          break;
        }
        case "logout": {
          const serverName = rest;
          if (!serverName) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /mcp logout <server>", "error");
            return;
          }
          await logoutServer(serverName, state, ctx);
          break;
        }
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            const result = await openMcpPanel(state, pi, ctx, earlyConfigPath);
            if (result?.configChanged) {
              await ctx.reload();
              return;
            }
          } else {
            await showStatus(state, ctx);
          }
          break;
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) {
        return;
      }

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const { authenticateServer, openMcpAuthPanel } = await import("./commands.ts");
      if (!serverName) {
        await openMcpAuthPanel(state, pi, ctx, earlyConfigPath);
        return;
      }

      await authenticateServer(serverName, state.config, ctx);
    },
  });

  function registerProxyTool(): void {
    if (registeredProxyTool) return;
    registeredProxyTool = true;
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcp",
      label: "MCP",
      description: "MCP gateway for connecting to configured MCP servers, searching tools, describing schemas, and calling tools lazily after MCP initialization.",
      promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
      parameters: Type.Object({
        tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
        args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
        connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
        describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
        search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
        regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
        includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
        server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
        action: Type.Optional(Type.String({ description: "Action: 'ui-messages' to retrieve prompts/intents from UI sessions" })),
      }),
      renderResult: renderMcpToolResult,
      async execute(_toolCallId: string, params: {
        tool?: string;
        args?: string;
        connect?: string;
        describe?: string;
        search?: string;
        regex?: boolean;
        includeSchemas?: boolean;
        server?: string;
        action?: string;
      }, _signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined, _ctx: ExtensionContext) {
        let parsedArgs: Record<string, unknown> | undefined;
        if (params.args) {
          try {
            parsedArgs = JSON.parse(params.args);
            if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
              const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
              throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
            }
            throw error;
          }
        }

        if (!state && initPromise) {
          try {
            state = await initPromise;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
              details: { error: "init_failed", message },
            };
          }
        }
        if (!state) {
          return {
            content: [{ type: "text" as const, text: "MCP not initialized" }],
            details: { error: "not_initialized" },
          };
        }

        const { executeCall, executeConnect, executeDescribe, executeList, executeSearch, executeStatus, executeUiMessages } = await import("./proxy-modes.ts");
        if (params.action === "ui-messages") {
          return executeUiMessages(state);
        }
        if (params.tool) {
          return executeCall(state, params.tool, parsedArgs, params.server, getPiTools);
        }
        if (params.connect) {
          return executeConnect(state, params.connect);
        }
        if (params.describe) {
          return executeDescribe(state, params.describe, params.server);
        }
        if (params.search) {
          return executeSearch(state, params.search, params.regex, params.server, params.includeSchemas);
        }
        if (params.server) {
          return executeList(state, params.server);
        }
        return executeStatus(state);
      },
    });
  }
}
