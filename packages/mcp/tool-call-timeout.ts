import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerEntry } from "./types.js";

export const MCP_TIMEOUT_MS_CONFIG_ERROR =
  "timeoutMs must be a finite number greater than 0 milliseconds";

export class McpTimeoutConfigError extends Error {
  constructor(serverName: string, value: unknown) {
    const rendered = typeof value === "string" ? JSON.stringify(value) : String(value);
    super(
      `Invalid MCP configuration for server "${serverName}": ${MCP_TIMEOUT_MS_CONFIG_ERROR}; received ${rendered}.`,
    );
    this.name = "McpTimeoutConfigError";
  }
}

export class McpToolCallTimeoutError extends Error {
  constructor(serverName: string, timeoutMs: number, cause?: unknown) {
    super(`MCP tool call to server "${serverName}" timed out after ${timeoutMs} ms of inactivity.`, {
      cause,
    });
    this.name = "McpToolCallTimeoutError";
  }
}

export function validateMcpServerTimeouts(
  servers: Record<string, unknown>,
): Record<string, ServerEntry> {
  for (const [serverName, rawEntry] of Object.entries(servers)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const timeoutMs = (rawEntry as Record<string, unknown>).timeoutMs;
    if (timeoutMs === undefined) continue;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new McpTimeoutConfigError(serverName, timeoutMs);
    }
  }
  return servers as Record<string, ServerEntry>;
}

export function createToolCallRequestOptions(
  definition: Pick<ServerEntry, "timeoutMs">,
  signal?: AbortSignal,
): RequestOptions | undefined {
  if (definition.timeoutMs === undefined) {
    return signal ? { signal } : undefined;
  }
  return {
    signal,
    timeout: definition.timeoutMs,
    resetTimeoutOnProgress: true,
    // The SDK only issues a progress token (and therefore only delivers the progress
    // notifications that reset this timeout) when an onprogress handler is registered,
    // so an empty handler is required for resetTimeoutOnProgress to ever fire.
    onprogress: () => {},
  };
}

export async function callToolWithConfiguredTimeout(
  client: Client,
  params: CallToolRequest["params"],
  definition: Pick<ServerEntry, "timeoutMs">,
  serverName: string,
  signal?: AbortSignal,
) {
  try {
    return await client.callTool(
      params,
      CallToolResultSchema,
      createToolCallRequestOptions(definition, signal),
    );
  } catch (error) {
    if (definition.timeoutMs !== undefined && isMcpToolCallTimeout(error)) {
      throw new McpToolCallTimeoutError(serverName, definition.timeoutMs, error);
    }
    throw error;
  }
}

export function isMcpToolCallTimeout(error: unknown): error is McpError {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}

export function formatMcpToolCallFailure(
  error: unknown,
  serverName: string,
  timeoutMs?: number,
): string {
  if (error instanceof McpToolCallTimeoutError) return error.message;
  if (timeoutMs !== undefined && isMcpToolCallTimeout(error)) {
    return new McpToolCallTimeoutError(serverName, timeoutMs).message;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to call tool: ${message}`;
}
