/**
 * Unit tests for store-widget-installer.
 * Tests: installStoreWidget (setWidget calls), installToolExecutionHooks (event subscriptions).
 * cross-ref: spec §5.4.4, §5.4.6, §5.5, §8.1 Phase E
 */

import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { installStoreWidget, installToolExecutionHooks } from "../../packages/workflows/src/tui/store-widget-installer.js";
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
// installStoreWidget
// ---------------------------------------------------------------------------

describe("installStoreWidget", () => {
  let storeInstance: Store;

  beforeEach(() => {
    storeInstance = createStore();
  });

  test("clears the widget when there are no active runs", () => {
    const { pi, widgetCalls } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    assert.equal(widgetCalls.length, 1);
    assert.equal(widgetCalls[0]!.key, "workflow.run");
    assert.equal(widgetCalls[0]!.factory, undefined);
  });

  test("re-calls setWidget with a fresh factory when a run starts", () => {
    const { pi, widgetCalls } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    const before = widgetCalls.length;
    storeInstance.recordRunStart(makeRun("r1", "my-wf"));
    const newCalls = widgetCalls.slice(before);
    const factoryCall = newCalls.find((c) => typeof c.factory === "function");
    assert.ok(factoryCall, "expected at least one setWidget(factory) call");
    assert.equal(factoryCall.key, "workflow.run");
    assert.deepEqual(factoryCall.opts, { placement: "aboveEditor" });
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

  test("requests a render after each setWidget so pi flushes the change", () => {
    const { pi, widgetCalls, renderRequests } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    const beforeRequests = renderRequests.count;
    storeInstance.recordRunStart(makeRun("r1", "my-wf"));
    assert.ok(renderRequests.count > beforeRequests, "expected requestRender on store mutation");
    assert.ok(widgetCalls.length >= 2, "expected setWidget to be re-issued");
  });

  test("clears the widget again when the last active run ends", () => {
    const { pi, widgetCalls } = makeMockPi();
    installStoreWidget(pi, storeInstance);
    storeInstance.recordRunStart(makeRun("r1", "my-wf"));
    storeInstance.recordRunEnd("r1", "completed");
    const last = widgetCalls[widgetCalls.length - 1]!;
    assert.equal(last.factory, undefined);
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

  test("does not start an animation timer for running stages (no spinner)", async () => {
    // Regression: the widget used to keep an 80ms setInterval re-issuing
    // setWidget so the braille spinner glyph could advance. Now the glyph
    // is static (statusIcon contract), so the installer must rely solely
    // on store mutations — no timer wakeups when the user is idle.
    const { pi, widgetCalls } = makeMockPi();
    const unsubscribe = installStoreWidget(pi, storeInstance);
    const run = makeRun("r1", "my-wf");
    (run.stages as StageSnapshot[]).push(makeStage("s1", "stage-1"));
    storeInstance.recordRunStart(run);
    const callsAfterStart = widgetCalls.length;

    // No store mutations during this window — if a timer were running it
    // would push additional setWidget calls (one per ~80ms tick).
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(
      widgetCalls.length,
      callsAfterStart,
      "widget must not re-render on a timer while idle (would indicate a leaked spinner interval)",
    );
    unsubscribe();
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

  test("tool_execution_start records tool on active stage (fallback heuristic)", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    const handler = eventHandlers.get("tool_execution_start")!;
    handler({ toolName: "bash", input: { cmd: "ls" }, ts: Date.now() });

    const snap = storeInstance.snapshot();
    const run = snap.runs.find((r) => r.id === "r1")!;
    const stage = run.stages.find((s) => s.id === "s1")!;
    assert.equal(stage.toolEvents.length, 1);
    assert.equal(stage.toolEvents[0]!.name, "bash");
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
    assert.equal(s2.toolEvents.length, 1);
    assert.equal(s2.toolEvents[0]!.name, "grep");
    assert.equal(s1.toolEvents.length, 0);
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
    assert.notEqual(evt, undefined);
    assert.equal(evt!.output, "ok");
    assert.notEqual(evt!.endedAt, undefined);
  });

  test("ask_user_question start marks the active stage awaiting input", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    const startHandler = eventHandlers.get("tool_execution_start")!;
    startHandler({ toolName: "ask_user_question", toolCallId: "ask-1", ts: 123 });

    const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "awaiting_input");
    assert.equal(stage.awaitingInputSince, 123);
  });

  test("ask_user_question end clears awaiting input even after no stage is running", () => {
    const { pi, eventHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    eventHandlers.get("tool_execution_start")!({
      toolName: "ask_user_question",
      toolCallId: "ask-1",
      ts: 123,
    });
    assert.equal(storeInstance.snapshot().runs[0]!.stages[0]!.status, "awaiting_input");

    eventHandlers.get("tool_execution_end")!({
      toolCallId: "ask-1",
      endedAt: 456,
      output: "answered",
    });

    const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "running");
    assert.equal(stage.awaitingInputSince, undefined);
  });

  test("ask_user_question tool_call/tool_result extension events update awaiting input", () => {
    const { pi, extensionHandlers } = makeMockPi();
    installToolExecutionHooks(pi, storeInstance);

    extensionHandlers.get("tool_call")!({
      type: "tool_call",
      toolName: "ask_user_question",
      toolCallId: "ask-2",
      input: { questions: [] },
    });
    assert.equal(storeInstance.snapshot().runs[0]!.stages[0]!.status, "awaiting_input");

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
    assert.doesNotThrow(() => handler({ toolName: "bash", ts: Date.now() }));
    const snap = emptyStore.snapshot();
    assert.equal(snap.runs.length, 0);
  });
});
