import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createDirectToolExecutor } from "../../packages/mcp/direct-tools.js";
import { executeCall } from "../../packages/mcp/proxy-call.js";
import { maybeStartUiSession } from "../../packages/mcp/ui-session.js";
import { buildHostHtmlTemplate } from "../../packages/mcp/host-html-template.js";
import type { McpExtensionState } from "../../packages/mcp/state.js";
import { McpServerManager } from "../../packages/mcp/server-manager.js";
import { McpLifecycleManager } from "../../packages/mcp/lifecycle.js";
import { UiResourceHandler } from "../../packages/mcp/ui-resource-handler.js";
import { ConsentManager } from "../../packages/mcp/consent-manager.js";
import type { UiServerHandle } from "../../packages/mcp/ui-server.js";
import type { DirectToolSpec, ToolMetadata } from "../../packages/mcp/types.js";
import type { UiSessionRuntime } from "../../packages/mcp/ui-session.js";
import { waitForCondition } from "../support/wait-for-condition.js";

interface UiHarness {
  readonly state: McpExtensionState;
  readonly events: string[];
  readonly cancellationReasons: string[];
  readonly resultCount: () => number;
  rejectCall(error: Error): void;
  releaseCancellation(): void;
}

function createUiHarness(options: {
  cancellationFailure?: Error;
  synchronousCancellationFailure?: Error;
  callFailure?: Error;
  deferredCall?: boolean;
  deferredCancellation?: boolean;
} = {}): UiHarness {
  const events: string[] = [];
  const cancellationReasons: string[] = [];
  let resultCount = 0;
  let rejectPendingCall: ((error: Error) => void) | null = null;
  let releasePendingCancellation: (() => void) | null = null;
  const pendingCancellation = options.deferredCancellation
    ? new Promise<void>((resolve) => { releasePendingCancellation = resolve; })
    : null;
  const callTool = (
    _params: object,
    _schema: object,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<CallToolResult> => {
    events.push("call");
    if (options.callFailure) return Promise.reject(options.callFailure);
    return new Promise<CallToolResult>((_resolve, reject) => {
      if (options.deferredCall) rejectPendingCall = reject;
      requestOptions?.signal?.addEventListener("abort", () => {
        reject(new Error("SDK wrapped the host cancellation"));
      }, { once: true });
    });
  };
  const connection = {
    client: {
      callTool,
      async readResource(): Promise<{ contents: [] }> { return { contents: [] }; },
    },
    tools: [],
    resources: [],
    status: "connected" as const,
    inFlight: 0,
    lastUsedAt: Date.now(),
  };
  const uiServer: UiServerHandle = {
    url: "http://localhost/ui",
    port: 1,
    sessionToken: "session",
    serverName: "server",
    toolName: "run",
    close() {},
    sendToolInput() { events.push("input"); },
    sendToolResult() { events.push("result"); resultCount += 1; },
    sendResultPatch() {},
    sendToolCancelled(reason: string): void | Promise<void> {
      events.push("cancel");
      cancellationReasons.push(reason);
      if (options.synchronousCancellationFailure) throw options.synchronousCancellationFailure;
      return options.cancellationFailure
        ? Promise.reject(options.cancellationFailure)
        : pendingCancellation ?? undefined;
    },
    sendHostContext() {},
    getSessionMessages: () => ({ prompts: [], notifications: [], intents: [] }),
    getStreamSummary: () => undefined,
  };
  const manager: McpServerManager = Object.assign(new McpServerManager(), {
    getConnection: () => connection,
    touch() {},
    incrementInFlight() { connection.inFlight += 1; },
    decrementInFlight() { connection.inFlight -= 1; },
    registerUiStreamListener() {},
    removeUiStreamListener() { events.push("close"); },
  });
  const state: McpExtensionState = {
    manager,
    lifecycle: new McpLifecycleManager(manager),
    toolMetadata: new Map<string, ToolMetadata[]>(),
    config: { mcpServers: { server: { command: "bun" } } },
    failureTracker: new Map<string, number>(),
    uiResourceHandler: new UiResourceHandler(manager),
    consentManager: new ConsentManager("once-per-server"),
    uiServer,
    completedUiSessions: [],
    openBrowser: async () => undefined,
  };
  return {
    state, events, cancellationReasons, resultCount: () => resultCount,
    rejectCall(error: Error) {
      if (!rejectPendingCall) throw new Error("SDK call is not pending");
      rejectPendingCall(error);
    },
    releaseCancellation() {
      if (!releasePendingCancellation) throw new Error("cancellation notification is not pending");
      releasePendingCancellation();
    },
  };
}

const directUiSpec: DirectToolSpec = {
  serverName: "server",
  originalName: "run",
  prefixedName: "server_run",
  description: "UI tool",
  uiResourceUri: "ui://run",
  uiStreamMode: "eager",
};

const proxyUiTool: ToolMetadata = {
  name: "server_run",
  originalName: "run",
  description: "UI tool",
  uiResourceUri: "ui://run",
  uiStreamMode: "eager",
};

async function waitForCall(events: readonly string[]): Promise<void> {
  await waitForCondition("UI-backed MCP call to reach the SDK request", () => events.includes("call"));
}

test("direct UI host cancellation emits one terminal cancellation before teardown and preserves the exact reason", async () => {
  const harness = createUiHarness();
  const execute = createDirectToolExecutor(
    async () => harness.state,
    (candidate) => candidate === harness.state,
    directUiSpec,
  );
  const controller = new AbortController();
  const reason = new Error("host stopped direct UI call");

  const pending = execute("direct", {}, controller.signal, undefined, {} as never);
  await waitForCall(harness.events);
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
  assert.deepEqual(harness.events.filter((event) => event !== "close"), ["input", "call", "cancel"]);
  assert.equal(harness.events.at(-1), "close");
  assert.deepEqual(harness.cancellationReasons, [reason.message]);
  assert.equal(harness.resultCount(), 0);
});

test("direct UI synchronous cancellation notification failure cannot mask the host reason", async () => {
  const notificationFailure = new Error("view cancellation callback failed synchronously");
  const harness = createUiHarness({ synchronousCancellationFailure: notificationFailure });
  const execute = createDirectToolExecutor(
    async () => harness.state,
    (candidate) => candidate === harness.state,
    directUiSpec,
  );
  const controller = new AbortController();
  const reason = new Error("host stopped direct UI call with broken view");
  const logged: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: Parameters<typeof console.error>) => { logged.push(values.map(String).join(" ")); };

  try {
    const pending = execute("direct", {}, controller.signal, undefined, {} as never);
    await waitForCall(harness.events);
    controller.abort(reason);

    await assert.rejects(pending, (error) => error === reason);
    assert.deepEqual(harness.events, ["input", "call", "cancel", "close"]);
    assert.equal(harness.resultCount(), 0);
    assert.ok(logged.some((line) => line.includes(notificationFailure.message)));
  } finally {
    console.error = originalConsoleError;
  }
});

