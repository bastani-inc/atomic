import {
  _buildStageSnapshots,
  findRunBlockedMetadata,
  findRunStartMetadata,
  restoreTerminalRuns,
  serializableObjectOrEmpty,
} from "./persistence-restore-helpers.js";
/**
 * Restore: scan session entries for in-flight runs on session_start.
 * Detects run.start entries without matching run.end and marks crashed or
 * attempts resume per the `resumeInFlight` config option.
 *
 * cross-ref: spec §5.6, §5.13
 */

import type { Store } from "./store.js";
import type { RunSnapshot } from "./store-types.js";
import type { WorkflowInputValues, WorkflowSerializableValue } from "./types.js";

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
  readonly payload?: Record<string, WorkflowSerializableValue>;
  readonly customType?: string;
  readonly data?: Record<string, WorkflowSerializableValue>;
}

export interface NormalizedSessionEntry {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, WorkflowSerializableValue>;
}

export function normalizeSessionEntries(entries: readonly SessionEntry[]): readonly NormalizedSessionEntry[] {
  return entries.flatMap((entry): readonly NormalizedSessionEntry[] => {
    if (entry.type === "custom" && typeof entry.customType === "string" && entry.data !== undefined) {
      return [{ id: entry.id, type: entry.customType, payload: entry.data }];
    }
    if (entry.payload !== undefined) return [{ id: entry.id, type: entry.type, payload: entry.payload }];
    return [];
  });
}

/** Structural type for pi's sessionManager (optional — degrades gracefully). */
export interface SessionManager {
  getCwd?: () => string;
  getEntries?: () => SessionEntry[] | readonly SessionEntry[];
  getSessionDir?: () => string;
  usesDefaultSessionDir?: () => boolean;
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

  for (const entry of normalizeSessionEntries(entries)) {
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

  const entries = getEntries.call(sessionManager) as readonly SessionEntry[];
  const sessionEntries = normalizeSessionEntries(entries);
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
        ...(runMeta.accumulatedDurationMs !== undefined ? { accumulatedDurationMs: runMeta.accumulatedDurationMs } : {}),
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
        ...(runMeta.accumulatedDurationMs !== undefined ? { accumulatedDurationMs: runMeta.accumulatedDurationMs } : {}),
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
        ...(runMeta.accumulatedDurationMs !== undefined ? { accumulatedDurationMs: runMeta.accumulatedDurationMs } : {}),
      };
      store.recordRunStart(runSnapshot);
      store.recordRunEnd(run.runId, "failed");
      callbacks.onCrashed?.(run);
    }
  }
}

