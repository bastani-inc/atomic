import { isRunIdPrefix, resolveRunIdTarget } from "../shared/run-id.js";
import type { RunSnapshot } from "../shared/store-types.js";
import {
	findRunInSource,
	type RunSource,
	reciprocalWorkflowRootRunId,
	runsByIdOf,
	runsInSource,
} from "../shared/workflow-run-ownership.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { ScopedDurableBackend } from "./scoped-backend.js";

const workflowRunBackend = Symbol.for("atomic-workflows/run-journal-backend@1");
type BackendRun = RunSnapshot & { [workflowRunBackend]?: DurableWorkflowBackend };

/** Execution ownership stays with the root snapshot, not the store's default selection. */
export function bindRunDurableBackend(run: RunSnapshot, backend: DurableWorkflowBackend): void {
	Object.defineProperty(run, workflowRunBackend, { value: backend });
}

export function availableRunDurableBackend(runs: RunSource, runId: string): DurableWorkflowBackend | undefined {
	// Only an 8-hex prefix can resolve to another run; any other id is its own target, found or not.
	const target = resolveRunIdTarget(runId, isRunIdPrefix(runId) ? runsInSource(runs).map((run) => run.id) : []);
	const id = target.kind === "exact" || target.kind === "unique_prefix" ? target.runId : runId;
	const rootRunId = durableRootRunIdForRun(runs, id);
	const rootRun = rootRunId === undefined ? undefined : (findRunInSource(runs, rootRunId) as BackendRun | undefined);
	return rootRun?.[workflowRunBackend];
}

/** Resolve the top-level durable owner only through complete reciprocal run/boundary links. */
export function durableRootRunIdForRun(runs: RunSource, runId: string): string | undefined {
	return reciprocalWorkflowRootRunId(runsByIdOf(runs), runId);
}

/** Resolve the durable backend view owned by an exact, reciprocally linked workflow run. */
export function durableBackendForRun(
	backend: DurableWorkflowBackend,
	runs: RunSource,
	runId: string,
): DurableWorkflowBackend | undefined {
	const rootRunId = durableRootRunIdForRun(runs, runId);
	if (rootRunId === undefined) return undefined;
	const runById = runsByIdOf(runs);
	const rootBackend = availableRunDurableBackend(runs, rootRunId) ?? backend;
	if (rootRunId === runId) return rootBackend;

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

	let view = rootBackend;
	for (const scopePrefix of scopes.reverse()) {
		view = new ScopedDurableBackend(view, { rootWorkflowId: rootRunId, scopePrefix });
	}
	return view;
}
