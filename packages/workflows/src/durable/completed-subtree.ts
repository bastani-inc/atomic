import type { RunSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableNestedRunSnapshots } from "./completed-catalog.js";

/** Return one cached boundary's exact subtree only when every selected node is fully terminal. */
export function durableCompletedNestedRunSubtree(
	backend: DurableWorkflowBackend,
	rootWorkflowId: string,
	childRunId: string,
): readonly RunSnapshot[] | undefined {
	const nested = durableNestedRunSnapshots(backend, rootWorkflowId);
	if (!nested.some((run) => run.id === childRunId)) return undefined;
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
		subtree.length === included.size &&
		subtree.every(
			(run) =>
				run.status === "completed" &&
				run.endedAt !== undefined &&
				run.stages.every((stage) => isTerminalStage(stage.status) && stage.endedAt !== undefined),
		);
	return complete ? subtree : undefined;
}

function isTerminalStage(status: RunSnapshot["stages"][number]["status"]): boolean {
	return status === "completed" || status === "failed" || status === "skipped";
}
