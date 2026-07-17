/**
 * Problem A regression suite: the workflow durable catalog must NOT invoke the
 * full directory scanner after a known register/checkpoint/status/prompt/delete
 * write, must repair only journaled dirty ids after a crash, and must absorb
 * out-of-band changes via asynchronous coalesced reconciliation (never on the
 * synchronous picker path).
 *
 * cross-ref: `.atomic/tmp/perf-investigation/persistent-resume-index-contract.md`
 * Problem A §1-§7 and `workflow-generation-design.md`.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileDurableBackend,
  WorkflowFileDurableBackend,
  durableStateFileFor,
} from "../../packages/workflows/src/durable/file-backend.js";
import { FileDurableCatalog, type FileCatalogSource } from "../../packages/workflows/src/durable/file-catalog.js";

let durableDir = "";

beforeEach(() => {
  durableDir = mkdtempSync(join(tmpdir(), "atomic-durable-nonrebuild-"));
});

afterEach(() => {
  rmSync(durableDir, { recursive: true, force: true });
});

function registerPaused(backend: WorkflowFileDurableBackend, workflowId: string, createdAt = 1): void {
  backend.registerWorkflow({ workflowId, name: `flow-${workflowId}`, inputs: {}, createdAt, status: "running" });
  backend.recordCheckpoint({
    kind: "tool",
    workflowId,
    checkpointId: "tool:1",
    name: "seed",
    argsHash: `hash-${workflowId}`,
    output: "done",
    completedAt: createdAt + 1,
  });
  backend.setWorkflowStatus(workflowId, "paused");
}

function writePausedState(workflowId: string, createdAt: number): void {
  writeFileSync(durableStateFileFor(durableDir, workflowId), JSON.stringify({
    version: 2,
    workflows: [{
      handle: {
        workflowId,
        name: `flow-${workflowId}`,
        inputs: {},
        createdAt,
        updatedAt: createdAt + 1,
        status: "paused",
        completedCheckpoints: 1,
        pendingPrompts: 0,
      },
      checkpoints: [{
        kind: "tool",
        workflowId,
        checkpointId: "tool:1",
        name: "seed",
        argsHash: `hash-${workflowId}`,
        output: "done",
        completedAt: createdAt + 1,
      }],
    }],
    deletedWorkflowIds: [],
  }));
}

/**
 * Wrap the backend's private full-directory scanners with a call counter so a
 * test can assert the picker / known-write path invokes them zero times.
 */
interface ScanSpyTarget {
  scanCatalog: () => Promise<readonly FileCatalogSource[]>;
  scanCatalogSync: () => readonly FileCatalogSource[];
}

function spyOnScans(backend: WorkflowFileDurableBackend): () => number {
  let scans = 0;
  const target = backend as unknown as ScanSpyTarget;
  const originalAsync = target.scanCatalog.bind(target);
  const originalSync = target.scanCatalogSync.bind(target);
  target.scanCatalog = () => { scans += 1; return originalAsync(); };
  target.scanCatalogSync = () => { scans += 1; return originalSync(); };
  return () => scans;
}

function dirtyRunCount(dir: string): number {
  const db = new Database(join(dir, ".catalog", "workflow-catalog.sqlite"));
  try {
    return db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM dirty_runs").get()?.count ?? -1;
  } finally {
    db.close();
  }
}

function syntheticSource(
  dir: string,
  workflowId: string,
  status: "paused" | "failed",
  createdAt: number,
): FileCatalogSource {
  return {
    record: {
      handle: {
        workflowId,
        name: `flow-${workflowId}`,
        inputs: {},
        createdAt,
        updatedAt: createdAt + 1,
        status,
        completedCheckpoints: 1,
        pendingPrompts: 0,
        ...(status === "failed" ? { resumable: true } : {}),
      },
      checkpoints: [{
        kind: "tool",
        workflowId,
        checkpointId: "tool:1",
        name: "seed",
        argsHash: `hash-${workflowId}`,
        output: "done",
        completedAt: createdAt + 1,
      }],
    },
    stateFile: durableStateFileFor(dir, workflowId),
    stateMtimeMs: createdAt,
    stateSize: 128,
    completedOpenable: false,
  };
}

