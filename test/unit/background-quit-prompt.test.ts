import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import {
  createStageControlRegistry,
  type StageControlHandle,
  type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

async function waitForPrompt(store: ReturnType<typeof createStore>): Promise<{
  readonly runId: string;
  readonly stageId: string;
  readonly promptId: string;
}> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    for (const runSnapshot of store.runs()) {
      const stage = runSnapshot.stages.find((candidate) => candidate.pendingPrompt !== undefined);
      if (stage?.pendingPrompt !== undefined) {
        return { runId: runSnapshot.id, stageId: stage.id, promptId: stage.pendingPrompt.id };
      }
    }
    await Bun.sleep(5);
  }
  throw new Error("pending prompt did not appear");
}

function control(input: {
  readonly runId: string;
  readonly stageId: string;
  readonly status: () => StageControlStatus;
  readonly pause: () => Promise<void>;
  readonly resume?: () => Promise<void>;
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

afterEach(() => setDurableBackend(undefined));

describe("graceful quit at user-input boundaries", () => {
  test("a synthetic prompt stays paused after an answer until explicit resume", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const store = createStore();
    const registry = createStageControlRegistry();
    let advancedPastPrompt = false;
    const runId = "quit-synthetic-prompt";
    const definition = workflow({
      name: "quit-synthetic-prompt",
      description: "",
      inputs: {},
      outputs: { answer: Type.String() },
      run: async (ctx) => {
        const answer = await ctx.ui.input("Value?");
        advancedPastPrompt = true;
        return { answer };
      },
    });
    const execution = run(definition, {}, {
      runId,
      store,
      stageControlRegistry: registry,
      durableBackend: backend,
      usePromptNodesForUi: true,
    });
    const pending = await waitForPrompt(store);
    const originalPrompt = structuredClone(
      store.runs().find((candidate) => candidate.id === runId)?.stages[0]?.pendingPrompt,
    );
    assert.equal(backend.getWorkflow(runId)?.pendingPrompts, 1);

    const quit = await quitRun(runId, { store, stageControlRegistry: registry });
    assert.equal(quit.ok, true);
    const paused = store.runs().find((candidate) => candidate.id === runId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.exitReason, "quit");
    assert.equal(paused?.resumable, true);
    assert.deepEqual(paused?.stages[0]?.pendingPrompt, originalPrompt);
    assert.equal(backend.getWorkflow(runId)?.status, "paused");
    assert.equal(backend.getWorkflow(runId)?.pendingPrompts, 1);

    assert.equal(store.resolveStagePendingPrompt(runId, pending.stageId, pending.promptId, "answer"), true);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(advancedPastPrompt, false, "answering must not bypass the quit pause gate");
    assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
    assert.equal(backend.getWorkflow(runId)?.pendingPrompts, 1);

    const resumed = await resumeRun(runId, { store, stageControlRegistry: registry });
    assert.equal(resumed.ok, true);
    assert.equal((await execution).status, "completed");
    assert.equal(advancedPastPrompt, true);
    assert.equal(backend.getWorkflow(runId)?.pendingPrompts, 0);
  });

  test("a second quit creates a fresh answer barrier after an unanswered resume", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const store = createStore();
    const registry = createStageControlRegistry();
    const runId = "quit-synthetic-prompt-twice";
    let advancedPastPrompt = false;
    const definition = workflow({
      name: runId,
      description: "",
      inputs: {},
      outputs: { answer: Type.String() },
      run: async (ctx) => {
        const answer = await ctx.ui.input("Value?");
        advancedPastPrompt = true;
        return { answer };
      },
    });
    const execution = run(definition, {}, {
      runId,
      store,
      stageControlRegistry: registry,
      durableBackend: backend,
      usePromptNodesForUi: true,
    });
    const pending = await waitForPrompt(store);

    assert.equal((await quitRun(runId, { store, stageControlRegistry: registry })).ok, true);
    assert.equal((await resumeRun(runId, { store, stageControlRegistry: registry })).ok, true);
    assert.equal((await quitRun(runId, { store, stageControlRegistry: registry })).ok, true);
    assert.equal(store.resolveStagePendingPrompt(runId, pending.stageId, pending.promptId, "answer"), true);
    await Bun.sleep(10);
    assert.equal(advancedPastPrompt, false, "the second quit must install a new unresolved gate");
    assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
    assert.equal(backend.getWorkflow(runId)?.status, "paused");

    assert.equal((await resumeRun(runId, { store, stageControlRegistry: registry })).ok, true);
    assert.equal((await execution).status, "completed");
    assert.equal(advancedPastPrompt, true);
  });

  test("controllerless synthetic pending prompt is distinct from between-stage state", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const store = createStore();
    const registry = createStageControlRegistry();
    const runId = "quit-controllerless-prompt";
    const stageId = "prompt-stage";
    const prompt = { id: "prompt-id", kind: "input" as const, message: "Value?", createdAt: 2 };
    store.recordRunStart({ id: runId, name: "prompt", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart(runId, { id: stageId, name: "input", status: "running", parentIds: [], toolEvents: [] });
    assert.equal(store.recordStagePendingPrompt(runId, stageId, prompt), true);
    backend.registerWorkflow({
      workflowId: runId,
      name: "prompt",
      inputs: {},
      createdAt: 1,
      status: "running",
      pendingPrompts: 1,
      resumable: true,
    });

    const result = await quitRun(runId, { store, stageControlRegistry: registry });

    assert.equal(result.ok, true);
    const paused = store.runs().find((run) => run.id === runId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.stages[0]?.status, "paused");
    assert.deepEqual(paused?.stages[0]?.pendingPrompt, prompt);
    assert.equal(backend.getWorkflow(runId)?.status, "paused");
    assert.equal(backend.getWorkflow(runId)?.pendingPrompts, 1);
  });

  test("awaiting-input controls acknowledge pause and already-paused quit is idempotent", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const store = createStore();
    const registry = createStageControlRegistry();
    const runId = "quit-live-awaiting";
    const stageId = "awaiting-stage";
    let status: StageControlStatus = "awaiting_input";
    let pauseCalls = 0;
    store.recordRunStart({ id: runId, name: "awaiting", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart(runId, { id: stageId, name: stageId, status: "awaiting_input", parentIds: [], toolEvents: [] });
    backend.registerWorkflow({ workflowId: runId, name: "awaiting", inputs: {}, createdAt: 1, status: "running", pendingPrompts: 1 });
    registry.register(control({
      runId,
      stageId,
      status: () => status,
      pause: async () => {
        pauseCalls += 1;
        status = "paused";
        store.recordStagePaused(runId, stageId);
      },
      resume: async () => {
        status = "running";
        store.recordStageResumed(runId, stageId);
      },
    }));

    const first = await quitRun(runId, { store, stageControlRegistry: registry });
    assert.equal(first.ok, true);
    assert.equal(pauseCalls, 1);
    const firstSnapshot = structuredClone(store.runs().find((candidate) => candidate.id === runId));

    const second = await quitRun(runId, { store, stageControlRegistry: registry });
    assert.deepEqual(Object.keys(second).sort(), Object.keys(first).sort());
    assert.equal(second.ok, true);
    assert.equal(second.runId, runId);
    assert.equal(pauseCalls, 1, "idempotent quit must not duplicate pause acknowledgement");
    assert.equal(store.runs().filter((candidate) => candidate.id === runId).length, 1);
    assert.equal(store.runs().find((candidate) => candidate.id === runId)?.id, firstSnapshot?.id);
    assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
    assert.equal(backend.getWorkflow(runId)?.status, "paused");
    assert.equal(backend.getWorkflow(runId)?.pendingPrompts, 1);
  });
});
