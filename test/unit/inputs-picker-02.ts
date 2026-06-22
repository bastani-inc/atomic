import { test } from "bun:test";
import assert from "node:assert/strict";
import { coerceValues, createInputsPickerState, handleInputsPickerInput } from "../../packages/workflows/src/tui/inputs-picker.ts";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.ts";
import { FIELDS, KB } from "./inputs-picker-helpers.js";

export function registerInputsPickerSuite2(): void {
  // ── Key handling ───────────────────────────────────────────────────────────

  test("text field: typing inserts characters, backspace removes", () => {
    const s = createInputsPickerState(FIELDS);
    handleInputsPickerInput("h", s, FIELDS, KB);
    handleInputsPickerInput("i", s, FIELDS, KB);
    assert.equal(s.rawText.prompt, "hi");
    assert.equal(s.caret, 2);
    handleInputsPickerInput("\x7f", s, FIELDS, KB);
    assert.equal(s.rawText.prompt, "h");
    assert.equal(s.caret, 1);
  });

  test("text field accepts encoded printable key sequences", () => {
    for (const [key, expected] of [
      ["\x1b[98;1u", "b"], // Kitty / CSI-u plain b
      ["\x1b[65;2u", "A"], // Kitty / CSI-u shifted A
      ["\x1b[27;1;98~", "b"], // xterm modifyOtherKeys plain b
      ["\x1b[27;2;65~", "A"], // xterm modifyOtherKeys shifted A
    ] as const) {
      const s = createInputsPickerState(FIELDS);
      handleInputsPickerInput(key, s, FIELDS, KB);
      assert.equal(s.rawText.prompt, expected, `key=${JSON.stringify(key)}`);
      assert.equal(s.caret, expected.length, `key=${JSON.stringify(key)}`);
    }
  });

  test("text field: CJK, emoji, and combining-mark edits move by grapheme", () => {
    const s = createInputsPickerState(FIELDS);
    handleInputsPickerInput("漢", s, FIELDS, KB);
    handleInputsPickerInput("👩‍💻", s, FIELDS, KB);
    handleInputsPickerInput("e", s, FIELDS, KB);
    handleInputsPickerInput("\u0301", s, FIELDS, KB);
    assert.equal(s.rawText.prompt, "漢👩‍💻é");
    assert.equal(s.caret, "漢👩‍💻é".length);

    handleInputsPickerInput("\x1b[D", s, FIELDS, KB); // left over the composed é
    assert.equal(s.caret, "漢👩‍💻".length);
    handleInputsPickerInput("\x7f", s, FIELDS, KB); // delete the whole emoji cluster
    assert.equal(s.rawText.prompt, "漢é");
    assert.equal(s.caret, "漢".length);
  });

  test("tab and shift+tab move focus, wrapping", () => {
    const s = createInputsPickerState(FIELDS);
    assert.equal(s.focusedIdx, 0);
    handleInputsPickerInput("\t", s, FIELDS, KB);
    assert.equal(s.focusedIdx, 1);
    handleInputsPickerInput("\x1b[Z", s, FIELDS, KB);
    assert.equal(s.focusedIdx, 0);
    // Wrap backward from 0 → Submit section.
    handleInputsPickerInput("\x1b[Z", s, FIELDS, KB);
    assert.equal(s.focusedIdx, FIELDS.length);
    // Tab from the last field moves to Submit, then wraps to the first field.
    s.focusedIdx = FIELDS.length - 1;
    handleInputsPickerInput("\t", s, FIELDS, KB);
    assert.equal(s.focusedIdx, FIELDS.length);
    handleInputsPickerInput("\t", s, FIELDS, KB);
    assert.equal(s.focusedIdx, 0);
  });

  test("select field: arrows cycle through choices", () => {
    const s = createInputsPickerState(FIELDS);
    s.focusedIdx = 2; // focus on `focus` field
    assert.equal(s.rawText.focus, "standard");
    handleInputsPickerInput("\x1b[C", s, FIELDS, KB); // right
    assert.equal(s.rawText.focus, "exhaustive");
    handleInputsPickerInput("\x1b[C", s, FIELDS, KB); // wraps
    assert.equal(s.rawText.focus, "minimal");
    handleInputsPickerInput("\x1b[D", s, FIELDS, KB); // wraps back
    assert.equal(s.rawText.focus, "exhaustive");
  });

  test("select field: up/down navigate choices without leaving the field", () => {
    const s = createInputsPickerState(FIELDS);
    s.focusedIdx = 2; // focus on `focus` field
    assert.equal(s.rawText.focus, "standard");
    handleInputsPickerInput("\x1b[B", s, FIELDS, KB); // down
    assert.equal(s.rawText.focus, "exhaustive");
    assert.equal(s.focusedIdx, 2);
    handleInputsPickerInput("\x1b[B", s, FIELDS, KB); // wraps
    assert.equal(s.rawText.focus, "minimal");
    assert.equal(s.focusedIdx, 2);
    handleInputsPickerInput("\x1b[A", s, FIELDS, KB); // up wraps back
    assert.equal(s.rawText.focus, "exhaustive");
    assert.equal(s.focusedIdx, 2);
  });

  test("boolean field: space and arrows flip", () => {
    const s = createInputsPickerState(FIELDS);
    s.focusedIdx = 3;
    assert.equal(s.rawText.verbose, "false");
    handleInputsPickerInput(" ", s, FIELDS, KB);
    assert.equal(s.rawText.verbose, "true");
    handleInputsPickerInput("\x1b[D", s, FIELDS, KB);
    assert.equal(s.rawText.verbose, "false");
  });

  test("boolean field: up/down navigate on/off without leaving the field", () => {
    const s = createInputsPickerState(FIELDS);
    s.focusedIdx = 3;
    s.rawText.verbose = "true";
    handleInputsPickerInput("\x1b[B", s, FIELDS, KB); // down to off
    assert.equal(s.rawText.verbose, "false");
    assert.equal(s.focusedIdx, 3);
    handleInputsPickerInput("\x1b[B", s, FIELDS, KB); // wraps to on
    assert.equal(s.rawText.verbose, "true");
    assert.equal(s.focusedIdx, 3);
    handleInputsPickerInput("\x1b[A", s, FIELDS, KB); // up wraps to off
    assert.equal(s.rawText.verbose, "false");
    assert.equal(s.focusedIdx, 3);
  });

  test("esc variants and ctrl+c variants cancel from form mode", () => {
    for (const key of [
      "\x1b",
      "\x1b[27u",
      "\x1b[27;1;27~",
      "\x03",
      "\x1b[99;5u",
      "\x1b[99;5:1u",
      "\x1b[27;5;99~",
    ]) {
      const state = createInputsPickerState(FIELDS);
      const action = handleInputsPickerInput(key, state, FIELDS, KB);
      assert.deepEqual(action, { kind: "cancel" }, `key=${JSON.stringify(key)}`);
    }
  });

  test("ctrl+x no longer submits or changes focus", () => {
    const s = createInputsPickerState(FIELDS, { prompt: "build something" });
    s.focusedIdx = 0;
    const action = handleInputsPickerInput("\x18", s, FIELDS, KB);
    assert.deepEqual(action, { kind: "noop" });
    assert.equal(s.focusedIdx, 0);
  });

  test("Submit tab with missing required fields focuses invalid", () => {
    const s = createInputsPickerState(FIELDS);
    s.focusedIdx = FIELDS.length;
    const action = handleInputsPickerInput("\r", s, FIELDS, KB);
    assert.deepEqual(action, { kind: "noop" });
    assert.equal(s.focusedIdx, 0);
    assert.equal(s.submitChoiceIdx, 0);
    assert.deepEqual(s.invalidIndices, [0]);
  });

  test("Submit button returns coerced values", () => {
    const s = createInputsPickerState(FIELDS, { prompt: "hi", focus: "minimal" });
    s.rawText.iters = "8";
    s.rawText.verbose = "true";
    s.focusedIdx = FIELDS.length;

    const run = handleInputsPickerInput("\r", s, FIELDS, KB);
    assert.equal(run.kind, "run");
    if (run.kind === "run") {
      assert.deepEqual(run.values, {
        prompt: "hi",
        iters: 8,
        focus: "minimal",
        verbose: true,
      });
    }
  });

  test("Submit button ignores numeric hotkeys", () => {
    const submit = createInputsPickerState(FIELDS, { prompt: "hi", focus: "minimal" });
    submit.focusedIdx = FIELDS.length;
    const run = handleInputsPickerInput("1", submit, FIELDS, KB);
    assert.equal(run.kind, "noop");
  });

  test("Submit button arrow keys return to the questions", () => {
    const s = createInputsPickerState(FIELDS, { prompt: "hi", focus: "minimal" });
    s.focusedIdx = FIELDS.length;

    handleInputsPickerInput("\x1b[A", s, FIELDS, KB);
    assert.equal(s.focusedIdx, FIELDS.length - 1);
    s.focusedIdx = FIELDS.length;
    handleInputsPickerInput("\x1b[B", s, FIELDS, KB);
    assert.equal(s.focusedIdx, 0);
  });

  // ── Coercion ──────────────────────────────────────────────────────────────

  test("coerceValues maps types correctly and skips empty optionals", () => {
    const out = coerceValues(FIELDS, {
      prompt: "do x",
      iters: "10",
      focus: "exhaustive",
      verbose: "true",
    });
    assert.deepEqual(out, {
      prompt: "do x",
      iters: 10,
      focus: "exhaustive",
      verbose: true,
    });

    const sparse = coerceValues(FIELDS, {
      prompt: "y",
      iters: "",
      focus: "standard",
      verbose: "false",
    });
    // iters is empty + optional → omitted; verbose still recorded
    assert.equal(sparse.iters, undefined);
    assert.equal(sparse.verbose, false);
  });

  test("coerceValues parses JSON-shaped text values", () => {
    const fields: WorkflowInputEntry[] = [
      { name: "tags", type: "text", required: false },
    ];
    const out = coerceValues(fields, { tags: '["a","b"]' });
    assert.deepEqual(out.tags, ["a", "b"]);
  });
}
