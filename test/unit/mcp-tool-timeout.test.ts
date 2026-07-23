import { test } from "bun:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import * as configModule from "../../packages/mcp/config.js";
import { ConsentManager } from "../../packages/mcp/consent-manager.js";
import { createDirectToolExecutor } from "../../packages/mcp/direct-tools.js";
import { executeCall } from "../../packages/mcp/proxy-call.js";
import type { McpExtensionState } from "../../packages/mcp/state.js";
import { startUiServer } from "../../packages/mcp/ui-server.js";
import type { DirectToolSpec, McpConfig, ToolMetadata } from "../../packages/mcp/types.js";

const TOOL: ToolMetadata = {
  name: "server_run",
  originalName: "run",
  description: "run test tool",
};

const DIRECT_TOOL: DirectToolSpec = {
  serverName: "server",
  originalName: "run",
  prefixedName: "server_run",
  description: "run test tool",
};

interface ConfigValidationModule {
  readonly MCP_TIMEOUT_MS_CONFIG_ERROR?: string;
  readonly validateMcpConfig?: (raw: object) => McpConfig;
}

interface ToolHandlerContext {
  readonly hasProgressToken: boolean;
  sendProgress(progress: number): Promise<void>;
}

interface SdkPair {
  readonly client: Client;
  close(): Promise<void>;
}

