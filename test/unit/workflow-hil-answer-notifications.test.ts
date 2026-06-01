import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  HIL_ANSWER_NOTICE_CUSTOM_TYPE,
  installWorkflowHilAnswerNotifications,
  registerHilAnswerNoticeRenderer,
  type WorkflowHilAnswerNoticeDetails,
} from "../../packages/workflows/src/extension/hil-answer-notifications.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

interface SentMessage {
  readonly customType: string;
  readonly content?: string;
  readonly display?: boolean;
  readonly details?: WorkflowHilAnswerNoticeDetails;
}

interface CardComponent {
  render(width: number): string[];
}

interface RegisteredRenderer {
  readonly event: string;
  readonly renderer: (payload: unknown) => unknown;
}

type SendOptions = {
  readonly triggerTurn?: boolean;
  readonly deliverAs?: "steer" | "followUp" | "nextTurn" | "interrupt";
  readonly excludeFromContext?: boolean;
  readonly interruptAbortMessage?: string;
};

const COLOR_ARGS = {
  questions: [
    {
      question: "What color?",
      options: [{ label: "Red" }, { label: "Blue" }],
    },
  ],
};

function runningStage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    id: "stage-1",
    name: "review",
    status: "running",
    parentIds: [],
    toolEvents: [],
    ...overrides,
  };
}

function pendingPrompt(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    id: "prompt-1",
    kind: "input",
    message: "Secret passphrase?",
    createdAt: 10,
    ...overrides,
  };
}

function setup() {
  const store = createStore();
  const broker = new StageUiBroker(store);
  const sent: SentMessage[] = [];
  const options: SendOptions[] = [];
  const unsubscribe = installWorkflowHilAnswerNotifications({
    store,
    stageUiBroker: broker,
    sendMessage(message, sendOptions) {
      sent.push(message as SentMessage);
      options.push(sendOptions ?? {});
    },
  });
  store.recordRunStart({ id: "run-1", name: "release", inputs: {}, status: "running", stages: [], startedAt: 1 });
  store.recordStageStart("run-1", runningStage());
  return { store, broker, sent, options, unsubscribe };
}

