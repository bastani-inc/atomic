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
import { subscribeStoreInvalidation } from "../shared/store-observation.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { workflowRunResumeCandidate } from "../shared/workflow-artifacts.js";
import type { WorkflowResumeRefresh } from "../tui/workflow-resume-selector.js";
import type { ExtensionRuntime } from "./runtime.js";
import { prepareWorkflowResumeCatalog } from "./workflow-durable-resume-command.js";
import { classifyDurableResumeShadow } from "./workflow-resume-shadow.js";

export interface ResumePickerLiveSource {
	readonly liveRuns: readonly RunSnapshot[];
	/** Live ids whose resumable durable duplicates must be suppressed. */
	readonly suppressedLiveIds: ReadonlySet<string>;
}

/** A live run is resumable when the shared predicate accepts it and the durable
 * backend has not explicitly deleted it. A live paused/quit run resumes through
 * its live stage controls, so it must NOT require a durable checkpoint here;
 * a restored snapshot that depends on durable state is filtered by its shadow
 * classification instead.
 */
function isResumableLiveRun(run: RunSnapshot): boolean {
	if (!getDurableBackend().isWorkflowLoadable(run.id)) return false;
	return isWorkflowRunResumable(workflowRunResumeCandidate(run));
}

export function collectResumePickerLiveRuns(runStore: Store): ResumePickerLiveSource {
	// `eligible` rows are re-listed from the durable catalog, and `ineligible`
	// rows have no durable checkpoint or pending prompt progress, so the resume
	// path would refuse them. Only `not_shadow` runs can actually be resumed here.
	const runs = topLevelWorkflowRuns(runStore.runs());
	const shadowClassification = new Map(runs.map((run) => [run.id, classifyDurableResumeShadow(run, runStore)]));
	const isOfferable = (run: RunSnapshot): boolean => shadowClassification.get(run.id) === "not_shadow";
	const resumableById = new Map(runs.map((run) => [run.id, isResumableLiveRun(run)]));
	const liveRuns = runs.filter((run) => isOfferable(run) && resumableById.get(run.id) === true);
	const isCurrentlyRunning = (run: RunSnapshot): boolean =>
		run.endedAt === undefined && run.status === "running" && run.exitReason !== "quit";
	const activeLiveIds = new Set(
		runs
			.filter(
				(run) =>
					shadowClassification.get(run.id) !== "eligible" &&
					isCurrentlyRunning(run) &&
					resumableById.get(run.id) !== true,
			)
			.map((run) => run.id),
	);
	// A non-running snapshot rejected by the shared predicate must not reappear as
	// a resumable durable row. Completed inspection rows remain visible separately.
	const rejectedLiveIds = new Set(
		runs.filter((run) => !isCurrentlyRunning(run) && resumableById.get(run.id) !== true).map((run) => run.id),
	);
	const suppressedLiveIds = new Set([...activeLiveIds, ...rejectedLiveIds]);
	return { liveRuns, suppressedLiveIds };
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
		watch: (onChange) => subscribeStoreInvalidation(runStore, onChange),
		refresh: async () => {
			const current = collectResumePickerLiveRuns(runStore);
			const catalog = await prepareWorkflowResumeCatalog(runtime, current.suppressedLiveIds);
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
