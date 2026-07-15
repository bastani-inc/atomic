import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDurableBackend, type DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import {
  DbosDurableBackend,
  type DbosSdkHandle,
  type DbosStepRecord,
  type DbosWorkflowInfo,
} from "../../packages/workflows/src/durable/dbos-backend.js";
import { FileDurableBackend } from "../../packages/workflows/src/durable/file-backend.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import { createCheckpointIdGenerator, createToolPrimitive } from "../../packages/workflows/src/durable/tool-primitive.js";
import { wrapUiWithDurable } from "../../packages/workflows/src/durable/ui-primitive.js";
import type { WorkflowUIContext } from "../../packages/workflows/src/shared/authoring-contract-ui.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

interface ReservationApi {
  reservePendingPrompt(workflowId: string, reservationId: string): unknown;
  releasePendingPrompt(workflowId: string, reservationId: string, token: unknown): void;
}

interface TestDbosHandle extends DbosSdkHandle {
  putStep(workflowId: string, stepName: string, output: WorkflowSerializableValue): void;
}

function mockDbos(): TestDbosHandle {
  const workflows = new Map<string, DbosWorkflowInfo>();
  const steps = new Map<string, WorkflowSerializableValue>();
  return {
    async launch() {},
    async shutdown() {},
    async startWorkflow(workflowId, name, inputs) {
      if (!workflows.has(workflowId)) {
        workflows.set(workflowId, { workflowId, name, inputs, status: "PENDING", createdAt: 1 });
      }
    },
    async retrieveWorkflow(workflowId) { return workflows.get(workflowId); },
    async cancelWorkflow() {},
    async resumeWorkflow() {},
    async listAllWorkflows() { return [...workflows.values()]; },
    async listStepRecords(workflowId) {
      const prefix = `${workflowId}:`;
      return [...steps]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, output]): DbosStepRecord => ({ stepName: key.slice(prefix.length), output }));
    },
    async recordStepOutput(workflowId, stepName, output) { steps.set(`${workflowId}:${stepName}`, output); },
    async deleteWorkflowData(workflowId) { workflows.delete(workflowId); },
    putStep(workflowId, stepName, output) { steps.set(`${workflowId}:${stepName}`, output); },
  };
}

function registration(workflowId: string, pendingPrompts = 0) {
  return { workflowId, name: workflowId, inputs: {}, createdAt: 1, status: "running" as const, pendingPrompts };
}

function reservationApi(backend: object): ReservationApi {
  return backend as ReservationApi;
}

function assertOpaqueGenerationSafety(
  backend: DurableWorkflowBackend,
  api: ReservationApi,
  workflowId: string,
  countWorkflowId = workflowId,
): void {
  const first = api.reservePendingPrompt(workflowId, "same-identity");
  assert.notEqual(first, undefined, "reserve must return an opaque generation token");
  api.releasePendingPrompt(workflowId, "same-identity", first);
  const second = api.reservePendingPrompt(workflowId, "same-identity");
  assert.notEqual(second, undefined);
  assert.notDeepEqual(second, first, "a later reservation must have a different generation token");
  assert.equal(backend.getWorkflow(countWorkflowId)?.pendingPrompts, 1);
  api.releasePendingPrompt(workflowId, "same-identity", first);
  assert.equal(backend.getWorkflow(countWorkflowId)?.pendingPrompts, 1, "stale generation release consumed the active generation");
  api.releasePendingPrompt(workflowId, "same-identity", second);
  assert.equal(backend.getWorkflow(countWorkflowId)?.pendingPrompts, 0);
}

function immediateInput(answer: string, onCall?: () => void): WorkflowUIContext {
  return {
    async input() { onCall?.(); return answer; },
    async confirm() { throw new Error("unused"); },
    async select<T extends string>(): Promise<T> { throw new Error("unused"); },
    async editor() { throw new Error("unused"); },
    async custom<T>(): Promise<T> { throw new Error("unused"); },
  };
}

