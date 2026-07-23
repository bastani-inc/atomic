import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectToolExecutor } from "../../packages/mcp/direct-tools.js";
import { executeSearch } from "../../packages/mcp/proxy-info-modes.js";
import { executeConnect } from "../../packages/mcp/proxy-connect.js";
import { executeCall } from "../../packages/mcp/proxy-call.js";
import type { McpExtensionState } from "../../packages/mcp/state.js";
import { McpServerManager } from "../../packages/mcp/server-manager.js";
import { McpLifecycleManager } from "../../packages/mcp/lifecycle.js";
import { UiResourceHandler } from "../../packages/mcp/ui-resource-handler.js";
import { ConsentManager } from "../../packages/mcp/consent-manager.js";
import type { DirectToolSpec, McpTool, ToolMetadata } from "../../packages/mcp/types.js";
import { waitForCondition } from "../support/wait-for-condition.js";
import { McpStateChangedError } from "../../packages/mcp/state-lease.js";

interface LazyHarness {
  readonly state: McpExtensionState;
  readonly sdkCalls: string[];
  readonly connectAttempts: () => number;
  releaseConnection(): void;
}

const directSpec: DirectToolSpec = {
  serverName: "server",
  originalName: "run",
  prefixedName: "server_run",
  description: "run",
};

function createLazyHarness(): LazyHarness {
  const sdkCalls: string[] = [];
  const serverTool: McpTool = {
    name: "run",
    description: "shared lazy tool",
    inputSchema: { type: "object", properties: {} },
  };
  const connection = {
    client: {
      async callTool(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        sdkCalls.push("call");
        return { content: [{ type: "text", text: "ok" }] };
      },
      async readResource(): Promise<{ contents: [] }> { return { contents: [] }; },
    },
    tools: [serverTool],
    resources: [],
    status: "connected" as const,
    inFlight: 0,
    lastUsedAt: Date.now(),
  };
  let currentConnection: typeof connection | undefined;
  let release!: () => void;
  let sharedConnect: Promise<typeof connection> | undefined;
  let attempts = 0;
  const manager: McpServerManager = Object.assign(new McpServerManager(), {
    connect(): Promise<typeof connection> {
      if (sharedConnect) return sharedConnect;
      attempts += 1;
      sharedConnect = new Promise<typeof connection>((resolve) => {
        release = () => {
          currentConnection = connection;
          resolve(connection);
        };
      });
      return sharedConnect;
    },
    getConnection: () => currentConnection,
    getAllConnections: () => new Map(currentConnection ? [["server", currentConnection]] : []),
    touch() {},
    incrementInFlight() { connection.inFlight += 1; },
    decrementInFlight() { connection.inFlight -= 1; },
  });
  const state: McpExtensionState = {
    manager,
    lifecycle: new McpLifecycleManager(manager),
    toolMetadata: new Map<string, ToolMetadata[]>(),
    config: { mcpServers: { server: { command: "bun" } } },
    failureTracker: new Map<string, number>(),
    uiResourceHandler: new UiResourceHandler(manager),
    consentManager: new ConsentManager("once-per-server"),
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => undefined,
  };
  return {
    state,
    sdkCalls,
    connectAttempts: () => attempts,
    releaseConnection: () => release(),
  };
}

