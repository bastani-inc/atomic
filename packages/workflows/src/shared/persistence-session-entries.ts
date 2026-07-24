/**
 * Helpers to append workflow lifecycle entries via pi.appendEntry.
 * cross-ref: spec §5.6 Persistence via session entries
 *
 * All functions are pure helpers — they accept a PersistenceAPI and call
 * through gracefully when the runtime doesn't support the method.
 */

import type { WorkflowExitStatus, WorkflowInputValues, WorkflowOutputValues } from "./types.js";
import type {
  WorkflowFailureCode,
  WorkflowFailureDisposition,
  WorkflowFailureKind,
} from "./store-types.js";

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
  readonly inputs: Readonly<WorkflowInputValues>;
  readonly parentRunId?: string;
  readonly parentStageId?: string;
  readonly rootRunId?: string;
  readonly resumedFromRunId?: string;
  readonly resumeFromStageId?: string;
  /** Elapsed ms inherited from prior sessions of a resumed run. */
  readonly accumulatedDurationMs?: number;
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
  readonly status: WorkflowExitStatus;
  readonly exited?: boolean;
  readonly outputs: WorkflowOutputValues;
  readonly exitReason?: string;
}

export interface StageEndPayload {
  readonly runId: string;
  readonly stageId: string;
  readonly status: string;
  readonly durationMs?: number;
  readonly summary?: string;
  readonly error?: string;
  readonly failureKind?: string;
  readonly failureCode?: string;
  readonly failureRecoverability?: string;
  readonly failureDisposition?: string;
  readonly failureMessage?: string;
  readonly retryAfterMs?: number;
  readonly skippedReason?: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly replayKey?: string;
  readonly replayedFromStageId?: string;
  readonly replayed?: boolean;
  readonly workflowChild?: WorkflowChildReplayPayload;
}

export interface RunEndPayload {
  readonly runId: string;
  readonly status: string;
  readonly result?: WorkflowOutputValues;
  readonly error?: string;
  readonly exited?: boolean;
  readonly exitReason?: string;
  readonly failureKind?: string;
  readonly failureCode?: string;
  readonly failureRecoverability?: string;
  readonly failureDisposition?: string;
  readonly failureMessage?: string;
  readonly failedStageId?: string;
  readonly failedToolNodeId?: string;
  readonly resumable?: boolean;
  readonly retryAfterMs?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly ts: number;
}

export interface RunBlockedPayload {
  readonly runId: string;
  readonly failedStageId: string;
  readonly error: string;
  readonly failureKind: WorkflowFailureKind;
  readonly failureCode?: WorkflowFailureCode;
  readonly failureMessage?: string;
  readonly failureRecoverability: "recoverable";
  readonly failureDisposition?: WorkflowFailureDisposition;
  readonly retryAfterMs?: number;
  readonly resumable: true;
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
    ...(payload.parentRunId !== undefined ? { parentRunId: payload.parentRunId } : {}),
    ...(payload.parentStageId !== undefined ? { parentStageId: payload.parentStageId } : {}),
    ...(payload.rootRunId !== undefined ? { rootRunId: payload.rootRunId } : {}),
    ...(payload.resumedFromRunId !== undefined ? { resumedFromRunId: payload.resumedFromRunId } : {}),
    ...(payload.resumeFromStageId !== undefined ? { resumeFromStageId: payload.resumeFromStageId } : {}),
    ...(payload.accumulatedDurationMs !== undefined ? { accumulatedDurationMs: payload.accumulatedDurationMs } : {}),
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
    ...(payload.failureCode !== undefined ? { failureCode: payload.failureCode } : {}),
    ...(payload.failureRecoverability !== undefined ? { failureRecoverability: payload.failureRecoverability } : {}),
    ...(payload.failureDisposition !== undefined ? { failureDisposition: payload.failureDisposition } : {}),
    ...(payload.failureMessage !== undefined ? { failureMessage: payload.failureMessage } : {}),
    ...(payload.retryAfterMs !== undefined ? { retryAfterMs: payload.retryAfterMs } : {}),
    ...(payload.skippedReason !== undefined ? { skippedReason: payload.skippedReason } : {}),
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
    ...(payload.sessionFile !== undefined ? { sessionFile: payload.sessionFile } : {}),
    ...(payload.replayKey !== undefined ? { replayKey: payload.replayKey } : {}),
    ...(payload.replayedFromStageId !== undefined ? { replayedFromStageId: payload.replayedFromStageId } : {}),
    ...(payload.replayed !== undefined ? { replayed: payload.replayed } : {}),
    ...(payload.status === "completed" && payload.workflowChild !== undefined ? { workflowChild: payload.workflowChild } : {}),
  });
  if (opts?.emitMessage === true && payload.summary && typeof api.appendCustomMessageEntry === "function") {
    api.appendCustomMessageEntry(
      `Workflow stage ${payload.stageId} completed (${payload.status}): ${payload.summary}`,
      { runId: payload.runId, stageId: payload.stageId },
    );
  }
}

