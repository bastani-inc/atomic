import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { InMemoryDurableBackend, type DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend, type DbosSdkHandle, type DbosStepRecord, type DbosWorkflowInfo } from "../../packages/workflows/src/durable/dbos-backend.js";
import { FileDurableBackend } from "../../packages/workflows/src/durable/file-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { transitionDurableWorkflowStatus } from "../../packages/workflows/src/durable/workflow-status-transition.js";
import type { PromptReservationToken } from "../../packages/workflows/src/durable/prompt-reservation-state.js";
import { classifyDurableResumeShadow } from "../../packages/workflows/src/extension/workflow-resume-shadow.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { markDurableResumed } from "../../packages/workflows/src/runs/background/durable-resume-transition.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

interface ReservationApi {
  pendingPromptToken(workflowId: string, reservationId: string): PromptReservationToken | undefined;
  reservePendingPrompt(workflowId: string, reservationId: string): PromptReservationToken;
  releasePendingPrompt(workflowId: string, reservationId: string, token: PromptReservationToken): void;
}

interface MockDbos extends DbosSdkHandle {
  readonly workflows: Map<string, DbosWorkflowInfo>;
  readonly steps: Map<string, WorkflowSerializableValue>;
  beforeListReturn?: () => Promise<void>;
}

function mockDbos(): MockDbos {
  const workflows = new Map<string, DbosWorkflowInfo>();
  const steps = new Map<string, WorkflowSerializableValue>();
  const result: MockDbos = {
    workflows,
    steps,
    async launch() {},
    async shutdown() {},
    async startWorkflow(workflowId, name, inputs) {
      if (!workflows.has(workflowId)) workflows.set(workflowId, { workflowId, name, inputs, status: "PENDING", createdAt: 1 });
    },
    async retrieveWorkflow(workflowId) { return workflows.get(workflowId); },
    async cancelWorkflow() {},
    async resumeWorkflow() {},
    async listAllWorkflows() { return [...workflows.values()]; },
    async listStepRecords(workflowId) {
      const prefix = `${workflowId}:`;
      const snapshot = [...steps]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, output]): DbosStepRecord => ({ stepName: key.slice(prefix.length), output }));
      const hook = result.beforeListReturn;
      result.beforeListReturn = undefined;
      if (hook !== undefined) await hook();
      return snapshot;
    },
    async recordStepOutput(workflowId, stepName, output) { steps.set(`${workflowId}:${stepName}`, output); },
    async deleteWorkflowData(workflowId) { workflows.delete(workflowId); },
  };
  return result;
}

function reservationApi(backend: DbosDurableBackend): ReservationApi {
  return backend as DbosDurableBackend & ReservationApi;
}

function registration(workflowId: string, pendingPrompts?: number) {
  return {
    workflowId,
    name: workflowId,
    inputs: {},
    createdAt: 1,
    status: "running" as const,
    ...(pendingPrompts !== undefined ? { pendingPrompts } : {}),
  };
}

let tempDirs: string[] = [];
afterEach(() => {
  setDurableBackend(undefined);
  tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  tempDirs = [];
});

function stateFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, "state.json");
}

function shadowStore(runId: string) {
  const store = createStore();
  store.recordRunStart({ id: runId, name: runId, inputs: {}, status: "running", stages: [], startedAt: 1 });
  return store;
}

