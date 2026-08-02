import { topLevelWorkflowRuns } from "./run-visibility.js";
import type { RunSnapshot } from "./store-types.js";

const SHORT_RUN_ID_LENGTH = 6;

/**
 * Format the compact run identity shown beside a human-input prompt.
 *
 * The widget uses six run-id characters, so prompt attribution uses that same
 * prefix. Attribution is intentionally absent unless more than one active
 * top-level run exists; single-run prompt output remains unchanged.
 */
export function formatPromptAttribution(
	originRunId: string | undefined,
	allRuns: readonly RunSnapshot[],
): string | undefined {
	const activeTopLevelRuns = topLevelWorkflowRuns(allRuns).filter((run) => run.endedAt === undefined);
	if (activeTopLevelRuns.length <= 1 || originRunId === undefined) return undefined;

	const origin = allRuns.find((run) => run.id === originRunId);
	if (origin === undefined) return undefined;
	const root = rootRun(origin, allRuns);
	const shortId = root.id.length > SHORT_RUN_ID_LENGTH ? root.id.slice(0, SHORT_RUN_ID_LENGTH) : root.id;
	return `${shortId} ${root.name}`;
}

function rootRun(run: RunSnapshot, allRuns: readonly RunSnapshot[]): RunSnapshot {
	if (run.parentRunId === undefined) return run;
	if (run.rootRunId !== undefined) {
		const root = allRuns.find((candidate) => candidate.id === run.rootRunId);
		if (root !== undefined) return root;
	}

	let current = run;
	const visited = new Set<string>();
	while (current.parentRunId !== undefined && !visited.has(current.id)) {
		visited.add(current.id);
		const parent = allRuns.find((candidate) => candidate.id === current.parentRunId);
		if (parent === undefined) break;
		current = parent;
	}
	return current;
}
