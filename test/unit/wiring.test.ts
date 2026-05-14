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

  test("does not force ask_user_question into the active tool list", async () => {
    const calls: CreateAgentSessionOptions[] = [];
    const adapters = buildRuntimeAdapters(
      { ui: { custom: () => undefined } },
      {
        createAgentSession: async (options) => {
          calls.push(options ?? {});
          return { session: fakeSession() };
        },
      },
    );

    await adapters.agentSession!.create({}, {
      runId: "run-1",
      stageId: "stage-1",
      stageName: "worker-a",
      signal: new AbortController().signal,
    });

    assert.equal(calls[0]?.tools, undefined);
    assert.equal(calls[0]?.customTools?.some((tool) => tool.name === "ask_user_question"), true);
  });

  test("injects ask_user_question, binds pi UI, and emits HIL lifecycle callbacks", async () => {
    const calls: CreateAgentSessionOptions[] = [];
    const bindCalls: Array<{
      uiContext?: Record<string, unknown> & {
        custom?: <T = undefined>(factory: unknown, options?: unknown) => Promise<T> | T | undefined;
      };
    }> = [];
    const events: string[] = [];
    const session = {
      ...fakeSession(),
      async bindExtensions(bindings: {
        uiContext?: Record<string, unknown> & {
          custom?: <T = undefined>(factory: unknown, options?: unknown) => Promise<T> | T | undefined;
        };
      }): Promise<void> {
        bindCalls.push(bindings);
      },
    };
    const pi: RuntimeWiringSurface = {
      ui: {
        custom: async () => ({
          answers: [{
            questionIndex: 0,
            question: "Pick a color?",
            kind: "option",
            answer: "Blue",
          }],
          cancelled: false,
        }),
      },
    };
    const meta = {
      runId: "run-1",
      stageId: "stage-1",
      stageName: "worker-a",
      signal: new AbortController().signal,
    };
    const adapters = buildRuntimeAdapters(pi, {
      createAgentSession: async (options) => {
        calls.push(options ?? {});
        return { session };
      },
      hil: {
        onAwaitingInputStart: ({ stageId }) => events.push(`start:${stageId}`),
        onAwaitingInputEnd: ({ stageId }) => events.push(`end:${stageId}`),
      },
    });

    await adapters.agentSession!.create({ tools: ["read"] }, meta);

    const options = calls[0]!;
    assert.deepEqual(options.tools, ["read"]);
    const tool = options.customTools?.find((candidate) => candidate.name === "ask_user_question");
    assert.ok(tool);
    assert.equal(typeof bindCalls[0]?.uiContext?.custom, "function");

    type ToolExecuteContext = Parameters<typeof tool.execute>[4];
    await tool.execute(
      "call-1",
      {
        questions: [{
          question: "Pick a color?",
          header: "Color",
          options: [
            { label: "Blue", description: "Use blue." },
            { label: "Green", description: "Use green." },
          ],
        }],
      },
      new AbortController().signal,
      () => undefined,
      {
        hasUI: true,
        ui: bindCalls[0]!.uiContext!,
      } as unknown as ToolExecuteContext,
    );

    assert.deepEqual(events, ["start:stage-1", "end:stage-1"]);
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