async function createSdkPair(
  handler: (context: ToolHandlerContext) => Promise<CallToolResult>,
): Promise<SdkPair> {
  const server = new Server(
    { name: "timeout-test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
    const progressToken = extra._meta?.progressToken;
    return handler({
      hasProgressToken: progressToken !== undefined,
      async sendProgress(progress) {
        if (progressToken === undefined) return;
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress },
        });
      },
    });
  });

  const client = new Client({ name: "timeout-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

function createConnectedState(
  client: Client,
  timeoutMs?: number,
): { state: McpExtensionState; getInFlight(): number } {
  const definition = {
    command: "bun",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const connection = {
    client,
    definition,
    tools: [{ name: "run", description: "run test tool", inputSchema: { type: "object" } }],
    resources: [],
    status: "connected" as const,
    inFlight: 0,
    lastUsedAt: Date.now(),
  };
  const manager = {
    getConnection() { return connection; },
    touch() {},
    incrementInFlight() { connection.inFlight += 1; },
    decrementInFlight() { connection.inFlight -= 1; },
  };
  const state = {
    manager,
    lifecycle: {},
    toolMetadata: new Map([["server", [TOOL]]]),
    config: { mcpServers: { server: definition } },
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => undefined,
  } as unknown as McpExtensionState;
  return { state, getInFlight: () => connection.inFlight };
}

test("timeoutMs config rejects non-numeric, non-positive, and NaN values clearly", () => {
  const api = configModule as ConfigValidationModule;
  assert.equal(
    api.MCP_TIMEOUT_MS_CONFIG_ERROR,
    "timeoutMs must be a finite number greater than 0 milliseconds",
  );
  assert.equal(typeof api.validateMcpConfig, "function");
  const validate = api.validateMcpConfig!;
  const invalidValues = [
    { value: "slow", rendered: '"slow"' },
    { value: 0, rendered: "0" },
    { value: -1, rendered: "-1" },
    { value: Number.NaN, rendered: "NaN" },
  ];

  for (const { value, rendered } of invalidValues) {
    assert.throws(
      () => validate({ mcpServers: { demo: { command: "bun", timeoutMs: value } } }),
      (error) => error instanceof Error
        && error.name === "McpTimeoutConfigError"
        && error.message === 'Invalid MCP configuration for server "demo": '
          + api.MCP_TIMEOUT_MS_CONFIG_ERROR
          + "; received "
          + rendered
          + ".",
    );
  }
});

test("timeoutMs config accepts positive values for local and remote servers", () => {
  const validate = (configModule as ConfigValidationModule).validateMcpConfig;
  assert.equal(typeof validate, "function");
  const config = validate!({
    mcpServers: {
      local: { command: "bun", timeoutMs: 25 },
      remote: { url: "https://example.invalid/mcp", timeoutMs: 50 },
    },
  });

  assert.equal(config.mcpServers.local?.timeoutMs, 25);
  assert.equal(config.mcpServers.remote?.timeoutMs, 50);
});

test("configured direct tool timeout fires and names the server and inactivity limit", async () => {
  const pair = await createSdkPair(async () => {
    await Bun.sleep(100);
    return { content: [{ type: "text", text: "late" }] };
  });
  try {
    const { state, getInFlight } = createConnectedState(pair.client, 20);
    const execute = createDirectToolExecutor(async () => state, (candidate) => candidate === state, DIRECT_TOOL);
    const result = await execute("call", {}, undefined, undefined, {} as never);
    const text = result.content.find((item) => item.type === "text")?.text ?? "";

    assert.equal(text, 'MCP tool call to server "server" timed out after 20 ms of inactivity.');
    assert.equal(getInFlight(), 0);
  } finally {
    await pair.close();
  }
});

test("progress notifications reset the configured proxy inactivity timeout", async () => {
  let progressTokenObserved = false;
  const pair = await createSdkPair(async (context) => {
    progressTokenObserved = context.hasProgressToken;
    for (let progress = 1; progress <= 3; progress += 1) {
      await Bun.sleep(30);
      await context.sendProgress(progress);
    }
    await Bun.sleep(15);
    return { content: [{ type: "text", text: "completed" }] };
  });
  try {
    const { state, getInFlight } = createConnectedState(pair.client, 50);
    const result = await executeCall(state, TOOL.name, {}, "server");
    const text = result.content.find((item) => item.type === "text")?.text ?? "";

    assert.equal(progressTokenObserved, true);
    assert.equal(text, "completed");
    assert.equal(getInFlight(), 0);
  } finally {
    await pair.close();
  }
});

test("omitted timeoutMs keeps SDK-default behavior and does not request progress", async () => {
  let progressTokenObserved = false;
  const pair = await createSdkPair(async (context) => {
    progressTokenObserved = context.hasProgressToken;
    await Bun.sleep(70);
    return { content: [{ type: "text", text: "default" }] };
  });
  try {
    const { state } = createConnectedState(pair.client);
    const result = await executeCall(state, TOOL.name, {}, "server");
    const text = result.content.find((item) => item.type === "text")?.text ?? "";

    assert.equal(progressTokenObserved, false);
    assert.equal(text, "default");
  } finally {
    await pair.close();
  }
});

test("UI server tool path threads the configured inactivity timeout options", async () => {
  let capturedSchema: object | undefined;
  let capturedOptions: RequestOptions | undefined;
  const connection = {
    definition: { command: "bun", timeoutMs: 75 },
    status: "connected" as const,
    client: {
      async callTool(_params: object, schema?: object, options?: RequestOptions) {
        capturedSchema = schema;
        capturedOptions = options;
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
  };
  const manager = {
    getConnection() { return connection; },
    touch() {},
    incrementInFlight() {},
    decrementInFlight() {},
  };
  const handle = await startUiServer({
    serverName: "server",
    toolName: "run",
    toolArgs: {},
    resource: { uri: "ui://test", html: "<html></html>", meta: {} },
    manager: manager as never,
    consentManager: new ConsentManager("never"),
    sessionToken: "timeout-test-session",
  });
  try {
    const response = await fetch("http://127.0.0.1:" + handle.port + "/proxy/tools/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: handle.sessionToken,
        params: { name: "run", arguments: { value: 1 } },
      }),
    });
    const payload = await response.json() as { ok: boolean };

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(capturedSchema === CallToolResultSchema, true);
    assert.equal(capturedOptions?.timeout, 75);
    assert.equal(capturedOptions?.resetTimeoutOnProgress, true);
    assert.equal(typeof capturedOptions?.onprogress, "function");
  } finally {
    handle.close("test complete");
  }
});

test("UI server timeout response names the server and configured inactivity limit", async () => {
  const connection = {
    definition: { command: "bun", timeoutMs: 30 },
    status: "connected" as const,
    client: {
      async callTool() {
        throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
      },
    },
  };
  const manager = {
    getConnection() { return connection; },
    touch() {},
    incrementInFlight() {},
    decrementInFlight() {},
  };
  const handle = await startUiServer({
    serverName: "server",
    toolName: "run",
    toolArgs: {},
    resource: { uri: "ui://test", html: "<html></html>", meta: {} },
    manager: manager as never,
    consentManager: new ConsentManager("never"),
    sessionToken: "timeout-error-session",
  });
  try {
    const response = await fetch("http://127.0.0.1:" + handle.port + "/proxy/tools/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: handle.sessionToken,
        params: { name: "run", arguments: {} },
      }),
    });
    const payload = await response.json() as { ok: boolean; error?: string };

    assert.equal(response.status, 500);
    assert.equal(payload.ok, false);
    assert.equal(
      payload.error,
      'MCP tool call to server "server" timed out after 30 ms of inactivity.',
    );
  } finally {
    handle.close("test complete");
  }
});
