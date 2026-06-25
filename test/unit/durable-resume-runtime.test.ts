/**
 * Tests for the cross-session durable workflow resume adapter.
 *
 * Verifies /workflow resume selector behavior: resolving durable catalog
 * entries, error paths, and successful re-dispatch with the original workflow
 * id so durable checkpoints replay.
 *
 * cross-ref: issue #1498 — /workflow resume by top-level workflow id.
 */
import { describe, test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import type { WorkflowRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { resolveDurableEntry, resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import type { ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";

function makeEntry(workflowId: string, name: string, status: ResumableWorkflowEntry["status"]): ResumableWorkflowEntry {
  return {
    workflowId,
    name,
    status,
    completedCheckpoints: 1,
    pendingPrompts: 0,
    createdAt: 1000,
    updatedAt: 2000,
  };
}

describe("resolveDurableEntry", () => {
  const catalog: readonly ResumableWorkflowEntry[] = [
    makeEntry("wf-aaa-001", "alpha", "running"),
    makeEntry("wf-bbb-002", "beta", "paused"),
  ];

  test("exact id match", () => {
    const r = resolveDurableEntry("wf-aaa-001", catalog);
    assert.ok(r && !("kind" in r));
    assert.equal(r!.workflowId, "wf-aaa-001");
  });

  test("unique prefix match", () => {
    const r = resolveDurableEntry("wf-aaa", catalog);
    assert.ok(r && !("kind" in r));
    assert.equal(r!.workflowId, "wf-aaa-001");
  });

  test("ambiguous prefix", () => {
    const r = resolveDurableEntry("wf-", catalog);
    assert.ok(r && "kind" in r && r.kind === "ambiguous");
    assert.equal(r.matches.length, 2);
  });

  test("no match returns undefined", () => {
    assert.equal(resolveDurableEntry("wf-zzz", catalog), undefined);
  });
});

describe("resumeDurableWorkflow", () => {
  let backend: InMemoryDurableBackend;
  let store: ReturnType<typeof createStore>;
  let cancellation: ReturnType<typeof createCancellationRegistry>;
  let jobs: ReturnType<typeof createJobTracker>;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    store = createStore();
    cancellation = createCancellationRegistry();
    jobs = createJobTracker();
  });

  function makeDef(): WorkflowDefinition {
    return workflow({
      name: "resumable-pipeline",
      description: "",
      inputs: { topic: Type.String() },
      outputs: { done: Type.Optional(Type.Boolean()) },
      run: async () => ({ done: true }),
    }) as unknown as WorkflowDefinition;
  }

  function makeRegistryWith(def: WorkflowDefinition): WorkflowRegistry {
    return {
      register: () => makeRegistryWith(def),
      merge: () => makeRegistryWith(def),
      get: (name: string) => (name === def.name || name === def.normalizedName ? def : undefined),
      has: (name: string) => name === def.name || name === def.normalizedName,
      remove: () => makeRegistryWith(def),
      names: () => [def.normalizedName],
      all: () => [def],
    };
  }

  function deps() {
    return {
      registry: makeRegistryWith(makeDef()),
      baseRunOpts: { store, cancellation, jobs },
      durableBackend: backend,
    };
  }

  test("returns not_registered when id is unknown", () => {
    const result = resumeDurableWorkflow("wf-does-not-exist", deps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_registered");
  });

  test("returns ambiguous when prefix matches multiple", () => {
    backend.registerWorkflow({ workflowId: "wf-x-1", name: "resumable-pipeline", inputs: { topic: "a" }, createdAt: 1, status: "running" });
    backend.registerWorkflow({ workflowId: "wf-x-2", name: "resumable-pipeline", inputs: { topic: "b" }, createdAt: 1, status: "running" });
    const result = resumeDurableWorkflow("wf-x", deps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_registered");
    assert.match(result.message, /Ambiguous/);
  });

  test("returns not_resumable when status is completed", () => {
    backend.registerWorkflow({ workflowId: "wf-done-1", name: "resumable-pipeline", inputs: { topic: "a" }, createdAt: 1, status: "completed" });
    // Pass an explicit catalog containing the completed entry (the backend's
    // resumable list would filter it out) to exercise the not_resumable branch.
    const catalog = [makeEntry("wf-done-1", "resumable-pipeline", "completed")];
    const result = resumeDurableWorkflow("wf-done-1", deps(), catalog);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_resumable");
  });

  test("returns workflow_not_found when definition is missing", () => {
    backend.registerWorkflow({ workflowId: "wf-ghost-1", name: "missing-workflow", inputs: {}, createdAt: 1, status: "running" });
    const result = resumeDurableWorkflow("wf-ghost-1", deps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, "workflow_not_found");
  });

  test("returns invalid_inputs when cached inputs fail schema validation", () => {
    backend.registerWorkflow({ workflowId: "wf-bad-in-1", name: "resumable-pipeline", inputs: {}, createdAt: 1, status: "running" });
    const result = resumeDurableWorkflow("wf-bad-in-1", deps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_inputs");
  });

  test("successfully re-dispatches with the ORIGINAL workflow id", () => {
    backend.registerWorkflow({ workflowId: "wf-resume-target", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "failed" });
    const result = resumeDurableWorkflow("wf-resume-target", deps());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.workflowId, "wf-resume-target");
      assert.equal(result.runId, "wf-resume-target"); // runId == original workflowId for replay
      assert.match(result.message, /Resuming durable workflow/);
    }
    // Backend status flipped back to running.
    assert.equal(backend.getWorkflow("wf-resume-target")!.status, "running");
  });
});
