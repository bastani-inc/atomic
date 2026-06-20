import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInputsPickerState, handleInputsPickerInput } from "../../packages/workflows/src/tui/inputs-picker.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.ts";
import { FIELDS, KB } from "./inputs-picker-helpers.js";

export function registerInputsPickerSuite4(): void {
  // ── injected keybindings: word / line / char editing (picker overlay) ──────

  test("picker: ctrl+w deletes the word left of the caret", () => {
    const s = createInputsPickerState(FIELDS, { prompt: "alpha beta gamma" });
    s.caret = 16; // end of "gamma"
    handleInputsPickerInput("\x17", s, FIELDS, KB);
    assert.equal(s.rawText.prompt, "alpha beta ");
    assert.equal(s.caret, 11);
  });

  test("picker: ctrl+u deletes from caret to logical line start", () => {
    const s = createInputsPickerState(FIELDS, {
      prompt: "line one\nline two\nline three",
    });
    s.caret = 14; // mid "line two": 9 + 5
    handleInputsPickerInput("\x15", s, FIELDS, KB);
    // Deletes "line " from line-two only; surrounding lines stay intact.
    assert.equal(s.rawText.prompt, "line one\ntwo\nline three");
    assert.equal(s.caret, 9);
  });

  test("picker: ctrl+k deletes from caret to logical line end without crossing newlines", () => {
    const s = createInputsPickerState(FIELDS, {
      prompt: "line one\nline two\nline three",
    });
    s.caret = 13; // mid "line two": 9 + 4 (after "line")
    handleInputsPickerInput("\x0b", s, FIELDS, KB);
    assert.equal(s.rawText.prompt, "line one\nline\nline three");
    assert.equal(s.caret, 13);
  });

  test("picker: ctrl+a / ctrl+e jump to logical line start / end", () => {
    const s = createInputsPickerState(FIELDS, {
      prompt: "first line\nsecond line",
    });
    s.caret = 14; // inside "second line"
    handleInputsPickerInput("\x01", s, FIELDS, KB);
    assert.equal(s.caret, 11);
    handleInputsPickerInput("\x05", s, FIELDS, KB);
    assert.equal(s.caret, 22);
  });

  test("picker: alt+d deletes the word right of the caret", () => {
    const s = createInputsPickerState(FIELDS, { prompt: "alpha beta gamma" });
    s.caret = 6; // start of "beta"
    handleInputsPickerInput("\x1bd", s, FIELDS, KB);
    assert.equal(s.rawText.prompt, "alpha  gamma");
    assert.equal(s.caret, 6);
  });

  test("picker: alt+left / alt+right jump by whole word", () => {
    const s = createInputsPickerState(FIELDS, { prompt: "alpha beta gamma" });
    s.caret = 16; // end
    handleInputsPickerInput("\x1b[1;3D", s, FIELDS, KB);
    assert.equal(s.caret, 11); // start of "gamma"
    handleInputsPickerInput("\x1b[1;3D", s, FIELDS, KB);
    assert.equal(s.caret, 6); // start of "beta"
    handleInputsPickerInput("\x1b[1;3C", s, FIELDS, KB);
    assert.equal(s.caret, 10); // end of "beta"
  });

  test("picker: ctrl+d deletes the char right of the caret", () => {
    const s = createInputsPickerState(FIELDS, { prompt: "abc" });
    s.caret = 1;
    handleInputsPickerInput("\x04", s, FIELDS, KB);
    assert.equal(s.rawText.prompt, "ac");
    assert.equal(s.caret, 1);
  });

  test("picker: user-remapped delete word backward respects injected keybindings", () => {
    const kb = makeFakeKeybindings({
      "tui.editor.deleteWordBackward": ["\x14"], // ctrl+t
    });
    const s = createInputsPickerState(FIELDS, { prompt: "one two" });
    s.caret = 7;
    handleInputsPickerInput("\x14", s, FIELDS, kb);
    assert.equal(s.rawText.prompt, "one ");
    assert.equal(s.caret, 4);
    // Original ctrl+w no longer triggers the action under override.
    s.rawText.prompt = "alpha beta";
    s.caret = 10;
    handleInputsPickerInput("\x17", s, FIELDS, kb);
    assert.equal(s.rawText.prompt, "alpha beta");
    assert.equal(s.caret, 10);
  });
}
