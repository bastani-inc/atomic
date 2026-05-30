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
  readonly deliverAs?: "steer" | "followUp" | "nextTurn";
};

const config = {
  enabled: true,
  notifyOn: ["completed", "failed", "awaiting_input"] as const,
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
  const sent: SentMessage[] = [];
  const options: SendOptions[] = [];
  const unsubscribe = installWorkflowLifecycleNotifications({
    store,
    config,
    sendMessage(message, sendOptions) {
      sent.push(message as SentMessage);
      options.push(sendOptions ?? {});
    },
  });
  return { store, sent, options, unsubscribe };
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

  test("emits awaiting-input notice for a stage pending prompt", () => {
    const { store, sent, options } = install();
    store.recordRunStart({ id: "run-3", name: "review", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart("run-3", runningStage());

    assert.equal(store.recordStagePendingPrompt("run-3", "stage-1", prompt()), true);

    assert.equal(sent.length, 1);
    assert.deepEqual(options, [{ triggerTurn: true, deliverAs: "steer" }]);
    assert.equal(sent[0]?.details?.kind, "awaiting_input");
    assert.equal(sent[0]?.details?.scope, "stage");
    assert.equal(sent[0]?.details?.promptId, "prompt-1");
    assert.match(sent[0]?.content ?? "", /workflow\(\{ action: "send"/);
  });

  test("emits awaiting-input notice for ask_user_question-style stages", () => {
    const { store, sent } = install();
    store.recordRunStart({ id: "run-4", name: "qa", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart("run-4", runningStage({ id: "stage-ask", name: "question" }));

    assert.equal(store.recordStageAwaitingInput("run-4", "stage-ask", true, 123), true);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.details?.kind, "awaiting_input");
    assert.equal(sent[0]?.details?.scope, "stage");
    assert.equal(sent[0]?.details?.stageId, "stage-ask");
    assert.equal(sent[0]?.details?.createdAt, 123);
    assert.match(sent[0]?.content ?? "", /Respond: \/workflow connect run-4\./);
    assert.doesNotMatch(sent[0]?.content ?? "", /workflow\(\{ action: "send"/);
    assert.doesNotMatch(sent[0]?.content ?? "", /promptId: ""/);
  });

  test("emits promptless awaiting-input after resolving a structured stage prompt", () => {
    const { store, sent } = install();
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

    const structuredPromptNotice = sent[0]?.details;
    const promptlessNotice = sent[1]?.details;

    assert.equal(sent.length, 2);
    assert.equal(structuredPromptNotice?.promptId, "prompt-1");
    assert.equal(promptlessNotice?.stageId, stageId);
    assert.equal(promptlessNotice?.createdAt, 123);
    assert.equal(promptlessNotice?.promptId, undefined);
    assert.equal(promptlessNotice?.promptKind, undefined);
    assert.equal(promptlessNotice?.promptMessage, undefined);
    assert.doesNotMatch(sent[1]?.content ?? "", /Old structured prompt/);
  });

  test("dedupes repeated promptless pauses by awaitingInputSince instead of stale prompt footprint", () => {
    const { store, sent } = install();
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

    assert.deepEqual(sent.map((message) => message.details?.createdAt), [10, 123, 456]);
    assert.deepEqual(sent.map((message) => message.details?.promptId), ["prompt-1", undefined, undefined]);
  });

  test("uses a new prompt id for a second structured stage prompt", () => {
    const { store, sent } = install();
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

    assert.deepEqual(sent.map((message) => message.details?.promptId), ["prompt-1", "prompt-2"]);
    assert.equal(sent[1]?.details?.createdAt, 20);
    assert.equal(sent[1]?.details?.promptMessage, "New prompt");
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

  test("emits awaiting-input notice for a run-level pending prompt", () => {
    const { store, sent } = install();
    startRun(store, "run-prompt", "legacy");

    assert.equal(store.recordPendingPrompt("run-prompt", prompt({ id: "run-prompt-1" })), true);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.details?.kind, "awaiting_input");
    assert.equal(sent[0]?.details?.scope, "run");
    assert.equal(sent[0]?.details?.promptId, "run-prompt-1");
    assert.equal(sent[0]?.details?.stageId, undefined);
    assert.match(sent[0]?.content ?? "", /run-level prompt/);
    assert.doesNotMatch(sent[0]?.content ?? "", /stageId/);
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

  test("async suppression stays active until the awaited operation settles", async () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const sent: SentMessage[] = [];
    installWorkflowLifecycleNotifications({
      store,
      config,
      state,
      sendMessage(message) { sent.push(message as SentMessage); },
    });

    startRun(store, "run-async-suppressed", "async suppressed");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const suppressed = withWorkflowLifecycleNotificationsSuppressedAsync(
      state,
      async () => {
        await gate;
        return "done";
      },
    );

    assert.equal(state.suppressionDepth, 1);
    assert.equal(store.recordRunEnd("run-async-suppressed", "completed", {}), true);
    assert.equal(sent.length, 0);

    release();
    assert.equal(await suppressed, "done");
    assert.equal(state.suppressionDepth, 0);

    store.recordNotice({ id: "after-async-suppression", level: "info", message: "tick", createdAt: 13 });
    assert.equal(sent.length, 0, "suppressed terminal notice should remain marked delivered");

    startRun(store, "run-after-async-suppression", "after async suppression");
    store.recordRunEnd("run-after-async-suppression", "completed", {});
    assert.deepEqual(sent.map((message) => message.details?.runId), ["run-after-async-suppression"]);
  });

  test("escapes workflow names and structured response ids in notice text", () => {
    const runId = 'run"\\id';
    const stageId = 'stage"\\id';
    const promptId = 'prompt"\\id';
    const text = formatWorkflowLifecycleNoticeText({
      kind: "awaiting_input",
      scope: "stage",
      runId,
      workflowName: 'release "canary"',
      status: "awaiting_input",
      stageId,
      stageName: 'review "gate"',
      promptId,
      promptKind: "confirm",
      promptMessage: "Approve?",
      createdAt: 1,
    });

    assert.match(text, /Workflow "release \\"canary\\"" needs input/);
    assert.match(text, /workflow\(\{ action: "send"/);
    assert.ok(text.includes(`runId: ${JSON.stringify(runId)}`));
    assert.ok(text.includes(`stageId: ${JSON.stringify(stageId)}`));
    assert.ok(text.includes(`promptId: ${JSON.stringify(promptId)}`));
  });

  test("always triggers a steer turn for emitted lifecycle notices", () => {
    const store = createStore();
    const options: SendOptions[] = [];
    installWorkflowLifecycleNotifications({
      store,
      config: { enabled: true, notifyOn: ["completed"] },
      sendMessage(_message, sendOptions) { options.push(sendOptions ?? {}); },
    });
    store.recordRunStart({ id: "run-7", name: "turn", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordRunEnd("run-7", "completed", {});
    assert.deepEqual(options, [{ triggerTurn: true, deliverAs: "steer" }]);
  });

  test("warns about send failures when workflow debug logging is enabled", () => {
    const store = createStore();
    const previousDebug = process.env.ATOMIC_WORKFLOW_DEBUG;
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    process.env.ATOMIC_WORKFLOW_DEBUG = "1";
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      installWorkflowLifecycleNotifications({
        store,
        config: { enabled: true, notifyOn: ["completed"] },
        sendMessage() {
          throw new Error("send failed");
        },
      });
      store.recordRunStart({ id: "run-debug-throw", name: "debug", inputs: {}, status: "running", stages: [], startedAt: 1 });
      assert.equal(store.recordRunEnd("run-debug-throw", "completed", {}), true);
    } finally {
      console.warn = originalWarn;
      if (previousDebug === undefined) {
        delete process.env.ATOMIC_WORKFLOW_DEBUG;
      } else {
        process.env.ATOMIC_WORKFLOW_DEBUG = previousDebug;
      }
    }

    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0] ?? ""), /workflow lifecycle notice/i);
    assert.match(String(warnings[0]?.[1] ?? ""), /send failed/);
  });

  test("does not warn about send failures unless workflow debug logging is enabled", () => {
    const store = createStore();
    const previousDebug = process.env.ATOMIC_WORKFLOW_DEBUG;
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    delete process.env.ATOMIC_WORKFLOW_DEBUG;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      installWorkflowLifecycleNotifications({
        store,
        config: { enabled: true, notifyOn: ["completed"] },
        sendMessage() {
          throw new Error("send failed");
        },
      });
      store.recordRunStart({ id: "run-debug-off", name: "debug off", inputs: {}, status: "running", stages: [], startedAt: 1 });
      assert.equal(store.recordRunEnd("run-debug-off", "completed", {}), true);
    } finally {
      console.warn = originalWarn;
      if (previousDebug === undefined) {
        delete process.env.ATOMIC_WORKFLOW_DEBUG;
      } else {
        process.env.ATOMIC_WORKFLOW_DEBUG = previousDebug;
      }
    }

    assert.equal(warnings.length, 0);
  });

  test("swallows synchronous send failures so sibling subscribers still receive snapshots", () => {
    const store = createStore();
    const seenStatuses: string[] = [];
    installWorkflowLifecycleNotifications({
      store,
      config: { enabled: true, notifyOn: ["completed"] },
      sendMessage() {
        throw new Error("send failed");
      },
    });
    const unsubscribeSibling = store.subscribe((snapshot) => {
      const run = snapshot.runs.find((candidate) => candidate.id === "run-send-throw");
      if (run) seenStatuses.push(run.status);
    });

    store.recordRunStart({ id: "run-send-throw", name: "throw", inputs: {}, status: "running", stages: [], startedAt: 1 });
    assert.doesNotThrow(() => {
      assert.equal(store.recordRunEnd("run-send-throw", "completed", {}), true);
    });
    unsubscribeSibling();

    assert.deepEqual(seenStatuses, ["running", "completed"]);
  });

  test("swallows rejected send promises without surfacing unhandled rejections", async () => {
    const store = createStore();
    let siblingSawCompletion = false;
    installWorkflowLifecycleNotifications({
      store,
      config: { enabled: true, notifyOn: ["completed"] },
      sendMessage() {
        return Promise.reject(new Error("send rejected"));
      },
    });
    const unsubscribeSibling = store.subscribe((snapshot) => {
      siblingSawCompletion ||= snapshot.runs.some(
        (run) => run.id === "run-send-reject" && run.status === "completed",
      );
    });

    store.recordRunStart({ id: "run-send-reject", name: "reject", inputs: {}, status: "running", stages: [], startedAt: 1 });
    assert.equal(store.recordRunEnd("run-send-reject", "completed", {}), true);
    await Promise.resolve();
    unsubscribeSibling();

    assert.equal(siblingSawCompletion, true);
  });

  test("registers lifecycle renderer once per host and returns a notice card", () => {
    const host = {};
    const registered: RegisteredRenderer[] = [];
    registerLifecycleNoticeRenderer({
      rendererHost: host,
      registerMessageRenderer(event, renderer) {
        registered.push({ event, renderer: renderer as (payload: unknown) => unknown });
      },
    });
    registerLifecycleNoticeRenderer({
      rendererHost: host,
      registerMessageRenderer(event, renderer) {
        registered.push({ event, renderer: renderer as (payload: unknown) => unknown });
      },
    });

    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.event, LIFECYCLE_NOTICE_CUSTOM_TYPE);
    const rendered = registered[0]?.renderer({
      details: {
        kind: "completed",
        scope: "run",
        runId: "run-card",
        workflowName: "cards",
        status: "completed",
        createdAt: 1,
      } satisfies WorkflowLifecycleNoticeDetails,
    });

    assert.equal(typeof rendered, "object");
    assert.notEqual(rendered, null);
    assert.deepEqual((rendered as CardComponent).render(80), [
      '✅ Workflow "cards" completed (run run-card). Inspect: /workflow status run-card',
    ]);
  });

  test("wraps long lifecycle notices to the render width so no rendered line overflows the terminal (#1109 width-overflow crash)", () => {
    const registered: RegisteredRenderer[] = [];
    registerLifecycleNoticeRenderer({
      rendererHost: {},
      registerMessageRenderer(event, renderer) {
        registered.push({ event, renderer: renderer as (payload: unknown) => unknown });
      },
    });

    const details: WorkflowLifecycleNoticeDetails = {
      kind: "completed",
      scope: "run",
      runId: "a3df3bfb-bea6-4c68-a05c-3f7bac10cd13",
      workflowName: "deep-research-codebase",
      status: "completed",
      createdAt: 1,
    };
    const component = registered[0]?.renderer({ details }) as CardComponent;

    // Sanity: the single-line form really does overflow a normal terminal —
    // this is the line that crashed pi-tui ("Rendered line N exceeds terminal width").
    assert.ok(visibleWidth(formatWorkflowLifecycleNoticeText(details)) > 120);

    // No rendered line may ever exceed the render width — this is the invariant
    // pi-tui enforces with a hard throw, even at very narrow widths where the
    // UUID itself must be hard-broken across lines.
    for (const width of [120, 80, 40, 24]) {
      for (const line of component.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `line exceeds width ${width}: ${JSON.stringify(line)} (w=${visibleWidth(line)})`,
        );
      }
    }

    // Where the terminal is wide enough to hold the run id token, wrapping must
    // not drop it so `/workflow status <id>` stays usable.
    for (const width of [120, 80, 40]) {
      const lines = component.render(width);
      assert.ok(
        lines.some((line) => line.includes(details.runId)),
        `runId missing after wrap at width ${width}: ${JSON.stringify(lines)}`,
      );
    }
  });
});
