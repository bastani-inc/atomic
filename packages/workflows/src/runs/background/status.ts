/**
 * Status, internal cancellation, and resume helpers for retained workflow runs.
 *
 * These helpers operate against the singleton store and are consumed by:
 *   - Workflow inspection/resume surfaces
 *   - Internal lifecycle cancellation
 *
 * cross-ref: spec §5.5, §8.1 Phase D
 */

import type { Store } from "../../shared/store.js";
import type { RunSnapshot, RunStatus, StageSnapshot } from "../../shared/store-types.js";
import type { WorkflowInputValues, WorkflowOutputValues, WorkflowPersistencePort } from "../../shared/types.js";
import type { CancellationRegistry } from "./cancellation-registry.js";
import type { StageControlRegistry } from "../foreground/stage-control-registry.js";
import { store as defaultStore } from "../../shared/store.js";
import { stageControlRegistry as defaultStageControlRegistry } from "../foreground/stage-control-registry.js";
import { appendRunEnd } from "../../shared/persistence-session-entries.js";
import { expandWorkflowGraph } from "../../shared/expanded-workflow-graph.js";
import { topLevelWorkflowRuns } from "../../shared/run-visibility.js";
import { actionableReturnedStatusText, effectiveRunStatus, structuredRecoverableWorkflowFailureText } from "../../shared/returned-run-status.js";
import { getDurableBackend } from "../../durable/factory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunStatusEntry {
  readonly runId: string;
  readonly name: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly durationMs?: number;
  readonly stageCount: number;
}

export type KillResult =
  | { ok: true; runId: string; previousStatus: RunStatus }
  | { ok: false; runId: string; reason: "not_found" | "already_ended" };

export type ResumeResult =
  | {
      ok: true;
      runId: string;
      snapshot: RunSnapshot;
      resumed: readonly StageSnapshot[];
      mode?: "snapshot" | "paused" | "not_resumable";
      message?: string;
    }
  | { ok: false; runId: string; reason: "not_found" };

export type PauseResult =
  | {
      ok: true;
      runId: string;
      paused: readonly StageSnapshot[];
    }
  | {
      ok: false;
      runId: string;
      reason: "not_found" | "already_ended" | "no_active_stages" | "stage_not_found";
    };

export type InterruptRunResult = PauseResult;

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

// ---------------------------------------------------------------------------
// statusRuns
// ---------------------------------------------------------------------------

/**
 * Returns a summary of all retained runs in the current store/session.
 *
 * Terminal snapshots are retained for inspection and are visible by default;
 * the legacy `all` option is accepted as a compatibility no-op.
 */
export function statusRuns(opts?: { all?: boolean; store?: Store }): RunStatusEntry[] {
  const activeStore = opts?.store ?? defaultStore;

  const snapshot = activeStore.snapshot();
  return topLevelWorkflowRuns(snapshot.runs).map((run) => ({
    runId: run.id,
    name: run.name,
    status: effectiveRunStatus(run),
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    stageCount: expandWorkflowGraph(snapshot, run.id).stages.length,
  }));
}

// ---------------------------------------------------------------------------
// killRun
// ---------------------------------------------------------------------------

/**
 * Marks a run as "killed" in the store and appends a `workflow.run.end` entry
 * with status "killed" when persistence is provided.
 *
 * Checks run existence and terminal state BEFORE aborting the executor so that
 * "not_found" / "already_ended" rejections are cheap and side-effect-free.
 *
 * If the run has already ended (completed/failed/killed), returns ok:false with
 * reason "already_ended". If the runId is unknown, returns ok:false "not_found".
 */
export function killRun(
  runId: string,
  opts?: { store?: Store; cancellation?: CancellationRegistry; persistence?: WorkflowPersistencePort },
): KillResult {
  const activeStore = opts?.store ?? defaultStore;

  // Read run state BEFORE aborting — reject early without side-effects
  const runs = activeStore.runs();
  const run = runs.find((r) => r.id === runId);

  if (!run) {
    return { ok: false, runId, reason: "not_found" };
  }
  if (run.endedAt !== undefined) {
    return { ok: false, runId, reason: "already_ended" };
  }

  const previousStatus = run.status;

  // Abort active executor (no-op if not registered)
  const errorMessage = "workflow killed";
  opts?.cancellation?.abort(runId, errorMessage);

  const metadata = {
    failureKind: "cancelled",
    failureCode: "cancelled",
    failureRecoverability: "non_recoverable",
    failureDisposition: "terminal_killed",
    failureMessage: errorMessage,
    resumable: false,
  } as const;
  const recorded = activeStore.recordRunEnd(runId, "killed", undefined, errorMessage, metadata);
  if (recorded && opts?.persistence) {
    appendRunEnd(opts.persistence, {
      runId,
      status: "killed",
      error: errorMessage,
      ...metadata,
      ts: Date.now(),
    });
  }

  return { ok: true, runId, previousStatus };
}

/**
 * Kills all in-flight runs. Returns array of KillResult for each run acted on.
 * Appends one `workflow.run.end` with status "killed" per successful kill when
 * persistence is provided.
 */
