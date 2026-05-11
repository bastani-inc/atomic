/**
 * Wires the pi-workflows store to the above-editor widget via `ctx.ui.setWidget`.
 * Also subscribes to `tool_execution_*` pi events to feed store tool progress.
 *
 * All calls are guarded — no crash when the runtime lacks ui/events APIs.
 *
 * cross-ref: spec §5.4.4, §5.4.6, §5.5, §8.1 Phase E
 */

import type { StoreSnapshot } from "../store-types.js";
import type { Store } from "../store.js";
import { renderWidgetLines } from "./widget.js";

// ---------------------------------------------------------------------------
// Minimal structural types for the pi UI API (optional surface).
// These are only used for type-narrowing guards; they add no runtime dep.
// ---------------------------------------------------------------------------

/** Minimal component shape accepted by pi-tui setWidget. */
export interface WidgetComponent {
  render(width: number): string[];
  dispose?(): void;
}

/** Factory signature expected by pi.ui.setWidget. */
export type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;

/** Minimal ui surface — presence on the ExtensionAPI is optional. */
export interface PiUI {
  setWidget?: (
    key: string,
    factory: WidgetFactory | undefined,
    opts?: { placement?: string },
  ) => void;
}

/** Minimal ExtensionAPI slice consumed here. */
export interface LiveWidgetAPI {
  ui?: PiUI;
  events?: {
    on?: (event: string, handler: (payload: unknown) => void) => void;
  };
}

// ---------------------------------------------------------------------------
// Widget component factory
// ---------------------------------------------------------------------------

/**
 * Build a WidgetComponent that renders compact lines from the supplied snapshot.
 * The snapshot is captured at factory-call time; re-registration on every store
 * change keeps the view current (spec §5.4.4 pattern).
 */
function makeWidgetComponent(snap: StoreSnapshot): WidgetComponent {
  return {
    render(width: number): string[] {
      return renderWidgetLines(snap, width);
    },
  };
}

// ---------------------------------------------------------------------------
// installStoreWidget
// ---------------------------------------------------------------------------

/**
 * Subscribe to `storeInstance` and call `pi.ui.setWidget` on every change.
 * - Active runs → register widget factory that renders current snapshot.
 * - No active runs → clear widget with `setWidget("workflow.run", undefined)`.
 *
 * Returns an `unsubscribe` function that tears down the store subscription
 * (call on extension teardown if the runtime supports it).
 *
 * Safe to call even when `pi.ui` or `pi.ui.setWidget` is absent.
 */
export function installStoreWidget(pi: LiveWidgetAPI, storeInstance: Store): () => void {
  function applyWidget(snap: StoreSnapshot): void {
    const setWidget = pi.ui?.setWidget;
    if (typeof setWidget !== "function") return;

    const activeRuns = snap.runs.filter((r) => r.endedAt === undefined);

    if (activeRuns.length === 0) {
      // Clear widget when no runs in flight.
      setWidget.call(pi.ui, "workflow.run", undefined);
      return;
    }

    // Re-register factory with fresh snapshot closure on every store change.
    const capturedSnap = snap;
    const factory: WidgetFactory = (_tui, _theme) => makeWidgetComponent(capturedSnap);
    setWidget.call(pi.ui, "workflow.run", factory, { placement: "aboveEditor" });
  }

  // Subscribe — runs applyWidget on every store mutation.
  const unsubscribe = storeInstance.subscribe(applyWidget);

  // Apply immediately with current snapshot so widget shows up
  // if runs already exist when the hook is installed (e.g. after restore).
  applyWidget(storeInstance.snapshot());

  return unsubscribe;
}

// ---------------------------------------------------------------------------
// installToolExecutionHooks
// ---------------------------------------------------------------------------

/**
 * Shape of a `tool_execution_start` event payload (best-effort — runtime may
 * vary; we guard every field access with optional chaining).
 */
interface ToolExecutionStartPayload {
  toolName?: string;
  tool_name?: string;
  runId?: string;
  run_id?: string;
  stageId?: string;
  stage_id?: string;
  input?: Record<string, unknown>;
  ts?: number;
}

interface ToolExecutionEndPayload extends ToolExecutionStartPayload {
  output?: string;
  endedAt?: number;
  ended_at?: number;
  error?: string;
}

/**
 * Subscribe to `tool_execution_start` and `tool_execution_end` pi events
 * (and the `_update` variant) to feed the store with tool progress data.
 *
 * The active run / active stage heuristic:
 *   - If the payload carries explicit `runId`+`stageId`, use them directly.
 *   - Otherwise fall back to the store's `activeRunId()` and the first
 *     running stage in that run (best-effort for runtimes that omit context).
 *
 * No crash if `pi.events` or `pi.events.on` is absent.
 */
export function installToolExecutionHooks(pi: LiveWidgetAPI, storeInstance: Store): void {
  const on = pi.events?.on;
  if (typeof on !== "function") return;

  function resolveIds(
    payload: ToolExecutionStartPayload,
  ): { runId: string; stageId: string } | null {
    const runId =
      (payload.runId ?? payload.run_id) ?? storeInstance.activeRunId() ?? undefined;
    if (!runId) return null;

    const stageId = payload.stageId ?? payload.stage_id;
    if (stageId) return { runId, stageId };

    // Fall back: first running stage of active run.
    const runs = storeInstance.runs();
    const run = runs.find((r) => r.id === runId);
    const runningStage = run?.stages.find((s) => s.status === "running");
    if (!runningStage) return null;

    return { runId, stageId: runningStage.id };
  }

  on.call(pi.events, "tool_execution_start", (payload: unknown) => {
    try {
      const p = payload as ToolExecutionStartPayload;
      const ids = resolveIds(p);
      if (!ids) return;
      const toolName = p.toolName ?? p.tool_name ?? "unknown";
      storeInstance.recordToolStart(ids.runId, ids.stageId, {
        name: toolName,
        input: p.input,
        startedAt: p.ts ?? Date.now(),
      });
    } catch {
      // Never crash on event handler errors.
    }
  });

  // _update: treat as another start (refreshes tool event in list).
  on.call(pi.events, "tool_execution_update", (payload: unknown) => {
    try {
      const p = payload as ToolExecutionStartPayload;
      const ids = resolveIds(p);
      if (!ids) return;
      const toolName = p.toolName ?? p.tool_name ?? "unknown";
      storeInstance.recordToolStart(ids.runId, ids.stageId, {
        name: toolName,
        input: p.input,
        startedAt: p.ts ?? Date.now(),
      });
    } catch {
      // Never crash.
    }
  });

  on.call(pi.events, "tool_execution_end", (payload: unknown) => {
    try {
      const p = payload as ToolExecutionEndPayload;
      const ids = resolveIds(p);
      if (!ids) return;
      const toolName = p.toolName ?? p.tool_name ?? "unknown";
      storeInstance.recordToolEnd(ids.runId, ids.stageId, {
        name: toolName,
        input: p.input,
        startedAt: p.ts ?? Date.now(),
        endedAt: p.endedAt ?? p.ended_at ?? Date.now(),
        output: p.output,
      });
    } catch {
      // Never crash.
    }
  });
}
