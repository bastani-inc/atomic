import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  askReadinessViaStageBroker,
  READINESS_GATE_ADVANCE_LABEL,
  READINESS_GATE_QUESTION_PARAMS,
  readinessResultMeansAdvance,
  toolResultHasChatAnswer,
} from "../../packages/workflows/src/runs/foreground/executor.js";
import { stageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import {
  buildStagePromptAdapter,
  coerceStageInputAnswer,
} from "../../packages/workflows/src/shared/stage-prompt.js";
import { buildQuestionnaireResponse } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/response-envelope.ts";
import type { QuestionParams } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";

const EXPLORE_LABEL = "I have more to explore or ask about.";

describe("readinessResultMeansAdvance", () => {
  test("exact advance label → advance", () => {
    assert.equal(
      readinessResultMeansAdvance({
        details: { answers: [{ answer: READINESS_GATE_ADVANCE_LABEL }], cancelled: false },
      }),
      true,
    );
  });

  test("case/whitespace variant of the advance label → advance", () => {
    assert.equal(
      readinessResultMeansAdvance({
        details: {
          answers: [{ answer: `   ${READINESS_GATE_ADVANCE_LABEL.toUpperCase()}   ` }],
          cancelled: false,
        },
      }),
      true,
    );
  });

  test("advance label carried in selected[] → advance", () => {
    assert.equal(
      readinessResultMeansAdvance({
        details: { answers: [{ selected: [READINESS_GATE_ADVANCE_LABEL] }], cancelled: false },
      }),
      true,
    );
  });

  test("explore option → stay", () => {
    assert.equal(
      readinessResultMeansAdvance({
        details: { answers: [{ answer: EXPLORE_LABEL }], cancelled: false },
      }),
      false,
    );
  });

  test("non-matching custom answer (the JSON string that stranded the gate) → stay", () => {
    const stranding = JSON.stringify({
      questions: [{ question: "Continue?", answer: READINESS_GATE_ADVANCE_LABEL }],
    });
    assert.equal(
      readinessResultMeansAdvance({ details: { answers: [{ answer: stranding }], cancelled: false } }),
      false,
    );
  });

  test("cancelled / missing details / missing answers → stay", () => {
    assert.equal(readinessResultMeansAdvance({ details: { answers: [], cancelled: true } }), false);
    assert.equal(readinessResultMeansAdvance({}), false);
    assert.equal(readinessResultMeansAdvance({ details: { cancelled: false } }), false);
    assert.equal(readinessResultMeansAdvance(undefined), false);
  });
});

// Full seam regression: orchestrator answer payload -> coerce -> gate adapter ->
// ask_user_question tool envelope (buildQuestionnaireResponse) -> readiness
// decision. Reproduces the real `workflow send` path that left the stage stuck.
describe("readiness gate end-to-end answer pipeline", () => {
  const gateParams = READINESS_GATE_QUESTION_PARAMS as unknown as QuestionParams;
  const adapter = buildStagePromptAdapter(
    "readiness-gate-s1",
    "readiness_gate",
    READINESS_GATE_QUESTION_PARAMS,
    1,
  )!;

  const decideFor = (payload: unknown): boolean => {
    const built = adapter.buildResult(coerceStageInputAnswer(payload));
    const toolResult = buildQuestionnaireResponse(
      built as Parameters<typeof buildQuestionnaireResponse>[0],
      gateParams,
    );
    return readinessResultMeansAdvance(toolResult);
  };

  test("every reasonable 'ready to move on' payload advances", () => {
    const advancePayloads: unknown[] = [
      READINESS_GATE_ADVANCE_LABEL,
      JSON.stringify({ questions: [{ question: "Continue?", answer: READINESS_GATE_ADVANCE_LABEL }] }),
      { questions: [{ question: "Continue?", answer: READINESS_GATE_ADVANCE_LABEL }] },
      { answer: READINESS_GATE_ADVANCE_LABEL },
      { label: READINESS_GATE_ADVANCE_LABEL },
      "1",
    ];
    for (const payload of advancePayloads) {
      assert.equal(decideFor(payload), true, `payload should advance: ${JSON.stringify(payload)}`);
    }
  });

  test("explore / index-2 payloads stay in the stage", () => {
    assert.equal(decideFor(EXPLORE_LABEL), false);
    assert.equal(decideFor("2"), false);
    assert.equal(decideFor({ answer: EXPLORE_LABEL }), false);
  });
});

// REAL end-to-end path: drives the executor's actual readiness gate through the
// shared StageUiBroker + the real ask_user_question tool, answering exactly the
// way `/workflow send` does (peek + answerStagePrompt). This is the path the
// prior isolated tests missed; the `answers[]`-without-questionIndex payload
// reproduces the live "User declined to answer questions" / stuck-stage bug.
describe("askReadinessViaStageBroker (real broker + tool resolution)", () => {
  // Answer the gate the moment it is shown to the host, mirroring `/workflow
  // send`: the brokered ctx.ui.custom() promise is resolved with the
  // adapter-built result derived from the orchestrator's answer payload.
  async function decideViaBroker(payload: unknown): Promise<"advance" | "stay"> {
    const runId = `run-${randomUUID()}`;
    const stageId = `stage-${randomUUID()}`;
    const controller = new AbortController();
    const unregister = stageUiBroker.registerHost(runId, stageId, {
      showCustomUi() {
        queueMicrotask(() => {
          stageUiBroker.answerStagePrompt(runId, stageId, coerceStageInputAnswer(payload));
        });
      },
    });
    try {
      return await askReadinessViaStageBroker(runId, stageId, controller.signal);
    } finally {
      unregister();
    }
  }

  test("every reasonable 'ready to move on' payload advances through the real tool", async () => {
    const advancePayloads: unknown[] = [
      READINESS_GATE_ADVANCE_LABEL,
      "1",
      JSON.stringify({ questions: [{ question: "Continue?", answer: READINESS_GATE_ADVANCE_LABEL }] }),
      { questions: [{ question: "Continue?", answer: READINESS_GATE_ADVANCE_LABEL }] },
      // The shape that declined in production: answers[] WITHOUT questionIndex.
      { answers: [{ question: "Continue?", answer: READINESS_GATE_ADVANCE_LABEL }], cancelled: false },
      { answer: READINESS_GATE_ADVANCE_LABEL },
      { label: READINESS_GATE_ADVANCE_LABEL },
      // A genuine, fully-formed QuestionnaireResult (carries questionIndex).
      {
        answers: [
          { questionIndex: 0, question: "Continue?", kind: "option", answer: READINESS_GATE_ADVANCE_LABEL },
        ],
        cancelled: false,
      },
    ];
    for (const payload of advancePayloads) {
      assert.equal(
        await decideViaBroker(payload),
        "advance",
        `payload should advance: ${JSON.stringify(payload)}`,
      );
    }
  });

  test("explore / index-2 / empty payloads stay in the stage", async () => {
    assert.equal(await decideViaBroker(EXPLORE_LABEL), "stay");
    assert.equal(await decideViaBroker("2"), "stay");
    assert.equal(await decideViaBroker({ answer: EXPLORE_LABEL }), "stay");
    assert.equal(await decideViaBroker({}), "stay");
  });
});

// ---------------------------------------------------------------------------
// toolResultHasChatAnswer — readiness gate bypass helper (#1264)
// ---------------------------------------------------------------------------

describe("toolResultHasChatAnswer", () => {
  test("tool result with kind:chat answer → true", () => {
    const result = {
      content: [{ type: "text", text: "..." }],
      details: {
        answers: [{ questionIndex: 0, question: "Continue?", kind: "chat", answer: "Chat about this" }],
        cancelled: false,
      },
      terminate: true,
    };
    assert.equal(toolResultHasChatAnswer(result), true);
  });

  test("tool result with kind:option answer → false", () => {
    const result = {
      content: [{ type: "text", text: "..." }],
      details: {
        answers: [{ questionIndex: 0, question: "Continue?", kind: "option", answer: "Yes" }],
        cancelled: false,
      },
    };
    assert.equal(toolResultHasChatAnswer(result), false);
  });

  test("tool result with kind:custom answer → false", () => {
    const result = {
      content: [{ type: "text", text: "..." }],
      details: {
        answers: [{ questionIndex: 0, question: "Continue?", kind: "custom", answer: "maybe" }],
        cancelled: false,
      },
    };
    assert.equal(toolResultHasChatAnswer(result), false);
  });

  test("null / undefined / non-object → false", () => {
    assert.equal(toolResultHasChatAnswer(null), false);
    assert.equal(toolResultHasChatAnswer(undefined), false);
    assert.equal(toolResultHasChatAnswer("string"), false);
    assert.equal(toolResultHasChatAnswer(42), false);
  });

  test("missing details → false", () => {
    assert.equal(toolResultHasChatAnswer({ content: [] }), false);
  });

  test("empty answers → false", () => {
    assert.equal(toolResultHasChatAnswer({ details: { answers: [], cancelled: false } }), false);
  });

  test("cancelled result with chat kind → still true (kind check only)", () => {
    const result = {
      details: {
        answers: [{ kind: "chat", answer: "Chat about this" }],
        cancelled: true,
      },
    };
    // The function checks kind only; cancelled is for the envelope layer.
    assert.equal(toolResultHasChatAnswer(result), true);
  });
});
