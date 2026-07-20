import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { RESUME_CONTINUATION_PROMPT } from "../../packages/workflows/src/shared/resume-continuation.js";
import { store } from "../../packages/workflows/src/shared/store.js";

const activeRuns: Promise<unknown>[] = [];

afterEach(async () => {
  stageControlRegistry.clear();
  store.clear();
  await Promise.allSettled(activeRuns.splice(0));
});

function deferred<T = void>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}


function baseSession(overrides: Partial<StageSessionRuntime>): StageSessionRuntime {
  return {
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    subscribe: () => () => {},
    sessionFile: undefined,
    sessionId: crypto.randomUUID(),
    setModel: async () => {},
    setThinkingLevel: () => {},
    cycleModel: async () => ({ model: undefined, thinkingLevel: undefined }),
    cycleThinkingLevel: () => undefined,
    agent: {} as never,
    model: undefined,
    thinkingLevel: "off",
    messages: [],
    isStreaming: false,
    navigateTree: async () => {},
    compact: async () => undefined,
    abortCompaction: () => {},
    abort: async () => {},
    dispose: () => {},
    ...overrides,
  } as StageSessionRuntime;
}

function idleChatSession(promptCalls: string[]): StageSessionRuntime {
  type Listener = Parameters<StageSessionRuntime["subscribe"]>[0];
  const listeners = new Set<Listener>();
  const emit = (event: AgentSessionEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return baseSession({
    async prompt(text) {
      promptCalls.push(text);
      if (text === "wait for chat") {
        emit({ type: "tool_execution_start", toolCallId: "ask-1", toolName: "ask_user_question" } as AgentSessionEvent);
        emit({ type: "tool_execution_end", toolCallId: "ask-1", toolName: "ask_user_question" } as AgentSessionEvent);
      }
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } } as AgentSessionEvent);
      emit({ type: "agent_end", messages: [] });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
}
async function startTwoStageIdleWorkflow(name: string, signal?: AbortSignal): Promise<{
  readonly runPromise: ReturnType<typeof run>;
  readonly runId: string;
  readonly stageId: string;
  readonly promptCalls: string[];
  readonly secondStageCalls: string[];
}> {
  const waiting = deferred<{ runId: string; stageId: string }>();
  const promptCalls: string[] = [];
  const secondStageCalls: string[] = [];
  let createCount = 0;
  const def = workflow({
    name,
    description: "",
    inputs: {},
    outputs: {},
    run: async (ctx) => {
      await ctx.stage("chat").prompt("wait for chat");
      await ctx.stage("record-completion").prompt("first completed");
      return {};
    },
  });
  const runPromise = run(def, {}, {
    store,
    stageControlRegistry,
    adapters: {
      agentSession: {
        async create() {
          createCount += 1;
          return createCount === 1
            ? idleChatSession(promptCalls)
            : baseSession({ async prompt(text) { secondStageCalls.push(text); } });
        },
      },
    },
    confirmStageReadiness: async ({ runId, stageId, stageName }) => {
      if (stageName === "chat") {
        waiting.resolve({ runId, stageId });
        return false;
      }
      return true;
    },
    ...(signal !== undefined ? { signal } : {}),
  });
  activeRuns.push(runPromise);
  const ids = await waiting.promise;
  return { runPromise, ...ids, promptCalls, secondStageCalls };
}

function streamingSession(input: {
  readonly promptCalls: string[];
  readonly followUps: string[];
  readonly steers: string[];
  readonly started: PromiseWithResolvers<void>;
  readonly release: PromiseWithResolvers<void>;
}): StageSessionRuntime {
  type Listener = Parameters<StageSessionRuntime["subscribe"]>[0];
  const listeners = new Set<Listener>();
  let streaming = false;
  const emit = (event: AgentSessionEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const emitQueue = (followUp: readonly string[]): void => {
    emit({ type: "queue_update", steering: [], followUp: [...followUp] });
  };
  const emitUser = (text: string): void => {
    emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } } as AgentSessionEvent);
  };
  const session = baseSession({
    async prompt(text) {
      input.promptCalls.push(text);
      emitUser(text);
      if (text === RESUME_CONTINUATION_PROMPT) return;
      streaming = true;
      input.started.resolve();
      await input.release.promise;
      for (const queued of input.followUps.splice(0)) {
        emitQueue(input.followUps);
        emitUser(queued);
      }
      emit({ type: "agent_end", messages: [] });
      streaming = false;
    },
    async followUp(text) {
      input.followUps.push(text);
      emitQueue(input.followUps);
    },
    async steer(text) {
      input.steers.push(text);
      emit({ type: "queue_update", steering: [text], followUp: [...input.followUps] });
      emit({ type: "queue_update", steering: [], followUp: [...input.followUps] });
      emitUser(text);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
  Object.defineProperty(session, "isStreaming", { get: () => streaming });
  return session;
}

describe("issue #1850 integration — idle stage message routing", () => {
  for (const requested of ["followUp", "auto"] as const) {
    test(`idle ${requested} starts one prompt and releases the dependent stage`, async () => {
      const fixture = await startTwoStageIdleWorkflow(`idle-${requested}-integration`);

      const delivered = await workflowSendAction({
        action: "send",
        runId: fixture.runId,
        stageId: fixture.stageId,
        delivery: requested,
        text: `continue via ${requested}`,
      });

      assert.equal(delivered.delivery, "prompt");
      assert.equal(delivered.message, "Prompt started for stage.");
      const completed = await fixture.runPromise;
      assert.equal(completed.status, "completed");
      assert.deepEqual(fixture.promptCalls, ["wait for chat", `continue via ${requested}`]);
      assert.deepEqual(fixture.secondStageCalls, ["first completed"]);
    });
  }

  test("paused idle-chat resume(message) starts exactly one recorded prompt", async () => {
    const fixture = await startTwoStageIdleWorkflow("idle-resume-integration");
    const handle = stageControlRegistry.get(fixture.runId, fixture.stageId);
    assert.ok(handle);
    await handle.pause();

    const delivered = await workflowSendAction({
      action: "send",
      runId: fixture.runId,
      stageId: fixture.stageId,
      delivery: "resume",
      text: "approved once",
    });

    assert.equal(delivered.delivery, "prompt");
    assert.equal(delivered.message, "Resumed stage and started prompt.");
    const completed = await fixture.runPromise;
    assert.equal(completed.status, "completed");
    assert.deepEqual(fixture.promptCalls, ["wait for chat", "approved once"]);
    assert.deepEqual(fixture.secondStageCalls, ["first completed"]);
  });

  test("streaming followUp queues and steer steers without a concurrent prompt", async () => {
    const started = deferred();
    const release = deferred();
    const promptCalls: string[] = [];
    const followUps: string[] = [];
    const steers: string[] = [];
    const ids = deferred<{ runId: string; stageId: string }>();
    const def = workflow({
      name: "streaming-routing-integration",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("streaming").prompt("active turn");
        return {};
      },
    });
    const runPromise = run(def, {}, {
      store,
      stageControlRegistry,
      adapters: { agentSession: { async create() { return streamingSession({ promptCalls, followUps, steers, started, release }); } } },
      onStageStart(runId, stage) { ids.resolve({ runId, stageId: stage.id }); },
      confirmStageReadiness: async () => true,
    });
    activeRuns.push(runPromise);
    const target = await ids.promise;
    await started.promise;

    const queued = await workflowSendAction({ ...target, text: "queued once", delivery: "followUp" });
    const steered = await workflowSendAction({ ...target, text: "steer once", delivery: "steer" });

    assert.equal(queued.delivery, "followUp");
    assert.equal(queued.message, "Follow-up queued for stage.");
    assert.equal(steered.delivery, "steer");
    assert.equal(steered.message, "Steered live stage.");
    assert.deepEqual(promptCalls, ["active turn"]);
    assert.deepEqual(followUps, ["queued once"]);
    assert.deepEqual(steers, ["steer once"]);

    release.resolve();
    const completed = await runPromise;
    assert.equal(completed.status, "completed");
    assert.equal(promptCalls.filter((text) => text === RESUME_CONTINUATION_PROMPT).length, 1);
    assert.deepEqual(followUps, []);
  });

  test("terminal completion removes live delivery while preserving explicit post-mortem compatibility", async () => {
    const fixture = await startTwoStageIdleWorkflow("terminal-late-prompt-integration");
    const retained = stageControlRegistry.get(fixture.runId, fixture.stageId);
    assert.ok(retained);

    await workflowSendAction({
      action: "send",
      runId: fixture.runId,
      stageId: fixture.stageId,
      delivery: "followUp",
      text: "complete normally",
    });
    const completed = await fixture.runPromise;
    assert.equal(completed.status, "completed");
    const before = [...fixture.promptCalls];

    const late = await workflowSendAction({
      action: "send",
      runId: fixture.runId,
      stageId: fixture.stageId,
      delivery: "resume",
      text: "unsupported terminal resume",
    });
    assert.equal(late.status, "noop");
    assert.equal(late.message, "Cannot resume a terminal post-mortem stage; use delivery \"followUp\" or \"prompt\" to continue its retained conversation.");
    assert.deepEqual(fixture.promptCalls, before);
  });

  test("abort blocks a captured idle handle from starting a late prompt", async () => {
    const controller = new AbortController();
    const fixture = await startTwoStageIdleWorkflow("abort-late-prompt-integration", controller.signal);
    const handle = stageControlRegistry.get(fixture.runId, fixture.stageId);
    assert.ok(handle);
    const before = [...fixture.promptCalls];

    controller.abort(new DOMException("test abort", "AbortError"));
    await assert.rejects(() => handle.prompt("late prompt"), /test abort|workflow killed/);
    const killed = await fixture.runPromise;

    assert.equal(killed.status, "killed");
    assert.deepEqual(fixture.promptCalls, before);
  });
});