const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
let tempRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "atomic-mcp-caller-wait-"));
  process.env.ATOMIC_CODING_AGENT_DIR = join(tempRoot, "agent");
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
  else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("one direct caller cancels its shared lazy-connect wait while a survivor uses the same attempt", async () => {
  const harness = createLazyHarness();
  const execute = createDirectToolExecutor(
    async () => harness.state,
    (candidate) => candidate === harness.state,
    directSpec,
  );
  const cancelledController = new AbortController();
  const survivorController = new AbortController();
  const reason = new Error("cancel only this direct connection wait");

  const cancelled = execute("cancelled", {}, cancelledController.signal, undefined, {} as never);
  const survivor = execute("survivor", {}, survivorController.signal, undefined, {} as never);
  await Promise.resolve();
  cancelledController.abort(reason);
  let cancelledSettled = false;
  let cancellationMatched = false;
  void cancelled.then(
    () => { cancelledSettled = true; },
    (error) => { cancellationMatched = error === reason; cancelledSettled = true; },
  );
  await waitForCondition("cancelled direct connection waiter to settle", () => cancelledSettled);

  assert.equal(cancellationMatched, true);
  assert.equal(harness.connectAttempts(), 1);
  harness.releaseConnection();
  const survivorResult = await survivor;
  assert.equal(survivorResult.details.server, "server");
  assert.deepEqual(harness.sdkCalls, ["call"]);
});

test("proxy metadata callers cancel locally while a survivor shares one lazy connection", async () => {
  const harness = createLazyHarness();
  const cancelledController = new AbortController();
  const reason = new Error("cancel only this metadata wait");

  const cancelled = executeSearch(harness.state, "shared", false, undefined, true, cancelledController.signal);
  const survivor = executeSearch(harness.state, "shared", false, undefined, true, new AbortController().signal);
  await Promise.resolve();
  cancelledController.abort(reason);
  let cancelledSettled = false;
  let cancellationMatched = false;
  void cancelled.then(
    () => { cancelledSettled = true; },
    (error) => { cancellationMatched = error === reason; cancelledSettled = true; },
  );
  await waitForCondition("cancelled metadata connection waiter to settle", () => cancelledSettled);

  assert.equal(cancellationMatched, true);
  assert.equal(harness.connectAttempts(), 1);
  harness.releaseConnection();
  const survivorResult = await survivor;
  assert.equal(survivorResult.details.count, 1);
});

test("one explicit proxy-connect caller aborts while a survivor shares the producer", async () => {
  const harness = createLazyHarness();
  const controller = new AbortController();
  const reason = new Error("cancel explicit connect waiter");

  const cancelled = executeConnect(harness.state, "server", controller.signal);
  const survivor = executeConnect(harness.state, "server", new AbortController().signal);
  await Promise.resolve();
  controller.abort(reason);
  let cancelledSettled = false;
  let cancellationMatched = false;
  void cancelled.then(
    () => { cancelledSettled = true; },
    (error) => { cancellationMatched = error === reason; cancelledSettled = true; },
  );
  await waitForCondition("cancelled explicit connection waiter to settle", () => cancelledSettled);
  assert.equal(cancellationMatched, true);
  assert.equal(harness.connectAttempts(), 1);

  harness.releaseConnection();
  const result = await survivor;
  assert.equal(result.details.server, "server");
});

test("one lazy proxy-call waiter aborts while a survivor calls the shared connection", async () => {
  const harness = createLazyHarness();
  const controller = new AbortController();
  const reason = new Error("cancel proxy call connection waiter");

  const cancelled = executeCall(harness.state, "server_run", {}, "server", undefined, controller.signal);
  const survivor = executeCall(harness.state, "server_run", {}, "server", undefined, new AbortController().signal);
  await Promise.resolve();
  controller.abort(reason);
  let cancelledSettled = false;
  let cancellationMatched = false;
  void cancelled.then(
    () => { cancelledSettled = true; },
    (error) => { cancellationMatched = error === reason; cancelledSettled = true; },
  );
  await waitForCondition("cancelled proxy-call connection waiter to settle", () => cancelledSettled);
  assert.equal(cancellationMatched, true);
  assert.equal(harness.connectAttempts(), 1);

  harness.releaseConnection();
  const result = await survivor;
  assert.equal(result.details.server, "server");
  assert.deepEqual(harness.sdkCalls, ["call"]);
});

