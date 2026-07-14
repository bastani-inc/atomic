import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend, type DbosSdkHandle, type DbosStepRecord, type DbosWorkflowInfo } from "../../packages/workflows/src/durable/dbos-backend.js";
import { decodeToCheckpoint } from "../../packages/workflows/src/durable/dbos-envelope.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { FileDurableBackend, WorkflowFileDurableBackend, durableStateFileFor } from "../../packages/workflows/src/durable/file-backend.js";
import { writeDurableFileState } from "../../packages/workflows/src/durable/file-lock.js";
import { scanResumableWorkflows } from "../../packages/workflows/src/durable/resume-catalog.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createDurableResumeRuntime } from "../../packages/workflows/src/extension/runtime-durable-resume.js";
import { resolveWorkflowResumeTarget } from "../../packages/workflows/src/extension/workflow-durable-resume-command.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

function durableRecord(workflowId: string) {
  return {
    handle: {
      workflowId,
      name: "compatible",
      inputs: {},
      createdAt: 1,
      updatedAt: 2,
      status: "paused",
      completedCheckpoints: 1,
      pendingPrompts: 0,
    },
    checkpoints: [{
      kind: "stage",
      workflowId,
      checkpointId: "stage:one",
      name: "one",
      replayKey: "stage:one",
      output: "done",
      completedAt: 2,
    }],
  };
}

interface MockDbosState {
  readonly workflows: Map<string, DbosWorkflowInfo>;
  readonly steps: Map<string, WorkflowSerializableValue>;
  readonly deleteAttempts: string[];
  failDelete: boolean;
}

function dbosMock(): DbosSdkHandle & { readonly state: MockDbosState } {
  const state: MockDbosState = { workflows: new Map(), steps: new Map(), deleteAttempts: [], failDelete: false };
  return {
    state,
    launch: async () => {},
    shutdown: async () => {},
    startWorkflow: async () => {},
    retrieveWorkflow: async (workflowId) => state.workflows.get(workflowId),
    cancelWorkflow: async () => {},
    resumeWorkflow: async () => {},
    listAllWorkflows: async () => [...state.workflows.values()],
    listStepRecords: async (workflowId) => {
      const prefix = `${workflowId}:checkpoint:`;
      const records: DbosStepRecord[] = [];
      for (const [key, output] of state.steps) {
        if (key.startsWith(prefix)) records.push({ stepName: key.slice(prefix.length), output });
      }
      return records;
    },
    recordStepOutput: async (workflowId, stepName, output) => {
      state.steps.set(`${workflowId}:checkpoint:${stepName}`, output);
    },
    deleteWorkflowData: async (workflowId) => {
      state.deleteAttempts.push(workflowId);
      if (state.failDelete) throw new Error("delete unavailable");
      state.workflows.delete(workflowId);
      const prefix = `${workflowId}:checkpoint:`;
      for (const key of state.steps.keys()) if (key.startsWith(prefix)) state.steps.delete(key);
    },
  };
}

function seedMetadata(sdk: ReturnType<typeof dbosMock>, workflowId: string, version: number, ts: number): void {
  sdk.state.workflows.set(workflowId, { workflowId, name: "compatible", status: "PENDING", createdAt: 1, inputs: {} });
  sdk.state.steps.set(`${workflowId}:checkpoint:__atomic_metadata:${ts}:seed`, {
    __atomicDurableMetadata: true,
    version,
    entry: {
      formatVersion: version,
      type: "workflow.durable.checkpoint",
      workflowId,
      name: "compatible",
      inputs: {},
      status: "paused",
      completedCheckpoints: 1,
      pendingPrompts: 0,
      ts,
    },
  });
}

