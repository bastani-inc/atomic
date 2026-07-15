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

  test("`q` on a real custom mount returns to main chat without mutating the run", () => {
    const runId = `q-return-${Date.now()}`;
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
    const overlay = buildOverlayHandle();
    const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
      options.onHandle?.(overlay.handle);
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
    const before = structuredClone(store.runs().find((r) => r.id === runId));

    capturedComponent!.handleInput!("q");

    assert.deepEqual(overlay.state.setHiddenCalls, [true]);
    assert.equal(overlay.state.unfocusCalls, 1);
    assert.equal(overlay.state.focused, false);
    assert.deepEqual(store.runs().find((r) => r.id === runId), before);
  });
});

// ---------------------------------------------------------------------------
// buildGraphOverlayAdapter — animation tick visibility gating
// ---------------------------------------------------------------------------
