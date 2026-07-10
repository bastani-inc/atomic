import type { McpExtensionState } from "./state.ts";
import { lazyConnect, updateMetadataCache, updateServerMetadata } from "./init.ts";
import { parallelLimit } from "./utils.ts";

export async function hydrateServerMetadata(
  state: McpExtensionState,
  serverName: string,
): Promise<boolean> {
  if (state.toolMetadata.has(serverName)) return true;
  if (!state.config.mcpServers[serverName]) return false;

  const connection = state.manager.getConnection(serverName);
  if (connection?.status === "connected") {
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    return state.toolMetadata.has(serverName);
  }

  return lazyConnect(state, serverName);
}

export async function hydrateMissingMetadata(
  state: McpExtensionState,
  options?: { server?: string },
): Promise<void> {
  if (options?.server) {
    await hydrateServerMetadata(state, options.server);
    return;
  }

  const missingServers = Object.keys(state.config.mcpServers).filter(
    (serverName) => !state.toolMetadata.has(serverName),
  );
  await parallelLimit(missingServers, 10, async (serverName) => {
    await hydrateServerMetadata(state, serverName);
  });
}
