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

const FIELDS: readonly WorkflowInputEntry[] = [
  { name: "prompt", type: "text", required: true, description: "task" },
  { name: "iters", type: "number", required: false, default: 5 },
  {
    name: "focus",
    type: "select",
    required: true,
    choices: ["minimal", "standard", "exhaustive"],
    default: "standard",
  },
  { name: "verbose", type: "boolean", required: false },
];

function makeState(overrides: Partial<Parameters<typeof createForm>[0]> = {}) {
  _resetForms();
  return createForm({
    formId: "wf-test",
    workflowName: "ralph",
    description: "loop a thinker",
    fields: FIELDS,
    rawText: { prompt: "", iters: "5", focus: "standard", verbose: "false" },
    focusedIdx: 0,
    caret: 0,
    status: "editing",
    ...overrides,
  });
}

// ── store ────────────────────────────────────────────────────────────────

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

// ── card renderer ────────────────────────────────────────────────────────

function plain(lines: string[]): string {
  // eslint-disable-next-line no-control-regex
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("card (live): shows header pill, workflow chip, all fields, footer hints", () => {
  const state = makeState();
  const lines = renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) });
  const txt = plain(lines);
  assert.match(txt, /WORKFLOW/);
  assert.match(txt, /ralph/);
  assert.match(txt, /loop a thinker/);
  assert.match(txt, /prompt/);
  assert.match(txt, /iters/);
  assert.match(txt, /focus/);
  assert.match(txt, /verbose/);
  assert.match(txt, /1 \/ 4/);
  assert.match(txt, /EDIT/);
  assert.match(txt, /tab/);
  assert.match(txt, /ctrl\+s/);
});

test("card (live): hint row is anchored at the bottom of the widget", () => {
  const state = makeState();
  const lines = renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) });
  // The footer band is the trailing 3 lines; hints live on the middle row.
  const tail = lines.slice(-3).map((l) => plain([l]));
  assert.match(tail.join("\n"), /tab\s+next/);
  assert.match(tail.join("\n"), /esc\s+cancel/);
});

test("card (live): each field title is centred inside its top border", () => {
  const state = makeState();
  const lines = renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) });
  // A centred title row looks like `╭─...─ <name> ─...─╮` with leading
  // dashes before the name. The original left-aligned `╭ <name> ─...─╮`
  // must NOT appear.
  const visible = plain(lines);
  for (const name of ["prompt", "iters", "focus", "verbose"]) {
    assert.match(visible, new RegExp(`╭─+ ${name} ─+╮`));
    assert.doesNotMatch(visible, new RegExp(`╭ ${name} ─+╮`));
  }
});

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

test("card (cancelled): shows ✗ cancelled ribbon", () => {
  const state = makeState({ status: "cancelled" });
  const lines = renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) });
  assert.match(plain(lines), /✗ cancelled/);
});

test("card: select field renders all choices with dot markers", () => {
  const state = makeState({ focusedIdx: 2 });
  const txt = plain(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) }));
  assert.match(txt, /○ minimal/);
  assert.match(txt, /● standard/);
  assert.match(txt, /○ exhaustive/);
});

test("card: focused text field shows the caret so the bottom editor can stay hidden", () => {
  const state = makeState({
    rawText: { prompt: "build", iters: "5", focus: "standard", verbose: "false" },
    focusedIdx: 0,
    caret: 2,
  });
  const txt = plain(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) }));
  assert.match(txt, /bu▋ild/);
});

