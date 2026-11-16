import type { AgentPanelOpenOptions, AgentPanelSource, WorkflowRunControlOutcome } from "@bastani/atomic";
import { panelItemsFromSnapshot, panelRunId } from "../tui/panel-runs.js";
import type { WorkflowOwnerResources } from "./workflow-owner-resources.js";
import { workflowAnswerAction } from "./workflow-tool-answer.js";

/** What the panel source needs of the session beyond its runs: opening a graph and quitting a run. */
export interface WorkflowPanelSourceDeps {
	open(runId: string, options?: AgentPanelOpenOptions): void;
	quit(runId: string): Promise<WorkflowRunControlOutcome>;
}

/**
 * The session's workflow runs as items of the agent panel and `/tasks` (#5224): Enter opens a run's graph, `x x` quits
 * it (it stays resumable), and a waiting run's question is answered as `workflow answer` answers it.
 */
export function workflowPanelSource(owner: WorkflowOwnerResources, deps: WorkflowPanelSourceDeps): AgentPanelSource {
	return {
		items: () => panelItemsFromSnapshot(owner.store.runs()),
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
				// A quit run is paused and resumable: that is the stop the panel asked for. Only a partial quit failed.
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
