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
test("overlay: openInlineInputsForm emits a custom message and swaps editor", async () => {
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

  // An editor factory was installed.
  assert.equal(ctx.installed.length, 1);
  const installed = ctx.installed[0]!.factory as
    | ((tui: unknown, theme: unknown, kb: unknown) => InlineFormEditor)
    | undefined;
  assert.equal(typeof installed, "function");

  // Build the editor via the installed factory and submit it.
  const tui = { requestRender: () => {} };
  const editor = installed!(tui, {}, makeFakeKeybindings());
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

  // Editor restored (setEditorComponent called again with previous = undefined).
  assert.equal(ctx.installed.length, 2);
  assert.equal(ctx.installed[1]!.factory, undefined);

  // Form state remained in the store, status: submitted (sticky scrollback).
  assert.equal(getForm(formId)?.status, "submitted");
});

test("overlay: openInlineInputsForm hides working while mounted and restores on submit", async () => {
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

  assert.deepEqual(workingCalls, [false]);
  const factory = ctx.installed[0]!.factory as
    | ((tui: unknown, theme: unknown, kb: unknown) => InlineFormEditor);
  const editor = factory({ requestRender: () => {} }, {}, makeFakeKeybindings());
  editor.handleInput("h");
  editor.handleInput("i");
  for (let i = 0; i < FIELDS.length; i += 1) editor.handleInput("\t");
  editor.handleInput("\r");

  const result = await pending;
  assert.equal(result.kind, "run");
  assert.deepEqual(workingCalls, [false, true]);
});

test("overlay: openInlineInputsForm restores working on cancel", async () => {
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
  const factory = ctx.installed[0]!.factory as
    | ((tui: unknown, theme: unknown, kb: unknown) => InlineFormEditor);
  factory({ requestRender: () => {} }, {}, makeFakeKeybindings()).handleInput("\x1b");

  const result = await pending;
  assert.equal(result.kind, "cancel");
  assert.deepEqual(workingCalls, [false, true]);
});

