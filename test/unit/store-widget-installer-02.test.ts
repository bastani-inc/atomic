// @ts-nocheck
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

  test("updates active elapsed time continuously without remounting or switching panels", async () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const timers = makeFakeTimers();
      const { pi, widgetCalls, renderRequests } = makeMockPi();
      installStoreWidget(pi, storeInstance, timers);
      storeInstance.recordRunStart(makeRun("r1", "my-wf"));
      await Promise.resolve();
      const mountCall = widgetCalls.findLast((c) => typeof c.factory === "function")!;
      const component = mountCall.factory!(null, undefined) as { render(w: number): string[] };
      const setWidgetCallsAfterStart = widgetCalls.length;
      assert.match(component.render(120).join("\n"), /single · 0s/);

      const firstTick = timers.scheduled.findLast((entry) => !entry.cleared);
      assert.ok(firstTick, "visible active workflow must schedule its first elapsed-time tick");
      assert.equal(firstTick.delayMs, 1_000);
      const requestsBeforeTick = renderRequests.count;
      now += firstTick.delayMs;
      firstTick.handler();
      await Promise.resolve();

      assert.equal(widgetCalls.length, setWidgetCallsAfterStart, "clock tick must update the mounted component in place");
      assert.ok(renderRequests.count > requestsBeforeTick, "clock tick must request a visible repaint");
      assert.match(component.render(120).join("\n"), /single · 1s/);

      const secondTick = timers.scheduled.findLast((entry) => !entry.cleared);
      assert.ok(secondTick && secondTick !== firstTick, "active cadence must reschedule continuously");
      now += secondTick.delayMs;
      secondTick.handler();
      await Promise.resolve();
      assert.match(component.render(120).join("\n"), /single · 2s/);
      assert.equal(widgetCalls.length, setWidgetCallsAfterStart, "continuous ticks must never remount the widget");
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

      now += 2_000;
      storeInstance.recordStageStart("r1", makeStage("s1", "stage-1"));
      await Promise.resolve();

      assert.equal(widgetCalls.filter((c) => typeof c.factory === "function").length, 1);
      assert.ok(host.renderRequests > requestsAfterStart, "semantic update should repaint through the TUI fallback");
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
    assert.ok(timer, "expected active elapsed timer before dispose");
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

  test("transitions from active cadence to one-shot ended expiry", () => {
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

      const activeTimer = timers.scheduled.findLast((entry) => !entry.cleared);
      assert.ok(activeTimer, "active run must schedule an elapsed refresh timer");
      assert.ok(activeTimer.delayMs <= 1_000, "active timer must target the next elapsed-second boundary");
      assert.equal(activeTimer.handle.unrefCalls, 1);

      storeInstance.recordRunEnd("r1", "completed");
      assert.equal(activeTimer.cleared, true, "ending the run must clear its active cadence");
      const expiryTimer = timers.scheduled.findLast((entry) => !entry.cleared);
      assert.ok(expiryTimer, "expected one-shot recent-ended expiry timer");
      assert.ok(expiryTimer.delayMs > 29_000, "ended run should refresh near expiry, not every second");
      assert.equal(expiryTimer.handle.unrefCalls, 1);
      unsubscribe();
    } finally {
      Date.now = originalNow;
    }
  });
});
