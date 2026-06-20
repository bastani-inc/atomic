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
test("editor: ctrl+x no longer submits or focuses invalid", () => {
  const e = makeEditor(); // prompt is empty
  e.state.focusedIdx = 2;
  e.editor.handleInput("\x18");
  assert.equal(e.getExited(), null);
  assert.equal(e.state.focusedIdx, 2);
  e.dispose();
});

test("editor: Submit section validates and submits via visible row", () => {
  const missing = makeEditor();
  missing.state.focusedIdx = FIELDS.length;
  missing.editor.handleInput("\r");
  assert.equal(missing.getExited(), null);
  assert.equal(missing.state.focusedIdx, 0);
  assert.equal(missing.state.submitChoiceIdx, 0);
  missing.dispose();

  const state = makeState({
    focusedIdx: FIELDS.length,
    rawText: { prompt: "build", iters: "5", focus: "standard", verbose: "false" },
  });
  const e = makeEditor(state);
  e.editor.handleInput("\r");
  assert.deepEqual(e.getExited(), { outcome: "submit" });
  e.dispose();
});

test("editor: Submit button ignores numeric hotkeys", () => {
  const submitState = makeState({
    focusedIdx: FIELDS.length,
    rawText: { prompt: "build", iters: "5", focus: "standard", verbose: "false" },
  });
  const submit = makeEditor(submitState);
  submit.editor.handleInput("1");
  assert.equal(submit.getExited(), null);
  submit.dispose();
});

test("editor: Submit button arrow keys return to questions", () => {
  const state = makeState({
    focusedIdx: FIELDS.length,
    rawText: { prompt: "build", iters: "5", focus: "standard", verbose: "false" },
  });
  const e = makeEditor(state);
  e.editor.handleInput("\x1b[A");
  assert.equal(state.focusedIdx, FIELDS.length - 1);
  state.focusedIdx = FIELDS.length;
  e.editor.handleInput("\x1b[B");
  assert.equal(state.focusedIdx, 0);
  e.dispose();
});

test("editor: select field arrow keys cycle, space cycles", () => {
  const state = makeState({ focusedIdx: 2 });
  const e = makeEditor(state);
  assert.equal(state.rawText.focus, "standard");
  e.editor.handleInput("\x1b[C");
  assert.equal(state.rawText.focus, "exhaustive");
  e.editor.handleInput(" ");
  assert.equal(state.rawText.focus, "minimal"); // wrap
  e.editor.handleInput("\x1b[D");
  assert.equal(state.rawText.focus, "exhaustive"); // wrap back
  e.dispose();
});

test("editor: select field up/down navigates choices without changing fields", () => {
  const state = makeState({ focusedIdx: 2 });
  const e = makeEditor(state);
  assert.equal(state.rawText.focus, "standard");
  e.editor.handleInput("\x1b[B");
  assert.equal(state.rawText.focus, "exhaustive");
  assert.equal(state.focusedIdx, 2);
  e.editor.handleInput("\x1b[B");
  assert.equal(state.rawText.focus, "minimal");
  assert.equal(state.focusedIdx, 2);
  e.editor.handleInput("\x1b[A");
  assert.equal(state.rawText.focus, "exhaustive");
  assert.equal(state.focusedIdx, 2);
  e.dispose();
});

test("editor: boolean field space toggles", () => {
  const state = makeState({ focusedIdx: 3 });
  const e = makeEditor(state);
  assert.equal(state.rawText.verbose, "false");
  e.editor.handleInput(" ");
  assert.equal(state.rawText.verbose, "true");
  e.editor.handleInput("\x1b[C");
  assert.equal(state.rawText.verbose, "false");
  e.dispose();
});

test("editor: boolean field up/down navigates on/off without changing fields", () => {
  const state = makeState({ focusedIdx: 3, rawText: { prompt: "", iters: "5", focus: "standard", verbose: "true" } });
  const e = makeEditor(state);
  e.editor.handleInput("\x1b[B");
  assert.equal(state.rawText.verbose, "false");
  assert.equal(state.focusedIdx, 3);
  e.editor.handleInput("\x1b[B");
  assert.equal(state.rawText.verbose, "true");
  assert.equal(state.focusedIdx, 3);
  e.editor.handleInput("\x1b[A");
  assert.equal(state.rawText.verbose, "false");
  assert.equal(state.focusedIdx, 3);
  e.dispose();
});

