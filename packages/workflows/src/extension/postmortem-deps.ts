/**
 * Extension-side wiring for the shared post-mortem stage-chat resolver.
 *
 * Builds `PostMortemStageChatDeps` from live extension runtime surfaces
 * (stage adapters, durable per-run cwd, and the default stage session dir after
 * a host restart) so the TUI attach pane can revive an
 * eligible terminal agent stage through the same detached, single-flight
 * resolver instead of process-local handle presence alone.
 *
 * cross-ref:
 *   - src/runs/foreground/postmortem-stage-chat.ts (resolver)
 *   - src/tui/overlay-adapter.ts (attach pane wiring)
 * */

import type { WorktreeRootMapping } from "@bastani/atomic";
import { readDurableCheckpoints } from "../durable/backend.js";
import { availableStoreDurableBackend, requireStoreDurableBackend } from "../durable/store-backend.js";
import {
	type EnsurePostMortemStageHandleResult,
	ensurePostMortemStageHandle,
	type PostMortemAdmission,
	type PostMortemStageChatDeps,
} from "../runs/foreground/postmortem-stage-chat.js";
import {
	beginStageRegistrationCheck,
	type StageControlRegistry,
	stageControlRegistry,
} from "../runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import { ownsStageRecord, stageRecordOwner } from "../shared/stage-record-owner.js";
import { currentStageUiBroker, type StageUiBroker } from "../shared/stage-ui-broker.js";
import { type Store, store } from "../shared/store.js";
import { readGraphStoreRun, readGraphStoreSnapshot } from "../shared/store-observation.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { failedBoundaryChildRuns } from "../shared/workflow-run-ownership.js";

export interface PostMortemResolverDeps {
	readonly adapters: StageAdapters;
	readonly resolveDefaultStageSessionDir: () => string | undefined;
	/** The owning session's store; defaults to the current one. */
	readonly store?: Store;
	/** The owning session's stage-control registry; defaults to the current one. */
	readonly stageControlRegistry?: StageControlRegistry;
	readonly stageUiBroker?: StageUiBroker;
}

/** Persisted original/resolved cwd for a durable run tree, when still available. */
function resolveStageCwd(runId: string, runStore: Store): string | undefined {
	try {
		const backend = requireStoreDurableBackend(runStore, runId);
		const owningHandle = backend.getWorkflow(runId);
		const run = readGraphStoreSnapshot(runStore).runs.find((candidate) => candidate.id === runId);
		const rootRunId = run?.rootRunId ?? owningHandle?.rootWorkflowId;
		const cwdHandle = rootRunId === undefined ? owningHandle : (backend.getWorkflow(rootRunId) ?? owningHandle);
		return cwdHandle?.workflowCwd ?? cwdHandle?.invocationCwd ?? undefined;
	} catch {
		return undefined;
	}
}

/** The restores the root of `runId`'s run tree recorded, which every stage of the tree follows. */
function resolveRunWorktreeRootMappings(runId: string, runStore: Store): readonly WorktreeRootMapping[] | undefined {
	const backend = availableStoreDurableBackend(runStore, runId);
	if (backend === undefined) return undefined;
	const owningHandle = backend.getWorkflow(runId);
	const rootRunId = readGraphStoreRun(runStore, runId)?.rootRunId ?? owningHandle?.rootWorkflowId ?? runId;
	return (backend.getWorkflow(rootRunId) ?? owningHandle)?.worktreeRootMappings;
}

/** Resolver deps for a specific run, keyed so revived handles use the real run cwd. */
export function postMortemDepsForRun(runId: string, deps: PostMortemResolverDeps): PostMortemStageChatDeps {
	return {
		registry: deps.stageControlRegistry ?? stageControlRegistry,
		store: deps.store ?? store,
		// An explicitly supplied store and adapter need not share the interactive session's broker.
		stageUiBroker: deps.stageUiBroker ?? (deps.store === undefined ? currentStageUiBroker() : undefined),
		adapters: deps.adapters,
		sessionStore: deps.adapters.sessionStore,
		cwd: resolveStageCwd(runId, deps.store ?? store),
		defaultSessionDir: deps.resolveDefaultStageSessionDir(),
		worktreeRootMappings: resolveRunWorktreeRootMappings(runId, deps.store ?? store),
		pooledSessionStore: async () => {
			const runStore = deps.store ?? store;
			const backend = requireStoreDurableBackend(runStore, runId);
			// A pooled stage's run is usually a child the backend has no handle for: its pool is the one of the root of its
			// run tree, found where that root's placement keeps it (#4357).
			const root =
				readGraphStoreRun(runStore, runId)?.rootRunId ?? backend.getWorkflow(runId)?.rootWorkflowId ?? runId;
			const { poolSessionStore } = await import("../workers/pool-session-store.js");
			return poolSessionStore(backend, root, backend.getWorkflow(root)?.resources);
		},
	};
}

/**
 * Build a `(runId, stageId) => result | undefined` resolver for the attach pane.
 * Unknown stages return `undefined`; known but non-revivable stages retain the
 * resolver's explicit reason so the pane can explain why chat is unavailable.
 */
