import type { DirectToolSpec, McpConfig } from "./types.js";
import type { MetadataCache } from "./metadata-cache.js";
import { isServerCacheValid } from "./metadata-cache.js";
import { formatToolName, isToolExcluded } from "./types.js";
import { resourceNameToToolName } from "./resource-tools.js";

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "search", "ls", "mcp"]);

interface DirectToolSelection {
  readonly servers: ReadonlySet<string>;
  readonly toolsByServer: ReadonlyMap<string, ReadonlySet<string>>;
}

function parseDirectToolSelection(items: readonly string[] | undefined): DirectToolSelection {
  const servers = new Set<string>();
  const toolsByServer = new Map<string, Set<string>>();
  for (const rawItem of items ?? []) {
    const item = rawItem.replace(/\/+$/, "");
    if (!item) continue;
    if (!item.includes("/")) {
      servers.add(item);
      continue;
    }
    const [server, tool] = item.split("/", 2);
    if (!server) continue;
    if (!tool) {
      servers.add(server);
      continue;
    }
    if (!toolsByServer.has(server)) toolsByServer.set(server, new Set());
    toolsByServer.get(server)!.add(tool);
  }
  return { servers, toolsByServer };
}

function directToolSelectionIncludes(selection: DirectToolSelection, serverName: string): boolean {
  return selection.servers.has(serverName) || selection.toolsByServer.has(serverName);
}

export function resolveDirectTools(
  config: McpConfig,
  cache: MetadataCache | null,
  prefix: "server" | "none" | "short",
  envOverride?: string[],
): DirectToolSpec[] {
  const specs: DirectToolSpec[] = [];
  if (!cache) return specs;

  const seenNames = new Set<string>();

  const envSelection = parseDirectToolSelection(envOverride);

  const globalDirect = config.settings?.directTools;

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    const serverCache = cache.servers[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) continue;

    let toolFilter: true | string[] | false = false;

    if (envOverride) {
      if (envSelection.servers.has(serverName)) {
        toolFilter = true;
      } else if (envSelection.toolsByServer.has(serverName)) {
        toolFilter = [...envSelection.toolsByServer.get(serverName)!];
      }
    } else {
      if (definition.directTools !== undefined) {
        toolFilter = definition.directTools;
      } else if (globalDirect) {
        toolFilter = globalDirect;
      }
    }

    if (!toolFilter) continue;

    for (const tool of serverCache.tools ?? []) {
      if (toolFilter !== true && !toolFilter.includes(tool.name)) continue;
      if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) continue;
      const prefixedName = formatToolName(tool.name, serverName, prefix);
      if (BUILTIN_NAMES.has(prefixedName)) {
        console.warn(`MCP: skipping direct tool "${prefixedName}" (collides with builtin)`);
        continue;
      }
      if (seenNames.has(prefixedName)) {
        console.warn(`MCP: skipping duplicate direct tool "${prefixedName}" from "${serverName}"`);
        continue;
      }
      seenNames.add(prefixedName);
      specs.push({
        serverName,
        originalName: tool.name,
        prefixedName,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        uiResourceUri: tool.uiResourceUri,
        uiStreamMode: tool.uiStreamMode,
      });
    }

    if (definition.exposeResources !== false) {
      for (const resource of serverCache.resources ?? []) {
        const baseName = `get_${resourceNameToToolName(resource.name)}`;
        if (toolFilter !== true && !toolFilter.includes(baseName)) continue;
        if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) continue;
        const prefixedName = formatToolName(baseName, serverName, prefix);
        if (BUILTIN_NAMES.has(prefixedName)) {
          console.warn(`MCP: skipping direct resource tool "${prefixedName}" (collides with builtin)`);
          continue;
        }
        if (seenNames.has(prefixedName)) {
          console.warn(`MCP: skipping duplicate direct resource tool "${prefixedName}" from "${serverName}"`);
          continue;
        }
        seenNames.add(prefixedName);
        specs.push({
          serverName,
          originalName: baseName,
          prefixedName,
          description: resource.description ?? `Read resource: ${resource.uri}`,
          resourceUri: resource.uri,
        });
      }
    }
  }

  return specs;
}

export function getMissingConfiguredDirectToolServers(
  config: McpConfig,
  cache: MetadataCache | null,
  envOverride?: readonly string[],
): string[] {
  const missing: string[] = [];
  const globalDirect = config.settings?.directTools;
  const envSelection = parseDirectToolSelection(envOverride);
  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    const hasConfiguredDirectTools = definition.directTools !== undefined
      ? !!definition.directTools
      : !!globalDirect;
    const hasDirectTools = envOverride
      ? directToolSelectionIncludes(envSelection, serverName)
      : hasConfiguredDirectTools;

    if (!hasDirectTools) continue;

    const serverCache = cache?.servers?.[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) {
      missing.push(serverName);
    }
  }

  return missing;
}

export function buildProxyDescription(
  config: McpConfig,
  cache: MetadataCache | null,
  directSpecs: DirectToolSpec[],
): string {
  const prefix = config.settings?.toolPrefix ?? "server";
  let desc = `MCP gateway - connect to MCP servers and call their tools. Non-MCP Pi tools should be called directly, not through mcp.\n`;

  const directByServer = new Map<string, number>();
  for (const spec of directSpecs) {
    directByServer.set(spec.serverName, (directByServer.get(spec.serverName) ?? 0) + 1);
  }
  if (directByServer.size > 0) {
    const parts = [...directByServer.entries()].map(
      ([server, count]) => `${server} (${count})`,
    );
    desc += `\nDirect tools available (call as normal tools): ${parts.join(", ")}\n`;
  }

  const serverSummaries: string[] = [];
  for (const serverName of Object.keys(config.mcpServers)) {
    const entry = cache?.servers?.[serverName];
    const definition = config.mcpServers[serverName];
    const toolCount = (entry?.tools ?? []).filter(
      (tool) => !isToolExcluded(tool.name, serverName, prefix, definition.excludeTools),
    ).length;
    const resourceCount = definition?.exposeResources !== false
      ? (entry?.resources ?? []).filter((resource) => {
          const baseName = `get_${resourceNameToToolName(resource.name)}`;
          return !isToolExcluded(baseName, serverName, prefix, definition.excludeTools);
        }).length
      : 0;
    const totalItems = toolCount + resourceCount;
    if (totalItems === 0) continue;
    const directCount = directByServer.get(serverName) ?? 0;
    const proxyCount = totalItems - directCount;
    if (proxyCount > 0) {
      serverSummaries.push(`${serverName} (${proxyCount} tools)`);
    }
  }

  if (serverSummaries.length > 0) {
    desc += `\nServers: ${serverSummaries.join(", ")}\n`;
  }

  desc += `\nUsage:\n`;
  desc += `  mcp({ })                              → Show server status\n`;
  desc += `  mcp({ server: "name" })               → List tools from server\n`;
  desc += `  mcp({ search: "query" })              → Search MCP tools by name/description\n`;
  desc += `  mcp({ describe: "tool_name" })        → Show tool details and parameters\n`;
  desc += `  mcp({ connect: "server-name" })       → Connect to a server and refresh metadata\n`;
  desc += `  mcp({ tool: "name", args: '{"key": "value"}' })    → Call a tool (args is JSON string)\n`;
  desc += `  mcp({ action: "ui-messages" })        → Retrieve accumulated messages from completed UI sessions\n`;
  desc += `\nMode: tool (call) > connect > describe > search > server (list) > action > nothing (status)`;

  return desc;
}


export { createDirectToolExecutor } from "./direct-tool-executor.js";
