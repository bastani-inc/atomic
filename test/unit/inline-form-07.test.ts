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
test("editor: paste into a select field is a no-op", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 2, // `focus` is type: select
      caret: 0,
    }),
  );
  e.editor.handleInput("\x1b[200~exhaustive\x1b[201~");
  // Select choices aren't text — paste leaves the value alone.
  assert.equal(e.state.rawText.focus, "standard");
  e.dispose();
});

test("editor: paste into a boolean field is a no-op", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "", iters: "5", focus: "standard", verbose: "true" },
      focusedIdx: 3, // `verbose` is type: boolean
      caret: 0,
    }),
  );
  e.editor.handleInput("\x1b[200~false\x1b[201~");
  assert.equal(e.state.rawText.verbose, "true");
  e.dispose();
});

test("editor: paste strips control bytes but keeps tabs and newlines", () => {
  const e = makeEditor();
  // Mix in a NUL and DEL — they must be filtered out, tab and newline retained.
  e.editor.handleInput("\x1b[200~hi\x00\ttab\x7f\nnext\x1b[201~");
  assert.equal(e.state.rawText.prompt, "hi\ttab\nnext");
  e.dispose();
});

test("editor: fallback paste — multi-char printable burst is inserted as paste", () => {
  // Hosts without bracketed paste send the raw chunk in one call.
  const e = makeEditor();
  e.editor.handleInput("hello world");
  assert.equal(e.state.rawText.prompt, "hello world");
  assert.equal(e.state.caret, "hello world".length);
  e.dispose();
});

test("editor: fallback paste rejects chunks containing escape sequences", () => {
  // `\x1b[A` is the up-arrow CSI sequence; must NOT be treated as paste.
  const e = makeEditor(
    makeState({
      rawText: { prompt: "abc\nxyz", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 5, // inside "xyz" at col 1 (`x|yz`)
    }),
  );
  e.editor.handleInput("\x1b[A");
  // Up-arrow moved caret to previous logical line, did not insert text.
  assert.equal(e.state.rawText.prompt, "abc\nxyz");
  assert.equal(e.state.caret, 1);
  e.dispose();
});

test("editor: fallback paste — empty body after sanitising is a no-op", () => {
  const e = makeEditor();
  // Pure control bytes — nothing printable survives sanitisation.
  e.editor.handleInput("\x1b[200~\x00\x01\x02\x1b[201~");
  assert.equal(e.state.rawText.prompt, "");
  e.dispose();
});

test("editor: ctrl+w deletes the word left of the caret", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "hello world foo", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 11, // end of "world"
    }),
  );
  e.editor.handleInput("\x17"); // ctrl+w
  assert.equal(e.state.rawText.prompt, "hello  foo");
  assert.equal(e.state.caret, 6);
  e.dispose();
});

test("editor: alt+backspace also deletes the word left (Pi action remap)", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "one two three", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 13, // end
    }),
  );
  e.editor.handleInput("\x1b\x7f");
  assert.equal(e.state.rawText.prompt, "one two ");
  assert.equal(e.state.caret, 8);
  e.dispose();
});

test("editor: alt+d deletes the word right of the caret", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "alpha beta gamma", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 6, // start of "beta"
    }),
  );
  e.editor.handleInput("\x1bd");
  assert.equal(e.state.rawText.prompt, "alpha  gamma");
  assert.equal(e.state.caret, 6);
  e.dispose();
});

test("editor: ctrl+u deletes from caret to logical line start (multi-line)", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "first line\nsecond line\nthird line", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 17, // mid "second line": "second" — 11+6=17
    }),
  );
  e.editor.handleInput("\x15"); // ctrl+u
  // Deletes "second" from start of its logical line; surrounding lines untouched.
  assert.equal(e.state.rawText.prompt, "first line\n line\nthird line");
  assert.equal(e.state.caret, 11);
  e.dispose();
});

test("editor: ctrl+k deletes from caret to logical line end (multi-line)", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "first line\nsecond line\nthird line", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 17, // mid "second line"
    }),
  );
  e.editor.handleInput("\x0b"); // ctrl+k
  // Deletes " line" from caret to end of its logical line; the trailing
  // \n and "third line" must NOT be touched.
  assert.equal(e.state.rawText.prompt, "first line\nsecond\nthird line");
  assert.equal(e.state.caret, 17);
  e.dispose();
});

test("editor: ctrl+a / ctrl+e jump to logical line start / end", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "first line\nsecond line", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 14, // inside "second line"
    }),
  );
  e.editor.handleInput("\x01"); // ctrl+a
  assert.equal(e.state.caret, 11); // start of "second line"
  e.editor.handleInput("\x05"); // ctrl+e
  assert.equal(e.state.caret, 22); // end of "second line"
  e.dispose();
});
