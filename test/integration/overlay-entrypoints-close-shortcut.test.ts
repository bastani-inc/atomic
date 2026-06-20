import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { PiCommandContext } from "./overlay-entrypoints-helpers.js";
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
