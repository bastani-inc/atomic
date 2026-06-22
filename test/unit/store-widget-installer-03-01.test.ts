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
});