describe("durable workflow catalog non-rebuild after known writes", () => {
  test("serves indexed rows after a known mutation without invoking the scanner", async () => {
    const backend = new WorkflowFileDurableBackend(durableDir);
    for (let index = 0; index < 20; index += 1) registerPaused(backend, `known-${index}`, index + 1);
    await backend.prepareWorkflowCatalog();

    const scans = spyOnScans(backend);
    backend.setWorkflowStatus("known-5", "failed", 0, true);
    const listed = backend.listResumableWorkflows();

    assert.equal(scans(), 0, "known-write list path must not invoke the directory scanner");
    assert.equal(listed.find((entry) => entry.workflowId === "known-5")?.status, "failed");
    await backend.reconcileWorkflowCatalog();
  });

  test("repairs only journaled dirty ids after a crash without a directory scan", async () => {
    const backend = new WorkflowFileDurableBackend(durableDir);
    registerPaused(backend, "clean", 1);
    registerPaused(backend, "crashed", 2);
    await backend.prepareWorkflowCatalog();

    // Crash between markDirty and sync: the authoritative state file advances to
    // "failed" but the catalog row is left stale with the id journaled dirty.
    const direct = new FileDurableBackend(durableStateFileFor(durableDir, "crashed"), "crashed");
    direct.setWorkflowStatus("crashed", "failed", 0, true);
    const db = new Database(join(durableDir, ".catalog", "workflow-catalog.sqlite"));
    db.run("INSERT OR REPLACE INTO dirty_runs (workflow_id) VALUES ('crashed')");
    db.close();

    const reader = new WorkflowFileDurableBackend(durableDir);
    const scans = spyOnScans(reader);
    const listed = reader.listResumableWorkflows();

    assert.equal(scans(), 0, "dirty crash repair must be targeted, not a directory scan");
    assert.equal(listed.find((entry) => entry.workflowId === "crashed")?.status, "failed");
    assert.equal(dirtyRunCount(durableDir), 0);
    await reader.reconcileWorkflowCatalog();
  });

  test("background reconcile absorbs out-of-band additions and deletions", async () => {
    const backend = new WorkflowFileDurableBackend(durableDir);
    registerPaused(backend, "stays", 1);
    registerPaused(backend, "vanishes", 2);
    await backend.prepareWorkflowCatalog();

    // Out-of-band directory changes the catalog did not perform.
    rmSync(durableStateFileFor(durableDir, "vanishes"));
    writePausedState("appears", 3);

    const reconciled = await backend.reconcileWorkflowCatalog();
    assert.deepEqual(reconciled.resumable.map((entry) => entry.workflowId).sort(), ["appears", "stays"]);

    // Reconcile advanced the signature, so a follow-up reconcile is a no-op
    // (no scan): the drift hint was resolved, not merely observed.
    const scans = spyOnScans(backend);
    await backend.reconcileWorkflowCatalog();
    assert.equal(scans(), 0);
  });

  test("coalesces a burst of drift observations into at most one background scan", async () => {
    const backend = new WorkflowFileDurableBackend(durableDir);
    for (let index = 0; index < 5; index += 1) registerPaused(backend, `burst-${index}`, index + 1);
    await backend.prepareWorkflowCatalog();

    const scans = spyOnScans(backend);
    for (let index = 0; index < 5; index += 1) {
      backend.setWorkflowStatus(`burst-${index}`, "failed", 0, true);
      backend.listResumableWorkflows();
    }
    assert.equal(scans(), 0, "no scan runs synchronously inside the write/list burst");

    await backend.reconcileWorkflowCatalog();
    assert.ok(scans() <= 1, `expected <=1 coalesced background scan, saw ${scans()}`);
  });

  test("serves 100k indexed rows after a known write without invoking the scanner", async () => {
    const catalog = new FileDurableCatalog(durableDir);
    const total = 100_000;
    let scans = 0;
    const statuses = new Map<string, "paused" | "failed">();
    for (let index = 0; index < total; index += 1) statuses.set(`wf-${index}`, "paused");
    const build = (): readonly FileCatalogSource[] =>
      Array.from(statuses, ([id, status], index) => syntheticSource(durableDir, id, status, index + 1));
    const asyncBuild = async (): Promise<readonly FileCatalogSource[]> => { scans += 1; return build(); };

    await catalog.prepare(asyncBuild);
    assert.equal(scans, 1, "cold build performs exactly one scan");

    // Known write: mark dirty + sync the mutated row (mimicking register/status),
    // then bump the durable-directory mtime so the reconcile signature is
    // genuinely stale — the adversarial drift the old mtime gate rebuilt on.
    statuses.set("wf-42", "failed");
    catalog.markDirty("wf-42");
    catalog.sync(syntheticSource(durableDir, "wf-42", "failed", 43));
    writeFileSync(join(durableDir, `dir-touch-${Date.now()}`), "x");

    const start = performance.now();
    const listed = catalog.list(() => { scans += 1; return []; });
    const elapsedMs = performance.now() - start;

    assert.equal(scans, 1, "known-write list path must invoke the scanner zero times");
    assert.equal(listed.resumable.length, total);
    assert.equal(listed.resumable.find((entry) => entry.workflowId === "wf-42")?.status, "failed");
    assert.ok(elapsedMs < 1000, `warm 100k list should be sub-second, took ${elapsedMs.toFixed(1)}ms`);

    // Drain the coalesced background reconcile so no scan dangles into teardown.
    await catalog.whenReconciled(asyncBuild);
  }, 120_000);
});