test("overlay: openInlineInputsForm restores working on unsupported setup failure", async () => {
  _resetForms();
  const { pi } = makeFakePi();
  const workingCalls: boolean[] = [];
  const ctx = {
    ui: {
      setWorkingVisible: (visible: boolean) => workingCalls.push(visible),
      setEditorComponent: () => {
        throw new Error("cannot install editor");
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

test("overlay: openInlineInputsForm restores working on sendMessage failure", async () => {
  _resetForms();
  const ctx = makeFakeCtx();
  const workingCalls: boolean[] = [];
  ctx.ui.setWorkingVisible = (visible: boolean) => workingCalls.push(visible);
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
  assert.deepEqual(workingCalls, [false, true]);
});

test("overlay: openInlineInputsForm works with pi runtime UI shape", async () => {
  _resetForms();
  const { pi, sentMessages } = makeFakePi();
  const baseCtx = makeFakeCtx();
  const ctx = {
    installed: baseCtx.installed,
    ui: {
      setEditorComponent: baseCtx.ui.setEditorComponent,
    },
  };

  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(ctx.installed.length, 1);
  const installed = ctx.installed[0]!.factory as
    | ((tui: unknown, theme: unknown, kb: unknown) => InlineFormEditor)
    | undefined;
  assert.equal(typeof installed, "function");

  const editor = installed!({ requestRender: () => {} }, {}, makeFakeKeybindings());
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
  assert.equal(ctx.installed[1]!.factory, undefined);
});

test("overlay: installed editor accepts pi setup before card render", async () => {
  _resetForms();
  const { pi, sentMessages } = makeFakePi();
  let editor: InlineFormEditor | undefined;
  const ctx = {
    ui: {
      setEditorComponent: (factory: unknown | undefined) => {
        if (typeof factory !== "function") return;
        editor = (factory as (tui: unknown, theme: unknown, kb: unknown) => InlineFormEditor)(
          { requestRender: () => {} },
          {},
          {},
        );
        editor.setUseTerminalCursor(true);
        editor.setAutocompleteMaxVisible(30);
        editor.setMaxHeight(4);
        editor.setHistoryStorage({});
      },
    },
  };

  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.equal(sentMessages.length, 1);
  assert.ok(editor);
  assert.equal(editor.getUseTerminalCursor(), true);
  assert.equal(editor.getAutocompleteMaxVisible(), 20);
  editor.handleInput("o");
  editor.handleInput("k");
  for (let i = 0; i < FIELDS.length; i += 1) editor.handleInput("\t");
  editor.handleInput("\r");
  const result = await pending;
  assert.equal(result.kind, "run");
});

test("overlay: host editor setup failure resolves unsupported without emitting card", async () => {
  _resetForms();
  const { pi, sentMessages } = makeFakePi();
  const ctx = {
    ui: {
      setEditorComponent: (factory: unknown | undefined) => {
        assert.equal(typeof factory, "function");
        const editor = (factory as (tui: unknown, theme: unknown, kb: unknown) => InlineFormEditor)(
          { requestRender: () => {} },
          {},
          makeFakeKeybindings(),
        );
        assert.equal(typeof editor.setUseTerminalCursor, "function");
        throw new TypeError("nextEditor.setUseTerminalCursor is not a function");
      },
    },
  };

  const result = await openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.equal(result.kind, "unsupported");
  assert.equal(sentMessages.length, 0);
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
  const factory = ctx.installed[0]!.factory as
    | ((tui: unknown, theme: unknown, kb: unknown) => InlineFormEditor);
  const editor = factory({ requestRender: () => {} }, {}, makeFakeKeybindings());
  editor.handleInput("\x1b");
  const result = await pending;
  assert.equal(result.kind, "cancel");
  const message = sentMessages[0]!;
  const formId = message.details!.formId!;
  assert.equal(getForm(formId)?.status, "cancelled");
  const rendered = renderers.get("workflows:input-form")?.(message) as { render(width: number): string[] };
  assert.deepEqual(rendered.render(80), []);
});

test("overlay: late settle after host editor reset does not restore stale previous editor", async () => {
  _resetForms();
  const { pi } = makeFakePi();
  const previousFactory = () => ({
    render: () => [],
    handleInput: () => undefined,
    invalidate: () => undefined,
  });
  const installed: { factory: unknown | undefined }[] = [];
  let current: unknown | undefined = previousFactory;
  const ctx = {
    ui: {
      setEditorComponent: (factory: unknown | undefined) => {
        current = factory;
        installed.push({ factory });
      },
      getEditorComponent: () => current,
    },
  };

  const pending = openInlineInputsForm(pi as never, ctx as never, {
    workflowName: "ralph",
    fields: FIELDS,
    theme: deriveGraphTheme({}),
  });

  assert.equal(installed.length, 1);
  const formFactory = installed[0]!.factory as
    | ((tui: unknown, theme: unknown, kb: unknown) => InlineFormEditor);
  const editor = formFactory({ requestRender: () => {} }, {}, makeFakeKeybindings());

  // Simulate pi's `/new` session-replacement reset restoring the default editor
  // before the old workflow form promise settles.
  ctx.ui.setEditorComponent(undefined);
  editor.handleInput("\x1b");

  const result = await pending;
  assert.equal(result.kind, "cancel");
  assert.equal(
    installed.length,
    2,
    "old form must not write previousFactory into the new session",
  );
  assert.equal(installed[1]!.factory, undefined);
});

test("overlay: missing setEditorComponent → immediate unsupported (headless)", async () => {
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
  // Cancel so the promise resolves and we don't leak a timer.
  const factory = ctx.installed[0]!.factory as
    | ((tui: unknown, theme: unknown, kb: unknown) => InlineFormEditor);
  factory({ requestRender: () => {} }, {}, makeFakeKeybindings()).handleInput("\x1b");
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
