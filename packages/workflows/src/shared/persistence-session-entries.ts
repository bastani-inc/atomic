/**
 * Helpers to append workflow lifecycle entries via pi.appendEntry.
 * cross-ref: spec §5.6 Persistence via session entries
 *
 * All functions are pure helpers — they accept a PersistenceAPI and call
 * through gracefully when the runtime doesn't support the method.
 */

// ---------------------------------------------------------------------------
// Structural API type (subset of ExtensionAPI needed here)
// ---------------------------------------------------------------------------

/** Subset of the pi runtime API required for persistence operations. */
export interface PersistenceAPI {
  /** Appends a typed entry to the session transcript. Returns the entry ID. */
  appendEntry?: (type: string, payload: Record<string, unknown>) => string | undefined;
  /** Labels an entry for /tree bookmark filtering. */
  setLabel?: (entryId: string, label: string) => void;
  /** Appends a synthetic system/assistant message entry. */
  appendCustomMessageEntry?: (
    content: string,
    meta?: Record<string, unknown>,
  ) => string | undefined;
}

// ---------------------------------------------------------------------------
// Entry payload types (spec §5.6)
// ---------------------------------------------------------------------------

export interface RunStartPayload {
  readonly runId: string;
  readonly name: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly resumedFromRunId?: string;
  readonly resumeFromStageId?: string;
  readonly ts: number;
}

export interface StageStartPayload {
  readonly runId: string;
  readonly stageId: string;
  readonly name: string;
  readonly parentIds: readonly string[];
  readonly model?: string;
  readonly replayKey?: string;
  readonly replayedFromStageId?: string;
  readonly replayed?: boolean;
  readonly ts: number;
}

export interface StageProgressPayload {
  readonly runId: string;
  readonly stageId: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface WorkflowChildReplayPayload {
  readonly alias: string;
  readonly workflow: string;
  readonly runId: string;
  readonly status: "completed" | "failed" | "killed";
  readonly outputs: Record<string, unknown>;
  readonly rawOutput?: Record<string, unknown>;
}

export interface StageEndPayload {
  readonly runId: string;
  readonly stageId: string;
  readonly status: string;
  readonly durationMs?: number;
  readonly summary?: string;
  readonly error?: string;
  readonly failureKind?: string;
  readonly failureMessage?: string;
  readonly skippedReason?: string;
  readonly replayKey?: string;
  readonly replayedFromStageId?: string;
  readonly replayed?: boolean;
  readonly workflowChild?: WorkflowChildReplayPayload;
}

export interface RunEndPayload {
  readonly runId: string;
  readonly status: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly failureKind?: string;
  readonly failureMessage?: string;
  readonly failedStageId?: string;
  readonly resumable?: boolean;
  readonly ts: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Appends a `workflow.run.start` entry and labels it for /tree filtering.
 * Label format: `wf:<name>:<short-id>` (first 8 chars of runId).
 */
export function appendRunStart(api: PersistenceAPI, payload: RunStartPayload): void {
  if (typeof api.appendEntry !== "function") return;
  const entryId = api.appendEntry("workflow.run.start", {
    runId: payload.runId,
    name: payload.name,
    inputs: payload.inputs,
    ...(payload.resumedFromRunId !== undefined ? { resumedFromRunId: payload.resumedFromRunId } : {}),
    ...(payload.resumeFromStageId !== undefined ? { resumeFromStageId: payload.resumeFromStageId } : {}),
    ts: payload.ts,
  });
  if (entryId && typeof api.setLabel === "function") {
    const shortId = payload.runId.slice(0, 8);
    api.setLabel(entryId, `wf:${payload.name}:${shortId}`);
  }
}

/** Appends a `workflow.stage.start` entry. */
export function appendStageStart(api: PersistenceAPI, payload: StageStartPayload): void {
  if (typeof api.appendEntry !== "function") return;
  api.appendEntry("workflow.stage.start", {
    runId: payload.runId,
    stageId: payload.stageId,
    name: payload.name,
    parentIds: [...payload.parentIds],
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.replayKey !== undefined ? { replayKey: payload.replayKey } : {}),
    ...(payload.replayedFromStageId !== undefined ? { replayedFromStageId: payload.replayedFromStageId } : {}),
    ...(payload.replayed !== undefined ? { replayed: payload.replayed } : {}),
    ts: payload.ts,
  });
}

/** Appends a `workflow.stage.progress` entry (tool calls, message deltas, etc.). */
export function appendStageProgress(api: PersistenceAPI, payload: StageProgressPayload): void {
  if (typeof api.appendEntry !== "function") return;
  api.appendEntry("workflow.stage.progress", {
    runId: payload.runId,
    stageId: payload.stageId,
    kind: payload.kind,
    payload: payload.payload as Record<string, unknown>,
  });
}

/** Appends a `workflow.stage.end` entry. Optionally emits a custom message entry. */
export function appendStageEnd(
  api: PersistenceAPI,
  payload: StageEndPayload,
  opts?: { emitMessage?: boolean },
): void {
  if (typeof api.appendEntry !== "function") return;
  api.appendEntry("workflow.stage.end", {
    runId: payload.runId,
    stageId: payload.stageId,
    status: payload.status,
    ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
    ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
    ...(payload.error !== undefined ? { error: payload.error } : {}),
    ...(payload.failureKind !== undefined ? { failureKind: payload.failureKind } : {}),
    ...(payload.failureMessage !== undefined ? { failureMessage: payload.failureMessage } : {}),
    ...(payload.skippedReason !== undefined ? { skippedReason: payload.skippedReason } : {}),
    ...(payload.replayKey !== undefined ? { replayKey: payload.replayKey } : {}),
    ...(payload.replayedFromStageId !== undefined ? { replayedFromStageId: payload.replayedFromStageId } : {}),
    ...(payload.replayed !== undefined ? { replayed: payload.replayed } : {}),
    ...(payload.workflowChild !== undefined ? { workflowChild: payload.workflowChild } : {}),
  });
  if (opts?.emitMessage === true && payload.summary && typeof api.appendCustomMessageEntry === "function") {
    api.appendCustomMessageEntry(
      `Workflow stage ${payload.stageId} completed (${payload.status}): ${payload.summary}`,
      { runId: payload.runId, stageId: payload.stageId },
    );
  }
}

/** Appends a `workflow.run.end` entry. */
export function appendRunEnd(api: PersistenceAPI, payload: RunEndPayload): void {
  if (typeof api.appendEntry !== "function") return;
  api.appendEntry("workflow.run.end", {
    runId: payload.runId,
    status: payload.status,
    ...(payload.result !== undefined ? { result: payload.result as Record<string, unknown> } : {}),
    ...(payload.error !== undefined ? { error: payload.error } : {}),
    ...(payload.failureKind !== undefined ? { failureKind: payload.failureKind } : {}),
    ...(payload.failureMessage !== undefined ? { failureMessage: payload.failureMessage } : {}),
    ...(payload.failedStageId !== undefined ? { failedStageId: payload.failedStageId } : {}),
    ...(payload.resumable !== undefined ? { resumable: payload.resumable } : {}),
    ts: payload.ts,
  });
}