async function callDurableInput(backend: DurableWorkflowBackend, workflowId: string, ui: WorkflowUIContext): Promise<string> {
  return wrapUiWithDurable(ui, {
    workflowId,
    backend,
    nextCheckpointId: createCheckpointIdGenerator(),
  }).input("shared prompt");
}

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("opaque durable prompt reservation generations", () => {
  test("in-memory delayed generation-1 release leaves generation 2 pending", () => {
    const workflowId = "opaque-memory";
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow(registration(workflowId));
    assertOpaqueGenerationSafety(backend, reservationApi(backend), workflowId);
  });

  test("file delayed generation-1 release leaves generation 2 pending", () => {
    tempDir = mkdtempSync(join(tmpdir(), "opaque-file-"));
    const file = join(tempDir, "state.json");
    const workflowId = "opaque-file";
    const owner = new FileDurableBackend(file);
    owner.registerWorkflow(registration(workflowId));
    const first = owner.reservePendingPrompt(workflowId, "same-identity");
    const staleReleaser = new FileDurableBackend(file);
    assert.equal(staleReleaser.getWorkflow(workflowId)?.pendingPrompts, 1);
    owner.releasePendingPrompt(workflowId, "same-identity", first);
    const newer = new FileDurableBackend(file);
    const second = newer.reservePendingPrompt(workflowId, "same-identity");
    staleReleaser.releasePendingPrompt(workflowId, "same-identity", first);
    assert.equal(new FileDurableBackend(file).getWorkflow(workflowId)?.pendingPrompts, 1);
    newer.releasePendingPrompt(workflowId, "same-identity", second);
    assert.equal(new FileDurableBackend(file).getWorkflow(workflowId)?.pendingPrompts, 0);
  });

  test("DBOS delayed generation-1 release leaves generation 2 pending", async () => {
    const workflowId = "opaque-dbos";
    const sdk = mockDbos();
    const backend = new DbosDurableBackend(sdk);
    backend.registerWorkflow(registration(workflowId));
    await backend.flush();
    const api = reservationApi(backend);
    const first = api.reservePendingPrompt(workflowId, "same-identity");
    await backend.flush();
    api.releasePendingPrompt(workflowId, "same-identity", first);
    await backend.flush();
    const second = api.reservePendingPrompt(workflowId, "same-identity");
    await backend.flush();
    api.releasePendingPrompt(workflowId, "same-identity", first);
    await backend.flush();
    assert.equal(backend.getWorkflow(workflowId)?.pendingPrompts, 1);
    const afterStaleRelease = new DbosDurableBackend(sdk);
    await afterStaleRelease.hydrateWorkflow(workflowId);
    assert.equal(afterStaleRelease.getWorkflow(workflowId)?.pendingPrompts, 1);
    api.releasePendingPrompt(workflowId, "same-identity", second);
    await backend.flush();
    assert.equal(backend.getWorkflow(workflowId)?.pendingPrompts, 0);
  });

  test("scoped delayed generation-1 release leaves generation 2 pending", () => {
    const workflowId = "opaque-scoped-root";
    const root = new InMemoryDurableBackend();
    root.registerWorkflow(registration(workflowId));
    const scoped = new ScopedDurableBackend(root, { rootWorkflowId: workflowId, scopePrefix: "workflow:child:1" });
    assertOpaqueGenerationSafety(root, reservationApi(scoped), "child-run", workflowId);
  });
});

