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


describe("buildGraphOverlayAdapter — Ctrl+X / h non-destructive hide", () => {
  test("Ctrl+X without onHandle invokes factory done() and keeps the run alive", () => {
    const runId = `ctrl-x-no-onhandle-${Date.now()}`;
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
    // no OverlayHandle to flip — `Ctrl+X` must fall back to `done()`.
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

    capturedComponent!.handleInput!("\x18");

    assert.equal(doneCalled, 1, "Ctrl+X should invoke done(undefined) exactly once");
    const run = store.runs().find((r) => r.id === runId);
    assert.ok(run, "run should still exist in the store");
    assert.notEqual(run!.status, "killed", "Ctrl+X must not transition status to killed");
    assert.equal(run!.endedAt, undefined, "Ctrl+X must not end the run");
  });

  test("Ctrl+X WITH onHandle hides via setHidden(true)+unfocus and keeps the run alive", () => {
    const runId = `ctrl-x-with-onhandle-${Date.now()}`;
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

    capturedComponent!.handleInput!("\x18");

    assert.deepEqual(setHiddenCalls, [true], "Ctrl+X should call setHidden(true) once");
    assert.equal(unfocusCalls, 1, "Ctrl+X should release focus once");
    assert.equal(doneCalled, 0, "Ctrl+X with onHandle must NOT invoke done()");
    const run = store.runs().find((r) => r.id === runId);
    assert.notEqual(run!.status, "killed");
    assert.equal(run!.endedAt, undefined);
  });

  test("`q` on a real custom mount does not navigate or mutate the run", () => {
    const runId = `q-printable-${Date.now()}`;
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

    assert.deepEqual(overlay.state.setHiddenCalls, []);
    assert.equal(overlay.state.unfocusCalls, 0);
    assert.equal(overlay.state.focused, true);
    assert.deepEqual(store.runs().find((r) => r.id === runId), before);
  });
});

// ---------------------------------------------------------------------------
// buildGraphOverlayAdapter — animation tick visibility gating
// ---------------------------------------------------------------------------
