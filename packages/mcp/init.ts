import { reportOwnedMcpLog } from "./diagnostics.js";
import type { ExtensionAPI, ExtensionContext, McpServerContribution } from "@bastani/atomic";
import { reportMcpDiagnostic } from "./diagnostics.js";
import type { McpExtensionState } from "./state.js";
import type { ServerEntry, ToolMetadata } from "./types.js";
import { existsSync } from "node:fs";
import { getContributedServerSources, loadMcpConfig } from "./config.ts";
import { ConsentManager } from "./consent-manager.js";
import { McpLifecycleManager } from "./lifecycle.ts";
import {
  computeServerHash,
  getMetadataCachePath,
  isServerCacheValid,
  loadMetadataCache,
  reconstructToolMetadata,
  saveMetadataCache,
  serializeResources,
  serializeTools,
  type MetadataCache,
  type ServerCacheEntry,
} from "./metadata-cache.js";
import { McpServerManager } from "./server-manager.ts";
import { buildToolMetadata, totalToolCount } from "./tool-metadata.js";
import { UiResourceHandler } from "./ui-resource-handler.ts";
import { openUrl, parallelLimit } from "./utils.js";
import { isProviderAuth, providerSignInGuidance } from "./provider-auth.js";
import { logger } from "./logger.ts";

const FAILURE_BACKOFF_MS = 60 * 1000;