function sanitizeTerminalRunEndPayload(payload: RunEndPayload): RunEndPayload {
  if (payload.status === "killed") {
    return {
      ...payload,
      failureRecoverability: "non_recoverable",
      failureDisposition: "terminal_killed",
      resumable: false,
    };
  }

  if (payload.failureDisposition !== "active_blocked") return payload;
  const sanitized = { ...payload };
  delete (sanitized as { failureDisposition?: string }).failureDisposition;
  return sanitized;
}

/** Appends a `workflow.run.end` entry. */
export function appendRunEnd(api: PersistenceAPI, payload: RunEndPayload): void {
  if (typeof api.appendEntry !== "function") return;
  const terminalPayload = sanitizeTerminalRunEndPayload(payload);
  api.appendEntry("workflow.run.end", {
    runId: terminalPayload.runId,
    status: terminalPayload.status,
    ...(terminalPayload.result !== undefined ? { result: terminalPayload.result } : {}),
    ...(terminalPayload.error !== undefined ? { error: terminalPayload.error } : {}),
    ...(terminalPayload.exited !== undefined ? { exited: terminalPayload.exited } : {}),
    ...(terminalPayload.exitReason !== undefined ? { exitReason: terminalPayload.exitReason } : {}),
    ...(terminalPayload.failureKind !== undefined ? { failureKind: terminalPayload.failureKind } : {}),
    ...(terminalPayload.failureCode !== undefined ? { failureCode: terminalPayload.failureCode } : {}),
    ...(terminalPayload.failureRecoverability !== undefined ? { failureRecoverability: terminalPayload.failureRecoverability } : {}),
    ...(terminalPayload.failureDisposition !== undefined ? { failureDisposition: terminalPayload.failureDisposition } : {}),
    ...(terminalPayload.failureMessage !== undefined ? { failureMessage: terminalPayload.failureMessage } : {}),
    ...(terminalPayload.failedStageId !== undefined ? { failedStageId: terminalPayload.failedStageId } : {}),
    ...(terminalPayload.failedToolNodeId !== undefined ? { failedToolNodeId: terminalPayload.failedToolNodeId } : {}),
    ...(terminalPayload.resumable !== undefined ? { resumable: terminalPayload.resumable } : {}),
    ...(terminalPayload.retryAfterMs !== undefined ? { retryAfterMs: terminalPayload.retryAfterMs } : {}),
    ...(terminalPayload.endedAt !== undefined ? { endedAt: terminalPayload.endedAt } : {}),
    ...(terminalPayload.durationMs !== undefined ? { durationMs: terminalPayload.durationMs } : {}),
    ts: terminalPayload.ts,
  });
}

/** Appends a `workflow.run.blocked` entry for active recoverable failures. */
export function appendRunBlocked(api: PersistenceAPI, payload: RunBlockedPayload): void {
  if (typeof api.appendEntry !== "function") return;
  api.appendEntry("workflow.run.blocked", {
    runId: payload.runId,
    failedStageId: payload.failedStageId,
    error: payload.error,
    failureKind: payload.failureKind,
    ...(payload.failureCode !== undefined ? { failureCode: payload.failureCode } : {}),
    ...(payload.failureMessage !== undefined ? { failureMessage: payload.failureMessage } : {}),
    failureRecoverability: payload.failureRecoverability,
    ...(payload.failureDisposition !== undefined ? { failureDisposition: payload.failureDisposition } : {}),
    ...(payload.retryAfterMs !== undefined ? { retryAfterMs: payload.retryAfterMs } : {}),
    resumable: payload.resumable,
    ts: payload.ts,
  });
}
