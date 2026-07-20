import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  createWorkflowLifecycleNotificationState,
  installWorkflowLifecycleNotifications,
  LIFECYCLE_NOTICE_CUSTOM_TYPE,
  resetWorkflowLifecycleNotificationState,
  withWorkflowLifecycleNotificationsSuppressed,
  type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";

const config = {
  enabled: true,
  notifyOn: ["completed", "failed", "blocked", "awaiting_input"] as const,
};

interface SentMessage {
  readonly customType?: string;
  readonly details?: WorkflowLifecycleNoticeDetails;
}

function startRecoverableRun(
  store: ReturnType<typeof createStore>,
  runId: string,
  parentRunId?: string,
): number {
  const run: RunSnapshot = {
    id: runId,
    name: "recoverable",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: 1,
    ...(parentRunId === undefined ? {} : { parentRunId }),
  };
  store.recordRunStart(run);
  const blockedAt = Date.now();
  assert.equal(store.recordRunBlocked(runId, "Configure credentials and resume.", {
    failureKind: "auth",
    failureCode: "missing_api_key",
    failureRecoverability: "recoverable",
    failureDisposition: "active_blocked",
    failureMessage: "No API key for provider: github-copilot",
    failedStageId: "reviewer-a",
    resumable: true,
    blockedAt,
  }), true);
  return blockedAt;
}

function install(
  store: ReturnType<typeof createStore>,
  state = createWorkflowLifecycleNotificationState(),
) {
  const sent: SentMessage[] = [];
  const unsubscribe = installWorkflowLifecycleNotifications({
    store,
    state,
    config,
    sendMessage(message) {
      sent.push(message as SentMessage);
    },
  });
  return { sent, state, unsubscribe };
}

