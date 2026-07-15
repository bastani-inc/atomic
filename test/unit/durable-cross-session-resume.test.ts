/**
 * Integration test for cross-session durable workflow resume.
 *
 * Simulates the full cross-session resume scenario described in issue #1498:
 * 1. Session A starts a workflow with ctx.tool calls.
 * 2. Session A is interrupted (process exits / crash).
 * 3. Session B creates a new process, discovers the workflow via durable state.
 * 4. Session B resumes, and completed side effects are not repeated.
 *
 * Uses the file-backed durable backend to simulate cross-process persistence
 * without requiring Postgres/DBOS.
 *
 * cross-ref: issue #1498 — "A workflow started in one Atomic session can be
 * resumed by a separate new session."
 */
import { describe, test, beforeEach, afterEach } from "bun:test";
import { Type } from "typebox";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { durableHash } from "../../packages/workflows/src/durable/backend.js";
import { FileDurableBackend } from "../../packages/workflows/src/durable/file-backend.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import { createToolPrimitive, createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { wrapUiWithDurable } from "../../packages/workflows/src/durable/ui-primitive.js";
import type { WorkflowUIContext } from "../../packages/workflows/src/shared/authoring-contract-ui.js";
import { listResumableFromBackend, formatResumableWorkflowList } from "../../packages/workflows/src/durable/resume-catalog.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";

const WORKFLOW_ID = "wf-cross-session-001";

async function openScopedContinuePrompt(ui: WorkflowUIContext): Promise<string> {
  return ui.input("Nested continue?");
}

async function openContinuePrompt(ui: WorkflowUIContext): Promise<string> {
  return ui.input("Continue?");
}

function uiWithInput(input: (prompt: string) => Promise<string>): WorkflowUIContext {
  return {
    input,
    async confirm() { throw new Error("unused confirm"); },
    async select<T extends string>(): Promise<T> { throw new Error("unused select"); },
    async editor() { throw new Error("unused editor"); },
    async custom<T>(): Promise<T> { throw new Error("unused custom"); },
  };
}

