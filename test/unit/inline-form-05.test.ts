// @ts-nocheck
/**
 * Unit tests for the Option-C inline workflow input form.
 *
 *   - inline-form-store: state seeding + lifecycle (createForm, finalize)
 *   - inline-form-card:  renders live + frozen views; routes status text
 *   - inline-form-editor: routes keystrokes per type without rendering a duplicate box
 *   - inline-form-overlay: emits sendMessage, swaps editor, restores it
 *
 * The editor side is exercised through its public surface (handleInput /
 * render). The overlay test uses a minimal `pi`/`ctx` mock that records
 * sendMessage + setEditorComponent calls — same pattern as the existing
 * extension test suite.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  _resetForms,
  clearForms,
  createForm,
  finalizeForm,
  getForm,
  touch,
} from "../../packages/workflows/src/tui/inline-form-store.ts";
import { layoutTextField, renderInlineCard } from "../../packages/workflows/src/tui/inline-form-card.ts";
import { InlineFormEditor } from "../../packages/workflows/src/tui/inline-form-editor.ts";
import {
  openInlineInputsForm,
  registerInlineFormRenderer,
} from "../../packages/workflows/src/tui/inline-form-overlay.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.ts";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.ts";

import { FIELDS, makeState, plain, ansi, assertLinesWithinWidth, makeEditor, makeFakePi, makeFakeCtx } from "./inline-form-helpers.ts";
test("layoutTextField: short single-line content stays on one row", () => {
  const r = layoutTextField("hello", 20, 0);
  assert.deepEqual(r.lines, ["hello"]);
  assert.equal(r.cursorRow, 0);
  assert.equal(r.cursorCol, 0);
});

test("layoutTextField: caret in the middle of a single line", () => {
  const r = layoutTextField("hello", 20, 2);
  assert.deepEqual(r.lines, ["hello"]);
  assert.equal(r.cursorRow, 0);
  assert.equal(r.cursorCol, 2);
});

test("layoutTextField: newlines start new visual rows (no `⏎` glyph)", () => {
  const r = layoutTextField("first\nsecond\nthird", 20, 8);
  assert.deepEqual(r.lines, ["first", "second", "third"]);
  // caret 8 → inside "second" at offset 2 (`se|cond`).
  assert.equal(r.cursorRow, 1);
  assert.equal(r.cursorCol, 2);
});

test("layoutTextField: caret at end of last line lands on last row", () => {
  const raw = "a\nb\nc";
  const r = layoutTextField(raw, 20, raw.length);
  assert.deepEqual(r.lines, ["a", "b", "c"]);
  assert.equal(r.cursorRow, 2);
  assert.equal(r.cursorCol, 1);
});

test("layoutTextField: wraps long content at character boundary when no newline", () => {
  const r = layoutTextField("abcdefghij", 4, 6);
  assert.deepEqual(r.lines, ["abcd", "efgh", "ij"]);
  assert.equal(r.cursorRow, 1);
  assert.equal(r.cursorCol, 2);
});

test("layoutTextField: wraps CJK by terminal cell width", () => {
  const raw = "漢字ab";
  const r = layoutTextField(raw, 4, "漢字".length);
  assert.deepEqual(r.lines, ["漢字", "ab"]);
  assert.equal(r.cursorRow, 1);
  assert.equal(r.cursorCol, 0);
});

test("layoutTextField: keeps combining sequences in one grapheme", () => {
  const r = layoutTextField("e\u0301x", 1, "e\u0301".length);
  assert.equal(r.lines[0], "é");
  assert.equal(r.cursorRow, 1);
  assert.equal(r.cursorCol, 0);
});

test("layoutTextField: caret at hard wrap boundary lands on next visual row", () => {
  // After typing 4 chars in a 4-cell box, caret advances past the wrap.
  const r = layoutTextField("abcd", 4, 4);
  assert.deepEqual(r.lines, ["abcd", ""]);
  assert.equal(r.cursorRow, 1);
  assert.equal(r.cursorCol, 0);
});

test("layoutTextField: empty content yields a single empty visual row", () => {
  const r = layoutTextField("", 20, 0);
  assert.deepEqual(r.lines, [""]);
  assert.equal(r.cursorRow, 0);
  assert.equal(r.cursorCol, 0);
});

test("card: focused multi-line text field renders newlines as real rows, no `⏎`", () => {
  const state = makeState({
    rawText: { prompt: "first line\nsecond line", iters: "5", focus: "standard", verbose: "false" },
    focusedIdx: 0,
    caret: 11, // start of "second line"
  });
  const txt = plain(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) }));
  // Real visual line break inside the prompt box.
  assert.match(txt, /first line/);
  assert.match(txt, /second line/);
  assert.match(ansi(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) })), /\x1b\[7ms\x1b\[0m/);
  // No literal `⏎` glyph anywhere — we render newlines as rows, not as a sigil.
  assert.doesNotMatch(txt, /⏎/);
});

test("card: inactive filled fields remain visible on the single page", () => {
  const state = makeState({
    rawText: { prompt: "first line\nsecond line", iters: "5", focus: "standard", verbose: "false" },
    focusedIdx: 1,
    caret: 1,
  });
  const txt = plain(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) }));
  assert.match(txt, /╭ prompt /);
  assert.match(txt, /│first line\s+│\n│second line/);
  assert.match(txt, /╭ iters ─+╮\n│5/);
  assert.doesNotMatch(txt, /⏎/);
});

test("editor: down arrow inside multi-line text moves caret to next logical line", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "first\nsecond\nthird", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 2, // inside "first" at col 2 (`fi|rst`)
    }),
  );
  e.editor.handleInput("\x1b[B"); // down
  assert.equal(e.state.focusedIdx, 0, "focus must stay on the text field");
  // Should land on "second" at col 2 → offset 6+2 = 8.
  assert.equal(e.state.caret, 8);
  e.dispose();
});
