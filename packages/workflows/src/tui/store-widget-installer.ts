/**
 * Widget installer — wires the orchestrator's below-editor widget to the
 * workflow store using a single long-lived component that is updated in
 * place (issue #1109).
 *
 * Placement note (belowEditor, not aboveEditor): pi-tui full-clears the
 * screen + scrollback whenever a changed line is above the viewport fold. An
 * aboveEditor widget gets pushed above the fold once the bottom region grows
 * tall, so each repaint cleared the whole screen (the resize flicker in
 * #1109). belowEditor keeps the widget among the last rendered lines (always
 * within the bottom viewport), so a repaint is a clean differential redraw.
 * See the `setWidget` call site for the full rationale.
 *
 * Pattern:
 *   1. The widget mounts once (`ui.setWidget(WIDGET_KEY, factory)`) on the
 *      hidden→visible transition and unmounts once
 *      (`ui.setWidget(WIDGET_KEY, undefined)`) on visible→hidden. Pi treats
 *      every `setWidget` call as a full replacement — it disposes the
 *      previous component, constructs a fresh one, rebuilds the widget
 *      container, and redraws — so re-issuing `setWidget` on each store
 *      mutation or clock tick produces a visible flicker. We therefore call
 *      it only on real mount/unmount transitions.
 *   2. For every other refresh — semantic store mutations that change
 *      content and the one-shot recent-ended expiry timer — we call
 *      `ui.requestRender()` only. Pi re-invokes the *same* mounted
 *      component's `render(width)` with no dispose/remount, so content
 *      updates land without flicker.
 *   3. The long-lived component reads the *latest* store snapshot through a
 *      live getter (`() => currentSnap`) at render time, so it is never
 *      visually stale — including after `up-arrow` history recall and other
 *      editor events that force a host re-render without a `setWidget` call.
 *   4. The mount / unmount / update / none decision is extracted into the
 *      pure, unit-testable `decideWidgetAction`, keeping this module a thin
 *      orchestration layer over a pure policy (SRP).
 *   5. There is deliberately NO per-second elapsed-clock cadence (issue
 *      #1856): clock-only ticks caused steady main-chat terminal writes,
 *      tail flicker, and native-scrollback snap-to-bottom while a workflow
 *      streamed in the background. Elapsed labels (`3s`, `complete · 4s
 *      ago`) advance on semantic store transitions and overlay opens; the
 *      only timer left is the one-shot recent-ended expiry unmount
 *      (`nextWidgetRefreshDelayMs`).
 */

import {
  decideReactiveWidgetAction,
  installReactiveWidget,
  type ReactiveWidgetAction,
  type ReactiveWidgetFactory,
  type ReactiveWidgetRenderState,
  type ReactiveWidgetTimerApi,
  type ReactiveWidgetTimerHandle,
} from "@bastani/atomic";
import type { Store } from "../shared/store.js";
import type { StoreSnapshot } from "../shared/store-types.js";
import { buildThemedWidgetLines, nextWidgetRefreshDelayMs } from "./widget.js";

export interface PiTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export type WidgetFactory = ReactiveWidgetFactory<unknown>;
export type WidgetAction = ReactiveWidgetAction;
export type WidgetRenderState = ReactiveWidgetRenderState;

interface UiSlice {
  setWidget?: (
    key: string,
    factory: WidgetFactory | undefined,
    opts?: { placement?: string },
  ) => void;
  requestRender?: () => void;
}

interface TimerApi extends ReactiveWidgetTimerApi {}
interface TimerHandle extends ReactiveWidgetTimerHandle {}

const defaultTimerApi: TimerApi = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs) as TimerHandle,
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface LiveWidgetAPI {
  ui?: UiSlice;
  on?: (event: string, handler: (payload: unknown, context?: unknown) => void) => void;
  events?: {
    on?: (event: string, handler: (payload: unknown) => void) => void;
  };
}

const WIDGET_KEY = "workflow.run";
const STALE_CONTEXT = "This extension ctx is stale";