test("a pre-aborted proxy metadata call does not start a lazy connection", async () => {
  const harness = createLazyHarness();
  const controller = new AbortController();
  const reason = new Error("already cancelled metadata call");
  controller.abort(reason);

  const pending = executeSearch(harness.state, "shared", false, undefined, true, controller.signal);
  await Promise.resolve();
  const attempts = harness.connectAttempts();
  if (attempts > 0) harness.releaseConnection();
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(attempts, 0);
});

test("a direct executor refuses an old connection after state ownership moves to its replacement", async () => {
  const oldHarness = createLazyHarness();
  const currentHarness = createLazyHarness();
  let currentState = oldHarness.state;
  const execute = createDirectToolExecutor(
    async () => currentState,
    (candidate) => candidate === currentState,
    directSpec,
  );

  const staleCall = execute("old", {}, new AbortController().signal, undefined, {} as never);
  await waitForCondition("old direct connection attempt to start", () => oldHarness.connectAttempts() === 1);
  currentState = currentHarness.state;
  oldHarness.releaseConnection();
  const staleResult = await staleCall;

  assert.equal(staleResult.details.error, "state_changed");
  assert.deepEqual(oldHarness.sdkCalls, [], "the old client must not be called after ownership loss");

  const currentCall = execute("current", {}, new AbortController().signal, undefined, {} as never);
  await waitForCondition("current direct connection attempt to start", () => currentHarness.connectAttempts() === 1);
  currentHarness.releaseConnection();
  const currentResult = await currentCall;
  assert.equal(currentResult.details.server, "server");
  assert.deepEqual(currentHarness.sdkCalls, ["call"]);
});

interface AuthHarness {
  readonly state: McpExtensionState;
  readonly authAttempts: () => number;
  readonly sdkCalls: string[];
  startAutoAuth(): Promise<{ status: "success" }>;
  releaseAuth(): void;
}

function createAuthHarness(): AuthHarness {
  const sdkCalls: string[] = [];
  const needsAuthConnection = {
    client: { async callTool() { return { content: [] }; }, async readResource() { return { contents: [] }; } },
    tools: [], resources: [], status: "needs-auth" as const, inFlight: 0, lastUsedAt: Date.now(),
  };
  const connectedConnection = {
    client: {
      async callTool(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        sdkCalls.push("call");
        return { content: [{ type: "text", text: "ok" }] };
      },
      async readResource(): Promise<{ contents: [] }> { return { contents: [] }; },
    },
    tools: [{ name: "run", description: "run", inputSchema: { type: "object", properties: {} } }],
    resources: [], status: "connected" as const, inFlight: 0, lastUsedAt: Date.now(),
  };
  let authenticated = false;
  let authAttempts = 0;
  let sharedAuth: Promise<{ status: "success" }> | null = null;
  let releaseAuth!: () => void;
  const manager: McpServerManager = Object.assign(new McpServerManager(), {
    getConnection: () => authenticated ? connectedConnection : needsAuthConnection,
    getAllConnections: () => new Map([["server", authenticated ? connectedConnection : needsAuthConnection]]),
    async connect() { return authenticated ? connectedConnection : needsAuthConnection; },
    async close() {}, touch() {},
    incrementInFlight() { connectedConnection.inFlight += 1; },
    decrementInFlight() { connectedConnection.inFlight -= 1; },
  });
  const state: McpExtensionState = {
    manager,
    lifecycle: new McpLifecycleManager(manager),
    toolMetadata: new Map<string, ToolMetadata[]>(),
    config: { mcpServers: { server: { url: "https://example.test/mcp", oauth: { grantType: "client_credentials" } } }, settings: { autoAuth: true } },
    failureTracker: new Map(),
    uiResourceHandler: new UiResourceHandler(manager),
    consentManager: new ConsentManager("once-per-server"),
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => undefined,
  };
  return {
    state,
    authAttempts: () => authAttempts,
    sdkCalls,
    startAutoAuth() {
      if (!sharedAuth) {
        authAttempts += 1;
        sharedAuth = new Promise((resolve) => {
          releaseAuth = () => { authenticated = true; resolve({ status: "success" }); };
        });
      }
      return sharedAuth;
    },
    releaseAuth() { releaseAuth(); },
  };
}