describe("active recoverable blocked lifecycle notices", () => {
  test("emits one blocked notice at blockedAt and dedupes later snapshots", () => {
    const store = createStore();
    const { sent } = install(store);

    const blockedAt = startRecoverableRun(store, "live-blocked");
    store.recordNotice({ id: "tick", level: "info", message: "tick", createdAt: blockedAt + 1 });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.customType, LIFECYCLE_NOTICE_CUSTOM_TYPE);
    assert.equal(sent[0]?.details?.kind, "blocked");
    assert.equal(sent[0]?.details?.status, "blocked");
    assert.equal(sent[0]?.details?.active, true);
    assert.equal(sent[0]?.details?.createdAt, blockedAt);
    assert.equal(sent[0]?.details?.error, "No API key for provider: github-copilot");
  });

  test("re-notifies when the same runId blocks again at a new blockedAt occurrence", () => {
    const store = createStore();
    const { sent } = install(store);

    // First occurrence under a reused id (e.g. after a same-run resume).
    const firstAt = startRecoverableRun(store, "reused-id");
    store.recordNotice({ id: "tick1", level: "info", message: "tick", createdAt: firstAt + 1 });
    assert.equal(sent.length, 1);

    // A second blocked occurrence under the same id but a new blockedAt must
    // emit a fresh notice (per-occurrence dedupe key), not be suppressed.
    assert.equal(store.recordRunBlocked("reused-id", "Configure credentials and resume.", {
      failureKind: "auth",
      failureCode: "missing_api_key",
      failureRecoverability: "recoverable",
      failureDisposition: "active_blocked",
      failureMessage: "No API key for provider: github-copilot",
      failedStageId: "reviewer-a",
      resumable: true,
      blockedAt: firstAt + 500,
    }), true);
    store.recordNotice({ id: "tick2", level: "info", message: "tick", createdAt: firstAt + 501 });

    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.details?.kind, "blocked");
    assert.equal(sent[1]?.details?.createdAt, firstAt + 500);
  });

  test("seeds a historical active block without notifying the new chat", () => {
    const store = createStore();
    const blockedAt = startRecoverableRun(store, "historical-blocked");
    const { sent } = install(store);

    store.recordNotice({ id: "history-tick", level: "info", message: "tick", createdAt: blockedAt + 1 });

    assert.deepEqual(sent, []);
  });

  test("consumes an active block created under lifecycle suppression", () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const { sent } = install(store, state);

    withWorkflowLifecycleNotificationsSuppressed(state, () => {
      startRecoverableRun(store, "suppressed-blocked");
    });
    store.recordNotice({ id: "after-suppression", level: "info", message: "tick", createdAt: Date.now() });

    assert.deepEqual(sent, []);
  });

  test("emits a later completion once when the same resumable run completes", () => {
    const store = createStore();
    const { sent } = install(store);

    startRecoverableRun(store, "resumed-completion");
    assert.equal(store.recordRunEnd("resumed-completion", "completed", {}), true);

    assert.deepEqual(sent.map((message) => message.details?.kind), ["blocked", "completed"]);
  });
  test("authoritative terminal status wins over retained recoverable stage metadata", () => {
    const store = createStore();
    startRecoverableRun(store, "terminal-source");
    store.recordStageStart("terminal-source", {
      id: "reviewer-a",
      name: "reviewer-a",
      status: "failed",
      parentIds: [],
      toolEvents: [],
      error: "No API key",
      failureKind: "auth",
      failureRecoverability: "recoverable",
      failureDisposition: "active_blocked",
      failureMessage: "No API key",
    });

    assert.equal(store.recordRunEnd("terminal-source", "killed", undefined, "continued elsewhere"), true);
    const source = store.runs().find((run) => run.id === "terminal-source");

    assert.ok(source);
    assert.equal(source.status, "killed");
    assert.equal(effectiveRunStatus(source), "killed");
  });


  test("retries a rejected chat admission and marks delivery only after acceptance", async () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const sent: SentMessage[] = [];
    let attempts = 0;
    const unsubscribe = installWorkflowLifecycleNotifications({
      store,
      state,
      config,
      sendMessage(message) {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("admission rejected"));
        sent.push(message as SentMessage);
        return Promise.resolve();
      },
    });

    const retryBlockedAt = startRecoverableRun(store, "retry-blocked");
    assert.equal(state.deliveredTerminalRuns.has(`blocked:retry-blocked:${retryBlockedAt}`), false);
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(attempts, 2);
    assert.equal(sent.length, 1);
    assert.equal(state.deliveredTerminalRuns.has(`blocked:retry-blocked:${retryBlockedAt}`), true);
    unsubscribe();
  });

  test("keeps retrying while the invoking chat remains active", async () => {
    const store = createStore();
    let attempts = 0;
    const sent: SentMessage[] = [];
    const unsubscribe = installWorkflowLifecycleNotifications({
      store,
      config,
      sendMessage(message) {
        attempts += 1;
        if (attempts < 4) return Promise.reject(new Error("temporary admission outage"));
        sent.push(message as SentMessage);
        return Promise.resolve();
      },
    });

    startRecoverableRun(store, "retry-fourth-attempt");
    await new Promise((resolve) => setTimeout(resolve, 180));

    assert.equal(attempts, 4);
    assert.equal(sent.length, 1);
    unsubscribe();
  });

  test("retries the retained blocked payload after the run is consumed", async () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const sent: SentMessage[] = [];
    let attempts = 0;
    const unsubscribe = installWorkflowLifecycleNotifications({
      store,
      state,
      config,
      sendMessage(message) {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("admission rejected"));
        sent.push(message as SentMessage);
        return Promise.resolve();
      },
    });
    startRecoverableRun(store, "consumed-after-rejection");
    assert.equal(store.recordRunEnd("consumed-after-rejection", "killed", undefined, "resumed"), true);

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(attempts, 2);
    assert.equal(sent[0]?.details?.kind, "blocked");
    assert.equal(sent[0]?.details?.runId, "consumed-after-rejection");
    unsubscribe();
  });

  test("retries a failed admission across notification reinstallation", async () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const rejected = installWorkflowLifecycleNotifications({
      store,
      state,
      config,
      sendMessage() { return Promise.reject(new Error("session replaced")); },
    });
    const reinstallBlockedAt = startRecoverableRun(store, "reinstall-blocked");
    await new Promise((resolve) => setTimeout(resolve, 40));
    rejected();

    const sent: SentMessage[] = [];
    const installed = installWorkflowLifecycleNotifications({
      store,
      state,
      config,
      sendMessage(message) { sent.push(message as SentMessage); return Promise.resolve(); },
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(sent.length, 1);
    assert.equal(state.deliveredTerminalRuns.has(`blocked:reinstall-blocked:${reinstallBlockedAt}`), true);
    installed();
  });
  test("does not re-send a still-pending admission across a config reinstall", async () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    let resolveOld!: () => void;
    let oldSends = 0;
    const disposed = installWorkflowLifecycleNotifications({
      store,
      state,
      config,
      sendMessage() {
        oldSends += 1;
        return new Promise<void>((resolve) => { resolveOld = resolve; });
      },
    });
    const pendingBlockedAt = startRecoverableRun(store, "pending-reinstall");
    await Promise.resolve();
    disposed();

    const newSends: SentMessage[] = [];
    const reinstalled = installWorkflowLifecycleNotifications({
      store,
      state,
      config,
      sendMessage(message) { newSends.push(message as SentMessage); return Promise.resolve(); },
    });

    resolveOld();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(oldSends, 1);
    assert.deepEqual(newSends, []);
    assert.equal(state.deliveredTerminalRuns.has(`blocked:pending-reinstall:${pendingBlockedAt}`), true);
    assert.equal(state.retryableTerminalNotices.has(`blocked:pending-reinstall:${pendingBlockedAt}`), false);
    reinstalled();
  });


  test("drops a pending admission when its invoking session is replaced", async () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    let rejectPending!: (error: Error) => void;
    const pending = installWorkflowLifecycleNotifications({
      store,
      state,
      config,
      sendMessage() {
        return new Promise<void>((_resolve, reject) => { rejectPending = reject; });
      },
    });
    startRecoverableRun(store, "pending-shutdown");
    pending();
    store.clear();
    resetWorkflowLifecycleNotificationState(state);

    const sent: SentMessage[] = [];
    const replacement = installWorkflowLifecycleNotifications({
      store,
      state,
      config,
      sendMessage(message) { sent.push(message as SentMessage); },
    });
    rejectPending(new Error("old session shut down"));
    await Promise.resolve();

    assert.deepEqual(sent, []);
    assert.equal(state.retryableTerminalRuns.size, 0);
    assert.equal(state.retryableTerminalNotices.size, 0);
    replacement();
  });

  test("does not notify for a nested active blocked child run", () => {
    const store = createStore();
    const { sent } = install(store);

    startRecoverableRun(store, "child-blocked", "parent-run");

    assert.deepEqual(sent, []);
  });
});
