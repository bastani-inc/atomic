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
test("editor: alt+left / alt+right jump by whole word", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "alpha beta gamma", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 16,
    }),
  );
  e.editor.handleInput("\x1b[1;3D"); // alt+left
  assert.equal(e.state.caret, 11);
  e.editor.handleInput("\x1b[1;3D"); // alt+left
  assert.equal(e.state.caret, 6);
  e.editor.handleInput("\x1b[1;3C"); // alt+right
  assert.equal(e.state.caret, 10);
  e.dispose();
});

test("editor: ctrl+d deletes the char right of the caret", () => {
  const e = makeEditor(
    makeState({
      rawText: { prompt: "abc", iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: 1,
    }),
  );
  e.editor.handleInput("\x04");
  assert.equal(e.state.rawText.prompt, "ac");
  assert.equal(e.state.caret, 1);
  e.dispose();
});

test("editor: char movement and deletion respect emoji and combining graphemes", () => {
  const raw = "漢👩‍💻e\u0301z";
  const e = makeEditor(
    makeState({
      rawText: { prompt: raw, iters: "5", focus: "standard", verbose: "false" },
      focusedIdx: 0,
      caret: raw.length,
    }),
  );
  e.editor.handleInput("\x1b[D"); // left over z
  assert.equal(e.state.caret, "漢👩‍💻é".length);
  e.editor.handleInput("\x1b[D"); // left over composed é
  assert.equal(e.state.caret, "漢👩‍💻".length);
  e.editor.handleInput("\x7f"); // delete the whole emoji cluster
  assert.equal(e.state.rawText.prompt, "漢éz");
  assert.equal(e.state.caret, "漢".length);
  e.editor.handleInput("\x04"); // delete the whole composed é cluster
  assert.equal(e.state.rawText.prompt, "漢z");
  assert.equal(e.state.caret, "漢".length);
  e.dispose();
});

test("editor: user-remapped delete word backward respects injected keybindings", () => {
  // Drop ctrl+w; remap deleteWordBackward to a hypothetical ctrl+t sequence
  // and verify the form picks up the new binding via the injected manager.
  const state = makeState({
    rawText: { prompt: "one two", iters: "5", focus: "standard", verbose: "false" },
    focusedIdx: 0,
    caret: 7,
  });
  const tui = { requestRender: () => {} };
  let exited: { outcome: "submit" | "cancel" } | null = null;
  const editor = new InlineFormEditor(tui, {
    formId: state.formId,
    theme: deriveGraphTheme({}),
    keybindings: makeFakeKeybindings({
      "tui.editor.deleteWordBackward": ["\x14"], // ctrl+t
    }),
    onExit: (outcome) => { exited = { outcome }; },
  });
  editor.handleInput("\x14"); // ctrl+t → delete word backward under override
  assert.equal(state.rawText.prompt, "one ");
  assert.equal(state.caret, 4);
  // Default ctrl+w should NOT trigger the action now (overridden table).
  state.rawText.prompt = "alpha beta";
  state.caret = 10;
  editor.handleInput("\x17");
  assert.equal(state.rawText.prompt, "alpha beta");
  assert.equal(state.caret, 10);
  assert.equal(exited, null);
  editor.dispose?.();
});

test("editor: without a keybindings manager, only form-level keys still work", () => {
  // Verifies the "always rely on pi" contract: when no keybindings manager
  // is wired, action-based keys (arrows, backspace, etc.) do nothing.
  // Form-level keys (tab, esc, printable insert) still function.
  const state = makeState();
  const tui = { requestRender: () => {} };
  let exited: { outcome: "submit" | "cancel" } | null = null;
  const editor = new InlineFormEditor(tui, {
    formId: state.formId,
    theme: deriveGraphTheme({}),
    onExit: (outcome) => { exited = { outcome }; },
  });
  // Printable insert still works (raw byte check).
  editor.handleInput("h");
  assert.equal(state.rawText.prompt, "h");
  // Backspace would normally delete; without kb, it's a no-op.
  editor.handleInput("\x7f");
  assert.equal(state.rawText.prompt, "h", "delete action requires kb");
  // Tab still advances focus (form contract, not Pi action).
  editor.handleInput("\t");
  assert.equal(state.focusedIdx, 1);
  // Esc still cancels.
  editor.handleInput("\x1b");
  assert.deepEqual(exited, { outcome: "cancel" });
  editor.dispose?.();
});