test("one direct OAuth waiter aborts while a survivor shares the authentication producer", async () => {
  const harness = createAuthHarness();
  const execute = createDirectToolExecutor(
    async () => harness.state,
    (candidate) => candidate === harness.state,
    directSpec,
    { startAutoAuth: async () => harness.startAutoAuth() },
  );
  const controller = new AbortController();
  const reason = new Error("cancel only this direct OAuth waiter");
  const cancelled = execute("cancelled", {}, controller.signal, undefined, {} as never);
  const survivor = execute("survivor", {}, new AbortController().signal, undefined, {} as never);
  await waitForCondition("shared direct OAuth producer to start", () => harness.authAttempts() === 1);
  controller.abort(reason);
  let cancelledReasonMatches = false;
  void cancelled.catch((error) => { cancelledReasonMatches = error === reason; });
  await waitForCondition("direct OAuth waiter to cancel", () => cancelledReasonMatches);
  assert.equal(harness.authAttempts(), 1);

  harness.releaseAuth();
  const result = await survivor;
  assert.equal(result.details.server, "server");
  assert.deepEqual(harness.sdkCalls, ["call"]);
});

test("one proxy-connect OAuth waiter aborts while a survivor shares the authentication producer", async () => {
  const harness = createAuthHarness();
  const controller = new AbortController();
  const reason = new Error("cancel only this proxy OAuth waiter");
  const startAutoAuth = async () => harness.startAutoAuth();
  const cancelled = executeConnect(harness.state, "server", controller.signal, startAutoAuth);
  const survivor = executeConnect(harness.state, "server", new AbortController().signal, startAutoAuth);
  await waitForCondition("shared proxy OAuth producer to start", () => harness.authAttempts() === 1);
  controller.abort(reason);
  let cancelledReasonMatches = false;
  void cancelled.catch((error) => { cancelledReasonMatches = error === reason; });
  await waitForCondition("proxy OAuth waiter to cancel", () => cancelledReasonMatches);
  assert.equal(harness.authAttempts(), 1);

  harness.releaseAuth();
  const result = await survivor;
  assert.equal(result.details.server, "server");
});

test("pre-aborted direct and proxy OAuth paths do not start authentication", async () => {
  const directHarness = createAuthHarness();
  const execute = createDirectToolExecutor(
    async () => directHarness.state,
    (candidate) => candidate === directHarness.state,
    directSpec,
    { startAutoAuth: async () => directHarness.startAutoAuth() },
  );
  const directController = new AbortController();
  const directReason = new Error("pre-aborted direct OAuth");
  directController.abort(directReason);
  await assert.rejects(execute("direct", {}, directController.signal, undefined, {} as never), (error) => error === directReason);
  assert.equal(directHarness.authAttempts(), 0);

  const proxyHarness = createAuthHarness();
  const proxyController = new AbortController();
  const proxyReason = new Error("pre-aborted proxy OAuth");
  proxyController.abort(proxyReason);
  await assert.rejects(
    executeConnect(proxyHarness.state, "server", proxyController.signal, async () => proxyHarness.startAutoAuth()),
    (error) => error === proxyReason,
  );
  assert.equal(proxyHarness.authAttempts(), 0);
});

test("proxy connect performs no metadata or SDK side effects after lease loss", async () => {
  const harness = createLazyHarness();
  let active = true;
  const assertActive = (): void => {
    if (!active) throw new McpStateChangedError();
  };
  const pending = executeConnect(harness.state, "server", undefined, undefined, assertActive);
  await waitForCondition("lease-aware proxy connect to start", () => harness.connectAttempts() === 1);
  active = false;
  harness.releaseConnection();

  await assert.rejects(pending, McpStateChangedError);
  assert.equal(harness.state.toolMetadata.size, 0);
  assert.deepEqual(harness.sdkCalls, []);
});
