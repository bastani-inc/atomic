/**
 * Tests for the cross-session durable workflow resume adapter.
 *
 * Verifies /workflow resume selector behavior: resolving durable catalog
 * entries, error paths, and successful re-dispatch with the original workflow
 * id so durable checkpoints replay.
 *
 * cross-ref: issue #1498 — /workflow resume by top-level workflow id.
 */
import { describe, test, beforeEach, afterEach } from "bun:test";
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
import { prepareRuntimeDurableResumable, resolveDurableEntry, resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
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

  test("exact id match", async () => {
    const r = resolveDurableEntry("wf-aaa-001", catalog);
    assert.ok(r && !("kind" in r));
    assert.equal(r!.workflowId, "wf-aaa-001");
  });

  test("unique prefix match", async () => {
    const r = resolveDurableEntry("wf-aaa", catalog);
    assert.ok(r && !("kind" in r));
    assert.equal(r!.workflowId, "wf-aaa-001");
  });

  test("ambiguous prefix", async () => {
    const r = resolveDurableEntry("wf-", catalog);
    assert.ok(r && "kind" in r && r.kind === "ambiguous");
    assert.equal(r.matches.length, 2);
  });

  test("no match returns undefined", async () => {
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

  afterEach(() => {
    setDurableBackend(undefined);
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

  test("returns not_registered when id is unknown", async () => {
    const result = await resumeDurableWorkflow("wf-does-not-exist", deps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_registered");
  });

  test("resolves a unique prefix before exact-id loadability checks", async () => {
    class ExactOnlyLoadableBackend extends InMemoryDurableBackend {
      override isWorkflowLoadable(workflowId: string): boolean {
        return this.getWorkflow(workflowId) !== undefined;
      }
    }
    const exactBackend = new ExactOnlyLoadableBackend();
    exactBackend.registerWorkflow({
      workflowId: "wf-prefix-current",
      name: "resumable-pipeline",
      inputs: { topic: "data" },
      createdAt: 1,
      status: "paused",
      completedCheckpoints: 1,
    });

    const result = await resumeDurableWorkflow("wf-prefix", { ...deps(), durableBackend: exactBackend });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.workflowId, "wf-prefix-current");
  });

  test("returns ambiguous when prefix matches multiple", async () => {
    backend.registerWorkflow({ workflowId: "wf-x-1", name: "resumable-pipeline", inputs: { topic: "a" }, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    backend.registerWorkflow({ workflowId: "wf-x-2", name: "resumable-pipeline", inputs: { topic: "b" }, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    const result = await resumeDurableWorkflow("wf-x", deps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_registered");
    assert.match(result.message, /Ambiguous/);
  });

  test("returns not_resumable when status is completed", async () => {
    backend.registerWorkflow({ workflowId: "wf-done-1", name: "resumable-pipeline", inputs: { topic: "a" }, createdAt: 1, status: "completed" });
    // Pass an explicit catalog containing the completed entry (the backend's
    // resumable list would filter it out) to exercise the not_resumable branch.
    const catalog = [makeEntry("wf-done-1", "resumable-pipeline", "completed")];
    const result = await resumeDurableWorkflow("wf-done-1", deps(), catalog);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_resumable");
  });

  test("rejects when authoritative backend state is ineligible despite stale catalog progress", async () => {
    backend.registerWorkflow({
      workflowId: "wf-zero-progress",
      name: "resumable-pipeline",
      inputs: { topic: "data" },
      createdAt: 1,
      status: "paused",
    });
    const staleCatalog = [makeEntry("wf-zero-progress", "resumable-pipeline", "paused")];

    const result = await resumeDurableWorkflow("wf-zero-progress", deps(), staleCatalog);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_resumable");
    assert.equal(backend.getWorkflow("wf-zero-progress")?.status, "paused");
  });

  test("returns workflow_not_found when definition is missing", async () => {
    backend.registerWorkflow({ workflowId: "wf-ghost-1", name: "missing-workflow", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    const result = await resumeDurableWorkflow("wf-ghost-1", deps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, "workflow_not_found");
  });

  test("rediscovers an on-the-fly project workflow from its persisted invocation cwd", async () => {
    const definition = makeDef();
    const conflicting = workflow({
      name: definition.name, description: "wrong current project", inputs: { topic: Type.String() },
      outputs: { wrong: Type.Boolean() }, run: async () => ({ wrong: true }),
    }) as unknown as WorkflowDefinition;
    backend.registerWorkflow({
      workflowId: "wf-reloaded-project", name: definition.name, inputs: { topic: "fresh" },
      createdAt: 1, status: "paused", completedCheckpoints: 1,
      invocationCwd: "/persisted/project",
    });
    let resolvedCwd: string | undefined;
    const result = await resumeDurableWorkflow("wf-reloaded-project", {
      ...deps(),
      registry: makeRegistryWith(conflicting),
      resolveDefinition: async (name, cwd) => {
        resolvedCwd = cwd;
        return name === definition.name ? definition : undefined;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(resolvedCwd, "/persisted/project");
    await jobs.get("wf-reloaded-project")?.promise;
  });

  test("returns invalid_inputs when cached inputs fail schema validation", async () => {
    backend.registerWorkflow({ workflowId: "wf-bad-in-1", name: "resumable-pipeline", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    const result = await resumeDurableWorkflow("wf-bad-in-1", deps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_inputs");
  });

  test("successfully re-dispatches with the ORIGINAL workflow id", async () => {
    backend.registerWorkflow({ workflowId: "wf-resume-target", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "failed" });
    const result = await resumeDurableWorkflow("wf-resume-target", deps());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.workflowId, "wf-resume-target");
      assert.equal(result.runId, "wf-resume-target"); // runId == original workflowId for replay
      assert.match(result.message, /Resuming durable workflow/);
    }
    // Backend status flipped back to running.
    assert.equal(backend.getWorkflow("wf-resume-target")!.status, "running");
  });



  test("resume succeeds when the backend has durable checkpoint state for the workflow", async () => {
    backend.registerWorkflow({ workflowId: "wf-has-state", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    const result = await resumeDurableWorkflow("wf-has-state", deps());
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.runId, "wf-has-state");
    assert.equal(backend.getWorkflow("wf-has-state")?.status, "running");
  });

  test("resume refuses only when a running handle has an active live run in this session", async () => {
    backend.registerWorkflow({ workflowId: "wf-active", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "running", completedCheckpoints: 1 });
    // No live run → crash recovery: resume is allowed even though the durable
    // handle says `running`.
    let result = await resumeDurableWorkflow("wf-active", deps());
    assert.equal(result.ok, true);

    // With an active live run in this session, resume is refused.
    backend.setWorkflowStatus("wf-active", "running");
    store.recordRunStart({
      id: "wf-active",
      name: "resumable-pipeline",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: 1,
    });
    result = await resumeDurableWorkflow("wf-active", deps());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not_resumable");
      assert.match(result.message, /already running/);
      assert.match(result.message, /\/workflow connect/);
      assert.match(result.message, /\/workflow quit/);
      assert.doesNotMatch(result.message, /\/workflow kill/);
    }
    store.removeRun("wf-active");
  });

  test("running and paused workflows are both resumable at the catalog level", async () => {
    backend.registerWorkflow({ workflowId: "wf-running", name: "resumable-pipeline", inputs: {}, createdAt: 1, status: "running", completedCheckpoints: 1 });
    backend.registerWorkflow({ workflowId: "wf-paused", name: "resumable-pipeline", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    const ids = backend.listResumableWorkflows().map((e) => e.workflowId);
    assert.ok(ids.includes("wf-running"), "running is resumable (crash recovery)");
    assert.ok(ids.includes("wf-paused"));
  });

  test("resume removes stale quit store shadow before reusing workflow id", async () => {
    backend.registerWorkflow({ workflowId: "wf-shadow", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    store.recordRunStart({
      id: "wf-shadow",
      name: "stale-shadow",
      inputs: {},
      status: "paused",
      stages: [],
      startedAt: 1,
      exitReason: "quit",
      resumable: true,
    });

    const result = await resumeDurableWorkflow("wf-shadow", deps());
    assert.equal(result.ok, true);
    const matching = store.runs().filter((run) => run.id === "wf-shadow");
    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.name, "resumable-pipeline");
  });

  test("successful resume result includes runId for overlay connection (issue #1498)", async () => {
    backend.registerWorkflow({ workflowId: "wf-overlay-connect", name: "resumable-pipeline", inputs: { topic: "overlay" }, createdAt: 1, status: "failed" });
    const result = await resumeDurableWorkflow("wf-overlay-connect", deps());
    assert.equal(result.ok, true);
    if (result.ok) {
      // runId is the original workflow id so the overlay connects to the
      // re-dispatched run.
      assert.equal(result.runId, "wf-overlay-connect");
      assert.equal(result.workflowId, "wf-overlay-connect");
    }
  });

  test("prepareRuntimeDurableResumable hydrates fresh persistent backend before resume", async () => {
    class HydratingBackend extends InMemoryDurableBackend {
      override readonly persistent = true;
      hydrated = false;
      async hydrateResumableWorkflows(): Promise<void> {
        this.hydrated = true;
        this.registerWorkflow({ workflowId: "wf-hydrated", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "paused", completedCheckpoints: 1 });
      }
    }
    const hydrating = new HydratingBackend();
    const catalog = await prepareRuntimeDurableResumable(() => hydrating);
    assert.equal(hydrating.hydrated, true);
    assert.equal(catalog.length, 1);
    const result = await resumeDurableWorkflow("wf-hydrated", { ...deps(), durableBackend: hydrating });
    assert.equal(result.ok, true);
  });
});
