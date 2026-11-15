import type { RunSnapshot } from "./store-types.js";

export const REPLAY_TOPOLOGY_MISMATCH_MESSAGE = "atomic-workflows: insufficient_state: replay topology mismatch";

export function isReplayTopologyMismatchMessage(message: string): boolean {
	return (
		message === REPLAY_TOPOLOGY_MISMATCH_MESSAGE || message.startsWith(`${REPLAY_TOPOLOGY_MISMATCH_MESSAGE} for `)
	);
}

/**
 * Fails when a node this run replayed names a recorded parent the run never had: the parent changed or was removed, so
 * the replay took a step the run no longer takes, and its records would name a node that does not exist (#4945).
 */
export function assertReplayedParentsMaterialised(
	run: Pick<RunSnapshot, "id" | "stages" | "toolNodes" | "resumedFromRunId">,
	/** A recorded parent the run may keep without running it again: a fork's copied node (#4321). */
	keepsRecordedParent: (parentId: string) => boolean = () => false,
): void {
	const nodes = new Set<string>([...run.stages, ...run.toolNodes].map((node) => node.id));
	for (const node of [...run.stages, ...run.toolNodes]) {
		if (node.replayed !== true) continue;
		const missing = node.parentIds.find((parentId) => !nodes.has(parentId) && !keepsRecordedParent(parentId));
		if (missing === undefined) continue;
		const kind = "kind" in node && node.kind === "tool" ? "tool" : "stage";
		throw new Error(
			`${REPLAY_TOPOLOGY_MISMATCH_MESSAGE} for ${kind} "${node.name}" (node "${node.id}") in source run ${run.resumedFromRunId ?? run.id}: its recorded parent "${missing}" did not run again`,
		);
	}
}