test("editor: render returns no rows so the bottom argument box is not duplicated", () => {
  const e = makeEditor();
  assert.deepEqual(e.editor.render(80), []);
  e.dispose();
});

test("editor: implements host resize methods (getTopBorderAvailableWidth / setTopBorder)", () => {
  const e = makeEditor();
  assert.equal(typeof e.editor.getTopBorderAvailableWidth, "function");
  assert.equal(typeof e.editor.setTopBorder, "function");
  assert.equal(e.editor.getTopBorderAvailableWidth!(120), 120);
  assert.equal(e.editor.getTopBorderAvailableWidth!(0), 0);
  assert.equal(e.editor.getTopBorderAvailableWidth!(-5), 0);
  assert.equal(e.editor.getTopBorderAvailableWidth!(Number.NaN), 0);
  assert.equal(e.editor.setTopBorder!({ content: "anything", width: 80 }), undefined);
  e.dispose();
});

test("editor: survives the host's resize-handler call sequence at many widths", () => {
  // This test simulates pi InteractiveMode's #resizeHandler verbatim.
  // The handler runs on every `process.stdout.resize` event:
  //
  //   #resizeHandler = () => {
  //     #syncEditorMaxHeight();            // → editor.setMaxHeight(rows - reserved)
  //     updateEditorTopBorder();           // ↓
  //   }
  //   updateEditorTopBorder() {
  //     const w = editor.getTopBorderAvailableWidth(terminal.columns);
  //     const top = statusLine.getTopBorder(w);   // host-side
  //     editor.setTopBorder(top);
  //   }
  //
  // Regression target: getTopBorderAvailableWidth and setTopBorder MUST be
  // present on InlineFormEditor and must not throw across the full range of
  // terminal sizes a user can resize to — including pathologically narrow,
  // ridiculous-wide, and degenerate (0, NaN) inputs.
  const e = makeEditor();
  const fireHostResize = (columns: number, rows: number): number => {
    e.editor.setMaxHeight!(Math.max(1, rows - 4));
    const w = e.editor.getTopBorderAvailableWidth!(columns);
    assert.equal(typeof w, "number", `getTopBorderAvailableWidth returned non-number for cols=${columns}`);
    assert.ok(Number.isFinite(w), `getTopBorderAvailableWidth returned ${w} for cols=${columns}`);
    assert.ok(w >= 0, `getTopBorderAvailableWidth returned negative ${w} for cols=${columns}`);
    // statusLine.getTopBorder is host-owned and not exercised here; we pass
    // a faithful shape ({ content, width }) so setTopBorder sees realistic
    // input — the host always passes the same shape.
    e.editor.setTopBorder!({ content: "  session-name", width: w });
    // Render must still produce zero rows (the inline-form-card owns chrome).
    assert.deepEqual(e.editor.render(columns), []);
    return w;
  };

  // Common terminal widths
  for (const [cols, rows] of [
    [40, 12],
    [80, 24],
    [100, 30],
    [120, 40],
    [200, 50],
    [320, 80],
  ]) {
    const w = fireHostResize(cols, rows);
    assert.equal(w, cols, `width passthrough at cols=${cols}`);
  }

  // Pathological: zero / negative / non-finite / very large
  for (const cols of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY, 100_000]) {
    const w = fireHostResize(cols, 24);
    assert.ok(w >= 0, `width must be non-negative for cols=${cols}, got ${w}`);
  }

  e.dispose();
});

test("editor: handleInput on a finalized form is a no-op", () => {
  const state = makeState({ status: "submitted" });
  const e = makeEditor(state);
  e.editor.handleInput("h");
  assert.equal(state.rawText.prompt, ""); // not touched
  e.dispose();
});
