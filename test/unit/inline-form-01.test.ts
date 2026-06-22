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
test("store: createForm seeds version=0 and registers it", () => {
  const s = makeState();
  assert.equal(s.version, 0);
  assert.equal(getForm("wf-test"), s);
});

test("store: touch bumps version", () => {
  const s = makeState();
  touch(s);
  touch(s);
  assert.equal(s.version, 2);
});

test("store: finalizeForm flips status to submitted/cancelled", () => {
  const s = makeState();
  finalizeForm("wf-test", "submit");
  assert.equal(s.status, "submitted");
  const s2 = makeState({ formId: "wf-test-2" });
  finalizeForm("wf-test-2", "cancel");
  assert.equal(s2.status, "cancelled");
});

test("store: finalize unknown id is a no-op", () => {
  _resetForms();
  // Should not throw.
  finalizeForm("nope", "submit");
});

test("card (live): renders workflow header and continuous footer chrome", () => {
  const state = makeState();
  const lines = renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) });
  const txt = plain(lines);
  assert.match(txt, /WORKFLOW/);
  assert.match(txt, /ralph/);
  assert.match(txt, /1 \/ 4/);
  assert.doesNotMatch(txt, /←/);
  assert.doesNotMatch(txt, /✓ Submit/);
  assert.doesNotMatch(txt, /loop a thinker/);
  assert.match(txt, /╭ prompt /);
  assert.match(txt, /╭ iters /);
  assert.match(txt, /╭ focus /);
  assert.match(txt, /╭ verbose /);
  assert.doesNotMatch(txt, /╭────────╮/);
  assert.match(txt, / SUBMIT /);
  assert.doesNotMatch(txt, /EDIT/);
  assert.match(txt, /enter Submit/);
  assert.match(txt, /tab Next/);
  assert.match(txt, /shift\+tab Prev/);
  assert.match(txt, /esc Cancel/);
  assert.doesNotMatch(txt, /ctrl\+x/);
  assert.doesNotMatch(txt, /ctrl\+enter/);
  assert.doesNotMatch(txt, /ctrl\+s/);
});

test("card (live): compact hint row is anchored at the bottom of the widget", () => {
  const state = makeState();
  const lines = renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) });
  const tail = plain([lines.at(-1) ?? ""]);
  assert.match(tail, / SUBMIT /);
  assert.doesNotMatch(tail, /EDIT/);
  assert.match(tail, /enter Submit/);
  assert.match(tail, /tab Next/);
  assert.match(tail, /esc Cancel/);
  assert.doesNotMatch(tail, /ctrl\+x/);
});

test("card (live): active field body uses boxed field styling", () => {
  const state = makeState();
  const lines = renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) });
  const visible = plain(lines);
  assert.match(visible, /╭ prompt ─+╮/);
  assert.match(visible, /│\s+│/);
  assert.match(visible, /text · required · task/);
  assert.match(ansi(lines), /\x1b\[7m \x1b\[0m/);
});

test("card (live): shows all questions with Submit at the end", () => {
  const state = makeState({
    rawText: { prompt: "build me a tui", iters: "5", focus: "minimal", verbose: "false" },
    focusedIdx: FIELDS.length,
  });
  const txt = plain(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) }));
  assert.match(txt, / SUBMIT /);
  assert.match(txt, /╭ prompt ─+╮\n│build me a tui/);
  assert.match(txt, /╭ iters ─+╮\n│5/);
  assert.match(txt, /╭ focus ─+╮\n│\s+1\. ✓ minimal/);
  assert.match(txt, /╭ verbose ─+╮\n│\s+1\. on\s+│\n│\s+2\. ✓ off/);
  assert.doesNotMatch(txt, /❯ Submit answers/);
  assert.doesNotMatch(txt, /Review your inputs/);
  assert.doesNotMatch(txt, /Ready to submit your inputs\?/);
  assert.doesNotMatch(txt, /2\. Cancel/);
  assert.doesNotMatch(txt, /Chat about this/);
  assert.doesNotMatch(txt, /ctrl\+x/);
});

test("card (live): normalizes true-like boolean field values", () => {
  const state = makeState({
    rawText: { prompt: "build me a tui", iters: "5", focus: "minimal", verbose: "1" },
    focusedIdx: FIELDS.length,
  });
  const txt = plain(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) }));
  assert.match(txt, /╭ verbose ─+╮\n│\s+1\. ✓ on\s+│\n│\s+2\. off/);
  assert.doesNotMatch(txt, /✓ off/);
});

test("card (live): shows empty boolean fields without selecting off", () => {
  const fields: readonly WorkflowInputEntry[] = [
    { name: "enabled", type: "boolean", required: true },
  ];
  const state = makeState({
    fields,
    rawText: { enabled: "" },
    focusedIdx: fields.length,
    caret: 0,
  });
  const txt = plain(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) }));
  assert.match(txt, /╭ enabled ─+╮\n│\s+1\. on\s+│\n│\s+2\. off/);
  assert.doesNotMatch(txt, /✓ off/);
});

test("card (live): wraps invalid Submit prompt instead of clipping", () => {
  const fields: readonly WorkflowInputEntry[] = [
    { name: "alpha_required_prompt", type: "string", required: true },
    { name: "beta_required_context", type: "string", required: true },
  ];
  const state = makeState({
    fields,
    rawText: { alpha_required_prompt: "", beta_required_context: "" },
    focusedIdx: fields.length,
    caret: 0,
  });
  const width = 32;
  const lines = renderInlineCard({ width, state, theme: deriveGraphTheme({}) });
  const plainLines = lines.map((line) => plain([line]));
  const txt = plainLines.join("\n");
  assert.match(txt, /Answer remaining inputs before/);
  assert.match(txt, /submitting:/);
  assert.match(txt, /alpha_required_prompt/);
  assert.match(txt, /beta_required_context/);
  assert.match(txt, / SUBMIT /);
  const promptStart = plainLines.findIndex((line) => line.startsWith("Answer remaining"));
  const promptLines = plainLines.slice(promptStart, promptStart + 4).join("\n");
  assert.doesNotMatch(promptLines, /…/);
  assertLinesWithinWidth(lines, width);
});

test("card (live): single-page form preserves multiline values", () => {
  const state = makeState({
    rawText: { prompt: "line one\nline two", iters: "5", focus: "minimal", verbose: "false" },
    focusedIdx: FIELDS.length,
  });
  const txt = plain(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) }));
  assert.match(txt, /│line one\s+│\n│line two/);
  assert.doesNotMatch(txt, /line one line two/);
});
