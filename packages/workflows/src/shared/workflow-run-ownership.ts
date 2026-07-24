import type { RunSnapshot, StageSnapshot } from "./store-types.js";

/** Child run selected by a boundary's status-authoritative ownership metadata. */
export function authoritativeWorkflowChildRunId(
  stage: StageSnapshot | undefined,
): string | undefined {
  if (stage === undefined || stage.status === "failed" || stage.status === "skipped") {
    return undefined;
  }
  if (stage.status === "completed") {
    return stage.workflowChild?.runId ?? stage.workflowChildRun?.runId;
  }
  return stage.workflowChildRun?.runId;
}

/**
 * Resolve a run's top-level owner through complete reciprocal parent-boundary
 * links. Omitted root ids are compatible unknown metadata; present root ids
 * must agree with the reached top-level run.
 */
export function reciprocalWorkflowRootRunId(
  runById: ReadonlyMap<string, RunSnapshot>,
  runId: string,
): string | undefined {
  const visited = new Set<string>();
  const declaredRoots: string[] = [];
  let current = runById.get(runId);

  while (current !== undefined) {
    const currentId = current.id;
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    if (current.rootRunId !== undefined) declaredRoots.push(current.rootRunId);

    const parentRunId = current.parentRunId;
    const parentStageId = current.parentStageId;
    if ((parentRunId === undefined) !== (parentStageId === undefined)) return undefined;
    if (parentRunId === undefined || parentStageId === undefined) {
      return declaredRoots.every((declared) => declared === currentId)
        ? currentId
        : undefined;
    }

    const parent = runById.get(parentRunId);
    const boundary = parent?.stages.find((stage) => stage.id === parentStageId);
    if (parent === undefined || authoritativeWorkflowChildRunId(boundary) !== currentId) {
      return undefined;
    }
    current = parent;
  }

  return undefined;
}