export async function initializeMcp(
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<McpExtensionState> {
  const configPath = pi.getFlag("mcp-config") as string | undefined;
  const contributions = pi.getMcpServerContributions?.() ?? [];
  const config = loadMcpConfig(configPath, ctx.cwd, contributions);

  const manager = new McpServerManager();
  manager.setProviderTokenResolver((provider) => ctx.modelRegistry.getApiKeyForProvider(provider));
  const lifecycle = new McpLifecycleManager(manager);
  try {
    const samplingAutoApprove = config.settings?.samplingAutoApprove === true;
    if (config.settings?.sampling !== false && (ctx.hasUI || samplingAutoApprove)) {
      manager.setSamplingConfig({
        autoApprove: samplingAutoApprove,
        ui: ctx.hasUI ? ctx.ui : undefined,
        modelRegistry: ctx.modelRegistry,
        getCurrentModel: () => ctx.model,
        getSignal: () => ctx.signal,
      });
    }
    const toolMetadata = new Map<string, ToolMetadata[]>();
    const failureTracker = new Map<string, number>();
    const uiResourceHandler = new UiResourceHandler(manager);
    const consentManager = new ConsentManager("once-per-server");
    const ui = ctx.hasUI ? ctx.ui : undefined;
    const state: McpExtensionState = {
      manager,
      lifecycle,
      toolMetadata,
      config,
      contributedSources: getContributedServerSources(configPath, ctx.cwd, contributions),
      failureTracker,
      uiResourceHandler,
      consentManager,
      uiServer: null,
      completedUiSessions: [],
      openBrowser: (url: string) => openUrl(pi, url, process.env.BROWSER),
      ui,
      sendMessage: (message, options) => pi.sendMessage(message as unknown as Parameters<typeof pi.sendMessage>[0], options),
    };

    const serverEntries = Object.entries(config.mcpServers);
    if (serverEntries.length === 0) {
      return state;
    }

    const idleSetting = typeof config.settings?.idleTimeout === "number" ? config.settings.idleTimeout : 10;
    lifecycle.setGlobalIdleTimeout(idleSetting);

    const cachePath = getMetadataCachePath();
    const cacheFileExists = existsSync(cachePath);
    let cache = loadMetadataCache();
    if (!cacheFileExists) {
      saveMetadataCache({ version: 1, servers: {} });
    } else if (!cache) {
      cache = { version: 1, servers: {} };
      saveMetadataCache(cache);
    }

    const prefix = config.settings?.toolPrefix ?? "server";

    for (const [name, definition] of serverEntries) {
      registerServer(state, name, definition, cache, prefix);
    }

    const startupServers = serverEntries.filter(([, definition]) => {
      const mode = definition.lifecycle ?? "lazy";
      return mode === "keep-alive" || mode === "eager";
    });

    if (ctx.hasUI && startupServers.length > 0) {
      ctx.ui.setStatus("mcp", `MCP: connecting to ${startupServers.length} servers...`);
    }

    const results = await parallelLimit(startupServers, 10, async ([name, definition]) => {
      try {
        const connection = await manager.connect(name, definition);
        if (connection.status === "needs-auth") {
          return {
            name,
            definition,
            connection: null,
            error: providerSignInGuidance(definition, name) ?? `OAuth authentication required. Run /mcp-auth ${name}.`,
          };
        }
        return { name, definition, connection, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name, definition, connection: null, error: message };
    }
  });

  for (const { name, definition, connection, error } of results) {
    if (error || !connection) {
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to connect to ${formatMcpServerName(state, name)}: ${error}`, "error");
      }
      reportMcpDiagnostic(pi, "MCP startup connection failed");
      continue;
    }

    const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
    toolMetadata.set(name, metadata);
    updateMetadataCache(state, name);

    if (failedTools.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `MCP: ${name} - ${failedTools.length} tools skipped`,
        "warning"
      );
    }
  }

  const connectedCount = results.filter(r => r.connection).length;
  const failedCount = results.filter(r => r.error).length;
  if (ctx.hasUI && connectedCount > 0) {
    const totalTools = totalToolCount(state);
    const msg = failedCount > 0
      ? `MCP: ${connectedCount}/${startupServers.length} servers connected (${totalTools} tools)`
      : `MCP: ${connectedCount} servers connected (${totalTools} tools)`;
    ctx.ui.notify(msg, "info");
  }

  startLifecycle(state);

  return state;
  } catch (error) {
    try {
      await lifecycle.gracefulShutdown();
    } catch (cleanupError) {
      if (!reportOwnedMcpLog("error")) console.error("MCP: failed to clean resources after initialization failure", cleanupError);
    }
    throw error;
  }
}

/** Server name with its contributing package or extension, for user-facing diagnostics. */
export function formatMcpServerName(state: McpExtensionState, name: string): string {
  const source = state.contributedSources?.get(name);
  return source ? `${name} (${source})` : name;
}

function registerServer(
  state: McpExtensionState,
  name: string,
  definition: ServerEntry,
  cache: MetadataCache | null,
  prefix: "server" | "none" | "short",
): void {
  const lifecycleMode = definition.lifecycle ?? "lazy";
  const idleOverride = definition.idleTimeout ?? (lifecycleMode === "eager" ? 0 : undefined);
  state.lifecycle.registerServer(
    name,
    definition,
    idleOverride !== undefined ? { idleTimeout: idleOverride } : undefined
  );
  if (lifecycleMode === "keep-alive") {
    state.lifecycle.markKeepAlive(name, definition);
  }

  if (cache?.servers?.[name] && isServerCacheValid(cache.servers[name], definition)) {
    const metadata = reconstructToolMetadata(name, cache.servers[name], prefix, definition);
    state.toolMetadata.set(name, metadata);
  }
}

function startLifecycle(state: McpExtensionState): void {
  state.lifecycle.setReconnectCallback((serverName) => {
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
  });

  state.lifecycle.setIdleShutdownCallback((serverName) => {
    const idleMinutes = getEffectiveIdleTimeoutMinutes(state, serverName);
    logger.debug(`${serverName} shut down (idle ${idleMinutes}m)`);
    updateStatusBar(state);
  });

  state.lifecycle.startHealthChecks();
}

/**
 * Reload the server set, contributions included, into a running state: removed or redefined servers are
 * closed and new definitions registered. Returns the changed names; connecting new startup servers is the
 * caller's job.
 */
export async function applyMcpConfigChanges(
  state: McpExtensionState,
  configPath: string | undefined,
  cwd: string,
  contributions: readonly McpServerContribution[],
): Promise<string[]> {
  const previous = state.config.mcpServers;
  const next = loadMcpConfig(configPath, cwd, contributions).mcpServers;
  const changed = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((name) => JSON.stringify(previous[name]) !== JSON.stringify(next[name]));
  state.config = { ...state.config, mcpServers: next };
  state.contributedSources = getContributedServerSources(configPath, cwd, contributions);
  if (changed.length === 0) return changed;

  const cache = loadMetadataCache();
  const settings = state.config.settings;
  const prefix = settings?.toolPrefix ?? "server";
  state.lifecycle.setGlobalIdleTimeout(typeof settings?.idleTimeout === "number" ? settings.idleTimeout : 10);
  for (const name of changed) {
    await state.manager.close(name);
    state.lifecycle.unregisterServer(name);
    state.toolMetadata.delete(name);
    state.failureTracker.delete(name);
    const definition = next[name];
    if (definition) registerServer(state, name, definition, cache, prefix);
  }
  startLifecycle(state);
  updateStatusBar(state);
  return changed;
}

export function updateServerMetadata(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return;

  const prefix = state.config.settings?.toolPrefix ?? "server";

  const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
  state.toolMetadata.set(serverName, metadata);
}

export function updateMetadataCache(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return;

  const configHash = computeServerHash(definition);
  const existing = loadMetadataCache();
  const existingEntry = existing?.servers?.[serverName];

  const tools = serializeTools(connection.tools);
  let resources = definition.exposeResources === false ? [] : serializeResources(connection.resources);

  if (
    definition.exposeResources !== false &&
    resources.length === 0 &&
    existingEntry?.resources?.length &&
    existingEntry.configHash === configHash
  ) {
    resources = existingEntry.resources;
  }

  const entry: ServerCacheEntry = {
    configHash,
    tools,
    resources,
    cachedAt: Date.now(),
  };

  saveMetadataCache({ version: 1, servers: { [serverName]: entry } });
}

export function flushMetadataCache(state: McpExtensionState): void {
  for (const [name, connection] of state.manager.getAllConnections()) {
    if (connection.status === "connected") {
      updateMetadataCache(state, name);
    }
  }
}

export function updateStatusBar(state: McpExtensionState): void {
  const ui = state.ui;
  if (!ui) return;
  const total = Object.keys(state.config.mcpServers).length;
  if (total === 0) {
    ui.setStatus("mcp", undefined);
    return;
  }
  const connectedCount = [...state.manager.getAllConnections().values()].filter(
    (connection) => connection.status === "connected",
  ).length;
  const text = `MCP: ${connectedCount}/${total} servers`;
  ui.setStatus("mcp", colorizeStatusText(ui, text));
}

function colorizeStatusText(ui: NonNullable<McpExtensionState["ui"]>, text: string): string {
  const theme = (ui as { theme?: { fg?: (color: string, text: string) => string } }).theme;
  if (typeof theme?.fg !== "function") return text;
  try {
    return theme.fg("accent", text);
  } catch {
    return text;
  }
}

export function getFailureAgeSeconds(state: McpExtensionState, serverName: string): number | null {
  const failedAt = state.failureTracker.get(serverName);
  if (!failedAt) return null;
  const ageMs = Date.now() - failedAt;
  if (ageMs > FAILURE_BACKOFF_MS) return null;
  return Math.round(ageMs / 1000);
}

export async function lazyConnect(state: McpExtensionState, serverName: string): Promise<boolean> {
  const connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    if (!isProviderAuth(state.config.mcpServers[serverName]?.auth)) return false;
    await state.manager.close(serverName);
  }
  if (connection?.status === "connected") {
    updateServerMetadata(state, serverName);
    return true;
  }

  const failedAgo = getFailureAgeSeconds(state, serverName);
  if (failedAgo !== null) return false;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return false;

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    }
    const newConnection = await state.manager.connect(serverName, definition);
    if (newConnection.status === "needs-auth") {
      return false;
    }
    state.failureTracker.delete(serverName);
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    updateStatusBar(state);
    return true;
  } catch (error) {
    state.failureTracker.set(serverName, Date.now());
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`MCP: lazy connect failed for ${serverName}: ${message}`);
    updateStatusBar(state);
    return false;
  }
}

function getEffectiveIdleTimeoutMinutes(state: McpExtensionState, serverName: string): number {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return typeof state.config.settings?.idleTimeout === "number" ? state.config.settings.idleTimeout : 10;
  }
  if (typeof definition.idleTimeout === "number") return definition.idleTimeout;
  const mode = definition.lifecycle ?? "lazy";
  if (mode === "eager") return 0;
  return typeof state.config.settings?.idleTimeout === "number" ? state.config.settings.idleTimeout : 10;
}
