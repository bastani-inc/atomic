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
  test("emits one failure notice with tool origin and no fabricated stage id", () => {
    const { store, sent } = install();
    store.recordRunStart({ id: "run-tool-fail", name: "mutate", inputs: {}, status: "running", stages: [], toolNodes: [], startedAt: 1 });
    store.recordToolNodeStart("run-tool-fail", {
      kind: "tool", id: "tool:failure", name: "publish-api", argsHash: "hash", ordinal: 1,
      parentIds: [], status: "pending", attachable: false,
    });
    store.recordToolNodeRunning("run-tool-fail", "tool:failure", 2);
    store.recordToolNodeEnd("run-tool-fail", "tool:failure", { status: "failed", endedAt: 3, error: "remote rejected" });

    assert.equal(store.recordRunEnd("run-tool-fail", "failed", undefined, "remote rejected", {
      failedToolNodeId: "tool:failure",
    }), true);
    store.recordNotice({ id: "tool-fail-tick", level: "info", message: "tick", createdAt: 4 });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.details?.toolNodeId, "tool:failure");
    assert.equal(sent[0]?.details?.toolName, "publish-api");
    assert.equal(sent[0]?.details?.failedStageId, undefined);
    assert.match(sent[0]?.content ?? "", /tool publish-api.*remote rejected/);
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
    assert.match(text, /Respond: \/workflow connect/);
    assert.match(text, /workflow\(\{ action: "send"/);
    assert.ok(text.includes(`runId: ${JSON.stringify(runId)}`));
    assert.ok(text.includes(`stageId: ${JSON.stringify(stageId)}`));
    assert.ok(text.includes(`promptId: ${JSON.stringify(promptId)}`));
  });

  test("awaiting-input states do not enqueue visible steer messages", () => {
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const options: SendOptions[] = [];
    installWorkflowLifecycleNotifications({
      store,
      state,
      config: { enabled: true, notifyOn: ["awaiting_input"] },
      sendMessage(_message, sendOptions) { options.push(sendOptions ?? {}); },
    });
    store.recordRunStart({ id: "run-awaiting-turn", name: "turn", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart("run-awaiting-turn", runningStage({ id: "stage-awaiting-turn" }));
    assert.equal(store.recordStageAwaitingInput("run-awaiting-turn", "stage-awaiting-turn", true, 2), true);
    assert.deepEqual(options, []);
    assert.equal(state.deliveredInputPrompts.size, 1);
  });

  test("always triggers a steer turn for emitted terminal lifecycle notices", () => {
    const store = createStore();
    const options: SendOptions[] = [];
    installWorkflowLifecycleNotifications({
      store,
      config: { enabled: true, notifyOn: ["completed"] },
      sendMessage(_message, sendOptions) { options.push(sendOptions ?? {}); },
    });
    store.recordRunStart({ id: "run-7", name: "turn", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordRunEnd("run-7", "completed", {});
    assert.deepEqual(options, [{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true }]);
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
    const lines = (rendered as CardComponent).render(80);
    const text = lines.join("\n");
    assert.match(text, /╭ WORKFLOW COMPLETE/);
    assert.match(text, /✓ Workflow "cards" completed/);
    assert.match(text, /workflow\s+cards/);
    assert.match(text, /run\s+run-card/);
    assert.match(text, /▸ \/workflow status run-card/);
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

  test("restoration seeding preserves pending and retryable live terminal admissions", () => {
    const state = createWorkflowLifecycleNotificationState();
    state.pendingTerminalRuns.set("completed:pending-live:", Symbol("pending"));
    state.retryableTerminalRuns.add("completed:retry-live:");
    const completed = (id: string) => ({
      id, name: id, inputs: {}, status: "completed" as const, stages: [], startedAt: 1, endedAt: 2,
    });

    seedWorkflowLifecycleNotificationState(state, {
      runs: [completed("pending-live"), completed("retry-live"), completed("history")], notices: [], version: 1,
    });

    assert.equal(state.deliveredTerminalRuns.has("completed:pending-live:"), false);
    assert.equal(state.deliveredTerminalRuns.has("completed:retry-live:"), false);
    assert.equal(state.deliveredTerminalRuns.has("completed:history:"), true);
    assert.equal(state.pendingTerminalRuns.has("completed:pending-live:"), true);
    assert.equal(state.retryableTerminalRuns.has("completed:retry-live:"), true);
  });

  test("failed lifecycle cards render tool origin with name and node-id fallback", () => {
    const registered: RegisteredRenderer[] = [];
    registerLifecycleNoticeRenderer({
      rendererHost: {},
      registerMessageRenderer(event, renderer) {
        registered.push({ event, renderer: renderer as (payload: unknown) => unknown });
      },
    });
    const render = (details: WorkflowLifecycleNoticeDetails, width: number): string[] =>
      (registered[0]?.renderer({ details }) as CardComponent).render(width);
    const base: WorkflowLifecycleNoticeDetails = {
      kind: "failed", scope: "run", runId: "tool-failed", workflowName: "publish", status: "failed", createdAt: 1,
      error: "publish rejected", toolNodeId: "tool:failure", toolName: "publish-api",
    };

    const named = render(base, 80).join("\n");
    assert.match(named, /tool\s+publish-api/);
    assert.doesNotMatch(named, /stage\s+/);
    const fallback = render({ ...base, toolName: "" }, 80).join("\n");
    assert.match(fallback, /tool\s+tool:failure/);
    const stageWins = render({ ...base, stageName: "model-stage" }, 80).join("\n");
    assert.match(stageWins, /stage\s+model-stage/);
    assert.doesNotMatch(stageWins, /tool\s+publish-api/);
    const narrow = render({ ...base, toolName: "" }, 24);
    assert.match(narrow.join("\n"), /tool[\s\S]*tool:failure/);
    assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
  });
});
