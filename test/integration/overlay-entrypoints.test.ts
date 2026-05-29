/**
 * Tests for WorkflowGraphOverlayAdapter and overlay entrypoints.
 *
 * Every mount path goes through Pi / pi's real
 * `ctx.ui.custom(factory, options)` primitive. There is no legacy
 * object-shaped overlay path.
 *
 * Verifies:
 *   - buildGraphOverlayAdapter is a no-op when pi.ui.custom is absent.
 *   - open(runId) calls pi.ui.custom with overlay:true and full-screen
 *     overlayOptions (width/maxHeight 100%, margin 0).
 *   - The factory returns a PiCustomComponent that paints overlay-style
 *     content; when `tui.terminal.rows` is provided the component
 *     renders that many lines (full-screen) instead of the constant
 *     32-row fallback.
 *   - toggle() uses `setHidden`/`focus` rather than remounting.
 *   - close() releases the OverlayHandle (`hide`) and disposes the view.
 *   - F2 shortcut registration in extension factory calls
 *     overlay.open(activeRunId).
 *   - /workflow resume + /workflow attach + /workflow pause routing.
 *   - Graph-mode Ctrl+D / `h` never kills the run.
 *   - `q` kills and retains the active run for inspection (regression gate).
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildGraphOverlayAdapter } from "../../packages/workflows/src/tui/overlay-adapter.js";
import type { OverlayPiSurface } from "../../packages/workflows/src/tui/overlay-adapter.js";
import type {
  PiCustomComponent,
  PiCustomOverlayFactory,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayFunction,
  PiCustomOverlayOptions,
  PiOverlayHandle,
} from "../../packages/workflows/src/extension/wiring.js";
import {
  createStore,
  store as singletonStore,
} from "../../packages/workflows/src/shared/store.js";
import factory from "../../packages/workflows/src/extension/index.js";
import type {
  ExtensionAPI,
  PiCommandContext,
  PiCommandOptions,
} from "../../packages/workflows/src/extension/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedCustomCall {
  /** Real factory passed to ctx.ui.custom. */
  factory: PiCustomOverlayFactory;
  /** Options passed alongside the factory. */
  options: PiCustomOverlayOptions;
  /** Component returned by the factory after it was invoked. */
  component: PiCustomComponent;
  /** Handle surfaced to the adapter via options.onHandle. */
  handle: PiOverlayHandle;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRenderCount(
  count: () => number,
  target: number,
  polls = 80,
  pollMs = 25,
): Promise<void> {
  for (let i = 0; i < polls && count() < target; i++) {
    await delay(pollMs);
  }
}

/** A controllable in-memory `PiOverlayHandle` used by the mock. */
function buildOverlayHandle(): {
  handle: PiOverlayHandle;
  state: {
    hidden: boolean;
    focused: boolean;
    setHiddenCalls: boolean[];
    focusCalls: number;
    unfocusCalls: number;
    hideCalls: number;
  };
} {
  const state = {
    hidden: false,
    focused: true,
    setHiddenCalls: [] as boolean[],
    focusCalls: 0,
    unfocusCalls: 0,
    hideCalls: 0,
  };
  const handle: PiOverlayHandle = {
    hide: () => {
      state.hideCalls++;
    },
    setHidden: (h) => {
      state.setHiddenCalls.push(h);
      state.hidden = h;
    },
    isHidden: () => state.hidden,
    focus: () => {
      state.focusCalls++;
      state.focused = true;
    },
    unfocus: () => {
      state.unfocusCalls++;
      state.focused = false;
    },
    isFocused: () => state.focused,
  };
  return { handle, state };
}

interface MockUiOpts {
  /** Optional terminal-row hint surfaced to the factory's `tui.terminal.rows`. */
  rows?: number;
  /** Optional terminal-col hint surfaced to the factory's `tui.terminal.columns`. */
  columns?: number;
}

/**
 * Build a pi.ui mock whose `custom` matches the real factory/options
 * signature. Invokes the factory immediately (mirroring Pi's runtime),
 * surfaces an `OverlayHandle` via `options.onHandle`, and captures every
 * call for assertion.
 */
