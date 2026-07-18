import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import {
  stageControlRegistry,
  type StageControlHandle,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";

const runIds = new Set<string>();

afterEach(() => {
  stageControlRegistry.clear();
  for (const runId of runIds) store.removeRun(runId);
  runIds.clear();
});

function liveHandle(input: {
  readonly runId: string;
  readonly streaming: boolean;
  readonly calls: string[];
  readonly status?: StageControlHandle["status"];
}): StageControlHandle {
  runIds.add(input.runId);
  store.recordRunStart({
    id: input.runId,
    name: "idle-routing",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: 1,
  });
  store.recordStageStart(input.runId, {
    id: "stage-a",
    name: "chat",
    status: "running",
    parentIds: [],
    toolEvents: [],
  });
  const handle: StageControlHandle = {
    runId: input.runId,
    stageId: "stage-a",
    stageName: "chat",
    status: input.status ?? "running",
    sessionId: "session-a",
    sessionFile: undefined,
    isStreaming: input.streaming,
    messages: [],
    async ensureAttached() {},
    async prompt(text) { input.calls.push(`prompt:${text}`); },
    async steer(text) { input.calls.push(`steer:${text}`); },
    async followUp(text) { input.calls.push(`followUp:${text}`); },
    async pause() {},
    async resume(text) { input.calls.push(`resume:${text ?? ""}`); },
    subscribe() { return () => {}; },
  };
  stageControlRegistry.register(handle);
  return handle;
}

describe("workflow send — idle-aware live-stage routing", () => {
  for (const delivery of ["auto", "followUp"] as const) {
    test(`idle ${delivery} starts a prompt and reports the actual action`, async () => {
      const runId = `idle-${delivery}`;
      const calls: string[] = [];
      liveHandle({ runId, streaming: false, calls });

      const result = await workflowSendAction({
        runId,
        stageId: "stage-a",
        text: "continue now",
        delivery,
      });

      assert.deepEqual(calls, ["prompt:continue now"]);
      assert.deepEqual(result, {
        action: "send",
        runId,
        stageId: "stage-a",
        delivery: "prompt",
        status: "ok",
        message: "Prompt started for stage.",
      });
    });
  }

  test("explicit idle prompt preserves its established response string", async () => {
    const runId = "explicit-idle-prompt";
    const calls: string[] = [];
    liveHandle({ runId, streaming: false, calls });

    const result = await workflowSendAction({
      runId,
      stageId: "stage-a",
      text: "explicit prompt",
      delivery: "prompt",
    });

    assert.deepEqual(calls, ["prompt:explicit prompt"]);
    assert.equal(result.delivery, "prompt");
    assert.equal(result.status, "ok");
    assert.equal(result.message, "Prompt sent to stage.");
  });

  test("ordinary paused resume preserves its established response string", async () => {
    const runId = "ordinary-resume";
    const calls: string[] = [];
    liveHandle({ runId, streaming: false, calls, status: "paused" });

    const result = await workflowSendAction({
      runId,
      stageId: "stage-a",
      text: "resume normally",
      delivery: "resume",
    });

    assert.deepEqual(calls, ["resume:resume normally"]);
    assert.equal(result.delivery, "resume");
    assert.equal(result.status, "ok");
    assert.equal(result.message, "Resumed interrupted stage with message.");
  });

  test("resume against a running stage is a truthful noop", async () => {
    const runId = "running-resume-noop";
    const calls: string[] = [];
    liveHandle({ runId, streaming: false, calls });

    const result = await workflowSendAction({
      runId,
      stageId: "stage-a",
      text: "must not be discarded",
      delivery: "resume",
    });

    assert.deepEqual(calls, []);
    assert.equal(result.delivery, "resume");
    assert.equal(result.status, "noop");
    assert.equal(result.message, "Stage is not paused; no resume message was delivered.");
  });

  test("explicit sends cannot bypass a paused stage", async () => {
    const runId = "paused-follow-up-noop";
    const calls: string[] = [];
    liveHandle({ runId, streaming: false, calls, status: "paused" });

    const result = await workflowSendAction({
      runId,
      stageId: "stage-a",
      text: "must wait for resume",
      delivery: "followUp",
    });

    assert.deepEqual(calls, []);
    assert.equal(result.delivery, "followUp");
    assert.equal(result.status, "noop");
    assert.equal(result.message, "Stage is paused; resume it before sending a new message.");
  });

  test("streaming followUp queues without starting a concurrent prompt", async () => {
    const runId = "streaming-follow-up";
    const calls: string[] = [];
    liveHandle({ runId, streaming: true, calls });

    const result = await workflowSendAction({
      runId,
      stageId: "stage-a",
      text: "after this turn",
      delivery: "followUp",
    });

    assert.deepEqual(calls, ["followUp:after this turn"]);
    assert.equal(result.delivery, "followUp");
    assert.equal(result.message, "Follow-up queued for stage.");
  });

  test("streaming steer steers without starting a concurrent prompt", async () => {
    const runId = "streaming-steer";
    const calls: string[] = [];
    liveHandle({ runId, streaming: true, calls });

    const result = await workflowSendAction({
      runId,
      stageId: "stage-a",
      text: "change direction",
      delivery: "steer",
    });

    assert.deepEqual(calls, ["steer:change direction"]);
    assert.equal(result.delivery, "steer");
    assert.equal(result.message, "Steered live stage.");
  });
});
