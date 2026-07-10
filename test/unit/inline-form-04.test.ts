// @ts-nocheck
/**
 * Unit tests for the Option-C inline workflow input form.
 *
 *   - inline-form-store: state seeding + lifecycle (createForm, finalize)
 *   - inline-form-card:  renders live + frozen views; routes status text
 *   - inline-form-editor: routes keystrokes per type without rendering a duplicate box
 *   - inline-form-overlay: emits sendMessage and mounts inline custom UI
 *
 * The editor side is exercised through its public surface (handleInput /
 * render). The overlay test uses a minimal `pi`/`ctx` mock that records
 * sendMessage + custom UI mounts — same pattern as the existing extension test
 * suite.
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

import { FIELDS, makeState, plain, ansi, assertLinesWithinWidth, makeEditor, makeFakePi, makeFakeCtx } from "./inline-form-helpers.ts";
test("overlay: openInlineInputsForm emits a custom message and mounts inline custom UI", async () => {
  _resetForms();
  const { pi, sentMessages } = makeFakePi();
  const ctx = makeFakeCtx();
  const theme = deriveGraphTheme({});

  // Kick off — don't await; the promise won't resolve until the editor exits.
  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme,
  });

  // The message was emitted synchronously.
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]!.customType, "workflows:input-form");
  // The input form is transient UI and must be kept out of LLM context, so
  // spawning the picker and exiting never leaks the form into the model.
  assert.deepEqual(sentMessages[0]!.options, { excludeFromContext: true });
  const formId = sentMessages[0]!.details!.formId!;
  assert.match(formId, /^wf-/);

  // An inline custom UI was mounted in the editor slot.
  assert.equal(ctx.installed.length, 1);
  assert.deepEqual(ctx.installed[0]!.options, { overlay: false });
  const editor = ctx.installed[0]!.component as InlineFormEditor;

  // Fill required prompt, tab to the visible Submit section, and submit.
  editor.handleInput("h");
  editor.handleInput("i");
  for (let i = 0; i < FIELDS.length; i += 1) editor.handleInput("\t");
  editor.handleInput("\r");
  const result = await pending;
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.values.prompt, "hi");
    assert.equal(result.values.focus, "standard");
  }

  // Form state remained in the store, status: submitted (sticky scrollback).
  assert.equal(getForm(formId)?.status, "submitted");
});

test("overlay: openInlineInputsForm leaves Working visibility to the host on submit", async () => {
  _resetForms();
  const { pi } = makeFakePi();
  const ctx = makeFakeCtx();
  const workingCalls: boolean[] = [];
  ctx.ui.setWorkingVisible = (visible: boolean) => workingCalls.push(visible);

  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.deepEqual(workingCalls, []);
  const editor = ctx.installed[0]!.component as InlineFormEditor;
  editor.handleInput("h");
  editor.handleInput("i");
  for (let i = 0; i < FIELDS.length; i += 1) editor.handleInput("\t");
  editor.handleInput("\r");

  const result = await pending;
  assert.equal(result.kind, "run");
  assert.deepEqual(workingCalls, []);
});

test("overlay: openInlineInputsForm leaves Working visibility to the host on cancel", async () => {
  _resetForms();
  const { pi } = makeFakePi();
  const ctx = makeFakeCtx();
  const workingCalls: boolean[] = [];
  ctx.ui.setWorkingVisible = (visible: boolean) => workingCalls.push(visible);

  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });
  (ctx.installed[0]!.component as InlineFormEditor).handleInput("\x1b");

  const result = await pending;
  assert.equal(result.kind, "cancel");
  assert.deepEqual(workingCalls, []);
});

test("overlay: openInlineInputsForm resolves unsupported when custom UI mount fails", async () => {
  _resetForms();
  const { pi } = makeFakePi();
  const ctx = {
    ui: {
      custom: () => {
        throw new Error("cannot mount editor");
      },
    },
  };

  const result = await openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.equal(result.kind, "unsupported");
});

test("overlay: openInlineInputsForm resolves unsupported on sendMessage failure", async () => {
  _resetForms();
  const ctx = makeFakeCtx();
  const pi = {
    sendMessage: () => {
      throw new Error("cannot emit card");
    },
  };

  const result = await openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.equal(result.kind, "unsupported");
  assert.equal(ctx.installed.length, 0);
});


test("overlay: openInlineInputsForm works with pi runtime custom UI shape", async () => {
  _resetForms();
  const { pi, sentMessages } = makeFakePi();
  const ctx = makeFakeCtx();

  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(ctx.installed.length, 1);
  const editor = ctx.installed[0]!.component as InlineFormEditor;

  editor.setUseTerminalCursor(true);
  assert.equal(editor.getUseTerminalCursor(), true);
  editor.setAutocompleteMaxVisible(30);
  assert.equal(editor.getAutocompleteMaxVisible(), 20);
  editor.setMaxHeight(4);
  editor.setHistoryStorage({});
  editor.setActionKeys("app.clear", ["ctrl+c"]);
  editor.setCustomKeyHandler("ctrl+x", () => {});
  editor.clearCustomKeyHandlers();
  editor.setAutocompleteProvider({});
  editor.insertTextAtCursor("\x1b");
  const result = await pending;
  assert.equal(result.kind, "cancel");
});

test("overlay: mounted editor accepts pi setup before card render", async () => {
  _resetForms();
  const { pi, sentMessages } = makeFakePi();
  const ctx = makeFakeCtx();
  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.equal(sentMessages.length, 1);
  const editor = ctx.installed[0]!.component as InlineFormEditor;
  editor.setUseTerminalCursor(true);
  editor.setAutocompleteMaxVisible(30);
  editor.setMaxHeight(4);
  editor.setHistoryStorage({});
  assert.equal(editor.getUseTerminalCursor(), true);
  assert.equal(editor.getAutocompleteMaxVisible(), 20);
  editor.handleInput("o");
  editor.handleInput("k");
  for (let i = 0; i < FIELDS.length; i += 1) editor.handleInput("\t");
  editor.handleInput("\r");
  const result = await pending;
  assert.equal(result.kind, "run");
});

test("overlay: custom mount failure resolves unsupported and freezes the card", async () => {
  _resetForms();
  const { pi, sentMessages } = makeFakePi();
  const ctx = {
    ui: {
      custom: () => Promise.reject(new TypeError("nextEditor.setUseTerminalCursor is not a function")),
    },
  };

  const result = await openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.equal(result.kind, "unsupported");
  assert.equal(sentMessages.length, 1);
  const formId = sentMessages[0]!.details!.formId!;
  assert.equal(getForm(formId)?.status, "cancelled");
});

test("overlay: cancelling via esc returns {kind:'cancel'} and renders no artefact", async () => {
  _resetForms();
  const { pi, sentMessages, renderers } = makeFakePi();
  registerInlineFormRenderer(pi as never, deriveGraphTheme({}));
  const ctx = makeFakeCtx();
  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });
  const editor = ctx.installed[0]!.component as InlineFormEditor;
  editor.handleInput("\x1b");
  const result = await pending;
  assert.equal(result.kind, "cancel");
  const message = sentMessages[0]!;
  const formId = message.details!.formId!;
  assert.equal(getForm(formId)?.status, "cancelled");
  const rendered = renderers.get("workflows:input-form")?.(message) as { render(width: number): string[] };
  assert.deepEqual(rendered.render(80), []);
});

test("overlay: late settle after host reset resolves without stale editor restoration", async () => {
  _resetForms();
  const { pi } = makeFakePi();
  const ctx = makeFakeCtx();

  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.equal(ctx.installed.length, 1);
  const editor = ctx.installed[0]!.component as InlineFormEditor;
  editor.handleInput("\x1b");

  const result = await pending;
  assert.equal(result.kind, "cancel");
  assert.equal(ctx.installed.length, 1);
});

test("overlay: missing custom UI → immediate unsupported (headless)", async () => {
  _resetForms();
  const { pi } = makeFakePi();
  const ctx = { ui: {} } as never;
  const result = await openInlineInputsForm(pi as never, ctx, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });
  assert.equal(result.kind, "unsupported");
});

test("overlay: prefilled values seed rawText", async () => {
  _resetForms();
  const { pi, sentMessages } = makeFakePi();
  const ctx = makeFakeCtx();
  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    prefilled: { prompt: "already typed", focus: "exhaustive" },
    theme: deriveGraphTheme({}),
  });
  const formId = sentMessages[0]!.details!.formId!;
  const state = getForm(formId)!;
  assert.equal(state.rawText.prompt, "already typed");
  assert.equal(state.rawText.focus, "exhaustive");
  // Cancel so the promise resolves.
  (ctx.installed[0]!.component as InlineFormEditor).handleInput("\x1b");
  await pending;
});

test("overlay: registerInlineFormRenderer preserves class-backed pi method binding", () => {
  class ClassBackedPi {
    readonly renderers = new Map<string, (payload: unknown) => unknown>();
    calls = 0;

    registerMessageRenderer(event: string, renderer: (payload: unknown) => unknown): void {
      this.calls += 1;
      this.renderers.set(event, renderer);
    }
  }

  const pi = new ClassBackedPi();
  registerInlineFormRenderer(pi as never, deriveGraphTheme({}));
  const first = pi.renderers.get("workflows:input-form");
  registerInlineFormRenderer(pi as never, deriveGraphTheme({}));
  const second = pi.renderers.get("workflows:input-form");
  // Second call on the same live host did not re-register.
  assert.equal(first, second);
  assert.equal(pi.calls, 1);

  // A replacement session gets a fresh ExtensionAPI host while the module stays
  // cached, so renderer registration must happen for that new host too.
  const replacementPi = new ClassBackedPi();
  registerInlineFormRenderer(replacementPi as never, deriveGraphTheme({}));
  assert.equal(replacementPi.calls, 1);
  assert.notEqual(replacementPi.renderers.get("workflows:input-form"), undefined);
});

test("overlay: renderer returns null (render nothing) for a lost snapshot on resume", () => {
  // On /resume the form store is cleared on session_start, so a rehydrated
  // `workflows:input-form` message has no live state. The renderer returns
  // null so CustomMessageComponent renders nothing — the input widget must not
  // reappear in chat (no stale form, no "snapshot lost" placeholder, no gap).
  _resetForms();
  const { pi, renderers } = makeFakePi();
  registerInlineFormRenderer(pi as never, deriveGraphTheme({}));
  const render = renderers.get("workflows:input-form");
  assert.equal(typeof render, "function");

  const message = {
    role: "custom",
    customType: "workflows:input-form",
    content: "stack-workflow-test",
    display: true,
    details: { formId: "wf-missing" },
    timestamp: 0,
  };
  const result = render!(message);

  assert.equal(result, null);
});

test("store: clearForms empties the registry so resumed sessions have no live forms", () => {
  _resetForms();
  createForm({
    formId: "wf-clear",
    workflowName: "ralph",
    fields: FIELDS,
    rawText: { prompt: "hi" },
    focusedIdx: 0,
    submitChoiceIdx: 0,
    caret: 0,
    status: "editing",
  });
  assert.notEqual(getForm("wf-clear"), undefined);

  // session_start calls clearForms(); afterwards a rehydrated card's renderer
  // finds no state and suppresses output.
  clearForms();
  assert.equal(getForm("wf-clear"), undefined);
});

test("overlay: renderer returns undefined (not a string) when the formId is absent", () => {
  // A message with no formId must yield `undefined` so CustomMessageComponent
  // falls back to its default boxed rendering rather than mounting a string.
  _resetForms();
  const { pi, renderers } = makeFakePi();
  registerInlineFormRenderer(pi as never, deriveGraphTheme({}));
  const render = renderers.get("workflows:input-form")!;
  const result = render({ role: "custom", customType: "workflows:input-form", details: {} });
  assert.equal(result, undefined);
});
