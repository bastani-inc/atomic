import type { DurableWorkflowBackend } from "../durable/backend.js";
import { GraphStoreSnapshotBuilder } from "./graph-store-snapshot.js";
import type { PromptAnswerRecord, RunEndMetadata, StoreInvalidationListener } from "./store-public-types.js";
import type {
	PendingPrompt,
	RunSnapshot,
	RunStatus,
	StageSnapshot,
	StageStatus,
	StoreSnapshot,
	WorkflowNotice,
} from "./store-types.js";
import { type WorkflowObservationChange, WorkflowObservationRuntime } from "./workflow-observation-runtime.js";
import { findSnapshotRun } from "./workflow-run-ownership.js";

/**
 * Statuses that represent a terminal run state — cannot be overwritten.
 *
 * Note on `"blocked"`: here it is an author-selected `ctx.exit({ status: "blocked" })`
 * outcome — terminal and non-resumable. This is deliberately distinct from retry-blocking,
 * which does NOT use this run status: `recordRunBlocked()` keeps `run.status = "running"`
 * and records the block via `blockedAt` / `failureDisposition: "active_blocked"` (resumable).
 * The two never collide despite the shared word.
 */
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
	"completed",
	"failed",
	"killed",
	"skipped",
	"cancelled",
	"blocked",
]);