describe("durable file format compatibility", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

  test("deletes exact v1 workflow files while preserving and listing v2", () => {
    dir = mkdtempSync(join(tmpdir(), "durable-formats-"));
    const legacyPath = durableStateFileFor(dir, "legacy");
    const currentPath = durableStateFileFor(dir, "current");
    writeFileSync(legacyPath, JSON.stringify({ version: 1, workflows: [durableRecord("legacy")] }));
    writeFileSync(currentPath, JSON.stringify({ version: 2, workflows: [durableRecord("current")] }));

    const backend = new WorkflowFileDurableBackend(dir);
    assert.deepEqual(backend.listResumableWorkflows().map((entry) => entry.workflowId), ["current"]);
    assert.equal(backend.isWorkflowLoadable("legacy"), false);
    assert.equal(backend.isWorkflowLoadable("current"), true);
    assert.equal(backend.isWorkflowLoadable("missing"), true);
    assert.equal(existsSync(legacyPath), true);
    assert.equal(existsSync(currentPath), true);
    assert.deepEqual(JSON.parse(readFileSync(legacyPath, "utf-8")), {
      version: 2, workflows: [], deletedWorkflowIds: ["legacy"],
    });

    const fresh = new WorkflowFileDurableBackend(dir);
    assert.deepEqual(fresh.listResumableWorkflows().map((entry) => entry.workflowId), ["current"]);
    assert.equal(fresh.isWorkflowLoadable("legacy"), false);
  });

  test("per-id deletion persists atomically and preserves compatible siblings", async () => {
    dir = mkdtempSync(join(tmpdir(), "durable-delete-shared-"));
    const statePath = join(dir, "shared.json");
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      workflows: [durableRecord("delete-me"), durableRecord("keep-me")],
      deletedWorkflowIds: [],
    }));
    const backend = new FileDurableBackend(statePath);
    await backend.deleteWorkflow("delete-me");
    assert.equal(backend.isWorkflowLoadable("delete-me"), false);
    assert.equal(backend.isWorkflowLoadable("keep-me"), true);
    assert.deepEqual(backend.listResumableWorkflows().map((entry) => entry.workflowId), ["keep-me"]);

    const fresh = new FileDurableBackend(statePath);
    assert.equal(fresh.isWorkflowLoadable("delete-me"), false);
    assert.equal(fresh.isWorkflowLoadable("keep-me"), true);
    assert.deepEqual(fresh.listResumableWorkflows().map((entry) => entry.workflowId), ["keep-me"]);
    const stored = JSON.parse(readFileSync(statePath, "utf-8")) as { workflows: Array<{ handle: { workflowId: string } }>; deletedWorkflowIds: string[] };
    assert.deepEqual(stored.workflows.map((record) => record.handle.workflowId), ["keep-me"]);
    assert.deepEqual(stored.deletedWorkflowIds, ["delete-me"]);
  });
  test("converts a shared legacy file into persistent per-id tombstones", () => {
    dir = mkdtempSync(join(tmpdir(), "durable-legacy-shared-"));
    const statePath = join(dir, "shared.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      workflows: [durableRecord("legacy-a"), durableRecord("legacy-b")],
    }));
    const backend = new FileDurableBackend(statePath);
    assert.deepEqual(backend.listResumableWorkflows(), []);
    const fresh = new FileDurableBackend(statePath);
    assert.equal(fresh.isWorkflowLoadable("legacy-a"), false);
    assert.equal(fresh.isWorkflowLoadable("legacy-b"), false);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf-8")).deletedWorkflowIds, ["legacy-a", "legacy-b"]);
  });

  test("a stale file backend cannot revive a concurrently deleted workflow", async () => {
    dir = mkdtempSync(join(tmpdir(), "durable-delete-stale-writer-"));
    const statePath = join(dir, "shared.json");
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      workflows: [durableRecord("victim"), durableRecord("sibling")],
      deletedWorkflowIds: [],
    }));
    const deleting = new FileDurableBackend(statePath);
    const stale = new FileDurableBackend(statePath);
    assert.deepEqual(stale.listResumableWorkflows().map((entry) => entry.workflowId).sort(), ["sibling", "victim"]);
    await deleting.deleteWorkflow("victim");
    stale.recordCheckpoint({
      kind: "stage", workflowId: "sibling", checkpointId: "stage:later", name: "later",
      replayKey: "stage:later", output: "later", completedAt: 3,
    });
    const fresh = new FileDurableBackend(statePath);
    assert.equal(fresh.isWorkflowLoadable("victim"), false);
    assert.deepEqual(fresh.listResumableWorkflows().map((entry) => entry.workflowId), ["sibling"]);
  });


  test("preserves and hides a per-workflow file whose payload IDs do not match its filename", () => {
    dir = mkdtempSync(join(tmpdir(), "durable-id-mismatch-"));
    const path = durableStateFileFor(dir, "expected-id");
    const raw = JSON.stringify({ version: 2, workflows: [durableRecord("other-id")], deletedWorkflowIds: [] });
    writeFileSync(path, raw);
    const backend = new WorkflowFileDurableBackend(dir);
    assert.deepEqual(backend.listResumableWorkflows(), []);
    assert.equal(backend.isWorkflowLoadable("expected-id"), false);
    assert.equal(readFileSync(path, "utf-8"), raw);
  });

  test("retries legacy cleanup after a transient filesystem failure", () => {
    dir = mkdtempSync(join(tmpdir(), "durable-delete-retry-"));
    const path = durableStateFileFor(dir, "legacy-retry");
    writeFileSync(path, JSON.stringify({ version: 1, workflows: [durableRecord("legacy-retry")] }));
    let attempts = 0;
    const backend = new FileDurableBackend(path, "legacy-retry", (filePath, state) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient legacy cleanup failure");
      writeDurableFileState(filePath, state);
    });
    assert.throws(() => backend.listResumableWorkflows(), /transient legacy cleanup failure/);
    assert.deepEqual(backend.listResumableWorkflows(), []);
    assert.equal(backend.isWorkflowLoadable("legacy-retry"), false);
    assert.equal(attempts, 2);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")).deletedWorkflowIds, ["legacy-retry"]);
  });

  test("hides and preserves future and malformed files and refuses to overwrite them", () => {
    dir = mkdtempSync(join(tmpdir(), "durable-unknown-"));
    const futurePath = join(dir, "future.json");
    const malformedPath = join(dir, "malformed.json");
    const structuralPath = join(dir, "structural.json");
    const future = JSON.stringify({ version: 3, workflows: [durableRecord("future")] });
    const malformed = "{not-json";
    const structural = JSON.stringify({ version: 2, workflows: [null] });
    writeFileSync(futurePath, future);
    writeFileSync(malformedPath, malformed);
    writeFileSync(structuralPath, structural);

    const futureBackend = new FileDurableBackend(futurePath);
    const malformedBackend = new FileDurableBackend(malformedPath);
    const structuralBackend = new FileDurableBackend(structuralPath);
    assert.deepEqual(futureBackend.listResumableWorkflows(), []);
    assert.deepEqual(malformedBackend.listResumableWorkflows(), []);
    assert.deepEqual(structuralBackend.listResumableWorkflows(), []);
    assert.equal(futureBackend.isWorkflowLoadable("future"), false);
    assert.equal(malformedBackend.isWorkflowLoadable("bad"), false);
    assert.equal(structuralBackend.isWorkflowLoadable("bad-shape"), false);
    assert.throws(() => futureBackend.registerWorkflow({ workflowId: "future", name: "new", inputs: {}, createdAt: 1, status: "running" }), /Cannot overwrite unknown/);
    assert.throws(() => malformedBackend.registerWorkflow({ workflowId: "bad", name: "new", inputs: {}, createdAt: 1, status: "running" }), /Cannot overwrite unknown/);
    assert.throws(() => structuralBackend.registerWorkflow({ workflowId: "bad-shape", name: "new", inputs: {}, createdAt: 1, status: "running" }), /Cannot overwrite unknown/);
    assert.equal(readFileSync(futurePath, "utf-8"), future);
    assert.equal(readFileSync(malformedPath, "utf-8"), malformed);
    assert.equal(readFileSync(structuralPath, "utf-8"), structural);
  });
});

