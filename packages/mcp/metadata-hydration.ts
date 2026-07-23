import type { McpExtensionState } from "./state.js";
import { lazyConnect, updateMetadataCache, updateServerMetadata } from "./init.js";
import { parallelLimit } from "./utils.js";
import { waitForCaller } from "./caller-wait.js";
import { assertMcpStateLease, type AssertMcpStateLease } from "./state-lease.js";

export async function hydrateServerMetadata(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
  assertActive?: AssertMcpStateLease,
): Promise<boolean> {
  signal?.throwIfAborted();
  assertMcpStateLease(assertActive);
  if (state.toolMetadata.has(serverName)) return true;
  if (!state.config.mcpServers[serverName]) return false;

  const connection = state.manager.getConnection(serverName);
  if (connection?.status === "connected") {
    assertMcpStateLease(assertActive);
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    return state.toolMetadata.has(serverName);
  }

  const connected = await waitForCaller(() => lazyConnect(state, serverName), signal);
  signal?.throwIfAborted();
  assertMcpStateLease(assertActive);
  return connected;
}

export async function hydrateMissingMetadata(
  state: McpExtensionState,
  options?: { server?: string },
  signal?: AbortSignal,
  assertActive?: AssertMcpStateLease,
): Promise<void> {
  signal?.throwIfAborted();
  assertMcpStateLease(assertActive);
  if (options?.server) {
    await hydrateServerMetadata(state, options.server, signal, assertActive);
    return;
  }

  const missingServers = Object.keys(state.config.mcpServers).filter(
    (serverName) => !state.toolMetadata.has(serverName),
  );
  await parallelLimit(missingServers, 10, async (serverName) => {
    await hydrateServerMetadata(state, serverName, signal, assertActive);
  });
  assertMcpStateLease(assertActive);
}
