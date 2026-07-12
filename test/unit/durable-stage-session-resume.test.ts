import { afterEach, beforeEach, describe, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { FileDurableBackend } from "../../packages/workflows/src/durable/file-backend.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { createDurableStagePrimitive, createStageReplayKeyGenerator, recordStageCheckpoint, recordStageSessionCheckpoint } from "../../packages/workflows/src/durable/stage-primitive.js";
import { RESUME_CONTINUATION_PROMPT } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { elapsedStageMs, rebasedStageStartedAt } from "../../packages/workflows/src/shared/timing.js";
import { createStore, run, Type, workflow } from "./executor-shared.js";

afterEach(() => mock.restore());
const WORKFLOW_ID = "wf-stage-session-resume";

function makeStage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    id: "stage-1",
    name: "analyze",
    status: "running",
    parentIds: [],
    startedAt: 1000,
    toolEvents: [],
    ...overrides,
  };
}

function fakeStageContext(text: string) {
  return {
    prompt: async () => text,
    complete: async () => text,
    steer: async () => {},
    followUp: async () => {},
    subscribe: () => () => {},
    sessionFile: undefined,
    sessionId: "",
    setModel: async () => {},
    setThinkingLevel: () => {},
    cycleModel: async () => undefined,
    cycleThinkingLevel: () => undefined,
    agent: undefined,
    model: undefined,
    thinkingLevel: undefined,
    messages: [],
    isStreaming: false,
    navigateTree: async () => {},
    compact: async () => {},
    abortCompaction: () => {},
    abort: async () => {},
  } as never;
}