describe("DBOS durable format compatibility", () => {
  test("deletes v1 rows once and repeated discovery is idempotent", async () => {
    const sdk = dbosMock();
    seedMetadata(sdk, "legacy", 1, 10);
    const backend = new DbosDurableBackend(sdk);

    await backend.hydrateResumableWorkflows();
    assert.deepEqual(backend.listResumableWorkflows(), []);
    assert.deepEqual(sdk.state.deleteAttempts, ["legacy"]);
    assert.equal(sdk.state.workflows.has("legacy"), false);

    await backend.hydrateResumableWorkflows();
    assert.deepEqual(sdk.state.deleteAttempts, ["legacy"]);
  });

  test("suppresses failed legacy deletion and retries on the next discovery", async () => {
    const sdk = dbosMock();
    seedMetadata(sdk, "legacy-failure", 1, 10);
    sdk.state.failDelete = true;
    const backend = new DbosDurableBackend(sdk);

    await backend.hydrateResumableWorkflows();
    assert.deepEqual(backend.listResumableWorkflows(), []);
    assert.equal(backend.getWorkflow("legacy-failure"), undefined);
    assert.equal(backend.isWorkflowLoadable("legacy-failure"), false);
    assert.equal(sdk.state.workflows.has("legacy-failure"), true);

    sdk.state.failDelete = false;
    await backend.hydrateResumableWorkflows();
    assert.deepEqual(sdk.state.deleteAttempts, ["legacy-failure", "legacy-failure"]);
    assert.equal(sdk.state.workflows.has("legacy-failure"), false);
  });

  test("a newer legacy marker removes a previously hydrated mirror", async () => {
    const sdk = dbosMock();
    seedMetadata(sdk, "changed", 2, 10);
    const backend = new DbosDurableBackend(sdk);
    await backend.hydrateResumableWorkflows();
    assert.equal(backend.getWorkflow("changed")?.name, "compatible");

    seedMetadata(sdk, "changed", 1, 20);
    await backend.hydrateResumableWorkflows();
    assert.equal(backend.getWorkflow("changed"), undefined);
    assert.deepEqual(backend.listResumableWorkflows(), []);
    assert.deepEqual(sdk.state.deleteAttempts, ["changed"]);
  });

  test("future and unavailable metadata remain stored but hidden", async () => {
    const sdk = dbosMock();
    seedMetadata(sdk, "future", 3, 10);
    sdk.state.workflows.set("unavailable", { workflowId: "unavailable", name: "unknown", status: "PENDING", createdAt: 1 });
    const backend = new DbosDurableBackend(sdk);

    await backend.hydrateResumableWorkflows();
    assert.deepEqual(backend.listResumableWorkflows(), []);
    assert.equal(backend.isWorkflowLoadable("future"), false);
    assert.equal(backend.isWorkflowLoadable("unavailable"), false);
    assert.deepEqual(sdk.state.deleteAttempts, []);
    assert.equal(sdk.state.workflows.has("future"), true);
    assert.equal(sdk.state.workflows.has("unavailable"), true);
  });

  test("keeps a deletion tombstone loadable across fresh DBOS backends", async () => {
    const sdk = dbosMock();
    seedMetadata(sdk, "legacy-restart", 1, 10);
    await new DbosDurableBackend(sdk).hydrateResumableWorkflows();
    assert.equal(sdk.state.workflows.has("legacy-restart"), false);
    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow("legacy-restart");
    assert.equal(fresh.isWorkflowLoadable("legacy-restart"), false);
    assert.equal([...sdk.state.steps.keys()].some((key) => key.endsWith(":__atomic_deleted")), true);
  });

  test("hides current metadata whose embedded workflow id mismatches the DBOS root", async () => {
    const sdk = dbosMock();
    seedMetadata(sdk, "outer-id", 2, 10);
    const key = [...sdk.state.steps.keys()].find((candidate) => candidate.includes("outer-id:checkpoint:__atomic_metadata"));
    assert.ok(key);
    const envelope = sdk.state.steps.get(key) as Record<string, WorkflowSerializableValue>;
    const entry = envelope["entry"] as Record<string, WorkflowSerializableValue>;
    sdk.state.steps.set(key, { ...envelope, entry: { ...entry, workflowId: "different-id" } });
    const backend = new DbosDurableBackend(sdk);
    await backend.hydrateResumableWorkflows();
    assert.deepEqual(backend.listResumableWorkflows(), []);
    assert.equal(backend.isWorkflowLoadable("outer-id"), false);
    assert.equal(sdk.state.workflows.has("outer-id"), true);
  });

  test("classifies mixed checkpoint formats at the whole-workflow boundary", async () => {
    const legacySdk = dbosMock();
    seedMetadata(legacySdk, "mixed-legacy", 2, 10);
    legacySdk.state.steps.set("mixed-legacy:checkpoint:old", {
      __dbos_checkpoint__: "__dbos_checkpoint__", v: 1, kind: "stage", checkpointId: "old", completedAt: 11,
    });
    await new DbosDurableBackend(legacySdk).hydrateResumableWorkflows();
    assert.equal(legacySdk.state.workflows.has("mixed-legacy"), false);

    for (const [id, output] of [
      ["mixed-future", { __dbos_checkpoint__: "__dbos_checkpoint__", v: 3, kind: "stage", checkpointId: "future", completedAt: 11 }],
      ["mixed-malformed", { __dbos_checkpoint__: "__dbos_checkpoint__", v: 2, kind: "tool", checkpointId: "bad", completedAt: 11 }],
      ["mixed-malformed-stage", { __dbos_checkpoint__: "__dbos_checkpoint__", v: 2, kind: "stage", completedAt: 11 }],
      ["mixed-output-flag", { __dbos_checkpoint__: "__dbos_checkpoint__", v: 2, kind: "stage", checkpointId: "mixed", hasOutput: true, completedAt: 11 }],
      ["mixed-checkpoint-id", { __dbos_checkpoint__: "__dbos_checkpoint__", v: 2, kind: "stage", checkpointId: "different", hasOutput: false, completedAt: 11 }],
      ["mixed-model-attempts", { __dbos_checkpoint__: "__dbos_checkpoint__", v: 2, kind: "stage", checkpointId: "mixed", hasOutput: false, completedAt: 11, modelAttempts: [{}] }],
    ] as const) {
      const sdk = dbosMock();
      seedMetadata(sdk, id, 2, 10);
      sdk.state.steps.set(`${id}:checkpoint:mixed`, output);
      const backend = new DbosDurableBackend(sdk);
      await backend.hydrateResumableWorkflows();
      assert.equal(backend.isWorkflowLoadable(id), false);
      assert.deepEqual(backend.listResumableWorkflows(), []);
      assert.equal(sdk.state.workflows.has(id), true);
      assert.deepEqual(sdk.state.deleteAttempts, []);
    }

    const rawSdk = dbosMock();
    seedMetadata(rawSdk, "mixed-raw", 2, 10);
    rawSdk.state.steps.set("mixed-raw:checkpoint:raw-step", "plain-output");
    const raw = new DbosDurableBackend(rawSdk);
    await raw.hydrateResumableWorkflows();
    assert.equal(raw.isWorkflowLoadable("mixed-raw"), true);
    assert.equal(raw.getStageOutput("mixed-raw", "raw-step"), "plain-output");
  });

  test("serializes deletion behind pending writes and blocks later non-registration writes", async () => {
    const base = dbosMock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sdk = {
      ...base,
      startWorkflow: async (workflowId: string, name: string, inputs: Readonly<Record<string, WorkflowSerializableValue>>) => {
        await gate;
        base.state.workflows.set(workflowId, { workflowId, name, inputs, status: "PENDING", createdAt: 1 });
      },
    } satisfies DbosSdkHandle & { readonly state: MockDbosState };
    const backend = new DbosDurableBackend(sdk);
    backend.registerWorkflow({ workflowId: "delete-race", name: "race", inputs: {}, createdAt: 1, status: "running" });
    const deletion = backend.deleteWorkflow("delete-race");
    backend.recordCheckpoint({
      kind: "stage", workflowId: "delete-race", checkpointId: "after-delete", name: "late", replayKey: "late", output: "late", completedAt: 3,
    });
    release();
    await deletion;
    assert.deepEqual(sdk.state.deleteAttempts, ["delete-race"]);
    assert.equal(sdk.state.workflows.has("delete-race"), false);
    assert.equal([...sdk.state.steps.keys()].some((key) => key.endsWith(":after-delete")), false);
    assert.equal([...sdk.state.steps.keys()].some((key) => key.endsWith(":__atomic_deleted")), true);
  });
});