describe("installWorkflowHilAnswerNotifications", () => {
  test("emits one display-only notice when a simple stage prompt is answered", () => {
    const { store, sent, options, unsubscribe } = setup();

    assert.equal(store.recordStagePendingPrompt("run-1", "stage-1", pendingPrompt()), true);
    assert.equal(store.resolveStagePendingPrompt("run-1", "stage-1", "prompt-1", "swordfish"), true);
    store.recordNotice({ id: "tick", level: "info", message: "force notify", createdAt: 20 });
    store.clearStagePromptAnswer("run-1", "stage-1");

    assert.equal(sent.length, 1);
    assert.deepEqual(options[0], { triggerTurn: false, excludeFromContext: true });
    assert.equal(sent[0]?.customType, HIL_ANSWER_NOTICE_CUSTOM_TYPE);
    assert.equal(sent[0]?.display, true);
    assert.equal(sent[0]?.details?.kind, "hil_answered");
    assert.equal(sent[0]?.details?.scope, "stage");
    assert.equal(sent[0]?.details?.runId, "run-1");
    assert.equal(sent[0]?.details?.workflowName, "release");
    assert.equal(sent[0]?.details?.stageId, "stage-1");
    assert.equal(sent[0]?.details?.stageName, "review");
    assert.equal(sent[0]?.details?.promptId, "prompt-1");
    assert.equal(sent[0]?.details?.promptKind, "input");
    assert.equal(sent[0]?.details?.answerAvailable, true);
    assert.equal(sent[0]?.details?.answerIncluded, true);
    assert.equal(sent[0]?.details?.answerSummary, "swordfish");
    assert.equal(sent[0]?.details?.promptMessage, "Secret passphrase?");
    assert.equal(typeof sent[0]?.details?.answeredAt, "number");
    assert.match(sent[0]?.content ?? "", /received the user's response/);
    assert.match(sent[0]?.content ?? "", /User responded with: swordfish/);
    assert.match(sent[0]?.content ?? "", /Do not ask the same question again/);
    assert.match(sent[0]?.content ?? "", /No main-chat action is needed/);
    assert.match(sent[0]?.content ?? "", /do not answer any other workflow human-in-the-loop prompt unless the user explicitly provides that answer/);
    unsubscribe();
  });

  test("does not notify when a simple prompt is cleared without recording an answer", () => {
    const { store, sent, unsubscribe } = setup();

    assert.equal(store.recordStagePendingPrompt("run-1", "stage-1", pendingPrompt()), true);
    assert.equal(
      store.resolveStagePendingPrompt("run-1", "stage-1", "prompt-1", "discarded", { recordAnswer: false }),
      true,
    );

    assert.deepEqual(sent, []);
    unsubscribe();
  });

  test("does not notify when a simple prompt is answered by the workflow tool", () => {
    const { store, sent, unsubscribe } = setup();

    assert.equal(store.recordStagePendingPrompt("run-1", "stage-1", pendingPrompt()), true);
    assert.equal(
      store.resolveStagePendingPrompt("run-1", "stage-1", "prompt-1", "from tool", { answerSource: "workflow_tool" }),
      true,
    );
    store.recordNotice({ id: "tick", level: "info", message: "force notify", createdAt: 20 });

    assert.deepEqual(sent, []);
    unsubscribe();
  });

  test("emits a display-only notice when a brokered structured prompt is answered", async () => {
    const { broker, sent, options, unsubscribe } = setup();
    const adapter = buildStagePromptAdapter("ask-1", "ask_user_question", COLOR_ARGS, 1)!;
    broker.provideStagePrompt("run-1", "stage-1", adapter);

    const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }));

    assert.equal(broker.answerStagePrompt("run-1", "stage-1", { text: "Blue" }), true);
    await pending;

    assert.equal(sent.length, 1);
    assert.deepEqual(options[0], { triggerTurn: false, excludeFromContext: true });
    assert.equal(sent[0]?.customType, HIL_ANSWER_NOTICE_CUSTOM_TYPE);
    assert.equal(sent[0]?.details?.promptId, "ask-1");
    assert.equal(sent[0]?.details?.promptKind, "ask_user_question");
    assert.equal(sent[0]?.details?.answerAvailable, true);
    assert.equal(sent[0]?.details?.answerIncluded, true);
    assert.equal(sent[0]?.details?.answerSummary, "What color? → Blue");
    assert.equal(sent[0]?.details?.promptMessage, "What color?");
    assert.match(sent[0]?.content ?? "", /User responded with: What color\? → Blue/);
    assert.match(sent[0]?.content ?? "", /No main-chat action is needed/);
    unsubscribe();
  });

  test("does not notify when a brokered structured prompt is answered by the workflow tool", async () => {
    const { broker, sent, unsubscribe } = setup();
    const adapter = buildStagePromptAdapter("ask-1", "ask_user_question", COLOR_ARGS, 1)!;
    broker.provideStagePrompt("run-1", "stage-1", adapter);

    const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }));

    assert.equal(broker.answerStagePrompt("run-1", "stage-1", { text: "Blue" }, { answerSource: "workflow_tool" }), true);
    await pending;

    assert.deepEqual(sent, []);
    unsubscribe();
  });

  test("registers HiL answer renderer once per host and returns a notice card", () => {
    const host = {};
    const registered: RegisteredRenderer[] = [];
    registerHilAnswerNoticeRenderer({
      rendererHost: host,
      registerMessageRenderer(event, renderer) {
        registered.push({ event, renderer: renderer as (payload: unknown) => unknown });
      },
    });
    registerHilAnswerNoticeRenderer({
      rendererHost: host,
      registerMessageRenderer(event, renderer) {
        registered.push({ event, renderer: renderer as (payload: unknown) => unknown });
      },
    });

    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.event, HIL_ANSWER_NOTICE_CUSTOM_TYPE);
    const rendered = registered[0]?.renderer({
      details: {
        kind: "hil_answered",
        scope: "stage",
        runId: "run-card",
        workflowName: "release",
        stageId: "stage-1",
        stageName: "review",
        promptId: "prompt-1",
        promptKind: "input",
        promptMessage: "Secret passphrase?",
        answeredAt: 1,
        answerAvailable: true,
        answerIncluded: true,
        answerSummary: "swordfish",
      } satisfies WorkflowHilAnswerNoticeDetails,
    });

    assert.equal(typeof rendered, "object");
    assert.notEqual(rendered, null);
    const lines = (rendered as CardComponent).render(80);
    const text = lines.join("\n");
    assert.match(text, /╭ HIL ANSWERED/);
    assert.match(text, /✓ Workflow "release" received the user's response/);
    assert.match(text, /stage\s+review/);
    assert.match(text, /answer\s+swordfish/);
    for (const width of [80, 40, 24]) {
      for (const line of (rendered as CardComponent).render(width)) {
        assert.ok(line.length === 0 || line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").length <= width);
      }
    }
  });
});
