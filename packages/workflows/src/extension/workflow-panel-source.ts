import type { AgentPanelOpenOptions, AgentPanelSource, WorkflowRunControlOutcome } from "@bastani/atomic";
import { readGraphStoreSnapshot } from "../shared/store-observation.js";
import { panelItemsFromSnapshot, panelRunId } from "../tui/panel-runs.js";
import type { WorkflowOwnerResources } from "./workflow-owner-resources.js";
import { workflowAnswerAction } from "./workflow-tool-answer.js";

export interface WorkflowPanelSourceDeps {
	open(runId: string, options?: AgentPanelOpenOptions): void;
	quit(runId: string): Promise<WorkflowRunControlOutcome>;
}

export function workflowPanelSource(owner: WorkflowOwnerResources, deps: WorkflowPanelSourceDeps): AgentPanelSource {
	return {
		items: () => panelItemsFromSnapshot(readGraphStoreSnapshot(owner.store)),
		subscribe: (listener) => owner.store.subscribeInvalidation(listener),
		open: (id, options) => {
			const runId = panelRunId(id);
			if (runId !== undefined) deps.open(runId, options);
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
		answer: async (id, text) => {
			const runId = panelRunId(id);
			if (runId === undefined) return { ok: false, reason: "not a workflow run" };
			const result = await workflowAnswerAction({ action: "answer", runId, text }, owner);
			return result.status === "ok" ? { ok: true } : { ok: false, reason: result.message ?? result.status };
		},
	};
}
