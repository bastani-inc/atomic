import type { RunSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";

/** Inspection evidence on the root's existing ending, never a new checkpoint or a replay input. */
export interface PooledDispatchRefusals {
	readonly runId: string;
	readonly attempt: number;
	readonly stageIds: readonly string[];
}

// A resume creates a new run snapshot even when it reuses both the root id and its boundary ids.
const refused = new WeakMap<RunSnapshot, string[]>();

export function recordPooledDispatchRefusal(run: RunSnapshot, stageId: string): void {
	const ids = refused.get(run);
	if (ids === undefined) refused.set(run, [stageId]);
	else ids.push(stageId);
}

export function releasePooledDispatchRefusals(run: RunSnapshot): void {
	refused.delete(run);
}

export function pooledDispatchRefusals(
	run: RunSnapshot,
	backend: DurableWorkflowBackend,
): PooledDispatchRefusals | undefined {
	const stageIds = refused.get(run);
	if (stageIds === undefined || backend.workflowAttempt === undefined) return undefined;
	return { runId: run.id, attempt: backend.workflowAttempt(run.id), stageIds: [...stageIds] };
}

/** Lazily indexed on inspection only. The receipt is immutable and only refused calls contribute IDs. */
const inspected = new WeakMap<PooledDispatchRefusals, ReadonlySet<string>>();
export function refusedStagesForInspection(
	backend: DurableWorkflowBackend,
	rootId: string,
): ReadonlySet<string> | undefined {
	const evidence = backend.pooledDispatchRefusals?.(rootId);
	if (!evidence || !Array.isArray(evidence.stageIds)) return undefined;
	let ids = inspected.get(evidence);
	if (!ids) {
		ids = new Set(evidence.stageIds);
		inspected.set(evidence, ids);
	}
	return ids;
}
