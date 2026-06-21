import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildGraphOverlayAdapter,
  buildInteractiveHostCustomUi,
  buildMockPi,
  buildMockUi,
  buildOverlayHandle,
  buildPrintCtx,
  buildPrintCtxWithRealCustom,
  attachHostCustomUiState,
  createCancellationRegistry,
  createJobTracker,
  createStore,
  defineWorkflow,
  delay,
  factory,
  runDetached,
  setupBranchingRun,
  setupSequentialRun,
  setupWideFanoutRun,
  singletonStore,
  Type,
  visibleText,
  waitForRenderCount,
  waitForRunEnded,
  waitForStagePendingPrompt,
} from "./overlay-entrypoints-helpers.js";
void [buildGraphOverlayAdapter, buildInteractiveHostCustomUi, buildMockPi, buildMockUi, buildOverlayHandle, buildPrintCtx, buildPrintCtxWithRealCustom, attachHostCustomUiState, createCancellationRegistry, createJobTracker, createStore, defineWorkflow, delay, factory, runDetached, setupBranchingRun, setupSequentialRun, setupWideFanoutRun, singletonStore, Type, visibleText, waitForRenderCount, waitForRunEnded, waitForStagePendingPrompt];

describe("buildGraphOverlayAdapter — open with pi.ui.custom", () => {
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
