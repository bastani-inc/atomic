import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { quitAllRuns, quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import {
  createStageControlRegistry,
  type StageControlHandle,
  type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";

function stageHandle(input: {
  runId: string;
  stageId: string;
  pause: () => Promise<void>;
  resume?: () => Promise<void>;
  status: () => StageControlStatus;
}): StageControlHandle {
  return {
    runId: input.runId,
    stageId: input.stageId,
    stageName: input.stageId,
    get status() { return input.status(); },
    sessionId: undefined,
    sessionFile: undefined,
    isStreaming: false,
    messages: [] as AgentSession["messages"],
    async ensureAttached() {},
    async prompt() {},
    async steer() {},
    async followUp() {},
    pause: input.pause,
    resume: input.resume ?? (async () => {}),
    subscribe: () => () => {},
  };
}

function productionSession(overrides: Partial<StageSessionRuntime>): StageSessionRuntime {
  return {
    async prompt() {},
    async steer() {},
    async followUp() {},
    subscribe: () => () => {},
    sessionFile: "/tmp/background-quit-production.jsonl",
    sessionId: "background-quit-production",
    async setModel() {},
    setThinkingLevel() {},
    cycleModel: async () => undefined,
    cycleThinkingLevel: () => undefined,
    agent: undefined as unknown as AgentSession["agent"],
    model: undefined as AgentSession["model"],
    thinkingLevel: "medium",
    messages: [] as AgentSession["messages"],
    isStreaming: false,
    navigateTree: async () => ({ cancelled: false }),
    compact: async () => ({}),
    abortCompaction() {},
    async abort() {},
    dispose() {},
    getLastAssistantText: () => "done",
    ...overrides,
  } as StageSessionRuntime;
}

afterEach(() => setDurableBackend(undefined));

describe("graceful workflow quit acknowledgement", () => {
  test("between stages reports no controllable stage instead of claiming resumable pause", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const store = createStore();
    const registry = createStageControlRegistry();
    const betweenStages = Promise.withResolvers<void>();
    const releaseWorkflow = Promise.withResolvers<void>();
    const runId = "quit-between-stages";
    const definition = workflow({
      name: "quit-between-stages",
      description: "",
      inputs: {},
      outputs: { done: Type.Boolean() },
      run: async (ctx) => {
        await ctx.stage("first").prompt("first");
        betweenStages.resolve();
        await releaseWorkflow.promise;
        await ctx.stage("second").prompt("second");
        return { done: true };
      },
    });

    const execution = run(definition, {}, {
      runId,
      store,
      stageControlRegistry: registry,
      durableBackend: backend,
      adapters: { prompt: { prompt: async (text) => `done:${text}` } },
    });
    await betweenStages.promise;
    assert.equal(registry.run(runId).stages().length, 0);

    const result = await quitRun(runId, { store, stageControlRegistry: registry });

    assert.deepEqual(result, { ok: false, runId, reason: "no_active_stages" });
    assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "running");
    assert.equal(backend.getWorkflow(runId)?.status, "running");

    releaseWorkflow.resolve();
    assert.equal((await execution).status, "completed");
  });

  test("same-run quit settles every stage pause and aggregates stage-specific failures", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const store = createStore();
    const registry = createStageControlRegistry();
    const secondAcknowledgement = Promise.withResolvers<void>();
    const runId = "quit-rejected-pause";
    let secondPauseCalls = 0;
    let secondPauseSettled = false;
    store.recordRunStart({ id: runId, name: "reject", inputs: {}, status: "running", stages: [], startedAt: 1 });
    for (const stageId of ["stage-reject", "stage-late"]) {
      store.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
    }
    backend.registerWorkflow({ workflowId: runId, name: "reject", inputs: {}, createdAt: 1, status: "running" });
    registry.register(stageHandle({
      runId,
      stageId: "stage-reject",
      status: () => "running",
      pause: async () => { throw new Error("first pause rejected"); },
    }));
    registry.register(stageHandle({
      runId,
      stageId: "stage-late",
      status: () => "running",
      pause: async () => {
        secondPauseCalls += 1;
        await secondAcknowledgement.promise;
        secondPauseSettled = true;
      },
    }));

    let quitSettled = false;
    const quitting = quitRun(runId, { store, stageControlRegistry: registry })
      .then(() => undefined, (error: unknown) => error)
      .finally(() => { quitSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeSecondAcknowledgement = quitSettled;
    const secondPauseCallsBeforeAcknowledgement = secondPauseCalls;
    secondAcknowledgement.resolve();
    const failure = await quitting;

    assert.equal(settledBeforeSecondAcknowledgement, false, "quit must await every same-run stage");
    assert.equal(secondPauseCallsBeforeAcknowledgement, 1, "quit must attempt the sibling after a rejection");
    assert.equal(secondPauseSettled, true);
    assert.match(failure instanceof Error ? failure.message : String(failure), /stage-reject.*first pause rejected/);
    const run = store.runs().find((candidate) => candidate.id === runId);
    assert.equal(run?.status, "running");
    assert.equal(run?.exitReason, undefined);
    assert.equal(run?.resumable, undefined);
    assert.equal(backend.getWorkflow(runId)?.status, "running");
  });

  test("successful quit waits for pause acknowledgement and remains resumable", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const store = createStore();
    const registry = createStageControlRegistry();
    const pauseAcknowledged = Promise.withResolvers<void>();
    const runId = "quit-acknowledged";
    let status: StageControlStatus = "running";
    store.recordRunStart({ id: runId, name: "ack", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart(runId, { id: "stage-1", name: "stage", status: "running", parentIds: [], toolEvents: [] });
    backend.registerWorkflow({ workflowId: runId, name: "ack", inputs: {}, createdAt: 1, status: "running" });
    registry.register(stageHandle({
      runId,
      stageId: "stage-1",
      status: () => status,
      pause: async () => {
        await pauseAcknowledged.promise;
        status = "paused";
      },
      resume: async () => { status = "running"; },
    }));

    let settled = false;
    const quitting = quitRun(runId, { store, stageControlRegistry: registry })
      .finally(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "running");
    assert.equal(backend.getWorkflow(runId)?.status, "running");

    pauseAcknowledged.resolve();
    const result = await quitting;
    assert.equal(result.ok, true);
    assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
    assert.equal(backend.getWorkflow(runId)?.status, "paused");

    const resumed = await resumeRun(runId, { store, stageControlRegistry: registry });
    assert.equal(resumed.ok, true);
    assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "running");
  });

  test("bulk quit settles fast rejection and late acknowledgement with per-run reasons", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const store = createStore();
    const registry = createStageControlRegistry();
    const lateAcknowledgement = Promise.withResolvers<void>();
    let lateStatus: StageControlStatus = "running";
    for (const runId of ["quit-reject-fast", "quit-ack-late"]) {
      store.recordRunStart({ id: runId, name: runId, inputs: {}, status: "running", stages: [], startedAt: 1 });
      store.recordStageStart(runId, { id: `${runId}-stage`, name: "stage", status: "running", parentIds: [], toolEvents: [] });
      backend.registerWorkflow({ workflowId: runId, name: runId, inputs: {}, createdAt: 1, status: "running" });
    }
    registry.register(stageHandle({
      runId: "quit-reject-fast",
      stageId: "quit-reject-fast-stage",
      status: () => "running",
      pause: async () => { throw new Error("pause failed fast"); },
    }));
    registry.register(stageHandle({
      runId: "quit-ack-late",
      stageId: "quit-ack-late-stage",
      status: () => lateStatus,
      pause: async () => {
        await lateAcknowledgement.promise;
        lateStatus = "paused";
      },
    }));

    let settled = false;
    const quitting = quitAllRuns({ store, stageControlRegistry: registry })
      .finally(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeLateAcknowledgement = settled;
    lateAcknowledgement.resolve();

    let results: Awaited<ReturnType<typeof quitAllRuns>> | undefined;
    let failure: unknown;
    try {
      results = await quitting;
    } catch (error) {
      failure = error;
    }

    assert.equal(settledBeforeLateAcknowledgement, false, "bulk quit must await every run");
    assert.equal(failure, undefined, "bulk quit must return settled failures instead of fail-fast rejecting");
    assert.deepEqual(results?.map((result) => result.ok ? [result.runId, "ok"] : [result.runId, result.reason]), [
      ["quit-reject-fast", "pause_failed"],
      ["quit-ack-late", "ok"],
    ]);
    const rejected = results?.find((result) => !result.ok && result.runId === "quit-reject-fast");
    assert.match(rejected !== undefined && "message" in rejected ? rejected.message : "", /pause failed fast/);
    assert.equal(store.runs().find((run) => run.id === "quit-reject-fast")?.status, "running");
    assert.equal(store.runs().find((run) => run.id === "quit-ack-late")?.status, "paused");
  });

  test("production pause rejection leaves stage, run, and durability running", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const store = createStore();
    const registry = createStageControlRegistry();
    const promptStarted = Promise.withResolvers<void>();
    const finishPrompt = Promise.withResolvers<void>();
    let streaming = false;
    const session = productionSession({
      async prompt() {
        streaming = true;
        promptStarted.resolve();
        await finishPrompt.promise;
        streaming = false;
      },
      get isStreaming() { return streaming; },
      async abort() { throw new Error("production pause acknowledgement failed"); },
    });
    const definition = workflow({
      name: "production-pause-rejection",
      description: "",
      inputs: {},
      outputs: { done: Type.Boolean() },
      run: async (ctx) => {
        await ctx.stage("live-stage").prompt("work");
        return { done: true };
      },
    });
    const execution = run(definition, {}, {
      runId: "production-pause-rejection",
      store,
      stageControlRegistry: registry,
      durableBackend: backend,
      adapters: { agentSession: { create: async () => session } },
    });
    await promptStarted.promise;
    const handle = registry.run("production-pause-rejection").stages()[0];
    assert.ok(handle);

    const pauseFailure = await quitRun("production-pause-rejection", { store, stageControlRegistry: registry })
      .then(() => undefined, (error: unknown) => error);
    const stateAfterRejectedPause = structuredClone(store.runs().find((run) => run.id === "production-pause-rejection"));
    const durableAfterRejectedPause = backend.getWorkflow("production-pause-rejection")?.status;

    await handle.resume();
    finishPrompt.resolve();
    await execution;

    assert.match(pauseFailure instanceof Error ? pauseFailure.message : String(pauseFailure), /production pause acknowledgement failed/);
    assert.equal(stateAfterRejectedPause?.status, "running");
    assert.equal(stateAfterRejectedPause?.stages[0]?.status, "running");
    assert.equal(durableAfterRejectedPause, "running");
  });

  test("production quit then acknowledged resume keeps store, stage, and durable state coherent", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const store = createStore();
    const registry = createStageControlRegistry();
    const firstPromptStarted = Promise.withResolvers<void>();
    const secondPromptStarted = Promise.withResolvers<void>();
    const finishSecondPrompt = Promise.withResolvers<void>();
    let rejectCurrentPrompt: ((reason: Error) => void) | undefined;
    let promptCalls = 0;
    let streaming = false;
    const session = productionSession({
      async prompt() {
        promptCalls += 1;
        streaming = true;
        if (promptCalls === 1) firstPromptStarted.resolve();
        else secondPromptStarted.resolve();
        await new Promise<void>((resolve, reject) => {
          rejectCurrentPrompt = reject;
          if (promptCalls > 1) void finishSecondPrompt.promise.then(resolve);
        });
        streaming = false;
      },
      get isStreaming() { return streaming; },
      async abort() {
        streaming = false;
        rejectCurrentPrompt?.(new Error("AbortError"));
      },
    });
    const definition = workflow({
      name: "production-quit-resume",
      description: "",
      inputs: {},
      outputs: { done: Type.Boolean() },
      run: async (ctx) => {
        await ctx.stage("live-stage").prompt("work");
        return { done: true };
      },
    });
    const runId = "production-quit-resume";
    const execution = run(definition, {}, {
      runId,
      store,
      stageControlRegistry: registry,
      durableBackend: backend,
      adapters: { agentSession: { create: async () => session } },
    });
    await firstPromptStarted.promise;

    assert.equal((await quitRun(runId, { store, stageControlRegistry: registry })).ok, true);
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "paused");
    assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.status, "paused");
    assert.equal(backend.getWorkflow(runId)?.status, "paused");

    const resumed = await resumeRun(runId, {
      store,
      stageControlRegistry: registry,
      message: "continue",
    });
    assert.equal(resumed.ok, true);
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
    assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.status, "running");
    assert.equal(registry.get(runId, store.runs().find((run) => run.id === runId)!.stages[0]!.id)?.status, "running");
    assert.equal(backend.getWorkflow(runId)?.status, "running");

    await secondPromptStarted.promise;
    finishSecondPrompt.resolve();
    assert.equal((await execution).status, "completed");
  });

});
