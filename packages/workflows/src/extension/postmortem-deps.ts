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

import { requireStoreDurableBackend } from "../durable/store-backend.js";
import {
	type EnsurePostMortemStageHandleResult,
	ensurePostMortemStageHandle,
	type PostMortemStageChatDeps,
} from "../runs/foreground/postmortem-stage-chat.js";
import { type StageControlRegistry, stageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import { type Store, store } from "../shared/store.js";
import { readGraphStoreSnapshot } from "../shared/store-observation.js";

export interface PostMortemResolverDeps {
	readonly adapters: StageAdapters;
	readonly resolveDefaultStageSessionDir: () => string | undefined;
	/** The owning session's store; defaults to the current one. */
	readonly store?: Store;
	/** The owning session's stage-control registry; defaults to the current one. */
	readonly stageControlRegistry?: StageControlRegistry;
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

/** Resolver deps for a specific run, keyed so revived handles use the real run cwd. */
export function postMortemDepsForRun(runId: string, deps: PostMortemResolverDeps): PostMortemStageChatDeps {
	return {
		registry: deps.stageControlRegistry ?? stageControlRegistry,
		adapters: deps.adapters,
		sessionStore: deps.adapters.sessionStore,
		cwd: resolveStageCwd(runId, deps.store ?? store),
		defaultSessionDir: deps.resolveDefaultStageSessionDir(),
		pooledSessionStore: async () => {
			const backend = requireStoreDurableBackend(deps.store ?? store, runId);
			const { poolSessionStore } = await import("../workers/pool-session-store.js");
			return poolSessionStore(backend);
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
): (runId: string, stageId: string) => Promise<EnsurePostMortemStageHandleResult | undefined> {
	return async (runId, stageId) => {
		const snapshot = readGraphStoreSnapshot(deps.store ?? store);
		const run = snapshot.runs.find((candidate) => candidate.id === runId);
		const found = run?.stages.find((candidate) => candidate.id === stageId);
		if (found === undefined) return undefined;
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
		const sessionId =
			found.sessionId ??
			(found.workerExecution === undefined ? undefined : pooledStageSessionId(deps.store ?? store, runId, stageId));
		const stage = {
			...found,
			...(pooledEnded ? { status: "failed" as const } : {}),
			...(sessionId === undefined ? {} : { sessionId }),
		};
		return ensurePostMortemStageHandle(runId, stage, postMortemDepsForRun(runId, deps));
	};
}

/** The last session a stage on a local worker committed, from its session checkpoints. */
function pooledStageSessionId(runStore: Store, runId: string, stageId: string): string | undefined {
	try {
		const backend = requireStoreDurableBackend(runStore, runId);
		const run = readGraphStoreSnapshot(runStore).runs.find((candidate) => candidate.id === runId);
		const root = run?.rootRunId ?? runId;
		let sessionId: string | undefined;
		for (const checkpoint of backend.listCheckpoints(root))
			if (
				checkpoint.kind === "stage" &&
				checkpoint.sessionId !== undefined &&
				checkpoint.topology?.stageId === stageId &&
				checkpoint.topology.run?.runId === runId
			)
				sessionId = checkpoint.sessionId;
		return sessionId;
	} catch {
		return undefined;
	}
}
