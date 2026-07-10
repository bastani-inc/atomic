import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ToolInfo } from "@bastani/atomic";
import type { McpExtensionState } from "./state.js";
import type { McpConfig } from "./types.js";
import type { MetadataCache } from "./metadata-cache.js";
import type { ProxyToolResult } from "./proxy-types.js";
import { waitForCaller } from "./caller-wait.js";
import { McpSessionCleanupBarrier } from "./session-cleanup-barrier.js";
import { McpStateChangedError } from "./state-lease.js";
import { registerMcpCommands } from "./command-registration.js";
import { Type } from "typebox";
import { loadMcpConfig } from "./config.js";
import { getConfigPathFromArgv } from "./utils.js";
import { renderMcpToolResult } from "./tool-result-renderer.js";

/**
 * Marker substring from the host's stale-context error (see ExtensionRunner.invalidate).
 * A captured `pi`/`ctx` becomes stale when its backing session is disposed (e.g. a
 * workflow child stage session, or a reload/replace) without emitting `session_shutdown`.
 */
const STALE_EXTENSION_CONTEXT_MARKER = "extension ctx is stale";
const STALE_INITIALIZATION_PREFIX = "Stale MCP session initialization cancelled";

interface ActiveMcpSession {
  readonly generation: number;
  readonly ctx: ExtensionContext;
  readonly cleanup: Promise<void>;
}

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STALE_EXTENSION_CONTEXT_MARKER);
}

