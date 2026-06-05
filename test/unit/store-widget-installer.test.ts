/**
 * Unit tests for store-widget-installer.
 * Tests: installStoreWidget (setWidget calls), installToolExecutionHooks (event subscriptions).
 * cross-ref: spec §5.4.4, §5.4.6, §5.5, §8.1 Phase E
 */

import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  installStoreWidget,
  installToolExecutionHooks,
  decideWidgetAction,
} from "../../packages/workflows/src/tui/store-widget-installer.js";
import type { WidgetRenderState } from "../../packages/workflows/src/tui/store-widget-installer.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(id: string, name: string): RunSnapshot {
  return {
    id,
    name,
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
  };
}

function makeStage(id: string, name: string): StageSnapshot {
  return {
    id,
    name,
    status: "running",
    parentIds: [],
    toolEvents: [],
  };
}

// ---------------------------------------------------------------------------
// Mock pi API
// ---------------------------------------------------------------------------

interface SetWidgetCall {
  key: string;
  factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  opts: { placement?: string } | undefined;
}

interface FakeTimerHandle {
  id: number;
  unrefCalls: number;
  unref(): void;
}

function makeFakeTimers(): {
  setTimeout: (handler: () => void, delayMs: number) => FakeTimerHandle;
  clearTimeout: (handle: FakeTimerHandle) => void;
  scheduled: Array<{ handle: FakeTimerHandle; handler: () => void; delayMs: number; cleared: boolean }>;
} {
  let nextId = 1;
  const scheduled: Array<{ handle: FakeTimerHandle; handler: () => void; delayMs: number; cleared: boolean }> = [];
  return {
    scheduled,
    setTimeout(handler: () => void, delayMs: number): FakeTimerHandle {
      const handle: FakeTimerHandle = {
        id: nextId++,
        unrefCalls: 0,
        unref() {
          this.unrefCalls += 1;
        },
      };
      scheduled.push({ handle, handler, delayMs, cleared: false });
      return handle;
    },
    clearTimeout(handle: FakeTimerHandle): void {
      const timer = scheduled.find((entry) => entry.handle === handle);
      if (timer) timer.cleared = true;
    },
  };
}

function makeMockPi(): {
  pi: {
    ui: {
      setWidget: (
        key: string,
        factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined,
        opts?: { placement?: string },
      ) => void;
      requestRender: () => void;
    };
    on: (event: string, handler: (payload: unknown) => void) => void;
    events: {
      on: (event: string, handler: (payload: unknown) => void) => void;
    };
  };
  widgetCalls: SetWidgetCall[];
  eventHandlers: Map<string, (payload: unknown) => void>;
  extensionHandlers: Map<string, (payload: unknown) => void>;
  renderRequests: { count: number };
} {
  const widgetCalls: SetWidgetCall[] = [];
  const eventHandlers: Map<string, (payload: unknown) => void> = new Map();
  const extensionHandlers: Map<string, (payload: unknown) => void> = new Map();
  const renderRequests = { count: 0 };

  const pi = {
    ui: {
      setWidget(
        key: string,
        factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined,
        opts?: { placement?: string },
      ): void {
        widgetCalls.push({ key, factory, opts });
      },
      requestRender(): void {
        renderRequests.count++;
      },
    },
    on(event: string, handler: (payload: unknown) => void): void {
      extensionHandlers.set(event, handler);
    },
    events: {
      on(event: string, handler: (payload: unknown) => void): void {
        eventHandlers.set(event, handler);
      },
    },
  };

  return { pi, widgetCalls, eventHandlers, extensionHandlers, renderRequests };
}

// ---------------------------------------------------------------------------
// decideWidgetAction (pure)
// ---------------------------------------------------------------------------