test("failed DBOS cleanup purges a matching restored run while preserving current live rows", async () => {
  const sdk = dbosMock();
  seedMetadata(sdk, "legacy-restored", 1, 10);
  sdk.state.failDelete = true;
  const backend = new DbosDurableBackend(sdk);
  backend.registerWorkflow({ workflowId: "current-live", name: "current", inputs: {}, createdAt: 2, status: "paused", completedCheckpoints: 1 });
  const restoredStore = createStore();
  restoredStore.recordRunStart({ id: "legacy-restored", name: "legacy", inputs: {}, status: "paused", stages: [], startedAt: 1 });
  restoredStore.recordRunStart({ id: "current-live", name: "current", inputs: {}, status: "paused", stages: [], startedAt: 2 });
  setDurableBackend(backend);
  try {
    const runtime = createDurableResumeRuntime({
      registry: createRegistry(),
      store: restoredStore,
      runtimeCwd: process.cwd(),
      ensureReady: async () => {},
      baseRunOpts: () => ({ store: restoredStore }),
    });
    await runtime.prepareDurableResumable();
    assert.deepEqual(restoredStore.runs().map((run) => run.id), ["current-live"]);
    assert.equal(resolveWorkflowResumeTarget("legacy-restored", restoredStore.runs(), [], []).kind, "not_found");
    assert.equal(resolveWorkflowResumeTarget("current-live", restoredStore.runs(), [], []).kind, "live");
    assert.equal(backend.isWorkflowLoadable("legacy-restored"), false);
    assert.equal(backend.isWorkflowLoadable("current-live"), true);
    assert.equal(sdk.state.workflows.has("legacy-restored"), true);
  } finally {
    setDurableBackend(undefined);
  }
});

