/**
 * Row sources for the `/workflow resume` picker.
 *
 * Only inactive workflows belong in the resume selector. Live runs contribute
 * paused (quit) or recoverably-failed rows; actively-running live runs are
 * hidden because resuming an executing workflow would double-dispatch it.
 * The same collection backs the picker's live refresh (store changes plus a
 * bounded cross-session poll), so state transitions appear while it is open.
 */

import { getDurableBackend } from "../durable/factory.js";
import { isWorkflowRunResumable } from "../durable/resume-eligibility.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowResumeRefresh } from "../tui/workflow-resume-selector.js";
import type { ExtensionRuntime } from "./runtime.js";
import { prepareWorkflowResumeCatalog } from "./workflow-durable-resume-command.js";
import { classifyDurableResumeShadow } from "./workflow-resume-shadow.js";

export interface ResumePickerLiveSource {
	readonly liveRuns: readonly RunSnapshot[];
	readonly activeLiveIds: ReadonlySet<string>;
}

/** Snapshot-derived paused/blocked state, shared by every predicate call here. */
function hasPausedState(run: RunSnapshot): boolean {
	return (
		run.status === "paused" ||
		run.exitReason === "quit" ||
		run.stages.some((stage) => stage.status === "paused" || stage.status === "blocked")
	);
}

/**
 * A live run is resumable when the shared predicate accepts it and the durable
 * backend has not explicitly deleted it. A live paused/quit run resumes through
 * its live stage controls, so it must NOT require a durable checkpoint here;
 * a restored snapshot that depends on durable state is filtered by its shadow
 * classification instead.
 */
function isResumableLiveRun(run: RunSnapshot): boolean {
	if (!getDurableBackend().isWorkflowLoadable(run.id)) return false;
	return isWorkflowRunResumable({ ...run, hasPausedState: hasPausedState(run) });
}

export function collectResumePickerLiveRuns(runStore: Store): ResumePickerLiveSource {
	// `eligible` rows are re-listed from the durable catalog, and `ineligible`
	// rows have no durable checkpoint or pending prompt progress, so the resume
	// path would refuse them. Only `not_shadow` runs can actually be resumed here.
	const shadowClassification = new Map(
		topLevelWorkflowRuns(runStore.runs()).map((run) => [run.id, classifyDurableResumeShadow(run, runStore)]),
	);
	const isOfferable = (run: RunSnapshot): boolean => shadowClassification.get(run.id) === "not_shadow";
	const liveRuns = topLevelWorkflowRuns(runStore.runs()).filter((run) => isOfferable(run) && isResumableLiveRun(run));
	const activeLiveIds = new Set(
		topLevelWorkflowRuns(runStore.runs())
			.filter(
				(run) =>
					shadowClassification.get(run.id) !== "eligible" &&
					run.endedAt === undefined &&
					run.status === "running" &&
					!isWorkflowRunResumable({ ...run, hasPausedState: hasPausedState(run) }) &&
					run.exitReason !== "quit",
			)
			.map((run) => run.id),
	);
	return { liveRuns, activeLiveIds };
}

export interface ResumePickerLiveUpdateOptions {
	readonly watch: (onChange: () => void) => () => void;
	readonly refresh: WorkflowResumeRefresh;
}

export function resumePickerLiveUpdateOptions(
	runStore: Store,
	runtime: ExtensionRuntime,
): ResumePickerLiveUpdateOptions {
	return {
		watch: (onChange) => runStore.subscribe(() => onChange()),
		refresh: async () => {
			const current = collectResumePickerLiveRuns(runStore);
			const catalog = await prepareWorkflowResumeCatalog(runtime, current.activeLiveIds);
			return {
				liveRuns: current.liveRuns,
				catalog: { durable: catalog.resumable, completed: catalog.completed },
			};
		},
	};
}

export interface ResumePickerCatalogRows {
	readonly durable: readonly ResumableWorkflowEntry[];
	readonly completed: readonly ResumableWorkflowEntry[];
}
