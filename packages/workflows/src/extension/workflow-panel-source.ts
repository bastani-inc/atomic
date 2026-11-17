import type { AgentPanelSource, WorkflowRunControlOutcome } from "@bastani/atomic";
import { readGraphStoreSnapshot } from "../shared/store-observation.js";
import {
	answerPanelRun,
	markWorkflowRunViewed,
	panelItemsFromSnapshot,
	panelRunId,
	viewedWorkflowRuns,
} from "../tui/panel-runs.js";
import type { WorkflowOwnerResources } from "./workflow-owner-resources.js";

export interface WorkflowPanelSourceDeps {
	open: NonNullable<AgentPanelSource["open"]>;
	quit(runId: string): Promise<WorkflowRunControlOutcome>;
}

export function workflowPanelSource(owner: WorkflowOwnerResources, deps: WorkflowPanelSourceDeps): AgentPanelSource {
	const viewedRuns = viewedWorkflowRuns(owner.store);
	let cachedSnapshot: ReturnType<typeof readGraphStoreSnapshot> | undefined;
	let cachedSecond: number | undefined;
	let cachedViewedRuns = new Set<string>();
	let cachedItems: ReturnType<typeof panelItemsFromSnapshot> = [];
	return {
		items: () => {
			const snapshot = readGraphStoreSnapshot(owner.store);
			const now = Date.now();
			const second = Math.floor(now / 1_000);
			let viewedChanged = viewedRuns.size !== cachedViewedRuns.size;
			if (!viewedChanged) {
				for (const id of viewedRuns) {
					if (cachedViewedRuns.has(id)) continue;
					viewedChanged = true;
					break;
				}
			}
			if (snapshot !== cachedSnapshot || viewedChanged || second !== cachedSecond) {
				cachedItems = panelItemsFromSnapshot(snapshot, now, viewedRuns);
				cachedSnapshot = snapshot;
				cachedSecond = second;
				cachedViewedRuns = new Set(viewedRuns);
			}
			return cachedItems;
		},
		subscribe: (listener) => owner.store.subscribeInvalidation(listener),
		open: (id, options) => {
			const runId = panelRunId(id);
			if (runId === undefined) return false;
			if (deps.open(runId, options) === false) return false;
			markWorkflowRunViewed(runId, owner.store);
			return true;
		},
		stop: async (id) => {
			const runId = panelRunId(id);
			if (runId === undefined) return { ok: false, reason: "not a workflow run" };
			try {
				const outcome = await deps.quit(runId);
				return outcome.status === "partial" || outcome.status === "running"
					? { ok: false, reason: outcome.message }
					: { ok: true };
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) };
			}
		},
		answer: (id, text, options) => answerPanelRun(id, text, owner, options),
	};
}