async function verifyConcurrentLegacyClaims(order: readonly ["a" | "b", "a" | "b"]): Promise<void> {
  const sdk = mockDbos();
  const workflowId = `legacy-claims-${order.join("")}`;
  const seed = new DbosDurableBackend(sdk);
  seed.registerWorkflow(registration(workflowId, 1));
  await seed.flush();
  const a = new DbosDurableBackend(sdk);
  const b = new DbosDurableBackend(sdk);
  await Promise.all([a.hydrateWorkflow(workflowId), b.hydrateWorkflow(workflowId)]);
  const backends = { a, b };
  for (const identity of order) {
    reservationApi(backends[identity]).reservePendingPrompt(workflowId, `prompt-${identity}`);
    await backends[identity].flush();
  }
  let fresh = new DbosDurableBackend(sdk);
  await fresh.hydrateWorkflow(workflowId);
  assert.equal(fresh.getWorkflow(workflowId)?.pendingPrompts, 2, "one anonymous legacy slot was assigned to multiple identities");
  const tokenA = reservationApi(fresh).reservePendingPrompt(workflowId, "prompt-a");
  reservationApi(fresh).releasePendingPrompt(workflowId, "prompt-a", tokenA);
  await fresh.flush();
  fresh = new DbosDurableBackend(sdk);
  await fresh.hydrateWorkflow(workflowId);
  assert.equal(fresh.getWorkflow(workflowId)?.pendingPrompts, 1, "releasing A must leave B active");
}

describe("DBOS anonymous legacy prompt balance", () => {
  test("concurrent legacy claims remain truthful in A/B event order", async () => {
    await verifyConcurrentLegacyClaims(["a", "b"]);
  });

  test("concurrent legacy claims remain truthful in B/A event order", async () => {
    await verifyConcurrentLegacyClaims(["b", "a"]);
  });

  test("v2 colliding legacy-token claims hydrate truthfully in either event order", async () => {
    for (const order of [["prompt-a", "prompt-b"], ["prompt-b", "prompt-a"]] as const) {
      const sdk = mockDbos();
      const workflowId = `legacy-v2-collision-${order.join("")}`;
      const seed = new DbosDurableBackend(sdk);
      seed.registerWorkflow(registration(workflowId, 1));
      await seed.flush();
      for (const identity of order) {
        sdk.putStep(workflowId, `__atomic_prompt_reservation:reserve:${identity}:1`, {
          __atomicPromptReservation: true, version: 2, reservationId: identity,
          generation: 1, operation: "reserve", tokenId: "legacy:0",
        });
      }
      const fresh = new DbosDurableBackend(sdk);
      await fresh.hydrateWorkflow(workflowId);
      assert.equal(fresh.getWorkflow(workflowId)?.pendingPrompts, 2);
      const tokenA = reservationApi(fresh).reservePendingPrompt(workflowId, "prompt-a");
      reservationApi(fresh).releasePendingPrompt(workflowId, "prompt-a", tokenA);
      await fresh.flush();
      const afterRelease = new DbosDurableBackend(sdk);
      await afterRelease.hydrateWorkflow(workflowId);
      assert.equal(afterRelease.getWorkflow(workflowId)?.pendingPrompts, 1);
    }
  });

  test("v1 scalar migration release stays consumed after hydration", async () => {
    const sdk = mockDbos();
    const workflowId = "legacy-v1-scalar-release";
    const seed = new DbosDurableBackend(sdk);
    seed.registerWorkflow(registration(workflowId));
    await seed.flush();
    sdk.putStep(workflowId, "__atomic_prompt_delta:legacy-positive", {
      __atomicPromptDelta: true, version: 1, delta: 1,
    });
    const releasing = new DbosDurableBackend(sdk);
    await releasing.hydrateWorkflow(workflowId);
    assert.equal(releasing.getWorkflow(workflowId)?.pendingPrompts, 1);
    releasing.adjustPendingPrompts(workflowId, -1);
    await releasing.flush();
    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow(workflowId);
    assert.equal(fresh.getWorkflow(workflowId)?.pendingPrompts, 0);
  });

  test("v1 colliding legacy claims hydrate as two active identities", async () => {
    const sdk = mockDbos();
    const workflowId = "legacy-v1-collision";
    const seed = new DbosDurableBackend(sdk);
    seed.registerWorkflow(registration(workflowId, 1));
    await seed.flush();
    for (const identity of ["prompt-a", "prompt-b"]) {
      sdk.putStep(workflowId, `__atomic_prompt_reservation:reserve:${identity}:1`, {
        __atomicPromptReservation: true,
        version: 1,
        reservationId: identity,
        generation: 1,
        operation: "reserve",
        claimedLegacy: true,
      });
    }
    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow(workflowId);
    assert.equal(fresh.getWorkflow(workflowId)?.pendingPrompts, 2);
    const tokenA = reservationApi(fresh).reservePendingPrompt(workflowId, "prompt-a");
    reservationApi(fresh).releasePendingPrompt(workflowId, "prompt-a", tokenA);
    await fresh.flush();
    const afterRelease = new DbosDurableBackend(sdk);
    await afterRelease.hydrateWorkflow(workflowId);
    assert.equal(afterRelease.getWorkflow(workflowId)?.pendingPrompts, 1);
  });
});

