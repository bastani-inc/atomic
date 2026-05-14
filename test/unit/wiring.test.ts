/**
 * Runtime wiring tests for SDK-backed workflow stages.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildRuntimeAdapters } from "../../src/extension/wiring.js";
import { createStageContext } from "../../src/runs/foreground/stage-runner.js";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { RuntimeWiringSurface } from "../../src/extension/wiring.js";
import type { StageSessionRuntime } from "../../src/runs/foreground/stage-runner.js";

function fakeSession(): StageSessionRuntime {
  let last = "";
  return {
    async prompt(text: string): Promise<string> { last = `sdk:${text}`; return last; },
    async steer(text: string): Promise<void> { last = `steer:${text}`; },
    async followUp(text: string): Promise<void> { last = `follow:${text}`; },
    subscribe: () => () => {},
    sessionFile: undefined,
    sessionId: "session-id",
    async setModel(): Promise<void> {},
    setThinkingLevel(): void {},
    async cycleModel(): Promise<undefined> { return undefined; },
    cycleThinkingLevel(): undefined { return undefined; },
    agent: {} as StageSessionRuntime["agent"],
    model: undefined,
    thinkingLevel: "medium" as StageSessionRuntime["thinkingLevel"],
    messages: [],
    isStreaming: false,
    async navigateTree(): Promise<{ cancelled: boolean }> { return { cancelled: true }; },
    async compact(): ReturnType<StageSessionRuntime["compact"]> {
      return undefined as unknown as Awaited<ReturnType<StageSessionRuntime["compact"]>>;
    },
    abortCompaction(): void {},
    async abort(): Promise<void> {},
    dispose(): void {},
    getLastAssistantText(): string | undefined { return last; },
  };
}

describe("buildRuntimeAdapters — SDK sessions", () => {
  test("always configures agentSession without pi.exec", () => {
    const adapters = buildRuntimeAdapters({});
    assert.notEqual(adapters.agentSession, undefined);
    assert.equal(adapters.prompt, undefined);
    assert.equal(adapters.complete, undefined);
  });

  test("forwards createAgentSession options from stage options", async () => {
    const calls: Array<CreateAgentSessionOptions | undefined> = [];
    const adapters = buildRuntimeAdapters({}, {
      createAgentSession: async (options) => { calls.push(options); return { session: fakeSession() }; },
    });
    await adapters.agentSession!.create({ cwd: "/repo", tools: ["read"], mcp: { deny: ["network"] } } as unknown as Parameters<NonNullable<typeof adapters.agentSession>["create"]>[0]);
    assert.equal(calls[0]?.cwd, "/repo");
    assert.deepEqual((calls[0] as unknown as { tools?: string[] })?.tools, ["read"]);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0], "mcp"), false);
  });

  test("stage prompt delegates to the SDK session adapter", async () => {
    const adapters = buildRuntimeAdapters({}, {
      createAgentSession: async () => ({ session: fakeSession() }),
    });
    const stage = createStageContext({ stageId: "s", stageName: "Stage", runId: "r", adapters });
    const result = await stage.prompt("hello");
    assert.equal(result, "sdk:hello");
    assert.equal(stage.getLastAssistantText(), "sdk:hello");
  });

  test("stage prompt output options do not override createAgentSession options", async () => {
    const calls: Array<CreateAgentSessionOptions | undefined> = [];
    const adapters = buildRuntimeAdapters({}, {
      createAgentSession: async (options) => { calls.push(options); return { session: fakeSession() }; },
    });
    const stage = createStageContext({
      stageId: "s",
      stageName: "Stage",
      runId: "r",
      adapters,
      stageOptions: { cwd: "/stage-cwd" },
    });

    await stage.prompt("hello", { cwd: "/prompt-cwd", context: "fork", sessionDir: "/prompt-sessions" });

    assert.equal(calls[0]?.cwd, "/stage-cwd");
    assert.equal((calls[0] as { context?: string } | undefined)?.context, undefined);
    assert.equal((calls[0] as { sessionDir?: string } | undefined)?.sessionDir, undefined);
  });
});

describe("subagent adapter — pi task bridge", () => {
  test(
    "calls pi.callTool('subagent', { agent, task }) without `action` (execution mode)",
    async () => {
      // pi-subagents v0.24.2: execution mode omits `action` entirely. The
      // valid SUBAGENT_ACTIONS list is {list,get,create,update,delete,
      // status,interrupt,resume,doctor} — "run" is NOT a member and is
      // rejected by createSubagentExecutor.execute.
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const pi: RuntimeWiringSurface = {
        callTool: async (name, args) => { calls.push({ name, args }); return "ok"; },
      };
      const adapters = buildRuntimeAdapters(pi);
      await adapters.subagent!.subagent({ agent: "worker", task: "do it" });
      assert.equal(calls[0]?.name, "subagent");
      assert.equal(calls[0]?.args["agent"], "worker");
      assert.equal(calls[0]?.args["task"], "do it");
      assert.equal(Object.prototype.hasOwnProperty.call(calls[0]?.args, "action"), false);
    },
  );

  test("forwards all subagent execution and management params to pi-subagents", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const pi: RuntimeWiringSurface = {
      callTool: async (name, args) => { calls.push({ name, args }); return "ok"; },
    };
    const adapters = buildRuntimeAdapters(pi);

    await adapters.subagent!.subagent({
      agent: "worker",
      task: "do it",
      action: "resume",
      id: "run-123",
      runId: "run-456",
      dir: "/tmp/run",
      index: 1,
      message: "continue",
      chainName: "handoff",
      config: { name: "custom" },
      output: "reports/out.md",
      outputMode: "file-only",
      skill: ["tdd"],
      model: "google/gemini-3-pro",
      tasks: [{ agent: "a", task: "t", cwd: "/repo/a", count: 2, output: false, outputMode: "inline", reads: false, progress: true, skill: false, model: "m" }],
      concurrency: 2,
      worktree: true,
      chain: [{ agent: "planner", task: "plan {task}" }, { parallel: [{ agent: "worker", task: "do {previous}" }], concurrency: 2, failFast: true, worktree: true }],
      context: "fork",
      chainDir: "/tmp/chain",
      clarify: false,
      agentScope: "both",
      async: true,
      cwd: "/repo",
      artifacts: false,
      includeProgress: true,
      share: true,
      sessionDir: "/tmp/sessions",
      control: { enabled: true, notifyOn: ["needs_attention"] },
    });

    assert.deepEqual(calls[0]?.args, {
      agent: "worker",
      task: "do it",
      action: "resume",
      id: "run-123",
      runId: "run-456",
      dir: "/tmp/run",
      index: 1,
      message: "continue",
      chainName: "handoff",
      config: { name: "custom" },
      output: "reports/out.md",
      outputMode: "file-only",
      skill: ["tdd"],
      model: "google/gemini-3-pro",
      tasks: [{ agent: "a", task: "t", cwd: "/repo/a", count: 2, output: false, outputMode: "inline", reads: false, progress: true, skill: false, model: "m" }],
      concurrency: 2,
      worktree: true,
      chain: [{ agent: "planner", task: "plan {task}" }, { parallel: [{ agent: "worker", task: "do {previous}" }], concurrency: 2, failFast: true, worktree: true }],
      context: "fork",
      chainDir: "/tmp/chain",
      clarify: false,
      agentScope: "both",
      async: true,
      cwd: "/repo",
      artifacts: false,
      includeProgress: true,
      share: true,
      sessionDir: "/tmp/sessions",
      control: { enabled: true, notifyOn: ["needs_attention"] },
    });
  });

  test("stage runner owns missing-subagent actionable error", async () => {
    const stage = createStageContext({ stageId: "s", stageName: "Stage", runId: "r", adapters: {} });
    await assert.rejects(stage.subagent({ agent: "a", task: "t" }), /pi task delegation/);
  });
});
