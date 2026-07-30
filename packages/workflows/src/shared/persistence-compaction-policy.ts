/**
 * Compaction policy: installs a `session_before_compact` hook to preserve
 * workflow state across pi's auto-compaction.
 *
 * When pi compacts the context window, in-flight run state would be lost
 * unless re-appended. This hook re-emits run.start (and pending stage.start)
 * entries for every active run so the next session sees them on restore.
 *
 * cross-ref: spec §5.6, §8.1 Phase D
 * cross-ref: pi-subagents fork-context children preservation pattern (upstream #147)
 */

import type { PersistenceAPI } from "./persistence-session-entries.js";
import { appendRunStart, appendStageStart } from "./persistence-session-entries.js";
import type { Store } from "./store.js";

// ---------------------------------------------------------------------------
// Compaction API structural type
// ---------------------------------------------------------------------------

/** Subset of the pi runtime API needed to install lifecycle hooks. */
export interface CompactionAPI {
	/** Register a listener for a pi lifecycle event. */
	on?: (event: string, handler: () => void | Promise<void>) => void;
}

// ---------------------------------------------------------------------------
// installCompactionHook
// ---------------------------------------------------------------------------

/**
 * Registers a `session_before_compact` handler.
 *
 * On compaction, re-appends `workflow.run.start` and `workflow.stage.start`
 * entries for every run that is still in-flight (no `endedAt`). This ensures
 * the next context window (post-compact) contains enough entries for
 * `restoreOnSessionStart` to detect and handle in-flight runs.
 *
 * Degrades gracefully if `api.on` is not available.
 */
export function installCompactionHook(api: CompactionAPI & PersistenceAPI, store: Store): void {
	if (typeof api.on !== "function") return;

	api.on("session_before_compact", () => {
		const runs = store.runs();
		const now = Date.now();

		for (const run of runs) {
			// Only preserve runs that haven't ended
			if (run.endedAt !== undefined) continue;

			appendRunStart(api, {
				runId: run.id,
				name: run.name,
				inputs: run.inputs,
				ts: run.startedAt ?? now,
			});

			for (const stage of run.stages) {
				// Re-append start for stages that haven't completed
				if (stage.endedAt !== undefined) continue;
				appendStageStart(api, {
					runId: run.id,
					stageId: stage.id,
					name: stage.name,
					parentIds: [...stage.parentIds],
					ts: stage.startedAt ?? now,
				});
			}
		}
	});
}
