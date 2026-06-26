/**
 * Focused tests: MCP stage scoping order and snapshot storage.
 *
 * Asserts the exact sequence:
 *   stage start → MCP scope.set → adapter call → MCP scope.clear → stage end
 *
 * Also asserts mcpScope is stored on StageSnapshot.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { WorkflowMcpPort } from "../../packages/workflows/src/shared/types.js";
import { makeMockSession, type AgentSessionAdapter } from "./stage-runner-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type OrderEvent =
  | "stageStart"
  | "mcpSet"
  | "adapterCall"
  | "prompt"
  | "sendUserMessage"
  | "mcpClear"
  | "stageEnd";

function makeMcpPort(order: OrderEvent[]): WorkflowMcpPort {
  return {
    setScope(_stageId, _allow, _deny) {
      order.push("mcpSet");
    },
    clearScope(_stageId) {
      order.push("mcpClear");
    },
  };
}

function makePromptAdapter(order: OrderEvent[]) {
  return {
    prompt: async (_text: string) => {
      order.push("adapterCall");
      return "ok";
    },
  };
}

function makeAgentSessionAdapter(order: OrderEvent[]): AgentSessionAdapter {
  const { session } = makeMockSession({
    async prompt() { order.push("prompt"); },
    async sendUserMessage() { order.push("sendUserMessage"); },
  });
  return { create: async () => session };
}

function makeStreamingAgentSessionAdapter(
  order: OrderEvent[],
  releasePrompt: Promise<void>,
): AgentSessionAdapter & { promptStarted: Promise<void> } {
  const promptStarted = Promise.withResolvers<void>();
  const { session } = makeMockSession({
    async prompt() {
      order.push("prompt");
      const mutableSession = session as { isStreaming: boolean };
      mutableSession.isStreaming = true;
      promptStarted.resolve();
      await releasePrompt;
      mutableSession.isStreaming = false;
    },
    async sendUserMessage() { order.push("sendUserMessage"); },
  });
  return { create: async () => session, promptStarted: promptStarted.promise };
}

// ---------------------------------------------------------------------------
// Order: stage start → MCP set → adapter call → MCP clear → stage end
// ---------------------------------------------------------------------------

describe("MCP stage scoping — call order", () => {
  test("set fires before adapter, clear fires after adapter in finally", async () => {
    const order: OrderEvent[] = [];

    const wf = workflow({
      name: "mcp-order-wf",
      description: "order test",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        const s = ctx.stage("work", { mcp: { allow: ["github"] } });
        await s.prompt("go");
        return {};
      },
    });

    await run(wf, {}, {
      store: createStore(),
      mcp: makeMcpPort(order),
      adapters: { prompt: makePromptAdapter(order) },
      onStageStart: () => order.push("stageStart"),
      onStageEnd: () => order.push("stageEnd"),
    });

    // Required exact subsequence: stageStart < mcpSet < adapterCall < mcpClear < stageEnd
    const idxStageStart = order.indexOf("stageStart");
    const idxMcpSet = order.indexOf("mcpSet");
    const idxAdapterCall = order.indexOf("adapterCall");
    const idxMcpClear = order.indexOf("mcpClear");
    const idxStageEnd = order.indexOf("stageEnd");

    assert.ok(idxStageStart >= 0);
    assert.ok(idxMcpSet > idxStageStart);
    assert.ok(idxAdapterCall > idxMcpSet);
    assert.ok(idxMcpClear > idxAdapterCall);
    assert.ok(idxStageEnd > idxMcpClear);
  });

  test("clear fires in finally even when adapter throws", async () => {
    const order: OrderEvent[] = [];

    const wf = workflow({
      name: "mcp-order-fail-wf",
      description: "order fail test",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        const s = ctx.stage("work", { mcp: { deny: ["filesystem"] } });
        await s.prompt("go");
        return {};
      },
    });

    await run(wf, {}, {
      store: createStore(),
      mcp: makeMcpPort(order),
      adapters: {
        prompt: {
          prompt: async () => {
            order.push("adapterCall");
            throw new Error("adapter failure");
          },
        },
      },
      onStageStart: () => order.push("stageStart"),
      onStageEnd: () => order.push("stageEnd"),
    });

    const idxMcpSet = order.indexOf("mcpSet");
    const idxAdapterCall = order.indexOf("adapterCall");
    const idxMcpClear = order.indexOf("mcpClear");
    const idxStageEnd = order.indexOf("stageEnd");

    assert.ok(idxMcpSet >= 0);
    assert.ok(idxAdapterCall > idxMcpSet);
    assert.ok(idxMcpClear > idxAdapterCall);
    assert.ok(idxStageEnd > idxMcpClear);
  });

  test("sendUserMessage follow-on turns reapply and clear the stage MCP scope", async () => {
    const order: OrderEvent[] = [];

    const wf = workflow({
      name: "mcp-send-user-message-wf",
      description: "sendUserMessage mcp scope test",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        const s = ctx.stage("work", { mcp: { allow: ["github"] } });
        await s.prompt("go");
        await s.sendUserMessage("follow on");
        return {};
      },
    });

    await run(wf, {}, {
      store: createStore(),
      mcp: makeMcpPort(order),
      adapters: { agentSession: makeAgentSessionAdapter(order) },
    });

    assert.deepEqual(order.filter((event) => event !== "stageStart" && event !== "stageEnd"), [
      "mcpSet",
      "prompt",
      "mcpClear",
      "mcpSet",
      "sendUserMessage",
      "mcpClear",
    ]);
  });

  test("streaming sendUserMessage does not clear the active prompt MCP scope", async () => {
    const order: OrderEvent[] = [];
    const releasePrompt = Promise.withResolvers<void>();
    const adapter = makeStreamingAgentSessionAdapter(order, releasePrompt.promise);

    const wf = workflow({
      name: "mcp-streaming-send-user-message-wf",
      description: "streaming sendUserMessage mcp scope test",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        const s = ctx.stage("work", { mcp: { allow: ["github"] } });
        const promptPromise = s.prompt("go");
        await adapter.promptStarted;
        await s.sendUserMessage("queue while streaming");
        assert.deepEqual(order, ["mcpSet", "prompt", "sendUserMessage"]);
        releasePrompt.resolve();
        await promptPromise;
        return {};
      },
    });

    await run(wf, {}, {
      store: createStore(),
      mcp: makeMcpPort(order),
      adapters: { agentSession: adapter },
    });

    assert.deepEqual(order.filter((event) => event !== "stageStart" && event !== "stageEnd"), [
      "mcpSet",
      "prompt",
      "sendUserMessage",
      "mcpClear",
    ]);
  });

  test("no MCP calls when stage has no mcp options", async () => {
    const order: OrderEvent[] = [];

    const wf = workflow({
      name: "mcp-no-opts-wf",
      description: "no mcp opts",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("plain").prompt("go");
        return {};
      },
    });

    await run(wf, {}, {
      store: createStore(),
      mcp: makeMcpPort(order),
      adapters: { prompt: makePromptAdapter(order) },
      onStageStart: () => order.push("stageStart"),
      onStageEnd: () => order.push("stageEnd"),
    });

    assert.ok(!order.includes("mcpSet"));
    assert.ok(!order.includes("mcpClear"));
    // adapter still called
    assert.ok(order.includes("adapterCall"));
  });

  test("concurrent stages: each gets distinct stageId in setScope", async () => {
    const setCalls: Array<{ stageId: string; allow: string[] | null }> = [];
    const clearCalls: string[] = [];

    const mcpPort: WorkflowMcpPort = {
      setScope(stageId, allow) { setCalls.push({ stageId, allow }); },
      clearScope(stageId) { clearCalls.push(stageId); },
    };

    const wf = workflow({
      name: "mcp-concurrent-wf",
      description: "concurrent stages",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await Promise.all([
          ctx.stage("stage-a", { mcp: { allow: ["server-a"] } }).prompt("a"),
          ctx.stage("stage-b", { mcp: { allow: ["server-b"] } }).prompt("b"),
        ]);
        return {};
      },
    });

    await run(wf, {}, {
      store: createStore(),
      mcp: mcpPort,
      adapters: { prompt: { prompt: async (t) => t } },
    });

    // Both stages should have called setScope with distinct stageIds
    assert.equal(setCalls.length, 2);
    assert.equal(clearCalls.length, 2);

    const stageIds = setCalls.map((c) => c.stageId);
    // Distinct UUIDs
    assert.notEqual(stageIds[0], stageIds[1]);

    // allow lists are stage-specific (not mixed)
    const aCall = setCalls.find((c) => c.allow?.includes("server-a"));
    const bCall = setCalls.find((c) => c.allow?.includes("server-b"));
    assert.notEqual(aCall, undefined);
    assert.notEqual(bCall, undefined);
    assert.notEqual(aCall!.stageId, bCall!.stageId);
  });
});

// ---------------------------------------------------------------------------
// mcpScope stored on StageSnapshot
// ---------------------------------------------------------------------------

describe("MCP stage scoping — StageSnapshot.mcpScope", () => {
  test("mcpScope stored with allow and deny from StageOptions", async () => {
    const wf = workflow({
      name: "mcp-snap-wf",
      description: "snapshot test",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("s", { mcp: { allow: ["github", "fetch"], deny: ["filesystem"] } }).prompt("x");
        return {};
      },
    });

    const result = await run(wf, {}, {
      store: createStore(),
      adapters: { prompt: { prompt: async () => "ok" } },
    });

    assert.equal(result.status, "completed");
    const snap = result.stages[0];
    assert.notEqual(snap?.mcpScope, undefined);
    assert.deepEqual(snap?.mcpScope?.allow, ["github", "fetch"]);
    assert.deepEqual(snap?.mcpScope?.deny, ["filesystem"]);
  });

  test("mcpScope.allow is null when only deny provided", async () => {
    const wf = workflow({
      name: "mcp-snap-deny-only-wf",
      description: "deny only",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("s", { mcp: { deny: ["bad-server"] } }).prompt("x");
        return {};
      },
    });

    const result = await run(wf, {}, {
      store: createStore(),
      adapters: { prompt: { prompt: async () => "ok" } },
    });

    const snap = result.stages[0];
    assert.equal(snap?.mcpScope?.allow, null);
    assert.deepEqual(snap?.mcpScope?.deny, ["bad-server"]);
  });

  test("mcpScope.deny is null when only allow provided", async () => {
    const wf = workflow({
      name: "mcp-snap-allow-only-wf",
      description: "allow only",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("s", { mcp: { allow: ["safe-server"] } }).prompt("x");
        return {};
      },
    });

    const result = await run(wf, {}, {
      store: createStore(),
      adapters: { prompt: { prompt: async () => "ok" } },
    });

    const snap = result.stages[0];
    assert.deepEqual(snap?.mcpScope?.allow, ["safe-server"]);
    assert.equal(snap?.mcpScope?.deny, null);
  });

  test("mcpScope absent when no mcp options passed", async () => {
    const wf = workflow({
      name: "mcp-snap-none-wf",
      description: "no options",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("plain").prompt("x");
        return {};
      },
    });

    const result = await run(wf, {}, {
      store: createStore(),
      adapters: { prompt: { prompt: async () => "ok" } },
    });

    const snap = result.stages[0];
    assert.equal(snap?.mcpScope, undefined);
  });

  test("mcpScope stored even when no mcp port configured", async () => {
    // Snapshot stores options regardless of port availability
    const wf = workflow({
      name: "mcp-snap-no-port-wf",
      description: "no port",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("s", { mcp: { allow: ["x"] } }).prompt("x");
        return {};
      },
    });

    const result = await run(wf, {}, {
      store: createStore(),
      adapters: { prompt: { prompt: async () => "ok" } },
      // no mcp port
    });

    const snap = result.stages[0];
    assert.notEqual(snap?.mcpScope, undefined);
    assert.deepEqual(snap?.mcpScope?.allow, ["x"]);
  });
});
