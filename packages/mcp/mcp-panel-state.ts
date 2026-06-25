import { isToolExcluded } from "./types.ts";
import type { MetadataCache, ServerCacheEntry, CachedTool } from "./metadata-cache.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerProvenance } from "./types.ts";
import type { ServerState, ToolState, VisibleItem } from "./mcp-panel-types.ts";

export type ToolPrefix = "server" | "none" | "short";

type ToolFilter = true | string[] | false;

export function getToolPrefix(config: McpConfig): ToolPrefix {
  return config.settings?.toolPrefix ?? "server";
}

function fuzzyScore(query: string, text: string): number {
  const lq = query.toLowerCase();
  const lt = text.toLowerCase();
  if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
  let score = 0;
  let qi = 0;
  let consecutive = 0;
  for (let i = 0; i < lt.length && qi < lq.length; i++) {
    if (lt[i] === lq[qi]) {
      score += 10 + consecutive;
      consecutive += 5;
      qi++;
    } else {
      consecutive = 0;
    }
  }
  return qi === lq.length ? score : 0;
}

function estimateTokens(tool: CachedTool): number {
  const schemaLen = JSON.stringify(tool.inputSchema ?? {}).length;
  const descLen = tool.description?.length ?? 0;
  return Math.ceil((tool.name.length + descLen + schemaLen) / 4) + 10;
}

function getToolFilter(config: McpConfig, serverName: string): ToolFilter {
  const definition = config.mcpServers[serverName];
  const globalDirect = config.settings?.directTools;
  if (definition?.directTools !== undefined) return definition.directTools;
  return globalDirect ? globalDirect : false;
}

function isDirectTool(toolFilter: ToolFilter, toolName: string): boolean {
  return toolFilter === true || (Array.isArray(toolFilter) && toolFilter.includes(toolName));
}

function cachedToolState(tool: CachedTool, toolFilter: ToolFilter): ToolState {
  const isDirect = isDirectTool(toolFilter, tool.name);
  return {
    name: tool.name,
    description: tool.description ?? "",
    isDirect,
    wasDirect: isDirect,
    estimatedTokens: estimateTokens(tool),
  };
}

function cachedResourceToolState(
  resource: { uri: string; name: string; description?: string },
  toolFilter: ToolFilter,
): ToolState {
  const baseName = `get_${resourceNameToToolName(resource.name)}`;
  const isDirect = isDirectTool(toolFilter, baseName);
  const cachedTool: CachedTool = { name: baseName, description: resource.description };
  return {
    name: baseName,
    description: resource.description ?? `Read resource: ${resource.uri}`,
    isDirect,
    wasDirect: isDirect,
    estimatedTokens: estimateTokens(cachedTool),
  };
}

export function buildServerStates(
  config: McpConfig,
  cache: MetadataCache | null,
  provenance: Map<string, ServerProvenance>,
  callbacks: McpPanelCallbacks,
  authOnly: boolean,
  prefix: ToolPrefix,
): ServerState[] {
  const servers: ServerState[] = [];

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (authOnly && !callbacks.canAuthenticate(serverName)) continue;
    const prov = provenance.get(serverName);
    const serverCache = cache?.servers?.[serverName];
    const toolFilter = getToolFilter(config, serverName);
    const tools: ToolState[] = [];

    if (serverCache && !authOnly) {
      for (const tool of serverCache.tools ?? []) {
        if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) continue;
        tools.push(cachedToolState(tool, toolFilter));
      }
      if (definition.exposeResources !== false) {
        for (const resource of serverCache.resources ?? []) {
          const baseName = `get_${resourceNameToToolName(resource.name)}`;
          if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) continue;
          tools.push(cachedResourceToolState(resource, toolFilter));
        }
      }
    }

    servers.push({
      name: serverName,
      expanded: false,
      source: prov?.kind ?? "user",
      importKind: prov?.importKind,
      excludeTools: definition.excludeTools,
      exposeResources: definition.exposeResources !== false,
      connectionStatus: callbacks.getConnectionStatus(serverName),
      tools,
      hasCachedData: !!serverCache,
    });
  }

  return servers;
}

