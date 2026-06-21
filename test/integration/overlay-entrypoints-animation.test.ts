import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { PiCustomComponent, PiCustomOverlayFunction, PiCustomOverlayFactoryTui, PiOverlayHandle } from "./overlay-entrypoints-helpers.js";
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
