import type { RunSnapshot } from "../shared/store-types.js";
import { reciprocalWorkflowRootRunId } from "../shared/workflow-run-ownership.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { ScopedDurableBackend } from "./scoped-backend.js";

/** Resolve the top-level durable owner only through complete reciprocal run/boundary links. */
export function durableRootRunIdForRun(runs: readonly RunSnapshot[], runId: string): string | undefined {
	return reciprocalWorkflowRootRunId(new Map(runs.map((run) => [run.id, run])), runId);
}

/** Resolve the durable backend view owned by an exact, reciprocally linked workflow run. */
export function durableBackendForRun(
	backend: DurableWorkflowBackend,
	runs: readonly RunSnapshot[],
	runId: string,
): DurableWorkflowBackend | undefined {
	const rootRunId = durableRootRunIdForRun(runs, runId);
	if (rootRunId === undefined) return undefined;
	const runById = new Map(runs.map((run) => [run.id, run]));
	if (rootRunId === runId) return backend;

	const scopes: string[] = [];
	let current = runById.get(runId);
	while (current !== undefined && current.id !== rootRunId) {
		const parent = current.parentRunId === undefined ? undefined : runById.get(current.parentRunId);
		const boundary = parent?.stages.find((stage) => stage.id === current?.parentStageId);
		if (parent === undefined || boundary?.replayKey === undefined) return undefined;
		scopes.push(boundary.replayKey);
		current = parent;
	}
	if (current?.id !== rootRunId) return undefined;

	let view = backend;
	for (const scopePrefix of scopes.reverse()) {
		view = new ScopedDurableBackend(view, { rootWorkflowId: rootRunId, scopePrefix });
	}
	return view;
}
