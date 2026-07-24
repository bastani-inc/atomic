import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  createWorkflowLifecycleNotificationState,
  installWorkflowLifecycleNotifications,
  resetWorkflowLifecycleNotificationState,
  type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

interface CapturedNotice {
  readonly details?: WorkflowLifecycleNoticeDetails;
}

interface ScheduledTimer {
  readonly callback: () => void;
  readonly delay: number;
  active: boolean;
}

function installTimerHarness(): {
  readonly delays: () => number[];
  readonly runNext: () => void;
  readonly activeCount: () => number;
  readonly restore: () => void;
} {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers: ScheduledTimer[] = [];

  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const timer: ScheduledTimer = { callback, delay, active: true };
    timers.push(timer);
    return timer as never;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    (handle as unknown as ScheduledTimer).active = false;
  }) as typeof clearTimeout;

  return {
    delays: () => timers.map((timer) => timer.delay),
    runNext() {
      const timer = timers.find((candidate) => candidate.active);
      assert.ok(timer, "expected an active lifecycle retry timer");
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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function startRun(store: ReturnType<typeof createStore>, id: string, name: string): void {
  store.recordRunStart({ id, name, inputs: {}, status: "running", stages: [], startedAt: 1 });
}

const completedConfig = { enabled: true, notifyOn: ["completed"] as const };

describe("workflow lifecycle admission failure recovery", () => {
  test("rejected admission retries the original notice with exponential delays capped at one second", async () => {
    const timers = installTimerHarness();
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const attempts: CapturedNotice[] = [];
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = installWorkflowLifecycleNotifications({
        store,
        state,
        seedExisting: false,
        config: completedConfig,
        sendMessage(message) {
          attempts.push(message as CapturedNotice);
          return Promise.reject(new Error("parent admission rejected"));
        },
      });
      startRun(store, "run-backoff", "original workflow");
      assert.equal(store.recordRunEnd("run-backoff", "completed", {}), true);
      await flushMicrotasks();

      for (const expectedDelay of [20, 40, 80, 160, 320, 640, 1_000]) {
        assert.equal(timers.delays().at(-1), expectedDelay);
        timers.runNext();
        await flushMicrotasks();
      }

      assert.deepEqual(timers.delays(), [20, 40, 80, 160, 320, 640, 1_000, 1_000]);
      assert.equal(attempts.length, 8);
      const originalDetails = attempts[0]?.details;
      assert.ok(originalDetails);
      assert.ok(attempts.every((attempt) => attempt.details === originalDetails));
      assert.equal(state.deliveredTerminalRuns.size, 0);
      assert.equal(state.retryableTerminalNotices.size, 1);
    } finally {
      unsubscribe?.();
      timers.restore();
    }
  });

  test("an in-flight rejection hands the original payload to the active reinstallation", async () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const firstAdmission = Promise.withResolvers<void>();
    const firstMessages: CapturedNotice[] = [];
    const replacementMessages: CapturedNotice[] = [];
    const firstUnsubscribe = installWorkflowLifecycleNotifications({
      store,
      state,
      seedExisting: false,
      config: { enabled: true, notifyOn: ["completed", "failed"] },
      sendMessage(message) {
        firstMessages.push(message as CapturedNotice);
        return firstAdmission.promise;
      },
    });
    let replacementUnsubscribe: (() => void) | undefined;
    try {
      startRun(store, "run-reinstall", "original workflow");
      assert.equal(store.recordRunEnd("run-reinstall", "completed", { version: "original" }), true);
      assert.equal(firstMessages.length, 1);
      const originalDetails = firstMessages[0]?.details;
      assert.ok(originalDetails);

      assert.equal(store.removeRun("run-reinstall"), true);
      startRun(store, "run-reinstall", "mutated workflow");
      assert.equal(store.recordRunEnd("run-reinstall", "completed", { version: "mutated" }), true);
      firstUnsubscribe();
      replacementUnsubscribe = installWorkflowLifecycleNotifications({
        store,
        state,
        seedExisting: false,
        config: completedConfig,
        sendMessage(message) {
          replacementMessages.push(message as CapturedNotice);
        },
      });

      firstAdmission.reject(new Error("old installation rejected admission"));
      await flushMicrotasks();

      assert.equal(firstMessages.length, 1);
      assert.equal(replacementMessages.length, 1);
      assert.equal(replacementMessages[0]?.details, originalDetails);
      assert.equal(replacementMessages[0]?.details?.workflowName, "original workflow");
      assert.equal(replacementMessages[0]?.details?.runId, "run-reinstall");
      assert.equal(state.retryableTerminalNotices.size, 0);
      assert.equal(state.deliveredTerminalRuns.size, 1);
    } finally {
      replacementUnsubscribe?.();
      firstUnsubscribe();
    }
  });

  test("session replacement clears failed admission payloads without waking the new chat", async () => {
    const timers = installTimerHarness();
    const oldStore = createStore();
    const state = createWorkflowLifecycleNotificationState();
    let oldUnsubscribe: (() => void) | undefined;
    let replacementUnsubscribe: (() => void) | undefined;
    try {
      oldUnsubscribe = installWorkflowLifecycleNotifications({
        store: oldStore,
        state,
        seedExisting: false,
        config: completedConfig,
        sendMessage() {
          return Promise.reject(new Error("old chat rejected admission"));
        },
      });
      startRun(oldStore, "run-old-session", "old session workflow");
      assert.equal(oldStore.recordRunEnd("run-old-session", "completed", {}), true);
      await flushMicrotasks();
      assert.equal(timers.activeCount(), 1);
      assert.equal(state.retryableTerminalNotices.size, 1);

      oldUnsubscribe();
      oldUnsubscribe = undefined;
      resetWorkflowLifecycleNotificationState(state);
      const replacementStore = createStore();
      let replacementWakeCount = 0;
      replacementUnsubscribe = installWorkflowLifecycleNotifications({
        store: replacementStore,
        state,
        seedExisting: false,
        config: completedConfig,
        sendMessage() {
          replacementWakeCount += 1;
        },
      });
      startRun(replacementStore, "run-unrelated", "unrelated new chat workflow");
      await flushMicrotasks();

      assert.equal(timers.activeCount(), 0);
      assert.equal(replacementWakeCount, 0);
      assert.equal(state.pendingTerminalRuns.size, 0);
      assert.equal(state.retryableTerminalRuns.size, 0);
      assert.equal(state.retryableTerminalNotices.size, 0);
      assert.equal(state.deliveredTerminalRuns.size, 0);
    } finally {
      replacementUnsubscribe?.();
      oldUnsubscribe?.();
      timers.restore();
    }
  });
});
