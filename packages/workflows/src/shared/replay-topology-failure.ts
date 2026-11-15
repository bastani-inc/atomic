import type { RunSnapshot } from "./store-types.js";

export const REPLAY_TOPOLOGY_MISMATCH_MESSAGE = "atomic-workflows: insufficient_state: replay topology mismatch";

export function isReplayTopologyMismatchMessage(message: string): boolean {
	return (
		message === REPLAY_TOPOLOGY_MISMATCH_MESSAGE || message.startsWith(`${REPLAY_TOPOLOGY_MISMATCH_MESSAGE} for `)
	);
}

/**
 * Fails when a node of this run names a parent the run never had. A replayed node, or a live one that took the parents
 * its record names, keeps a recorded parent that changed or was removed: the run no longer takes that step, and its
 * records would name a node that does not exist (#4945).
 */
export function assertRecordedParentsMaterialised(
	run: Pick<RunSnapshot, "id" | "stages" | "toolNodes" | "resumedFromRunId">,
	/** A recorded parent the run may keep without running it again: a fork's copied node (#4321). */
	keepsRecordedParent: (parentId: string) => boolean,
): void {
	const nodes = new Set<string>([...run.stages, ...run.toolNodes].map((node) => node.id));
	for (const node of [...run.stages, ...run.toolNodes]) {
		const missing = node.parentIds.find((parentId) => !nodes.has(parentId) && !keepsRecordedParent(parentId));
		if (missing === undefined) continue;
		const kind = "kind" in node ? "tool" : "stage";
		throw new Error(
			`${REPLAY_TOPOLOGY_MISMATCH_MESSAGE} for ${kind} "${node.name}" (node "${node.id}") in source run ${run.resumedFromRunId ?? run.id}: its recorded parent "${missing}" did not run again`,
		);
	}
}