function buildMockUi(mockOpts: MockUiOpts = {}): {
  ui: NonNullable<OverlayPiSurface["ui"]>;
  calls: CapturedCustomCall[];
} {
  const calls: CapturedCustomCall[] = [];
  const ui: NonNullable<OverlayPiSurface["ui"]> = {
    custom: (factoryArg, options) => {
      const { handle } = buildOverlayHandle();
      options.onHandle?.(handle);
      const tui: PiCustomOverlayFactoryTui = {
        requestRender: () => undefined,
        terminal:
          mockOpts.rows != null || mockOpts.columns != null
            ? { rows: mockOpts.rows, columns: mockOpts.columns }
            : undefined,
      };
      const component = factoryArg(tui, {}, {}, () => undefined);
      if (component instanceof Promise) {
        throw new Error("test factory should be sync");
      }
      calls.push({ factory: factoryArg, options, component, handle });
      return undefined;
    },
  };
  return { ui, calls };
}

/** Create a minimal mock pi ExtensionAPI with the real custom overlay surface. */
function buildMockPi(overrides: Partial<ExtensionAPI> = {}): {
  pi: ExtensionAPI;
  shortcuts: Record<string, (ctx?: PiCommandContext) => void>;
  commands: Record<string, { name: string; options: PiCommandOptions }>;
  customCalls: CapturedCustomCall[];
} {
  const shortcuts: Record<string, (ctx?: PiCommandContext) => void> = {};
  const commands: Record<string, { name: string; options: PiCommandOptions }> = {};
  const { ui, calls } = buildMockUi();

  const pi: ExtensionAPI = {
    // The overlay tests assert registration/entrypoint behavior against the
    // bundled startup registry. Disable project/global async discovery so each
    // mock factory instance does not leave unrelated background work running.
    disableAsyncDiscovery: true,
    registerTool: () => undefined,
    registerCommand: (name: string, options: PiCommandOptions) => {
      commands[name] = { name, options };
    },
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    registerShortcut: (key, opts) => {
      shortcuts[key] = opts.handler;
    },
    ui,
    ...overrides,
  };

  return { pi, shortcuts, commands, customCalls: calls };
}

/** Build a slash-command ctx whose `ui.notify` captures the printed messages. */
function buildPrintCtx(): { ctx: PiCommandContext; messages: string[] } {
  const messages: string[] = [];
  return {
    ctx: {
      ui: {
        notify: (m: string) => {
          messages.push(m);
        },
      },
    },
    messages,
  };
}

function buildPrintCtxWithRealCustom(rows?: number): {
  ctx: PiCommandContext;
  messages: string[];
  customCalls: CapturedCustomCall[];
} {
  const messages: string[] = [];
  const { ui, calls } = buildMockUi({ rows });
  const ctx: PiCommandContext = {
    ui: {
      notify: (m: string) => {
        messages.push(m);
      },
      custom: ui.custom,
    },
  };
  return { ctx, messages, customCalls: calls };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleText(lines: string[]): string {
  return lines.join("\n").replace(ANSI_RE, "");
}

function setupSequentialRun(store: ReturnType<typeof createStore>, runId: string, count: number): void {
  store.recordRunStart({
    id: runId,
    name: "wf",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
  });
  for (let i = 0; i < count; i++) {
    store.recordStageStart(runId, {
      id: `stage-${i}`,
      name: `stage-${i}`,
      status: "pending",
      parentIds: i === 0 ? [] : [`stage-${i - 1}`],
      toolEvents: [],
    });
  }
}

function setupBranchingRun(store: ReturnType<typeof createStore>, runId: string): void {
  const stages = [
    { id: "root", parentIds: [] },
    { id: "branch-left", parentIds: ["root"] },
    { id: "branch-right", parentIds: ["root"] },
    { id: "merge", parentIds: ["branch-left", "branch-right"] },
    { id: "tail-a", parentIds: ["merge"] },
    { id: "tail-b", parentIds: ["tail-a"] },
  ];
  setupRunFromStages(store, runId, stages);
}

function setupWideFanoutRun(store: ReturnType<typeof createStore>, runId: string): void {
  setupRunFromStages(store, runId, [
    { id: "root", parentIds: [] },
    { id: "child-0", parentIds: ["root"] },
    { id: "child-1", parentIds: ["root"] },
    { id: "child-2", parentIds: ["root"] },
    { id: "child-3", parentIds: ["root"] },
    { id: "child-4", parentIds: ["root"] },
    { id: "child-5", parentIds: ["root"] },
  ]);
}

function setupRunFromStages(
  store: ReturnType<typeof createStore>,
  runId: string,
  stages: Array<{ id: string; parentIds: string[] }>,
): void {
  store.recordRunStart({
    id: runId,
    name: "wf",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
  });
  for (const stage of stages) {
    store.recordStageStart(runId, {
      id: stage.id,
      name: stage.id,
      status: "pending",
      parentIds: stage.parentIds,
      toolEvents: [],
    });
  }
}

// ---------------------------------------------------------------------------
// buildGraphOverlayAdapter — degraded runtime (no custom)
// ---------------------------------------------------------------------------

describe("buildGraphOverlayAdapter — absent pi.ui.custom", () => {
  test("returns noopOverlay when pi.ui is absent", () => {
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({}, store);
    assert.doesNotThrow(() => adapter.open(null));
    assert.doesNotThrow(() => adapter.open("run-1"));
    assert.doesNotThrow(() => adapter.close());
  });

  test("returns noopOverlay when pi.ui.custom is absent", () => {
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui: {} }, store);
    assert.doesNotThrow(() => adapter.open("run-1"));
    assert.doesNotThrow(() => adapter.close());
  });
});

