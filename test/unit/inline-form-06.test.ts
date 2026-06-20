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
import { renderInlineCard } from "../../packages/workflows/src/tui/inline-form-card.ts";
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
test("editor: up arrow inside multi-line text moves caret to previous logical line", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "first\nsecond\nthird", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 9, // inside "second" at col 3 (`sec|ond`)
    }),
  );
  e.editor.handleInput("\x1b[A"); // up
  assert.equal(e.state.focusedIdx, 0);
  // Should land on "first" at col 3 → offset 3.
  assert.equal(e.state.caret, 3);
  e.dispose();
});

test("editor: down arrow on last logical line of text falls through to focus-next", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "only one line", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 4,
    }),
  );
  e.editor.handleInput("\x1b[B"); // down — no next logical line, so focus advances
  assert.equal(e.state.focusedIdx, 1);
  e.dispose();
});

test("editor: up arrow on first logical line of text falls through to focus-prev", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "single line", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 3,
    }),
  );
  e.editor.handleInput("\x1b[A"); // up — no previous logical line, focus wraps to Submit section
  assert.equal(e.state.focusedIdx, FIELDS.length);
  e.dispose();
});

test("editor: down arrow clamps caret to the next line's length on shorter targets", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "longer first line\nhi", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 10, // inside "longer first line" at col 10
    }),
  );
  e.editor.handleInput("\x1b[B");
  // Next line "hi" is only 2 chars; caret clamps to col 2 → offset 18+2 = 20.
  assert.equal(e.state.caret, 20);
  e.dispose();
});

test("editor: enter on text type inserts a real `\\n`, not the `⏎` glyph", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "ab", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 1,
    }),
  );
  e.editor.handleInput("\r");
  assert.equal(e.state.rawText.prompt, "a\nb");
  assert.equal(e.state.caret, 2);
  e.dispose();
});

test("editor: non-text field down arrow still moves focus, not caret", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "x", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 1, // iters (number, single-line)
      caret: 1,
    }),
  );
  e.editor.handleInput("\x1b[B");
  // Number type doesn't have multi-line; down should advance focus.
  assert.equal(e.state.focusedIdx, 2);
  e.dispose();
});

test("editor: bracketed paste inserts content at caret in a text field", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "ab", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 1,
    }),
  );
  e.editor.handleInput("\x1b[200~XYZ\x1b[201~");
  assert.equal(e.state.rawText.prompt, "aXYZb");
  assert.equal(e.state.caret, 4);
  e.dispose();
});

test("editor: bracketed paste preserves newlines in a text field (no `⏎` glyph)", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 0,
    }),
  );
  e.editor.handleInput("\x1b[200~line one\nline two\nline three\x1b[201~");
  assert.equal(e.state.rawText.prompt, "line one\nline two\nline three");
  assert.equal(e.state.caret, "line one\nline two\nline three".length);
  e.dispose();
});

test("editor: bracketed paste normalises CRLF and stray CR to LF", () => {
  const e = makeEditor();
  e.editor.handleInput("\x1b[200~a\r\nb\rc\x1b[201~");
  assert.equal(e.state.rawText.prompt, "a\nb\nc");
  e.dispose();
});

test("editor: bracketed paste split across multiple handleInput calls is buffered", () => {
  const e = makeEditor();
  e.editor.handleInput("\x1b[200~hello ");
  // Nothing applied yet — the close marker hasn't arrived.
  assert.equal(e.state.rawText.prompt, "");
  e.editor.handleInput("world");
  assert.equal(e.state.rawText.prompt, "");
  e.editor.handleInput("!\x1b[201~");
  assert.equal(e.state.rawText.prompt, "hello world!");
  e.dispose();
});

test("editor: data after the close marker still flows through normal routing", () => {
  const e = makeEditor();
  // Paste followed by a single typed char.
  e.editor.handleInput("\x1b[200~xy\x1b[201~z");
  assert.equal(e.state.rawText.prompt, "xyz");
  e.dispose();
});

test("editor: paste into a non-text scalar takes only the first logical line", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "x", iters: "", focus: "standard", verbose: "false" },
      focusedIdx: 1, // `iters` is type: number
      caret: 0,
    }),
  );
  e.editor.handleInput("\x1b[200~42\nignored second line\x1b[201~");
  // Number field accepts the first line; newline + remainder dropped.
  assert.equal(e.state.rawText.iters, "42");
  e.dispose();
});
