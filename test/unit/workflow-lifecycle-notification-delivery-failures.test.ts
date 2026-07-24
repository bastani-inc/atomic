import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import factory, { type ExtensionAPI } from "../../packages/workflows/src/extension/index.js";
import {
  createWorkflowLifecycleNotificationState,
  installWorkflowLifecycleNotifications,
  LIFECYCLE_NOTICE_CUSTOM_TYPE,
  type WorkflowLifecycleNoticeDetails,
  type WorkflowLifecycleNoticeKind,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStore, store as extensionStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

interface CapturedNotice {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details?: WorkflowLifecycleNoticeDetails;
}

interface CapturedSendOptions {
  readonly triggerTurn?: boolean;
  readonly deliverAs?: "steer" | "followUp";
  readonly persistWhenStreaming?: boolean;
}

interface CapturedAdmission {
  readonly message: CapturedNotice;
  readonly options: CapturedSendOptions | undefined;
}

type ExtensionHandler = (event: unknown, context?: unknown) => unknown;

interface ScheduledTimer {
  readonly callback: () => void;
  readonly delay: number;
  active: boolean;
}

function captureAdmission(message: object, options?: object): CapturedAdmission {
  return {
    message: message as CapturedNotice,
    options: options as CapturedSendOptions | undefined,
  };
}

function snapshotAdmission(admission: CapturedAdmission): CapturedAdmission {
  return structuredClone(admission);
}
function installTimerHarness(): {
  readonly delays: () => number[];
  readonly latest: () => ScheduledTimer | undefined;
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
    latest: () => timers.at(-1),
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

function startRun(store: ReturnType<typeof createStore>, id: string, name: string): RunSnapshot {
  const run: RunSnapshot = { id, name, inputs: {}, status: "running", stages: [], startedAt: 1 };
  store.recordRunStart(run);
  return run;
}

const completedConfig = { enabled: true, notifyOn: ["completed"] as const };

describe("workflow lifecycle admission failure recovery", () => {
  test("rejected admission retries the complete original envelope with capped exponential delays", async () => {
    const timers = installTimerHarness();
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const attempts: CapturedAdmission[] = [];
    const notifyOn: WorkflowLifecycleNoticeKind[] = ["completed"];
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = installWorkflowLifecycleNotifications({
        store,
        state,
        seedExisting: false,
        config: { enabled: true, notifyOn },
        sendMessage(message, options) {
          attempts.push(captureAdmission(message, options));
          return Promise.reject(new Error("parent admission rejected"));
        },
      });
      const liveRun = startRun(store, "run-backoff", 'original "workflow" \\ raw');
      assert.equal(store.recordRunEnd("run-backoff", "completed", {}), true);
      await flushMicrotasks();

      const originalAttempt = attempts[0];
      assert.ok(originalAttempt);
      const originalEnvelope = snapshotAdmission(originalAttempt);
      const originalDetails = originalAttempt.message.details;
      assert.ok(originalDetails);
      assert.equal(
        originalEnvelope.message.content,
        '✓ Workflow "original \\"workflow\\" \\\\ raw" completed (run run-backoff). Inspect: /workflow status run-backoff',
      );
      assert.equal(originalEnvelope.message.customType, LIFECYCLE_NOTICE_CUSTOM_TYPE);
      assert.equal(originalEnvelope.message.display, true);
      assert.deepEqual(originalEnvelope.options, {
        triggerTurn: true,
        deliverAs: "steer",
        persistWhenStreaming: true,
      });
      assert.deepEqual(Object.keys(originalDetails).sort(), [
        "createdAt",
        "durationMs",
        "kind",
        "runId",
        "scope",
        "status",
        "workflowName",
      ]);

      const mutableRunSource = liveRun as { name: string; durationMs?: number };
      mutableRunSource.name = "mutated workflow source";
      mutableRunSource.durationMs = -1;
      notifyOn[0] = "failed";

      for (const expectedDelay of [20, 40, 80, 160, 320, 640, 1_000]) {
        assert.equal(timers.delays().at(-1), expectedDelay);
        timers.runNext();
        await flushMicrotasks();
      }

      assert.deepEqual(timers.delays(), [20, 40, 80, 160, 320, 640, 1_000, 1_000]);
      assert.equal(attempts.length, 8);
      for (const attempt of attempts) {
        assert.deepEqual(snapshotAdmission(attempt), originalEnvelope);
        assert.equal(attempt.message.details, originalDetails);
      }
      assert.equal(state.deliveredTerminalRuns.size, 0);
      assert.equal(state.retryableTerminalNotices.size, 1);
    } finally {
      unsubscribe?.();
      timers.restore();
    }
  });

  test("a failed admission retries its retained envelope after reinstall without a store snapshot", async () => {
    const timers = installTimerHarness();
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const firstAdmissions: CapturedAdmission[] = [];
    const replacementAdmissions: CapturedAdmission[] = [];
    let firstUnsubscribe: (() => void) | undefined;
    let replacementUnsubscribe: (() => void) | undefined;
    try {
      firstUnsubscribe = installWorkflowLifecycleNotifications({
        store,
        state,
        seedExisting: false,
        config: completedConfig,
        sendMessage(message, options) {
          firstAdmissions.push(captureAdmission(message, options));
          return Promise.reject(new Error("retained admission rejected"));
        },
      });
      const liveRun = startRun(store, "run-failed-reinstall", "retained original workflow");
      assert.equal(store.recordRunEnd("run-failed-reinstall", "completed", { version: "original" }), true);
      await flushMicrotasks();

      assert.equal(firstAdmissions.length, 1);
      const originalAdmission = firstAdmissions[0];
      assert.ok(originalAdmission);
      const originalEnvelope = snapshotAdmission(originalAdmission);
      const originalDetails = originalAdmission.message.details;
      assert.ok(originalDetails);
      assert.equal(state.retryableTerminalNotices.size, 1);
      assert.equal(timers.activeCount(), 1);

      const mutableRunSource = liveRun as { name: string; durationMs?: number };
      mutableRunSource.name = "mutated after terminal failure";
      mutableRunSource.durationMs = -1;
      assert.equal(store.removeRun("run-failed-reinstall"), true);
      assert.equal(store.snapshot().runs.length, 0, "fresh scanning must have no terminal notice to reconstruct");
      firstUnsubscribe();
      firstUnsubscribe = undefined;
      assert.equal(timers.activeCount(), 0);

      replacementUnsubscribe = installWorkflowLifecycleNotifications({
        store,
        state,
        config: completedConfig,
        sendMessage(message, options) {
          replacementAdmissions.push(captureAdmission(message, options));
        },
      });

      assert.equal(replacementAdmissions.length, 1);
      assert.deepEqual(snapshotAdmission(replacementAdmissions[0]!), originalEnvelope);
      assert.equal(replacementAdmissions[0]?.message.details, originalDetails);
      assert.equal(state.retryableTerminalNotices.size, 0);
      assert.equal(state.deliveredTerminalRuns.size, 1);
    } finally {
      replacementUnsubscribe?.();
      firstUnsubscribe?.();
      timers.restore();
    }
  });

  test("an in-flight rejection hands the original payload to the active reinstallation", async () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const firstAdmission = Promise.withResolvers<void>();
    const firstMessages: CapturedAdmission[] = [];
    const replacementMessages: CapturedAdmission[] = [];
    const firstUnsubscribe = installWorkflowLifecycleNotifications({
      store,
      state,
      seedExisting: false,
      config: { enabled: true, notifyOn: ["completed", "failed"] },
      sendMessage(message, options) {
        firstMessages.push(captureAdmission(message, options));
        return firstAdmission.promise;
      },
    });
    let replacementUnsubscribe: (() => void) | undefined;
    try {
      startRun(store, "run-reinstall", "original workflow");
      assert.equal(store.recordRunEnd("run-reinstall", "completed", { version: "original" }), true);
      assert.equal(firstMessages.length, 1);
      const originalDetails = firstMessages[0]?.message.details;
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
        sendMessage(message, options) {
          replacementMessages.push(captureAdmission(message, options));
        },
      });

      firstAdmission.reject(new Error("old installation rejected admission"));
      await flushMicrotasks();

      assert.equal(firstMessages.length, 1);
      assert.equal(replacementMessages.length, 1);
      assert.equal(replacementMessages[0]?.message.details, originalDetails);
      assert.equal(replacementMessages[0]?.message.details?.workflowName, "original workflow");
      assert.equal(replacementMessages[0]?.message.details?.runId, "run-reinstall");
      assert.equal(state.retryableTerminalNotices.size, 0);
      assert.equal(state.deliveredTerminalRuns.size, 1);
    } finally {
      replacementUnsubscribe?.();
      firstUnsubscribe();
    }
  });

  test("the registered replacement lifecycle cancels old retries and does not wake the new chat", async () => {
    const timers = installTimerHarness();
    const handlers = new Map<string, ExtensionHandler>();
    const oldAdmissions: CapturedAdmission[] = [];
    let replacementWakeCount = 0;
    let activeChat: "old" | "replacement" = "old";
    const pi: ExtensionAPI = {
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerMessageRenderer: () => undefined,
      registerFlag: () => undefined,
      registerShortcut: () => undefined,
      on: (event, handler) => {
        handlers.set(event, handler as ExtensionHandler);
      },
      sendMessage(message, options) {
        if (activeChat === "old") {
          oldAdmissions.push(captureAdmission(message, options));
          return Promise.reject(new Error("old chat rejected admission"));
        }
        replacementWakeCount += 1;
      },
      disableAsyncDiscovery: true,
    };
    extensionStore.clear();
    factory(pi);
    const sessionStart = handlers.get("session_start");
    const sessionShutdown = handlers.get("session_shutdown");
    assert.ok(sessionStart);
    assert.ok(sessionShutdown);
    try {
      await Promise.resolve(sessionStart({ reason: "startup" }, { hasUI: false }));
      startRun(extensionStore, "run-old-session", "old session workflow");
      assert.equal(extensionStore.recordRunEnd("run-old-session", "completed", {}), true);
      await flushMicrotasks();
      assert.equal(oldAdmissions.length, 1);
      const oldRetryTimer = timers.latest();
      assert.ok(oldRetryTimer);
      assert.equal(oldRetryTimer.delay, 20);
      assert.equal(oldRetryTimer.active, true);

      await Promise.resolve(sessionShutdown({ reason: "new" }));
      assert.equal(oldRetryTimer.active, false, "the host boundary must cancel the old retry timer");
      activeChat = "replacement";
      await Promise.resolve(sessionStart({ reason: "new" }, { hasUI: false }));
      await flushMicrotasks();

      assert.equal(replacementWakeCount, 0, "retained old-chat delivery must clear before replacement activation");
      assert.equal(extensionStore.snapshot().runs.length, 0);
      startRun(extensionStore, "run-unrelated", "unrelated new chat workflow");
      await flushMicrotasks();
      assert.equal(replacementWakeCount, 0, "a non-terminal unrelated run must not wake the replacement chat");
      assert.equal(oldRetryTimer.active, false);
    } finally {
      await Promise.resolve(sessionShutdown({ reason: "new" }));
      extensionStore.clear();
      timers.restore();
    }
  });
});