function assertLinesWithinWidth(lines: string[], width: number): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds ${width} cells: ${visibleWidth(line)} ${JSON.stringify(plain([line]))}`,
    );
  }
}

test("card: live form lines stay within the requested width", () => {
  const width = 113;
  const longDescription = "Maximum number of codebase partitions to explore in parallel. Actual partitions scale by one per 10K LoC, capped by this value.";
  const state = makeState({
    workflowName: "deep-research-codebase-with-a-very-long-name-that-should-not-overflow-the-terminal",
    description: "Prepare a comprehensive multi-agent research workflow with enough prose to exceed the viewport.",
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

// ── editor ───────────────────────────────────────────────────────────────

function makeEditor(state = makeState()) {
  const renders: number[] = [];
  const tui = { requestRender: () => { renders.push(Date.now()); } };
  let exited: { outcome: "submit" | "cancel" } | null = null;
  const editor = new InlineFormEditor(tui, {
    formId: state.formId,
    theme: deriveGraphTheme({}),
    keybindings: makeFakeKeybindings(),
    onExit: (outcome) => { exited = { outcome }; },
  });
  return { editor, state, renders, getExited: () => exited, dispose: () => editor.dispose?.() };
}

test("editor: typing a char inserts at caret on the focused text field", () => {
  const e = makeEditor();
  e.editor.handleInput("h");
  e.editor.handleInput("i");
  assert.equal(e.state.rawText.prompt, "hi");
  assert.equal(e.state.caret, 2);
  e.dispose();
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

test("editor: esc fires onExit('cancel')", () => {
  const e = makeEditor();
  e.editor.handleInput("\x1b");
  assert.deepEqual(e.getExited(), { outcome: "cancel" });
  e.dispose();
});

test("editor: ctrl+s with missing required is a no-op (validation blocks)", () => {
  const e = makeEditor(); // prompt is empty
  e.editor.handleInput("\x13");
  assert.equal(e.getExited(), null);
  e.dispose();
});

test("editor: ctrl+s with all required filled fires onExit('submit')", () => {
  const state = makeState({
    rawText: { prompt: "build", iters: "5", focus: "standard", verbose: "false" },
  });
  const e = makeEditor(state);
  e.editor.handleInput("\x13");
  assert.deepEqual(e.getExited(), { outcome: "submit" });
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
    e.editor.setTopBorder!({ content: "▎ session-name", width: w });
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

// ── overlay (orchestration) ───────────────────────────────────────────────

interface FakePiSurface {
  sentMessages: Array<{ customType: string; details?: { formId?: string } }>;
  renderers: Map<string, (payload: unknown) => unknown>;
  pi: {
    sendMessage: (m: { customType: string; content?: string; display?: boolean; details?: { formId?: string } }) => void;
    registerMessageRenderer: (event: string, r: (payload: unknown) => unknown) => void;
  };
}

function makeFakePi(): FakePiSurface {
  const sentMessages: FakePiSurface["sentMessages"] = [];
  const renderers = new Map<string, (payload: unknown) => unknown>();
  return {
    sentMessages,
    renderers,
    pi: {
      sendMessage: (m) => { sentMessages.push(m); },
      registerMessageRenderer: (event, r) => { renderers.set(event, r); },
    },
  };
}

interface FakeCtx {
  ui: {
    setEditorComponent: (factory: unknown | undefined) => void;
    getEditorComponent?: () => unknown | undefined;
  };
  installed: { factory: unknown | undefined }[];
}

function makeFakeCtx(): FakeCtx {
  const installed: { factory: unknown | undefined }[] = [];
  let current: unknown | undefined;
  return {
    installed,
    ui: {
      setEditorComponent: (factory) => {
        current = factory;
        installed.push({ factory });
      },
      getEditorComponent: () => current,
    },
  };
}

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
  // Fill required prompt and submit.
  editor.handleInput("h");
  editor.handleInput("i");
  editor.handleInput("\x13");
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
  editor.handleInput("\x13");
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

test("overlay: cancelling via esc returns {kind:'cancel'} + freezes state", async () => {
  _resetForms();
  const { pi, sentMessages } = makeFakePi();
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
  const formId = sentMessages[0]!.details!.formId!;
  assert.equal(getForm(formId)?.status, "cancelled");
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
// ── multi-line text field (rich-text prompt box) ──────────────────────────

import { layoutTextField } from "../../packages/workflows/src/tui/inline-form-card.ts";

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
  assert.match(txt, /▋second line/);
  // No literal `⏎` glyph anywhere — we render newlines as rows, not as a sigil.
  assert.doesNotMatch(txt, /⏎/);
});

test("card: unfocused multi-line text field also renders rows, not collapsed", () => {
  const state = makeState({
    rawText: { prompt: "first line\nsecond line", iters: "5", focus: "standard", verbose: "false" },
    focusedIdx: 1, // focus on iters, prompt is unfocused
    caret: 1,
  });
  const txt = plain(renderInlineCard({ width: 80, state, theme: deriveGraphTheme({}) }));
  assert.match(txt, /first line/);
  assert.match(txt, /second line/);
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
  e.editor.handleInput("\x1b[A"); // up — no previous logical line, focus wraps to last
  assert.equal(e.state.focusedIdx, FIELDS.length - 1);
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

// ── paste handling (bracketed + fallback) ────────────────────────────────

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

// ── injected keybindings: word / line / char editing ──────────────────────

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

test("editor: user-remapped delete word backward respects injected keybindings", () => {
  // Drop ctrl+w; remap deleteWordBackward to a hypothetical ctrl+x sequence
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
      "tui.editor.deleteWordBackward": ["\x18"], // ctrl+x
    }),
    onExit: (outcome) => { exited = { outcome }; },
  });
  editor.handleInput("\x18"); // ctrl+x → delete word backward under override
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
  // Form-level keys (tab, esc, ctrl+s, printable insert) still function.
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
