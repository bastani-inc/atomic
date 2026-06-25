import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { PiCustomComponent, PiCustomOverlayOptions } from "./overlay-entrypoints-helpers.js";
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
  workflow,
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
void [buildGraphOverlayAdapter, buildInteractiveHostCustomUi, buildMockPi, buildMockUi, buildOverlayHandle, buildPrintCtx, buildPrintCtxWithRealCustom, attachHostCustomUiState, createCancellationRegistry, createJobTracker, createStore, workflow, delay, factory, runDetached, setupBranchingRun, setupSequentialRun, setupWideFanoutRun, singletonStore, Type, visibleText, waitForRenderCount, waitForRunEnded, waitForStagePendingPrompt];


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

});
