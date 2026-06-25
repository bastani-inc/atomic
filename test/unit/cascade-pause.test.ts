import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";

function stage(id: string, parentIds: readonly string[], status: StageSnapshot["status"] = "pending"): StageSnapshot {
  return { id, name: id, parentIds, status, toolEvents: [] };
}

describe("cascade pause", () => {
  test("linear DAG (A→B→C): pausing A blocks B and C; resuming A unblocks both in order", () => {
    const store = createStore();
    const runId = "linear";
    store.recordRunStart({ id: runId, name: "linear", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    for (const s of [stage("A", [], "running"), stage("B", ["A"]), stage("C", ["B"])]) store.recordStageStart(runId, s);

    assert.equal(store.recordStagePaused(runId, "A"), true);
    assert.equal(store.recordStageBlocked(runId, "B", "A"), true);
    assert.equal(store.recordStageBlocked(runId, "C", "A"), true);

    let stages = store.snapshot().runs[0]!.stages;
    assert.equal(stages.find((s) => s.id === "B")?.status, "blocked");
    assert.equal(stages.find((s) => s.id === "C")?.status, "blocked");

    assert.equal(store.recordStageResumed(runId, "A"), true);
    assert.equal(store.recordStageUnblocked(runId, "B"), true);
    assert.equal(store.recordStageUnblocked(runId, "C"), true);

    stages = store.snapshot().runs[0]!.stages;
    assert.equal(stages.find((s) => s.id === "B")?.status, "pending");
    assert.equal(stages.find((s) => s.id === "C")?.status, "pending");
  });

  test("diamond fan-in (A,B → C): pausing A leaves C blocked until A resumes", () => {
    const store = createStore();
    const runId = "diamond";
    store.recordRunStart({ id: runId, name: "diamond", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    for (const s of [stage("A", [], "running"), stage("B", [], "running"), stage("C", ["A", "B"])]) store.recordStageStart(runId, s);

    assert.equal(store.recordStagePaused(runId, "A"), true);
    assert.equal(store.recordStageEnd(runId, { ...stage("B", [], "completed"), startedAt: Date.now(), endedAt: Date.now() }), undefined);
    assert.equal(store.recordStageBlocked(runId, "C", "A"), true);
    assert.equal(store.snapshot().runs[0]!.stages.find((s) => s.id === "C")?.status, "blocked");

    assert.equal(store.recordStageResumed(runId, "A"), true);
    assert.equal(store.recordStageUnblocked(runId, "C"), true);
    assert.equal(store.snapshot().runs[0]!.stages.find((s) => s.id === "C")?.status, "pending");
  });

  test("parallel siblings (A→[B,C]): pausing B leaves C running; pausing A blocks both B and C", () => {
    const store = createStore();
    const runId = "siblings";
    store.recordRunStart({ id: runId, name: "siblings", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    for (const s of [stage("A", [], "running"), stage("B", ["A"], "running"), stage("C", ["A"], "running")]) store.recordStageStart(runId, s);

    assert.equal(store.recordStagePaused(runId, "B"), true);
    assert.equal(store.snapshot().runs[0]!.stages.find((s) => s.id === "C")?.status, "running");

    assert.equal(store.recordStageResumed(runId, "B"), true);
    assert.equal(store.recordStagePaused(runId, "A"), true);
    assert.equal(store.recordStageBlocked(runId, "B", "A"), true);
    assert.equal(store.recordStageBlocked(runId, "C", "A"), true);

    const stages = store.snapshot().runs[0]!.stages;
    assert.equal(stages.find((s) => s.id === "B")?.status, "blocked");
    assert.equal(stages.find((s) => s.id === "C")?.status, "blocked");
  });

  test("notice emission: setModel records a model notice with from=prev and to=haiku", async () => {
    const store = createStore();
    const fakeSession = {
      sessionId: "session",
      sessionFile: "session.jsonl",
      isStreaming: false,
      messages: [],
      model: "sonnet",
      thinkingLevel: "medium",
      agent: {},
      async prompt() {},
      async steer() {},
      async followUp() {},
      subscribe() { return () => {}; },
      async setModel(model: string) { this.model = model; },
      setThinkingLevel(level: string) { this.thinkingLevel = level; },
      async cycleModel() { this.model = "opus"; return undefined; },
      cycleThinkingLevel() { this.thinkingLevel = "high"; return undefined; },
      async navigateTree() { return { cancelled: false }; },
      async compact() { return { summary: "", firstKeptEntryId: "", tokensBefore: 12300, tokensAfter: 1100 }; },
      abortCompaction() {},
      async abort() {},
      dispose() {},
      getLastAssistantText() { return undefined; },
    };
    const def = workflow({
      name: "notice",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("A").setModel("haiku" as never);
        return {};
      },
    });

    await run(def, {}, { store, adapters: { agentSession: { create: async () => fakeSession as never } } });

    const notice = store.snapshot().runs[0]!.stages[0]!.notices?.[0];
    assert.equal(notice?.kind, "model");
    assert.equal(notice?.from, "sonnet");
    assert.equal(notice?.to, "haiku");
  });

  test("kill/abort during cascade rejects barriers without leaving stages blocked forever", () => {
    const store = createStore();
    const runId = "kill";
    store.recordRunStart({ id: runId, name: "kill", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    store.recordStageStart(runId, stage("A", [], "paused"));
    store.recordStageStart(runId, stage("B", ["A"]));
    assert.equal(store.recordStageBlocked(runId, "B", "A"), true);

    assert.equal(store.recordStageUnblocked(runId, "B"), true);
    assert.equal(store.recordRunEnd(runId, "killed", undefined, "aborted"), true);

    const blocked = store.snapshot().runs[0]!.stages.filter((s) => s.status === "blocked");
    assert.deepEqual(blocked, []);
  });
});