describe("durable stage session resume", () => {
  let backend: InMemoryDurableBackend;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    backend.registerWorkflow({
      workflowId: WORKFLOW_ID,
      name: "stage-test",
      inputs: {},
      createdAt: Date.now(),
      status: "running",
    });
  });

  function deps(now = 2000) {
    return {
      workflowId: WORKFLOW_ID,
      backend,
      nextCheckpointId: createCheckpointIdGenerator(),
      nextReplayKey: createStageReplayKeyGenerator(WORKFLOW_ID),
      now: () => now,
    };
  }

  test("records in-progress stage session metadata", async () => {
    const stage = makeStage({ replayKey: "stage:analyze:1", sessionId: "sid-1", sessionFile: "/tmp/stage.jsonl" });
    assert.equal(await recordStageSessionCheckpoint(deps(), stage), true);
    assert.equal(backend.getStageOutput(WORKFLOW_ID, "stage:analyze:1"), undefined);
    assert.deepEqual(backend.getStageSession(WORKFLOW_ID, "stage:analyze:1"), {
      sessionId: "sid-1",
      sessionFile: "/tmp/stage.jsonl",
      startedAt: 1000,
      durationMs: 1000,
    });
    // Running (active) workflows are hidden from resume; quitting flips the
    // durable handle to paused, which is when an in-progress stage session
    // becomes resumable.
    backend.setWorkflowStatus(WORKFLOW_ID, "paused");
    assert.equal(backend.listResumableWorkflows().length, 1);
  });

  test("refreshes accumulated active duration for repeated checkpoints of one session", async () => {
    const replayKey = "stage:analyze:1";
    const stage = makeStage({ replayKey, sessionId: "sid-1", sessionFile: "/tmp/stage.jsonl" });

    assert.equal(await recordStageSessionCheckpoint(deps(1400), stage), true);
    assert.equal(await recordStageSessionCheckpoint(deps(1750), stage), true);
    assert.equal(await recordStageSessionCheckpoint(deps(1750), stage), false);

    assert.deepEqual(backend.getStageSession(WORKFLOW_ID, replayKey), {
      sessionId: "sid-1",
      sessionFile: "/tmp/stage.jsonl",
      startedAt: 1000,
      durationMs: 750,
    });
    assert.equal(backend.listCheckpoints(WORKFLOW_ID).length, 2);
  });

  test("checkpoints pause-adjusted duration without double-counting", async () => {
    const replayKey = "stage:analyze:1";
    const stage = makeStage({
      replayKey,
      sessionFile: "/tmp/stage.jsonl",
      pausedDurationMs: 200,
      pausedAt: 1800,
    });

    await recordStageSessionCheckpoint(deps(2200), stage);

    assert.equal(backend.getStageSession(WORKFLOW_ID, replayKey)?.durationMs, 600);
  });

  test("counts post-resume elapsed time while excluding a new pause exactly once", () => {
    const resumedAt = 5000;
    const startedAt = rebasedStageStartedAt(700, resumedAt);
    const completedAt = 5500;

    assert.equal(startedAt, 4300);
    assert.equal(elapsedStageMs({ startedAt, pausedDurationMs: 200 }, completedAt), 1000);
    assert.equal(rebasedStageStartedAt(-50, resumedAt), resumedAt);
  });

  test("reopens prior session file when output is not completed", async () => {
    const replayKey = "stage:analyze:1";
    await recordStageSessionCheckpoint(deps(), makeStage({ replayKey, sessionFile: "/tmp/prior.jsonl" }));
    let observed: string | undefined;
    let observedPrompt: string | undefined;
    const stage = createDurableStagePrimitive({
      workflowId: WORKFLOW_ID,
      backend,
      nextReplayKey: () => replayKey,
      stage: (_name, options) => {
        observed = options?.resumeFromSessionFile;
        return Object.assign(fakeStageContext("resumed") as object, {
          prompt: async (text: string) => {
            observedPrompt = text;
            return "resumed";
          },
        }) as never;
      },
    });

    assert.equal(await stage("analyze").prompt("continue"), "resumed");
    assert.equal(observed, "/tmp/prior.jsonl");
    assert.equal(observedPrompt, RESUME_CONTINUATION_PROMPT);
  });

  test("hydrates accumulated duration into a new-process live stage", async () => {
    const replayKey = "stage:analyze:1";
    await recordStageSessionCheckpoint(deps(1700), makeStage({ replayKey, sessionFile: "/tmp/prior.jsonl" }));
    let accumulatedDurationMs: number | undefined;
    const stage = createDurableStagePrimitive({
      workflowId: WORKFLOW_ID,
      backend,
      nextReplayKey: () => replayKey,
      stage: (_name, options) => {
        accumulatedDurationMs = options?.durableAccumulatedDurationMs;
        return fakeStageContext("resumed");
      },
    });

    await stage("analyze").prompt("continue");
    assert.equal(accumulatedDurationMs, 700);
  });

  test("mid-session resume does not eagerly read throwing StageContext getters", async () => {
    const replayKey = "stage:analyze:1";
    await recordStageSessionCheckpoint(deps(), makeStage({ replayKey, sessionFile: "/tmp/prior.jsonl" }));
    let observedPrompt: string | undefined;
    // Mirror production StageContext: lazy getters that throw until the SDK
    // session exists. A spread-based wrapper would invoke these eagerly.
    const throwingGetter = (): never => {
      throw new Error("atomic-workflows: stage AgentSession property is unavailable until the SDK session has been created");
    };
    const stage = createDurableStagePrimitive({
      workflowId: WORKFLOW_ID,
      backend,
      nextReplayKey: () => replayKey,
      stage: () => {
        const ctx: Record<string, unknown> = Object.assign(fakeStageContext("resumed") as object, {
          prompt: async (text: string) => {
            observedPrompt = text;
            return "resumed";
          },
        });
        for (const prop of ["sessionId", "sessionFile", "messages", "isStreaming"]) {
          Object.defineProperty(ctx, prop, { enumerable: true, configurable: true, get: throwingGetter });
        }
        return ctx as never;
      },
    });

    assert.equal(await stage("analyze").prompt("continue"), "resumed");
    assert.equal(observedPrompt, RESUME_CONTINUATION_PROMPT);
  });

  test("updates session metadata across repeated resumes", async () => {
    const replayKey = "stage:analyze:1";
    assert.equal(await recordStageSessionCheckpoint(deps(1500), makeStage({ replayKey, sessionFile: "/tmp/first.jsonl" })), true);
    assert.equal(await recordStageSessionCheckpoint(deps(1800), makeStage({ replayKey, sessionFile: "/tmp/second.jsonl" })), true);
    assert.deepEqual(backend.getStageSession(WORKFLOW_ID, replayKey), {
      sessionFile: "/tmp/second.jsonl",
      startedAt: 1000,
      durationMs: 800,
    });
  });

  test("completed output wins over later session metadata", async () => {
    const replayKey = "stage:analyze:1";
    await recordStageCheckpoint(deps(), makeStage({ status: "completed", replayKey, result: "done", endedAt: 2000 }));
    await recordStageSessionCheckpoint(deps(), makeStage({ replayKey, sessionFile: "/tmp/later.jsonl" }));
    assert.equal(backend.getStageOutput(WORKFLOW_ID, replayKey), "done");
    assert.deepEqual(backend.getStageSession(WORKFLOW_ID, replayKey), { sessionFile: "/tmp/later.jsonl", startedAt: 1000, durationMs: 1000 });
    const stage = createDurableStagePrimitive({
      workflowId: WORKFLOW_ID,
      backend,
      nextReplayKey: () => replayKey,
      stage: () => { throw new Error("live stage should not run when output is cached"); },
    });
    assert.equal(await stage("analyze").prompt("continue"), "done");
  });

  test("completed output wins after earlier session metadata", async () => {
    const replayKey = "stage:analyze:1";
    await recordStageSessionCheckpoint(deps(), makeStage({ replayKey, sessionFile: "/tmp/first.jsonl" }));
    await recordStageCheckpoint(deps(), makeStage({ status: "completed", replayKey, result: "done", endedAt: 2000 }));
    assert.equal(backend.getStageOutput(WORKFLOW_ID, replayKey), "done");
    assert.deepEqual(backend.getStageSession(WORKFLOW_ID, replayKey), { sessionFile: "/tmp/first.jsonl", startedAt: 1000, durationMs: 1000 });
  });

  test("file process-boundary completion preserves total duration and replay identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-stage-duration-"));
    try {
      const runId = "wf-stage-duration-resume";
      const replayKey = "stage:analyze:1";
      const stateFile = join(dir, "durable.json");
      const writer = new FileDurableBackend(stateFile);
      writer.registerWorkflow({ workflowId: runId, name: "duration-resume", inputs: {}, createdAt: 1000, status: "paused" });
      await recordStageSessionCheckpoint({
        workflowId: runId,
        backend: writer,
        nextCheckpointId: createCheckpointIdGenerator(),
        nextReplayKey: () => replayKey,
        now: () => 1700,
      }, makeStage({ replayKey, sessionFile: "/tmp/durable-stage-duration.jsonl" }));

      let clock = 5000;
      let liveStageCalls = 0;
      spyOn(Date, "now").mockImplementation(() => clock);
      let lifecycleDurationMs: number | undefined;
      const store = createStore();
      const def = workflow({
        name: "duration-resume",
        description: "",
        inputs: {},
        outputs: { result: Type.String() },
        run: async (ctx) => ({ result: await ctx.stage("analyze").complete("done") }),
      });
      const resumedBackend = new FileDurableBackend(stateFile);
      const first = await run(def, {}, {
        runId,
        store,
        durableBackend: resumedBackend,
        adapters: { complete: { complete: async (text) => {
          liveStageCalls += 1;
          clock = 5300;
          return text;
        } } },
        onStageEnd: (_stageRunId, snapshot) => { lifecycleDurationMs = snapshot.durationMs; },
      });

      const storedStage = store.runs()[0]?.stages.find((stage) => stage.name === "analyze");
      const durableStage = resumedBackend.listCheckpoints(runId).find((checkpoint) =>
        checkpoint.kind === "stage" && checkpoint.replayKey === replayKey && checkpoint.output !== undefined,
      );
      assert.equal(first.status, "completed");
      assert.equal(liveStageCalls, 1);
      assert.equal(storedStage?.durationMs, 1000);
      assert.equal(lifecycleDurationMs, 1000);
      assert.equal(durableStage?.kind === "stage" ? durableStage.durationMs : undefined, 1000);

      const replay = await run(def, {}, {
        runId,
        store: createStore(),
        durableBackend: new FileDurableBackend(stateFile),
        adapters: { complete: { complete: async () => {
          liveStageCalls += 1;
          throw new Error("completed stage replay must not execute again");
        } } },
      });
      assert.equal(replay.status, "completed");
      assert.equal(liveStageCalls, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
