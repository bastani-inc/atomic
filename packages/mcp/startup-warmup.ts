import type { McpExtensionState } from "./state.ts";
import { getMissingConfiguredDirectToolServers } from "./direct-tools.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import { buildToolMetadata } from "./tool-metadata.ts";
import { parallelLimit } from "./utils.ts";
import { logger } from "./logger.ts";
import { updateMetadataCache, updateStatusBar } from "./init.ts";

export interface McpStartupWarmupOptions {
  shouldContinue?: () => boolean;
  onDirectToolsChanged?: () => void | Promise<void>;
  onSettled?: () => void;
}

export interface McpStartupWarmupHandle {
  readonly promise: Promise<void>;
  cancel(): void;
}

function deferToMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function scheduleMcpStartupWarmup(
  state: McpExtensionState,
  options: McpStartupWarmupOptions = {},
): McpStartupWarmupHandle {
  let cancelled = false;
  const shouldContinue = (): boolean => !cancelled && (options.shouldContinue?.() ?? true);

  const promise = (async () => {
    await deferToMacrotask();
    if (!shouldContinue()) return;

    const envDirect = process.env.MCP_DIRECT_TOOLS;
    if (envDirect === "__none__") return;

    const envDirectTools = envDirect?.split(",").map((item) => item.trim()).filter(Boolean);
    const missingCacheServers = getMissingConfiguredDirectToolServers(state.config, loadMetadataCache(), envDirectTools)
      .filter((name) => state.manager.getConnection(name)?.status !== "connected");
    if (missingCacheServers.length === 0) return;

    const prefix = state.config.settings?.toolPrefix ?? "server";
    const results = await parallelLimit(missingCacheServers, 10, async (name) => {
      if (!shouldContinue()) return { name, ok: false };
      const definition = state.config.mcpServers[name];
      if (!definition) return { name, ok: false };
      try {
        const connection = await state.manager.connect(name, definition);
        if (!shouldContinue()) {
          if (state.manager.getConnection(name) === connection) {
            await state.manager.close(name);
          }
          return { name, ok: false };
        }
        if (connection.status === "needs-auth") return { name, ok: false };
        const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
        state.toolMetadata.set(name, metadata);
        updateMetadataCache(state, name);
        return { name, ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`MCP: background direct-tools warmup failed for ${name}: ${message}`);
        return { name, ok: false };
      }
    });

    if (!shouldContinue()) return;
    const warmed = results.filter((result) => result.ok).map((result) => result.name);
    if (warmed.length === 0) return;
    updateStatusBar(state);
    if (!shouldContinue()) return;
    await options.onDirectToolsChanged?.();
    if (!shouldContinue()) return;
    if (state.ui) {
      state.ui.notify(`MCP: direct tools for ${warmed.join(", ")} are now available`, "info");
    }
  })()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`MCP: background startup warmup failed: ${message}`);
    })
    .finally(() => {
      try {
        options.onSettled?.();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`MCP: background startup warmup settled callback failed: ${message}`);
      }
    });

  return {
    promise,
    cancel() {
      cancelled = true;
    },
  };
}
