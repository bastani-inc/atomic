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
test("card (submitted): shows ✓ submitted ribbon + composed command", () => {
  const state = makeState({
    rawText: {
      prompt: "build me a tui",
      iters: "5",
      focus: "minimal",
      verbose: "false",
    },
    status: "submitted",
  });
  const lines = renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) });
  const txt = plain(lines);
  assert.match(txt, /✓ submitted/);
  assert.match(txt, /\/workflow ralph/);
  assert.match(txt, /prompt="build me a tui"/);
  assert.match(txt, /focus=minimal/);
  // editing-status hints should NOT appear in frozen view.
  assert.doesNotMatch(txt, /✎ editing/);
});

test("card (cancelled): renders no cancellation artefact", () => {
  const state = makeState({ status: "cancelled" });
  const lines = renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) });
  assert.deepEqual(lines, []);
});

test("card: keeps Submit visible in a narrow tab bar", () => {
  const fields: readonly WorkflowInputEntry[] = [
    { name: "very_long_prompt_name", type: "string", required: true },
    { name: "another_long_context_name", type: "string", required: false },
  ];
  const state = makeState({
    fields,
    rawText: { very_long_prompt_name: "ready", another_long_context_name: "" },
    focusedIdx: fields.length,
    caret: 0,
  });
  const lines = renderInlineCard({ width: 16, state, theme: deriveGraphTheme({}) });
  const footer = plain([lines.at(-1) ?? ""]);
  assert.match(footer, /SUBMIT/);
  assert.ok(footer.length <= 16);
});

test("card: select field renders choices as ask-user-question numbered rows", () => {
  const state = makeState({ focusedIdx: 2 });
  const txt = plain(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) }));
  assert.match(txt, /  1\. minimal/);
  assert.match(txt, /❯ 2\. standard/);
  assert.match(txt, /  3\. exhaustive/);
  assert.doesNotMatch(txt, /○ minimal/);
});

test("card: focused text field shows the caret so the bottom editor can stay hidden", () => {
  const state = makeState({
    rawText: { prompt: "build", iters: "5", focus: "standard", verbose: "false" },
    focusedIdx: 0,
    caret: 2,
  });
  const lines = renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) });
  const txt = plain(lines);
  assert.match(txt, /build/);
  assert.match(ansi(lines), /\x1b\[7mi\x1b\[0m/);
  assert.doesNotMatch(txt, /▋/);
});

test("card: wraps long descriptions and choice labels without ellipses", () => {
  const fields: readonly WorkflowInputEntry[] = [
    {
      name: "strategy",
      type: "select",
      required: true,
      description: "Choose the deployment strategy that prioritizes safety across multiple production regions and rollback windows.",
      choices: ["roll out gradually across production regions with automated rollback and operator checkpoints"],
    },
  ];
  const state = makeState({
    fields,
    rawText: { strategy: fields[0]!.choices![0]! },
    focusedIdx: 0,
    caret: 0,
  });
  const txt = plain(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) }));
  assert.match(txt, /prioritizes safety/);
  assert.match(txt, /across multiple production regions and rollback windows/);
  assert.match(txt, /roll out gradually across production regions/);
  assert.match(txt, /automated rollback and/);
  assert.match(txt, /operator checkpoints/);
  assert.doesNotMatch(txt, /…/);
});

test("card: live form lines stay within the requested width", () => {
  const width = 113;
  const longDescription = "Maximum number of codebase partitions to explore in parallel. Actual partitions scale by one per 10K LoC, capped by this value.";
  const state = makeState({
    workflowName: "deep-research-codebase-with-a-very-long-name-that-should-not-overflow-the-terminal",
    fields: [
      { name: "prompt", type: "text", required: true, description: "Research question or investigation focus for the codebase." },
      { name: "max_partitions", type: "number", required: false, default: 4, description: longDescription },
    ],
    rawText: { prompt: "", max_partitions: "4" },
    focusedIdx: 1,
    caret: 1,
  });

  const lines = renderInlineCard({ width, state, theme: deriveGraphTheme({}) });
  assertLinesWithinWidth(lines, width);
});

test("card: frozen form lines stay within the requested width", () => {
  const width = 72;
  const state = makeState({
    workflowName: "deep-research-codebase-with-a-very-long-name-that-should-not-overflow-the-terminal",
    rawText: {
      prompt: "build a very long response that would otherwise make the submitted command line wider than the terminal",
      iters: "5",
      focus: "minimal",
      verbose: "false",
    },
    status: "submitted",
  });

  const lines = renderInlineCard({ width, state, theme: deriveGraphTheme({}) });
  assertLinesWithinWidth(lines, width);
});

test("editor: typing a char inserts at caret on the focused text field", () => {
  const e = makeEditor();
  e.editor.handleInput("h");
  e.editor.handleInput("i");
  assert.equal(e.state.rawText.prompt, "hi");
  assert.equal(e.state.caret, 2);
  e.dispose();
});

test("editor: accepts encoded printable key sequences", () => {
  for (const [key, expected] of [
    ["\x1b[98;1u", "b"], // Kitty / CSI-u plain b
    ["\x1b[65;2u", "A"], // Kitty / CSI-u shifted A
    ["\x1b[27;1;98~", "b"], // xterm modifyOtherKeys plain b
    ["\x1b[27;2;65~", "A"], // xterm modifyOtherKeys shifted A
  ] as const) {
    const e = makeEditor();
    e.editor.handleInput(key);
    assert.equal(e.state.rawText.prompt, expected, `key=${JSON.stringify(key)}`);
    assert.equal(e.state.caret, expected.length, `key=${JSON.stringify(key)}`);
    e.dispose();
  }
});

test("editor: tab advances focus, shift+tab retreats", () => {
  const e = makeEditor();
  assert.equal(e.state.focusedIdx, 0);
  e.editor.handleInput("\t");
  assert.equal(e.state.focusedIdx, 1);
  e.editor.handleInput("\x1b[Z");
  assert.equal(e.state.focusedIdx, 0);
  e.dispose();
});

test("editor: esc variants and ctrl+c variants fire onExit('cancel')", () => {
  for (const key of [
    "\x1b",
    "\x1b[27u",
    "\x1b[27;1;27~",
    "\x03",
    "\x1b[99;5u",
    "\x1b[99;5:1u",
    "\x1b[27;5;99~",
  ]) {
    const e = makeEditor();
    e.editor.handleInput(key);
    assert.deepEqual(e.getExited(), { outcome: "cancel" }, `key=${JSON.stringify(key)}`);
    e.dispose();
  }
});