export function createPostMortemHandleResolver(
	deps: PostMortemResolverDeps,
): (
	runId: string,
	stageId: string,
	admission?: PostMortemAdmission,
) => Promise<EnsurePostMortemStageHandleResult | undefined> {
	return async (requestedRunId, requestedStageId, admission) => {
		const snapshot = readGraphStoreSnapshot(deps.store ?? store);
		const requested = snapshot.runs
			.find((candidate) => candidate.id === requestedRunId)
			?.stages.find((candidate) => candidate.id === requestedStageId);
		if (requested === undefined) return undefined;
		// A failed boundary's id can still name its pooled child's one stage for post-mortem chat (#3996).
		const pooledChild = failedBoundaryPooledStage(snapshot.runs, requestedRunId, requested);
		const runId = pooledChild?.runId ?? requestedRunId;
		const stageId = pooledChild?.stage.id ?? requestedStageId;
		const run = snapshot.runs.find((candidate) => candidate.id === runId);
		const found = pooledChild?.stage ?? requested;
		// A stage on a local worker whose run ended without settling it (its pool gave up on the
		// child) failed with its run; its retained session reopens like any failed pooled stage (#3996).
		const root =
			run?.rootRunId === undefined ? undefined : snapshot.runs.find((candidate) => candidate.id === run.rootRunId);
		const pooledEnded =
			found.workerExecution !== undefined &&
			(run?.endedAt !== undefined || root?.endedAt !== undefined) &&
			found.status !== "completed" &&
			found.status !== "failed" &&
			found.status !== "skipped";
		// A fenced attempt's stage loses its live session id in the store; its last session is still
		// recorded on the stage's session checkpoints in the journal.
		const runStore = deps.store ?? store;
		const currentRecord = () => runStore.run(runId)?.stages.find((candidate) => candidate.id === stageId);
		const record = currentRecord();
		const owner = record && stageRecordOwner(record);
		let sessionId = found.sessionId;
		if (sessionId === undefined && found.workerExecution !== undefined) {
			const check = beginStageRegistrationCheck(deps.stageControlRegistry ?? stageControlRegistry, runId);
			try {
				sessionId = await pooledStageSessionId(runStore, snapshot.runs, runId, stageId);
				if (!check.current()) return { ok: false, reason: "closed" };
			} finally {
				check.release();
			}
		}
		const stage = {
			...found,
			...(pooledEnded ? { status: "failed" as const } : {}),
			...(sessionId === undefined ? {} : { sessionId }),
		};
		if (!ownsStageRecord(owner, currentRecord())) return { ok: false, reason: "closed" };
		return ensurePostMortemStageHandle(runId, stage, postMortemDepsForRun(runId, deps), admission);
	};
}

/**
 * The last session a stage on a local worker committed, from its session checkpoints. A pooled root keeps only its own
 * checkpoints in memory, so they are read from the scope of the root's child the stage ran under (#4318).
 */
async function pooledStageSessionId(
	runStore: Store,
	runs: readonly RunSnapshot[],
	runId: string,
	stageId: string,
): Promise<string | undefined> {
	const backend = availableStoreDurableBackend(runStore, runId);
	if (backend === undefined) return undefined;
	const root = runs.find((candidate) => candidate.id === runId)?.rootRunId ?? runId;
	let sessionId: string | undefined;
	for (const checkpoint of await readDurableCheckpoints(backend, root, rootChildScope(runs, root, runId)))
		if (
			checkpoint.kind === "stage" &&
			checkpoint.sessionId !== undefined &&
			checkpoint.topology?.stageId === stageId &&
			checkpoint.topology.run?.runId === runId
		)
			sessionId = checkpoint.sessionId;
	return sessionId;
}

/** The replay key of the root boundary `runId` runs under, at any depth, or undefined when the store cannot tell. */
function rootChildScope(runs: readonly RunSnapshot[], root: string, runId: string): string | undefined {
	const byId = new Map(runs.map((run) => [run.id, run]));
	let child = byId.get(runId);
	for (const seen = new Set<string>(); child !== undefined && child.parentRunId !== root; ) {
		if (child.parentRunId === undefined || seen.has(child.id)) return undefined;
		seen.add(child.id);
		child = byId.get(child.parentRunId);
	}
	return byId.get(root)?.stages.find((stage) => stage.id === child?.parentStageId)?.replayKey;
}

/** The one stage of a failed boundary's child run that ran on a local worker, if there is exactly one. */
function failedBoundaryPooledStage(
	runs: readonly RunSnapshot[],
	runId: string,
	boundary: StageSnapshot,
): { readonly runId: string; readonly stage: StageSnapshot } | undefined {
	if (boundary.status !== "failed") return undefined;
	const children = failedBoundaryChildRuns(runs, runId, boundary.id, boundary);
	const pooled = children.flatMap((run) =>
		run.stages.filter((stage) => stage.workerExecution !== undefined).map((stage) => ({ runId: run.id, stage })),
	);
	return pooled.length === 1 ? pooled[0] : undefined;
}
