import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import {
  buildStagePromptAdapter,
  coerceStageInputAnswer,
  parseAskUserQuestionArgs,
} from "../../packages/workflows/src/shared/stage-prompt.js";

const COLOR_ARGS = {
  questions: [
    {
      question: "What is your favorite color?",
      header: "Fav color",
      options: [
        { label: "Red", description: "A warm, bold color." },
        { label: "Green", description: "A fresh, natural color." },
        { label: "Blue", description: "A cool, calm color." },
      ],
    },
  ],
};

type BuiltResult = {
  answers: Array<{
    questionIndex: number;
    question: string;
    kind: string;
    answer: string | null;
    selected?: string[];
  }>;
  cancelled: boolean;
};

describe("parseAskUserQuestionArgs", () => {
  test("parses questions, options, header, and multiSelect", () => {
    const questions = parseAskUserQuestionArgs({
      questions: [
        {
          question: "Pick features",
          header: "Features",
          multiSelect: true,
          options: [{ label: "A", description: "a" }, { label: "B" }],
        },
      ],
    });
    assert.ok(questions);
    assert.equal(questions!.length, 1);
    assert.equal(questions![0]!.question, "Pick features");
    assert.equal(questions![0]!.header, "Features");
    assert.equal(questions![0]!.multiSelect, true);
    assert.deepEqual(questions![0]!.options.map((o) => o.label), ["A", "B"]);
  });

  test("returns undefined for malformed / empty args", () => {
    assert.equal(parseAskUserQuestionArgs(undefined), undefined);
    assert.equal(parseAskUserQuestionArgs({}), undefined);
    assert.equal(parseAskUserQuestionArgs({ questions: [] }), undefined);
    assert.equal(parseAskUserQuestionArgs({ questions: [{ header: "x" }] }), undefined);
  });
});

describe("buildStagePromptAdapter", () => {
  test("returns undefined when no parseable question is present", () => {
    assert.equal(buildStagePromptAdapter("id", "ask_user_question", {}, 1), undefined);
  });

  test("exposes a serializable prompt descriptor", () => {
    const adapter = buildStagePromptAdapter("prompt-1", "ask_user_question", COLOR_ARGS, 1234);
    assert.ok(adapter);
    assert.deepEqual(JSON.parse(JSON.stringify(adapter!.prompt)), {
      id: "prompt-1",
      kind: "ask_user_question",
      createdAt: 1234,
      questions: [
        {
          question: "What is your favorite color?",
          header: "Fav color",
          options: [
            { label: "Red", description: "A warm, bold color." },
            { label: "Green", description: "A fresh, natural color." },
            { label: "Blue", description: "A cool, calm color." },
          ],
        },
      ],
    });
  });

  test("matches an option label case-insensitively → kind option", () => {
    const adapter = buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!;
    const result = adapter.buildResult({ text: "blue" }) as BuiltResult;
    assert.equal(result.cancelled, false);
    assert.deepEqual(result.answers, [
      { questionIndex: 0, question: "What is your favorite color?", kind: "option", answer: "Blue" },
    ]);
  });

  test("matches a 1-based option index → kind option", () => {
    const adapter = buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!;
    const result = adapter.buildResult({ text: "2" }) as BuiltResult;
    assert.equal(result.answers[0]!.kind, "option");
    assert.equal(result.answers[0]!.answer, "Green");
  });

  test("free text that matches no option → kind custom", () => {
    const adapter = buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!;
    const result = adapter.buildResult({ text: "teal" }) as BuiltResult;
    assert.equal(result.answers[0]!.kind, "custom");
    assert.equal(result.answers[0]!.answer, "teal");
  });

  test("explicit optionLabels take precedence over text", () => {
    const adapter = buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!;
    const result = adapter.buildResult({ optionLabels: ["Red"], text: "ignored" }) as BuiltResult;
    assert.equal(result.answers[0]!.kind, "option");
    assert.equal(result.answers[0]!.answer, "Red");
  });

  test("empty / missing answer → cancelled", () => {
    const adapter = buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!;
    const result = adapter.buildResult({}) as BuiltResult;
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.answers, []);
  });

  test("raw answer is forwarded verbatim", () => {
    const adapter = buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!;
    const raw = { answers: [{ questionIndex: 0, question: "x", kind: "option", answer: "Green" }], cancelled: false };
    assert.equal(adapter.buildResult({ raw }), raw);
  });

  test("multiSelect resolves comma-separated labels and indices into selected", () => {
    const adapter = buildStagePromptAdapter(
      "p",
      "ask_user_question",
      {
        questions: [
          {
            question: "Pick colors",
            multiSelect: true,
            options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }],
          },
        ],
      },
      1,
    )!;
    const result = adapter.buildResult({ text: "red, 3" }) as BuiltResult;
    assert.equal(result.answers[0]!.kind, "multi");
    assert.equal(result.answers[0]!.answer, null);
    assert.deepEqual(result.answers[0]!.selected, ["Red", "Blue"]);
  });

  test("readiness-gate advance label resolves to the advance option", () => {
    const advanceLabel = "I'm ready to move on to the next workflow stage.";
    const adapter = buildStagePromptAdapter(
      "readiness-gate-s1",
      "readiness_gate",
      {
        questions: [
          {
            question: "Any additional points to explore before moving on?",
            header: "Continue?",
            options: [
              { label: advanceLabel, description: "advance" },
              { label: "I have more to explore or ask about.", description: "stay" },
            ],
          },
        ],
      },
      1,
    )!;
    const advance = adapter.buildResult({ text: advanceLabel }) as BuiltResult;
    assert.equal(advance.answers[0]!.answer, advanceLabel);
    // Index "1" also selects the advance option.
    const byIndex = adapter.buildResult({ text: "1" }) as BuiltResult;
    assert.equal(byIndex.answers[0]!.answer, advanceLabel);
  });
});

