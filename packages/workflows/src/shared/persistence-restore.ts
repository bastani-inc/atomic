/**
 * Restore: scan session entries for in-flight runs on session_start.
 * Detects run.start entries without matching run.end and marks crashed or
 * attempts resume per the `resumeInFlight` config option.
 *
 * cross-ref: spec §5.6, §5.13
 */

import type { Store } from "./store.js";
import type {
  RunSnapshot,
  RunStatus,
  StageSnapshot,
  StageStatus,
  WorkflowFailureCode,
  WorkflowFailureDisposition,
  WorkflowFailureKind,
} from "./store-types.js";
import type { WorkflowExitStatus, WorkflowInputValues, WorkflowOutputValues } from "./types.js";
import { workflowSerializableObjectSchema } from "./serializable.js";
import { Value } from "typebox/value";
import {
  isWorkflowFailureCode,
  isWorkflowFailureDisposition,
  isWorkflowFailureKind,
  isWorkflowFailureRecoverability,
} from "./workflow-failures.js";

// ---------------------------------------------------------------------------
// Config option
// ---------------------------------------------------------------------------

/** Controls what the extension does with in-flight runs on session_start. */
export type ResumeInFlight = "ask" | "auto" | "never";

// ---------------------------------------------------------------------------
// Session entry types
// ---------------------------------------------------------------------------

