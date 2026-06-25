import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
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


describe("/workflow resume — overlay integration", () => {
  beforeEach(() => {
    setDurableBackend(new InMemoryDurableBackend());
  });
  test("resume with unknown runId prints not-found, does NOT call custom", () => {
    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);

    const wfCmd = commands["workflow"]!;
    const { ctx } = buildPrintCtx();

    void wfCmd.options.handler("resume no-such-run", ctx);

    assert.equal(customCalls.length, 0);
  });

  test("resume with no runId prints usage", async () => {
    singletonStore.clear();
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


  test("resume with no runId opens durable picker when only durable entries exist", async () => {
    singletonStore.clear();
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-picker-run", name: "durable-wf", inputs: {}, createdAt: Date.now(), status: "paused" });
    setDurableBackend(backend);
    try {
      const { pi, commands } = buildMockPi();
      factory(pi);
      const wfCmd = commands["workflow"]!;
      const { ctx, customCalls } = buildPrintCtxWithRealCustom();
      void wfCmd.options.handler("resume", ctx);
      await delay(5);
      assert.equal(customCalls.length, 1);
      assert.equal(customCalls[0]!.options.overlay, false);
      assert.match(visibleText(customCalls[0]!.component.render(80)).replace(/\n/g, " "), /Resumable workflows.*durable-wf/);
    } finally {
      setDurableBackend(undefined);
    }
  });

  test("resume with no runId ignores completed local runs when durable entries exist", async () => {
    singletonStore.clear();
    const completedRunId = `completed-local-${Date.now()}`;
    singletonStore.recordRunStart({ id: completedRunId, name: "done", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunEnd(completedRunId, "completed", {});
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-after-completed", name: "durable-history", inputs: {}, createdAt: Date.now(), status: "paused" });
    setDurableBackend(backend);
    try {
      const { pi, commands } = buildMockPi();
      factory(pi);
      const { ctx, customCalls } = buildPrintCtxWithRealCustom();
      void commands["workflow"]!.options.handler("resume", ctx);
      await delay(5);
      assert.equal(customCalls.length, 1);
      assert.match(visibleText(customCalls[0]!.component.render(80)), /durable-history/);
    } finally {
      setDurableBackend(undefined);
    }
  });

  test("resume with no runId opens live picker when paused runs exist", async () => {
    singletonStore.clear();
    const runId = `test-paused-picker-${Date.now()}`;
    singletonStore.recordRunStart({
      id: runId,
      name: "paused-wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });
    singletonStore.recordRunPaused(runId);
    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);
    const wfCmd = commands["workflow"]!;
    const { ctx, customCalls: realCustomCalls } = buildPrintCtxWithRealCustom();

    void wfCmd.options.handler("resume", ctx);
    await delay(5);

    assert.equal(customCalls.length, 0);
    assert.ok(realCustomCalls.length >= 1);
    assert.equal(realCustomCalls[0]!.options.overlay, false);
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
  test("resume with no runId surfaces durable history even when live runs exist", async () => {
    singletonStore.clear();
    const liveRunId = `live-run-${Date.now()}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "live-wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunPaused(liveRunId);
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-alongside-live", name: "durable-cross-session", inputs: {}, createdAt: Date.now(), status: "paused" });
    setDurableBackend(backend);
    try {
      const { pi, commands } = buildMockPi();
      factory(pi);
      const { ctx, messages } = buildPrintCtx();
      void commands["workflow"]!.options.handler("resume", ctx);
      await delay(5);
      // Live picker should open AND durable entries should be surfaced.
      const combined = messages.join("\n");
      assert.match(combined, /durable-cross-session/);
    } finally {
      setDurableBackend(undefined);
    }
  });

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

  test("durable resume <id> does NOT open the overlay when resume fails", async () => {
    singletonStore.clear();
    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);
    const wfCmd = commands["workflow"]!;
    const { ctx } = buildPrintCtx();
    // Unknown id — no durable backend configured.
    await wfCmd.options.handler("resume not-a-durable-wf", ctx);
    assert.equal(customCalls.length, 0);
  });

  test("no-arg resume with live + durable opens combined picker (issue #1498)", async () => {
    singletonStore.clear();
    const liveRunId = `live-combined-${Date.now()}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "live-wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunPaused(liveRunId);
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-combined-wf", name: "durable-wf", inputs: {}, createdAt: Date.now(), status: "paused" });
    setDurableBackend(backend);
    try {
      const { pi, commands } = buildMockPi();
      factory(pi);
      const { ctx, customCalls } = buildPrintCtxWithRealCustom();
      void commands["workflow"]!.options.handler("resume", ctx);
      await delay(5);
      // Combined picker should open showing both live and durable entries.
      assert.ok(customCalls.length >= 1);
      assert.equal(customCalls[0]!.options.overlay, false);
      const text = visibleText(customCalls[0]!.component.render(80)).replace(/\n/g, " ");
      // Both live and durable should be visible.
      assert.match(text, /live-wf/);
      assert.match(text, /durable-wf/);
    } finally {
      setDurableBackend(undefined);
    }
  });

  test("no-arg resume with only live runs opens normal live picker (no combined)", async () => {
    singletonStore.clear();
    const liveRunId = `live-only-${Date.now()}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "only-live-wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunPaused(liveRunId);
    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);
    const { ctx, customCalls: realCustomCalls } = buildPrintCtxWithRealCustom();
    void commands["workflow"]!.options.handler("resume", ctx);
    await delay(5);
    // Only the live picker (openSessionPicker) should open — no combined.
    assert.equal(customCalls.length, 0);
    assert.ok(realCustomCalls.length >= 1);
    assert.equal(realCustomCalls[0]!.options.overlay, false);
  });

  // cross-ref: issue #1498 — dismissing combined picker must NOT open a second picker.
  test("no-arg resume: dismissing combined picker does not open second live picker", async () => {
    singletonStore.clear();
    const liveRunId = `live-dismiss-${Date.now()}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "live-wf-dismiss", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunPaused(liveRunId);
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-dismiss-wf", name: "durable-dismiss", inputs: {}, createdAt: Date.now(), status: "paused" });
    setDurableBackend(backend);
    try {
      const { pi, commands } = buildMockPi();
      factory(pi);
      const { ctx, customCalls } = buildPrintCtxWithRealCustom();
      // Fire the handler; it will open the combined picker.
      const handlerPromise = commands["workflow"]!.options.handler("resume", ctx);
      await delay(5);
      // Combined picker is open.
      assert.ok(customCalls.length >= 1);
      const pickerFactory = customCalls[0]!;
      // Simulate dismissal (Escape).
      pickerFactory.component.handleInput?.("\u001b");
      await handlerPromise;
      // After dismissal: exactly ONE custom call (the combined picker).
      // No second live-only picker should have opened.
      assert.equal(customCalls.length, 1);
    } finally {
      setDurableBackend(undefined);
    }
  });


  // cross-ref: issue #1498 — mixed resume uses async hydrated durable listing.
  test("no-arg resume: mixed live+durable uses prepareDurableResumable (async hydration)", async () => {
    singletonStore.clear();
    const liveRunId = `live-hydrate-${Date.now()}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "live-hydrate-wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunPaused(liveRunId);
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-hydrate-wf", name: "durable-hydrate", inputs: {}, createdAt: Date.now(), status: "paused" });
    setDurableBackend(backend);
    try {
      const { pi, commands } = buildMockPi();
      factory(pi);
      const { ctx, customCalls } = buildPrintCtxWithRealCustom();
      void commands["workflow"]!.options.handler("resume", ctx);
      await delay(10);
      // The combined picker should include the durable entry that was only
      // discoverable through async prepareDurableResumable (DBOS hydration path).
      assert.ok(customCalls.length >= 1);
      const text = visibleText(customCalls[0]!.component.render(80)).replace(/\n/g, " ");
      assert.match(text, /durable-hydrate/);
    } finally {
      setDurableBackend(undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Graph-mode Ctrl+D / `h` — non-destructive hide, never kills the run
// ---------------------------------------------------------------------------