export function killAllRuns(opts?: {
  store?: Store;
  cancellation?: CancellationRegistry;
  persistence?: WorkflowPersistencePort;
}): KillResult[] {
  const activeStore = opts?.store ?? defaultStore;
  const inFlight = topLevelWorkflowRuns(activeStore.runs()).filter((r) => r.endedAt === undefined);
  return inFlight.map((r) =>
    killRun(r.id, { store: activeStore, cancellation: opts?.cancellation, persistence: opts?.persistence }),
  );
}

// ---------------------------------------------------------------------------
// resumeRun
// ---------------------------------------------------------------------------

/**
 * Reopen a run for display, awaiting every live stage-control resume before
 * recording the corresponding store and durable transitions.
 *
 * Non-paused and terminal runs still return a read-only snapshot. Rejected
 * control acknowledgements reject this operation and leave unacknowledged
 * stages paused; callers surface that failure through their existing message
 * shapes.
 */
export async function resumeRun(
  runId: string,
  opts?: {
    store?: Store;
    stageControlRegistry?: StageControlRegistry;
    /** When supplied, resume only this stage within the run. */
    stageId?: string;
    /** Optional resume message forwarded to each resumed stage. */
    message?: string;
  },
): Promise<ResumeResult> {
  const activeStore = opts?.store ?? defaultStore;
  const registry = opts?.stageControlRegistry ?? defaultStageControlRegistry;
  const runs = activeStore.runs();
  const run = runs.find((candidate) => candidate.id === runId);

  if (!run) return { ok: false, runId, reason: "not_found" };

  const resumed: StageSnapshot[] = [];
  const controlRunIds = opts?.stageId ? [runId] : expandedControlRunIds(activeStore, runId);
  const hasPausedState = controlRunIds.some((controlRunId) => {
    const controlRun = runs.find((candidate) => candidate.id === controlRunId);
    return controlRun?.status === "paused" || (controlRun?.stages.some((stage) => stage.status === "paused") ?? false);
  });
  if (hasPausedState) {
    const handles = opts?.stageId
      ? [registry.get(runId, opts.stageId)].filter(
          (handle): handle is NonNullable<typeof handle> => handle !== undefined && handle.status === "paused",
        ).map((handle) => ({ controlRunId: runId, handle }))
      : controlRunIds.flatMap((controlRunId) =>
          registry.run(controlRunId).pausedStages().map((handle) => ({ controlRunId, handle })),
        );
    const resumedRunIds = new Set<string>();
    for (const { controlRunId, handle } of handles) {
      if (handle.status !== "paused") continue;
      await handle.resume(opts?.message);
      activeStore.recordStageResumed(controlRunId, handle.stageId);
      resumedRunIds.add(controlRunId);
      const controlRun = activeStore.runs().find((candidate) => candidate.id === controlRunId);
      const stage = controlRun?.stages.find((candidate) => candidate.id === handle.stageId);
      if (stage !== undefined) resumed.push(structuredClone(stage));
    }
    for (const controlRunId of resumedRunIds) {
      const controlRun = activeStore.runs().find((candidate) => candidate.id === controlRunId);
      const stillPaused = controlRun?.stages.some(
        (stage) => stage.status === "paused" || stage.status === "blocked",
      ) ?? false;
      if (!stillPaused) activeStore.recordRunResumed(controlRunId);
    }
    const currentRoot = activeStore.runs().find((candidate) => candidate.id === runId);
    const rootHasPausedStage = currentRoot?.stages.some(
      (stage) => stage.status === "paused" || stage.status === "blocked",
    ) ?? false;
    if (!rootHasPausedStage && (resumed.length > 0 || currentRoot?.status === "paused")) {
      activeStore.recordRunResumed(runId);
    }
    if (activeStore.runs().find((candidate) => candidate.id === runId)?.status === "running") {
      markDurableResumed(runId);
    }
  }

  const current = activeStore.runs().find((candidate) => candidate.id === runId) ?? run;
  const snapshot = structuredClone(current);
  const resumedCopy = structuredClone(resumed);
  if (current.status === "killed" || current.resumable === false) {
    return {
      ok: true,
      runId,
      snapshot,
      resumed: resumedCopy,
      mode: "not_resumable",
      message: "This workflow is not resumable; inspect the snapshot and start a new workflow run when ready.",
    };
  }
  if (
    current.endedAt === undefined &&
    current.resumable === true &&
    current.failureRecoverability === "recoverable" &&
    current.failedStageId !== undefined
  ) {
    return {
      ok: true,
      runId,
      snapshot,
      resumed: resumedCopy,
      mode: resumedCopy.length > 0 ? "paused" : "snapshot",
      message: `Workflow is blocked on a recoverable ${current.failureCode ?? current.failureKind ?? "workflow"} failure at stage ${current.failedStageId}; retry/resume after the issue clears.`,
    };
  }
  return {
    ok: true,
    runId,
    snapshot,
    resumed: resumedCopy,
    mode: resumedCopy.length > 0 ? "paused" : "snapshot",
  };
}

