import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import {
  createWorkflowLifecycleNotificationState,
  installWorkflowLifecycleNotifications,
  seedWorkflowLifecycleNotificationState,
  type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

interface Admission {
  readonly content?: string;
  readonly details?: WorkflowLifecycleNoticeDetails;
}

interface TimerRecord {
  readonly callback: () => void;
  active: boolean;
}

function seedCompletedTool(backend: InMemoryDurableBackend, runId: string, name = "historical workflow"): void {
  backend.registerWorkflow({ workflowId: runId, name, inputs: {}, createdAt: 1, updatedAt: 3, status: "completed" });
  backend.recordCheckpoint({
    kind: "tool", workflowId: runId, checkpointId: "tool:done", name: "done",
    argsHash: "done-hash", output: true, completedAt: 2,
  });
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined).then(() => undefined).then(() => undefined);
}

function installTimerHarness(): { runNext(): void; activeCount(): number; restore(): void } {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers: TimerRecord[] = [];
  globalThis.setTimeout = ((callback: () => void) => {
    const timer: TimerRecord = { callback, active: true };
    timers.push(timer);
    return timer as never;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    (timer as unknown as TimerRecord).active = false;
  }) as typeof clearTimeout;
  return {
    runNext() {
      const timer = timers.find((candidate) => candidate.active);
      assert.ok(timer);
      timer.active = false;
      timer.callback();
    },
    activeCount: () => timers.filter((timer) => timer.active).length,
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

describe("completed inspection lifecycle delivery state", () => {
  test("preserves an in-flight live completion admission until its original send resolves", async () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const send = Promise.withResolvers<void>();
    const admissions: Admission[] = [];
    seedCompletedTool(backend, "pending-live", "historical replacement");
    const unsubscribe = installWorkflowLifecycleNotifications({
      store, state, seedExisting: false,
      config: { enabled: true, notifyOn: ["completed"] },
      sendMessage(message) { admissions.push(message as Admission); return send.promise; },
    });
    store.recordRunStart({ id: "pending-live", name: "original live", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordRunEnd("pending-live", "completed", {});
    assert.equal(admissions.length, 1);

    const opened = openCompletedDurableWorkflow("pending-live", {
      durableBackend: backend,
      store,
      beforeRestore(snapshots) {
        seedWorkflowLifecycleNotificationState(state, { ...store.snapshot(), runs: snapshots });
      },
    });
    assert.equal(opened.ok, true);
    assert.equal(admissions.length, 1, "historical insertion must not duplicate a pending live admission");
    assert.equal(state.pendingTerminalRuns.size, 1);

    send.resolve();
    await flushMicrotasks();
    assert.equal(state.pendingTerminalRuns.size, 0);
    assert.equal(state.deliveredTerminalRuns.size, 1);
    assert.equal(admissions.length, 1);
    unsubscribe();
  });

  test("preserves the retained retry envelope until its scheduled retry", async () => {
    const timers = installTimerHarness();
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const admissions: Admission[] = [];
    let attempt = 0;
    seedCompletedTool(backend, "retry-live", "historical replacement");
    const unsubscribe = installWorkflowLifecycleNotifications({
      store, state, seedExisting: false,
      config: { enabled: true, notifyOn: ["completed"] },
      sendMessage(message) {
        admissions.push(message as Admission);
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error("first admission rejected"));
      },
    });
    try {
      store.recordRunStart({ id: "retry-live", name: "original live", inputs: {}, status: "running", stages: [], startedAt: 1 });
      store.recordRunEnd("retry-live", "completed", {});
      await flushMicrotasks();
      assert.equal(admissions.length, 1);
      assert.equal(timers.activeCount(), 1);
      const originalDetails = admissions[0]?.details;
      const originalContent = admissions[0]?.content;
      assert.equal(originalDetails?.workflowName, "original live");

      const opened = openCompletedDurableWorkflow("retry-live", {
        durableBackend: backend,
        store,
        beforeRestore(snapshots) {
          seedWorkflowLifecycleNotificationState(state, { ...store.snapshot(), runs: snapshots });
        },
      });
      assert.equal(opened.ok, true);
      assert.equal(admissions.length, 1, "restoration must not immediately replace a retryable live envelope");
      assert.equal(state.retryableTerminalNotices.values().next().value, originalDetails);
      assert.equal(timers.activeCount(), 1);

      timers.runNext();
      await flushMicrotasks();
      assert.equal(admissions.length, 2);
      assert.equal(admissions[1]?.details, originalDetails);
      assert.equal(admissions[1]?.content, originalContent);
      assert.equal(state.retryableTerminalNotices.size, 0);
      assert.equal(state.deliveredTerminalRuns.size, 1);
    } finally {
      unsubscribe();
      timers.restore();
    }
  });
});
