import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbosDurableBackend, type DbosSdkHandle, type DbosStepRecord, type DbosWorkflowInfo } from "../../packages/workflows/src/durable/dbos-backend.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { FileDurableBackend } from "../../packages/workflows/src/durable/file-backend.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { wrapUiWithDurable } from "../../packages/workflows/src/durable/ui-primitive.js";
import type { WorkflowUIContext } from "../../packages/workflows/src/shared/authoring-contract-ui.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

function mockDbos(): DbosSdkHandle {
  const workflows = new Map<string, DbosWorkflowInfo>();
  const steps = new Map<string, WorkflowSerializableValue>();
  return {
    async launch() {},
    async shutdown() {},
    async startWorkflow(workflowId, name, inputs) {
      if (!workflows.has(workflowId)) {
        workflows.set(workflowId, { workflowId, name, inputs, status: "PENDING", createdAt: Date.now() });
      }
    },
    async retrieveWorkflow(workflowId) { return workflows.get(workflowId); },
    async cancelWorkflow() {},
    async resumeWorkflow() {},
    async listAllWorkflows() { return [...workflows.values()]; },
    async listStepRecords(workflowId) {
      const prefix = `${workflowId}:`;
      const records: DbosStepRecord[] = [];
      for (const [key, output] of steps) {
        if (key.startsWith(prefix)) records.push({ stepName: key.slice(prefix.length), output });
      }
      return records;
    },
    async recordStepOutput(workflowId, stepName, output) {
      steps.set(`${workflowId}:${stepName}`, output);
    },
    async deleteWorkflowData(workflowId) { workflows.delete(workflowId); },
  };
}