/** Shared executor/store authority for terminal workflow lifecycle states. */
export function isTerminalRunStatus(status: RunStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

export interface ResolverEntry {
	readonly promptId: string;
	readonly resolve: (response: unknown) => void;
	readonly reject: (reason: unknown) => void;
}

export interface StoreState {
	readonly runs: RunSnapshot[];
	/**
	 * Position of each run in `runs` by id, so a lookup costs the same however many runs the store holds (#4182).
	 * Kept by the store's own mutations; a lookup that finds it out of step with `runs` rebuilds it.
	 */
	readonly runPositions: Map<string, number>;
	/** Ids of the runs by the run and boundary stage they hang from, so a run's children are found without a scan. */
	readonly childRunIds: Map<string, Map<string | undefined, Set<string>>>;
	/**
	 * The parent and stage each run is indexed under in `childRunIds`. Snapshots are stored by reference, so a run's
	 * own fields may already name a new link when the store replaces, relinks or removes it.
	 */
	readonly childRunLinks: Map<string, ChildRunLink>;
	readonly notices: WorkflowNotice[];
	readonly listeners: Set<(snap: StoreSnapshot) => void>;
	readonly invalidationListeners: Set<StoreInvalidationListener>;
	readonly resolvers: Map<string, ResolverEntry>;
	readonly stagePromptAnswers: Map<string, PromptAnswerRecord>;
	readonly stagePromptDrafts: Map<string, string>;
	version: number;
}

export interface StoreContext {
	backend?: DurableWorkflowBackend;
	readonly state: StoreState;
	readonly observation: WorkflowObservationRuntime;
	snapshot(): StoreSnapshot;
	graphSnapshot(): StoreSnapshot;
	graphRun(runId: string): RunSnapshot | undefined;
	/** `change` scopes observation to one run or node; pass it only when nothing outside it changed. */
	notify(change?: WorkflowObservationChange): void;
	/** Runs `update` with every invalidation it causes coalesced into one notification at its end. */
	batch<T>(update: () => T): T;
	/** `change` scopes observation to one run or node; pass it only when nothing outside it changed. */
	bumpAndNotify(change?: WorkflowObservationChange): void;
	findRun(runId: string): RunSnapshot | undefined;
	/** Position of the run in `state.runs`, or undefined when the store does not hold it. */
	runPosition(runId: string): number | undefined;
	childRuns(parentRunId: string, parentStageId?: string): readonly RunSnapshot[];
	reparentRun(run: RunSnapshot, parentStageId: string): void;
	/** Adds the run, or replaces the run with its id where it stands. */
	placeRun(run: RunSnapshot): void;
	/** Removes the run at `position` of `state.runs`. */
	removeRunAt(position: number): void;
	/** Drops every run. */
	clearRuns(): void;
	findStage(run: RunSnapshot, stageId: string): StageSnapshot | undefined;
	rejectPrompt(promptId: string, reason: string): void;
	rejectStagePrompt(runId: string, stage: StageSnapshot, reason: string): void;
	rejectAllStagePrompts(runId: string, run: RunSnapshot, reason: string): void;
	stagePromptAnswerKey(runId: string, stageId: string): string;
	stagePromptDraftKey(runId: string, stageId: string, promptId: string): string;
	stageHasActiveTextPrompt(runId: string, stageId: string, promptId: string): { prompt: PendingPrompt } | undefined;
}

export function isTerminalStageStatus(status: StageStatus): boolean {
	return status === "completed" || status === "failed" || status === "skipped";
}

export function cannotAwaitInput(status: StageStatus): boolean {
	return isTerminalStageStatus(status) || status === "paused" || status === "blocked";
}

export function cannotBlock(status: StageStatus): boolean {
	return isTerminalStageStatus(status) || status === "paused";
}

export function cannotPause(status: StageStatus): boolean {
	return isTerminalStageStatus(status) || status === "paused" || status === "blocked";
}

export function clearRunFailureMetadata(run: RunSnapshot): void {
	delete run.error;
	delete run.failureKind;
	delete run.failureCode;
	delete run.failureRecoverability;
	delete run.failureDisposition;
	delete run.failureMessage;
	delete run.failedStageId;
	delete run.failedToolNodeId;
	delete run.resumable;
	delete run.retryAfterMs;
	delete run.blockedAt;
	delete run.exited;
	delete run.exitReason;
}

export function clearStaleBlockedRunMetadata(run: RunSnapshot, metadata: RunEndMetadata | undefined): void {
	if (metadata?.failureKind === undefined) delete run.failureKind;
	if (metadata?.failureCode === undefined) delete run.failureCode;
	if (metadata?.failureRecoverability === undefined) delete run.failureRecoverability;
	if (metadata?.failureDisposition === undefined) delete run.failureDisposition;
	if (metadata?.failureMessage === undefined) delete run.failureMessage;
	if (metadata?.failedStageId === undefined) delete run.failedStageId;
	if (metadata?.failedToolNodeId === undefined) delete run.failedToolNodeId;
	if (metadata?.resumable === undefined) delete run.resumable;
	if (metadata?.retryAfterMs === undefined) delete run.retryAfterMs;
	if (metadata?.exited === undefined) delete run.exited;
	if (metadata?.exitReason === undefined) delete run.exitReason;
}

export function applyRunEndMetadata(run: RunSnapshot, metadata: RunEndMetadata): void {
	if (metadata.failureKind !== undefined) run.failureKind = metadata.failureKind;
	if (metadata.failureCode !== undefined) run.failureCode = metadata.failureCode;
	if (metadata.failureRecoverability !== undefined) run.failureRecoverability = metadata.failureRecoverability;
	if (metadata.failureDisposition !== undefined) run.failureDisposition = metadata.failureDisposition;
	if (metadata.retryAfterMs !== undefined) run.retryAfterMs = metadata.retryAfterMs;
	if (metadata.failureMessage !== undefined) run.failureMessage = metadata.failureMessage;
	if (metadata.failedStageId !== undefined) run.failedStageId = metadata.failedStageId;
	if (metadata.failedToolNodeId !== undefined) run.failedToolNodeId = metadata.failedToolNodeId;
	if (metadata.resumable !== undefined) run.resumable = metadata.resumable;
	if (metadata.exited !== undefined) run.exited = metadata.exited;
	if (metadata.exitReason !== undefined) run.exitReason = metadata.exitReason;
}

interface ChildRunLink {
	readonly parentRunId: string;
	readonly parentStageId: string | undefined;
}

export function createStoreState(): StoreState {
	return {
		runs: [],
		runPositions: new Map(),
		childRunIds: new Map(),
		childRunLinks: new Map(),
		notices: [],
		listeners: new Set(),
		invalidationListeners: new Set(),
		resolvers: new Map(),
		stagePromptAnswers: new Map(),
		stagePromptDrafts: new Map(),
		version: 0,
	};
}

/** Rebuilds the index from the list; a duplicated id keeps its first position, as a linear `find` would. */
function reindexRuns(state: StoreState): void {
	state.runPositions.clear();
	state.childRunIds.clear();
	state.childRunLinks.clear();
	state.runs.forEach((run, position) => {
		if (state.runPositions.has(run.id)) return;
		state.runPositions.set(run.id, position);
		indexChildRun(state, run);
	});
}

/** Indexes the run under the parent and stage it names now, dropping the link it was indexed under before. */
function indexChildRun(state: StoreState, run: RunSnapshot): void {
	unindexChildRun(state, run.id);
	if (run.parentRunId === undefined) return;
	const byStage = state.childRunIds.get(run.parentRunId) ?? new Map<string | undefined, Set<string>>();
	state.childRunIds.set(run.parentRunId, byStage);
	const ids = byStage.get(run.parentStageId) ?? new Set<string>();
	byStage.set(run.parentStageId, ids);
	ids.add(run.id);
	state.childRunLinks.set(run.id, { parentRunId: run.parentRunId, parentStageId: run.parentStageId });
}

function unindexChildRun(state: StoreState, runId: string): void {
	const link = state.childRunLinks.get(runId);
	if (link === undefined) return;
	state.childRunLinks.delete(runId);
	const byStage = state.childRunIds.get(link.parentRunId);
	const ids = byStage?.get(link.parentStageId);
	if (byStage === undefined || ids === undefined) return;
	ids.delete(runId);
	if (ids.size === 0) byStage.delete(link.parentStageId);
	if (byStage.size === 0) state.childRunIds.delete(link.parentRunId);
}

/**
 * Where the run with this id stands in `state.runs`. The index answers in constant time. The store's own methods keep
 * it in step with the list; a lookup that finds it out of step (a direct edit of the array `runs()` returns, which that
 * method documents as read-only) rebuilds it. A miss is trusted while the index and the list hold as many runs.
 */
function runPosition(state: StoreState, runId: string): number | undefined {
	const position = state.runPositions.get(runId);
	if (position !== undefined && state.runs[position]?.id === runId) return position;
	if (position === undefined && state.runPositions.size === state.runs.length) return undefined;
	reindexRuns(state);
	return state.runPositions.get(runId);
}

export function createStoreContext(state: StoreState = createStoreState()): StoreContext {
	let cachedGraphVersion = -1;
	let cachedGraphSnapshot: StoreSnapshot | undefined;
	const graphBuilder = new GraphStoreSnapshotBuilder();
	const observation = new WorkflowObservationRuntime(
		{ all: () => state.runs, find: findRun, position: (runId) => runPosition(state, runId) },
		bumpAndNotify,
	);

	function snapshot(): StoreSnapshot {
		return JSON.parse(
			JSON.stringify({ runs: state.runs, notices: state.notices, version: state.version }),
		) as StoreSnapshot;
	}

	function graphSnapshot(): StoreSnapshot {
		if (cachedGraphSnapshot === undefined || cachedGraphVersion !== state.version) {
			cachedGraphSnapshot = graphBuilder.build(state.runs, state.notices, state.version);
			cachedGraphVersion = state.version;
		}
		return cachedGraphSnapshot;
	}

	function graphRun(runId: string): RunSnapshot | undefined {
		if (cachedGraphSnapshot !== undefined && cachedGraphVersion === state.version)
			return findSnapshotRun(cachedGraphSnapshot.runs, runId);
		const run = findRun(runId);
		return run === undefined ? undefined : graphBuilder.buildRun(run);
	}

	let batchDepth = 0;
	let batchedNotification = false;
	/** Changes inside the open batch; undefined once any change was not scoped. */
	let batchedChanges: WorkflowObservationChange[] | undefined = [];

	function notify(change?: WorkflowObservationChange): void {
		graphBuilder.markChanged(change);
		if (batchDepth > 0) {
			batchedNotification = true;
			if (change === undefined) batchedChanges = undefined;
			else batchedChanges?.push(change);
			return;
		}
		const changes = change === undefined ? undefined : [change];
		observation.capture(changes);
		publish(changes);
	}

	/** `changes` names every run the invalidation changed, or is undefined when a change was not scoped to a run. */
	function publish(changes: readonly WorkflowObservationChange[] | undefined): void {
		for (const fn of state.invalidationListeners) {
			try {
				fn(changes);
			} catch {
				// One observer must not starve later observers or the snapshot channel.
			}
		}
		if (state.listeners.size > 0) {
			const snap = snapshot();
			for (const fn of state.listeners) {
				try {
					fn(snap);
				} catch {
					// Store mutations remain authoritative when a consumer fails.
				}
			}
		}
	}

	function bumpAndNotify(change?: WorkflowObservationChange): void {
		state.version++;
		notify(change);
	}

	function batch<T>(update: () => T): T {
		batchDepth++;
		try {
			return update();
		} finally {
			batchDepth--;
			if (batchDepth === 0 && batchedNotification) {
				const changes = batchedChanges;
				batchedNotification = false;
				batchedChanges = [];
				observation.capture(changes);
				publish(changes);
			}
		}
	}

	function findRun(runId: string): RunSnapshot | undefined {
		const position = runPosition(state, runId);
		return position === undefined ? undefined : state.runs[position];
	}

	function placeRun(run: RunSnapshot): void {
		const position = runPosition(state, run.id);
		if (position !== undefined) {
			state.runs[position] = run;
			indexChildRun(state, run);
			return;
		}
		state.runPositions.set(run.id, state.runs.length);
		state.runs.push(run);
		indexChildRun(state, run);
	}

	function removeRunAt(position: number): void {
		const [removed] = state.runs.splice(position, 1);
		if (removed === undefined) return;
		state.runPositions.delete(removed.id);
		unindexChildRun(state, removed.id);
		for (let index = position; index < state.runs.length; index++)
			state.runPositions.set(state.runs[index]!.id, index);
	}

	function clearRuns(): void {
		state.runs.length = 0;
		state.runPositions.clear();
		state.childRunIds.clear();
		state.childRunLinks.clear();
	}

	function childRuns(parentRunId: string, parentStageId?: string): readonly RunSnapshot[] {
		if (state.runPositions.size !== state.runs.length) reindexRuns(state);
		const byStage = state.childRunIds.get(parentRunId);
		if (byStage === undefined) return [];
		const ids =
			parentStageId === undefined
				? [...byStage.values()].flatMap((set) => [...set])
				: [...(byStage.get(parentStageId) ?? [])];
		return ids
			.map((id) => findRun(id))
			.filter(
				(run): run is RunSnapshot =>
					run !== undefined &&
					run.parentRunId === parentRunId &&
					(parentStageId === undefined || run.parentStageId === parentStageId),
			)
			.sort((left, right) => runPosition(state, left.id)! - runPosition(state, right.id)!);
	}

	function reparentRun(run: RunSnapshot, parentStageId: string): void {
		run.parentStageId = parentStageId;
		indexChildRun(state, run);
	}

	function findStage(run: RunSnapshot, stageId: string): StageSnapshot | undefined {
		return run.stages.find((s) => s.id === stageId);
	}

	function rejectPrompt(promptId: string, reason: string): void {
		const entry = state.resolvers.get(promptId);
		if (!entry) return;
		state.resolvers.delete(promptId);
		entry.reject(new Error(reason));
	}

	function stagePromptAnswerKey(runId: string, stageId: string): string {
		return JSON.stringify([runId, stageId]);
	}

	function stagePromptDraftKey(runId: string, stageId: string, promptId: string): string {
		return JSON.stringify([runId, stageId, promptId]);
	}

	function stageHasActiveTextPrompt(
		runId: string,
		stageId: string,
		promptId: string,
	): { prompt: PendingPrompt } | undefined {
		const run = findRun(runId);
		if (!run || TERMINAL_STATUSES.has(run.status)) return undefined;
		const stage = findStage(run, stageId);
		if (!stage || isTerminalStageStatus(stage.status)) return undefined;
		const prompt = stage.pendingPrompt;
		if (!prompt || prompt.id !== promptId) return undefined;
		if (prompt.kind !== "input" && prompt.kind !== "editor") return undefined;
		return { prompt };
	}

	function rejectStagePrompt(runId: string, stage: StageSnapshot, reason: string): void {
		const prompt = stage.pendingPrompt;
		if (!prompt) return;
		observation.lifecycle({ kind: "prompt", runId, stageId: stage.id, promptId: prompt.id, status: "cancelled" });
		stage.pendingPrompt = undefined;
		state.stagePromptDrafts.delete(stagePromptDraftKey(runId, stage.id, prompt.id));
		rejectPrompt(prompt.id, reason);
	}

	function rejectAllStagePrompts(runId: string, run: RunSnapshot, reason: string): void {
		for (const stage of run.stages) {
			rejectStagePrompt(runId, stage, reason);
		}
	}

	return {
		state,
		observation,
		snapshot,
		graphSnapshot,
		graphRun,
		notify,
		batch,
		bumpAndNotify,
		findRun,
		runPosition: (runId) => runPosition(state, runId),
		childRuns,
		reparentRun,
		placeRun,
		removeRunAt,
		clearRuns,
		findStage,
		rejectPrompt,
		rejectStagePrompt,
		rejectAllStagePrompts,
		stagePromptAnswerKey,
		stagePromptDraftKey,
		stageHasActiveTextPrompt,
	};
}