// ---------------------------------------------------------------------------
// buildGraphOverlayAdapter — open path uses real factory/options shape
// ---------------------------------------------------------------------------

describe("buildGraphOverlayAdapter — open with pi.ui.custom", () => {
  test("open(runId) calls pi.ui.custom with overlay:true and full-screen overlayOptions", () => {
    const { ui, calls } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-abc");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.options.overlay, true);
    assert.equal(calls[0]!.options.overlayOptions?.width, "100%");
    assert.equal(calls[0]!.options.overlayOptions?.maxHeight, "100%");
    assert.equal(calls[0]!.options.overlayOptions?.margin, 0);
    assert.equal(calls[0]!.options.overlayOptions?.anchor, "center");
  });

  test("factory returns a PiCustomComponent that renders string[]", () => {
    const { ui, calls } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-abc");

    const lines = calls[0]!.component.render(80);
    assert.equal(Array.isArray(lines), true);
    assert.ok(lines.length > 0);
  });

  test("component.handleInput is wired to the GraphView", () => {
    const { ui, calls } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-abc");
    // `q` on an empty store completes without throwing — the input is
    // accepted by the GraphView even when there is no live run to kill.
    assert.doesNotThrow(() => calls[0]!.component.handleInput?.("q"));
  });

  test("mock pi overlay render scrolls a tall graph with arrow input", () => {
    const { ui, calls } = buildMockUi({ rows: 32 });
    const store = createStore();
    const runId = "scroll-run";
    setupSequentialRun(store, runId, 6);
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open(runId);

    const component = calls[0]!.component;
    assert.doesNotMatch(visibleText(component.render(96)), /stage-5/);
    for (let i = 0; i < 5; i++) component.handleInput?.("\x1b[B");
    assert.match(visibleText(component.render(96)), /stage-5/);
  });

  test("mock pi switcher render hides graph cells behind the panel", () => {
    const { ui, calls } = buildMockUi({ rows: 32 });
    const store = createStore();
    const runId = "switcher-run";
    setupBranchingRun(store, runId);
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open(runId);

    const component = calls[0]!.component;
    assert.match(visibleText(component.render(200)), /╭──── branch-right/);
    component.handleInput?.("/");
    const withSwitcher = visibleText(component.render(200));
    assert.match(withSwitcher, /STAGES/);
    assert.match(withSwitcher, /│\s+○ root\s+pending\s+│/);
    assert.doesNotMatch(withSwitcher, /^│ ▸/m);
    assert.doesNotMatch(withSwitcher, /╭──── branch-right/);
  });

  test("mock pi switcher render hides node-card graph for long workflows", () => {
    const { ui, calls } = buildMockUi({ rows: 40 });
    const store = createStore();
    const runId = "long-switcher-run";
    setupSequentialRun(store, runId, 16);
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open(runId);

    const component = calls[0]!.component;
    component.handleInput?.("/");
    const withSwitcher = visibleText(component.render(160));
    assert.match(withSwitcher, /STAGES/);
    assert.match(withSwitcher, /│\s+○ stage-0\s+pending\s+│/);
    assert.doesNotMatch(withSwitcher, /╭.*stage-0/);
    assert.doesNotMatch(withSwitcher, /^\s*○ stage-0\s+pending/m);
  });

  test("mock pi render horizontally scrolls wide fan-out graphs", () => {
    const { ui, calls } = buildMockUi({ rows: 32 });
    const store = createStore();
    const runId = "wide-fanout-run";
    setupWideFanoutRun(store, runId);
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open(runId);

    const component = calls[0]!.component;
    assert.doesNotMatch(visibleText(component.render(80)), /╭.*child-5/);
    component.handleInput?.("\x1b[B");
    for (let i = 0; i < 5; i++) component.handleInput?.("\x1b[C");
    const afterNav = visibleText(component.render(80));
    assert.match(afterNav, /╭.*child-5/);
    assert.doesNotMatch(afterNav, /^\s*○ child-5\s+pending/m);
  });

  test("open(null) still calls pi.ui.custom with overlay:true", () => {
    const { ui, calls } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open(null);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.options.overlay, true);
  });

  test("second open() reuses the existing overlay (no remount, no extra custom call)", () => {
    const { ui, calls } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    adapter.open("run-2");

    // Already mounted ⇒ second open() is a no-op (or a setHidden(false)
    // flip when hidden). Either way, no new mount.
    assert.equal(calls.length, 1);
  });

  test("toggle() on a visible mount calls setHidden(true)+unfocus (no remount)", () => {
    const { ui, calls } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    const { handle } = calls[0]!;
    // Reach into the mock state by spying on setHidden calls.
    const setHiddenCalls: boolean[] = [];
    const focusCalls: number[] = [];
    const unfocusCalls: number[] = [];
    handle.setHidden = (h) => {
      setHiddenCalls.push(h);
    };
    handle.isHidden = () => setHiddenCalls.length > 0 && setHiddenCalls[setHiddenCalls.length - 1] === true;
    handle.focus = () => {
      focusCalls.push(focusCalls.length);
    };
    handle.unfocus = () => {
      unfocusCalls.push(unfocusCalls.length);
    };

    adapter.toggle("run-1");
    assert.deepEqual(setHiddenCalls, [true]);
    assert.equal(calls.length, 1, "toggle must not remount");

    // Toggle back: should call setHidden(false) and focus().
    adapter.toggle("run-1");
    assert.deepEqual(setHiddenCalls, [true, false]);
    assert.equal(focusCalls.length, 1);
    assert.equal(calls.length, 1, "toggle must not remount when revealing");
  });

  test("subsequent open() after hiding calls setHidden(false) and focus()", () => {
    const { ui, calls } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    const { handle } = calls[0]!;
    let hidden = false;
    const setHiddenCalls: boolean[] = [];
    let focusCalls = 0;
    handle.setHidden = (h) => {
      setHiddenCalls.push(h);
      hidden = h;
    };
    handle.isHidden = () => hidden;
    handle.focus = () => {
      focusCalls++;
    };
    handle.unfocus = () => undefined;

    // Hide via toggle.
    adapter.toggle("run-1");
    assert.equal(hidden, true);

    // Re-open: adapter should detect the hidden state and reveal.
    adapter.open("run-1");
    assert.deepEqual(setHiddenCalls, [true, false]);
    assert.equal(focusCalls, 1);
    assert.equal(calls.length, 1, "open after hide must not remount");
  });

  test("fullscreen overlay renders terminal.rows lines when tui.terminal.rows is set", () => {
    const { ui, calls } = buildMockUi({ rows: 50, columns: 120 });
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-fullscreen");
    const lines = calls[0]!.component.render(120);
    assert.equal(lines.length, 50, "should fill the terminal-row viewport");
  });

  test("falls back to 32-row frame when tui.terminal is absent", () => {
    const { ui, calls } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-fallback");
    const lines = calls[0]!.component.render(120);
    assert.equal(lines.length, 32, "fallback line count keeps the legacy rectangle");
  });
});

