import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { completedWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import type { DurableCheckpoint, DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

function definitions(onCallback: () => void) {
  const child = workflow({
    name: "migration-child", description: "", inputs: {}, outputs: {},
    run: async (ctx) => {
      await ctx.tool("legacy-child-write", {}, async () => { onCallback(); return "cached-value"; });
      return {};
    },
  });
  const parent = workflow({
    name: "migration-root", description: "", inputs: {}, outputs: {},
    run: async (ctx) => { await ctx.workflow(child, { stageName: "child-boundary" }); return {}; },
  });
  return { child, parent };
}

async function legacyCheckpoint(runId: string): Promise<DurableToolCheckpoint> {
  const seed = new InMemoryDurableBackend();
  const { parent } = definitions(() => undefined);
  await run(parent, {}, { runId, store: createStore(), durableBackend: seed });
  const checkpoint = seed.listCheckpoints(runId).find(
    (entry): entry is DurableToolCheckpoint => entry.kind === "tool" && entry.name === "legacy-child-write",
  );
  assert.ok(checkpoint !== undefined);
  return {
    kind: "tool", workflowId: runId, checkpointId: checkpoint.checkpointId,
    name: checkpoint.name, argsHash: checkpoint.argsHash, output: checkpoint.output, completedAt: 1,
  };
}

interface MigrationFailureState { attempts: number; rejectNext: boolean }

class RejectFirstMigrationBackend extends InMemoryDurableBackend {
  constructor(private readonly migration: MigrationFailureState) { super(); }

  override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
    if (checkpoint.kind === "tool" && checkpoint.checkpointId.includes("tool-replay-meta:")) {
      this.migration.attempts += 1;
      if (this.migration.rejectNext) {
        this.migration.rejectNext = false;
        throw new Error("additive migration unavailable");
      }
    }
    await super.recordCheckpointAsync(checkpoint);
  }
}

describe("best-effort legacy child topology migration", () => {
  test("returns cached child output when additive persistence rejects, then retries migration", async () => {
    const runId = "migration-best-effort-root";
    const legacy = await legacyCheckpoint(runId);
    let callbackCalls = 0;
    const { parent } = definitions(() => { callbackCalls += 1; });
    const migration = { attempts: 0, rejectNext: true };
    const backend = new RejectFirstMigrationBackend(migration);
    backend.registerWorkflow({ workflowId: runId, name: parent.name, inputs: {}, createdAt: 1, status: "paused", resumable: true });
    backend.recordCheckpoint(legacy);

    const firstStore = createStore();
    const first = await run(parent, {}, { runId, store: firstStore, durableBackend: backend });
    assert.equal(first.status, "completed");
    assert.equal(callbackCalls, 0);
    assert.equal(migration.attempts, 1);
    assert.equal(backend.listCheckpoints(runId).some((entry) => entry.checkpointId.includes("tool-replay-meta:")), false);
    const childRun = firstStore.runs().find((entry) => entry.parentRunId === runId);
    assert.equal(childRun?.toolNodes?.[0]?.status, "cached");
    assert.equal(expandWorkflowGraph(firstStore.snapshot(), runId).tools[0]?.runId, childRun?.id);
    await backend.flush();

    const retryBackend = new RejectFirstMigrationBackend(migration);
    retryBackend.registerWorkflow({ workflowId: runId, name: parent.name, inputs: {}, createdAt: 1, status: "paused", resumable: true });
    retryBackend.recordCheckpoint(legacy);
    const second = await run(parent, {}, { runId, store: createStore(), durableBackend: retryBackend });
    assert.equal(second.status, "completed");
    assert.equal(callbackCalls, 0);
    assert.equal(migration.attempts, 2);
    assert.equal(retryBackend.listCheckpoints(runId).filter((entry) => entry.checkpointId.includes("tool-replay-meta:")).length, 1);
    const catalogEntry = retryBackend.listCompletedWorkflows().find((entry) => entry.workflowId === runId);
    assert.ok(catalogEntry !== undefined);
    const restored = completedWorkflowRunSnapshots(retryBackend, catalogEntry);
    assert.equal(restored.find((entry) => entry.parentRunId === runId)?.toolNodes?.[0]?.name, "legacy-child-write");
  });

  test("DBOS best-effort rejection updates neither mirror nor fatal flush state", async () => {
    const baseSdk = createMockSdk();
    const persist = baseSdk.recordStepOutput.bind(baseSdk);
    let rejectMigration = false;
    const sdk = {
      ...baseSdk,
      async recordStepOutput(...args: Parameters<typeof baseSdk.recordStepOutput>) {
        const [, stepName] = args;
        if (rejectMigration && stepName.includes("tool-replay-meta:")) throw new Error("dbos additive rejected");
        await persist(...args);
      },
    };
    const backend = new DbosDurableBackend(sdk);
    backend.registerWorkflow({ workflowId: "dbos-best-effort", name: "dbos", inputs: {}, createdAt: 1, status: "running" });
    await backend.flush();
    const checkpoint: DurableToolCheckpoint = {
      kind: "tool", workflowId: "dbos-best-effort", checkpointId: "tool-replay-meta:test",
      name: "legacy", argsHash: "legacy-hash", output: "cached", completedAt: 2,
      topology: { version: 1, nodeId: "tool:legacy", ordinal: 1, order: 1, parentIds: [], endedAt: 2 },
    };

    rejectMigration = true;
    assert.equal(await backend.recordAdditiveCheckpointBestEffort(checkpoint), false);
    assert.equal(backend.getToolCheckpoint("dbos-best-effort", "legacy-hash"), undefined);
    await backend.flush();

    rejectMigration = false;
    assert.equal(await backend.recordAdditiveCheckpointBestEffort(checkpoint), true);
    assert.equal(backend.getToolCheckpoint("dbos-best-effort", "legacy-hash")?.output, "cached");
    await backend.flush();
  });


  test("cancellation during additive migration is not swallowed as a cache hit", async () => {
    class GatedMigrationBackend extends InMemoryDurableBackend {
      readonly started = Promise.withResolvers<void>();
      readonly release = Promise.withResolvers<void>();
      override async recordAdditiveCheckpointBestEffort(): Promise<boolean> {
        this.started.resolve();
        await this.release.promise;
        return false;
      }
    }
    const runId = "migration-cancellation-root";
    const legacy = await legacyCheckpoint(runId);
    let callbackCalls = 0;
    const { parent } = definitions(() => { callbackCalls += 1; });
    const backend = new GatedMigrationBackend();
    backend.registerWorkflow({ workflowId: runId, name: parent.name, inputs: {}, createdAt: 1, status: "paused", resumable: true });
    backend.recordCheckpoint(legacy);
    const controller = new AbortController();
    const store = createStore();
    const pending = run(parent, {}, { runId, store, durableBackend: backend, signal: controller.signal });

    await backend.started.promise;
    controller.abort(new Error("cancel migration replay"));
    backend.release.resolve();
    const result = await pending;
    assert.equal(result.status, "killed");
    assert.equal(callbackCalls, 0);
    assert.equal(store.runs().flatMap((entry) => entry.toolNodes ?? [])[0]?.status, "cancelled");
  });
  test("authoritative fresh checkpoint failures still fail the run", async () => {
    class RejectAuthoritativeBackend extends InMemoryDurableBackend {
      override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
        if (checkpoint.kind === "tool") throw new Error("authoritative write rejected");
        await super.recordCheckpointAsync(checkpoint);
      }
    }
    let callbackCalls = 0;
    const result = await run(workflow({
      name: "authoritative-failure", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.tool("fresh", {}, async () => { callbackCalls += 1; return "done"; }); return {}; },
    }), {}, { store: createStore(), durableBackend: new RejectAuthoritativeBackend() });
    assert.equal(result.status, "failed");
    assert.equal(callbackCalls, 1);
    assert.match(result.error ?? "", /authoritative write rejected/);
    assert.equal(result.toolNodes?.[0]?.status, "failed");
  });

  test("cached checkpoint lookup failures surface before callbacks or migration", async () => {
    class RejectLookupBackend extends InMemoryDurableBackend {
      override getToolCheckpoint(): DurableToolCheckpoint | undefined { throw new Error("lookup rejected"); }
    }
    let callbackCalls = 0;
    const result = await run(workflow({
      name: "lookup-failure", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.tool("lookup", {}, async () => { callbackCalls += 1; return "no"; }); return {}; },
    }), {}, { store: createStore(), durableBackend: new RejectLookupBackend() });
    assert.equal(result.status, "failed");
    assert.equal(callbackCalls, 0);
    assert.match(result.error ?? "", /lookup rejected/);
    assert.deepEqual(result.toolNodes, []);
  });
});
