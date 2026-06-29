// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createWorkflowLifecycleNotificationState,
  installWorkflowLifecycleNotifications,
  formatWorkflowLifecycleNoticeText,
  LIFECYCLE_NOTICE_CUSTOM_TYPE,
  LIFECYCLE_NOTICE_SNIPPET_LIMIT,
  registerLifecycleNoticeRenderer,
  resetWorkflowLifecycleNotificationState,
  seedWorkflowLifecycleNotificationState,
  withWorkflowLifecycleNotificationsSuppressed,
  withWorkflowLifecycleNotificationsSuppressedAsync,
  type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

interface SentMessage {
  readonly customType: string;
  readonly content?: string;
  readonly display?: boolean;
  readonly details?: WorkflowLifecycleNoticeDetails;
}

interface CardComponent {
  render(width: number): string[];
  invalidate?(): void;
}

interface RegisteredRenderer {
  readonly event: string;
  readonly renderer: (payload: unknown) => unknown;
}

type SendOptions = {
  readonly triggerTurn?: boolean;
  readonly deliverAs?: "steer" | "followUp" | "nextTurn" | "interrupt";
};

const config = {
  enabled: true,
  notifyOn: ["completed", "failed", "blocked", "awaiting_input"] as const,
};

function runningStage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    id: "stage-1",
    name: "planner",
    status: "running",
    parentIds: [],
    toolEvents: [],
    ...overrides,
  };
}

function prompt(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    id: "prompt-1",
    kind: "confirm",
    message: "Proceed with this plan?",
    createdAt: 10,
    ...overrides,
  };
}

function install() {
  const store = createStore();
  const state = createWorkflowLifecycleNotificationState();
  const sent: SentMessage[] = [];
  const options: SendOptions[] = [];
  const unsubscribe = installWorkflowLifecycleNotifications({
    store,
    config,
    state,
    sendMessage(message, sendOptions) {
      sent.push(message as SentMessage);
      options.push(sendOptions ?? {});
    },
  });
  return { store, state, sent, options, unsubscribe };
}

function installWithState(
  store: ReturnType<typeof createStore>,
  state: ReturnType<typeof createWorkflowLifecycleNotificationState>,
  sent: SentMessage[],
): () => void {
  return installWorkflowLifecycleNotifications({
    store,
    config,
    state,
    seedExisting: true,
    sendMessage(message) { sent.push(message as SentMessage); },
  });
}

function startRun(store: ReturnType<typeof createStore>, id: string, name = id): void {
  store.recordRunStart({ id, name, inputs: {}, status: "running", stages: [], startedAt: 1 });
}

