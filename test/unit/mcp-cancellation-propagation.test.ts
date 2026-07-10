import { test } from "bun:test";
import assert from "node:assert/strict";
import type { McpExtensionState } from "../../packages/mcp/state.js";
import type { DirectToolSpec, ToolMetadata } from "../../packages/mcp/types.js";
import { createDirectToolExecutor } from "../../packages/mcp/direct-tools.js";
import { executeCall } from "../../packages/mcp/proxy-call.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { waitForCondition } from "../support/wait-for-condition.js";

interface ClientCalls {
  readonly reads: Array<readonly [params: object, options?: { signal?: AbortSignal }]>;
  readonly tools: Array<readonly [params: object, schema?: object, options?: { signal?: AbortSignal }]>;
}

interface ClientResponses {
  readonly read?: Promise<{ contents: Array<{ uri: string; text: string }> }>;
  readonly tool?: Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

function createConnectedState(
  metadata: readonly ToolMetadata[],
  responses: ClientResponses = {},
): { state: McpExtensionState; calls: ClientCalls; getInFlight(): number } {
  const reads: ClientCalls["reads"] = [];
  const tools: ClientCalls["tools"] = [];
  const client = {
    async readResource(params: object, options?: { signal?: AbortSignal }) {
      reads.push([params, options]);
      return responses.read ?? { contents: [{ uri: "resource://test", text: "resource" }] };
    },
    async callTool(params: object, schema?: object, options?: { signal?: AbortSignal }) {
      tools.push([params, schema, options]);
      return responses.tool ?? { content: [{ type: "text", text: "tool" }] };
    },
  };
  const connection = {
    client,
    tools: [],
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
    toolMetadata: new Map([["server", [...metadata]]]),
    config: { mcpServers: { server: { command: "bun" } } },
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => undefined,
  } as unknown as McpExtensionState;
  return { state, calls: { reads, tools }, getInFlight: () => connection.inFlight };
}

test("direct resource calls pass the invocation signal as MCP request options", async () => {
  const { state, calls } = createConnectedState([]);
  const spec: DirectToolSpec = {
    serverName: "server",
    originalName: "get_test",
    prefixedName: "server_get_test",
    description: "read test resource",
    resourceUri: "resource://test",
  };
  const execute = createDirectToolExecutor(async () => state, (candidate) => candidate === state, spec);
  const signal = new AbortController().signal;

  await execute("call", {}, signal, undefined, {} as never);

  assert.equal(calls.reads.length, 1);
  assert.equal(calls.reads[0]?.[1]?.signal, signal);
});

test("proxy resource calls pass the invocation signal as MCP request options", async () => {
  const resource: ToolMetadata = {
    name: "server_get_test",
    originalName: "get_test",
    description: "read test resource",
    resourceUri: "resource://test",
  };
  const { state, calls } = createConnectedState([resource]);
  const signal = new AbortController().signal;

  await executeCall(state, resource.name, {}, "server", undefined, signal);

  assert.equal(calls.reads.length, 1);
  assert.equal(calls.reads[0]?.[1]?.signal, signal);
});

test("direct tool calls pass the result schema and signal in the SDK option position", async () => {
  const { state, calls } = createConnectedState([]);
  const spec: DirectToolSpec = {
    serverName: "server",
    originalName: "run",
    prefixedName: "server_run",
    description: "run test tool",
  };
  const execute = createDirectToolExecutor(async () => state, (candidate) => candidate === state, spec);
  const signal = new AbortController().signal;

  await execute("call", { value: 1 }, signal, undefined, {} as never);

  assert.equal(calls.tools.length, 1);
  assert.equal(calls.tools[0]?.[1], CallToolResultSchema);
  assert.equal(calls.tools[0]?.[2]?.signal, signal);
});

test("proxy tool calls pass the result schema and signal in the SDK option position", async () => {
  const tool: ToolMetadata = {
    name: "server_run",
    originalName: "run",
    description: "run test tool",
  };
  const { state, calls } = createConnectedState([tool]);
  const signal = new AbortController().signal;

  await executeCall(state, tool.name, { value: 1 }, "server", undefined, signal);

  assert.equal(calls.tools.length, 1);
  assert.equal(calls.tools[0]?.[1], CallToolResultSchema);
  assert.equal(calls.tools[0]?.[2]?.signal, signal);
});

test("one direct caller aborts promptly while a survivor waits for shared readiness", async () => {
  const { state, calls } = createConnectedState([]);
  let release!: (value: McpExtensionState) => void;
  const readiness = new Promise<McpExtensionState>((resolve) => { release = resolve; });
  let ensureCalls = 0;
  const execute = createDirectToolExecutor(() => {
    ensureCalls += 1;
    return readiness;
  }, (candidate) => candidate === state, {
    serverName: "server", originalName: "run", prefixedName: "server_run", description: "run test tool",
  });
  const controller = new AbortController();
  const reason = new Error("direct caller cancelled during readiness");

  const cancelled = execute("cancelled", {}, controller.signal, undefined, {} as never);
  const survivor = execute("survivor", {}, new AbortController().signal, undefined, {} as never);
  let cancellationOutcome: boolean | undefined;
  void cancelled.then(
    () => { cancellationOutcome = false; },
    (error) => { cancellationOutcome = error === reason; },
  );
  controller.abort(reason);
  await waitForCondition("cancelled caller to settle before shared readiness", () => cancellationOutcome !== undefined);
  assert.equal(cancellationOutcome, true, "cancelled caller must settle before shared readiness releases");
  release(state);

  await survivor;
  assert.equal(ensureCalls, 2);
  assert.equal(calls.tools.length, 1);
  assert.equal(calls.reads.length, 0);
});

test("a direct caller abort observes a later shared readiness rejection", async () => {
  let rejectReadiness!: (error: unknown) => void;
  const readiness = new Promise<McpExtensionState>((_resolve, reject) => { rejectReadiness = reject; });
  const execute = createDirectToolExecutor(() => readiness, () => true, {
    serverName: "server", originalName: "run", prefixedName: "server_run", description: "run test tool",
  });
  const controller = new AbortController();
  const reason = new Error("caller cancelled before shared rejection");
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    let cancellationOutcome: boolean | undefined;
    void execute("call", {}, controller.signal, undefined, {} as never).then(
      () => { cancellationOutcome = false; },
      (error) => { cancellationOutcome = error === reason; },
    );
    controller.abort(reason);
    await waitForCondition("cancelled caller to settle before shared readiness rejects", () => cancellationOutcome !== undefined);
    assert.equal(cancellationOutcome, true);

    rejectReadiness(new Error("late readiness failure"));
    let rejectionCheckpointReached = false;
    setImmediate(() => { rejectionCheckpointReached = true; });
    await waitForCondition("late shared readiness rejection observation", () => rejectionCheckpointReached);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("pre-aborted direct calls do not start shared readiness", async () => {
  const { state } = createConnectedState([]);
  let ensureCalls = 0;
  const execute = createDirectToolExecutor(async () => {
    ensureCalls += 1;
    return state;
  }, (candidate) => candidate === state, {
    serverName: "server",
    originalName: "run",
    prefixedName: "server_run",
    description: "run test tool",
  });
  const controller = new AbortController();
  const reason = new Error("direct caller cancelled before readiness");
  controller.abort(reason);

  await assert.rejects(
    execute("call", {}, controller.signal, undefined, {} as never),
    (error) => error === reason,
  );
  assert.equal(ensureCalls, 0);
});

test("proxy calls aborted during an SDK request reject and settle in-flight accounting", async () => {
  let release!: (value: { content: Array<{ type: "text"; text: string }> }) => void;
  const toolResponse = new Promise<{ content: Array<{ type: "text"; text: string }> }>((resolve) => {
    release = resolve;
  });
  const tool: ToolMetadata = {
    name: "server_run",
    originalName: "run",
    description: "run test tool",
  };
  const { state, calls, getInFlight } = createConnectedState([tool], { tool: toolResponse });
  const controller = new AbortController();
  const reason = new Error("proxy caller cancelled during SDK request");

  const pending = executeCall(state, tool.name, {}, "server", undefined, controller.signal);
  assert.equal(calls.tools.length, 1);
  assert.equal(getInFlight(), 1);
  controller.abort(reason);
  release({ content: [{ type: "text", text: "late" }] });

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(getInFlight(), 0);
});

test("direct UI startup aborts promptly and closes a late runtime", async () => {
  const tool: DirectToolSpec = {
    serverName: "server",
    originalName: "run_ui",
    prefixedName: "server_run_ui",
    description: "run UI tool",
    uiResourceUri: "ui://test",
  };
  const { state, calls, getInFlight } = createConnectedState([]);
  let releaseUi!: (runtime: { reused: false; requestMeta: {}; close(reason?: string): void }) => void;
  let closes = 0;
  const uiStartup = new Promise<{ reused: false; requestMeta: {}; close(reason?: string): void }>((resolve) => { releaseUi = resolve; });
  const execute = createDirectToolExecutor(async () => state, (candidate) => candidate === state, tool, {
    startUiSession: async () => uiStartup as never,
  });
  const controller = new AbortController();
  const reason = new Error("cancelled during UI startup");
  let outcome: unknown;
  void execute("call", {}, controller.signal, undefined, {} as never).then(
    () => { outcome = false; },
    (error) => { outcome = error; },
  );
  await waitForCondition("UI startup to increment in-flight", () => getInFlight() === 1);
  controller.abort(reason);
  await waitForCondition("UI startup caller to abort", () => outcome !== undefined);
  assert.equal(outcome, reason);
  assert.equal(getInFlight(), 0);
  assert.equal(calls.tools.length, 0);

  releaseUi({ reused: false, requestMeta: {}, close() { closes += 1; } });
  await waitForCondition("late UI runtime cleanup", () => closes === 1);
});