test("proxy UI cancellation notification rejection is observed without masking the host reason", async () => {
  const notificationFailure = new Error("view transport disconnected");
  const harness = createUiHarness({ cancellationFailure: notificationFailure });
  harness.state.toolMetadata.set("server", [proxyUiTool]);
  const controller = new AbortController();
  const reason = new Error("host stopped proxy UI call");
  const logged: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: Parameters<typeof console.error>) => { logged.push(values.map(String).join(" ")); };

  try {
    const pending = executeCall(harness.state, proxyUiTool.name, {}, "server", undefined, controller.signal);
    await waitForCall(harness.events);
    controller.abort(reason);

    await assert.rejects(pending, (error) => error === reason);
    assert.deepEqual(harness.events.filter((event) => event !== "close"), ["input", "call", "cancel"]);
    assert.equal(harness.events.at(-1), "close");
    assert.equal(harness.resultCount(), 0);
    assert.ok(logged.some((line) => line.includes(notificationFailure.message)));
  } finally {
    console.error = originalConsoleError;
  }
});

test("reused UI sessions emit tool-cancelled rather than an error-shaped tool result", async () => {
  const harness = createUiHarness();
  const session = await maybeStartUiSession(harness.state, {
    serverName: "server",
    toolName: "run",
    toolArgs: { value: 1 },
    uiResourceUri: "ui://run",
  });

  assert.ok(session?.reused);
  await session.sendToolCancelled("cancelled by host");
  assert.deepEqual(harness.events, ["input", "cancel"]);
  assert.equal(harness.resultCount(), 0);
});


