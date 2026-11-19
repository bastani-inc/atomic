import { isTerminalRunStatus } from "../shared/store-internal.js";
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
	// A completed parent may have handled a child's failure. Restore that terminal descendant with its parent,
	// without making the failed child's own boundary replayable.
	const started = new Set<string>();
	for (const run of subtree)
		for (const stage of run.stages) if (stage.startedChildRunId !== undefined) started.add(stage.startedChildRunId);
	const complete =
		subtree.length === included.size &&
		subtree.every((run) =>
			isCompleteCachedRun(run, catalog.intentionalExitStatuses, run.id !== childRunId && started.has(run.id)),
		);
	return complete ? subtree.map(cloneRunSnapshot) : undefined;
}

function isCompleteCachedRun(
	run: RunSnapshot,
	intentionalExitStatuses: ReadonlyMap<string, RunSnapshot["status"]>,
	startedDescendant: boolean,
): boolean {
	if (
		run.endedAt === undefined ||
		!run.stages.every((stage) => isTerminalStage(stage.status) && stage.endedAt !== undefined)
	) {
		return false;
	}
	if (run.status === "completed" || run.exited === true) return true;
	return intentionalExitStatuses.get(run.id) === run.status || (startedDescendant && isTerminalRunStatus(run.status));
}

function isTerminalStage(status: RunSnapshot["stages"][number]["status"]): boolean {
	return status === "completed" || status === "failed" || status === "skipped";
}