describe("cross-instance-fresh file replay reads", () => {
  test("a stale file instance observes another instance's tool checkpoint and does not execute twice", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fresh-tool-replay-"));
    const file = join(tempDir, "state.json");
    const workflowId = "fresh-tool-replay";
    const writer = new FileDurableBackend(file);
    writer.registerWorkflow(registration(workflowId));
    const staleReader = new FileDurableBackend(file);
    assert.equal(staleReader.getWorkflow(workflowId)?.completedCheckpoints, 0);
    const writerTool = createToolPrimitive({ workflowId, backend: writer, nextCheckpointId: createCheckpointIdGenerator(), throwIfCancelled() {} });
    assert.equal(await writerTool("side-effect", { value: 1 }, async () => "writer-result"), "writer-result");
    let duplicateExecutions = 0;
    const readerTool = createToolPrimitive({ workflowId, backend: staleReader, nextCheckpointId: createCheckpointIdGenerator(), throwIfCancelled() {} });
    const result = await readerTool("side-effect", { value: 1 }, async () => {
      duplicateExecutions += 1;
      return "duplicate-result";
    });
    assert.equal(result, "writer-result");
    assert.equal(duplicateExecutions, 0);
  });

  test("a stale file instance observes another instance's UI checkpoint and does not re-prompt", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fresh-ui-replay-"));
    const file = join(tempDir, "state.json");
    const workflowId = "fresh-ui-replay";
    const writer = new FileDurableBackend(file);
    writer.registerWorkflow(registration(workflowId));
    const staleReader = new FileDurableBackend(file);
    assert.equal(staleReader.getWorkflow(workflowId)?.completedCheckpoints, 0);
    assert.equal(await callDurableInput(writer, workflowId, immediateInput("writer-answer")), "writer-answer");
    let duplicatePrompts = 0;
    const answer = await callDurableInput(staleReader, workflowId, immediateInput("duplicate-answer", () => { duplicatePrompts += 1; }));
    assert.equal(answer, "writer-answer");
    assert.equal(duplicatePrompts, 0);
  });

  test("stage and checkpoint replay lookup refreshes a previously loaded file mirror", () => {
    tempDir = mkdtempSync(join(tmpdir(), "fresh-stage-replay-"));
    const file = join(tempDir, "state.json");
    const workflowId = "fresh-stage-replay";
    const writer = new FileDurableBackend(file);
    writer.registerWorkflow(registration(workflowId));
    const staleReader = new FileDurableBackend(file);
    assert.deepEqual(staleReader.listCheckpoints(workflowId), []);
    writer.recordCheckpoint({
      kind: "stage", workflowId, checkpointId: "stage:1", name: "stage", replayKey: "stage:1",
      output: "stage-output", sessionId: "session-1", completedAt: 2,
    });
    assert.equal(staleReader.getStageOutput(workflowId, "stage:1"), "stage-output");
    assert.equal(staleReader.getStageSession(workflowId, "stage:1")?.sessionId, "session-1");
    assert.equal(staleReader.listCheckpoints(workflowId).length, 1);
  });
});