describe("installWorkflowLifecycleNotifications", () => {
  test("emits one completion notice when a run completes", () => {
    const { store, sent, options } = install();
    store.recordRunStart({ id: "run-1", name: "release", inputs: {}, status: "running", stages: [], startedAt: 1 });

    assert.equal(store.recordRunEnd("run-1", "completed", {}, undefined), true);
    store.recordNotice({ id: "nudge", level: "info", message: "force notify", createdAt: 3 });

    assert.equal(sent.length, 1);
    assert.deepEqual(options, [{ triggerTurn: true, deliverAs: "steer" }]);
    assert.equal(sent[0]?.customType, LIFECYCLE_NOTICE_CUSTOM_TYPE);
    assert.equal(sent[0]?.display, true);
    assert.equal(sent[0]?.details?.kind, "completed");
    assert.equal(sent[0]?.details?.scope, "run");
    assert.equal(sent[0]?.details?.workflowName, "release");
    assert.match(sent[0]?.content ?? "", /\/workflow status run-1/);
  });

  test("uses blocked lifecycle notices for runs ending with blocked status", () => {
    const { store, sent } = install();
    store.recordRunStart({ id: "run-blocked", name: "release", inputs: {}, status: "running", stages: [], startedAt: 1 });

    assert.equal(store.recordRunEnd("run-blocked", "blocked", { status: "blocked", summary: "checks are still pending" }, "checks are still pending"), true);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.details?.kind, "blocked");
    assert.equal(sent[0]?.details?.status, "blocked");
    assert.equal(sent[0]?.details?.error, "checks are still pending");
    assert.match(sent[0]?.content ?? "", /ended blocked.*checks are still pending/u);
    assert.doesNotMatch(sent[0]?.content ?? "", /✓/u);
  });

  test("includes ctx.exit blocked reasons in lifecycle notices", () => {
    const { store, sent } = install();
    startRun(store, "run-exit-blocked", "release");

    assert.equal(
      store.recordRunEnd("run-exit-blocked", "blocked", undefined, undefined, {
        exited: true,
        exitReason: "waiting for approval",
      }),
      true,
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.details?.kind, "blocked");
    assert.equal(sent[0]?.details?.error, "waiting for approval");
    assert.match(sent[0]?.content ?? "", /ended blocked.*waiting for approval/u);
  });

  test("seeds historical completed runs using returned failed or blocked status", () => {
    const store = createStore();
    const sent: SentMessage[] = [];
    startRun(store, "run-legacy-failed", "legacy failed");
    store.recordRunEnd("run-legacy-failed", "completed", { status: "failed", summary: "old failure" });
    startRun(store, "run-legacy-blocked", "legacy blocked");
    store.recordRunEnd("run-legacy-blocked", "completed", { status: "blocked", summary: "old blocker" });

    installWorkflowLifecycleNotifications({
      store,
      config,
      state: createWorkflowLifecycleNotificationState(),
      sendMessage(message) { sent.push(message as SentMessage); },
    });
    store.recordNotice({ id: "history-tick", level: "info", message: "tick", createdAt: 13 });

    assert.deepEqual(sent, []);
  });

  test("emits failure notice with stage and truncated error context", () => {
    const { store, sent, options } = install();
    const longError = `${"No API key. ".repeat(40)}tail`;
    store.recordRunStart({ id: "run-2", name: "deploy", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart("run-2", runningStage({ id: "stage-2", name: "publish" }));

    assert.equal(store.recordRunEnd("run-2", "failed", undefined, longError, { failedStageId: "stage-2" }), true);

    assert.equal(sent.length, 1);
    assert.deepEqual(options, [{ triggerTurn: true, deliverAs: "steer" }]);
    assert.equal(sent[0]?.details?.kind, "failed");
    assert.equal(sent[0]?.details?.stageName, "publish");
    assert.equal(sent[0]?.details?.error?.length, LIFECYCLE_NOTICE_SNIPPET_LIMIT);
    assert.match(sent[0]?.details?.error ?? "", /…$/);
  });

  test("tracks a stage pending prompt without waking the main chat", () => {
    const { store, state, sent, options } = install();
    store.recordRunStart({ id: "run-3", name: "review", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart("run-3", runningStage());

    assert.equal(store.recordStagePendingPrompt("run-3", "stage-1", prompt()), true);
    store.recordNotice({ id: "tick", level: "info", message: "force notify", createdAt: 11 });

    assert.equal(sent.length, 0);
    assert.deepEqual(options, []);
    assert.equal(state.deliveredInputPrompts.size, 1);
  });

  test("tracks ask_user_question-style stages without waking the main chat", () => {
    const { store, state, sent, options } = install();
    store.recordRunStart({ id: "run-4", name: "qa", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart("run-4", runningStage({ id: "stage-ask", name: "question" }));
    assert.equal(store.recordStageInputRequest("run-4", "stage-ask", {
      id: "ask-1",
      kind: "ask_user_question",
      createdAt: 122,
      questions: [{ question: "What color?", options: [{ label: "Red" }, { label: "Blue" }] }],
    }), true);

    assert.equal(store.recordStageAwaitingInput("run-4", "stage-ask", true, 123), true);

    assert.equal(sent.length, 0);
    assert.deepEqual(options, []);
    assert.equal(state.deliveredInputPrompts.size, 1);
  });

  test("tracks a fresh promptless awaiting-input state after resolving a structured stage prompt", () => {
    const { store, state, sent } = install();
    const runId = "run-stale-footprint";
    const stageId = "stage-mixed";

    startRun(store, runId, "stale footprint");
    store.recordStageStart(runId, runningStage({ id: stageId, name: "mixed" }));

    assert.equal(
      store.recordStagePendingPrompt(
        runId,
        stageId,
        prompt({ id: "prompt-1", message: "Old structured prompt", createdAt: 10 }),
      ),
      true,
    );
    assert.equal(store.resolveStagePendingPrompt(runId, stageId, "prompt-1", "accepted"), true);
    assert.equal(store.recordStageAwaitingInput(runId, stageId, true, 123), true);

    assert.equal(sent.length, 0);
    assert.equal(state.deliveredInputPrompts.size, 2);
  });

  test("dedupes repeated promptless pauses by awaitingInputSince instead of stale prompt footprint", () => {
    const { store, state, sent } = install();
    const runId = "run-promptless-dedupe";
    const stageId = "stage-repeat";

    startRun(store, runId, "promptless dedupe");
    store.recordStageStart(runId, runningStage({ id: stageId, name: "repeat" }));

    assert.equal(
      store.recordStagePendingPrompt(runId, stageId, prompt({ id: "prompt-1", createdAt: 10 })),
      true,
    );
    assert.equal(store.resolveStagePendingPrompt(runId, stageId, "prompt-1", true), true);
    assert.equal(store.recordStageAwaitingInput(runId, stageId, true, 123), true);
    store.recordNotice({ id: "same-pause-tick", level: "info", message: "tick", createdAt: 124 });
    assert.equal(store.recordStageAwaitingInput(runId, stageId, false), true);
    assert.equal(store.recordStageAwaitingInput(runId, stageId, true, 456), true);

    assert.equal(sent.length, 0);
    assert.equal(state.deliveredInputPrompts.size, 3);
  });

  test("uses a new prompt id for a second structured stage prompt", () => {
    const { store, state, sent } = install();
    const runId = "run-second-prompt";
    const stageId = "stage-structured";

    startRun(store, runId, "second prompt");
    store.recordStageStart(runId, runningStage({ id: stageId, name: "structured" }));

    assert.equal(
      store.recordStagePendingPrompt(runId, stageId, prompt({ id: "prompt-1", createdAt: 10 })),
      true,
    );
    assert.equal(store.resolveStagePendingPrompt(runId, stageId, "prompt-1", false), true);
    assert.equal(
      store.recordStagePendingPrompt(
        runId,
        stageId,
        prompt({ id: "prompt-2", message: "New prompt", createdAt: 20 }),
      ),
      true,
    );

    assert.equal(sent.length, 0);
    assert.equal(state.deliveredInputPrompts.size, 2);
  });

  test("respects disabled and notifyOn filtering", () => {
    const store = createStore();
    const sent: SentMessage[] = [];
    installWorkflowLifecycleNotifications({
      store,
      config: { enabled: true, notifyOn: ["failed"] },
      sendMessage(message) { sent.push(message as SentMessage); },
    });
    store.recordRunStart({ id: "run-5", name: "filtered", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordRunEnd("run-5", "completed", {});
    assert.equal(sent.length, 0);

    installWorkflowLifecycleNotifications({
      store,
      config: { enabled: false, notifyOn: ["completed", "failed", "awaiting_input"] },
      sendMessage(message) { sent.push(message as SentMessage); },
    });
    store.recordRunStart({ id: "run-6", name: "disabled", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordRunEnd("run-6", "failed", undefined, "boom");
    assert.equal(sent.length, 1);
  });

  test("tracks a run-level pending prompt without waking the main chat", () => {
    const { store, state, sent, options } = install();
    startRun(store, "run-prompt", "legacy");

    assert.equal(store.recordPendingPrompt("run-prompt", prompt({ id: "run-prompt-1" })), true);

    assert.equal(sent.length, 0);
    assert.deepEqual(options, []);
    assert.equal(state.deliveredInputPrompts.size, 1);
  });

  test("suppresses run-level pending prompt when notifyOn excludes awaiting_input", () => {
    const store = createStore();
    const sent: SentMessage[] = [];
    installWorkflowLifecycleNotifications({
      store,
      config: { enabled: true, notifyOn: ["completed", "failed"] },
      sendMessage(message) { sent.push(message as SentMessage); },
    });
    startRun(store, "run-filtered-prompt", "legacy filtered");

    assert.equal(store.recordPendingPrompt("run-filtered-prompt", prompt({ id: "filtered-prompt" })), true);

    assert.equal(sent.length, 0);
  });

  test("shared state dedupes terminal notices across reinstall", () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const sent: SentMessage[] = [];
    const unsubscribe = installWithState(store, state, sent);
    startRun(store, "run-dedupe", "dedupe");
    store.recordRunEnd("run-dedupe", "completed", {});
    unsubscribe();
    installWithState(store, state, sent);
    startRun(store, "run-other", "other");

    assert.deepEqual(sent.map((message) => message.details?.runId), ["run-dedupe"]);
  });

  test("omitted seedExisting treats current terminal runs and prompts as history", () => {
    const store = createStore();
    startRun(store, "run-old", "old");
    store.recordRunEnd("run-old", "completed", {});
    startRun(store, "run-old-prompt", "old prompt");
    store.recordPendingPrompt("run-old-prompt", prompt({ id: "old-prompt" }));

    const sent: SentMessage[] = [];
    installWorkflowLifecycleNotifications({
      store,
      config,
      state: createWorkflowLifecycleNotificationState(),
      sendMessage(message) { sent.push(message as SentMessage); },
    });
    store.recordNotice({ id: "tick", level: "info", message: "tick", createdAt: 11 });
    startRun(store, "run-new", "new");
    store.recordRunEnd("run-new", "completed", {});

    assert.deepEqual(sent.map((message) => message.details?.runId), ["run-new"]);
  });

  test("resetting shared state allows reused run IDs across session boundaries", () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const sent: SentMessage[] = [];
    let unsubscribe = installWithState(store, state, sent);
    startRun(store, "run-reused", "first session");
    store.recordRunEnd("run-reused", "completed", {});
    unsubscribe();

    store.clear();
    resetWorkflowLifecycleNotificationState(state);
    unsubscribe = installWithState(store, state, sent);
    startRun(store, "run-reused", "second session");
    store.recordRunEnd("run-reused", "completed", {});
    unsubscribe();

    assert.deepEqual(sent.map((message) => message.details?.workflowName), ["first session", "second session"]);
  });

  test("restore suppression after reset seeds restored history without emitting", () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const sent: SentMessage[] = [];
    installWorkflowLifecycleNotifications({
      store,
      config,
      state,
      sendMessage(message) { sent.push(message as SentMessage); },
    });

    startRun(store, "run-before-reset", "before reset");
    store.recordRunEnd("run-before-reset", "completed", {});
    store.clear();
    resetWorkflowLifecycleNotificationState(state);

    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "run-restored-after-reset", name: "restored after reset", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.run.end", payload: { runId: "run-restored-after-reset", status: "completed", result: {}, ts: 2 } },
    ];

    withWorkflowLifecycleNotificationsSuppressed(state, () => {
      restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "never", persistRuns: true }, store);
      seedWorkflowLifecycleNotificationState(state, store.snapshot());
    });
    store.recordNotice({ id: "after-reset-restore", level: "info", message: "tick", createdAt: 12 });
    startRun(store, "run-live-after-reset", "live after reset");
    store.recordRunEnd("run-live-after-reset", "completed", {});

    assert.deepEqual(sent.map((message) => message.details?.runId), ["run-before-reset", "run-live-after-reset"]);
  });

  test("suppression seeds actual restore replay without emitting", () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const sent: SentMessage[] = [];
    installWorkflowLifecycleNotifications({
      store,
      config,
      state,
      sendMessage(message) { sent.push(message as SentMessage); },
    });
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "run-restored", name: "restored", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.run.end", payload: { runId: "run-restored", status: "failed", error: "old failure", ts: 2 } },
    ];

    withWorkflowLifecycleNotificationsSuppressed(state, () => {
      restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "never", persistRuns: true }, store);
    });
    store.recordNotice({ id: "after-restore", level: "info", message: "tick", createdAt: 12 });
    startRun(store, "run-live", "live");
    store.recordRunEnd("run-live", "failed", undefined, "live failure");

    assert.deepEqual(sent.map((message) => message.details?.runId), ["run-live"]);
  });

});
