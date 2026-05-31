import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  HIL_ANSWER_NOTICE_CUSTOM_TYPE,
  installWorkflowHilAnswerNotifications,
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

type SendOptions = {
  readonly triggerTurn?: boolean;
  readonly deliverAs?: "steer" | "followUp" | "nextTurn" | "interrupt";
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
  test("emits one interrupt notice when a simple stage prompt is answered", () => {
    const { store, sent, options, unsubscribe } = setup();

    assert.equal(store.recordStagePendingPrompt("run-1", "stage-1", pendingPrompt()), true);
    assert.equal(store.resolveStagePendingPrompt("run-1", "stage-1", "prompt-1", "swordfish"), true);
    store.recordNotice({ id: "tick", level: "info", message: "force notify", createdAt: 20 });
    store.clearStagePromptAnswer("run-1", "stage-1");

    assert.equal(sent.length, 1);
    assert.deepEqual(options, [{ triggerTurn: true, deliverAs: "interrupt" }]);
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
    assert.equal(sent[0]?.details?.answerIncluded, false);
    assert.equal(typeof sent[0]?.details?.answeredAt, "number");
    assert.match(sent[0]?.content ?? "", /received the answer/);
    assert.match(sent[0]?.content ?? "", /Do not ask the same question again/);
    assert.doesNotMatch(sent[0]?.content ?? "", /swordfish/);
    assert.doesNotMatch(JSON.stringify(sent[0]?.details), /swordfish/);
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

  test("emits an interrupt notice when a brokered structured prompt is answered", async () => {
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
    assert.deepEqual(options, [{ triggerTurn: true, deliverAs: "interrupt" }]);
    assert.equal(sent[0]?.customType, HIL_ANSWER_NOTICE_CUSTOM_TYPE);
    assert.equal(sent[0]?.details?.promptId, "ask-1");
    assert.equal(sent[0]?.details?.promptKind, "ask_user_question");
    assert.equal(sent[0]?.details?.answerAvailable, true);
    assert.equal(sent[0]?.details?.answerIncluded, false);
    assert.match(sent[0]?.content ?? "", /already received the user's response|stage has already received the user's response/);
    assert.doesNotMatch(sent[0]?.content ?? "", /Blue/);
    assert.doesNotMatch(JSON.stringify(sent[0]?.details), /Blue/);
    unsubscribe();
  });
});