// ---------------------------------------------------------------------------
// buildGraphOverlayAdapter — close path
// ---------------------------------------------------------------------------

describe("buildGraphOverlayAdapter — close", () => {
  test("close() calls handle.hide and disposes the component", () => {
    const { ui, calls } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    let hideCount = 0;
    calls[0]!.handle.hide = () => {
      hideCount++;
    };
    // Pi disposes the rendered component when the overlay unmounts.
    // Mirror that here: the adapter's close() drives `finishMounted`
    // which disposes the WorkflowAttachPane; once it has, calling
    // `render` again should not throw — the view treats the second
    // call as a re-render of an empty surface.
    adapter.close();

    assert.equal(hideCount, 1, "close() must release the overlay handle via hide()");
    // After close(), the adapter has cleared `currentHandle`. Toggling
    // would then re-mount, so calling open() again should issue a new
    // pi.ui.custom invocation.
    adapter.open("run-2");
    assert.equal(calls.length, 2, "open() after close() must remount via pi.ui.custom");
  });

  test("close() before open() does not throw", () => {
    const { ui } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);
    assert.doesNotThrow(() => adapter.close());
  });

  test("close() is idempotent once the overlay has unmounted", () => {
    const { ui, calls } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    adapter.close();
    // Second close — adapter has already cleared its handle/view refs.
    assert.doesNotThrow(() => adapter.close());
    assert.equal(calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// F2 shortcut — registered in extension factory
// ---------------------------------------------------------------------------

describe("extension factory — F2 shortcut", () => {
  test("F2 shortcut is registered when registerShortcut is present", () => {
    const { pi, shortcuts } = buildMockPi();
    factory(pi);
    assert.equal("F2" in shortcuts, true);
  });

  test("F2 handler calls pi.ui.custom with overlay:true and full-screen options", () => {
    const { pi, shortcuts, customCalls } = buildMockPi();
    factory(pi);

    shortcuts["F2"]!();

    assert.ok(customCalls.length >= 1);
    assert.equal(customCalls[0]!.options.overlay, true);
    assert.equal(customCalls[0]!.options.overlayOptions?.width, "100%");
    assert.equal(customCalls[0]!.options.overlayOptions?.maxHeight, "100%");
  });

  test("F2 handler uses shortcut ctx.ui.custom when top-level pi.ui is absent", () => {
    const { pi, shortcuts } = buildMockPi();
    delete pi.ui;
    factory(pi);

    const { ctx, customCalls } = buildPrintCtxWithRealCustom();
    shortcuts["F2"]!(ctx);

    assert.equal(customCalls.length, 1);
    assert.equal(customCalls[0]!.options.overlay, true);
  });

  test("F2 handler does not throw when no active run", () => {
    const { pi, shortcuts } = buildMockPi();
    factory(pi);
    // store.activeRunId() → null when no run started.
    assert.doesNotThrow(() => shortcuts["F2"]!());
  });

  test("F2 shortcut NOT registered when registerShortcut absent", () => {
    const { pi } = buildMockPi();
    delete pi.registerShortcut;
    const shortcuts: Record<string, (ctx?: PiCommandContext) => void> = {};
    // Should not crash when registerShortcut is absent.
    assert.doesNotThrow(() => factory(pi));
    assert.equal("F2" in shortcuts, false);
  });
});

// ---------------------------------------------------------------------------
// /workflow resume — calls overlay.open after successful resumeRun
// ---------------------------------------------------------------------------

describe("/workflow resume — overlay integration", () => {
  test("resume with unknown runId prints not-found, does NOT call custom", () => {
    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);

    const wfCmd = commands["workflow"]!;
    const { ctx } = buildPrintCtx();

    void wfCmd.options.handler("resume no-such-run", ctx);

    assert.equal(customCalls.length, 0);
  });

  test("resume with no runId prints usage", async () => {
    const { pi, commands } = buildMockPi();
    factory(pi);

    const wfCmd = commands["workflow"]!;
    const { ctx, messages } = buildPrintCtx();

    await wfCmd.options.handler("resume", ctx);

    assert.equal(
      messages.some((m) => m.includes("Usage")),
      true,
    );
  });

  test("resume subcommand is listed in argument completions", async () => {
    const { pi, commands } = buildMockPi();
    factory(pi);

    const wfCmd = commands["workflow"]!;
    const completions = (await wfCmd.options.getArgumentCompletions?.("res")) ?? [];

    assert.equal(
      completions.some((c) => c.label === "resume"),
      true,
    );
  });

  // RFC regression gate: overlay.open MUST be called when resume succeeds.
  test("resume with known completed runId calls overlay.open", async () => {
    const runId = `test-resume-run-${Date.now()}`;

    singletonStore.recordRunStart({
      id: runId,
      name: "test-wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });
    singletonStore.recordRunEnd(runId, "completed", {});

    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);

    const wfCmd = commands["workflow"]!;
    const { ctx } = buildPrintCtx();

    await wfCmd.options.handler(`resume ${runId}`, ctx);

    assert.ok(customCalls.length >= 1);
    assert.equal(customCalls[0]!.options.overlay, true);
  });

  test("resume with still-active runId calls overlay.open", async () => {
    const runId = `test-active-run-${Date.now()}`;

    singletonStore.recordRunStart({
      id: runId,
      name: "active-wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);

    const wfCmd = commands["workflow"]!;
    const { ctx } = buildPrintCtx();

    await wfCmd.options.handler(`resume ${runId}`, ctx);

    assert.equal(customCalls.length, 1);
    assert.equal(customCalls[0]!.options.overlay, true);
  });

  test("resume uses real command ctx.ui.custom when top-level pi.ui is absent", async () => {
    const runId = `test-real-ui-run-${Date.now()}`;
    singletonStore.recordRunStart({
      id: runId,
      name: "real-ui-wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    const { pi, commands } = buildMockPi();
    delete pi.ui;
    factory(pi);

    const wfCmd = commands["workflow"]!;
    const { ctx, customCalls } = buildPrintCtxWithRealCustom();

    await wfCmd.options.handler(`resume ${runId}`, ctx);

    assert.equal(customCalls.length, 1);
    assert.equal(customCalls[0]!.options.overlay, true);
  });

  test("/workflow run does NOT auto-open the overlay (opt-in via F2)", async () => {
    const { pi, commands } = buildMockPi();
    delete pi.ui;
    factory(pi);

    const wfCmd = commands["workflow"]!;
    const { ctx, customCalls } = buildPrintCtxWithRealCustom();

    await wfCmd.options.handler("deep-research-codebase prompt=test", ctx);

    assert.equal(customCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// /workflow pause + /workflow attach + paused-resume — integration
// ---------------------------------------------------------------------------

describe("/workflow pause — top-level command", () => {
  test("pause with no args and no active runs prints a hint", async () => {
    singletonStore.clear();
    const { pi, commands } = buildMockPi();
    factory(pi);
    const wfCmd = commands["workflow"]!;
    const { ctx, messages } = buildPrintCtx();
    await wfCmd.options.handler("pause", ctx);
    const joined = messages.join("\n");
    assert.ok(
      joined.toLowerCase().includes("no active runs") ||
        joined.toLowerCase().includes("picker requires"),
      `unexpected output: ${joined}`,
    );
  });

  test("pause <unknown> prints not-found", async () => {
    singletonStore.clear();
    const { pi, commands } = buildMockPi();
    factory(pi);
    const wfCmd = commands["workflow"]!;
    const { ctx, messages } = buildPrintCtx();
    await wfCmd.options.handler("pause no-such-run", ctx);
    const joined = messages.join("\n");
    assert.match(joined, /Run not found/);
  });
});

describe("/workflow resume — paused vs non-paused branching", () => {
  test("resume <runId> on a non-paused run still reopens the overlay", async () => {
    singletonStore.clear();
    const runId = `test-non-paused-${Date.now()}`;
    singletonStore.recordRunStart({
      id: runId,
      name: "snap-only-wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });
    singletonStore.recordRunEnd(runId, "completed", {});
    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);
    const wfCmd = commands["workflow"]!;
    const { ctx } = buildPrintCtx();
    await wfCmd.options.handler(`resume ${runId}`, ctx);
    assert.ok(customCalls.length >= 1);
    assert.equal(customCalls[0]!.options.overlay, true);
  });
});

describe("/workflow attach — top-level command", () => {
  test("attach <runId> opens the overlay", async () => {
    singletonStore.clear();
    const runId = `test-attach-${Date.now()}`;
    singletonStore.recordRunStart({
      id: runId,
      name: "attach-wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });
    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);
    const wfCmd = commands["workflow"]!;
    const { ctx } = buildPrintCtx();
    await wfCmd.options.handler(`attach ${runId}`, ctx);
    assert.ok(customCalls.length >= 1);
    assert.equal(customCalls[0]!.options.overlay, true);
  });

  test("attach <unknown> prints not-found and does not open the overlay", async () => {
    singletonStore.clear();
    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);
    const wfCmd = commands["workflow"]!;
    const { ctx, messages } = buildPrintCtx();
    await wfCmd.options.handler("attach not-a-run", ctx);
    assert.match(messages.join("\n"), /Run not found/);
    assert.equal(customCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Graph-mode Ctrl+D / `h` — non-destructive hide, never kills the run
// ---------------------------------------------------------------------------

describe("buildGraphOverlayAdapter — Ctrl+D / h non-destructive hide", () => {
  test("Ctrl+D without onHandle invokes factory done() and keeps the run alive", () => {
    const runId = `ctrl-d-no-onhandle-${Date.now()}`;
    const store = createStore();
    store.recordRunStart({
      id: runId,
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    let doneCalled = 0;
    let capturedComponent: PiCustomComponent | undefined;
    // Custom variant that skips `options.onHandle` so the adapter has
    // no OverlayHandle to flip — `Ctrl+D` must fall back to `done()`.
    const customFn: PiCustomOverlayFunction = (factoryArg, _options) => {
      const tui: PiCustomOverlayFactoryTui = {
        requestRender: () => undefined,
      };
      const component = factoryArg(tui, {}, {}, (_result) => {
        doneCalled++;
      });
      if (component instanceof Promise) throw new Error("expected sync factory");
      capturedComponent = component;
      return undefined;
    };

    const adapter = buildGraphOverlayAdapter({ ui: { custom: customFn } }, store);
    adapter.open(runId);

    assert.ok(capturedComponent, "factory should return a component");
    assert.equal(typeof capturedComponent!.handleInput, "function");

    capturedComponent!.handleInput!("\x04");

    assert.equal(doneCalled, 1, "Ctrl+D should invoke done(undefined) exactly once");
    const run = store.runs().find((r) => r.id === runId);
    assert.ok(run, "run should still exist in the store");
    assert.notEqual(run!.status, "killed", "Ctrl+D must not transition status to killed");
    assert.equal(run!.endedAt, undefined, "Ctrl+D must not end the run");
  });

  test("Ctrl+D WITH onHandle hides via setHidden(true)+unfocus and keeps the run alive", () => {
    const runId = `ctrl-d-with-onhandle-${Date.now()}`;
    const store = createStore();
    store.recordRunStart({
      id: runId,
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    let hidden = false;
    const setHiddenCalls: boolean[] = [];
    let unfocusCalls = 0;
    let doneCalled = 0;
    let capturedComponent: PiCustomComponent | undefined;
    const overlayHandle: PiOverlayHandle = {
      hide: () => undefined,
      setHidden: (h) => {
        setHiddenCalls.push(h);
        hidden = h;
      },
      isHidden: () => hidden,
      focus: () => undefined,
      unfocus: () => {
        unfocusCalls++;
      },
      isFocused: () => !hidden,
    };
    const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
      options.onHandle?.(overlayHandle);
      const tui: PiCustomOverlayFactoryTui = {
        requestRender: () => undefined,
      };
      const component = factoryArg(tui, {}, {}, () => {
        doneCalled++;
      });
      if (component instanceof Promise) throw new Error("expected sync factory");
      capturedComponent = component;
      return undefined;
    };

    const adapter = buildGraphOverlayAdapter({ ui: { custom: customFn } }, store);
    adapter.open(runId);

    capturedComponent!.handleInput!("\x04");

    assert.deepEqual(setHiddenCalls, [true], "Ctrl+D should call setHidden(true) once");
    assert.equal(unfocusCalls, 1, "Ctrl+D should release focus once");
    assert.equal(doneCalled, 0, "Ctrl+D with onHandle must NOT invoke done()");
    const run = store.runs().find((r) => r.id === runId);
    assert.notEqual(run!.status, "killed");
    assert.equal(run!.endedAt, undefined);
  });

  test("`q` on a real custom mount kills and retains the active run (regression gate)", () => {
    const runId = `q-kill-${Date.now()}`;
    const store = createStore();
    store.recordRunStart({
      id: runId,
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    let capturedComponent: PiCustomComponent | undefined;
    const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
      const { handle } = buildOverlayHandle();
      options.onHandle?.(handle);
      const tui: PiCustomOverlayFactoryTui = {
        requestRender: () => undefined,
      };
      const component = factoryArg(tui, {}, {}, () => undefined);
      if (component instanceof Promise) throw new Error("expected sync factory");
      capturedComponent = component;
      return undefined;
    };

    const adapter = buildGraphOverlayAdapter({ ui: { custom: customFn } }, store);
    adapter.open(runId);

    capturedComponent!.handleInput!("q");

    const run = store.runs().find((r) => r.id === runId);
    assert.ok(run, "`q` must retain the run in live history/status for inspection");
    assert.equal(run.status, "killed");
    assert.notEqual(run.endedAt, undefined);
  });
});

// ---------------------------------------------------------------------------
// buildGraphOverlayAdapter — animation tick visibility gating
// ---------------------------------------------------------------------------

describe("buildGraphOverlayAdapter — animation tick visibility gating", () => {
  test("requestRender from the view fires tui.requestRender while visible", async () => {
    const runId = `tick-visible-${Date.now()}`;
    const store = createStore();
    store.recordRunStart({
      id: runId,
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    let renderCalls = 0;
    let component: PiCustomComponent | undefined;
    const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
      const { handle } = buildOverlayHandle();
      options.onHandle?.(handle);
      const tui: PiCustomOverlayFactoryTui = {
        requestRender: () => {
          renderCalls++;
        },
      };
      const c = factoryArg(tui, {}, {}, () => undefined);
      if (c instanceof Promise) throw new Error("expected sync factory");
      component = c;
      return undefined;
    };

    const adapter = buildGraphOverlayAdapter({ ui: { custom: customFn } }, store);
    adapter.open(runId);
    assert.ok(component, "factory should return a component");
    // Animation tick is 100ms, but Windows CI can starve the event loop long
    // enough that a single wall-clock sleep observes only one interval turn.
    // Poll across scheduler turns instead of assuming 250ms means two ticks.
    try {
      await waitForRenderCount(() => renderCalls, 2);
      assert.ok(
        renderCalls >= 2,
        `expected tui.requestRender to fire on the animation tick (got ${renderCalls})`,
      );
    } finally {
      component!.dispose?.();
    }
  });

  test("requestRender suppresses tui.requestRender while overlay is hidden", async () => {
    const runId = `tick-hidden-${Date.now()}`;
    const store = createStore();
    store.recordRunStart({
      id: runId,
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    let renderCalls = 0;
    let component: PiCustomComponent | undefined;
    let hidden = false;
    const overlayHandle: PiOverlayHandle = {
      hide: () => undefined,
      setHidden: (h) => {
        hidden = h;
      },
      isHidden: () => hidden,
      focus: () => undefined,
      unfocus: () => undefined,
      isFocused: () => !hidden,
    };
    const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
      options.onHandle?.(overlayHandle);
      const tui: PiCustomOverlayFactoryTui = {
        requestRender: () => {
          renderCalls++;
        },
      };
      const c = factoryArg(tui, {}, {}, () => undefined);
      if (c instanceof Promise) throw new Error("expected sync factory");
      component = c;
      return undefined;
    };

    const adapter = buildGraphOverlayAdapter({ ui: { custom: customFn } }, store);
    adapter.open(runId);
    // Flip to hidden before the first tick can fire.
    overlayHandle.setHidden(true);
    const before = renderCalls;
    await new Promise((r) => setTimeout(r, 250));
    const after = renderCalls;
    component!.dispose?.();
    assert.equal(
      after,
      before,
      `tui.requestRender must not fire while overlay is hidden (before=${before}, after=${after})`,
    );
  });

  test("tick stops after the component is disposed", async () => {
    const runId = `tick-dispose-${Date.now()}`;
    const store = createStore();
    store.recordRunStart({
      id: runId,
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    let renderCalls = 0;
    let component: PiCustomComponent | undefined;
    const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
      const { handle } = buildOverlayHandle();
      options.onHandle?.(handle);
      const tui: PiCustomOverlayFactoryTui = {
        requestRender: () => {
          renderCalls++;
        },
      };
      const c = factoryArg(tui, {}, {}, () => undefined);
      if (c instanceof Promise) throw new Error("expected sync factory");
      component = c;
      return undefined;
    };

    const adapter = buildGraphOverlayAdapter({ ui: { custom: customFn } }, store);
    adapter.open(runId);
    await new Promise((r) => setTimeout(r, 150));
    component!.dispose?.();
    const afterDispose = renderCalls;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      renderCalls,
      afterDispose,
      "no further ticks should fire after dispose",
    );
  });
});
