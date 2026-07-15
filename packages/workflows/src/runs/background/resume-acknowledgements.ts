import type { Store } from "../../shared/store-public-types.js";
import type { StageSnapshot } from "../../shared/store-types.js";
import type { StageControlHandle } from "../foreground/stage-control-registry.js";

export interface ResumeAcknowledgementTarget {
  readonly controlRunId: string;
  readonly handle: StageControlHandle;
}

export interface ResumeAcknowledgementResult {
  readonly resumed: readonly StageSnapshot[];
  readonly acknowledged: number;
  /** Rejections whose targets are still visibly paused and therefore retryable. */
  readonly failures: readonly string[];
  /** Rejections reported after the target had already become visibly running. */
  readonly lateFailures: readonly string[];
}

function targetStage(
  store: Store,
  target: ResumeAcknowledgementTarget,
): StageSnapshot | undefined {
  return store.runs()
    .find((run) => run.id === target.controlRunId)
    ?.stages.find((stage) => stage.id === target.handle.stageId);
}

function targetIsActuallyPaused(store: Store, target: ResumeAcknowledgementTarget): boolean {
  const run = store.runs().find((candidate) => candidate.id === target.controlRunId);
  const stage = targetStage(store, target);
  if (run?.endedAt !== undefined || stage?.endedAt !== undefined) return false;
  return stage?.status === "paused" || stage?.status === "blocked"
    || (run?.status === "paused" && target.handle.status === "paused");
}

/** Attempt every actually-paused control, then reconcile outcomes from visible state in target order. */
export async function settleResumeAcknowledgements(
  store: Store,
  targets: readonly ResumeAcknowledgementTarget[],
  message?: string,
): Promise<ResumeAcknowledgementResult> {
  const attempted = targets.filter(
    (target) => target.handle.status === "paused" && targetIsActuallyPaused(store, target),
  );
  const settled = await Promise.allSettled(
    attempted.map(({ handle }) => handle.resume(message)),
  );
  const resumed: StageSnapshot[] = [];
  const failures: string[] = [];
  const lateFailures: string[] = [];
  const resumedRunIds = new Set<string>();
  settled.forEach((result, index) => {
    const target = attempted[index]!;
    const controlRun = store.runs().find((candidate) => candidate.id === target.controlRunId);
    const controlVisiblyRunning = target.handle.status === "running"
      || target.handle.status === "pending"
      || target.handle.status === "awaiting_input";
    if ((result.status === "fulfilled" || controlVisiblyRunning) && controlRun?.endedAt === undefined) {
      const stage = targetStage(store, target);
      if (stage?.status === "paused" || stage?.status === "blocked") {
        store.recordStageResumed(target.controlRunId, target.handle.stageId);
      }
    }
    const stage = targetStage(store, target);
    const visiblyRunning = controlRun?.endedAt === undefined && stage?.status === "running";
    if (visiblyRunning && stage !== undefined) {
      resumedRunIds.add(target.controlRunId);
      resumed.push(structuredClone(stage));
    }
    if (result.status !== "rejected") return;
    const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
    const qualified = `${target.controlRunId}/${target.handle.stageId}: ${detail}`;
    if (visiblyRunning) lateFailures.push(qualified);
    else if (controlRun?.endedAt === undefined && targetIsActuallyPaused(store, target)) failures.push(qualified);
  });
  for (const controlRunId of resumedRunIds) store.recordRunResumed(controlRunId);
  return { resumed, acknowledged: resumed.length, failures, lateFailures };
}