describe("decideWidgetAction", () => {
  const hidden: WidgetRenderState = { mounted: false, lines: [] };

  test("hidden + empty next lines → none", () => {
    assert.equal(decideWidgetAction(hidden, []), "none");
  });

  test("hidden + non-empty next lines → mount", () => {
    assert.equal(decideWidgetAction(hidden, ["● 80c5fe ralph · single · 0/1 · 3m 23s"]), "mount");
  });

  test("mounted + empty next lines → unmount", () => {
    const mounted: WidgetRenderState = { mounted: true, lines: ["● 80c5fe ralph · single · 0/1 · 3m 23s"] };
    assert.equal(decideWidgetAction(mounted, []), "unmount");
  });

  test("mounted + changed lines (elapsed advanced) → update", () => {
    const mounted: WidgetRenderState = { mounted: true, lines: ["● 80c5fe ralph · single · 0/1 · 3m 23s"] };
    assert.equal(
      decideWidgetAction(mounted, ["● 80c5fe ralph · single · 0/1 · 3m 29s"]),
      "update",
    );
  });

  test("mounted + identical lines → none", () => {
    const lines = ["● 80c5fe ralph · single · 0/1 · 3m 23s", "     single · 3m 23s"];
    const mounted: WidgetRenderState = { mounted: true, lines };
    assert.equal(decideWidgetAction(mounted, [...lines]), "none");
  });
});

// ---------------------------------------------------------------------------
// installStoreWidget
// ---------------------------------------------------------------------------