function pendingInputUi(answer: Promise<string>): WorkflowUIContext {
  return {
    input: () => answer,
    async confirm() { throw new Error("unused"); },
    async select<T extends string>(): Promise<T> { throw new Error("unused"); },
    async editor() { throw new Error("unused"); },
    async custom<T>(): Promise<T> { throw new Error("unused"); },
  };
}

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("durable pending-prompt counter backends", () => {
  test("file updates are atomic across stale backend instances and never underflow", () => {
    tempDir = mkdtempSync(join(tmpdir(), "durable-prompt-counter-"));
    const file = join(tempDir, "state.json");
    const workflowId = "file-prompts";
    const backendA = new FileDurableBackend(file);
    backendA.registerWorkflow({ workflowId, name: "prompts", inputs: {}, createdAt: 1, status: "running" });
    const backendB = new FileDurableBackend(file);
    assert.equal(backendA.getWorkflow(workflowId)?.pendingPrompts, 0);
    assert.equal(backendB.getWorkflow(workflowId)?.pendingPrompts, 0);

    backendA.adjustPendingPrompts(workflowId, 1);
    backendB.adjustPendingPrompts(workflowId, 1);
    assert.equal(new FileDurableBackend(file).getWorkflow(workflowId)?.pendingPrompts, 2);

    backendA.adjustPendingPrompts(workflowId, -1);
    backendB.adjustPendingPrompts(workflowId, -1);
    backendB.adjustPendingPrompts(workflowId, -1);
    assert.equal(new FileDurableBackend(file).getWorkflow(workflowId)?.pendingPrompts, 0);
  });

  test("file answer checkpoint preserves a stale sibling reservation", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "durable-prompt-checkpoint-"));
    const file = join(tempDir, "state.json");
    const workflowId = "file-checkpoint-prompts";
    const backendA = new FileDurableBackend(file);
    backendA.registerWorkflow({ workflowId, name: "prompts", inputs: {}, createdAt: 1, status: "running" });
    const backendB = new FileDurableBackend(file);
    backendA.getWorkflow(workflowId);
    backendB.getWorkflow(workflowId);
    const answerA = Promise.withResolvers<string>();
    const answerB = Promise.withResolvers<string>();
    const uiA = wrapUiWithDurable(pendingInputUi(answerA.promise), {
      workflowId, backend: backendA, nextCheckpointId: createCheckpointIdGenerator(),
    });
    const uiB = wrapUiWithDurable(pendingInputUi(answerB.promise), {
      workflowId, backend: backendB, nextCheckpointId: createCheckpointIdGenerator(),
    });

    const promptA = uiA.input("A");
    const promptB = uiB.input("B");
    await Promise.resolve();
    assert.equal(new FileDurableBackend(file).getWorkflow(workflowId)?.pendingPrompts, 2);
    answerA.resolve("answer-A");
    assert.equal(await promptA, "answer-A");
    assert.equal(new FileDurableBackend(file).getWorkflow(workflowId)?.pendingPrompts, 1);
    answerB.reject(new Error("abort-B"));
    await assert.rejects(promptB, /abort-B/);
    assert.equal(new FileDurableBackend(file).getWorkflow(workflowId)?.pendingPrompts, 0);
  });

  test("DBOS separately hydrated instances preserve both prompt reservations", async () => {
    const sdk = mockDbos();
    const workflowId = "dbos-overlapping-prompts";
    const seed = new DbosDurableBackend(sdk);
    seed.registerWorkflow({ workflowId, name: "prompts", inputs: {}, createdAt: 1, status: "running" });
    await seed.flush();
    const backendA = new DbosDurableBackend(sdk);
    const backendB = new DbosDurableBackend(sdk);
    await Promise.all([backendA.hydrateWorkflow(workflowId), backendB.hydrateWorkflow(workflowId)]);
    const answerA = Promise.withResolvers<string>();
    const answerB = Promise.withResolvers<string>();
    const promptA = wrapUiWithDurable(pendingInputUi(answerA.promise), {
      workflowId, backend: backendA, nextCheckpointId: createCheckpointIdGenerator(),
    }).input("A");
    const promptB = wrapUiWithDurable(pendingInputUi(answerB.promise), {
      workflowId, backend: backendB, nextCheckpointId: createCheckpointIdGenerator(),
    }).input("B");
    await Bun.sleep(0);
    await Promise.all([backendA.flush(), backendB.flush()]);

    const bothOpen = new DbosDurableBackend(sdk);
    await bothOpen.hydrateWorkflow(workflowId);
    assert.equal(bothOpen.getWorkflow(workflowId)?.pendingPrompts, 2);
    answerA.resolve("answer-A");
    assert.equal(await promptA, "answer-A");
    const onlyBOpen = new DbosDurableBackend(sdk);
    await onlyBOpen.hydrateWorkflow(workflowId);
    assert.equal(onlyBOpen.getWorkflow(workflowId)?.pendingPrompts, 1);
    answerB.reject(new Error("abort-B"));
    await assert.rejects(promptB, /abort-B/);
    const settled = new DbosDurableBackend(sdk);
    await settled.hydrateWorkflow(workflowId);
    assert.equal(settled.getWorkflow(workflowId)?.pendingPrompts, 0);
  });

  test("duplicate in-memory legacy release is an identity no-op and a fresh generation is explicit", () => {
    const workflowId = "memory-duplicate-release";
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId, name: "prompts", inputs: {}, createdAt: 1, status: "running", pendingPrompts: 2 });

    const completed = backend.reservePendingPrompt(workflowId, "completed-prompt");
    backend.releasePendingPrompt(workflowId, "completed-prompt", completed);
    assert.equal(backend.getWorkflow(workflowId)?.pendingPrompts, 1);
    backend.releasePendingPrompt(workflowId, "completed-prompt", completed);
    assert.equal(backend.getWorkflow(workflowId)?.pendingPrompts, 1);

    const next = backend.reservePendingPrompt(workflowId, "completed-prompt");
    assert.equal(backend.getWorkflow(workflowId)?.pendingPrompts, 2);
    backend.releasePendingPrompt(workflowId, "completed-prompt", next);
    assert.equal(backend.getWorkflow(workflowId)?.pendingPrompts, 1);
  });

  test("duplicate file legacy release survives stale backend instances", () => {
    tempDir = mkdtempSync(join(tmpdir(), "durable-prompt-duplicate-"));
    const file = join(tempDir, "state.json");
    const workflowId = "file-duplicate-release";
    const backendA = new FileDurableBackend(file);
    backendA.registerWorkflow({ workflowId, name: "prompts", inputs: {}, createdAt: 1, status: "running", pendingPrompts: 2 });
    const backendB = new FileDurableBackend(file);
    backendA.getWorkflow(workflowId);
    backendB.getWorkflow(workflowId);

    const completed = backendA.reservePendingPrompt(workflowId, "completed-prompt");
    backendA.releasePendingPrompt(workflowId, "completed-prompt", completed);
    assert.equal(new FileDurableBackend(file).getWorkflow(workflowId)?.pendingPrompts, 1);
    backendB.releasePendingPrompt(workflowId, "completed-prompt", completed);
    assert.equal(new FileDurableBackend(file).getWorkflow(workflowId)?.pendingPrompts, 1);
  });

  test("duplicate DBOS legacy release is an identity no-op", async () => {
    const sdk = mockDbos();
    const workflowId = "dbos-duplicate-release";
    const backend = new DbosDurableBackend(sdk);
    backend.registerWorkflow({ workflowId, name: "prompts", inputs: {}, createdAt: 1, status: "running", pendingPrompts: 2 });
    await backend.flush();

    const completed = backend.reservePendingPrompt(workflowId, "completed-prompt");
    backend.releasePendingPrompt(workflowId, "completed-prompt", completed);
    backend.releasePendingPrompt(workflowId, "completed-prompt", completed);
    await backend.flush();
    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow(workflowId);
    assert.equal(fresh.getWorkflow(workflowId)?.pendingPrompts, 1);
  });

  test("two stale DBOS decrements cannot hide a negative balance from a later increment", async () => {
    const sdk = mockDbos();
    const workflowId = "dbos-concurrent-underflow";
    const seed = new DbosDurableBackend(sdk);
    seed.registerWorkflow({ workflowId, name: "prompts", inputs: {}, createdAt: 1, status: "running", pendingPrompts: 1 });
    await seed.flush();
    const backendA = new DbosDurableBackend(sdk);
    const backendB = new DbosDurableBackend(sdk);
    await Promise.all([backendA.hydrateWorkflow(workflowId), backendB.hydrateWorkflow(workflowId)]);

    backendA.adjustPendingPrompts(workflowId, -1);
    backendB.adjustPendingPrompts(workflowId, -1);
    await Promise.all([backendA.flush(), backendB.flush()]);
    const afterRelease = new DbosDurableBackend(sdk);
    await afterRelease.hydrateWorkflow(workflowId);
    assert.equal(afterRelease.getWorkflow(workflowId)?.pendingPrompts, 0);

    afterRelease.adjustPendingPrompts(workflowId, 1);
    await afterRelease.flush();
    const afterIncrement = new DbosDurableBackend(sdk);
    await afterIncrement.hydrateWorkflow(workflowId);
    assert.equal(afterIncrement.getWorkflow(workflowId)?.pendingPrompts, 1);
  });

  test("two stale DBOS releases consume one legacy slot before a fresh reservation", async () => {
    const sdk = mockDbos();
    const workflowId = "dbos-concurrent-legacy-release";
    const seed = new DbosDurableBackend(sdk);
    seed.registerWorkflow({ workflowId, name: "prompts", inputs: {}, createdAt: 1, status: "running", pendingPrompts: 1 });
    await seed.flush();
    const backendA = new DbosDurableBackend(sdk);
    const backendB = new DbosDurableBackend(sdk);
    await Promise.all([backendA.hydrateWorkflow(workflowId), backendB.hydrateWorkflow(workflowId)]);

    const completed = backendA.reservePendingPrompt(workflowId, "legacy-owner");
    backendA.releasePendingPrompt(workflowId, "legacy-owner", completed);
    backendB.releasePendingPrompt(workflowId, "legacy-owner", completed);
    await Promise.all([backendA.flush(), backendB.flush()]);
    const afterRelease = new DbosDurableBackend(sdk);
    await afterRelease.hydrateWorkflow(workflowId);
    assert.equal(afterRelease.getWorkflow(workflowId)?.pendingPrompts, 0);

    afterRelease.reservePendingPrompt(workflowId, "fresh-reservation");
    await afterRelease.flush();
    const afterReservation = new DbosDurableBackend(sdk);
    await afterReservation.hydrateWorkflow(workflowId);
    assert.equal(afterReservation.getWorkflow(workflowId)?.pendingPrompts, 1);
  });

  test("DBOS updates persist for fresh hydration and never underflow", async () => {
    const sdk = mockDbos();
    const workflowId = "dbos-prompts";
    const backend = new DbosDurableBackend(sdk);
    backend.registerWorkflow({ workflowId, name: "prompts", inputs: {}, createdAt: 1, status: "running" });
    await backend.flush();
    backend.adjustPendingPrompts(workflowId, 1);
    backend.adjustPendingPrompts(workflowId, 1);
    backend.adjustPendingPrompts(workflowId, -1);
    await backend.flush();
    assert.equal(backend.getWorkflow(workflowId)?.pendingPrompts, 1);

    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow(workflowId);
    assert.equal(fresh.getWorkflow(workflowId)?.pendingPrompts, 1);
    assert.deepEqual(fresh.listResumableWorkflows().map((entry) => entry.workflowId), [workflowId]);
    fresh.adjustPendingPrompts(workflowId, -2);
    await fresh.flush();
    assert.equal(fresh.getWorkflow(workflowId)?.pendingPrompts, 0);
    fresh.adjustPendingPrompts(workflowId, 1);
    await fresh.flush();
    const afterUnderflow = new DbosDurableBackend(sdk);
    await afterUnderflow.hydrateWorkflow(workflowId);
    assert.equal(afterUnderflow.getWorkflow(workflowId)?.pendingPrompts, 1);
  });
});