/** Probe the host guard to determine whether a captured context remains active. */
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
  let activeSession: ActiveMcpSession | null = null;
  let stateOwner: ActiveMcpSession | null = null;
  const cleanupBarrier = new McpSessionCleanupBarrier();

  async function registerDirectToolsFromConfig(
    config: McpConfig,
    cache: MetadataCache | null,
  ): Promise<{ directToolCount: number; missingConfiguredDirectToolServers: string[] }> {
    const [{ resolveDirectTools, createDirectToolExecutor, getMissingConfiguredDirectToolServers }, { truncateAtWord }] = await Promise.all([
      import("./direct-tools.js"),
      import("./utils.js"),
    ]);
    const prefix = config.settings?.toolPrefix ?? "server";
    const envRaw = process.env.MCP_DIRECT_TOOLS;
    const envDirectTools = envRaw?.split(",").map(s => s.trim()).filter(Boolean);
    const directSpecs = envRaw === "__none__"
      ? []
      : resolveDirectTools(
          config,
          cache,
          prefix,
          envDirectTools,
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
        execute: createDirectToolExecutor(
          () => ensureMcpInitialized(),
          (candidate) => isOwnedState(candidate),
          spec,
        ),
        renderResult: renderMcpToolResult,
      });
    }
    const refreshTools = (pi as { refreshTools?: () => void }).refreshTools;
    refreshTools?.();
    return {
      directToolCount: directSpecs.length,
      missingConfiguredDirectToolServers: getMissingConfiguredDirectToolServers(config, cache, envDirectTools),
    };
  }

  async function registerDirectTools(nextState: McpExtensionState): Promise<{ directToolCount: number; missingConfiguredDirectToolServers: string[] }> {
    const { loadMetadataCache } = await import("./metadata-cache.js");
    return registerDirectToolsFromConfig(nextState.config, loadMetadataCache());
  }

  async function shutdownOAuthFlow(reason: string): Promise<void> {
    const { shutdownOAuth } = await import("./mcp-auth-flow.js");
    await shutdownOAuth(reason);
  }

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) return;
    const failures: unknown[] = [];
    const uiServer = currentState.uiServer;
    currentState.uiServer = null;
    try {
      uiServer?.close(reason);
    } catch (error) {
      failures.push(error);
    }
    try {
      const { flushMetadataCache } = await import("./init.js");
      flushMetadataCache(currentState);
    } catch (error) {
      failures.push(error);
    }
    try {
      await currentState.lifecycle.gracefulShutdown();
    } catch (error) {
      failures.push(error);
    }
    for (const error of failures.slice(1)) {
      console.error("MCP: additional state shutdown failure", error);
    }
    if (failures.length > 0) throw failures[0];
  }

  async function cleanupSessionResources(currentState: McpExtensionState | null, reason: string, label: string): Promise<void> {
    const results = await Promise.allSettled([
      shutdownState(currentState, reason),
      shutdownOAuthFlow(reason),
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error(label, result.reason);
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

  function isCurrentSession(session: ActiveMcpSession): boolean {
    return activeSession === session
      && lifecycleGeneration === session.generation
      && isContextActive(session.ctx);
  }

  function isOwnedState(candidate: McpExtensionState, owner = stateOwner): boolean {
    return state === candidate && owner !== null && stateOwner === owner && isCurrentSession(owner);
  }

  function assertOwnedState(candidate: McpExtensionState, owner: ActiveMcpSession): void {
    if (!isOwnedState(candidate, owner)) throw new McpStateChangedError();
  }

  async function initializeSession(
    session: ActiveMcpSession,
    expectedPromise: { current: Promise<McpExtensionState> | null },
  ): Promise<McpExtensionState> {
    await session.cleanup;
    if (!isCurrentSession(session)) {
      throw new Error(`${STALE_INITIALIZATION_PREFIX} before startup`);
    }

    const [{ initializeMcp, updateStatusBar }, { scheduleMcpStartupWarmup }] = await Promise.all([
      import("./init.js"),
      import("./startup-warmup.js"),
    ]);
    if (!isCurrentSession(session)) {
      throw new Error(`${STALE_INITIALIZATION_PREFIX} before startup`);
    }

    let candidate: McpExtensionState | null = null;
    try {
      candidate = await initializeMcp(pi, session.ctx);
      const initializedState = candidate;
      if (!isCurrentSession(session) || initPromise !== expectedPromise.current) {
        throw new Error(`${STALE_INITIALIZATION_PREFIX} after startup`);
      }

      const directToolState = await registerDirectTools(initializedState);
      if (!isCurrentSession(session) || initPromise !== expectedPromise.current) {
        throw new Error(`${STALE_INITIALIZATION_PREFIX} after tool registration`);
      }
      if (
        initializedState.config.settings?.disableProxyTool !== true
        || directToolState.directToolCount === 0
        || directToolState.missingConfiguredDirectToolServers.length > 0
      ) {
        registerProxyTool();
      }

      updateStatusBar(initializedState);
      let cancelWarmup: (() => void) | null = null;
      const warmup = scheduleMcpStartupWarmup(initializedState, {
        shouldContinue: () => isCurrentSession(session) && state === initializedState,
        onDirectToolsChanged: async () => {
          if (!isCurrentSession(session) || state !== initializedState) return;
          await registerDirectTools(initializedState);
        },
        onSettled: () => {
          if (isCurrentSession(session) && state === initializedState && startupWarmupCancel === cancelWarmup) {
            startupWarmupCancel = null;
          }
        },
      });
      cancelWarmup = () => warmup.cancel();
      startupWarmupCancel = cancelWarmup;
      stateOwner = session;
      state = initializedState;
      return initializedState;
    } catch (error) {
      if (candidate && state !== candidate) {
        try {
          await shutdownState(candidate, "failed_initialization");
        } catch (cleanupError) {
          console.error("MCP: failed to clean unpublished initialization state", cleanupError);
        }
      }
      throw error;
    }
  }

  function ensureMcpInitialized(): Promise<McpExtensionState> {
    const session = activeSession;
    if (!session || session.generation !== lifecycleGeneration || !isContextActive(session.ctx)) {
      return Promise.reject(new Error("MCP initialization unavailable: no active session"));
    }
    if (state) {
      if (stateOwner === session && isOwnedState(state, session)) return Promise.resolve(state);
      return Promise.reject(new Error("MCP initialization unavailable: stale session state"));
    }
    if (initPromise) return initPromise;

    const expectedPromise: { current: Promise<McpExtensionState> | null } = { current: null };
    const attempt = initializeSession(session, expectedPromise);
    expectedPromise.current = attempt;
    initPromise = attempt;
    void attempt.then(
      () => {
        if (initPromise === attempt) initPromise = null;
      },
      (error: unknown) => {
        if (activeSession !== session || session.generation !== lifecycleGeneration) return;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith(STALE_INITIALIZATION_PREFIX) && !isStaleExtensionContextError(error)) {
          console.error(
            `MCP initialization failed for session generation ${session.generation}; a later MCP call will retry:`,
            error,
          );
        }
        if (initPromise === attempt) initPromise = null;
      },
    );
    return attempt;
  }

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousState = state;
    const retiredInitialization = initPromise;
    state = null;
    stateOwner = null;
    initPromise = null;
    registeredDirectToolNames = new Set<string>();
    cancelStartupWarmup();
    const previousStateCleanup = cleanupSessionResources(
      previousState,
      "session_restart",
      "MCP: failed to shut down previous session state",
    );
    const cleanup = cleanupBarrier.retain([retiredInitialization, previousStateCleanup]);
    const isStartCurrent = (): boolean => generation === lifecycleGeneration && isContextActive(ctx);
    await cleanup;
    if (!isStartCurrent()) return;

    try {
      const config = loadMcpConfig(earlyConfigPath, ctx.cwd);
      const { loadMetadataCache } = await import("./metadata-cache.js");
      if (!isStartCurrent()) return;
      const directToolState = await registerDirectToolsFromConfig(config, loadMetadataCache());
      if (!isStartCurrent()) return;
      if (
        config.settings?.disableProxyTool !== true
        || directToolState.directToolCount === 0
        || directToolState.missingConfiguredDirectToolServers.length > 0
      ) {
        registerProxyTool();
      }
    } catch (error) {
      if (!isStartCurrent() || isStaleExtensionContextError(error)) return;
      console.error("MCP: failed to register cached startup tools; enabling MCP proxy fallback", error);
      registerProxyTool();
    }

    if (!isStartCurrent()) return;
    activeSession = { generation, ctx, cleanup };
    void ensureMcpInitialized().catch(() => undefined);
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentState = state;
    const retiredInitialization = initPromise;
    activeSession = null;
    state = null;
    stateOwner = null;
    initPromise = null;
    registeredDirectToolNames = new Set<string>();
    cancelStartupWarmup();

    const stateCleanup = cleanupSessionResources(
      currentState,
      "session_shutdown",
      "MCP: session shutdown cleanup failed",
    );
    await cleanupBarrier.retain([retiredInitialization, stateCleanup]);
  });

  registerMcpCommands(pi, earlyConfigPath, async () => {
    const readyState = await ensureMcpInitialized();
    const readyOwner = stateOwner;
    if (!readyOwner) throw new McpStateChangedError();
    assertOwnedState(readyState, readyOwner);
    return {
      state: readyState,
      assertActive: () => assertOwnedState(readyState, readyOwner),
    };
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
      }, signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined, _ctx: ExtensionContext) {
        signal?.throwIfAborted();
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

        let readyState: McpExtensionState;
        try {
          readyState = await waitForCaller(ensureMcpInitialized, signal);
        } catch (error) {
          signal?.throwIfAborted();
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
            details: { error: "init_failed", message },
          };
        }
        signal?.throwIfAborted();
        const readyOwner = stateOwner;
        if (!readyOwner || !isOwnedState(readyState, readyOwner)) {
          return {
            content: [{ type: "text" as const, text: "MCP session changed during initialization" }],
            details: { error: "init_cancelled", message: "Session changed before MCP execution" },
          };
        }
        const assertActive = (): void => assertOwnedState(readyState, readyOwner);

        const { executeCall, executeConnect, executeDescribe, executeList, executeSearch, executeStatus, executeUiMessages } = await import("./proxy-modes.js");
        signal?.throwIfAborted();
        try {
          assertActive();
        } catch (error) {
          if (error instanceof McpStateChangedError) {
            return {
              content: [{ type: "text" as const, text: "MCP session changed during execution" }],
              details: { error: "state_changed", message: "Session changed before MCP execution completed" },
            };
          }
          throw error;
        }
        const stateChangedResult = (): ProxyToolResult => ({
          content: [{ type: "text" as const, text: "MCP session changed during execution" }],
          details: { error: "state_changed", message: "Session changed before MCP execution completed" },
        });
        const finish = async (start: () => ProxyToolResult | Promise<ProxyToolResult>): Promise<ProxyToolResult> => {
          try {
            signal?.throwIfAborted();
            assertActive();
            const result = await start();
            signal?.throwIfAborted();
            assertActive();
            return result;
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof McpStateChangedError) return stateChangedResult();
            throw error;
          }
        };
        if (params.action === "ui-messages") return finish(() => executeUiMessages(readyState, assertActive));
        if (params.tool) return finish(() => executeCall(readyState, params.tool!, parsedArgs, params.server, getPiTools, signal, undefined, assertActive));
        if (params.connect) return finish(() => executeConnect(readyState, params.connect!, signal, undefined, assertActive));
        if (params.describe) return finish(() => executeDescribe(readyState, params.describe!, params.server, signal, assertActive));
        if (params.search) return finish(() => executeSearch(readyState, params.search!, params.regex, params.server, params.includeSchemas, signal, assertActive));
        if (params.server) return finish(() => executeList(readyState, params.server!, signal, assertActive));
        return finish(() => executeStatus(readyState, assertActive));
      },
    });
  }
}
