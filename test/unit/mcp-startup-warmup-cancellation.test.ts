import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleMcpStartupWarmup } from "../../packages/mcp/startup-warmup.ts";
import type { McpExtensionState } from "../../packages/mcp/state.ts";
import type { McpServerManager } from "../../packages/mcp/server-manager.ts";
import type { McpConfig } from "../../packages/mcp/types.ts";

const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
let tmpRoot = "";

type McpConnection = Awaited<ReturnType<McpServerManager["connect"]>>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "atomic-mcp-warmup-cancel-"));
  process.env.ATOMIC_CODING_AGENT_DIR = join(tmpRoot, "agent");
  delete process.env.MCP_DIRECT_TOOLS;
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
  else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
  if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
  else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

test("MCP startup warmup discards post-connect metadata after cancellation", async () => {
  const started = deferred<void>();
  const release = deferred<McpConnection>();
  let currentConnection: McpConnection | undefined;
  let closeCalls = 0;
  let directToolCallbacks = 0;
  let settled = false;
  const manager = {
    async connect(): Promise<McpConnection> {
      started.resolve();
      currentConnection = await release.promise;
      return currentConnection;
    },
    getConnection(): McpConnection | undefined {
      return currentConnection;
    },
    async close(): Promise<void> {
      closeCalls += 1;
      currentConnection = undefined;
    },
  } as Pick<McpServerManager, "connect" | "getConnection" | "close"> as McpServerManager;
  const config: McpConfig = {
    mcpServers: {
      lazy: { command: "bun", args: ["--version"], directTools: true },
    },
  };
  const state = {
    manager,
    config,
    toolMetadata: new Map(),
    lifecycle: {},
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => undefined,
  } as unknown as McpExtensionState;
  const handle = scheduleMcpStartupWarmup(state, {
    onDirectToolsChanged: () => { directToolCallbacks += 1; },
    onSettled: () => { settled = true; },
  });
  await started.promise;
  handle.cancel();
  release.resolve({
    client: { close: async () => undefined },
    transport: { close: async () => undefined },
    definition: config.mcpServers.lazy!,
    tools: [{ name: "late_tool", description: "late", inputSchema: { type: "object", properties: {} } }],
    resources: [],
    lastUsedAt: Date.now(),
    inFlight: 0,
    status: "connected",
  } as unknown as McpConnection);
  await handle.promise;
  assert.equal(closeCalls, 1);
  assert.equal(state.toolMetadata.size, 0);
  assert.equal(directToolCallbacks, 0);
  assert.equal(settled, true);
});

test("MCP startup warmup hydrates env-selected direct tool servers on cold cache", async () => {
  process.env.MCP_DIRECT_TOOLS = "github/search_code";
  const connected: string[] = [];
  const connections = new Map<string, McpConnection>();
  const config: McpConfig = {
    mcpServers: {
      github: { command: "bun", args: ["--version"] },
      unrelated: { command: "bun", args: ["--version"] },
    },
  };
  const manager = {
    async connect(name: string): Promise<McpConnection> {
      connected.push(name);
      const connection = {
        client: { close: async () => undefined },
        transport: { close: async () => undefined },
        definition: config.mcpServers[name]!,
        tools: [{ name: "search_code", description: "search", inputSchema: { type: "object", properties: {} } }],
        resources: [],
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
      } as unknown as McpConnection;
      connections.set(name, connection);
      return connection;
    },
    getConnection(name: string): McpConnection | undefined {
      return connections.get(name);
    },
    async close(name: string): Promise<void> {
      connections.delete(name);
    },
  } as Pick<McpServerManager, "connect" | "getConnection" | "close"> as McpServerManager;
  const state = {
    manager,
    config,
    toolMetadata: new Map(),
    lifecycle: {},
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => undefined,
  } as unknown as McpExtensionState;
  let directToolCallbacks = 0;

  const handle = scheduleMcpStartupWarmup(state, { onDirectToolsChanged: () => { directToolCallbacks += 1; } });
  await handle.promise;

  assert.deepEqual(connected, ["github"]);
  assert.equal(state.toolMetadata.has("github"), true);
  assert.equal(state.toolMetadata.has("unrelated"), false);
  assert.equal(directToolCallbacks, 1);
});

test("MCP_DIRECT_TOOLS none disables startup warmup", async () => {
  process.env.MCP_DIRECT_TOOLS = "__none__";
  let connectCalls = 0;
  const manager = {
    async connect(): Promise<McpConnection> {
      connectCalls += 1;
      throw new Error("should not connect");
    },
    getConnection(): McpConnection | undefined {
      return undefined;
    },
    async close(): Promise<void> {},
  } as Pick<McpServerManager, "connect" | "getConnection" | "close"> as McpServerManager;
  const state = {
    manager,
    config: { mcpServers: { lazy: { command: "bun", args: ["--version"], directTools: true } } },
    toolMetadata: new Map(),
    lifecycle: {},
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => undefined,
  } as unknown as McpExtensionState;

  const handle = scheduleMcpStartupWarmup(state);
  await handle.promise;

  assert.equal(connectCalls, 0);
  assert.equal(state.toolMetadata.size, 0);
});
