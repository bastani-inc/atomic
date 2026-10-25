import type { RunSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { cloneRunSnapshot, durableNestedRunCatalog } from "./completed-catalog.js";

/** Return one cached boundary's exact subtree only when every selected node is fully terminal. */
export function durableCompletedNestedRunSubtree(
	backend: DurableWorkflowBackend,
	rootWorkflowId: string,
	childRunId: string,
): readonly RunSnapshot[] | undefined {
	const catalog = durableNestedRunCatalog(backend, rootWorkflowId);
	if (!catalog.positionsById.has(childRunId)) return undefined;
	const included = new Set([childRunId]);
	const pending = [childRunId];
	for (let runId = pending.pop(); runId !== undefined; runId = pending.pop()) {
		for (const childId of catalog.childIdsByParent.get(runId) ?? []) {
			if (included.has(childId)) continue;
			included.add(childId);
			pending.push(childId);
		}
	}
	const positions = [...included]
		.flatMap((runId) => catalog.positionsById.get(runId) ?? [])
		.sort((left, right) => left - right);
	const subtree = positions.map((position) => catalog.runs[position]!);
	const complete =
		subtree.length === included.size &&
		subtree.every((run) => isCompleteCachedRun(run, catalog.intentionalExitStatuses));
	return complete ? subtree.map(cloneRunSnapshot) : undefined;
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
