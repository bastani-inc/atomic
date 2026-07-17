import { beforeEach, afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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


function registerInspectableCompleted(backend: InMemoryDurableBackend, workflowId: string, name: string): () => void {
  const dir = mkdtempSync(join(tmpdir(), "atomic-completed-overlay-"));
  const sessionFile = join(dir, "stage.jsonl");
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: `${workflowId}-session`, timestamp: new Date().toISOString(), cwd: dir }),
    JSON.stringify({ type: "message", id: `${workflowId}-message`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "prior context", timestamp: Date.now() } }),
  ].join("\n") + "\n");
  backend.registerWorkflow({ workflowId, name, inputs: {}, createdAt: 1, status: "completed" });
  backend.recordCheckpoint({
    kind: "stage", workflowId, checkpointId: "stage:1", name: "final",
    replayKey: "stage:final:1", output: "done", sessionFile, completedAt: 2,
  });
  return () => rmSync(dir, { recursive: true, force: true });
}

describe("/workflow resume — overlay integration", () => {
  beforeEach(() => {
    setDurableBackend(new InMemoryDurableBackend());
  });
  afterEach(() => setDurableBackend(undefined));
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
    backend.registerWorkflow({ workflowId: "durable-picker-run", name: "durable-wf", inputs: {}, createdAt: Date.now(), status: "paused", completedCheckpoints: 1 });
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
      const rendered = visibleText(customCalls[0]!.component.render(80)).replace(/\n/g, " ");
      assert.match(rendered, /Resume Session/);
      assert.match(rendered, /durable-wf/);
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
    backend.registerWorkflow({ workflowId: "durable-after-completed", name: "durable-history", inputs: {}, createdAt: Date.now(), status: "paused", completedCheckpoints: 1 });
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

  test("resume with no runId mixes live and durable entries", async () => {
    singletonStore.clear();
    const liveRunId = `live-run-${Date.now()}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "live-wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunPaused(liveRunId);
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-alongside-live", name: "durable-cross-session", inputs: {}, createdAt: Date.now(), status: "paused", completedCheckpoints: 1 });
    setDurableBackend(backend);
    try {
      const { pi, commands } = buildMockPi();
      factory(pi);
      const { ctx, customCalls } = buildPrintCtxWithRealCustom();
      const handlerPromise = commands["workflow"]!.options.handler("resume", ctx);
      await delay(5);
      assert.ok(customCalls.length >= 1);
      const text = visibleText(customCalls[0]!.component.render(80)).replace(/\n/g, " ");
      assert.match(text, /live-wf/);
      assert.match(text, /durable-cross-session/);
      customCalls[0]!.component.handleInput?.("\u001b");
      await handlerPromise;
    } finally {
      setDurableBackend(undefined);
    }
  });

  test("resume with known authoritative completed runId calls overlay.open", async () => {
    singletonStore.clear();
    const runId = `test-resume-run-${Date.now()}`;
    const backend = new InMemoryDurableBackend();
    const cleanup = registerInspectableCompleted(backend, runId, "test-wf");
    setDurableBackend(backend);
    singletonStore.recordRunStart({
      id: runId,
      name: "stale-local",
      inputs: {},
      status: "completed",
      stages: [],
      startedAt: 1,
      endedAt: 2,
      resumable: false,
    });
    try {
      const { pi, commands, customCalls } = buildMockPi();
      factory(pi);
      const { ctx } = buildPrintCtx();

      await commands["workflow"]!.options.handler(`resume ${runId}`, ctx);

      assert.ok(customCalls.length >= 1);
      assert.equal(customCalls[0]!.options.overlay, true);
      assert.equal(singletonStore.runs()[0]?.name, "test-wf");
      assert.equal(singletonStore.runs()[0]?.stages[0]?.name, "final");
    } finally {
      cleanup();
    }
  });

  test("resume of an actively-running run is refused (use /workflow connect)", async () => {
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
    const { ctx, messages } = buildPrintCtx();

    await wfCmd.options.handler(`resume ${runId}`, ctx);

    // Active workflows must not be re-resumed; no overlay opens.
    assert.equal(customCalls.length, 0);
    const joined = messages.join("\n");
    assert.match(joined, /already running/);
    assert.match(joined, /\/workflow connect/);
  });

  test("resume uses real command ctx.ui.custom when top-level pi.ui is absent", async () => {
    singletonStore.clear();

    const { pi, commands } = buildMockPi();
    delete pi.ui;
    factory(pi);

    const wfCmd = commands["workflow"]!;
    const { ctx, customCalls } = buildPrintCtxWithRealCustom();

    // No-arg resume opens the shared /resume-style selector through ctx.ui.custom
    // even when the top-level pi.ui surface is absent.
    const handlerPromise = wfCmd.options.handler("resume", ctx) as Promise<unknown>;
    await delay(5);
    assert.ok(customCalls.length >= 1);
    customCalls[0]!.component.handleInput?.("\u001b");
    await handlerPromise;
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
  beforeEach(() => setDurableBackend(new InMemoryDurableBackend()));
  afterEach(() => setDurableBackend(undefined));
  test("resume <runId> refuses a completed local snapshot without authoritative data", async () => {
    singletonStore.clear();
    const runId = `test-non-paused-${Date.now()}`;
    singletonStore.recordRunStart({
      id: runId,
      name: "snap-only-wf",
      inputs: {},
      status: "completed",
      stages: [],
      startedAt: 1,
      endedAt: 2,
      resumable: false,
    });
    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);
    const { ctx, messages } = buildPrintCtx();
    await commands["workflow"]!.options.handler(`resume ${runId}`, ctx);
    assert.equal(customCalls.length, 0);
    assert.match(messages.join("\n"), /No resumable workflow|No durable workflow|No completed durable workflow|stale/);
  });
});

describe("/workflow attach — top-level command", () => {
  // Hermetic durable backend: without this, tests that fall back to durable
  // discovery scan the real ~/.atomic/workflow-durable directory, which can
  // hold tens of thousands of files on dev machines and blow the 5s timeout.
  beforeEach(() => {
    setDurableBackend(new InMemoryDurableBackend());
  });
  afterEach(() => setDurableBackend(undefined));
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
    // Unknown id — hermetic durable backend has no matching record.
    await wfCmd.options.handler("resume not-a-durable-wf", ctx);
    assert.equal(customCalls.length, 0);
  });

  test("no-arg resume globally orders mixed live and durable choices by recency", async () => {
    singletonStore.clear();
    const now = Date.now();
    const liveRunId = `live-combined-${now}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "live-older-wf", inputs: {}, status: "running", stages: [], startedAt: now });
    singletonStore.recordRunPaused(liveRunId);
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-combined-wf", name: "durable-newer-wf", inputs: {}, createdAt: now + 10_000, status: "paused", completedCheckpoints: 1 });
    setDurableBackend(backend);
    try {
      const { pi, commands } = buildMockPi();
      factory(pi);
      const { ctx, customCalls } = buildPrintCtxWithRealCustom();
      const handlerPromise = commands["workflow"]!.options.handler("resume", ctx);
      await delay(5);
      assert.ok(customCalls.length >= 1);
      assert.equal(customCalls[0]!.options.overlay, false);
      const text = visibleText(customCalls[0]!.component.render(80)).replace(/\n/g, " ");
      assert.match(text, /live-older-wf/);
      assert.match(text, /durable-newer-wf/);
      assert.ok(text.indexOf("durable-newer-wf") < text.indexOf("live-older-wf"));
      customCalls[0]!.component.handleInput?.("\u001b");
      await handlerPromise;
    } finally {
      setDurableBackend(undefined);
    }
  });

  test("no-arg resume with only live runs opens the /resume-style selector", async () => {
    singletonStore.clear();
    const liveRunId = `live-only-${Date.now()}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "only-live-wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunPaused(liveRunId);
    const { pi, commands, customCalls } = buildMockPi();
    factory(pi);
    const { ctx, customCalls: realCustomCalls } = buildPrintCtxWithRealCustom();
    void commands["workflow"]!.options.handler("resume", ctx);
    await delay(5);
    // The resume command should open the shared /resume-style selector directly.
    assert.equal(customCalls.length, 0);
    assert.ok(realCustomCalls.length >= 1);
    assert.equal(realCustomCalls[0]!.options.overlay, false);
    const text = visibleText(realCustomCalls[0]!.component.render(80));
    assert.match(text, /Resume Session/);
    assert.doesNotMatch(text, /Connect to workflow run/);
  });

  // cross-ref: issue #1498 — dismissing the shared selector must NOT open a second picker.
  test("no-arg resume: dismissing shared selector does not open second live picker", async () => {
    singletonStore.clear();
    const liveRunId = `live-dismiss-${Date.now()}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "live-wf-dismiss", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunPaused(liveRunId);
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-dismiss-wf", name: "durable-dismiss", inputs: {}, createdAt: Date.now(), status: "paused", completedCheckpoints: 1 });
    setDurableBackend(backend);
    try {
      const { pi, commands } = buildMockPi();
      factory(pi);
      const { ctx, customCalls } = buildPrintCtxWithRealCustom();
      // Fire the handler; it will open the shared live+durable selector.
      const handlerPromise = commands["workflow"]!.options.handler("resume", ctx);
      await delay(5);
      // Shared selector is open.
      assert.ok(customCalls.length >= 1);
      const pickerFactory = customCalls[0]!;
      // Simulate dismissal (Escape).
      pickerFactory.component.handleInput?.("\u001b");
      await handlerPromise;
      // After dismissal: exactly ONE custom call (the shared selector).
      // No second live-only picker should have opened.
      assert.equal(customCalls.length, 1);
    } finally {
      setDurableBackend(undefined);
    }
  });


  test("no-arg resume with live runs includes asynchronously hydrated durable entries", async () => {
    singletonStore.clear();
    const liveRunId = `live-hydrate-${Date.now()}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "live-hydrate-wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunPaused(liveRunId);
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-hydrate-wf", name: "durable-hydrate", inputs: {}, createdAt: Date.now(), status: "paused", completedCheckpoints: 1 });
    setDurableBackend(backend);
    try {
      const { pi, commands } = buildMockPi();
      factory(pi);
      const { ctx, customCalls } = buildPrintCtxWithRealCustom();
      const handlerPromise = commands["workflow"]!.options.handler("resume", ctx);
      await delay(10);
      assert.ok(customCalls.length >= 1);
      const text = visibleText(customCalls[0]!.component.render(80)).replace(/\n/g, " ");
      assert.match(text, /live-hydrate-wf/);
      assert.match(text, /durable-hydrate/);
      customCalls[0]!.component.handleInput?.("\u001b");
      await handlerPromise;
    } finally {
      setDurableBackend(undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Graph-mode Ctrl+X / `h` — non-destructive hide, never kills the run
// ---------------------------------------------------------------------------