function isStale(err: unknown): boolean {
  return err instanceof Error && err.message.includes(STALE_CONTEXT);
}

export function decideWidgetAction(
  prev: WidgetRenderState,
  nextLines: readonly string[],
): WidgetAction {
  return decideReactiveWidgetAction(prev, nextLines);
}

export function installStoreWidget(
  pi: LiveWidgetAPI,
  storeInstance: Store,
  timers: TimerApi = defaultTimerApi,
): () => void {
  const ui = pi.ui;
  if (!ui?.setWidget) return () => {};

  const requestRender = ui.requestRender;
  const controller = installReactiveWidget<StoreSnapshot, unknown>({
    ui: {
      setWidget: (key, factory, opts) => ui.setWidget?.(key, factory, opts),
      ...(requestRender ? { requestRender: () => requestRender.call(ui) } : {}),
    },
    key: WIDGET_KEY,
    placement: "belowEditor",
    timers,
    getSnapshot: () => storeInstance.snapshot(),
    subscribe: (listener) => storeInstance.subscribe(() => listener()),
    getPreviewLines: (snap, now) => buildThemedWidgetLines(snap, undefined, 120, now),
    render: (snap, { theme, width, now }) =>
      buildThemedWidgetLines(snap, theme as PiTheme | undefined, width, now),
    getNextRefreshDelayMs: (snap, now) => nextWidgetRefreshDelayMs(snap, now),
    // #1856: a store mutation that leaves the rendered card byte-identical
    // must not broadcast a host-wide render (each one becomes terminal
    // writes that fight native main-chat scrollback).
    requestRenderOnStateNoop: false,
    isStaleError: isStale,
  });

  return () => controller.dispose();
}

interface ToolExecutionStartPayload {
  toolName?: string;
  tool_name?: string;
  name?: string;
  runId?: string;
  run_id?: string;
  stageId?: string;
  stage_id?: string;
  toolCallId?: string;
  tool_call_id?: string;
  toolUseId?: string;
  tool_use_id?: string;
  id?: string;
  input?: Record<string, unknown>;
  args?: Record<string, unknown>;
  ts?: number;
}

interface ToolExecutionEndPayload extends ToolExecutionStartPayload {
  output?: string;
  endedAt?: number;
  ended_at?: number;
  error?: string;
}

