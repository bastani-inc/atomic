import { reportOwnedMcpLog } from "./diagnostics.js";
import { isStaleExtensionContextError, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext, type SubagentChildPolicy, type ToolInfo } from "@bastani/atomic";
import type { McpExtensionState } from "./state.js";
import type { McpConfig, ServerEntry } from "./types.js";
import type { MetadataCache } from "./metadata-cache.js";
import type { ProxyToolResult } from "./proxy-types.js";
import { waitForCaller } from "./caller-wait.js";
import { McpSessionCleanupBarrier } from "./session-cleanup-barrier.js";
import { McpStateChangedError } from "./state-lease.js";
import { registerMcpCommands } from "./command-registration.js";
import { Type } from "typebox";
import { loadMcpConfig } from "./config.ts";
import { getConfigPathFromArgv } from "./utils.js";
import { renderMcpToolResult } from "./tool-result-renderer.js";
import { renderMcpDirectToolCall, renderMcpToolCall } from "./tool-call-renderer.js";

const STALE_INITIALIZATION_PREFIX = "Stale MCP session initialization cancelled";

interface ActiveMcpSession {
  readonly generation: number;
  readonly ctx: ExtensionContext;
  readonly cleanup: Promise<void>;
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
  let renderConfig: McpConfig | undefined;
  let initPromise: Promise<McpExtensionState> | null = null;
  let lifecycleGeneration = 0;
  let registeredDirectTools = new Map<string, string>();
  const retiredDirectToolNames = new Set<string>();
  let registeredProxyTool = false;
  let startupWarmupCancel: (() => void) | null = null;
  let activeSession: ActiveMcpSession | null = null;
  let stateOwner: ActiveMcpSession | null = null;
  const cleanupBarrier = new McpSessionCleanupBarrier();
  const unpublishedCleanupFailures: unknown[] = [];
  let contributionRevision = 0;
  let contributionRefresh: Promise<void> = Promise.resolve();
  const getContributions = () => pi.getMcpServerContributions?.() ?? [];
  const getConfigPath = () => (pi.getFlag("mcp-config") as string | undefined) ?? earlyConfigPath;

  /** Keep names so the next session can retire them, but re-register every tool it still resolves. */
  function forgetDirectToolRegistrations(): void {
    registeredDirectTools = new Map([...registeredDirectTools.keys()].map((name) => [name, ""]));
  }

  function startsWithSession(server: ServerEntry | undefined): boolean {
    return server?.lifecycle === "eager" || server?.lifecycle === "keep-alive";
  }

  function registerProxyToolIfNeeded(
    config: McpConfig,
    directToolState: { directToolCount: number; missingConfiguredDirectToolServers: string[] },
  ): void {
    if (
      config.settings?.disableProxyTool !== true
      || directToolState.directToolCount === 0
      || directToolState.missingConfiguredDirectToolServers.length > 0
    ) {
      registerProxyTool();
    }
  }

