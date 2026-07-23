/**
 * Tests for DBOS read-side hydration in a fresh process.
 *
 * Uses the shared mock {@link DbosSdkHandle} from
 * `durable-dbos-backend-helpers.ts` to verify that a fresh backend (empty
 * in-memory mirror) reconstructs full checkpoints from DBOS alone.
 *
 * cross-ref: issue #1498 — DBOS read-side hydration.
 */
import { describe, test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { durableHash } from "../../packages/workflows/src/durable/backend.js";
import type { DurableToolCheckpoint, DurableUiCheckpoint, DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { createMockSdk, seedMockWorkflow, seedMockCheckpoint } from "./durable-dbos-backend-helpers.js";

describe("DbosDurableBackend hydration (fresh process)", () => {
  let sdk: ReturnType<typeof createMockSdk>;

  beforeEach(() => {
    sdk = createMockSdk();
  });

  test("hydrateWorkflow reconstructs tool checkpoints from DBOS envelopes", async () => {
    const hash = durableHash({ name: "fetch", args: { url: "https://api.example.com" } });
    const cp: DurableToolCheckpoint = {
      kind: "tool", workflowId: "wf-h1", checkpointId: "tool:h1", name: "fetch", argsHash: hash, output: { data: 42 }, completedAt: 1000,
    };
    seedMockWorkflow(sdk, { workflowId: "wf-h1", name: "test", status: "PENDING", inputs: { task: "x" } });
    seedMockCheckpoint(sdk, "wf-h1", cp);

    // Fresh backend — no in-memory state.
    const fresh = new DbosDurableBackend(sdk);
    assert.equal(fresh.getToolOutput("wf-h1", hash), undefined);

    await fresh.hydrateWorkflow("wf-h1");
    // Tool checkpoint fully reconstructed with argsHash for replay lookup.
    assert.deepEqual(fresh.getToolOutput("wf-h1", hash), { data: 42 });
    // Verify the checkpoint was reconstructed correctly:
    const toolCp = fresh.listCheckpoints("wf-h1").find((c) => c.kind === "tool") as DurableToolCheckpoint | undefined;
    assert.ok(toolCp !== undefined);
    assert.equal(toolCp.argsHash, hash);
    assert.deepEqual(toolCp.output, { data: 42 });
    assert.equal(toolCp.checkpointId, "tool:h1");
  });

  test("hydrateWorkflow reconstructs UI checkpoints from DBOS envelopes", async () => {
    const cp: DurableUiCheckpoint = {
      kind: "ui", workflowId: "wf-h2", checkpointId: "ui:abc", promptKind: "input", message: "Name?", promptHash: "abc", response: "Alice", completedAt: 2000,
    };
    seedMockWorkflow(sdk, { workflowId: "wf-h2", name: "test", status: "PENDING" });
    seedMockCheckpoint(sdk, "wf-h2", cp);

    const fresh = new DbosDurableBackend(sdk);
    assert.equal(fresh.getUiResponse("wf-h2", "abc"), undefined);
    await fresh.hydrateWorkflow("wf-h2");
    assert.equal(fresh.getUiResponse("wf-h2", "abc"), "Alice");
  });

  test("hydrateWorkflow reconstructs stage checkpoints from DBOS envelopes", async () => {
    const cp: DurableStageCheckpoint = {
      kind: "stage", workflowId: "wf-h3", checkpointId: "stage:r1", name: "build", replayKey: "stage:build:1", output: "done", completedAt: 1400,
      sessionFile: "/tmp/build.jsonl", startedAt: 1000, durationMs: 400,
    };
    seedMockWorkflow(sdk, { workflowId: "wf-h3", name: "test", status: "PENDING" });
    seedMockCheckpoint(sdk, "wf-h3", cp);
    seedMockCheckpoint(sdk, "wf-h3", {
      ...cp, checkpointId: "stage-session:r2", output: undefined, durationMs: 900, completedAt: 1900,
    });

    const fresh = new DbosDurableBackend(sdk);
    assert.equal(fresh.getStageOutput("wf-h3", "stage:build:1"), undefined);
    await fresh.hydrateWorkflow("wf-h3");
    await fresh.hydrateWorkflow("wf-h3");
    assert.equal(fresh.getStageOutput("wf-h3", "stage:build:1"), "done");
    assert.equal(fresh.getStageSession("wf-h3", "stage:build:1")?.durationMs, 900);
    assert.equal(fresh.listCheckpoints("wf-h3").length, 2);
  });

  test("flush then fresh hydrate preserves deep run-aware stage topology", async () => {
    const session1 = new DbosDurableBackend(sdk);
    const workflowId = "wf-hierarchy-roundtrip";
    session1.registerWorkflow({ workflowId, name: "hierarchy-root", inputs: {}, createdAt: 1, status: "running" });
    const rootRun = { runId: workflowId, runName: "hierarchy-root" } as const;
    const childRun = { runId: "child-run", runName: "child", parentRunId: workflowId, parentStageId: "boundary", rootRunId: workflowId } as const;
    const stages = [
      { checkpointId: "root", name: "root", replayKey: "root", stageId: "root", parentIds: [], run: rootRun },
      { checkpointId: "boundary", name: "workflow:child", replayKey: "boundary", stageId: "boundary", parentIds: ["root"], run: rootRun },
      { checkpointId: "left", name: "left", replayKey: "workflow:child:1:left", stageId: "left", parentIds: [], run: childRun },
      { checkpointId: "right", name: "right", replayKey: "workflow:child:1:right", stageId: "right", parentIds: [], run: childRun },
      { checkpointId: "join", name: "join", replayKey: "workflow:child:1:join", stageId: "join", parentIds: ["left", "right"], run: childRun },
    ] as const;
    for (const stage of stages) {
      session1.recordCheckpoint({
        kind: "stage", workflowId, checkpointId: stage.checkpointId, name: stage.name,
        replayKey: stage.replayKey, output: stage.name, completedAt: 100,
        topology: { version: 1, stageId: stage.stageId, parentIds: stage.parentIds, run: stage.run },
      });
    }
    await session1.flush();

    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow(workflowId);
    const hydrated = fresh.listCheckpoints(workflowId).filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage");
    assert.deepEqual(hydrated.map((checkpoint) => checkpoint.topology), stages.map((stage) => ({
      version: 1,
      stageId: stage.stageId,
      parentIds: [...stage.parentIds],
      run: { ...stage.run },
    })));
  });

  test("hydrateWorkflow rejects an unmarked checkpoint payload", async () => {
    seedMockWorkflow(sdk, { workflowId: "wf-unmarked", name: "test", status: "SUCCESS" });
    sdk.state.steps.set("wf-unmarked:checkpoint:plain-step", "plain-output" as WorkflowSerializableValue);

    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow("wf-unmarked");
    assert.equal(fresh.getWorkflow("wf-unmarked"), undefined);
    assert.equal(fresh.isWorkflowLoadable("wf-unmarked"), false);
  });

  test("hydrateResumableWorkflows uses Atomic metadata status instead of DBOS helper completion", async () => {
    const session1 = new DbosDurableBackend(sdk);
    session1.registerWorkflow({ workflowId: "wf-meta", name: "meta", inputs: { x: 1 }, createdAt: 10, status: "running" });
    session1.recordCheckpoint({ kind: "tool", workflowId: "wf-meta", checkpointId: "tool:meta", name: "meta-step", argsHash: "h-meta", output: "ok", completedAt: 11 });
    session1.setWorkflowStatus("wf-meta", "paused");
    await session1.flush();
    const dbosInfo = sdk.state.workflows.get("wf-meta")!;
    sdk.state.workflows.set("wf-meta", { ...dbosInfo, status: "SUCCESS" });

    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateResumableWorkflows();
    const entry = fresh.listResumableWorkflows().find((e) => e.workflowId === "wf-meta");
    assert.ok(entry !== undefined);
    assert.equal(entry.status, "paused");
    assert.deepEqual(entry.inputs, { x: 1 });
  });


  test("hydrateResumableWorkflows discovers all workflows and checkpoints", async () => {
    const hash = durableHash({ name: "t", args: {} });
    seedMockWorkflow(sdk, { workflowId: "wf-a", name: "wf-a", status: "PENDING", inputs: { x: 1 } });
    seedMockWorkflow(sdk, { workflowId: "wf-b", name: "wf-b", status: "PENDING" });
    seedMockCheckpoint(sdk, "wf-a", {
      kind: "tool", workflowId: "wf-a", checkpointId: "tool:1", name: "t", argsHash: hash, output: 1, completedAt: 100,
    });
    seedMockCheckpoint(sdk, "wf-b", {
      kind: "tool", workflowId: "wf-b", checkpointId: "tool:1", name: "t", argsHash: hash, output: 2, completedAt: 200,
    });

    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateResumableWorkflows();
    // Both workflows and their checkpoints are hydrated. (They hydrate as
    // `running` from DBOS PENDING, so they are not in the resumable list until
    // a quit/paused metadata envelope exists; checkpoint discovery is the
    // property under test here.)
    assert.equal(fresh.getToolOutput("wf-a", hash), 1);
    assert.equal(fresh.getToolOutput("wf-b", hash), 2);
    assert.deepEqual(fresh.getWorkflow("wf-a")!.inputs, { x: 1 });
    assert.equal(fresh.listCheckpoints("wf-a").length, 1);
    assert.equal(fresh.listCheckpoints("wf-b").length, 1);
  });

  test("hydration is idempotent (double-hydrate does not duplicate)", async () => {
    const hash = durableHash({ name: "t", args: {} });
    seedMockWorkflow(sdk, { workflowId: "wf-idem", name: "test", status: "PENDING" });
    seedMockCheckpoint(sdk, "wf-idem", {
      kind: "tool", workflowId: "wf-idem", checkpointId: "tool:1", name: "t", argsHash: hash, output: "v", completedAt: 100,
    });

    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow("wf-idem");
    await fresh.hydrateWorkflow("wf-idem");
    assert.equal(fresh.listCheckpoints("wf-idem").length, 1);
  });

  test("full cross-session resume: fresh backend hydrates then replays", async () => {
    const hash = durableHash({ name: "expensive", args: { n: 5 } });
    // Session 1: record a workflow + checkpoint via a backend, simulating a
    // prior process that wrote to DBOS.
    const session1 = new DbosDurableBackend(sdk);
    session1.registerWorkflow({ workflowId: "wf-resume", name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
    session1.recordCheckpoint({
      kind: "tool", workflowId: "wf-resume", checkpointId: `tool:${hash}`, name: "expensive", argsHash: hash, output: "COMPUTED", completedAt: Date.now(),
    });
    await session1.flush();
    // Verify DBOS has the checkpoint and versioned metadata.
    assert.equal([...sdk.state.steps.keys()].filter((k) => k.includes(":checkpoint:__atomic_metadata")).length, 2);
    assert.ok(sdk.state.workflows.has("wf-resume"));

    // Session 2: fresh process — only DBOS state, empty in-memory mirror.
    const session2 = new DbosDurableBackend(sdk);
    assert.equal(session2.getToolOutput("wf-resume", hash), undefined);

    await session2.hydrateWorkflow("wf-resume");
    // Now the fresh process can replay the checkpoint without re-executing.
    assert.equal(session2.getToolOutput("wf-resume", hash), "COMPUTED");
    assert.equal(session2.getWorkflow("wf-resume")!.name, "test");
    assert.equal(session2.listCheckpoints("wf-resume").length, 1);
  });
});
