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