test("ordinary direct UI failures remain result-shaped and emit the existing cancellation terminal event", async () => {
  const failure = new Error("server rejected ordinary UI call");
  const harness = createUiHarness({ callFailure: failure });
  const execute = createDirectToolExecutor(
    async () => harness.state,
    (candidate) => candidate === harness.state,
    directUiSpec,
  );

  const result = await execute("direct-failure", {}, new AbortController().signal, undefined, {} as never);

  assert.equal(result.details.error, "call_failed");
  assert.deepEqual(harness.events, ["input", "call", "cancel", "close"]);
  assert.deepEqual(harness.cancellationReasons, [failure.message]);
});

test("browser host observes the asynchronous AppBridge cancellation notification", () => {
  const html = buildHostHtmlTemplate({
    sessionToken: "session",
    serverName: "server",
    toolName: "run",
    toolArgs: {},
    resource: { uri: "ui://run", html: "<main>app</main>", meta: {} },
    allowAttribute: "",
    requireToolConsent: true,
    cacheToolConsent: true,
  });

  assert.match(html, /void bridge\.sendToolCancelled\(JSON\.parse\(event\.data\)\)\.catch/);
});


test("host abort during an asynchronous cancellation notification remains authoritative", async () => {
  const failure = new Error("ordinary SDK rejection before host abort");
  const harness = createUiHarness({ callFailure: failure, deferredCancellation: true });
  const execute = createDirectToolExecutor(
    async () => harness.state,
    (candidate) => candidate === harness.state,
    directUiSpec,
  );
  const controller = new AbortController();
  const reason = new Error("host aborted while Apps cancellation was pending");

  const pending = execute("direct", {}, controller.signal, undefined, {} as never);
  await waitForCondition("Apps cancellation notification to start", () => harness.events.includes("cancel"));
  controller.abort(reason);
  harness.releaseCancellation();

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(harness.events.filter((event) => event === "cancel").length, 1);
  assert.equal(harness.resultCount(), 0);
});

test("direct ownership loss after a new UI starts closes it and suppresses the old failure", async () => {
  const harness = createUiHarness({ deferredCall: true });
  let currentState = harness.state;
  const uiEvents: string[] = [];
  const newUiSession: UiSessionRuntime = {
    serverName: "server", toolName: "run", reused: false, url: "http://localhost/ui",
    isActive: () => true, sendToolResult() { uiEvents.push("result"); }, sendResultPatch() {},
    sendToolCancelled() { uiEvents.push("cancel"); }, close() { uiEvents.push("close"); },
  };
  const execute = createDirectToolExecutor(
    async () => currentState,
    (candidate) => candidate === currentState,
    directUiSpec,
    { startUiSession: async () => newUiSession },
  );

  const pending = execute("direct", {}, new AbortController().signal, undefined, {} as never);
  await waitForCondition("stale direct SDK call to start", () => harness.events.includes("call"));
  currentState = createUiHarness().state;
  harness.rejectCall(new Error("old SDK request rejected after replacement"));
  const result = await pending;

  assert.equal(result.details.error, "state_changed");
  assert.deepEqual(uiEvents, ["cancel", "close"]);
  assert.equal(harness.resultCount(), 0);
});

test("proxy host abort during an asynchronous cancellation notification remains authoritative", async () => {
  const failure = new Error("ordinary proxy SDK rejection before host abort");
  const harness = createUiHarness({ callFailure: failure, deferredCancellation: true });
  harness.state.toolMetadata.set("server", [proxyUiTool]);
  const controller = new AbortController();
  const reason = new Error("host aborted proxy while Apps cancellation was pending");

  const pending = executeCall(harness.state, proxyUiTool.name, {}, "server", undefined, controller.signal);
  await waitForCondition("proxy Apps cancellation notification to start", () => harness.events.includes("cancel"));
  controller.abort(reason);
  harness.releaseCancellation();

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(harness.events.filter((event) => event === "cancel").length, 1);
  assert.equal(harness.resultCount(), 0);
});
