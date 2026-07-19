import type { DurableWorkflowBackend } from "../durable/backend.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowPersistencePort } from "../shared/types.js";
import { appendRunEnd } from "../shared/persistence-session-entries.js";

/**
 * Source ids whose active-block resume is currently in flight in this process.
 * Held across the dispatch+finalize window so a concurrent same-session resume
 * cannot double-dispatch; released once the local source is killed (after
 * which same-session routing refuses it). Cross-process concurrent resume is
 * not guarded here — it is the same recoverable, idempotent-replay edge that
 * exists for any durable failed/blocked run.
 */
const inFlightActiveBlockResumes = new Set<string>();

/**
 * Claim the right to resume an active recoverable block in this process. The
 * durable source is intentionally NOT mutated: it stays `blocked`/resumable so
 * it remains discoverable and recoverable — including a zero-checkpoint
 * first-stage block — if the process dies before the continuation settles.
 */
export function claimActiveBlockedResume(_backend: DurableWorkflowBackend, sourceId: string): boolean {
  if (inFlightActiveBlockResumes.has(sourceId)) return false;
  inFlightActiveBlockResumes.add(sourceId);
  return true;
}

/** Release an in-flight claim (dispatch failed, or the source was finalized). */
export function releaseActiveBlockedClaim(sourceId: string): void {
  inFlightActiveBlockResumes.delete(sourceId);
}
/**
 * Mark the resumed source killed locally so the same session will not re-resume
 * it. The durable source is intentionally left `blocked`/resumable for
 * cross-session/crash recoverability; killing only the in-session snapshot is
 * safe because same-session resume resolution consults that snapshot.
 */
export function finalizeResumedActiveBlockedSourceRun(
  source: RunSnapshot,
  continuationRunId: string,
  store: Store,
  persistence?: WorkflowPersistencePort,
): void {
  const error = source.error ?? source.failureMessage ?? `workflow resumed in new run ${continuationRunId}`;
  const metadata = {
    ...(source.failureKind !== undefined ? { failureKind: source.failureKind } : {}),
    ...(source.failureCode !== undefined ? { failureCode: source.failureCode } : {}),
    failureRecoverability: "non_recoverable" as const,
    failureDisposition: "terminal_killed" as const,
    ...(source.failureMessage !== undefined ? { failureMessage: source.failureMessage } : {}),
    ...(source.failedStageId !== undefined ? { failedStageId: source.failedStageId } : {}),
    resumable: false,
    ...(source.retryAfterMs !== undefined ? { retryAfterMs: source.retryAfterMs } : {}),
  };
  const recorded = store.recordRunEnd(source.id, "killed", undefined, error, metadata);
  if (recorded && persistence !== undefined) {
    appendRunEnd(persistence, { runId: source.id, status: "killed", error, ...metadata, ts: Date.now() });
  }
}