const ADVANCE_LABEL = "I'm ready to move on to the next workflow stage.";

describe("coerceStageInputAnswer", () => {
  test("plain string → text", () => {
    assert.deepEqual(coerceStageInputAnswer("Blue"), { text: "Blue" });
  });

  test("non-JSON string with a leading brace stays plain text", () => {
    assert.deepEqual(coerceStageInputAnswer("{not json"), { text: "{not json" });
  });

  test("JSON-string questions[] shape → extracted answer text", () => {
    // This is the exact shape `workflow send` forwarded that stranded the gate.
    const json = JSON.stringify({
      questions: [{ question: "Continue?", answer: ADVANCE_LABEL }],
    });
    assert.deepEqual(coerceStageInputAnswer(json), { text: ADVANCE_LABEL });
  });

  test("object questions[] shape → extracted answer text", () => {
    const value = { questions: [{ question: "Continue?", answer: ADVANCE_LABEL }] };
    assert.deepEqual(coerceStageInputAnswer(value), { text: ADVANCE_LABEL });
  });

  test("flat { answer } → text", () => {
    assert.deepEqual(coerceStageInputAnswer({ answer: "Green" }), { text: "Green" });
  });

  test("flat { label } → text", () => {
    assert.deepEqual(coerceStageInputAnswer({ label: "Red" }), { text: "Red" });
  });

  test("flat { response } string → text", () => {
    assert.deepEqual(coerceStageInputAnswer({ response: "Blue" }), { text: "Blue" });
  });

  test("{ selected: [...] } → optionLabels", () => {
    assert.deepEqual(coerceStageInputAnswer({ selected: ["A", "B"] }), {
      optionLabels: ["A", "B"],
    });
  });

  test("questions[] with selected → optionLabels", () => {
    assert.deepEqual(
      coerceStageInputAnswer({ questions: [{ selected: ["A", "C"] }] }),
      { optionLabels: ["A", "C"] },
    );
  });

  test("genuine QuestionnaireResult (answers carry questionIndex) is forwarded as raw verbatim", () => {
    const result = {
      answers: [{ questionIndex: 0, question: "Continue?", kind: "option", answer: ADVANCE_LABEL }],
      cancelled: false,
    };
    assert.deepEqual(coerceStageInputAnswer(result), { raw: result });
  });

  test("answers[] WITHOUT questionIndex is normalized, not raw-forwarded", () => {
    // The production decline: a loosely-shaped answers[] lacks questionIndex, so
    // forwarding it raw makes the tool envelope match no question and decline.
    assert.deepEqual(
      coerceStageInputAnswer({ answers: [{ question: "Continue?", answer: ADVANCE_LABEL }], cancelled: false }),
      { text: ADVANCE_LABEL },
    );
    assert.deepEqual(
      coerceStageInputAnswer({ answers: [{ selected: ["A", "B"] }] }),
      { optionLabels: ["A", "B"] },
    );
  });

  test("string array → optionLabels", () => {
    assert.deepEqual(coerceStageInputAnswer(["X", "Y"]), { optionLabels: ["X", "Y"] });
  });

  test("null / unusable primitives → empty answer", () => {
    assert.deepEqual(coerceStageInputAnswer(null), {});
    assert.deepEqual(coerceStageInputAnswer(undefined), {});
    assert.deepEqual(coerceStageInputAnswer(42), {});
  });

  test("end-to-end: structured response canonicalizes to the readiness advance option", () => {
    // coerce → adapter → the exact option label the readiness decision expects.
    const adapter = buildStagePromptAdapter(
      "readiness-gate-s1",
      "readiness_gate",
      {
        questions: [
          {
            question: "Any additional points to explore before moving on?",
            header: "Continue?",
            options: [
              { label: ADVANCE_LABEL, description: "advance" },
              { label: "I have more to explore or ask about.", description: "stay" },
            ],
          },
        ],
      },
      1,
    )!;
    for (const payload of [
      ADVANCE_LABEL,
      JSON.stringify({ questions: [{ question: "Continue?", answer: ADVANCE_LABEL }] }),
      { questions: [{ question: "Continue?", answer: ADVANCE_LABEL }] },
      { answers: [{ question: "Continue?", answer: ADVANCE_LABEL }], cancelled: false },
      { answer: ADVANCE_LABEL },
      "1",
    ]) {
      const result = adapter.buildResult(coerceStageInputAnswer(payload)) as BuiltResult;
      assert.equal(result.cancelled, false);
      assert.equal(result.answers[0]!.answer, ADVANCE_LABEL, `payload: ${JSON.stringify(payload)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Chat sentinel mapping (#1264)
// ---------------------------------------------------------------------------

describe("buildStagePromptAdapter — 'Chat about this' sentinel", () => {
  test("exact 'Chat about this' text → kind chat", () => {
    const adapter = buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!;
    const result = adapter.buildResult({ text: "Chat about this" }) as BuiltResult;
    assert.equal(result.cancelled, false);
    assert.equal(result.answers[0]!.kind, "chat");
    assert.equal(result.answers[0]!.answer, "Chat about this");
  });

  test("lowercase 'chat about this' → kind chat (case insensitive)", () => {
    const adapter = buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!;
    const result = adapter.buildResult({ text: "chat about this" }) as BuiltResult;
    assert.equal(result.answers[0]!.kind, "chat");
    assert.equal(result.answers[0]!.answer, "Chat about this");
  });

  test("leading/trailing whitespace → kind chat (whitespace tolerant)", () => {
    const adapter = buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!;
    const result = adapter.buildResult({ text: "  Chat about this  " }) as BuiltResult;
    assert.equal(result.answers[0]!.kind, "chat");
  });

  test("non-sentinel text still maps to kind custom", () => {
    const adapter = buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!;
    const result = adapter.buildResult({ text: "something else" }) as BuiltResult;
    assert.equal(result.answers[0]!.kind, "custom");
  });

  test("optionLabels matching 'Chat about this' → kind chat", () => {
    const adapter = buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!;
    const result = adapter.buildResult({ optionLabels: ["Chat about this"] }) as BuiltResult;
    assert.equal(result.answers[0]!.kind, "chat");
    assert.equal(result.answers[0]!.answer, "Chat about this");
  });

  test("multiSelect text matching 'Chat about this' → kind chat", () => {
    const adapter = buildStagePromptAdapter(
      "p",
      "ask_user_question",
      {
        questions: [
          {
            question: "Pick colors",
            multiSelect: true,
            options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }],
          },
        ],
      },
      1,
    )!;
    for (const text of ["Chat about this", "  chat ABOUT this  "]) {
      const result = adapter.buildResult({ text }) as BuiltResult;
      assert.equal(result.cancelled, false);
      assert.deepEqual(result.answers, [
        { questionIndex: 0, question: "Pick colors", kind: "chat", answer: "Chat about this" },
      ]);
    }
  });

  test("multiSelect optionLabels containing 'Chat about this' → kind chat", () => {
    const adapter = buildStagePromptAdapter(
      "p",
      "ask_user_question",
      {
        questions: [
          {
            question: "Pick colors",
            multiSelect: true,
            options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }],
          },
        ],
      },
      1,
    )!;
    const result = adapter.buildResult({ optionLabels: ["Red", " Chat about this "] }) as BuiltResult;
    assert.equal(result.answers[0]!.kind, "chat");
    assert.equal(result.answers[0]!.answer, "Chat about this");
    assert.equal(result.answers[0]!.selected, undefined);
  });

  test("multiSelect comma-split candidate containing 'Chat about this' → kind chat", () => {
    const adapter = buildStagePromptAdapter(
      "p",
      "ask_user_question",
      {
        questions: [
          {
            question: "Pick colors",
            multiSelect: true,
            options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }],
          },
        ],
      },
      1,
    )!;
    const result = adapter.buildResult({ text: "Red, Chat about this" }) as BuiltResult;
    assert.equal(result.answers[0]!.kind, "chat");
    assert.equal(result.answers[0]!.answer, "Chat about this");
    assert.equal(result.answers[0]!.selected, undefined);
  });
});
