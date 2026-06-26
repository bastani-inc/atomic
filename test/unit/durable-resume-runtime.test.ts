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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import type { WorkflowRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { InMemoryDurableBackend, type DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { prepareRuntimeDurableResumable, resolveDurableEntry, resumeDurableWorkflow, isBackendTerminal } from "../../packages/workflows/src/durable/resume-runtime.js";
import type { DurableCheckpointEntry, ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";

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
  let tmpDir: string;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    store = createStore();
    cancellation = createCancellationRegistry();
    jobs = createJobTracker();
    tmpDir = mkdtempSync(join(tmpdir(), "durable-resume-"));
  });

  afterEach(() => {
    setDurableBackend(undefined);
    rmSync(tmpDir, { recursive: true, force: true });
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
    backend.registerWorkflow({ workflowId: "wf-x-1", name: "resumable-pipeline", inputs: { topic: "a" }, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    backend.registerWorkflow({ workflowId: "wf-x-2", name: "resumable-pipeline", inputs: { topic: "b" }, createdAt: 1, status: "paused", completedCheckpoints: 1 });
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
    backend.registerWorkflow({ workflowId: "wf-ghost-1", name: "missing-workflow", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    const result = resumeDurableWorkflow("wf-ghost-1", deps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, "workflow_not_found");
  });

  test("returns invalid_inputs when cached inputs fail schema validation", () => {
    backend.registerWorkflow({ workflowId: "wf-bad-in-1", name: "resumable-pipeline", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
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

  test("scan-only resume entries are hidden from prepared selector catalog", async () => {
    const entry = {
      type: "workflow.durable.checkpoint",
      workflowId: "wf-scan-only",
      name: "resumable-pipeline",
      inputs: { topic: "from-session" },
      status: "running" as const,
      completedCheckpoints: 2,
      pendingPrompts: 0,
      ts: Date.now(),
    };
    writeFileSync(join(tmpDir, "session.jsonl"), JSON.stringify({ type: "custom", customType: "workflow.durable.checkpoint", data: entry }) + "\n");

    const prepared = await prepareRuntimeDurableResumable(() => backend, () => tmpDir);
    assert.equal(prepared.length, 0);
    assert.equal(backend.getWorkflow("wf-scan-only"), undefined);

    const result = resumeDurableWorkflow("wf-scan-only", deps(), [{
      workflowId: "wf-scan-only",
      name: "resumable-pipeline",
      inputs: { topic: "from-session" },
      status: "running",
      completedCheckpoints: 2,
      pendingPrompts: 0,
      createdAt: entry.ts,
      updatedAt: entry.ts,
    }]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "stale");
      assert.match(result.message, /session-cache metadata/);
    }
    assert.equal(backend.getWorkflow("wf-scan-only"), undefined);
  });

  test("resume succeeds when the backend has durable checkpoint state for the workflow", () => {
    backend.registerWorkflow({ workflowId: "wf-has-state", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    const result = resumeDurableWorkflow("wf-has-state", deps());
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.runId, "wf-has-state");
    assert.equal(backend.getWorkflow("wf-has-state")?.status, "running");
  });

  test("resume refuses only when a running handle has an active live run in this session", () => {
    backend.registerWorkflow({ workflowId: "wf-active", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "running", completedCheckpoints: 1 });
    // No live run → crash recovery: resume is allowed even though the durable
    // handle says `running`.
    let result = resumeDurableWorkflow("wf-active", deps());
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
    result = resumeDurableWorkflow("wf-active", deps());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not_resumable");
      assert.match(result.message, /already running/);
      assert.match(result.message, /\/workflow connect/);
      assert.match(result.message, /\/workflow kill/);
    }
    store.removeRun("wf-active");
  });

  test("running and paused workflows are both resumable at the catalog level", () => {
    backend.registerWorkflow({ workflowId: "wf-running", name: "resumable-pipeline", inputs: {}, createdAt: 1, status: "running", completedCheckpoints: 1 });
    backend.registerWorkflow({ workflowId: "wf-paused", name: "resumable-pipeline", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    const ids = backend.listResumableWorkflows().map((e) => e.workflowId);
    assert.ok(ids.includes("wf-running"), "running is resumable (crash recovery)");
    assert.ok(ids.includes("wf-paused"));
  });

  test("resume removes stale quit store shadow before reusing workflow id", () => {
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

    const result = resumeDurableWorkflow("wf-shadow", deps());
    assert.equal(result.ok, true);
    const matching = store.runs().filter((run) => run.id === "wf-shadow");
    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.name, "resumable-pipeline");
  });

  test("successful resume result includes runId for overlay connection (issue #1498)", () => {
    backend.registerWorkflow({ workflowId: "wf-overlay-connect", name: "resumable-pipeline", inputs: { topic: "overlay" }, createdAt: 1, status: "failed" });
    const result = resumeDurableWorkflow("wf-overlay-connect", deps());
    assert.equal(result.ok, true);
    if (result.ok) {
      // runId is the original workflow id so the overlay connects to the
      // re-dispatched run.
      assert.equal(result.runId, "wf-overlay-connect");
      assert.equal(result.workflowId, "wf-overlay-connect");
    }
  });

  test("prepareRuntimeDurableResumable hydrates fresh persistent backend before resume", async () => {
    class HydratingBackend implements DurableWorkflowBackend {
      readonly persistent = true;
      private readonly mem = new InMemoryDurableBackend();
      hydrated = false;
      registerWorkflow = this.mem.registerWorkflow.bind(this.mem);
      recordCheckpoint = this.mem.recordCheckpoint.bind(this.mem);
      getToolOutput = this.mem.getToolOutput.bind(this.mem);
      getUiResponse = this.mem.getUiResponse.bind(this.mem);
      getStageOutput = this.mem.getStageOutput.bind(this.mem);
      getStageSession = this.mem.getStageSession.bind(this.mem);
      listCheckpoints = this.mem.listCheckpoints.bind(this.mem);
      getWorkflow = this.mem.getWorkflow.bind(this.mem);
      setWorkflowStatus = this.mem.setWorkflowStatus.bind(this.mem);
      listResumableWorkflows = this.mem.listResumableWorkflows.bind(this.mem);
      toCacheEntry = this.mem.toCacheEntry.bind(this.mem) as (workflowId: string) => DurableCheckpointEntry | undefined;
      reset = this.mem.reset.bind(this.mem);
      async hydrateResumableWorkflows(): Promise<void> {
        this.hydrated = true;
        this.mem.registerWorkflow({ workflowId: "wf-hydrated", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "paused", completedCheckpoints: 1 });
      }
    }
    const hydrating = new HydratingBackend();
    const catalog = await prepareRuntimeDurableResumable(() => hydrating, () => undefined);
    assert.equal(hydrating.hydrated, true);
    assert.equal(catalog.length, 1);
    const result = resumeDurableWorkflow("wf-hydrated", { ...deps(), durableBackend: hydrating });
    assert.equal(result.ok, true);
  });
});

describe("terminal cache suppression (issue #1498)", () => {
  let backend: InMemoryDurableBackend;
  let tmpDir: string;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
  });
  afterEach(() => {
    setDurableBackend(undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSessionCacheEntry(workflowId: string, name: string, status: string): void {
    const entry = {
      type: "workflow.durable.checkpoint",
      workflowId,
      name,
      inputs: { topic: "data" },
      status,
      completedCheckpoints: 1,
      pendingPrompts: 0,
      ts: Date.now(),
    };
    writeFileSync(join(tmpDir, "session.jsonl"), JSON.stringify({ type: "custom", customType: "workflow.durable.checkpoint", data: entry }) + "\n", { flag: "a" });
  }

  test("stale session-cache entry is suppressed when backend marks workflow completed", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "terminal-cache-"));
    // Backend knows the workflow is completed (terminal).
    backend.registerWorkflow({ workflowId: "wf-completed-terminal", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "completed" });
    // Session cache still has a stale "running" entry for the same workflow.
    writeSessionCacheEntry("wf-completed-terminal", "resumable-pipeline", "running");

    const catalog = await prepareRuntimeDurableResumable(() => backend, () => tmpDir);
    // The stale entry must NOT appear: backend terminal status wins.
    assert.equal(catalog.length, 0);
  });

  test("stale session-cache entry is suppressed when backend marks workflow cancelled", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "terminal-cancel-"));
    backend.registerWorkflow({ workflowId: "wf-cancelled-terminal", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "cancelled" });
    writeSessionCacheEntry("wf-cancelled-terminal", "resumable-pipeline", "running");

    const catalog = await prepareRuntimeDurableResumable(() => backend, () => tmpDir);
    assert.equal(catalog.length, 0);
  });

  test("stale session-cache entry is suppressed when backend marks workflow failed-non-resumable", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "terminal-failed-"));
    backend.registerWorkflow({ workflowId: "wf-failed-terminal", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "failed", resumable: false });
    writeSessionCacheEntry("wf-failed-terminal", "resumable-pipeline", "running");

    const catalog = await prepareRuntimeDurableResumable(() => backend, () => tmpDir);
    assert.equal(catalog.length, 0);
  });

  test("non-terminal backend status does NOT suppress session-cache entries", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "non-terminal-"));
    // Backend has the workflow as "failed" but resumable (not terminal).
    backend.registerWorkflow({ workflowId: "wf-failed-resumable", name: "resumable-pipeline", inputs: { topic: "data" }, createdAt: 1, status: "failed", resumable: true });
    writeSessionCacheEntry("wf-failed-resumable", "resumable-pipeline", "running");

    const catalog = await prepareRuntimeDurableResumable(() => backend, () => tmpDir);
    // The backend's own resumable list already includes it (failed+resumable).
    assert.ok(catalog.length >= 1);
    assert.ok(catalog.some((e) => e.workflowId === "wf-failed-resumable"));
  });

  test("isBackendTerminal returns true for completed/cancelled/non-resumable-failed", () => {
    const b = new InMemoryDurableBackend();
    b.registerWorkflow({ workflowId: "w1", name: "n", inputs: {}, createdAt: 1, status: "completed" });
    b.registerWorkflow({ workflowId: "w2", name: "n", inputs: {}, createdAt: 1, status: "cancelled" });
    b.registerWorkflow({ workflowId: "w3", name: "n", inputs: {}, createdAt: 1, status: "failed", resumable: false });
    b.registerWorkflow({ workflowId: "w4", name: "n", inputs: {}, createdAt: 1, status: "failed", resumable: true });
    b.registerWorkflow({ workflowId: "w5", name: "n", inputs: {}, createdAt: 1, status: "running" });
    assert.equal(isBackendTerminal(b, "w1"), true);
    assert.equal(isBackendTerminal(b, "w2"), true);
    assert.equal(isBackendTerminal(b, "w3"), true);
    assert.equal(isBackendTerminal(b, "w4"), false);
    assert.equal(isBackendTerminal(b, "w5"), false);
    assert.equal(isBackendTerminal(b, "w-unknown"), false);
  });
});