describe("Cross-session durable workflow resume (integration)", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cross-session-"));
    stateFile = join(tmpDir, "durable-state.json");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("workflow started in session A is discoverable and resumable in session B", () => {
    // === Session A: start workflow, execute some ctx.tool calls ===
    const backendA = new FileDurableBackend(stateFile);
    backendA.registerWorkflow({
      workflowId: WORKFLOW_ID,
      name: "data-pipeline",
      inputs: { source: "s3://bucket" },
      createdAt: Date.now(),
      status: "running",
    });

    let sideEffectCount = 0;
    const toolArgs = { resource: "dataset-1" };
    const hash = durableHash({ name: "process-data", args: toolArgs, ordinal: 1 });

    // Record checkpoint manually for test simplicity.
    backendA.recordCheckpoint({
      kind: "tool",
      workflowId: WORKFLOW_ID,
      checkpointId: "cp-1",
      name: "process-data",
      argsHash: hash,
      output: "processed-result",
      completedAt: Date.now(),
    });

    // Session A crashes — workflow is left in "running" state.
    // (In production, DBOS recovery or the file backend preserves this.)

    // === Session B: new process discovers the workflow ===
    const backendB = new FileDurableBackend(stateFile);
    const resumable = listResumableFromBackend(backendB);
    assert.equal(resumable.length, 1);
    assert.equal(resumable[0]!.workflowId, WORKFLOW_ID);
    assert.equal(resumable[0]!.name, "data-pipeline");
    assert.equal(resumable[0]!.status, "running");

    // === Session B resumes: completed side effect is NOT repeated ===
    sideEffectCount = 0;
    const toolB = createToolPrimitive({
      workflowId: WORKFLOW_ID,
      backend: backendB,
      nextCheckpointId: createCheckpointIdGenerator(),
      throwIfCancelled: () => {},
    });

    // The same tool call should return cached result without executing.
    // (In a real async test we'd await, but since the backend already has the
    // checkpoint, the tool returns immediately from cache.)
    return toolB("process-data", toolArgs, async () => {
      sideEffectCount++;
      return "SHOULD-NOT-EXECUTE";
    }).then((result) => {
      assert.equal(result, "processed-result");
      assert.equal(sideEffectCount, 0); // side effect was NOT repeated
    });
  });

  test("fresh backend discovers and resumes an unresolved prompt with the original workflow id", async () => {
    const backendA = new FileDurableBackend(stateFile);
    backendA.registerWorkflow({
      workflowId: WORKFLOW_ID,
      name: "prompt-first-workflow",
      inputs: {},
      createdAt: Date.now(),
      status: "running",
      resumable: true,
    });
    const unresolved = Promise.withResolvers<string>();
    const baseA = uiWithInput(() => unresolved.promise);
    const uiA = wrapUiWithDurable(baseA, {
      workflowId: WORKFLOW_ID,
      backend: backendA,
      nextCheckpointId: createCheckpointIdGenerator(),
    });
    void openContinuePrompt(uiA);
    await Promise.resolve();
    assert.equal(backendA.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 1);

    const backendB = new FileDurableBackend(stateFile);
    assert.deepEqual(
      listResumableFromBackend(backendB).map((entry) => entry.workflowId),
      [WORKFLOW_ID],
    );
    const resumedDefinition = workflow({
      name: "prompt-first-workflow",
      description: "",
      inputs: {},
      outputs: { answer: Type.String() },
      run: async (ctx) => ({ answer: await openContinuePrompt(ctx.ui) }),
    });
    const resumedStore = createStore();
    const resumed = resumeDurableWorkflow(WORKFLOW_ID, {
      registry: createRegistry().register(resumedDefinition),
      baseRunOpts: {
        store: resumedStore,
        cancellation: createCancellationRegistry(),
      },
      durableBackend: backendB,
    });
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(resumed.workflowId, WORKFLOW_ID);
    assert.equal(resumed.runId, WORKFLOW_ID);

    const deadline = Date.now() + 1_000;
    let answered = false;
    while (Date.now() < deadline && !answered) {
      const runSnapshot = resumedStore.runs().find((run) => run.id === WORKFLOW_ID);
      const stage = runSnapshot?.stages.find((candidate) => candidate.pendingPrompt !== undefined);
      if (stage?.pendingPrompt !== undefined) {
        answered = resumedStore.resolveStagePendingPrompt(
          WORKFLOW_ID,
          stage.id,
          stage.pendingPrompt.id,
          "resumed-answer",
        );
      } else await Bun.sleep(5);
    }
    assert.equal(answered, true);
    while (Date.now() < deadline) {
      const status = resumedStore.runs().find((run) => run.id === WORKFLOW_ID)?.status;
      if (status === "completed") break;
      await Bun.sleep(5);
    }
    assert.equal(resumedStore.runs().find((run) => run.id === WORKFLOW_ID)?.status, "completed");
    assert.equal(backendB.getWorkflow(WORKFLOW_ID)?.workflowId, WORKFLOW_ID);
    assert.equal(backendB.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 0);
    assert.equal(backendB.getWorkflow(WORKFLOW_ID)?.status, "completed");
    assert.equal(backendB.listCheckpoints(WORKFLOW_ID).length, 1);
  });

  test("fresh scoped child reuses its root prompt reservation", async () => {
    const backendA = new FileDurableBackend(stateFile);
    backendA.registerWorkflow({
      workflowId: WORKFLOW_ID,
      name: "nested-prompt-workflow",
      inputs: {},
      createdAt: 1,
      status: "running",
    });
    const scope = { rootWorkflowId: WORKFLOW_ID, scopePrefix: "workflow:child:1" };
    const scopedA = new ScopedDurableBackend(backendA, scope);
    const firstAnswer = Promise.withResolvers<string>();
    const firstPrompt = wrapUiWithDurable(uiWithInput(() => firstAnswer.promise), {
      workflowId: "child-session-a",
      backend: scopedA,
      nextCheckpointId: createCheckpointIdGenerator(),
    });
    void openScopedContinuePrompt(firstPrompt);
    await Promise.resolve();
    assert.equal(new FileDurableBackend(stateFile).getWorkflow(WORKFLOW_ID)?.pendingPrompts, 1);

    const backendB = new FileDurableBackend(stateFile);
    const scopedB = new ScopedDurableBackend(backendB, scope);
    const resumedAnswer = Promise.withResolvers<string>();
    const resumedPrompt = wrapUiWithDurable(uiWithInput(() => resumedAnswer.promise), {
      workflowId: "child-session-b",
      backend: scopedB,
      nextCheckpointId: createCheckpointIdGenerator(),
    });
    const pending = openScopedContinuePrompt(resumedPrompt);
    await Promise.resolve();
    assert.equal(new FileDurableBackend(stateFile).getWorkflow(WORKFLOW_ID)?.pendingPrompts, 1);
    resumedAnswer.resolve("continued");
    assert.equal(await pending, "continued");
    assert.equal(new FileDurableBackend(stateFile).getWorkflow(WORKFLOW_ID)?.pendingPrompts, 0);
  });

  test("resume after failed stage — workflow is resumable", () => {
    const backend = new FileDurableBackend(stateFile);
    backend.registerWorkflow({
      workflowId: "wf-failed-001",
      name: "failing-workflow",
      inputs: {},
      createdAt: Date.now(),
      status: "running",
    });

    // Complete one stage.
    backend.recordCheckpoint({
      kind: "stage",
      workflowId: "wf-failed-001",
      checkpointId: "cp-1",
      name: "stage-1",
      replayKey: "stage:1",
      output: "stage-1-output",
      completedAt: Date.now(),
    });

    // Mark as failed (e.g. stage 2 failed).
    backend.setWorkflowStatus("wf-failed-001", "failed");

    // The workflow should appear in resumable list.
    const resumable = listResumableFromBackend(backend);
    assert.equal(resumable.length, 1);
    assert.equal(resumable[0]!.status, "failed");

    // On resume, mark as running again.
    backend.setWorkflowStatus("wf-failed-001", "running");
    assert.equal(backend.getWorkflow("wf-failed-001")!.status, "running");
  });

  test("multiple completed stages with later stages pending — resume continues from last checkpoint", () => {
    const backend = new FileDurableBackend(stateFile);
    backend.registerWorkflow({
      workflowId: "wf-multi-001",
      name: "multi-stage",
      inputs: {},
      createdAt: Date.now(),
      status: "running",
    });

    // Complete 3 stages out of 5.
    for (let i = 1; i <= 3; i++) {
      backend.recordCheckpoint({
        kind: "stage",
        workflowId: "wf-multi-001",
        checkpointId: `cp-${i}`,
        name: `stage-${i}`,
        replayKey: `stage:${i}`,
        output: `output-${i}`,
        completedAt: Date.now() + i,
      });
    }

    // All 3 completed stages have cached outputs.
    assert.equal(backend.getStageOutput("wf-multi-001", "stage:1"), "output-1");
    assert.equal(backend.getStageOutput("wf-multi-001", "stage:2"), "output-2");
    assert.equal(backend.getStageOutput("wf-multi-001", "stage:3"), "output-3");
    // Stage 4 has no cached output (pending).
    assert.equal(backend.getStageOutput("wf-multi-001", "stage:4"), undefined);

    assert.equal(backend.getWorkflow("wf-multi-001")!.completedCheckpoints, 3);
  });

  test("cancelled workflow is not in resumable list", () => {
    const backend = new FileDurableBackend(stateFile);
    backend.registerWorkflow({
      workflowId: "wf-cancelled-001",
      name: "cancelled",
      inputs: {},
      createdAt: Date.now(),
      status: "running",
    });
    backend.setWorkflowStatus("wf-cancelled-001", "cancelled");

    const resumable = listResumableFromBackend(backend);
    assert.equal(resumable.length, 0);
  });

  test("formatResumableWorkflowList shows workflow id for /workflow resume selector", () => {
    const backend = new FileDurableBackend(stateFile);
    backend.registerWorkflow({
      workflowId: "wf-selector-001",
      name: "selector-test",
      inputs: {},
      createdAt: Date.now(),
      status: "running",
    });
    backend.recordCheckpoint({
      kind: "tool",
      workflowId: "wf-selector-001",
      checkpointId: "cp-1",
      name: "init",
      argsHash: "h1",
      output: "ok",
      completedAt: Date.now(),
    });

    const resumable = listResumableFromBackend(backend);
    const text = formatResumableWorkflowList(resumable);
    assert.ok(text.includes("wf-selector-001".slice(0, 8)));
    assert.ok(text.includes("selector-test"));
    assert.ok(text.includes("1 checkpoint"));
  });
});
