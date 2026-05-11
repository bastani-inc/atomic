import type { StoreSnapshot } from "../store-types.js";
import type { Store } from "../store.js";
import { renderWidgetLines } from "./widget.js";

export interface WidgetComponent {
  render(width: number): string[];
  dispose?(): void;
}

export type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;

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

function makeWidgetComponent(snap: StoreSnapshot): WidgetComponent {
  return {
    render(width: number): string[] {
      return renderWidgetLines(snap, width);
    },
  };
}

export function installStoreWidget(pi: LiveWidgetAPI, storeInstance: Store): () => void {
  function applyWidget(snap: StoreSnapshot): void {
    const setWidget = pi.ui?.setWidget;
    if (typeof setWidget !== "function") return;

    const hasActiveRun = snap.runs.some((run) => run.endedAt === undefined);
    if (!hasActiveRun) {
      setWidget.call(pi.ui, "workflow.run", undefined);
      return;
    }

    const factory: WidgetFactory = () => makeWidgetComponent(snap);
    setWidget.call(pi.ui, "workflow.run", factory, { placement: "aboveEditor" });
  }

  const unsubscribe = storeInstance.subscribe(applyWidget);
  applyWidget(storeInstance.snapshot());

  return unsubscribe;
}

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

export function installToolExecutionHooks(pi: LiveWidgetAPI, storeInstance: Store): void {
  const on = pi.events?.on;
  if (typeof on !== "function") return;

  function resolveIds(payload: ToolExecutionStartPayload): { runId: string; stageId: string } | null {
    const runId = payload.runId ?? payload.run_id ?? storeInstance.activeRunId();
    if (!runId) return null;

    const stageId = payload.stageId ?? payload.stage_id;
    if (stageId) return { runId, stageId };

    const run = storeInstance.runs().find((candidate) => candidate.id === runId);
    const runningStage = run?.stages.find((s) => s.status === "running");
    if (!runningStage) return null;

    return { runId, stageId: runningStage.id };
  }

  function recordToolStart(payload: unknown): void {
    if (!isToolExecutionPayload(payload)) return;

    const ids = resolveIds(payload);
    if (!ids) return;

    storeInstance.recordToolStart(ids.runId, ids.stageId, {
      name: toolName(payload),
      input: payload.input,
      startedAt: payload.ts ?? Date.now(),
    });
  }

  function recordToolEnd(payload: unknown): void {
    if (!isToolExecutionPayload(payload)) return;

    const ids = resolveIds(payload);
    if (!ids) return;

    storeInstance.recordToolEnd(ids.runId, ids.stageId, {
      name: toolName(payload),
      input: payload.input,
      startedAt: payload.ts ?? Date.now(),
      endedAt: payload.endedAt ?? payload.ended_at ?? Date.now(),
      output: payload.output,
    });
  }

  on.call(pi.events, "tool_execution_start", safelyHandle(recordToolStart));
  on.call(pi.events, "tool_execution_update", safelyHandle(recordToolStart));
  on.call(pi.events, "tool_execution_end", safelyHandle(recordToolEnd));
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
  return payload.toolName ?? payload.tool_name ?? "unknown";
}
