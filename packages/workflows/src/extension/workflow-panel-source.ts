import type { AgentPanelItem, AgentPanelSource, WorkflowRunControlOutcome } from "@bastani/atomic";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import { runStageIndex } from "../shared/run-stage-index.js";
import { readGraphStoreSnapshot } from "../shared/store-observation.js";
import type { StoreSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import {
	answerPanelRun,
	markWorkflowRunViewed,
	panelItemsFromSnapshot,
	panelRunId,
	stageTokens,
	usageTokens,
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
	let cachedSnapshot: StoreSnapshot | undefined;
	let cachedViewedRuns = new Set<string>();
	let cachedPendingSignature = "";
	let cachedItems: AgentPanelItem[] = [];
	const listeners = new Set<() => void>();
	let unsubscribeStore: (() => void) | undefined;
	const handleSubscriptions = new Map<StageControlHandle, () => void>();
	let notifyScheduled = false;

	const pendingTokensOf = (runId: string, stageId: string): number => {
		const handle = owner.stageControlRegistry.peek(runId, stageId);
		if (handle === undefined || handle.isDisposed === true) return 0;
		return usageTokens(handle.inFlightAttemptUsage?.());
	};

	const activePendingSignature = (snapshot: StoreSnapshot): string => {
		let signature = "";
		for (const run of snapshot.runs) {
			if (!owner.stageControlRegistry.has(run.id)) continue;
			if (run.endedAt !== undefined && run.resumable !== true && run.blockedAt === undefined) continue;
			const rawRun = owner.store.run(run.id);
			for (const stage of runStageIndex(run).unfinished) {
				const rawStage = rawRun?.stages.find((candidate) => candidate.id === stage.id);
				const recorded = rawStage === undefined ? 0 : stageTokens(rawStage);
				const pending = pendingTokensOf(run.id, stage.id);
				if (recorded > 0 || pending > 0) signature += `${run.id}:${stage.id}=${recorded}+${pending};`;
			}
		}
		return signature;
	};

	const notifyListeners = (): void => {
		for (const listener of [...listeners]) listener();
	};

	const scheduleHandleNotification = (): void => {
		if (notifyScheduled || listeners.size === 0) return;
		notifyScheduled = true;
		queueMicrotask(() => {
			notifyScheduled = false;
			if (listeners.size === 0) return;
			notifyListeners();
		});
	};

	const clearHandleSubscriptions = (): void => {
		for (const unsubscribe of handleSubscriptions.values()) unsubscribe();
		handleSubscriptions.clear();
	};

	const syncHandleSubscriptions = (snapshot: StoreSnapshot): void => {
		if (listeners.size === 0) {
			if (handleSubscriptions.size > 0) clearHandleSubscriptions();
			return;
		}
		const activeHandles = new Set<StageControlHandle>();
		for (const run of snapshot.runs) {
			if (!owner.stageControlRegistry.has(run.id)) continue;
			if (run.endedAt !== undefined && run.resumable !== true && run.blockedAt === undefined) continue;
			for (const stage of runStageIndex(run).unfinished) {
				const handle = owner.stageControlRegistry.peek(run.id, stage.id);
				if (handle === undefined || handle.isDisposed === true) continue;
				activeHandles.add(handle);
				if (!handleSubscriptions.has(handle)) {
					const unsubscribe = handle.subscribe(() => {
						scheduleHandleNotification();
					});
					handleSubscriptions.set(handle, unsubscribe);
				}
			}
		}
		for (const [handle, unsubscribe] of handleSubscriptions) {
			if (!activeHandles.has(handle)) {
				unsubscribe();
				handleSubscriptions.delete(handle);
			}
		}
	};

	return {
		items: () => {
			sampledAt = Date.now();
			const snapshot = readGraphStoreSnapshot(owner.store);
			syncHandleSubscriptions(snapshot);
			const viewedChanged =
				viewedRuns.size !== cachedViewedRuns.size || [...viewedRuns].some((id) => !cachedViewedRuns.has(id));
			const pendingSignature = activePendingSignature(snapshot);
			if (snapshot !== cachedSnapshot || viewedChanged || pendingSignature !== cachedPendingSignature) {
				const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
				cachedItems = panelItemsFromSnapshot(snapshot, sampledAt, viewedRuns, pendingTokensOf).map((item) => {
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
				cachedPendingSignature = pendingSignature;
			}
			return cachedItems;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			if (unsubscribeStore === undefined) {
				unsubscribeStore = owner.store.subscribeInvalidation(() => {
					syncHandleSubscriptions(readGraphStoreSnapshot(owner.store));
					notifyListeners();
				});
			}
			syncHandleSubscriptions(readGraphStoreSnapshot(owner.store));
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					unsubscribeStore?.();
					unsubscribeStore = undefined;
					clearHandleSubscriptions();
				}
			};
		},
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
