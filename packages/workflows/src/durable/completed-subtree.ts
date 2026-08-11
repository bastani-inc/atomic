import type { RunSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableNestedRunSnapshots } from "./completed-catalog.js";
import { parseWorkflowChildResult } from "./workflow-child-result.js";

/** Return one cached boundary's exact subtree only when every selected node is fully terminal. */
export function durableCompletedNestedRunSubtree(
	backend: DurableWorkflowBackend,
	rootWorkflowId: string,
	childRunId: string,
): readonly RunSnapshot[] | undefined {
	const nested = durableNestedRunSnapshots(backend, rootWorkflowId);
	if (!nested.some((run) => run.id === childRunId)) return undefined;
	const intentionalExitStatuses = new Map<string, RunSnapshot["status"]>();
	for (const checkpoint of backend.listCheckpoints(rootWorkflowId)) {
		if (checkpoint.kind !== "stage") continue;
		const child = parseWorkflowChildResult(checkpoint.output);
		if (child?.exited === true) intentionalExitStatuses.set(child.runId, child.status);
	}
	const included = new Set([childRunId]);
	let priorSize = -1;
	while (priorSize !== included.size) {
		priorSize = included.size;
		for (const run of nested) {
			if (run.parentRunId !== undefined && included.has(run.parentRunId)) included.add(run.id);
		}
	}
	const subtree = nested.filter((run) => included.has(run.id));
	const complete =
		subtree.length === included.size && subtree.every((run) => isCompleteCachedRun(run, intentionalExitStatuses));
	return complete ? subtree : undefined;
}

function isCompleteCachedRun(
	run: RunSnapshot,
	intentionalExitStatuses: ReadonlyMap<string, RunSnapshot["status"]>,
): boolean {
	if (
		run.endedAt === undefined ||
		!run.stages.every((stage) => isTerminalStage(stage.status) && stage.endedAt !== undefined)
	) {
		return false;
	}
	if (run.status === "completed" || run.exited === true) return true;
	return intentionalExitStatuses.get(run.id) === run.status;
}

function isTerminalStage(status: RunSnapshot["stages"][number]["status"]): boolean {
	return status === "completed" || status === "failed" || status === "skipped";
}