/** Minimal shape of a pi session entry as returned by sessionManager.getEntries(). */
export interface SessionEntry {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** Structural type for pi's sessionManager (optional — degrades gracefully). */
export interface SessionManager {
  getEntries?: () => SessionEntry[] | readonly SessionEntry[];
}

// ---------------------------------------------------------------------------
// In-flight run descriptor (result of scan)
// ---------------------------------------------------------------------------

export interface InFlightRun {
  readonly runId: string;
  readonly name: string;
  readonly inputs: Readonly<WorkflowInputValues>;
  readonly startTs: number;
  /** Stage IDs that were started (in order) but may or may not have ended. */
  readonly stageIds: readonly string[];
}

interface RestoredRunBlockedMetadata {
  readonly failedStageId: string;
  readonly error: string;
  readonly failureKind: WorkflowFailureKind;
  readonly failureCode?: WorkflowFailureCode;
  readonly failureRecoverability: "recoverable";
  readonly failureDisposition?: WorkflowFailureDisposition;
  readonly failureMessage?: string;
  readonly retryAfterMs?: number;
  readonly resumable: true;
  readonly ts: number;
}

// ---------------------------------------------------------------------------
// Scan logic
// ---------------------------------------------------------------------------

/**
 * Scans a list of session entries and returns runs that have a
 * `workflow.run.start` entry but no matching `workflow.run.end`.
 *
 * Pure function — does not mutate anything.
 */
export function scanInFlightRuns(entries: readonly SessionEntry[]): InFlightRun[] {
  const started = new Map<string, { name: string; inputs: WorkflowInputValues; startTs: number; stageIds: string[] }>();
  const ended = new Set<string>();

  for (const entry of entries) {
    if (entry.type === "workflow.run.start") {
      const runId = entry.payload["runId"];
      const name = entry.payload["name"];
      const inputs = entry.payload["inputs"];
      const ts = entry.payload["ts"];
      if (
        typeof runId === "string" &&
        typeof name === "string" &&
        typeof ts === "number"
      ) {
        started.set(runId, {
          name,
          inputs: serializableObjectOrEmpty(inputs),
          startTs: ts,
          stageIds: [],
        });
      }
    }

    if (entry.type === "workflow.stage.start") {
      const runId = entry.payload["runId"];
      const stageId = entry.payload["stageId"];
      if (typeof runId === "string" && typeof stageId === "string") {
        const run = started.get(runId);
        if (run && !run.stageIds.includes(stageId)) {
          run.stageIds.push(stageId);
        }
      }
    }

    if (entry.type === "workflow.run.end") {
      const runId = entry.payload["runId"];
      if (typeof runId === "string") {
        ended.add(runId);
      }
    }
  }

  const result: InFlightRun[] = [];
  for (const [runId, info] of started) {
    if (!ended.has(runId)) {
      result.push({
        runId,
        name: info.name,
        inputs: Object.freeze({ ...info.inputs }),
        startTs: info.startTs,
        stageIds: Object.freeze([...info.stageIds]),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Restore callbacks
// ---------------------------------------------------------------------------

export interface RestoreCallbacks {
  /**
   * Called when a run is detected as crashed (no end entry, session restarted).
   * Implementations typically mark the run "failed" in the store and optionally
   * notify the user.
   */
  onCrashed?: (run: InFlightRun) => void;
  /**
   * Called when a run is being resumed (resumeInFlight === "auto").
   * Implementations typically re-register the run in the store with status "running".
   */
  onResume?: (run: InFlightRun) => void;
}

// ---------------------------------------------------------------------------
// restoreOnSessionStart
// ---------------------------------------------------------------------------

/**
 * Entry point called on `session_start`.
 *
 * Behavior by `config.resumeInFlight`:
 *   "never" — mark all in-flight runs as crashed (failed) in the store.
 *   "auto"  — restore in-flight runs to "running" in the store and call onResume.
 *   "ask"   — same as "never" for store side-effects; onCrashed is called so
 *             the caller can prompt the user and invoke resume logic separately.
 *
 * When `config.persistRuns` is false the function returns early — no session
 * entries were written, so there is nothing to restore.
 */
export function restoreOnSessionStart(
  sessionManager: SessionManager,
  config: { resumeInFlight: ResumeInFlight; persistRuns: boolean },
  store: Store,
  callbacks: RestoreCallbacks = {},
): void {
  if (!config.persistRuns) return;

  const getEntries = sessionManager.getEntries;
  if (typeof getEntries !== "function") return;

  const entries = getEntries.call(sessionManager);
  const sessionEntries = entries as readonly SessionEntry[];
  restoreTerminalRuns(sessionEntries, store);
  const inFlight = scanInFlightRuns(sessionEntries);
  if (inFlight.length === 0) return;

  for (const run of inFlight) {
    const runMeta = findRunStartMetadata(sessionEntries, run.runId);
    const blockedMeta = findRunBlockedMetadata(sessionEntries, run.runId);
    const stages = _buildStageSnapshots(sessionEntries, run.runId, blockedMeta);

    if (blockedMeta !== undefined) {
      const runSnapshot: RunSnapshot = {
        id: run.runId,
        name: run.name,
        inputs: run.inputs,
        status: "running",
        stages,
        startedAt: run.startTs,
        ...(runMeta.parentRunId !== undefined ? { parentRunId: runMeta.parentRunId } : {}),
        ...(runMeta.parentStageId !== undefined ? { parentStageId: runMeta.parentStageId } : {}),
        ...(runMeta.rootRunId !== undefined ? { rootRunId: runMeta.rootRunId } : {}),
        ...(runMeta.resumedFromRunId !== undefined ? { resumedFromRunId: runMeta.resumedFromRunId } : {}),
        ...(runMeta.resumeFromStageId !== undefined ? { resumeFromStageId: runMeta.resumeFromStageId } : {}),
      };
      store.recordRunStart(runSnapshot);
      store.recordRunBlocked(run.runId, blockedMeta.error, {
        failureKind: blockedMeta.failureKind,
        ...(blockedMeta.failureCode !== undefined ? { failureCode: blockedMeta.failureCode } : {}),
        failureRecoverability: "recoverable",
        ...(blockedMeta.failureDisposition !== undefined ? { failureDisposition: blockedMeta.failureDisposition } : {}),
        ...(blockedMeta.failureMessage !== undefined ? { failureMessage: blockedMeta.failureMessage } : {}),
        failedStageId: blockedMeta.failedStageId,
        resumable: true,
        ...(blockedMeta.retryAfterMs !== undefined ? { retryAfterMs: blockedMeta.retryAfterMs } : {}),
        blockedAt: blockedMeta.ts,
      });
      continue;
    }

    if (config.resumeInFlight === "auto") {
      // Re-hydrate the run into the store as "running"
      const runSnapshot: RunSnapshot = {
        id: run.runId,
        name: run.name,
        inputs: run.inputs,
        status: "running",
        stages,
        startedAt: run.startTs,
        ...(runMeta.parentRunId !== undefined ? { parentRunId: runMeta.parentRunId } : {}),
        ...(runMeta.parentStageId !== undefined ? { parentStageId: runMeta.parentStageId } : {}),
        ...(runMeta.rootRunId !== undefined ? { rootRunId: runMeta.rootRunId } : {}),
        ...(runMeta.resumedFromRunId !== undefined ? { resumedFromRunId: runMeta.resumedFromRunId } : {}),
        ...(runMeta.resumeFromStageId !== undefined ? { resumeFromStageId: runMeta.resumeFromStageId } : {}),
      };
      store.recordRunStart(runSnapshot);
      callbacks.onResume?.(run);
    } else {
      // "ask" or "never": mark as crashed in store, surface to caller
      const runSnapshot: RunSnapshot = {
        id: run.runId,
        name: run.name,
        inputs: run.inputs,
        status: "failed",
        stages,
        startedAt: run.startTs,
        endedAt: Date.now(),
        error: "Run did not complete — process was interrupted.",
        failureKind: "unknown",
        resumable: false,
        ...(runMeta.parentRunId !== undefined ? { parentRunId: runMeta.parentRunId } : {}),
        ...(runMeta.parentStageId !== undefined ? { parentStageId: runMeta.parentStageId } : {}),
        ...(runMeta.rootRunId !== undefined ? { rootRunId: runMeta.rootRunId } : {}),
        ...(runMeta.resumedFromRunId !== undefined ? { resumedFromRunId: runMeta.resumedFromRunId } : {}),
        ...(runMeta.resumeFromStageId !== undefined ? { resumeFromStageId: runMeta.resumeFromStageId } : {}),
      };
      store.recordRunStart(runSnapshot);
      store.recordRunEnd(run.runId, "failed");
      callbacks.onCrashed?.(run);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Rebuild partial StageSnapshot array from session entries for a given run. */
function _buildStageSnapshots(
  entries: readonly SessionEntry[],
  runId: string,
  blockedMeta?: RestoredRunBlockedMetadata,
): StageSnapshot[] {
  const stageMap = new Map<string, StageSnapshot>();
  const endedStages = new Set<string>();

  for (const entry of entries) {
    if (entry.payload["runId"] !== runId) continue;

    if (entry.type === "workflow.stage.start") {
      const stageId = entry.payload["stageId"];
      const name = entry.payload["name"];
      const parentIds = entry.payload["parentIds"];
      const ts = entry.payload["ts"];
      if (typeof stageId !== "string" || typeof name !== "string") continue;
      if (!stageMap.has(stageId)) {
        stageMap.set(stageId, {
          id: stageId,
          name,
          status: "running",
          parentIds: Array.isArray(parentIds) ? (parentIds as string[]) : [],
          startedAt: typeof ts === "number" ? ts : undefined,
          ...replayMetadata(entry.payload),
          toolEvents: [],
        });
      }
    }

    if (entry.type === "workflow.stage.end") {
      const stageId = entry.payload["stageId"];
      const status = entry.payload["status"];
      const durationMs = entry.payload["durationMs"];
      const summary = entry.payload["summary"];
      const error = entry.payload["error"];
      const failureKind = entry.payload["failureKind"];
      const failureCode = entry.payload["failureCode"];
      const failureRecoverability = entry.payload["failureRecoverability"];
      const failureDisposition = entry.payload["failureDisposition"];
      const retryAfterMs = entry.payload["retryAfterMs"];
      const failureMessage = entry.payload["failureMessage"];
      const skippedReason = entry.payload["skippedReason"];
      const sessionId = entry.payload["sessionId"];
      const sessionFile = entry.payload["sessionFile"];
      if (typeof stageId !== "string") continue;
      endedStages.add(stageId);
      const snap = stageMap.get(stageId);
      if (snap) {
        snap.status = restoreStageStatus(status);
        if (typeof durationMs === "number") snap.durationMs = durationMs;
        if (typeof summary === "string") snap.result = summary;
        if (typeof error === "string") snap.error = error;
        if (typeof failureKind === "string" && isWorkflowFailureKind(failureKind)) snap.failureKind = failureKind;
        if (typeof failureCode === "string" && isWorkflowFailureCode(failureCode)) snap.failureCode = failureCode;
        if (typeof failureRecoverability === "string" && isWorkflowFailureRecoverability(failureRecoverability)) snap.failureRecoverability = failureRecoverability;
        if (typeof failureDisposition === "string" && isWorkflowFailureDisposition(failureDisposition)) snap.failureDisposition = failureDisposition;
        if (typeof retryAfterMs === "number") snap.retryAfterMs = retryAfterMs;
        if (typeof failureMessage === "string") snap.failureMessage = failureMessage;
        if (typeof skippedReason === "string") snap.skippedReason = skippedReason;
        if (typeof sessionId === "string") snap.sessionId = sessionId;
        if (typeof sessionFile === "string") snap.sessionFile = sessionFile;
        Object.assign(snap, replayMetadata(entry.payload), workflowChildMetadata(entry.payload));
      }
    }
  }

  if (blockedMeta !== undefined) {
    restoreBlockedStageState(stageMap, endedStages, blockedMeta);
  } else {
    // Mark any stage that didn't get an end entry as crashed.
    for (const [stageId, snap] of stageMap) {
      if (endedStages.has(stageId)) continue;
      snap.status = "failed";
      snap.error = "Stage did not complete — process was interrupted.";
    }
  }

  return [...stageMap.values()];
}

function hasRestoredAncestor(
  stageMap: ReadonlyMap<string, StageSnapshot>,
  stage: StageSnapshot,
  ancestorId: string,
): boolean {
  const queue = [...stage.parentIds];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next)) continue;
    if (next === ancestorId) return true;
    seen.add(next);
    queue.push(...(stageMap.get(next)?.parentIds ?? []));
  }

  return false;
}

function markRestoredBlockedFailureStage(
  snap: StageSnapshot,
  blockedMeta: RestoredRunBlockedMetadata,
): void {
  snap.status = "failed";
  snap.error = blockedMeta.error;
  snap.failureKind = blockedMeta.failureKind;
  snap.failureCode = blockedMeta.failureCode;
  snap.failureRecoverability = blockedMeta.failureRecoverability;
  snap.failureDisposition = blockedMeta.failureDisposition;
  snap.failureMessage = blockedMeta.failureMessage;
  snap.retryAfterMs = blockedMeta.retryAfterMs;
}

function restoreBlockedStageState(
  stageMap: Map<string, StageSnapshot>,
  endedStages: ReadonlySet<string>,
  blockedMeta: RestoredRunBlockedMetadata,
): void {
  for (const [stageId, snap] of stageMap) {
    if (endedStages.has(stageId)) continue;
    if (stageId === blockedMeta.failedStageId) {
      markRestoredBlockedFailureStage(snap, blockedMeta);
      continue;
    }
    if (hasRestoredAncestor(stageMap, snap, blockedMeta.failedStageId)) {
      snap.status = "blocked";
      snap.blockedByStageId = blockedMeta.failedStageId;
    }
  }
}

function replayMetadata(payload: Record<string, unknown>): Pick<StageSnapshot, "replayKey" | "replayedFromStageId" | "replayed"> {
  const replayKey = payload["replayKey"];
  const replayedFromStageId = payload["replayedFromStageId"];
  const replayed = payload["replayed"];
  return {
    ...(typeof replayKey === "string" ? { replayKey } : {}),
    ...(typeof replayedFromStageId === "string" ? { replayedFromStageId } : {}),
    ...(typeof replayed === "boolean" ? { replayed } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializableObject(value: unknown): WorkflowOutputValues | undefined {
  return Value.Check(workflowSerializableObjectSchema, value)
    ? (value as WorkflowOutputValues)
    : undefined;
}

function serializableObjectOrEmpty(value: unknown): WorkflowOutputValues {
  return serializableObject(value) ?? {};
}

function isWorkflowChildReplayStatus(status: unknown): status is WorkflowExitStatus {
  return status === "completed" || status === "skipped" || status === "cancelled" || status === "blocked";
}

function workflowChildMetadata(payload: Record<string, unknown>): Pick<StageSnapshot, "workflowChild"> {
  if (payload["status"] !== "completed") return {};
  const workflowChild = payload["workflowChild"];
  if (!isRecord(workflowChild)) return {};
  const alias = workflowChild["alias"];
  const workflow = workflowChild["workflow"];
  const childRunId = workflowChild["runId"];
  const status = workflowChild["status"];
  const outputs = workflowChild["outputs"];
  const exited = workflowChild["exited"];
  const exitReason = workflowChild["exitReason"];
  if (
    typeof alias !== "string" ||
    typeof workflow !== "string" ||
    typeof childRunId !== "string" ||
    !isWorkflowChildReplayStatus(status) ||
    !isRecord(outputs)
  ) {
    return {};
  }

  // `structuredClone` detaches the restored snapshot from the parsed JSONL
  // payload with a guaranteed deep copy, independent of the TypeBox
  // serializable check. Declared `outputs` are the child contract, so a
  // non-serializable value bails the whole child snapshot.
  let clonedOutputs: WorkflowOutputValues;
  try {
    const serializableOutputs = serializableObject(outputs);
    if (serializableOutputs === undefined) return {};
    clonedOutputs = structuredClone(serializableOutputs);
  } catch {
    return {};
  }

  return {
    workflowChild: {
      alias,
      workflow,
      runId: childRunId,
      status,
      ...(typeof exited === "boolean" ? { exited } : status !== "completed" || typeof exitReason === "string" ? { exited: true } : {}),
      outputs: clonedOutputs,
      ...(typeof exitReason === "string" ? { exitReason } : {}),
    },
  };
}

function restoreStageStatus(status: unknown): StageStatus {
  switch (status) {
    case "completed":
    case "failed":
    case "skipped":
    case "blocked":
      return status;
    default:
      return "failed";
  }
}

function numericRetryAfterMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function findRunBlockedMetadata(
  entries: readonly SessionEntry[],
  runId: string,
): RestoredRunBlockedMetadata | undefined {
  let latest: RestoredRunBlockedMetadata | undefined;
  for (const entry of entries) {
    if (entry.type !== "workflow.run.blocked" || entry.payload["runId"] !== runId) continue;
    const failedStageId = entry.payload["failedStageId"];
    const error = entry.payload["error"];
    const failureKind = entry.payload["failureKind"];
    const failureCode = entry.payload["failureCode"];
    const failureRecoverability = entry.payload["failureRecoverability"];
    const failureDisposition = entry.payload["failureDisposition"];
    const failureMessage = entry.payload["failureMessage"];
    const retryAfterMs = numericRetryAfterMs(entry.payload["retryAfterMs"]);
    const resumable = entry.payload["resumable"];
    const ts = entry.payload["ts"];
    if (
      typeof failedStageId !== "string" ||
      typeof error !== "string" ||
      typeof failureKind !== "string" ||
      !isWorkflowFailureKind(failureKind) ||
      failureRecoverability !== "recoverable" ||
      resumable !== true ||
      typeof ts !== "number"
    ) {
      continue;
    }
    latest = {
      failedStageId,
      error,
      failureKind,
      ...(typeof failureCode === "string" && isWorkflowFailureCode(failureCode) ? { failureCode } : {}),
      failureRecoverability: "recoverable",
      ...(typeof failureDisposition === "string" && isWorkflowFailureDisposition(failureDisposition) ? { failureDisposition } : {}),
      ...(typeof failureMessage === "string" ? { failureMessage } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      resumable: true,
      ts,
    };
  }
  return latest;
}

function restoreTerminalRuns(entries: readonly SessionEntry[], store: Store): void {
  const started = new Map<string, { readonly name: string; readonly inputs: Readonly<WorkflowInputValues>; readonly startTs: number }>();
  const ended = new Map<string, Record<string, unknown>>();

  for (const entry of entries) {
    if (entry.type === "workflow.run.start") {
      const runId = entry.payload["runId"];
      const name = entry.payload["name"];
      const inputs = entry.payload["inputs"];
      const ts = entry.payload["ts"];
      if (typeof runId === "string" && typeof name === "string" && typeof ts === "number") {
        started.set(runId, {
          name,
          inputs: serializableObjectOrEmpty(inputs),
          startTs: ts,
        });
      }
    }
    if (entry.type === "workflow.run.end") {
      const runId = entry.payload["runId"];
      if (typeof runId === "string") ended.set(runId, entry.payload);
    }
  }

  for (const [runId, start] of started) {
    if (store.runs().some((run) => run.id === runId)) continue;
    const end = ended.get(runId);
    const status = restoreTerminalRunStatus(end?.["status"]);
    if (end === undefined || status === undefined) continue;

    const runMeta = findRunStartMetadata(entries, runId);
    const stages = _buildStageSnapshots(entries, runId);
    const exited = end["exited"];
    const exitReason = end["exitReason"];
    const resumable = end["resumable"];
    const restoredAuthorExit = isWorkflowExitTerminalStatus(status) &&
      (exited === true || status !== "completed" || typeof exitReason === "string" || resumable === false);
    if (status === "completed" && !restoredAuthorExit && stages.some((stage) => stage.status !== "completed")) continue;
    store.recordRunStart({
      id: runId,
      name: start.name,
      inputs: start.inputs,
      status: "running",
      stages,
      startedAt: start.startTs,
      ...(runMeta.parentRunId !== undefined ? { parentRunId: runMeta.parentRunId } : {}),
      ...(runMeta.parentStageId !== undefined ? { parentStageId: runMeta.parentStageId } : {}),
      ...(runMeta.rootRunId !== undefined ? { rootRunId: runMeta.rootRunId } : {}),
      ...(runMeta.resumedFromRunId !== undefined ? { resumedFromRunId: runMeta.resumedFromRunId } : {}),
      ...(runMeta.resumeFromStageId !== undefined ? { resumeFromStageId: runMeta.resumeFromStageId } : {}),
    });

    const error = end["error"];
    const result = serializableObject(end["result"]);
    const failureKind = end["failureKind"];
    const failureCode = end["failureCode"];
    const failureRecoverability = end["failureRecoverability"];
    const failureDisposition = end["failureDisposition"];
    const retryAfterMs = numericRetryAfterMs(end["retryAfterMs"]);
    const failureMessage = end["failureMessage"];
    const failedStageId = end["failedStageId"];
    store.recordRunEnd(
      runId,
      status,
      result,
      typeof error === "string" ? error : undefined,
      {
        ...(typeof failureKind === "string" && isWorkflowFailureKind(failureKind) ? { failureKind } : {}),
        ...(typeof failureCode === "string" && isWorkflowFailureCode(failureCode) ? { failureCode } : {}),
        ...(typeof failureRecoverability === "string" && isWorkflowFailureRecoverability(failureRecoverability) ? { failureRecoverability } : {}),
        ...(typeof failureDisposition === "string" && isWorkflowFailureDisposition(failureDisposition) ? { failureDisposition } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(typeof failureMessage === "string" ? { failureMessage } : {}),
        ...(typeof failedStageId === "string" ? { failedStageId } : {}),
        ...(typeof resumable === "boolean" ? { resumable } : isWorkflowExitTerminalStatus(status) && restoredAuthorExit ? { resumable: false } : {}),
        ...(restoredAuthorExit && isWorkflowExitTerminalStatus(status) ? { exited: true } : {}),
        ...(typeof exitReason === "string" ? { exitReason } : {}),
      },
    );
  }
}

function isWorkflowExitTerminalStatus(status: RunStatus): status is WorkflowExitStatus {
  return status === "completed" || status === "skipped" || status === "cancelled" || status === "blocked";
}

function restoreTerminalRunStatus(status: unknown): RunStatus | undefined {
  switch (status) {
    case "completed":
    case "skipped":
    case "cancelled":
    case "blocked":
    case "failed":
    case "killed":
      return status;
    default:
      return undefined;
  }
}

function findRunStartMetadata(
  entries: readonly SessionEntry[],
  runId: string,
): {
  readonly parentRunId?: string;
  readonly parentStageId?: string;
  readonly rootRunId?: string;
  readonly resumedFromRunId?: string;
  readonly resumeFromStageId?: string;
} {
  for (const entry of entries) {
    if (entry.type !== "workflow.run.start" || entry.payload["runId"] !== runId) continue;
    const parentRunId = entry.payload["parentRunId"];
    const parentStageId = entry.payload["parentStageId"];
    const rootRunId = entry.payload["rootRunId"];
    const resumedFromRunId = entry.payload["resumedFromRunId"];
    const resumeFromStageId = entry.payload["resumeFromStageId"];
    return {
      ...(typeof parentRunId === "string" ? { parentRunId } : {}),
      ...(typeof parentStageId === "string" ? { parentStageId } : {}),
      ...(typeof rootRunId === "string" ? { rootRunId } : {}),
      ...(typeof resumedFromRunId === "string" ? { resumedFromRunId } : {}),
      ...(typeof resumeFromStageId === "string" ? { resumeFromStageId } : {}),
    };
  }
  return {};
}