describe("installStoreWidget", () => {
  let storeInstance: Store;

  beforeEach(() => {
    storeInstance = createStore();
  });

  test("does not mount the widget when there are no active runs", () => {
    // New in-place contract: a hidden→hidden refresh is "none", so the
    // installer never issues setWidget on first install with no runs.
    const { pi, widgetCalls } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    assert.equal(widgetCalls.length, 0);
  });

  test("mounts the widget with a factory exactly once when a run starts", () => {
    const { pi, widgetCalls } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    storeInstance.recordRunStart(makeRun("r1", "my-wf"));
    const factoryCalls = widgetCalls.filter((c) => typeof c.factory === "function");
    assert.equal(factoryCalls.length, 1, "expected exactly one setWidget(factory) mount");
    assert.equal(factoryCalls[0]!.key, "workflow.run");
    assert.deepEqual(factoryCalls[0]!.opts, { placement: "belowEditor" });
  });

  test("factory builds a Container with Text lines that include the workflow name", () => {
    const { pi, widgetCalls } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    storeInstance.recordRunStart(makeRun("r1", "my-wf"));
    const factoryCall = widgetCalls.findLast((c) => typeof c.factory === "function")!;
    const component = factoryCall.factory!(null, null) as { render(w: number): string[] };
    const lines = component.render(120);
    assert.ok(lines.length > 0);
    assert.ok(lines.some((l) => l.includes("my-wf")));
  });

  test("factory reflows the widget against the host render width", () => {
    const { pi, widgetCalls } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    storeInstance.recordRunStart(makeRun("r1", "my-wf"));
    const factoryCall = widgetCalls.findLast((c) => typeof c.factory === "function")!;
    const component = factoryCall.factory!(null, undefined) as { render(w: number): string[] };

    const narrowLines = component.render(60);

    assert.deepEqual(narrowLines, [" ▾  1 background · 1 ●"]);
  });

  test("requests a render and mounts exactly once when a run starts", async () => {
    const { pi, widgetCalls, renderRequests } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    const beforeRequests = renderRequests.count;
    storeInstance.recordRunStart(makeRun("r1", "my-wf"));
    await Promise.resolve();
    assert.ok(renderRequests.count > beforeRequests, "expected requestRender on store mutation");
    const factoryCalls = widgetCalls.filter((c) => typeof c.factory === "function");
    assert.equal(factoryCalls.length, 1, "expected exactly one setWidget(factory) mount");
  });

  test("repaints the mounted widget in place when a stage starts awaiting human input", async () => {
    const { pi, widgetCalls, renderRequests } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    const run = makeRun("r1", "my-wf");
    (run.stages as StageSnapshot[]).push(makeStage("s1", "ask"));
    storeInstance.recordRunStart(run);
    // Capture the originally-mounted long-lived component.
    const mountCall = widgetCalls.findLast((c) => typeof c.factory === "function")!;
    const component = mountCall.factory!(null, undefined) as { render(w: number): string[] };
    const callsAfterMount = widgetCalls.length;
    const beforeRequests = renderRequests.count;

    storeInstance.recordStageAwaitingInput("r1", "s1", true);
    await Promise.resolve();

    assert.equal(widgetCalls.length, callsAfterMount, "awaiting input must not remount the widget");
    assert.ok(renderRequests.count > beforeRequests, "expected in-place repaint for awaiting input");
    assert.match(component.render(120).join("\n"), /● 1 running\s+？ ↵ 1 needs attention/);
  });

  test("repaints the mounted widget in place when a run fails", async () => {
    const { pi, widgetCalls, renderRequests } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    const run = makeRun("r1", "my-wf");
    (run.stages as StageSnapshot[]).push(makeStage("s1", "fail"));
    storeInstance.recordRunStart(run);
    // Capture the originally-mounted long-lived component.
    const mountCall = widgetCalls.findLast((c) => typeof c.factory === "function")!;
    const component = mountCall.factory!(null, undefined) as { render(w: number): string[] };
    const callsAfterMount = widgetCalls.length;
    const beforeRequests = renderRequests.count;

    storeInstance.recordRunEnd("r1", "failed", undefined, "boom");
    await Promise.resolve();

    assert.equal(widgetCalls.length, callsAfterMount, "failure must not remount the widget");
    assert.ok(renderRequests.count > beforeRequests, "expected in-place repaint for failed run");
    const rendered = component.render(120).join("\n");
    assert.match(rendered, /✗ 1/);
    assert.match(rendered, /failed · 0s/);
    assert.doesNotMatch(rendered, /ago/);
  });

  test("keeps the widget mounted in place for recently-ended runs", () => {
    const { pi, widgetCalls } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    storeInstance.recordRunStart(makeRun("r1", "my-wf"));
    // Capture the originally-mounted long-lived component.
    const mountCall = widgetCalls.findLast((c) => typeof c.factory === "function")!;
    const component = mountCall.factory!(null, undefined) as { render(w: number): string[] };
    const factoryCallsAfterStart = widgetCalls.filter((c) => typeof c.factory === "function").length;

    storeInstance.recordRunEnd("r1", "completed");

    assert.equal(
      widgetCalls.filter((c) => typeof c.factory === "function").length,
      factoryCallsAfterStart,
      "ending a run must not remount a fresh widget factory",
    );
    const lines = component.render(120);
    assert.ok(lines.some((line) => line.includes("my-wf")));
    assert.ok(lines.some((line) => line.includes("complete")));
  });

  test("updates in place (no remount) when the clock-refresh timer fires for an active run", async () => {
    // Flicker regression (#1109): a once-per-second elapsed-label refresh must
    // update the long-lived widget in place (requestRender only) and MUST NOT
    // re-issue setWidget (which would dispose+remount the host component).
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const timers = makeFakeTimers();
      const { pi, widgetCalls, renderRequests } = makeMockPi();
      installStoreWidget(pi, storeInstance, timers);
      storeInstance.recordRunStart(makeRun("r1", "my-wf"));
      // Capture the originally-mounted long-lived component.
      const mountCall = widgetCalls.findLast((c) => typeof c.factory === "function")!;
      const component = mountCall.factory!(null, undefined) as { render(w: number): string[] };
      const setWidgetCallsAfterStart = widgetCalls.length;
      const requestsAfterStart = renderRequests.count;
      const labelBefore = component.render(120).join("\n");
      assert.match(labelBefore, /single · 0s/);

      const timer = timers.scheduled.findLast((entry) => !entry.cleared);
      assert.ok(timer, "expected active widget refresh timer");
      assert.ok(timer.delayMs > 0 && timer.delayMs <= 1_000);

      now += timer.delayMs;
      timer.handler();
      await Promise.resolve();

      assert.equal(
        widgetCalls.length,
        setWidgetCallsAfterStart,
        "clock tick must NOT re-issue setWidget (no dispose/remount)",
      );
      assert.ok(renderRequests.count > requestsAfterStart, "clock tick must request an in-place render");
      const labelAfter = component.render(120).join("\n");
      assert.notEqual(labelAfter, labelBefore, "long-lived component must reflect the advanced elapsed label");
      assert.match(labelAfter, /single · 1s/);
    } finally {
      Date.now = originalNow;
    }
  });

  test("uses the mounted TUI requestRender fallback when the UI context lacks requestRender", async () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const timers = makeFakeTimers();
      const widgetCalls: SetWidgetCall[] = [];
      const host = {
        renderRequests: 0,
        requestRender(): void {
          this.renderRequests++;
        },
      };
      const pi = {
        ui: {
          setWidget(
            key: string,
            factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined,
            opts?: { placement?: string },
          ): void {
            widgetCalls.push({ key, factory, opts });
            factory?.(host, undefined);
          },
        },
      };

      installStoreWidget(pi, storeInstance, timers);
      storeInstance.recordRunStart(makeRun("r1", "my-wf"));
      await Promise.resolve();
      const requestsAfterStart = host.renderRequests;
      assert.ok(requestsAfterStart > 0, "mount should request a render through the TUI fallback");

      const timer = timers.scheduled.findLast((entry) => !entry.cleared);
      assert.ok(timer, "expected active widget refresh timer");
      now += timer.delayMs;
      timer.handler();
      await Promise.resolve();

      assert.equal(widgetCalls.filter((c) => typeof c.factory === "function").length, 1);
      assert.ok(host.renderRequests > requestsAfterStart, "clock tick should repaint through the TUI fallback");
    } finally {
      Date.now = originalNow;
    }
  });

  test("clears the widget after recently-ended runs become stale without user interaction", () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const timers = makeFakeTimers();
      const { pi, widgetCalls } = makeMockPi();
      installStoreWidget(pi, storeInstance, timers);
      storeInstance.recordRunStart(makeRun("r1", "my-wf"));
      storeInstance.recordRunEnd("r1", "completed");
      assert.equal(typeof widgetCalls[widgetCalls.length - 1]!.factory, "function");

      const timer = timers.scheduled.findLast((entry) => !entry.cleared);
      assert.ok(timer, "expected recent-ended widget refresh timer");
      assert.ok(timer.delayMs > 29_000, "terminal-only widget should refresh near expiry, not every second");

      now += 31_000;
      timer.handler();

      const last = widgetCalls[widgetCalls.length - 1]!;
      assert.equal(last.factory, undefined);
    } finally {
      Date.now = originalNow;
    }
  });

  test("does not schedule a second-boundary refresh for fully paused runs", () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const timers = makeFakeTimers();
      const { pi } = makeMockPi();
      installStoreWidget(pi, storeInstance, timers);
      const run = makeRun("r1", "my-wf");
      run.status = "paused";
      run.pausedAt = now - 5_000;
      storeInstance.recordRunStart(run);

      const timer = timers.scheduled.findLast((entry) => !entry.cleared);
      assert.equal(timer, undefined);
    } finally {
      Date.now = originalNow;
    }
  });

  test("clears a scheduled widget refresh timer on dispose", () => {
    const timers = makeFakeTimers();
    const { pi } = makeMockPi();
    const unsubscribe = installStoreWidget(pi, storeInstance, timers);
    storeInstance.recordRunStart(makeRun("r1", "my-wf"));

    const timer = timers.scheduled.findLast((entry) => !entry.cleared);
    assert.ok(timer, "expected refresh timer before dispose");
    unsubscribe();

    assert.equal(timer.cleared, true);
  });

  test("returns disposer that removes the widget", () => {
    const { pi, widgetCalls } = makeMockPi();
    const unsubscribe = installStoreWidget(pi, storeInstance);
    const before = widgetCalls.length;
    unsubscribe();
    const last = widgetCalls[widgetCalls.length - 1]!;
    assert.ok(widgetCalls.length > before);
    assert.equal(last.factory, undefined);
  });

  test("no crash when pi.ui is absent", () => {
    const piNoUI: { ui?: undefined; events?: undefined } = {};
    const storeNoUI = createStore();
    assert.doesNotThrow(() => installStoreWidget(piNoUI, storeNoUI));
  });

  test("no crash when pi.ui.setWidget is absent", () => {
    const piNoSetWidget = { ui: {} };
    const storeNoWidget = createStore();
    assert.doesNotThrow(() => installStoreWidget(piNoSetWidget, storeNoWidget));
  });

  test("uses a low-frequency clock timer, not a high-frequency spinner timer", () => {
    // Regression: the widget used to keep an 80ms setInterval re-issuing
    // setWidget so the braille spinner glyph could advance. The glyph is
    // static now; elapsed-time labels use one-shot second-boundary refreshes.
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const timers = makeFakeTimers();
      const { pi } = makeMockPi();
      const unsubscribe = installStoreWidget(pi, storeInstance, timers);
      const run = makeRun("r1", "my-wf");
      (run.stages as StageSnapshot[]).push(makeStage("s1", "stage-1"));
      storeInstance.recordRunStart(run);

      const timer = timers.scheduled.findLast((entry) => !entry.cleared);
      assert.ok(timer, "expected clock refresh timer");
      assert.equal(timer.delayMs, 1_000);
      assert.equal(timer.handle.unrefCalls, 1);
      unsubscribe();
    } finally {
      Date.now = originalNow;
    }
  });
});

