/**
 * Read-only per-run inspection surface.
 *
 * Extracted from `status.ts` (which stays focused on lifecycle status,
 * cancellation, and resume helpers) so both files respect the repository
 * file-length gate.
 *
 * cross-ref: spec §5.5
 */

import type { Store } from "../../shared/store.js";
import type { RunSnapshot, RunStatus } from "../../shared/store-types.js";
import type { WorkflowInputValues, WorkflowOutputValues } from "../../shared/types.js";
import { store as defaultStore } from "../../shared/store.js";
import { expandWorkflowGraph } from "../../shared/expanded-workflow-graph.js";
import { actionableReturnedStatusText, effectiveRunStatus, structuredRecoverableWorkflowFailureText } from "../../shared/returned-run-status.js";

/**
 * Per-run detail returned by {@link inspectRun}. A read-only view over the
 * store snapshot suitable for the "  RUN" detail surface — same data the
 * resume snapshot carries, plus a normalised `mode` field derived from
 * stage shape so renderers don't have to recompute it.
 */
export interface RunDetail {
  readonly runId: string;
  readonly name: string;
  readonly status: RunStatus;
  readonly mode: "single" | "chain";
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly pausedDurationMs?: number;
  readonly pausedAt?: number;
  readonly resumedAt?: number;
  /** Elapsed ms inherited from prior sessions of a resumed durable run. */
  readonly accumulatedDurationMs?: number;
  readonly inputs: Readonly<WorkflowInputValues>;
  readonly stages: readonly RunSnapshot["stages"][number][];
  readonly result?: WorkflowOutputValues;
  readonly error?: string;
  readonly exited?: boolean;
  readonly exitReason?: string;
  readonly failureKind?: RunSnapshot["failureKind"];
  readonly failureCode?: RunSnapshot["failureCode"];
  readonly failureRecoverability?: RunSnapshot["failureRecoverability"];
  readonly failureDisposition?: RunSnapshot["failureDisposition"];
  readonly failedStageId?: string;
  readonly resumable?: boolean;
  readonly retryAfterMs?: number;
  readonly blockedAt?: number;
}

export type InspectRunResult =
  | { ok: true; runId: string; detail: RunDetail }
  | { ok: false; runId: string; reason: "not_found" };

/**
 * Look up a single run by id (full UUID or unique prefix) and return a
 * normalised {@link RunDetail} for the per-run text/TUI surfaces.
 *
 * Returns ok:false "not_found" when no run matches, "ambiguous" when a
 * prefix matches multiple. Read-only: does not mutate the store.
 */
export function inspectRun(
  runId: string,
  opts?: { store?: Store },
): InspectRunResult {
  const activeStore = opts?.store ?? defaultStore;
  const runs = activeStore.runs();

  const exact = runs.find((r) => r.id === runId);
  const candidate = exact ?? (runs.length > 0 ? runs.find((r) => r.id.startsWith(runId)) : undefined);

  if (!candidate) {
    return { ok: false, runId, reason: "not_found" };
  }

  // Deep copy so callers cannot mutate the store via the snapshot.
  const copy = structuredClone(candidate);
  const expandedStages = expandWorkflowGraph(activeStore.snapshot(), copy.id).stages;

  const detail: RunDetail = {
    runId: copy.id,
    name: copy.name,
    status: effectiveRunStatus(copy),
    mode: expandedStages.length > 1 ? "chain" : "single",
    startedAt: copy.startedAt,
    endedAt: copy.endedAt,
    durationMs: copy.durationMs,
    pausedDurationMs: copy.pausedDurationMs,
    pausedAt: copy.pausedAt,
    resumedAt: copy.resumedAt,
    accumulatedDurationMs: copy.accumulatedDurationMs,
    inputs: copy.inputs,
    stages: expandedStages.map((stage) => structuredClone(stage)),
    result: copy.result,
    error: copy.error ?? (effectiveRunStatus(copy) === copy.status ? undefined : (structuredRecoverableWorkflowFailureText(copy) ?? actionableReturnedStatusText(copy.result))),
    exited: copy.exited,
    exitReason: copy.exitReason,
    failureKind: copy.failureKind,
    failureCode: copy.failureCode,
    failureRecoverability: copy.failureRecoverability,
    failureDisposition: copy.failureDisposition,
    failedStageId: copy.failedStageId,
    resumable: copy.resumable,
    retryAfterMs: copy.retryAfterMs,
    blockedAt: copy.blockedAt,
  };

  return { ok: true, runId: copy.id, detail };
}