  async function registerDirectToolsFromConfig(
    config: McpConfig,
    cache: MetadataCache | null,
    subagentPolicy?: SubagentChildPolicy,
  ): Promise<{ directToolCount: number; missingConfiguredDirectToolServers: string[] }> {
    const [{ resolveDirectTools, createDirectToolExecutor, getMissingConfiguredDirectToolServers }, { truncateAtWord }] = await Promise.all([
      import("./direct-tools.ts"),
      import("./utils.js"),
    ]);
    const prefix = config.settings?.toolPrefix ?? "server";
    const directTools = subagentPolicy?.mcpDirectTools;
    const directSpecs = resolveDirectTools(config, cache, prefix, directTools === undefined ? undefined : [...directTools]);
    const resolvedNames = new Set(directSpecs.map((spec) => spec.prefixedName));
    const obsoleteNames = [...registeredDirectTools.keys()].filter((name) => !resolvedNames.has(name));
    const revivedNames = directSpecs.map((spec) => spec.prefixedName).filter((name) => retiredDirectToolNames.has(name));
    const activeNames = new Set(obsoleteNames.length > 0 ? pi.getActiveTools() : []);
    for (const name of obsoleteNames) {
      registeredDirectTools.delete(name);
      if (activeNames.has(name)) retiredDirectToolNames.add(name);
    }
    for (const name of revivedNames) retiredDirectToolNames.delete(name);
    for (const spec of directSpecs) {
      const signature = JSON.stringify([spec.serverName, spec.originalName, spec.description, spec.inputSchema]);
      if (registeredDirectTools.get(spec.prefixedName) === signature) continue;
      registeredDirectTools.set(spec.prefixedName, signature);
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
        renderCall: (_args: Record<string, unknown>, theme: Parameters<typeof renderMcpDirectToolCall>[2]) =>
          renderMcpDirectToolCall(spec.serverName, spec.originalName, theme),
        renderResult: renderMcpToolResult,
      });
    }
    const refreshTools = (pi as { refreshTools?: () => void }).refreshTools;
    refreshTools?.();
    if (obsoleteNames.length > 0 || revivedNames.length > 0) {
      const obsolete = new Set(obsoleteNames);
      pi.setActiveTools([...pi.getActiveTools().filter((name) => !obsolete.has(name)), ...revivedNames]);
    }
    return {
      directToolCount: directSpecs.length,
      missingConfiguredDirectToolServers: getMissingConfiguredDirectToolServers(config, cache, directTools),
    };
  }

  async function registerDirectTools(nextState: McpExtensionState, subagentPolicy?: SubagentChildPolicy): Promise<{ directToolCount: number; missingConfiguredDirectToolServers: string[] }> {
    const { loadMetadataCache } = await import("./metadata-cache.js");
    return registerDirectToolsFromConfig(nextState.config, loadMetadataCache(), subagentPolicy);
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
    if (failures.length > 0) throw new AggregateError(failures, "MCP state shutdown failed");
  }

  async function cleanupSessionResources(currentState: McpExtensionState | null, reason: string, label: string): Promise<void> {
    const results = await Promise.allSettled([
      shutdownState(currentState, reason),
      shutdownOAuthFlow(reason),
    ]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, label);
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
    const revision = contributionRevision;
    try {
      candidate = await initializeMcp(pi, session.ctx);
      const initializedState = candidate;
      if (!isCurrentSession(session) || initPromise !== expectedPromise.current) {
        throw new Error(`${STALE_INITIALIZATION_PREFIX} after startup`);
      }

      const directToolState = await registerDirectTools(initializedState, session.ctx.subagentPolicy);
      if (!isCurrentSession(session) || initPromise !== expectedPromise.current) {
        throw new Error(`${STALE_INITIALIZATION_PREFIX} after tool registration`);
      }
      registerProxyToolIfNeeded(initializedState.config, directToolState);

      updateStatusBar(initializedState);
      let cancelWarmup: (() => void) | null = null;
      const warmup = scheduleMcpStartupWarmup(initializedState, {
        hasUI: session.ctx.hasUI,
        subagentPolicy: session.ctx.subagentPolicy,
        shouldContinue: () => isCurrentSession(session) && state === initializedState,
        onDirectToolsChanged: async () => {
          if (!isCurrentSession(session) || state !== initializedState) return;
          await registerDirectTools(initializedState, session.ctx.subagentPolicy);
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
      if (revision !== contributionRevision) scheduleContributionRefresh(session);
      return initializedState;
    } catch (error) {
      if (candidate && state !== candidate) {
        try {
          await shutdownState(candidate, "failed_initialization");
        } catch (cleanupError) {
          const failure = new AggregateError([error, cleanupError], "MCP initialization and candidate cleanup failed");
          unpublishedCleanupFailures.push(failure);
          throw failure;
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
          if (!reportOwnedMcpLog("error")) console.error(
            `MCP initialization failed for session generation ${session.generation}; a later MCP call will retry:`,
            error,
          );
        }
        if (initPromise === attempt) initPromise = null;
      },
    );
    return attempt;
  }

  function scheduleContributionRefresh(session: ActiveMcpSession): void {
    contributionRefresh = contributionRefresh
      .then(() => refreshContributedServers(session))
      .catch((error: Error) => {
        if (!isCurrentSession(session) || isStaleExtensionContextError(error)) return;
        if (!reportOwnedMcpLog("error")) console.error("MCP: failed to apply contributed MCP server changes", error);
      });
  }

  /** Lazy reload after `registerMcpServer()`: late servers join the running state or the next initialization. */
  async function refreshContributedServers(session: ActiveMcpSession): Promise<void> {
    if (!isCurrentSession(session)) return;
    const configPath = getConfigPath();
    const contributions = getContributions();
    const current = state;
    if (current && isOwnedState(current, session)) {
      const { applyMcpConfigChanges, formatMcpServerName, lazyConnect } = await import("./init.js");
      const changed = await applyMcpConfigChanges(current, configPath, session.ctx.cwd, contributions);
      renderConfig = current.config;
      if (!isOwnedState(current, session)) return;
      registerProxyToolIfNeeded(current.config, await registerDirectTools(current, session.ctx.subagentPolicy));
      for (const name of changed) {
        if (!startsWithSession(current.config.mcpServers[name])) continue;
        void lazyConnect(current, name).then(async (connected) => {
          if (!isOwnedState(current, session)) {
            await current.manager.close(name);
          } else if (connected) {
            registerProxyToolIfNeeded(current.config, await registerDirectTools(current, session.ctx.subagentPolicy));
          } else if (current.failureTracker.has(name)) {
            current.ui?.notify(`MCP: Failed to connect to ${formatMcpServerName(current, name)}`, "error");
          }
        }).catch(() => undefined);
      }
      return;
    }
    const config = loadMcpConfig(configPath, session.ctx.cwd, contributions);
    renderConfig = config;
    const { loadMetadataCache } = await import("./metadata-cache.js");
    if (!isCurrentSession(session)) return;
    registerProxyToolIfNeeded(config, await registerDirectToolsFromConfig(config, loadMetadataCache()));
    if (
      isCurrentSession(session) && !state && !initPromise
      && Object.values(config.mcpServers).some(startsWithSession)
    ) {
      void ensureMcpInitialized().catch(() => undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousState = state;
    const retiredInitialization = initPromise;
    state = null;
    renderConfig = undefined;
    stateOwner = null;
    initPromise = null;
    forgetDirectToolRegistrations();
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
    const revision = contributionRevision;

    try {
      const config = loadMcpConfig(earlyConfigPath, ctx.cwd, getContributions());
      const { loadMetadataCache } = await import("./metadata-cache.js");
      if (!isStartCurrent()) return;
      renderConfig = config;
      const directToolState = await registerDirectToolsFromConfig(config, loadMetadataCache());
      if (!isStartCurrent()) return;
      registerProxyToolIfNeeded(config, directToolState);
    } catch (error) {
      if (!isStartCurrent() || isStaleExtensionContextError(error)) return;
      if (!reportOwnedMcpLog("error")) console.error("MCP: failed to register cached startup tools; enabling MCP proxy fallback", error);
      registerProxyTool();
    }

    if (!isStartCurrent()) return;
    const session: ActiveMcpSession = { generation, ctx, cleanup };
    activeSession = session;
    // SDK discovery must not warm uncached lazy servers. Explicit startup
    // lifecycles and terminal discovery retain their configured behavior.
    if (ctx.hasUI || Object.values(renderConfig?.mcpServers ?? {}).some(startsWithSession)) {
      void ensureMcpInitialized().catch(() => undefined);
    }
    if (revision !== contributionRevision) scheduleContributionRefresh(session);
  });

  pi.onMcpServerContributionsChanged?.(() => {
    contributionRevision++;
    if (activeSession) scheduleContributionRefresh(activeSession);
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentState = state;
    const retiredInitialization = initPromise;
    activeSession = null;
    state = null;
    renderConfig = undefined;
    stateOwner = null;
    initPromise = null;
    forgetDirectToolRegistrations();
    cancelStartupWarmup();

    const stateCleanup = cleanupSessionResources(
      currentState,
      "session_shutdown",
      "MCP: session shutdown cleanup failed",
    );
    const failures: unknown[] = [];
    try {
      await cleanupBarrier.close([retiredInitialization?.catch(() => undefined), stateCleanup]);
    } catch (error) {
      if (!unpublishedCleanupFailures.length) throw error;
      failures.push(error);
    }
    failures.push(...unpublishedCleanupFailures);
    if (failures.length) throw new AggregateError(failures, "MCP session cleanup failed");
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
      renderCall: (args: Record<string, unknown>, theme: Parameters<typeof renderMcpToolCall>[1]) =>
        renderMcpToolCall(args, theme, { config: state?.config ?? renderConfig, toolMetadata: state?.toolMetadata }),
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
