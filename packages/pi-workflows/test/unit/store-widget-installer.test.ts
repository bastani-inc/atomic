/**
 * Unit tests for store-widget-installer.
 * Tests: installStoreWidget (setWidget calls), installToolExecutionHooks (event subscriptions).
 * cross-ref: spec §5.4.4, §5.4.6, §5.5, §8.1 Phase E
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { installStoreWidget, installToolExecutionHooks } from "../../src/tui/store-widget-installer.js";
import { createStore } from "../../src/store.js";
import type { Store } from "../../src/store.js";
import type { RunSnapshot, StageSnapshot } from "../../src/store-types.js";

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

function makeMockPi(): {
  pi: {
    ui: {
      setWidget: (
        key: string,
        factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined,
        opts?: { placement?: string },
      ) => void;
    };
    events: {
      on: (event: string, handler: (payload: unknown) => void) => void;
    };
  };
  widgetCalls: SetWidgetCall[];
  eventHandlers: Map<string, (payload: unknown) => void>;
} {
  const widgetCalls: SetWidgetCall[] = [];
  const eventHandlers: Map<string, (payload: unknown) => void> = new Map();

  const pi = {
    ui: {
      setWidget(
        key: string,
        factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined,
        opts?: { placement?: string },
      ): void {
        widgetCalls.push({ key, factory, opts });
      },
    },
    events: {
      on(event: string, handler: (payload: unknown) => void): void {
        eventHandlers.set(event, handler);
      },
    },
  };

  return { pi, widgetCalls, eventHandlers };
}

// ---------------------------------------------------------------------------
// installStoreWidget
// ---------------------------------------------------------------------------

describe("installStoreWidget", () => {
  let storeInstance: Store;

  beforeEach(() => {
    storeInstance = createStore();
  });

  test("calls setWidget(undefined) immediately when no active runs", () => {
    const { pi, widgetCalls } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    expect(widgetCalls.length).toBe(1);
    expect(widgetCalls[0]!.key).toBe("workflow.run");
    expect(widgetCalls[0]!.factory).toBeUndefined();
  });

  test("calls setWidget with factory when active run exists", () => {
    const { pi, widgetCalls } = makeMockPi();
    const run = makeRun("r1", "my-wf");
    storeInstance.recordRunStart(run);

    installStoreWidget(pi, storeInstance);
    // One initial call, one from recordRunStart subscription
    const lastCall = widgetCalls[widgetCalls.length - 1]!;
    expect(lastCall.key).toBe("workflow.run");
    expect(typeof lastCall.factory).toBe("function");
    expect(lastCall.opts).toEqual({ placement: "aboveEditor" });
  });

  test("factory returns component with render() that produces lines", () => {
    const { pi, widgetCalls } = makeMockPi();
    const run = makeRun("r1", "my-wf");
    storeInstance.recordRunStart(run);

    installStoreWidget(pi, storeInstance);
    const lastCall = widgetCalls[widgetCalls.length - 1]!;
    const component = lastCall.factory!(null, null);
    const lines = component.render(80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("▶ my-wf");
  });

  test("clears widget when run ends", () => {
    const { pi, widgetCalls } = makeMockPi();
    const run = makeRun("r1", "my-wf");
    storeInstance.recordRunStart(run);
    installStoreWidget(pi, storeInstance);

    // End the run → should clear widget
    storeInstance.recordRunEnd("r1", "completed");
    const lastCall = widgetCalls[widgetCalls.length - 1]!;
    expect(lastCall.factory).toBeUndefined();
  });

  test("re-registers factory on each store change (snapshot capture)", () => {
    const { pi, widgetCalls } = makeMockPi();
    const run = makeRun("r1", "my-wf");
    storeInstance.recordRunStart(run);
    installStoreWidget(pi, storeInstance);
    const callsBefore = widgetCalls.length;

    // Add a stage — triggers another store change
    storeInstance.recordStageStart("r1", makeStage("s1", "scout"));
    expect(widgetCalls.length).toBeGreaterThan(callsBefore);
  });

  test("returns unsubscribe — no more calls after unsubscribe", () => {
    const { pi, widgetCalls } = makeMockPi();
    const unsubscribe = installStoreWidget(pi, storeInstance);
    unsubscribe();
    const countAfterUnsub = widgetCalls.length;

    storeInstance.recordRunStart(makeRun("r1", "my-wf"));
    expect(widgetCalls.length).toBe(countAfterUnsub);
  });

  test("no crash when pi.ui is absent", () => {
    const piNoUI: { ui?: undefined; events?: undefined } = {};
    const storeNoUI = createStore();
    expect(() => installStoreWidget(piNoUI, storeNoUI)).not.toThrow();
  });

  test("no crash when pi.ui.setWidget is absent", () => {
    const piNoSetWidget = { ui: {} };
    const storeNoWidget = createStore();
    expect(() => installStoreWidget(piNoSetWidget, storeNoWidget)).not.toThrow();
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
    expect(() => installToolExecutionHooks(piNoEvents, storeInstance)).not.toThrow();
  });

  test("no crash when pi.events.on is absent", () => {
    const piNoOn = { events: {} };
    expect(() => installToolExecutionHooks(piNoOn, storeInstance)).not.toThrow();
  });

  test("subscribes to tool_execution_start, _update, _end", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);
    expect(eventHandlers.has("tool_execution_start")).toBe(true);
    expect(eventHandlers.has("tool_execution_update")).toBe(true);
    expect(eventHandlers.has("tool_execution_end")).toBe(true);
  });

  test("tool_execution_start records tool on active stage (fallback heuristic)", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    const handler = eventHandlers.get("tool_execution_start")!;
    handler({ toolName: "bash", input: { cmd: "ls" }, ts: Date.now() });

    const snap = storeInstance.snapshot();
    const run = snap.runs.find((r) => r.id === "r1")!;
    const stage = run.stages.find((s) => s.id === "s1")!;
    expect(stage.toolEvents.length).toBe(1);
    expect(stage.toolEvents[0]!.name).toBe("bash");
  });

  test("tool_execution_start with explicit runId+stageId routes correctly", () => {
    // Add a second stage
    storeInstance.recordStageStart("r1", makeStage("s2", "specialist"));

    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    const handler = eventHandlers.get("tool_execution_start")!;
    handler({ toolName: "grep", runId: "r1", stageId: "s2", ts: Date.now() });

    const snap = storeInstance.snapshot();
    const run = snap.runs.find((r) => r.id === "r1")!;
    const s2 = run.stages.find((s) => s.id === "s2")!;
    const s1 = run.stages.find((s) => s.id === "s1")!;
    expect(s2.toolEvents.length).toBe(1);
    expect(s2.toolEvents[0]!.name).toBe("grep");
    expect(s1.toolEvents.length).toBe(0);
  });

  test("tool_execution_end records tool end", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    const startTs = Date.now() - 500;
    const startHandler = eventHandlers.get("tool_execution_start")!;
    startHandler({ toolName: "bash", ts: startTs });

    const endHandler = eventHandlers.get("tool_execution_end")!;
    endHandler({ toolName: "bash", ts: startTs, endedAt: Date.now(), output: "ok" });

    const snap = storeInstance.snapshot();
    const run = snap.runs.find((r) => r.id === "r1")!;
    const stage = run.stages.find((s) => s.id === "s1")!;
    const evt = stage.toolEvents.find((e) => e.name === "bash");
    expect(evt).toBeDefined();
    expect(evt!.output).toBe("ok");
    expect(evt!.endedAt).toBeDefined();
  });

  test("malformed payloads do not crash", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    const startHandler = eventHandlers.get("tool_execution_start")!;
    expect(() => startHandler(null)).not.toThrow();
    expect(() => startHandler(undefined)).not.toThrow();
    expect(() => startHandler(42)).not.toThrow();
    expect(() => startHandler({})).not.toThrow();
  });

  test("no-op when no active run exists", () => {
    const emptyStore = createStore();
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, emptyStore);

    const handler = eventHandlers.get("tool_execution_start")!;
    expect(() => handler({ toolName: "bash", ts: Date.now() })).not.toThrow();
    const snap = emptyStore.snapshot();
    expect(snap.runs.length).toBe(0);
  });
});
