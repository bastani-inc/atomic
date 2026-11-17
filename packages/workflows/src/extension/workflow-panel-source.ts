import type { AgentPanelOpenOptions, AgentPanelSource, WorkflowRunControlOutcome } from "@bastani/atomic";
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
	open(runId: string, options?: AgentPanelOpenOptions): void;
	quit(runId: string): Promise<WorkflowRunControlOutcome>;
}

export function workflowPanelSource(owner: WorkflowOwnerResources, deps: WorkflowPanelSourceDeps): AgentPanelSource {
	const viewedRuns = viewedWorkflowRuns(owner.store);
	return {
		items: () => panelItemsFromSnapshot(readGraphStoreSnapshot(owner.store), Date.now(), viewedRuns),
		subscribe: (listener) => owner.store.subscribeInvalidation(listener),
		open: (id, options) => {
			const runId = panelRunId(id);
			if (runId === undefined) return false;
			markWorkflowRunViewed(runId, owner.store);
			deps.open(runId, options);
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
