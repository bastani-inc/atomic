import {
	type ResumePreconditionError,
	type RunWorktreeTarget,
	runRestorePreconditionError,
	type WorktreeRootMapping,
	type WorktreeSnapshotSettingsInput,
	worktreeNeedsRestore,
} from "@bastani/atomic";
import type { RunJournal } from "./journal/types.js";
import {
	listWorkflowSnapshotBoundaries,
	mapWorkflowWorktreePath,
	workflowSnapshotFrontier,
} from "./worktree-snapshots.js";

/** Marks a run's options once its resume checked the restore preconditions, so `run()` does not check them again. */
export const restorePreconditionsChecked = Symbol("restore-preconditions-checked");

/**
 * The typed failure of resuming run `runId` on this node when restoring the checkouts its latest snapshots recorded,
 * and that are gone or changed here, could not complete: Git is unavailable, or a snapshot has dependency inputs and no
 * setup hook could run. Read-only, so it can run before anything is claimed or restored.
 */
export async function runRestorePreconditionFailure(
	journal: RunJournal,
	runId: string,
	mappings: readonly WorktreeRootMapping[],
	settings: WorktreeSnapshotSettingsInput | undefined,
	signal?: AbortSignal,
): Promise<ResumePreconditionError | undefined> {
	const restoring: RunWorktreeTarget[] = [];
	for (const boundary of workflowSnapshotFrontier(await listWorkflowSnapshotBoundaries(journal, runId))) {
		const here = mapWorkflowWorktreePath(boundary.root, mappings);
		if (await worktreeNeedsRestore(boundary.snapshot, here, { settings, signal })) {
			restoring.push({ root: boundary.root, envHash: boundary.snapshot.envHash });
		}
	}
	return await runRestorePreconditionError(runId, restoring);
}
