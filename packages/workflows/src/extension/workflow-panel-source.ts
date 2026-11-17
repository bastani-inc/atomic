import type { AgentPanelItem, AgentPanelSource, WorkflowRunControlOutcome } from "@bastani/atomic";
import { readGraphStoreSnapshot } from "../shared/store-observation.js";
import { elapsedRunMs } from "../shared/timing.js";
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
	let sampledAt = 0;
	let cachedSnapshot: ReturnType<typeof readGraphStoreSnapshot> | undefined;
	let cachedViewedRuns = new Set<string>();
	let cachedItems: AgentPanelItem[] = [];
	return {
		items: () => {
			sampledAt = Date.now();
			const snapshot = readGraphStoreSnapshot(owner.store);
			const viewedChanged =
				viewedRuns.size !== cachedViewedRuns.size || [...viewedRuns].some((id) => !cachedViewedRuns.has(id));
			if (snapshot !== cachedSnapshot || viewedChanged) {
				const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
				cachedItems = panelItemsFromSnapshot(snapshot, sampledAt, viewedRuns).map((item) => {
					if (item.state !== "running" && item.state !== "input" && item.state !== "stopping") return item;
					const id = panelRunId(item.id);
					const run = id === undefined ? undefined : runs.get(id);
					if (run === undefined) return item;
					return {
						...item,
						get elapsedMs() {
							return elapsedRunMs(run, item.endedAt ?? sampledAt);
						},
					};
				});
				cachedSnapshot = snapshot;
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