describe("post-commit authoritative durable state", () => {
  test("shadow classification observes pending prompts changing from one to zero on its first call", () => {
    const file = stateFile("shadow-one-zero-");
    const writer = new FileDurableBackend(file);
    writer.registerWorkflow(registration("race", 1));
    const stale = new FileDurableBackend(file);
    assert.equal(stale.getWorkflow("race")?.pendingPrompts, 1);
    writer.setWorkflowStatus("race", "running", 0, true);
    const store = shadowStore("race");
    const before = structuredClone(store.runs()[0]);

    const classification = classifyDurableResumeShadow(store.runs()[0]!, store, {
      backend: stale,
      jobs: createJobTracker(),
      stageControls: createStageControlRegistry(),
    });

    assert.equal(classification, "ineligible");
    assert.deepEqual(store.runs()[0], before, "stale progress must not mutate local metadata");
    assert.equal(stale.getWorkflow("race")?.pendingPrompts, 0);
  });

  test("shadow classification observes pending prompts changing from zero to one on its first call", () => {
    const file = stateFile("shadow-zero-one-");
    const writer = new FileDurableBackend(file);
    writer.registerWorkflow({ ...registration("race", 0), status: "paused" });
    const stale = new FileDurableBackend(file);
    assert.equal(stale.getWorkflow("race")?.pendingPrompts, 0);
    writer.setWorkflowStatus("race", "paused", 1, true);
    const store = shadowStore("race");

    const classification = classifyDurableResumeShadow(store.runs()[0]!, store, {
      backend: stale,
      jobs: createJobTracker(),
      stageControls: createStageControlRegistry(),
    });

    assert.equal(classification, "eligible");
    assert.equal(store.runs()[0]?.status, "paused");
    assert.equal(store.runs()[0]?.exitReason, "quit");
    assert.equal(stale.getWorkflow("race")?.pendingPrompts, 1);
  });

  test("a stale paused backend cannot resume over a concurrently completed durable handle", async () => {
    const file = stateFile("resume-terminal-race-");
    const local = new FileDurableBackend(file);
    local.registerWorkflow({ ...registration("race"), status: "paused", completedCheckpoints: 1, resumable: true });
    assert.equal(local.getWorkflow("race")?.status, "paused");
    const remote = new FileDurableBackend(file);
    remote.setWorkflowStatus("race", "completed", 0, false);
    setDurableBackend(local);

    const transition = await markDurableResumed("race");

    assert.equal(transition, "refused");
    assert.equal(new FileDurableBackend(file).getWorkflow("race")?.status, "completed");
  });

  test("DBOS terminal metadata wins the exact stale transition interleave", async () => {
    const sdk = mockDbos();
    const seed = new DbosDurableBackend(sdk);
    seed.registerWorkflow({ ...registration("dbos-exact-interleave"), status: "paused", completedCheckpoints: 1, resumable: true });
    await seed.flush();
    const local = new DbosDurableBackend(sdk);
    await local.hydrateWorkflow("dbos-exact-interleave");
    const remote = new DbosDurableBackend(sdk);
    await remote.hydrateWorkflow("dbos-exact-interleave");
    setDurableBackend(local);
    sdk.beforeListReturn = async () => {
      remote.setWorkflowStatus("dbos-exact-interleave", "completed", 0, false);
      await remote.flush();
      await Bun.sleep(3);
    };

    const outcome = await markDurableResumed("dbos-exact-interleave");
    await local.flush();
    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow("dbos-exact-interleave");
    const metadataWrites = [...sdk.steps]
      .filter(([key]) => key.includes("__atomic_metadata"))
      .map(([, output]) => JSON.stringify(output));

    assert.match(metadataWrites.at(-1) ?? "", /"status":"running"/,
      "the stale transition must append its newer running metadata before reconciliation");
    assert.equal(outcome, "refused");
    assert.equal(local.getWorkflow("dbos-exact-interleave")?.status, "completed");
    assert.equal(fresh.getWorkflow("dbos-exact-interleave")?.status, "completed");
  });

  test("custom backends without an atomic transition primitive refuse safely", async () => {
    const mem = new InMemoryDurableBackend();
    mem.registerWorkflow({ ...registration("custom-no-cas"), status: "paused" });
    const custom = new Proxy(mem, {
      get(target, property) {
        if (property === "transitionWorkflowStatus") return undefined;
        const value = Reflect.get(target, property, target) as object | undefined;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DurableWorkflowBackend;

    assert.equal(await transitionDurableWorkflowStatus(custom, "custom-no-cas", ["paused"], "running"), false);
    assert.equal(mem.getWorkflow("custom-no-cas")?.status, "paused");
  });

  test("built-in File backend retains atomic paused-to-running transitions", async () => {
    const file = stateFile("file-transition-preservation-");
    const backend = new FileDurableBackend(file);
    backend.registerWorkflow({ ...registration("file-transition"), status: "paused", resumable: true });

    assert.equal(await transitionDurableWorkflowStatus(backend, "file-transition", ["paused"], "running"), true);
    assert.equal(new FileDurableBackend(file).getWorkflow("file-transition")?.status, "running");
  });

  test("a hydrated DBOS reader also refuses a concurrently terminal resume transition", async () => {
    const sdk = mockDbos();
    const seed = new DbosDurableBackend(sdk);
    seed.registerWorkflow({ ...registration("dbos-terminal-race"), status: "paused", completedCheckpoints: 1, resumable: true });
    await seed.flush();
    const local = new DbosDurableBackend(sdk);
    await local.hydrateWorkflow("dbos-terminal-race");
    const remote = new DbosDurableBackend(sdk);
    await remote.hydrateWorkflow("dbos-terminal-race");
    remote.setWorkflowStatus("dbos-terminal-race", "completed", 0, false);
    await remote.flush();
    setDurableBackend(local);

    assert.equal(await markDurableResumed("dbos-terminal-race"), "refused");
    const authoritative = new DbosDurableBackend(sdk);
    await authoritative.hydrateWorkflow("dbos-terminal-race");
    assert.equal(authoritative.getWorkflow("dbos-terminal-race")?.status, "completed");
  });});

describe("DBOS workflow registration preserves prompt ownership", () => {
  test("re-registering a workflow preserves and releases its original active token", async () => {
    const backend = new DbosDurableBackend(mockDbos());
    const api = reservationApi(backend);
    backend.registerWorkflow(registration("dbos-reregister"));
    const token = api.reservePendingPrompt("dbos-reregister", "prompt-1");
    assert.equal(backend.getWorkflow("dbos-reregister")?.pendingPrompts, 1);

    backend.registerWorkflow({ ...registration("dbos-reregister"), label: "merged" });
    assert.equal(backend.getWorkflow("dbos-reregister")?.label, "merged");
    assert.equal(backend.getWorkflow("dbos-reregister")?.pendingPrompts, 1);
    assert.deepEqual(api.pendingPromptToken("dbos-reregister", "prompt-1"), token);
    api.releasePendingPrompt("dbos-reregister", "prompt-1", token);

    assert.equal(backend.getWorkflow("dbos-reregister")?.pendingPrompts, 0);
  });

  test("an explicit zero baseline resets active ownership and persists a new generation boundary", async () => {
    const sdk = mockDbos();
    const backend = new DbosDurableBackend(sdk);
    const api = reservationApi(backend);
    backend.registerWorkflow(registration("dbos-explicit-zero"));
    const first = api.reservePendingPrompt("dbos-explicit-zero", "same-prompt");
    await backend.flush();
    assert.equal(backend.getWorkflow("dbos-explicit-zero")?.pendingPrompts, 1);

    backend.registerWorkflow(registration("dbos-explicit-zero", 0));
    assert.equal(backend.getWorkflow("dbos-explicit-zero")?.pendingPrompts, 0);
    assert.equal(api.pendingPromptToken("dbos-explicit-zero", "same-prompt"), undefined);
    api.releasePendingPrompt("dbos-explicit-zero", "same-prompt", first);
    assert.equal(backend.getWorkflow("dbos-explicit-zero")?.pendingPrompts, 0);

    const second = api.reservePendingPrompt("dbos-explicit-zero", "same-prompt");
    assert.notDeepEqual(second, first);
    await backend.flush();
    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow("dbos-explicit-zero");
    assert.equal(fresh.getWorkflow("dbos-explicit-zero")?.pendingPrompts, 1);
    const freshApi = reservationApi(fresh);
    freshApi.releasePendingPrompt("dbos-explicit-zero", "same-prompt", first);
    assert.equal(fresh.getWorkflow("dbos-explicit-zero")?.pendingPrompts, 1);
    freshApi.releasePendingPrompt("dbos-explicit-zero", "same-prompt", second);
    await fresh.flush();
    assert.equal(fresh.getWorkflow("dbos-explicit-zero")?.pendingPrompts, 0);
  });

  test("an explicit zero baseline clears a legacy-hydrated claim after fresh hydration", async () => {
    const sdk = mockDbos();
    const seed = new DbosDurableBackend(sdk);
    seed.registerWorkflow(registration("dbos-explicit-zero-legacy", 1));
    await seed.flush();
    const resumed = new DbosDurableBackend(sdk);
    await resumed.hydrateWorkflow("dbos-explicit-zero-legacy");
    const api = reservationApi(resumed);
    const legacy = api.pendingPromptToken("dbos-explicit-zero-legacy", "legacy-prompt");
    assert.notEqual(legacy, undefined);
    await resumed.flush();

    resumed.registerWorkflow(registration("dbos-explicit-zero-legacy", 0));
    assert.equal(resumed.getWorkflow("dbos-explicit-zero-legacy")?.pendingPrompts, 0);
    api.releasePendingPrompt("dbos-explicit-zero-legacy", "legacy-prompt", legacy!);
    await resumed.flush();
    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow("dbos-explicit-zero-legacy");
    assert.equal(fresh.getWorkflow("dbos-explicit-zero-legacy")?.pendingPrompts, 0);
    assert.equal(reservationApi(fresh).pendingPromptToken("dbos-explicit-zero-legacy", "legacy-prompt"), undefined);
  });

  test("an explicit nonzero baseline replaces tombstones and releases coherently", async () => {
    const sdk = mockDbos();
    const backend = new DbosDurableBackend(sdk);
    const api = reservationApi(backend);
    backend.registerWorkflow(registration("dbos-explicit-two"));
    const first = api.reservePendingPrompt("dbos-explicit-two", "cycled");
    api.releasePendingPrompt("dbos-explicit-two", "cycled", first);
    const second = api.reservePendingPrompt("dbos-explicit-two", "cycled");
    await backend.flush();

    backend.registerWorkflow(registration("dbos-explicit-two", 2));
    assert.equal(backend.getWorkflow("dbos-explicit-two")?.pendingPrompts, 2);
    api.releasePendingPrompt("dbos-explicit-two", "cycled", second);
    assert.equal(backend.getWorkflow("dbos-explicit-two")?.pendingPrompts, 2);
    const baselineA = api.pendingPromptToken("dbos-explicit-two", "baseline-a");
    const baselineB = api.pendingPromptToken("dbos-explicit-two", "baseline-b");
    assert.notEqual(baselineA, undefined);
    assert.notEqual(baselineB, undefined);
    api.releasePendingPrompt("dbos-explicit-two", "baseline-a", baselineA!);
    api.releasePendingPrompt("dbos-explicit-two", "baseline-b", baselineB!);
    await backend.flush();

    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow("dbos-explicit-two");
    assert.equal(fresh.getWorkflow("dbos-explicit-two")?.pendingPrompts, 0);
  });

  test("re-registering a legacy-hydrated workflow preserves the claimed token through cached replay", async () => {
    const sdk = mockDbos();
    const seed = new DbosDurableBackend(sdk);
    seed.registerWorkflow(registration("dbos-legacy-hydrated", 1));
    await seed.flush();
    const resumed = new DbosDurableBackend(sdk);
    await resumed.hydrateWorkflow("dbos-legacy-hydrated");
    const api = reservationApi(resumed);
    const token = api.pendingPromptToken("dbos-legacy-hydrated", "cached-prompt");
    assert.notEqual(token, undefined);

    resumed.registerWorkflow({ ...registration("dbos-legacy-hydrated"), label: "replayed" });
    assert.equal(resumed.getWorkflow("dbos-legacy-hydrated")?.pendingPrompts, 1);
    api.releasePendingPrompt("dbos-legacy-hydrated", "cached-prompt", token!);
    await resumed.flush();

    assert.equal(resumed.getWorkflow("dbos-legacy-hydrated")?.pendingPrompts, 0);
    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow("dbos-legacy-hydrated");
    assert.equal(fresh.getWorkflow("dbos-legacy-hydrated")?.pendingPrompts, 0);
  });

});
