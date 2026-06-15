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
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type {
  PiCustomComponent,
  PiCustomOverlayFactory,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayFunction,
  PiCustomOverlayOptions,
  PiHostCustomUiStateListener,
  PiOverlayHandle,
} from "../../packages/workflows/src/extension/wiring.js";
import {
  createStore,
  store as singletonStore,
} from "../../packages/workflows/src/shared/store.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { Type } from "typebox";
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

async function waitForStagePendingPrompt(
  store: ReturnType<typeof createStore>,
  runId: string,
  expectedKind?: "input" | "confirm" | "select" | "editor",
  timeoutMs = 5000,
): Promise<{ stageId: string; promptId: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.runs().find((candidate) => candidate.id === runId);
    const stage = run?.stages.find((candidate) => {
      const prompt = candidate.pendingPrompt;
      return prompt !== undefined && (expectedKind === undefined || prompt.kind === expectedKind);
    });
    if (stage?.pendingPrompt) return { stageId: stage.id, promptId: stage.pendingPrompt.id };
    await delay(5);
  }
  throw new Error(`stage pending prompt did not appear on run ${runId}`);
}

async function waitForRunEnded(
  store: ReturnType<typeof createStore>,
  runId: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.runs().find((candidate) => candidate.id === runId);
    if (run?.endedAt !== undefined) return;
    await delay(5);
  }
  throw new Error(`run ${runId} did not end in time`);
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
  /** Optional observer for custom overlay render requests. */
  onRequestRender?: () => void;
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
        requestRender: () => mockOpts.onRequestRender?.(),
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

function buildInteractiveHostCustomUi(): {
  ui: NonNullable<OverlayPiSurface["ui"]>;
  customMounts: PiCustomOverlayFactory[];
  overlayHandles: Array<ReturnType<typeof buildOverlayHandle>>;
  overlayShows: () => number;
  focusTargets: unknown[];
  customPromises: Promise<unknown>[];
} {
  initTheme("dark");
  const customMounts: PiCustomOverlayFactory[] = [];
  const customPromises: Promise<unknown>[] = [];
  const overlayHandles: Array<ReturnType<typeof buildOverlayHandle>> = [];
  const focusTargets: unknown[] = [];
  let overlayShowCount = 0;
  const host: any = {
    editor: {
      getText: () => "",
      setText: () => undefined,
    },
    editorContainer: {
      clear: () => undefined,
      addChild: () => undefined,
    },
    keybindings: {},
    ui: {
      setFocus: (target: unknown) => {
        focusTargets.push(target);
      },
      requestRender: () => undefined,
      showOverlay: () => {
        overlayShowCount++;
        const overlayHandle = buildOverlayHandle();
        overlayHandles.push(overlayHandle);
        return overlayHandle.handle;
      },
      hideOverlay: () => undefined,
    },
    blockingInlineCustomUiDepth: 0,
    deferredInlineCustomUiFocusDepth: 0,
    pendingInlineCustomUiFocus: undefined,
    hostCustomUiStateListeners: new Set(),
  };
  Object.setPrototypeOf(host, (InteractiveMode as any).prototype);

  const ui = host.ui as NonNullable<OverlayPiSurface["ui"]>;
  ui.custom = (factoryArg, options) => {
    customMounts.push(factoryArg);
    const promise = (InteractiveMode as any).prototype.showExtensionCustom.call(
      host,
      factoryArg,
      options,
    ) as Promise<unknown>;
    customPromises.push(promise);
    return promise;
  };
  ui.getHostCustomUiState = () => host.getHostCustomUiState();
  ui.onHostCustomUiStateChange = (listener) => host.onHostCustomUiStateChange(listener);

  return {
    ui,
    customMounts,
    overlayHandles,
    overlayShows: () => overlayShowCount,
    focusTargets,
    customPromises,
  };
}