export function rebuildVisibleItems(
  servers: ServerState[],
  nameQuery: string,
  descSearchActive: boolean,
  descQuery: string,
  authOnly: boolean,
): VisibleItem[] {
  const query = descSearchActive ? descQuery : nameQuery;
  const mode = descSearchActive ? "desc" : "name";
  const items: VisibleItem[] = [];

  for (let si = 0; si < servers.length; si++) {
    const server = servers[si];
    if (query && authOnly) {
      const score = mode === "name" ? fuzzyScore(query, server.name) : 0;
      if (score > 0) items.push({ type: "server", serverIndex: si });
      continue;
    }

    items.push({ type: "server", serverIndex: si });
    if (server.expanded || query) {
      for (let ti = 0; ti < server.tools.length; ti++) {
        const tool = server.tools[ti];
        if (query) {
          const score = mode === "name"
            ? Math.max(fuzzyScore(query, tool.name), fuzzyScore(query, server.name) * 0.6)
            : fuzzyScore(query, tool.description);
          if (score === 0) continue;
        }
        items.push({ type: "tool", serverIndex: si, toolIndex: ti });
      }
    }
  }

  if (!query || authOnly) return items;
  return items.filter((item) => {
    if (item.type === "server") {
      return items.some((other) => other.type === "tool" && other.serverIndex === item.serverIndex);
    }
    return true;
  });
}

export function calculateDirty(servers: ServerState[]): boolean {
  return servers.some((server) => server.tools.some((tool) => tool.isDirect !== tool.wasDirect));
}

export function buildMcpPanelResult(servers: ServerState[]): McpPanelResult {
  const changes = new Map<string, true | string[] | false>();
  for (const server of servers) {
    const changed = server.tools.some((tool) => tool.isDirect !== tool.wasDirect);
    if (!changed) continue;
    const directTools = server.tools.filter((tool) => tool.isDirect);
    if (directTools.length === server.tools.length && server.tools.length > 0) {
      changes.set(server.name, true);
    } else if (directTools.length === 0) {
      changes.set(server.name, false);
    } else {
      changes.set(server.name, directTools.map((tool) => tool.name));
    }
  }
  return { changes, cancelled: false };
}

export function rebuildServerTools(server: ServerState, entry: ServerCacheEntry, prefix: ToolPrefix): void {
  const existingState = new Map<string, boolean>();
  for (const tool of server.tools) existingState.set(tool.name, tool.isDirect);

  const newTools: ToolState[] = [];
  for (const tool of entry.tools ?? []) {
    if (isToolExcluded(tool.name, server.name, prefix, server.excludeTools)) continue;

    const prev = existingState.get(tool.name);
    const isDirect = prev !== undefined ? prev : false;
    newTools.push({
      name: tool.name,
      description: tool.description ?? "",
      isDirect,
      wasDirect: prev !== undefined ? server.tools.find((oldTool) => oldTool.name === tool.name)?.wasDirect ?? false : false,
      estimatedTokens: estimateTokens(tool),
    });
  }

  if (server.exposeResources) {
    for (const resource of entry.resources ?? []) {
      const baseName = `get_${resourceNameToToolName(resource.name)}`;
      if (isToolExcluded(baseName, server.name, prefix, server.excludeTools)) continue;

      const prev = existingState.get(baseName);
      const isDirect = prev !== undefined ? prev : false;
      const cachedTool: CachedTool = { name: baseName, description: resource.description };
      newTools.push({
        name: baseName,
        description: resource.description ?? `Read resource: ${resource.uri}`,
        isDirect,
        wasDirect: prev !== undefined ? server.tools.find((tool) => tool.name === baseName)?.wasDirect ?? false : false,
        estimatedTokens: estimateTokens(cachedTool),
      });
    }
  }

  server.tools = newTools;
}