export function installToolExecutionHooks(pi: LiveWidgetAPI, storeInstance: Store): void {
  const eventBusOn = pi.events?.on;
  const extensionOn = pi.on;
  if (typeof eventBusOn !== "function" && typeof extensionOn !== "function") return;

  interface StageScope {
    readonly runId: string;
    readonly stageId: string;
  }

  interface ActiveToolCall extends StageScope {
    readonly callId: string;
    readonly name: string;
    readonly startedAt: number;
  }

  const terminalRunStatuses = new Set(["completed", "failed", "killed", "skipped", "cancelled", "blocked"]);
  const terminalStageStatuses = new Set(["completed", "failed", "skipped"]);
  const activeToolCalls = new Map<string, ActiveToolCall>();

  function activeCallKey(runId: string, stageId: string, callId: string): string {
    return `${runId}\0${stageId}\0${callId}`;
  }

  function firstNonEmptyString(...values: readonly unknown[]): string | null {
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
  }

  function resolveExplicitStageScope(payload: ToolExecutionStartPayload): StageScope | null {
    const runId = firstNonEmptyString(payload.runId, payload.run_id);
    const stageId = firstNonEmptyString(payload.stageId, payload.stage_id);
    if (runId === null || stageId === null) return null;
    return { runId, stageId };
  }

  function hasLiveStageScope(scope: StageScope, snap: StoreSnapshot): boolean {
    const run = snap.runs.find((candidate) => candidate.id === scope.runId);
    if (!run || run.endedAt !== undefined || terminalRunStatuses.has(run.status)) return false;
    const stage = run.stages.find((candidate) => candidate.id === scope.stageId);
    return stage !== undefined && !terminalStageStatuses.has(stage.status);
  }

  function pruneActiveToolCalls(snap: StoreSnapshot): void {
    for (const [key, call] of activeToolCalls) {
      if (!hasLiveStageScope(call, snap)) activeToolCalls.delete(key);
    }
  }

  function activeToolCallForPayload(payload: ToolExecutionStartPayload): { key: string; call: ActiveToolCall } | null {
    const scope = resolveExplicitStageScope(payload);
    if (!scope) return null;

    const key = activeCallKey(scope.runId, scope.stageId, toolCallId(payload));
    const call = activeToolCalls.get(key);
    return call ? { key, call } : null;
  }

  storeInstance.subscribe(pruneActiveToolCalls);

  function recordToolStart(payload: unknown): void {
    if (!isToolExecutionPayload(payload)) return;

    const snap = storeInstance.snapshot();
    pruneActiveToolCalls(snap);

    const scope = resolveExplicitStageScope(payload);
    if (!scope || !hasLiveStageScope(scope, snap)) return;

    const callId = toolCallId(payload);
    const key = activeCallKey(scope.runId, scope.stageId, callId);
    if (activeToolCalls.has(key)) return;

    const name = toolName(payload);
    const startedAt = payload.ts ?? Date.now();
    activeToolCalls.set(key, { ...scope, callId, name, startedAt });
    storeInstance.recordToolStart(scope.runId, scope.stageId, {
      name,
      input: toolInput(payload),
      startedAt,
    });
  }

  function recordToolUpdate(payload: unknown): void {
    if (!isToolExecutionPayload(payload)) return;

    pruneActiveToolCalls(storeInstance.snapshot());

    if (!activeToolCallForPayload(payload)) return;
    // Updates are attach-only until the store has an explicit update API.
  }

  function recordToolEnd(payload: unknown): void {
    if (!isToolExecutionPayload(payload)) return;

    pruneActiveToolCalls(storeInstance.snapshot());

    const active = activeToolCallForPayload(payload);
    if (!active) return;

    storeInstance.recordToolEnd(active.call.runId, active.call.stageId, {
      name: active.call.name,
      input: toolInput(payload),
      startedAt: active.call.startedAt,
      endedAt: payload.endedAt ?? payload.ended_at ?? Date.now(),
      output: payload.output,
    });
    activeToolCalls.delete(active.key);
  }

  const safeStart = safelyHandle(recordToolStart);
  const safeUpdate = safelyHandle(recordToolUpdate);
  const safeEnd = safelyHandle(recordToolEnd);

  if (typeof eventBusOn === "function") {
    eventBusOn.call(pi.events, "tool_execution_start", safeStart);
    eventBusOn.call(pi.events, "tool_execution_update", safeUpdate);
    eventBusOn.call(pi.events, "tool_execution_end", safeEnd);
  }
  if (typeof extensionOn === "function") {
    extensionOn.call(pi, "tool_execution_start", safeStart);
    extensionOn.call(pi, "tool_execution_update", safeUpdate);
    extensionOn.call(pi, "tool_execution_end", safeEnd);
    extensionOn.call(pi, "tool_call", safeStart);
    extensionOn.call(pi, "tool_result", safeEnd);
  }
}

function isToolExecutionPayload(payload: unknown): payload is ToolExecutionEndPayload {
  return typeof payload === "object" && payload !== null;
}

function safelyHandle(handler: (payload: unknown) => void): (payload: unknown) => void {
  return (payload: unknown): void => {
    try {
      handler(payload);
    } catch {
      // Event hooks must not crash pi runtime when optional event payloads vary.
    }
  };
}

function toolName(payload: ToolExecutionStartPayload): string {
  return payload.toolName ?? payload.tool_name ?? payload.name ?? "unknown";
}

function toolCallId(payload: ToolExecutionStartPayload): string {
  return payload.toolCallId ?? payload.tool_call_id ?? payload.toolUseId ?? payload.tool_use_id ?? payload.id ?? "__ask_user_question__";
}

function toolInput(payload: ToolExecutionStartPayload): Record<string, unknown> | undefined {
  return payload.input ?? payload.args;
}
