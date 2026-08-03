import type { RunSnapshot } from "./store-types.js";

export function isTopLevelWorkflowRun(run: Pick<RunSnapshot, "parentRunId">): boolean {
	return run.parentRunId === undefined;
}

export function topLevelWorkflowRuns(runs: readonly RunSnapshot[]): RunSnapshot[] {
	return runs.filter(isTopLevelWorkflowRun);
}
