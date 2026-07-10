/**
 * Tests for the DBOS-backed durable backend adapter and DBOS read-side hydration.
 *
 * Since the real DBOS SDK requires Postgres, these tests use a mock
 * {@link DbosSdkHandle} that simulates DBOS persistence. The mock stores
 * checkpoint envelopes so hydration tests can verify that a fresh process
 * (empty in-memory mirror) reconstructs full checkpoints from DBOS alone.
 *
 * cross-ref: issue #1498 — DBOS read-side hydration.
 */
import { describe, test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { DbosDurableBackend, isDbosConfigured, type DbosSdkHandle, type DbosWorkflowInfo, type DbosStepRecord } from "../../packages/workflows/src/durable/dbos-backend.js";
import { InMemoryDurableBackend, durableHash } from "../../packages/workflows/src/durable/backend.js";
import { encodeCheckpoint, decodeToCheckpoint, isCheckpointEnvelope, type DbosCheckpointEnvelope } from "../../packages/workflows/src/durable/dbos-envelope.js";
import type { DurableCheckpoint, DurableToolCheckpoint, DurableUiCheckpoint, DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

// ---------------------------------------------------------------------------
// Mock SDK that simulates DBOS persistence
// ---------------------------------------------------------------------------

interface MockDbosState {
  readonly workflows: Map<string, DbosWorkflowInfo>;
  /** stepName → envelope/output for each checkpoint workflow. */
  readonly steps: Map<string, WorkflowSerializableValue>;
  readonly starts: { workflowId: string; name: string }[];
  readonly cancels: string[];
  readonly resumes: string[];
}

function createMockSdk(): DbosSdkHandle & { state: MockDbosState } {
  const state: MockDbosState = {
    workflows: new Map(),
    steps: new Map(),
    starts: [],
    cancels: [],
    resumes: [],
  };
  return {
    state,
    async launch() {},
    async shutdown() {},
    async startWorkflow(workflowId, name) {
      state.starts.push({ workflowId, name });
      // Simulate DBOS registering the workflow so it shows up in listAllWorkflows.
      if (!state.workflows.has(workflowId)) {
        state.workflows.set(workflowId, { workflowId, name, status: "PENDING", createdAt: Date.now() });
      }
    },
    async retrieveWorkflow(workflowId) { return state.workflows.get(workflowId); },
    async cancelWorkflow(workflowId) { state.cancels.push(workflowId); },
    async resumeWorkflow(workflowId) { state.resumes.push(workflowId); },
    async listAllWorkflows() { return [...state.workflows.values()]; },
    async listStepRecords(workflowId) {
      const prefix = `${workflowId}:checkpoint:`;
      const records: DbosStepRecord[] = [];
      for (const [key, output] of state.steps) {
        if (key.startsWith(prefix)) {
          records.push({ stepName: key.slice(prefix.length), output });
        }
      }
      return records;
    },
    async recordStepOutput(workflowId, stepName, output) {
      state.steps.set(`${workflowId}:checkpoint:${stepName}`, output);
    },
  };
}

function seedMockWorkflow(sdk: ReturnType<typeof createMockSdk>, info: Partial<DbosWorkflowInfo> & { workflowId: string }): void {
  sdk.state.workflows.set(info.workflowId, {
    workflowId: info.workflowId,
    name: info.name ?? "test-workflow",
    status: info.status ?? "PENDING",
    createdAt: info.createdAt ?? Date.now(),
    ...(info.inputs !== undefined ? { inputs: info.inputs } : {}),
  });
}

function seedMockCheckpoint(sdk: ReturnType<typeof createMockSdk>, workflowId: string, cp: DurableCheckpoint): void {
  const envelope = encodeCheckpoint(cp);
  sdk.state.steps.set(`${workflowId}:checkpoint:${cp.checkpointId}`, envelope);
}

// ---------------------------------------------------------------------------
// DBOS adapter delegation tests (existing behavior)
// ---------------------------------------------------------------------------

describe("DbosDurableBackend (mock SDK)", () => {
  let sdk: ReturnType<typeof createMockSdk>;
  let backend: DbosDurableBackend;

  beforeEach(() => {
    sdk = createMockSdk();
    backend = new DbosDurableBackend(sdk);
  });

  test("registerWorkflow delegates to DBOS startWorkflow", async () => {
    backend.registerWorkflow({
      workflowId: "wf-dbos-1",
      name: "dbos-workflow",
      inputs: { task: "analyze" },
      createdAt: Date.now(),
      status: "running",
    });
    await backend.flush();
    assert.equal(sdk.state.starts.length, 1);
    assert.equal(sdk.state.starts[0]!.workflowId, "wf-dbos-1");
    assert.equal(sdk.state.starts[0]!.name, "dbos-workflow");
    assert.equal(backend.getWorkflow("wf-dbos-1")!.name, "dbos-workflow");
  });

  test("recordCheckpoint stores envelope in DBOS", async () => {
    backend.registerWorkflow({ workflowId: "wf-2", name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
    const hash = durableHash({ name: "fetch", args: {} });
    const cp: DurableToolCheckpoint = {
      kind: "tool", workflowId: "wf-2", checkpointId: "cp-1", name: "fetch-data", argsHash: hash, output: "result", completedAt: Date.now(),
    };
    backend.recordCheckpoint(cp);
    await backend.flush();
    assert.equal([...sdk.state.steps.keys()].filter((k) => k.includes(":checkpoint:__atomic_metadata")).length, 2);
    const stored = sdk.state.steps.get("wf-2:checkpoint:cp-1");
    assert.ok(isCheckpointEnvelope(stored));
    const env = stored as DbosCheckpointEnvelope;
    assert.equal(env.kind, "tool");
    assert.equal(env.argsHash, hash);
    assert.equal(env.output, "result");
  });

  test("stage checkpoint envelope round-trips hydration metadata", () => {
    const usage = { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.25 } };
    const cp: DurableStageCheckpoint = {
      kind: "stage", workflowId: "wf-stage-meta", checkpointId: "stage:review:1", name: "review",
      replayKey: "stage:review:1", output: { verdict: "pass" }, completedAt: 3000,
      startedAt: 1000, endedAt: 3000, durationMs: 2000, result: "review passed",
      sessionId: "sid", sessionFile: "/tmp/review.jsonl", model: "gpt-test", fastMode: true,
      attemptedModels: ["gpt-test"], modelAttempts: [{ model: "gpt-test", success: true }],
      usage,
      usageComplete: false,
    };

    const env = encodeCheckpoint(cp);
    assert.equal(env.startedAt, 1000);
    assert.equal(env.durationMs, 2000);
    assert.equal(env.result, "review passed");
    assert.deepEqual(env.attemptedModels, ["gpt-test"]);
    assert.deepEqual(env.usage, usage);
    assert.equal(env.usageComplete, false);

    const decoded = decodeToCheckpoint("wf-stage-meta", "stage:review:1", env);
    assert.ok(decoded?.kind === "stage");
    assert.equal(decoded.startedAt, 1000);
    assert.equal(decoded.endedAt, 3000);
    assert.equal(decoded.durationMs, 2000);
    assert.equal(decoded.result, "review passed");
    assert.equal(decoded.model, "gpt-test");
    assert.equal(decoded.fastMode, true);
    assert.deepEqual(decoded.attemptedModels, ["gpt-test"]);
    assert.equal(decoded.modelAttempts?.[0]?.success, true);
    assert.deepEqual(decoded.usage, usage);
    assert.equal(decoded.usageComplete, false);
  });

  test("flush waits for queued async checkpoint writes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedSdk = createMockSdk();
    let persisted = false;
    const baseRecord = delayedSdk.recordStepOutput;
    const slowSdk: DbosSdkHandle = {
      ...delayedSdk,
      async recordStepOutput(workflowId, stepName, output) {
        await gate;
        await baseRecord(workflowId, stepName, output);
        if (stepName === "cp-delayed") persisted = true;
      },
    };
    const slowBackend = new DbosDurableBackend(slowSdk);
    slowBackend.registerWorkflow({ workflowId: "wf-delay", name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
    const hash = durableHash({ name: "fetch", args: {} });
    slowBackend.recordCheckpoint({ kind: "tool", workflowId: "wf-delay", checkpointId: "cp-delayed", name: "fetch", argsHash: hash, output: "result", completedAt: Date.now() });
    const flushed = slowBackend.flush().then(() => "flushed");
    await Promise.resolve();
    assert.equal(persisted, false);
    release();
    assert.equal(await flushed, "flushed");
    assert.equal(persisted, true);
  });

  test("flush propagates queued async checkpoint write failures", async () => {
    const failingSdk: DbosSdkHandle = {
      ...sdk,
      async recordStepOutput() { throw new Error("dbos write failed"); },
    };
    const failingBackend = new DbosDurableBackend(failingSdk);
    failingBackend.registerWorkflow({ workflowId: "wf-fail-write", name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
    const hash = durableHash({ name: "fetch", args: {} });
    failingBackend.recordCheckpoint({ kind: "tool", workflowId: "wf-fail-write", checkpointId: "cp-fail", name: "fetch", argsHash: hash, output: "result", completedAt: Date.now() });
    await assert.rejects(() => failingBackend.flush(), /dbos write failed/);
  });

  test("recordCheckpointAsync does not update replay mirror before DBOS accepts", async () => {
    const hash = durableHash({ name: "fetch", args: {}, ordinal: 1 });
    const failingBackend = new DbosDurableBackend({
      ...sdk,
      async recordStepOutput() { throw new Error("dbos write failed"); },
    });
    failingBackend.registerWorkflow({ workflowId: "wf-async-fail", name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
    await assert.rejects(() => failingBackend.recordCheckpointAsync!({
      kind: "tool", workflowId: "wf-async-fail", checkpointId: `tool:${hash}`, name: "fetch", argsHash: hash, output: "result", completedAt: Date.now(),
    }), /dbos write failed/);
    assert.equal(failingBackend.getToolOutput("wf-async-fail", hash), undefined);
  });

  test("cancelWorkflow delegates to DBOS cancelWorkflow", async () => {
    backend.registerWorkflow({ workflowId: "wf-3", name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
    backend.setWorkflowStatus("wf-3", "cancelled");
    await backend.flush();
    assert.equal(sdk.state.cancels.length, 1);
    assert.equal(sdk.state.cancels[0], "wf-3");
    assert.equal(backend.getWorkflow("wf-3")!.status, "cancelled");
  });

  test("resume sets running status and delegates to DBOS resumeWorkflow", async () => {
    backend.registerWorkflow({ workflowId: "wf-4", name: "test", inputs: {}, createdAt: Date.now(), status: "paused" });
    backend.setWorkflowStatus("wf-4", "running");
    await backend.flush();
    assert.equal(sdk.state.resumes.length, 1);
    assert.equal(sdk.state.resumes[0], "wf-4");
    assert.equal(backend.getWorkflow("wf-4")!.status, "running");
  });

  test("versioned metadata hydrates latest mutable status and checkpoint count", async () => {
    backend.registerWorkflow({ workflowId: "wf-meta-update", name: "test", inputs: {}, createdAt: 1, status: "running" });
    await backend.flush();
    await new Promise((resolve) => setTimeout(resolve, 1));
    const hash = durableHash({ name: "tool", args: {}, ordinal: 1 });
    await backend.recordCheckpointAsync({ kind: "tool", workflowId: "wf-meta-update", checkpointId: `tool:${hash}`, name: "tool", argsHash: hash, output: "done", completedAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 1));
    backend.setWorkflowStatus("wf-meta-update", "failed");
    await backend.flush();

    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow("wf-meta-update");
    const handle = fresh.getWorkflow("wf-meta-update")!;
    assert.equal(handle.status, "failed");
    assert.equal(handle.completedCheckpoints, 1);
  });

  test("getToolOutput reads from in-memory mirror", () => {
    backend.registerWorkflow({ workflowId: "wf-5", name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
    const hash = durableHash({ name: "compute", args: { x: 1 } });
    backend.recordCheckpoint({
      kind: "tool", workflowId: "wf-5", checkpointId: "cp-1", name: "compute", argsHash: hash, output: 42, completedAt: Date.now(),
    });
    assert.equal(backend.getToolOutput("wf-5", hash), 42);
  });
});

// ---------------------------------------------------------------------------
// DBOS read-side hydration tests
// ---------------------------------------------------------------------------

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
      kind: "stage", workflowId: "wf-h3", checkpointId: "stage:r1", name: "build", replayKey: "stage:build:1", output: "done", completedAt: 3000,
    };
    seedMockWorkflow(sdk, { workflowId: "wf-h3", name: "test", status: "PENDING" });
    seedMockCheckpoint(sdk, "wf-h3", cp);

    const fresh = new DbosDurableBackend(sdk);
    assert.equal(fresh.getStageOutput("wf-h3", "stage:build:1"), undefined);
    await fresh.hydrateWorkflow("wf-h3");
    assert.equal(fresh.getStageOutput("wf-h3", "stage:build:1"), "done");
  });

  test("hydrateWorkflow handles legacy/simple payloads gracefully", async () => {
    // Simulate an old DBOS record with a plain output value (no envelope).
    seedMockWorkflow(sdk, { workflowId: "wf-legacy", name: "test", status: "SUCCESS" });
    sdk.state.steps.set("wf-legacy:checkpoint:legacy-step", "plain-output" as WorkflowSerializableValue);

    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow("wf-legacy");
    // Legacy payload becomes a generic stage checkpoint keyed by stepName.
    assert.equal(fresh.getStageOutput("wf-legacy", "legacy-step"), "plain-output");
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

// ---------------------------------------------------------------------------
// Envelope encode/decode tests
// ---------------------------------------------------------------------------

describe("DBOS checkpoint envelope", () => {
  test("encodeCheckpoint produces a valid envelope for tool", () => {
    const cp: DurableToolCheckpoint = {
      kind: "tool", workflowId: "w", checkpointId: "cp1", name: "n", argsHash: "h1", output: 42, completedAt: 100,
    };
    const env = encodeCheckpoint(cp);
    assert.ok(isCheckpointEnvelope(env));
    assert.equal(env.kind, "tool");
    assert.equal(env.argsHash, "h1");
    assert.equal(env.output, 42);
  });

  test("encodeCheckpoint produces a valid envelope for ui", () => {
    const cp: DurableUiCheckpoint = {
      kind: "ui", workflowId: "w", checkpointId: "cp2", promptKind: "input", message: "?", promptHash: "h2", response: "A", completedAt: 200,
    };
    const env = encodeCheckpoint(cp);
    assert.equal(env.kind, "ui");
    assert.equal(env.promptHash, "h2");
    assert.equal(env.promptKind, "input");
  });

  test("encode → decode round-trip preserves all fields", () => {
    const cp: DurableStageCheckpoint = {
      kind: "stage", workflowId: "w", checkpointId: "cp3", name: "build", replayKey: "stage:build:1", output: "ok", completedAt: 300,
    };
    const env = encodeCheckpoint(cp);
    const decoded = decodeToCheckpoint("w", "stage:build:1", env);
    assert.ok(decoded !== undefined);
    assert.equal(decoded!.kind, "stage");
    const s = decoded as DurableStageCheckpoint;
    assert.equal(s.replayKey, "stage:build:1");
    assert.equal(s.output, "ok");
    assert.equal(s.checkpointId, "cp3");
  });

  test("isCheckpointEnvelope rejects plain values", () => {
    assert.equal(isCheckpointEnvelope("hello"), false);
    assert.equal(isCheckpointEnvelope(42), false);
    assert.equal(isCheckpointEnvelope({ foo: 1 }), false);
    assert.equal(isCheckpointEnvelope(null), false);
  });
});

// ---------------------------------------------------------------------------
// isDbosConfigured + export/import (existing)
// ---------------------------------------------------------------------------

describe("isDbosConfigured", () => {
  test("returns false when DBOS_SYSTEM_DATABASE_URL is not set", () => {
    const saved = process.env.DBOS_SYSTEM_DATABASE_URL;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    assert.equal(isDbosConfigured(), false);
    if (saved) process.env.DBOS_SYSTEM_DATABASE_URL = saved;
  });

  test("returns true when DBOS_SYSTEM_DATABASE_URL is set", () => {
    const saved = process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.DBOS_SYSTEM_DATABASE_URL = "postgresql://localhost/test";
    assert.equal(isDbosConfigured(), true);
    if (saved) process.env.DBOS_SYSTEM_DATABASE_URL = saved;
    else delete process.env.DBOS_SYSTEM_DATABASE_URL;
  });
});

describe("InMemoryDurableBackend export/import round-trip", () => {
  test("exportAll + importAll preserves all checkpoints", () => {
    const src = new InMemoryDurableBackend();
    src.registerWorkflow({ workflowId: "wf-exp", name: "export-test", inputs: { a: 1 }, createdAt: Date.now(), status: "running" });
    const hash = durableHash({ name: "t", args: {} });
    src.recordCheckpoint({ kind: "tool", workflowId: "wf-exp", checkpointId: "cp-1", name: "t", argsHash: hash, output: "val", completedAt: Date.now() });

    const dst = new InMemoryDurableBackend();
    dst.importAll(src.exportAll());
    assert.equal(dst.getToolOutput("wf-exp", hash), "val");
    assert.equal(dst.getWorkflow("wf-exp")!.completedCheckpoints, 1);
  });
});