function markDurableResumed(runId: string): void {
  try {
    const backend = getDurableBackend();
    if (backend.getWorkflow(runId) !== undefined) backend.setWorkflowStatus(runId, "running");
  } catch {
    // Custom durability is best-effort; acknowledged local control state wins.
  }
}

// ---------------------------------------------------------------------------
// pauseRun
// ---------------------------------------------------------------------------

/** Pause a run only after its live stage controls acknowledge the request. */
function expandedControlRunIds(activeStore: Store, runId: string): string[] {
  const graph = expandWorkflowGraph(activeStore.snapshot(), runId);
  const ids = new Set<string>([runId]);
  for (const stage of graph.stages) ids.add(stage.workflowGraphTarget.runId);
  return [...ids];
}

export async function pauseRun(
  runId: string,
  opts?: {
    store?: Store;
    stageControlRegistry?: StageControlRegistry;
    /** Pause only this stage. */
    stageId?: string;
  },
): Promise<PauseResult> {
  const activeStore = opts?.store ?? defaultStore;
  const registry = opts?.stageControlRegistry ?? defaultStageControlRegistry;
  const run = activeStore.runs().find((candidate) => candidate.id === runId);

  if (!run) return { ok: false, runId, reason: "not_found" };
  if (run.endedAt !== undefined) return { ok: false, runId, reason: "already_ended" };

  if (opts?.stageId !== undefined) {
    const handle = registry.get(runId, opts.stageId);
    if (!handle) return { ok: false, runId, reason: "stage_not_found" };
    if (handle.status !== "running" && handle.status !== "pending") {
      return { ok: false, runId, reason: "no_active_stages" };
    }
    await handle.pause();
    activeStore.recordStagePaused(runId, opts.stageId);
    const currentRun = activeStore.runs().find((candidate) => candidate.id === runId);
    const stage = currentRun?.stages.find((candidate) => candidate.id === opts.stageId);
    const paused = stage === undefined ? [] : [structuredClone(stage)];
    const stillActive = currentRun?.stages.some(
      (candidate) =>
        candidate.id !== opts.stageId &&
        (candidate.status === "running" || candidate.status === "pending"),
    ) ?? false;
    if (!stillActive) activeStore.recordRunPaused(runId);
    return { ok: true, runId, paused };
  }

  const controlRunIds = expandedControlRunIds(activeStore, runId);
  const handles = controlRunIds.flatMap((controlRunId) =>
    registry.run(controlRunId).stages().filter(
      (handle) => handle.status === "running" || handle.status === "pending",
    ).map((handle) => ({ controlRunId, handle })),
  );
  if (handles.length === 0) return { ok: false, runId, reason: "no_active_stages" };

  const paused: StageSnapshot[] = [];
  const pausedRunIds = new Set<string>();
  for (const { controlRunId, handle } of handles) {
    await handle.pause();
    activeStore.recordStagePaused(controlRunId, handle.stageId);
    pausedRunIds.add(controlRunId);
    const controlRun = activeStore.runs().find((candidate) => candidate.id === controlRunId);
    const stage = controlRun?.stages.find((candidate) => candidate.id === handle.stageId);
    if (stage !== undefined) paused.push(structuredClone(stage));
  }
  for (const pausedRunId of pausedRunIds) activeStore.recordRunPaused(pausedRunId);
  activeStore.recordRunPaused(runId);
  return { ok: true, runId, paused };
}

export async function pauseAllRuns(opts?: {
  store?: Store;
  stageControlRegistry?: StageControlRegistry;
}): Promise<PauseResult[]> {
  const activeStore = opts?.store ?? defaultStore;
  const inFlight = topLevelWorkflowRuns(activeStore.runs()).filter((run) => run.endedAt === undefined);
  return Promise.all(inFlight.map((run) =>
    pauseRun(run.id, { store: activeStore, stageControlRegistry: opts?.stageControlRegistry })
  ));
}

// ---------------------------------------------------------------------------
// interruptRun
// ---------------------------------------------------------------------------

/** Interrupt a run in a resumable way without destructive cancellation. */
export async function interruptRun(
  runId: string,
  opts?: {
    store?: Store;
    stageControlRegistry?: StageControlRegistry;
    stageId?: string;
  },
): Promise<InterruptRunResult> {
  return pauseRun(runId, opts);
}

/** Interrupt all in-flight runs without removing them from history/status. */
export async function interruptAllRuns(opts?: {
  store?: Store;
  stageControlRegistry?: StageControlRegistry;
}): Promise<InterruptRunResult[]> {
  const activeStore = opts?.store ?? defaultStore;
  const inFlight = topLevelWorkflowRuns(activeStore.runs()).filter((run) => run.endedAt === undefined);
  return Promise.all(inFlight.map((run) =>
    interruptRun(run.id, { store: activeStore, stageControlRegistry: opts?.stageControlRegistry })
  ));
}

// ---------------------------------------------------------------------------
// inspectRun
// ---------------------------------------------------------------------------

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
