// @ts-nocheck
import { test } from "bun:test";
import assert from "node:assert/strict";
import { openInlineInputsForm } from "../../packages/workflows/src/tui/inline-form-overlay.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { _resetForms } from "../../packages/workflows/src/tui/inline-form-store.ts";
import { InlineFormEditor } from "../../packages/workflows/src/tui/inline-form-editor.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.ts";
import { FIELDS, makeFakePi } from "./inline-form-helpers.ts";

test("overlay: late settle after stale ctx still restores working and resolves", async () => {
  _resetForms();
  const { pi } = makeFakePi();
  const workingCalls: boolean[] = [];
  let stale = false;
  let current: unknown;
  const ui = {
    setWorkingVisible: (visible: boolean) => workingCalls.push(visible),
    setEditorComponent: (factory: unknown | undefined) => { current = factory; },
    getEditorComponent: () => {
      if (stale) throw new Error("This extension ctx is stale after /resume");
      return current;
    },
  };
  const ctx = {
    get ui() {
      if (stale) throw new Error("This extension ctx is stale after /resume");
      return ui;
    },
  };

  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  const factory = current as (tui: unknown, theme: unknown, kb: unknown) => InlineFormEditor;
  const editor = factory({ requestRender: () => {} }, {}, makeFakeKeybindings());
  stale = true;
  editor.handleInput("\x1b");

  const result = await pending;
  assert.equal(result.kind, "cancel");
  assert.deepEqual(workingCalls, [false, true]);
});

test("overlay: initial editor lookup failure restores working and resolves unsupported", async () => {
  _resetForms();
  const { pi } = makeFakePi();
  const workingCalls: boolean[] = [];
  const ctx = {
    ui: {
      setWorkingVisible: (visible: boolean) => workingCalls.push(visible),
      setEditorComponent: () => undefined,
      getEditorComponent: () => {
        throw new Error("get editor failed");
      },
    },
  };

  const result = await openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.equal(result.kind, "unsupported");
  assert.deepEqual(workingCalls, [false, true]);
});
