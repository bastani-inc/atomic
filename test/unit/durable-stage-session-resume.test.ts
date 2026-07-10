import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { createDurableStagePrimitive, createStageReplayKeyGenerator, recordStageCheckpoint, recordStageSessionCheckpoint } from "../../packages/workflows/src/durable/stage-primitive.js";
import { RESUME_CONTINUATION_PROMPT } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

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

  function deps() {
    return {
      workflowId: WORKFLOW_ID,
      backend,
      nextCheckpointId: createCheckpointIdGenerator(),
      nextReplayKey: createStageReplayKeyGenerator(WORKFLOW_ID),
    };
  }

  test("records in-progress stage session metadata", async () => {
    const stage = makeStage({ replayKey: "stage:analyze:1", sessionId: "sid-1", sessionFile: "/tmp/stage.jsonl" });
    assert.equal(await recordStageSessionCheckpoint(deps(), stage), true);
    assert.equal(backend.getStageOutput(WORKFLOW_ID, "stage:analyze:1"), undefined);
    assert.deepEqual(backend.getStageSession(WORKFLOW_ID, "stage:analyze:1"), {
      sessionId: "sid-1",
      sessionFile: "/tmp/stage.jsonl",
    });
    // Running (active) workflows are hidden from resume; quitting flips the
    // durable handle to paused, which is when an in-progress stage session
    // becomes resumable.
    backend.setWorkflowStatus(WORKFLOW_ID, "paused");
    assert.equal(backend.listResumableWorkflows().length, 1);
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
    assert.equal(await recordStageSessionCheckpoint(deps(), makeStage({ replayKey, sessionFile: "/tmp/first.jsonl" })), true);
    assert.equal(await recordStageSessionCheckpoint(deps(), makeStage({ replayKey, sessionFile: "/tmp/second.jsonl" })), true);
    assert.deepEqual(backend.getStageSession(WORKFLOW_ID, replayKey), { sessionFile: "/tmp/second.jsonl" });
  });

  test("completed output wins over later session metadata", async () => {
    const replayKey = "stage:analyze:1";
    await recordStageCheckpoint(deps(), makeStage({ status: "completed", replayKey, result: "done", endedAt: 2000 }));
    await recordStageSessionCheckpoint(deps(), makeStage({ replayKey, sessionFile: "/tmp/later.jsonl" }));
    assert.equal(backend.getStageOutput(WORKFLOW_ID, replayKey), "done");
    assert.deepEqual(backend.getStageSession(WORKFLOW_ID, replayKey), { sessionFile: "/tmp/later.jsonl" });
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
    assert.deepEqual(backend.getStageSession(WORKFLOW_ID, replayKey), { sessionFile: "/tmp/first.jsonl" });
  });
});
