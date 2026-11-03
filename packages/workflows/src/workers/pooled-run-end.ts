import type { Store } from "../shared/store.js";
import { isTerminalStageStatus } from "../shared/store-internal.js";
import type { RunSnapshot } from "../shared/store-types.js";

/**
 * Ends a pooled run that failed with its pool or on its own (#3996): its unfinished stages fail with the run's
 * error, so the graph counts none of them active and their chats show no worker; finished stages keep their outcome.
 */
export function endPooledRun(store: Store, run: RunSnapshot, error: string): void {
	const now = Date.now();
	for (const stage of run.stages)
		if (!isTerminalStageStatus(stage.status))
			store.recordStageEnd(run.id, {
				...stage,
				status: "failed",
				endedAt: now,
				durationMs: stage.startedAt === undefined ? undefined : Math.max(0, now - stage.startedAt),
				error,
			});
	store.recordRunEnd(run.id, "failed", undefined, error);
}

/**
 * Ends every unfinished run of a failed child's subtree, in store order. The subtree is found by walking down from the
 * child through the store's child index, so the cost follows the subtree, not the runs the store holds (#4190). The
 * walk passes through finished runs, since an unfinished run below one is still part of the child.
 */
export function endPooledChild(store: Store, childRunId: string, error: string): void {
	const child = store.run(childRunId);
	if (child === undefined) return;
	const subtree = [child];
	const seen = new Set([child.id]);
	for (let index = 0; index < subtree.length; index++)
		for (const nested of store.childRuns(subtree[index]!.id))
			if (!seen.has(nested.id)) {
				seen.add(nested.id);
				subtree.push(nested);
			}
	const unfinished = subtree
		.filter((run) => run.endedAt === undefined)
		.map((run) => ({ run, position: store.runPosition(run.id) ?? Number.MAX_SAFE_INTEGER }))
		.sort((left, right) => left.position - right.position);
	for (const { run } of unfinished) if (run.endedAt === undefined) endPooledRun(store, run, error);
}