test("session cache exposes only exact current v2 entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "durable-cache-formats-"));
  try {
    const base = {
      type: "workflow.durable.checkpoint",
      name: "cache",
      inputs: {},
      status: "paused",
      completedCheckpoints: 1,
      pendingPrompts: 0,
      ts: 1,
    };
    writeFileSync(join(dir, "session.jsonl"), [
      JSON.stringify({ ...base, workflowId: "absent" }),
      JSON.stringify({ ...base, formatVersion: 1, workflowId: "legacy" }),
      JSON.stringify({ ...base, formatVersion: 2, workflowId: "current" }),
      JSON.stringify({ ...base, formatVersion: 3, workflowId: "future" }),
    ].join("\n"));
    assert.deepEqual(scanResumableWorkflows(dir).map((entry) => entry.workflowId), ["current"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-workflow deletion suppresses stale metadata until a current run is registered", async () => {
  const memory = new InMemoryDurableBackend();
  memory.registerWorkflow({ workflowId: "replaceable", name: "old", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
  await memory.deleteWorkflow("replaceable");
  assert.equal(memory.isWorkflowLoadable("replaceable"), false);
  memory.registerWorkflow({ workflowId: "replaceable", name: "current", inputs: {}, createdAt: 2, status: "running" });
  assert.equal(memory.isWorkflowLoadable("replaceable"), true);

  const dir = mkdtempSync(join(tmpdir(), "durable-delete-tombstone-"));
  try {
    const files = new WorkflowFileDurableBackend(dir);
    files.registerWorkflow({ workflowId: "replaceable", name: "old", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    await files.deleteWorkflow("replaceable");
    assert.equal(files.isWorkflowLoadable("replaceable"), false);
    files.registerWorkflow({ workflowId: "replaceable", name: "current", inputs: {}, createdAt: 2, status: "running" });
    assert.equal(files.isWorkflowLoadable("replaceable"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scoped deletion cannot remove root state", async () => {
  const root = new InMemoryDurableBackend();
  root.registerWorkflow({ workflowId: "root", name: "root", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
  assert.equal(root.isWorkflowLoadable("root"), true);
  assert.equal(root.isWorkflowLoadable("missing"), true);
  const scoped = new ScopedDurableBackend(root, { rootWorkflowId: "root", scopePrefix: "workflow:child:1" });
  assert.equal(scoped.isWorkflowLoadable("child"), false);
  await scoped.deleteWorkflow("child");
  assert.equal(root.getWorkflow("root")?.name, "root");
});

test("marked unsupported DBOS envelopes are not reinterpreted as raw legacy checkpoints", () => {
  const future = { __dbos_checkpoint__: "__dbos_checkpoint__", v: 3, kind: "stage", checkpointId: "future", completedAt: 1 };
  assert.equal(decodeToCheckpoint("wf", "future", future), undefined);
  assert.equal(decodeToCheckpoint("wf", "raw", "plain-output")?.kind, "stage");
});
