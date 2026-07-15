import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDurableBackend } from "../../packages/workflows/src/durable/file-backend.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { mockSession, run, runChain, runParallel, runTask, Type, workflow } from "./executor-shared.js";

let tempDir = "";

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "atomic-completed-topology-")); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

function retainedSession(name: string): string {
  const path = join(tempDir, `${name}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: `${name}-session`, timestamp: new Date().toISOString(), cwd: tempDir }),
    JSON.stringify({ type: "message", id: `${name}-message`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: name, timestamp: Date.now() } }),
  ].join("\n") + "\n");
  return path;
}

function agentSessionAdapter(promptCalls: string[]) {
  let sessionIndex = 0;
  return {
    async create() {
      sessionIndex += 1;
      const sessionFile = retainedSession(`stage-${sessionIndex}`);
      return {
        ...mockSession(),
        sessionFile,
        sessionId: `stage-${sessionIndex}-session`,
        async prompt(text: string) { promptCalls.push(text); },
        getLastAssistantText() { return `result-${sessionIndex}`; },
      };
    },
  };
}

function assertLinearTopology(stages: readonly { readonly id: string; readonly name: string; readonly parentIds: readonly string[] }[]): void {
  assert.deepEqual(stages.map((stage) => stage.name), ["alpha", "beta", "gamma"]);
  assert.deepEqual(stages[0]?.parentIds, []);
  assert.deepEqual(stages[1]?.parentIds, [stages[0]?.id]);
  assert.deepEqual(stages[2]?.parentIds, [stages[1]?.id]);
  const ids = new Set(stages.map((stage) => stage.id));
  for (const stage of stages) {
    for (const parentId of stage.parentIds) assert.equal(ids.has(parentId), true);
  }
}
function inspectCompleted(stateFile: string, runId: string): RunSnapshot {
  const reader = new FileDurableBackend(stateFile);
  const store = createStore();
  const opened = openCompletedDurableWorkflow(runId, { durableBackend: reader, store });
  assert.equal(opened.ok, true);
  const snapshot = store.runs()[0];
  assert.ok(snapshot);
  assert.equal(snapshot.status, "completed");
  return snapshot;
}


describe("completed durable topology across a fresh backend/store boundary", () => {
  test("preserves a completed named linear workflow without redispatching or mutating durable state", async () => {
    const stateFile = join(tempDir, "named-linear.json");
    const writer = new FileDurableBackend(stateFile);
    const promptCalls: string[] = [];
    const def = workflow({
      name: "named-linear",
      description: "Exercises completed linear topology reconstruction.",
      inputs: {},
      outputs: { final: Type.String() },
      async run(ctx) {
        await ctx.task("alpha", { prompt: "alpha" });
        await ctx.task("beta", { prompt: "beta" });
        const gamma = await ctx.task("gamma", { prompt: "gamma" });
        return { final: gamma.text };
      },
    });

    const result = await run(def, {}, {
      runId: "named-linear-run",
      store: createStore(),
      durableBackend: writer,
      adapters: { agentSession: agentSessionAdapter(promptCalls) },
    });
    assert.equal(result.status, "completed");
    assert.equal(promptCalls.length, 3);
    const durableBefore = readFileSync(stateFile, "utf8");
    const checkpointCount = writer.listCheckpoints(result.runId).length;

    const reader = new FileDurableBackend(stateFile);
    const inspectionStore = createStore();
    const opened = openCompletedDurableWorkflow(result.runId, {
      durableBackend: reader,
      store: inspectionStore,
      adapters: { agentSession: { async create() { throw new Error("inspection must not create a session"); } } },
    });

    assert.equal(opened.ok, true);
    const inspected = inspectionStore.runs()[0];
    assert.ok(inspected);
    assert.equal(inspected.status, "completed");
    assertLinearTopology(inspected.stages);
    assert.equal(promptCalls.length, 3);
    assert.equal(reader.getWorkflow(result.runId)?.status, "completed");
    assert.equal(reader.listCheckpoints(result.runId).length, checkpointCount);
    assert.equal(readFileSync(stateFile, "utf8"), durableBefore);
  });

  test("preserves direct task, tasks, and chain topology across fresh backends", async () => {
    const taskFile = join(tempDir, "direct-task.json");
    const taskCalls: string[] = [];
    const task = await runTask(
      { name: "only", task: "only" },
      { artifacts: false },
      { runId: "direct-task-run", store: createStore(), durableBackend: new FileDurableBackend(taskFile), adapters: { agentSession: agentSessionAdapter(taskCalls) } },
    );
    assert.equal(task.status, "completed");
    assert.equal(task.runId, "direct-task-run");
    const taskSnapshot = inspectCompleted(taskFile, task.runId);
    assert.deepEqual(taskSnapshot.stages.map((stage) => ({ name: stage.name, parentIds: stage.parentIds, topologyState: stage.topologyState })), [
      { name: "only", parentIds: [], topologyState: undefined },
    ]);
    assert.equal(taskCalls.length, 1);

    const tasksFile = join(tempDir, "direct-tasks.json");
    const tasksCalls: string[] = [];
    const tasks = await runParallel(
      [{ name: "left", task: "left" }, { name: "right", task: "right" }],
      { artifacts: false },
      { runId: "direct-tasks-run", store: createStore(), durableBackend: new FileDurableBackend(tasksFile), adapters: { agentSession: agentSessionAdapter(tasksCalls) } },
    );
    assert.equal(tasks.status, "completed");
    assert.equal(tasks.runId, "direct-tasks-run");
    const tasksSnapshot = inspectCompleted(tasksFile, tasks.runId);
    assert.deepEqual(tasksSnapshot.stages.map((stage) => stage.name).sort(), ["left", "right"]);
    assert.equal(tasksSnapshot.stages.every((stage) => stage.parentIds.length === 0 && stage.topologyState === undefined), true);
    assert.equal(tasksCalls.length, 2);

    const chainFile = join(tempDir, "direct-chain.json");
    const chainCalls: string[] = [];
    const chain = await runChain(
      [
        { name: "alpha", task: "alpha" },
        { name: "beta", task: "beta" },
        { name: "gamma", task: "gamma" },
      ],
      { artifacts: false },
      { runId: "direct-chain-run", store: createStore(), durableBackend: new FileDurableBackend(chainFile), adapters: { agentSession: agentSessionAdapter(chainCalls) } },
    );
    assert.equal(chain.status, "completed");
    assert.equal(chain.runId, "direct-chain-run");
    assertLinearTopology(inspectCompleted(chainFile, chain.runId).stages);
    assert.equal(chainCalls.length, 3);
  });

  test("preserves parallel fan-out and fan-in relationships after restart", async () => {
    const stateFile = join(tempDir, "fan-out-in.json");
    const promptCalls: string[] = [];
    const def = workflow({
      name: "fan-out-in",
      description: "Exercises completed parallel topology reconstruction.",
      inputs: {},
      outputs: { final: Type.String() },
      async run(ctx) {
        await ctx.task("setup", { prompt: "setup" });
        await ctx.parallel([
          { name: "branch-a", prompt: "branch-a" },
          { name: "branch-b", prompt: "branch-b" },
        ]);
        const merge = await ctx.task("merge", { prompt: "merge" });
        return { final: merge.text };
      },
    });
    const result = await run(def, {}, {
      runId: "fan-out-in-run",
      store: createStore(),
      durableBackend: new FileDurableBackend(stateFile),
      adapters: { agentSession: agentSessionAdapter(promptCalls) },
    });
    assert.equal(result.status, "completed");

    const stages = inspectCompleted(stateFile, result.runId).stages;
    const byName = new Map(stages.map((stage) => [stage.name, stage]));
    const setup = byName.get("setup");
    const branchA = byName.get("branch-a");
    const branchB = byName.get("branch-b");
    const merge = byName.get("merge");
    assert.ok(setup && branchA && branchB && merge);
    assert.deepEqual(setup.parentIds, []);
    assert.deepEqual(branchA.parentIds, [setup.id]);
    assert.deepEqual(branchB.parentIds, [setup.id]);
    assert.deepEqual(new Set(merge.parentIds), new Set([branchA.id, branchB.id]));
    assert.equal(promptCalls.length, 4);
  });

  test("marks legacy topology-less checkpoints unavailable instead of inferring false roots", () => {
    const stateFile = join(tempDir, "legacy-topology.json");
    const writer = new FileDurableBackend(stateFile);
    const sessionFile = retainedSession("legacy-stage");
    writer.registerWorkflow({
      workflowId: "legacy-topology-run",
      name: "legacy-topology",
      inputs: {},
      createdAt: 1,
      updatedAt: 4,
      status: "completed",
    });
    for (const [index, name] of ["alpha", "beta", "gamma"].entries()) {
      writer.recordCheckpoint({
        kind: "stage",
        workflowId: "legacy-topology-run",
        checkpointId: `legacy-stage-${index}`,
        name,
        replayKey: `stage:${name}:1`,
        output: name,
        sessionFile,
        completedAt: index + 1,
      });
    }

    const stages = inspectCompleted(stateFile, "legacy-topology-run").stages;
    assert.deepEqual(stages.map((stage) => stage.name), ["alpha", "beta", "gamma"]);
    assert.equal(stages.every((stage) => stage.topologyState === "unavailable"), true);
    assert.equal(stages.every((stage) => stage.parentIds.length === 0), true);
  });

  for (const fixture of [
    { label: "unsupported", topology: { version: 2, stageId: "future-stage", parentIds: [] } },
    { label: "malformed", topology: { version: 1, stageId: "broken-stage", parentIds: "not-an-array" } },
  ] as const) {
    test(`keeps file checkpoints readable when topology is ${fixture.label}`, () => {
      const stateFile = join(tempDir, `${fixture.label}-topology.json`);
      const writer = new FileDurableBackend(stateFile);
      const workflowId = `${fixture.label}-topology-run`;
      writer.registerWorkflow({
        workflowId,
        name: `${fixture.label}-topology`,
        inputs: {},
        createdAt: 1,
        updatedAt: 2,
        status: "completed",
      });
      writer.recordCheckpoint({
        kind: "stage",
        workflowId,
        checkpointId: "stage:inspect:1",
        name: "inspect",
        replayKey: "stage:inspect:1",
        output: "preserved output",
        sessionFile: retainedSession(`${fixture.label}-topology-stage`),
        completedAt: 2,
        topology: { version: 1, stageId: "source-stage", parentIds: [] },
      });
      const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as {
        workflows: Array<{ checkpoints: Array<Record<string, object | string | number>> }>;
      };
      persisted.workflows[0]!.checkpoints[0]!["topology"] = fixture.topology;
      writeFileSync(stateFile, JSON.stringify(persisted));

      const checkpoint = new FileDurableBackend(stateFile).listCheckpoints(workflowId)[0];
      assert.ok(checkpoint?.kind === "stage");
      assert.equal(checkpoint.output, "preserved output");
      assert.equal(checkpoint.topology, undefined);
      const stage = inspectCompleted(stateFile, workflowId).stages[0];
      assert.ok(stage);
      assert.equal(stage.topologyState, "unavailable");
      assert.deepEqual(stage.parentIds, []);
    });
  }

  test("does not claim partial topology when persisted source identities are duplicated", () => {
    const stateFile = join(tempDir, "duplicate-topology.json");
    const writer = new FileDurableBackend(stateFile);
    const sessionFile = retainedSession("duplicate-stage");
    writer.registerWorkflow({
      workflowId: "duplicate-topology-run",
      name: "duplicate-topology",
      inputs: {},
      createdAt: 1,
      updatedAt: 3,
      status: "completed",
    });
    for (const [index, name] of ["alpha", "beta"].entries()) {
      writer.recordCheckpoint({
        kind: "stage",
        workflowId: "duplicate-topology-run",
        checkpointId: `duplicate-stage-${index}`,
        name,
        replayKey: `stage:${name}:1`,
        output: name,
        sessionFile,
        completedAt: index + 1,
        topology: { version: 1, stageId: "duplicate-source", parentIds: [] },
      });
    }

    const stages = inspectCompleted(stateFile, "duplicate-topology-run").stages;
    assert.equal(stages.every((stage) => stage.topologyState === "unavailable"), true);
    assert.equal(stages.every((stage) => stage.parentIds.length === 0), true);
  });
});