// ---------------------------------------------------------------------------
// installToolExecutionHooks
// ---------------------------------------------------------------------------

describe("installToolExecutionHooks", () => {
  let storeInstance: Store;

  beforeEach(() => {
    storeInstance = createStore();
    const run = makeRun("r1", "my-wf");
    storeInstance.recordRunStart(run);
    storeInstance.recordStageStart("r1", makeStage("s1", "scout"));
  });

  test("no crash when pi.events is absent", () => {
    const piNoEvents: { ui?: undefined; events?: undefined } = {};
    assert.doesNotThrow(() => installToolExecutionHooks(piNoEvents, storeInstance));
  });

  test("no crash when pi.events.on is absent", () => {
    const piNoOn = { events: {} };
    assert.doesNotThrow(() => installToolExecutionHooks(piNoOn, storeInstance));
  });

  test("subscribes to tool_execution_start, _update, _end", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);
    assert.equal(eventHandlers.has("tool_execution_start"), true);
    assert.equal(eventHandlers.has("tool_execution_update"), true);
    assert.equal(eventHandlers.has("tool_execution_end"), true);
  });

  test("subscribes to pi extension tool events", () => {
    const { pi, extensionHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);
    assert.equal(extensionHandlers.has("tool_execution_start"), true);
    assert.equal(extensionHandlers.has("tool_execution_update"), true);
    assert.equal(extensionHandlers.has("tool_execution_end"), true);
    assert.equal(extensionHandlers.has("tool_call"), true);
    assert.equal(extensionHandlers.has("tool_result"), true);
  });

  test("tool_execution_start ignores unscoped events instead of using active-stage fallback", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    const handler = eventHandlers.get("tool_execution_start")!;
    handler({ toolName: "bash", input: { cmd: "ls" }, ts: Date.now() });

    const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.toolEvents.length, 0);
    assert.equal(stage.status, "running");
    assert.equal(stage.awaitingInputSince, undefined);
  });

  test("tool_execution_start preserves SDK args for scoped orchestrator tool UI", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    const handler = eventHandlers.get("tool_execution_start")!;
    handler({
      toolName: "bash",
      runId: "r1",
      stageId: "s1",
      toolCallId: "bash-args",
      args: { command: "echo hi" },
      ts: Date.now(),
    });

    const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
    assert.deepEqual(stage.toolEvents[0]!.input, { command: "echo hi" });
  });

  test("tool_execution_start with explicit runId+stageId routes correctly", () => {
    storeInstance.recordStageStart("r1", makeStage("s2", "specialist"));

    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    const handler = eventHandlers.get("tool_execution_start")!;
    handler({
      toolName: "grep",
      runId: "r1",
      stageId: "s2",
      toolCallId: "grep-1",
      ts: Date.now(),
    });

    const snap = storeInstance.snapshot();
    const run = snap.runs.find((r) => r.id === "r1")!;
    const s2 = run.stages.find((s) => s.id === "s2")!;
    const s1 = run.stages.find((s) => s.id === "s1")!;
    assert.equal(s2.toolEvents.length, 1);
    assert.equal(s2.toolEvents[0]!.name, "grep");
    assert.equal(s1.toolEvents.length, 0);
  });

  test("tool_execution_update is attach-only and cannot create a stage tool event", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    eventHandlers.get("tool_execution_update")!({
      toolName: "bash",
      runId: "r1",
      stageId: "s1",
      toolCallId: "missing-call",
      ts: Date.now(),
    });

    const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.toolEvents.length, 0);
    assert.equal(stage.status, "running");
    assert.equal(stage.awaitingInputSince, undefined);
  });

  test("tool_execution_end records tool end for the exact scoped active call", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    const startTs = Date.now() - 500;
    const startHandler = eventHandlers.get("tool_execution_start")!;
    startHandler({
      toolName: "bash",
      runId: "r1",
      stageId: "s1",
      toolCallId: "bash-1",
      ts: startTs,
    });

    const endHandler = eventHandlers.get("tool_execution_end")!;
    endHandler({
      toolName: "renamed-in-end-payload",
      runId: "r1",
      stageId: "s1",
      toolCallId: "bash-1",
      ts: startTs + 123,
      endedAt: Date.now(),
      output: "ok",
    });

    const snap = storeInstance.snapshot();
    const run = snap.runs.find((r) => r.id === "r1")!;
    const stage = run.stages.find((s) => s.id === "s1")!;
    const evt = stage.toolEvents.find((e) => e.name === "bash");
    assert.notEqual(evt, undefined);
    assert.equal(evt!.startedAt, startTs);
    assert.equal(evt!.output, "ok");
    assert.notEqual(evt!.endedAt, undefined);
  });

  test("unscoped parent ask_user_question start/update is ignored across parallel stages", () => {
    storeInstance.recordStageStart("r1", makeStage("s2", "reviewer-b"));

    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    eventHandlers.get("tool_execution_start")!({
      toolName: "ask_user_question",
      toolCallId: "parent-ask",
      input: { questions: [{ question: "Parent prompt?" }] },
      ts: 123,
    });
    eventHandlers.get("tool_execution_update")!({
      toolName: "ask_user_question",
      toolCallId: "parent-ask",
      input: { questions: [{ question: "Parent prompt?" }] },
      ts: 124,
    });

    const run = storeInstance.snapshot().runs[0]!;
    for (const stage of run.stages) {
      assert.equal(stage.toolEvents.length, 0, `${stage.id} should not receive parent ask telemetry`);
      assert.equal(stage.status, "running", `${stage.id} should remain running`);
      assert.equal(stage.awaitingInputSince, undefined, `${stage.id} should not be awaiting input`);
    }
  });

  test("scoped ask_user_question records only own stage telemetry without awaiting input", () => {
    storeInstance.recordStageStart("r1", makeStage("s2", "reviewer-b"));

    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    eventHandlers.get("tool_execution_start")!({
      toolName: "ask_user_question",
      runId: "r1",
      stageId: "s2",
      toolCallId: "stage-ask",
      input: { questions: [{ question: "Stage prompt?" }] },
      ts: 123,
    });

    const run = storeInstance.snapshot().runs[0]!;
    const s1 = run.stages.find((s) => s.id === "s1")!;
    const s2 = run.stages.find((s) => s.id === "s2")!;
    assert.equal(s1.toolEvents.length, 0);
    assert.equal(s2.toolEvents.length, 1);
    assert.equal(s2.toolEvents[0]!.name, "ask_user_question");
    assert.equal(s1.status, "running");
    assert.equal(s2.status, "running");
    assert.equal(s1.awaitingInputSince, undefined);
    assert.equal(s2.awaitingInputSince, undefined);
  });

  test("duplicate start/update cannot migrate a scoped call to a sibling stage", () => {
    storeInstance.recordStageStart("r1", makeStage("s2", "reviewer-b"));

    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    eventHandlers.get("tool_execution_start")!({
      toolName: "bash",
      runId: "r1",
      stageId: "s1",
      toolCallId: "call-1",
      input: { cmd: "first" },
      ts: 100,
    });
    eventHandlers.get("tool_execution_start")!({
      toolName: "bash",
      runId: "r1",
      stageId: "s1",
      toolCallId: "call-1",
      input: { cmd: "duplicate" },
      ts: 101,
    });
    eventHandlers.get("tool_execution_update")!({
      toolName: "bash",
      runId: "r1",
      stageId: "s1",
      toolCallId: "call-1",
      input: { cmd: "attached-update" },
      ts: 102,
    });
    eventHandlers.get("tool_execution_update")!({
      toolName: "bash",
      runId: "r1",
      stageId: "s2",
      toolCallId: "call-1",
      input: { cmd: "must-not-migrate" },
      ts: 103,
    });
    eventHandlers.get("tool_execution_update")!({
      toolName: "bash",
      toolCallId: "call-1",
      input: { cmd: "unscoped-duplicate" },
      ts: 104,
    });

    const run = storeInstance.snapshot().runs[0]!;
    const s1 = run.stages.find((s) => s.id === "s1")!;
    const s2 = run.stages.find((s) => s.id === "s2")!;
    assert.equal(s1.toolEvents.length, 1);
    assert.equal(s1.toolEvents[0]!.startedAt, 100);
    assert.deepEqual(s1.toolEvents[0]!.input, { cmd: "first" });
    assert.equal(s2.toolEvents.length, 0);
    assert.equal(s1.status, "running");
    assert.equal(s2.status, "running");
  });

  test("active tracking is pruned when a stage ends before late update/end events", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    eventHandlers.get("tool_execution_start")!({
      toolName: "bash",
      runId: "r1",
      stageId: "s1",
      toolCallId: "call-1",
      ts: 100,
    });
    storeInstance.recordStageEnd("r1", {
      ...makeStage("s1", "scout"),
      status: "completed",
      endedAt: 200,
    });
    eventHandlers.get("tool_execution_update")!({
      toolName: "bash",
      runId: "r1",
      stageId: "s1",
      toolCallId: "call-1",
      ts: 201,
    });
    eventHandlers.get("tool_execution_end")!({
      toolName: "bash",
      runId: "r1",
      stageId: "s1",
      toolCallId: "call-1",
      endedAt: 202,
      output: "late",
    });

    const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "completed");
    assert.equal(stage.toolEvents.length, 1);
    assert.equal(stage.toolEvents[0]!.endedAt, undefined);
    assert.equal(stage.toolEvents[0]!.output, undefined);
  });

  test("unscoped ask_user_question tool_call/tool_result extension events do not update awaiting input", () => {
    const { pi, extensionHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    extensionHandlers.get("tool_call")!({
      type: "tool_call",
      toolName: "ask_user_question",
      toolCallId: "ask-2",
      input: { questions: [] },
    });
    extensionHandlers.get("tool_result")!({
      type: "tool_result",
      toolName: "ask_user_question",
      toolCallId: "ask-2",
      input: { questions: [] },
      content: [],
      isError: false,
    });

    const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "running");
    assert.equal(stage.awaitingInputSince, undefined);
    assert.equal(stage.toolEvents.length, 0);
  });

  test("unmatched main-chat ask_user_question result does not clear a workflow HIL prompt node", () => {
    storeInstance = createStore();
    storeInstance.recordRunStart(makeRun("r1", "my-wf"));
    storeInstance.recordStageStart("r1", makeStage("hil", "select"));
    assert.equal(storeInstance.recordStagePendingPrompt("r1", "hil", {
      id: "prompt-1",
      kind: "select",
      message: "workflow prompt",
      choices: ["one", "two"],
      createdAt: 123,
    }), true);

    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    eventHandlers.get("tool_execution_end")!({
      toolName: "ask_user_question",
      toolCallId: "main-chat-ask",
      endedAt: 456,
      output: "hold open one",
    });

    const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "awaiting_input");
    assert.equal(stage.pendingPrompt?.id, "prompt-1");
    assert.equal(stage.awaitingInputSince, 123);
  });

  test("malformed payloads do not crash", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    const startHandler = eventHandlers.get("tool_execution_start")!;
    assert.doesNotThrow(() => startHandler(null));
    assert.doesNotThrow(() => startHandler(undefined));
    assert.doesNotThrow(() => startHandler(42));
    assert.doesNotThrow(() => startHandler({}));
  });

  test("no-op when no active run exists", () => {
    const emptyStore = createStore();
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, emptyStore);

    const handler = eventHandlers.get("tool_execution_start")!;
    assert.doesNotThrow(() => handler({
      toolName: "bash",
      runId: "missing-run",
      stageId: "missing-stage",
      toolCallId: "call-1",
      ts: Date.now(),
    }));
    const snap = emptyStore.snapshot();
    assert.equal(snap.runs.length, 0);
  });
});