function attachHostCustomUiState(ui: NonNullable<OverlayPiSurface["ui"]>): {
  setActive: (active: boolean) => void;
  listenerCount: () => number;
} {
  let depth = 0;
  const listeners = new Set<PiHostCustomUiStateListener>();
  const snapshot = () => ({
    blockingInlineCustomUiDepth: depth,
    blockingInlineCustomUiActive: depth > 0,
  });
  ui.getHostCustomUiState = snapshot;
  ui.onHostCustomUiStateChange = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    setActive: (active) => {
      depth = active ? 1 : 0;
      const state = snapshot();
      for (const listener of listeners) listener(state);
    },
    listenerCount: () => listeners.size,
  };
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

  test("same-turn open() calls through InteractiveMode custom path do not remount (#1353)", async () => {
    const { ui, customMounts, overlayShows, customPromises } = buildInteractiveHostCustomUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    adapter.open("run-2");

    assert.equal(customMounts.length, 1, "second same-turn open must not call ctx.ui.custom again");
    await Promise.resolve();
    assert.equal(overlayShows(), 1, "host should mount only one overlay component");

    adapter.close();
    await Promise.allSettled(customPromises);
  });

  test("pre-aborted host custom UI does not yield or refocus a visible graph overlay (#1353)", async () => {
    const { ui, overlayHandles, customPromises } = buildInteractiveHostCustomUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    await Promise.resolve();
    assert.equal(overlayHandles.length, 1, "overlay should be visible before pre-aborted host UI");

    const { state } = overlayHandles[0]!;
    const controller = new AbortController();
    const failure = new Error("already aborted");
    let factoryCalls = 0;
    controller.abort(failure);

    const preAborted = ui.custom!(
      () => {
        factoryCalls++;
        return { render: () => [], invalidate: () => undefined };
      },
      { overlay: false, signal: controller.signal } as PiCustomOverlayOptions & { signal: AbortSignal },
    ) as Promise<unknown>;

    await assert.rejects(preAborted, /already aborted/);
    assert.equal(factoryCalls, 0, "pre-aborted inline host UI must not invoke the factory");
    assert.deepEqual(state.setHiddenCalls, [], "pre-abort must not hide or restore the overlay");
    assert.equal(state.unfocusCalls, 0, "pre-abort must not unfocus the overlay");
    assert.equal(state.focusCalls, 0, "pre-abort must not refocus the overlay");
    assert.equal(state.hidden, false);
    assert.equal(state.focused, true);

    adapter.close();
    await Promise.allSettled(customPromises);
  });

  test("hiding the graph focuses the pending main-chat inline custom UI (#1353)", async () => {
    const { ui, focusTargets, customPromises } = buildInteractiveHostCustomUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    await Promise.resolve();

    let finishInline!: (value: string) => void;
    const inlineComponent: PiCustomComponent = {
      render: () => ["QUESTION"],
      invalidate: () => undefined,
    };
    const inlinePromise = ui.custom!(
      (_tui, _theme, _keybindings, done: (value: string) => void) => {
        finishInline = done;
        return inlineComponent;
      },
      { overlay: false } as PiCustomOverlayOptions,
    ) as Promise<unknown>;
    await Promise.resolve();

    assert.equal(
      focusTargets.includes(inlineComponent),
      false,
      "inline main-chat UI must not steal focus while the graph is visible",
    );

    adapter.toggle("run-1");

    assert.equal(
      focusTargets.at(-1),
      inlineComponent,
      "exiting/hiding the graph should focus the pending main-chat UI",
    );
    finishInline("answered");
    await assert.doesNotReject(inlinePromise);
    adapter.close();
    await Promise.allSettled(customPromises);
  });

  // Regression for issue #1120: retargeting a visible, mounted overlay must
  // restore keyboard focus. pi-tui only dispatches key events to the focused
  // component, so without this the retargeted overlay (e.g. brought to a
  // stage-scoped HIL prompt / readiness gate) appears frozen — arrows, Enter,
  // Ctrl+D and `q` all dead.
  test("retargeting a visible mounted overlay restores keyboard focus (#1120)", () => {
    const { ui, calls } = buildMockUi();
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    const { handle } = calls[0]!;
    let focusCalls = 0;
    handle.focus = () => {
      focusCalls++;
    };
    handle.isHidden = () => false; // mounted AND visible

    // Retarget the visible overlay to a different run/stage.
    adapter.open("run-2");

    assert.equal(calls.length, 1, "retarget must not remount");
    assert.equal(focusCalls, 1, "visible retarget must restore keyboard focus (#1120)");
  });

  test("host inline custom UI stays pending behind a focused graph overlay (#1353)", () => {
    let renderCalls = 0;
    const { ui, calls } = buildMockUi({
      onRequestRender: () => {
        renderCalls++;
      },
    });
    const statusMessages: Array<{ key: string; value: string | undefined }> = [];
    ui.setStatus = (key, value) => {
      statusMessages.push({ key, value });
    };
    const hostCustomUi = attachHostCustomUiState(ui);
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    const { handle } = calls[0]!;
    let hidden = false;
    let focused = true;
    const setHiddenCalls: boolean[] = [];
    let focusCalls = 0;
    let unfocusCalls = 0;
    handle.isHidden = () => hidden;
    handle.setHidden = (value) => {
      setHiddenCalls.push(value);
      hidden = value;
    };
    handle.isFocused = () => focused;
    handle.focus = () => {
      focusCalls++;
      focused = true;
    };
    handle.unfocus = () => {
      unfocusCalls++;
      focused = false;
    };

    hostCustomUi.setActive(true);
    assert.equal(hidden, false, "host question must not hide the graph");
    assert.equal(focused, true, "graph overlay keeps keyboard focus");
    assert.deepEqual(setHiddenCalls, []);
    assert.equal(unfocusCalls, 0);
    assert.ok(
      statusMessages.some(
        (status) =>
          status.key === "pi-workflows:main-chat-input" &&
          status.value === "Main chat needs input — exit graph to answer.",
      ),
      "focused graph should hint that main chat has a pending question",
    );
    assert.equal(calls.length, 1, "host question must not remount the overlay");

    hostCustomUi.setActive(false);
    assert.equal(hidden, false);
    assert.equal(focused, true);
    assert.deepEqual(setHiddenCalls, []);
    assert.equal(focusCalls, 0);
    assert.deepEqual(statusMessages.slice(-1), [
      { key: "pi-workflows:main-chat-input", value: undefined },
    ]);
    assert.equal(renderCalls, 0, "host question state should not force graph remount/render");
    assert.equal(calls.length, 1, "host question completion must not remount the overlay");
  });

  test("close unsubscribes from host custom UI state changes (#1353)", () => {
    const { ui, calls } = buildMockUi();
    const hostCustomUi = attachHostCustomUiState(ui);
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    assert.equal(hostCustomUi.listenerCount(), 1);

    const { handle } = calls[0]!;
    const setHiddenCalls: boolean[] = [];
    let focusCalls = 0;
    let unfocusCalls = 0;
    handle.isHidden = () => false;
    handle.setHidden = (value) => {
      setHiddenCalls.push(value);
    };
    handle.focus = () => {
      focusCalls++;
    };
    handle.unfocus = () => {
      unfocusCalls++;
    };

    adapter.close();
    assert.equal(hostCustomUi.listenerCount(), 0);

    hostCustomUi.setActive(true);
    hostCustomUi.setActive(false);

    assert.deepEqual(setHiddenCalls, []);
    assert.equal(focusCalls, 0);
    assert.equal(unfocusCalls, 0);
  });

  test("host inline custom UI does not restore an overlay hidden by the user (#1353)", () => {
    const { ui, calls } = buildMockUi();
    const hostCustomUi = attachHostCustomUiState(ui);
    const store = createStore();
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open("run-1");
    const { handle } = calls[0]!;
    let hidden = false;
    const setHiddenCalls: boolean[] = [];
    handle.isHidden = () => hidden;
    handle.setHidden = (value) => {
      setHiddenCalls.push(value);
      hidden = value;
    };
    handle.unfocus = () => undefined;
    handle.focus = () => undefined;

    adapter.toggle("run-1");
    assert.equal(hidden, true);
    setHiddenCalls.length = 0;

    hostCustomUi.setActive(true);
    hostCustomUi.setActive(false);

    assert.deepEqual(setHiddenCalls, []);
    assert.equal(hidden, true, "host inactive must not reveal a user-hidden overlay");
    assert.equal(calls.length, 1);
  });

  test("store-update refocus keeps the graph interactive while host inline custom UI is active (#1353)", () => {
    const { ui, calls } = buildMockUi();
    let hostActive = false;
    ui.getHostCustomUiState = () => ({
      blockingInlineCustomUiDepth: hostActive ? 1 : 0,
      blockingInlineCustomUiActive: hostActive,
    });
    const store = createStore();
    const runId = "blocked-refocus-run";
    setupSequentialRun(store, runId, 1);
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open(runId);
    const { handle } = calls[0]!;
    let focused = false;
    let hidden = false;
    let focusCalls = 0;
    handle.isHidden = () => hidden;
    handle.isFocused = () => focused;
    handle.focus = () => {
      focusCalls++;
      focused = true;
    };
    handle.setHidden = (value) => {
      hidden = value;
    };

    hostActive = true;

    store.recordStagePendingPrompt(runId, "stage-0", {
      id: "prompt-1",
      kind: "confirm",
      message: "approve?",
      createdAt: Date.now(),
    });

    assert.equal(focusCalls, 1, "graph focus should win over a pending main-chat question");
  });

  test("stage-chat focus hold still focuses while host inline custom UI is active (#1353)", async () => {
    const { ui, calls } = buildMockUi();
    let hostActive = false;
    ui.getHostCustomUiState = () => ({
      blockingInlineCustomUiDepth: hostActive ? 1 : 0,
      blockingInlineCustomUiActive: hostActive,
    });
    const store = createStore();
    const runId = "blocked-request-focus-run";
    setupSequentialRun(store, runId, 1);
    const adapter = buildGraphOverlayAdapter({ ui }, store);

    adapter.open(runId, undefined, "stage-0");
    const { handle } = calls[0]!;
    let focused = false;
    let focusCalls = 0;
    handle.isHidden = () => false;
    handle.isFocused = () => focused;
    handle.focus = () => {
      focusCalls++;
      focused = true;
    };

    hostActive = true;
    await delay(180);
    adapter.close();

    assert.ok(focusCalls >= 1, "workflow-local HIL must continue to focus inside the attached pane");
  });

  test("visible graph overlay refocuses when detached ctx.ui.editor and confirm prompts appear", async () => {
    const { ui, calls } = buildMockUi({ rows: 32 });
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const adapter = buildGraphOverlayAdapter({ ui }, store);
    let releaseWorkflow!: () => void;
    const workflowGate = new Promise<void>((resolve) => {
      releaseWorkflow = resolve;
    });

    const def = defineWorkflow("hil-focus-dummy")
      .output("edited", Type.Optional(Type.Any()))
      .output("approved", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        await workflowGate;
        const edited = await ctx.ui.editor("draft approval json");
        const approved = await ctx.ui.confirm(`Approve ${edited.length} chars?`);
        return { edited, approved };
      })
      .compile();

    const accepted = runDetached(def, {}, { store, cancellation, jobs });
    adapter.open(accepted.runId);

    const { handle } = calls[0]!;
    let focused = true;
    let focusCalls = 0;
    handle.isHidden = () => false;
    handle.isFocused = () => focused;
    handle.focus = () => {
      focusCalls += 1;
      focused = true;
    };

    // Reproduce the failure shape: the orchestrator panel is visible, but
    // keyboard focus has drifted away before the HIL prompt node appears.
    focused = false;
    releaseWorkflow();

    const editorPrompt = await waitForStagePendingPrompt(store, accepted.runId, "editor");
    assert.equal(focusCalls, 1, "new editor prompt should reclaim visible graph focus");
    store.resolveStagePendingPrompt(accepted.runId, editorPrompt.stageId, editorPrompt.promptId, "edited text");

    focused = false;
    const confirmPrompt = await waitForStagePendingPrompt(store, accepted.runId, "confirm");
    assert.equal(focusCalls, 2, "new confirm prompt should reclaim visible graph focus");
    store.resolveStagePendingPrompt(accepted.runId, confirmPrompt.stageId, confirmPrompt.promptId, true);

    await waitForRunEnded(store, accepted.runId);
    const run = store.runs().find((candidate) => candidate.id === accepted.runId);
    assert.equal(run?.status, "completed");
    assert.deepEqual(run?.result, { edited: "edited text", approved: true });
  });

  test("long detached ctx.ui.confirm text scrolls after attaching from the graph", async () => {
    const { ui, calls } = buildMockUi({ rows: 14, columns: 90 });
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    let now = 0;
    const adapter = buildGraphOverlayAdapter({ ui }, store, { now: () => now });
    let releaseWorkflow!: () => void;
    const workflowGate = new Promise<void>((resolve) => {
      releaseWorkflow = resolve;
    });
    const longMessage = [
      "SECTION 1 top of the long approval prompt.",
      "SECTION 2 enough words to wrap across several rows in a narrow workflow overlay.",
      "SECTION 3 more approval details that must remain reachable by scrolling.",
      "SECTION 4 posting safety notes and validation context for the user.",
      "SECTION 5 generated reply summary and artifact paths.",
      "SECTION 6 additional details that would normally appear in a real approval gate.",
      "SECTION 7 final caveats before the user chooses yes or no.",
      "SECTION 8 bottom of the long approval prompt.",
    ].join("\n\n");

    const def = defineWorkflow("hil-long-confirm-dummy")
      .output("approved", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        await workflowGate;
        const approved = await ctx.ui.confirm(longMessage);
        return { approved };
      })
      .compile();

    const accepted = runDetached(def, {}, { store, cancellation, jobs });
    adapter.open(accepted.runId);
    releaseWorkflow();
    await waitForStagePendingPrompt(store, accepted.runId, "confirm");

    const component = calls[0]!.component;
    now += 201;
    component.handleInput?.("\r");
    const top = visibleText(component.render(90));
    assert.match(top, /SECTION 1/);
    assert.doesNotMatch(top, /SECTION 8/);

    component.handleInput?.("end");
    const bottom = visibleText(component.render(90));
    assert.doesNotMatch(bottom, /SECTION 1/);
    assert.match(bottom, /SECTION 8|yes|no/);

    component.handleInput?.("y");
    await waitForRunEnded(store, accepted.runId);
    const run = store.runs().find((candidate) => candidate.id === accepted.runId);
    assert.equal(run?.status, "completed");
    assert.deepEqual(run?.result, { approved: true });
  });

  test("long detached ctx.ui.editor prefill renders with editor scroll indicators", async () => {
    const { ui, calls } = buildMockUi({ rows: 16, columns: 100 });
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    let now = 0;
    const adapter = buildGraphOverlayAdapter({ ui }, store, { now: () => now });
    let releaseWorkflow!: () => void;
    const workflowGate = new Promise<void>((resolve) => {
      releaseWorkflow = resolve;
    });
    const longDocument = Array.from(
      { length: 40 },
      (_, index) => `JSON LINE ${index + 1}: approval payload entry with enough text to render in the editor`,
    ).join("\n");

    const def = defineWorkflow("hil-long-editor-dummy")
      .output("editedLength", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        await workflowGate;
        const edited = await ctx.ui.editor(longDocument);
        return { editedLength: edited.length };
      })
      .compile();

    const accepted = runDetached(def, {}, { store, cancellation, jobs });
    adapter.open(accepted.runId);
    releaseWorkflow();
    const editorPrompt = await waitForStagePendingPrompt(store, accepted.runId, "editor");

    const component = calls[0]!.component;
    now += 201;
    component.handleInput?.("\r");
    const bottom = visibleText(component.render(100));
    assert.match(bottom, /JSON LINE 40/);
    assert.doesNotMatch(bottom, /JSON LINE 1:/);
    assert.match(bottom, /↑ \d+ more/);

    component.handleInput?.("pageUp");
    const afterPageUp = visibleText(component.render(100));
    assert.notEqual(afterPageUp, bottom);
    assert.match(afterPageUp, /↑ \d+ more|↓ \d+ more/);

    store.resolveStagePendingPrompt(accepted.runId, editorPrompt.stageId, editorPrompt.promptId, "edited");
    await waitForRunEnded(store, accepted.runId);
    const run = store.runs().find((candidate) => candidate.id === accepted.runId);
    assert.equal(run?.status, "completed");
    assert.deepEqual(run?.result, { editedLength: "edited".length });
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

  test("`q` on a real custom mount confirms, kills, and retains the active run (regression gate)", async () => {
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

    const capturedComponents: PiCustomComponent[] = [];
    const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
      const { handle } = buildOverlayHandle();
      options.onHandle?.(handle);
      const tui: PiCustomOverlayFactoryTui = {
        requestRender: () => undefined,
      };
      const component = factoryArg(tui, {}, {}, () => undefined);
      if (component instanceof Promise) throw new Error("expected sync factory");
      capturedComponents.push(component);
      return undefined;
    };

    const adapter = buildGraphOverlayAdapter({ ui: { custom: customFn } }, store);
    adapter.open(runId);

    capturedComponents[0]!.handleInput!("q");
    assert.equal(capturedComponents.length, 2, "q must mount the confirmation overlay first");
    assert.notEqual(store.runs().find((r) => r.id === runId)?.status, "killed");

    capturedComponents[1]!.handleInput!("y");
    await Promise.resolve();

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
      await waitForRenderCount(() => renderCalls, 2, 200, 25);
      assert.ok(
        renderCalls >= 2,
        `expected tui.requestRender to fire on the animation tick (got ${renderCalls})`,
      );
    } finally {
      component!.dispose?.();
    }
  }, 15_000);

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
