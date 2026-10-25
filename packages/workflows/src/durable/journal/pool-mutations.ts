import { type SessionStore, type SqliteDatabase, type SqliteExecutor, StorageProvider } from "@bastani/atomic/storage";
import { boundaryTransitionError } from "../boundary-lifecycle.js";
import { validateCheckpointInvocationFingerprint } from "../boundary-topology.js";
import { directChildTopologyError, durableStageGroupKey, sameRun, sameStrings } from "../stage-topology-validation.js";
import { DURABLE_TOOL_TOPOLOGY_VERSION, type DurableCheckpoint, type DurableStageCheckpoint } from "../types.js";
import { parseWorkflowChildResult } from "../workflow-child-result.js";
import type { SqlPoolStorage } from "./internal.js";
import { type IndexedStage, inKeyOrder, type PoolCheckpointRead } from "./pool-checkpoint-index.js";
import type { PoolWork } from "./sql-pool-queue.js";

/** Creating or replacing a pool session binds it to its stage with one checkpoint. */
export type PoolSessionMutation = {
	readonly checkpoint: DurableStageCheckpoint;
	readonly entries: Parameters<SessionStore["create"]>[1];
} & (
	| { readonly kind: "session-create"; readonly header: Parameters<SessionStore["create"]>[0] }
	| {
			readonly kind: "session-replace";
			readonly header: Parameters<SessionStore["create"]>[0];
			readonly expectSeq: number;
	  }
);
/**
 * Appending to a pool session journals no checkpoint: the session's owner row, written when it was created, binds
 * it to the work and stage, so an append carries only the entries.
 */
export interface PoolSessionAppend {
	readonly kind: "session-append";
	readonly sessionId: string;
	readonly entries: Parameters<SessionStore["append"]>[1];
	readonly expectSeq: number;
}
export type PoolCheckpointMutation =
	| { readonly kind: "checkpoint"; readonly checkpoint: DurableCheckpoint }
	| PoolSessionMutation;
export type PoolMutation = PoolCheckpointMutation | PoolSessionAppend;

/**
 * Validate one pool checkpoint mutation against the root's recorded checkpoints. Only the checkpoints the checks
 * can consult are read from the index: those of the mutated child run, its owning boundary start, its stage groups,
 * and the boundary records related to a boundary transition, in the order a scan of every checkpoint returns them.
 */
export async function validatePoolMutation(
	tx: SqliteExecutor,
	journal: SqlPoolStorage["tables"],
	root: string,
	work: PoolWork,
	mutation: PoolCheckpointMutation,
	checkpoints: PoolCheckpointRead,
): Promise<void> {
	if (!["checkpoint", "session-create", "session-replace"].includes(mutation.kind))
		throw new Error("Invalid pool mutation");
	const checkpoint = mutation.checkpoint;
	const prefix = `${work.scope}:`;
	const key =
		checkpoint.kind === "tool"
			? checkpoint.argsHash
			: checkpoint.kind === "ui"
				? checkpoint.promptHash
				: checkpoint.kind === "stage"
					? checkpoint.replayKey
					: "";
	if (checkpoint.workflowId !== root || !checkpoint.checkpointId.startsWith(prefix) || !key.startsWith(prefix))
		throw new Error("Pool checkpoint scope mismatch");
	validateCheckpointInvocationFingerprint(checkpoint);
	if (checkpoint.kind === "stage" && checkpoint.sessionFile !== undefined)
		throw new Error("Pool sessions require database identity");
	if (mutation.kind !== "checkpoint" && checkpoint.kind !== "stage") throw new Error("Invalid pool session mutation");
	if (mutation.kind === "checkpoint" && checkpoint.kind === "stage" && checkpoint.sessionId) {
		const owner = await tx.get(
			`SELECT work, replay_key FROM ${journal.runs}_pool_session_owners WHERE session = ?`,
			checkpoint.sessionId,
		);
		if (owner?.work !== work.id || owner.replay_key !== checkpoint.replayKey)
			throw new Error("Pool session scope mismatch");
	}
	if (checkpoint.kind === "ui") return;
	const view = await checkpoints.read(tx, journal.events);
	const topology = checkpoint.topology;
	const run = topology?.run;
	if (!topology || !run || run.rootRunId !== root || run.runId === root)
		throw new Error("Pool topology scope mismatch");
	const owner = inKeyOrder(view.entries("startsByChild", run.runId))[0]?.topology?.boundary;
	if (
		!owner ||
		!sameRun(run, owner.child) ||
		!key.startsWith(`${owner.replayScope}:`) ||
		!checkpoint.checkpointId.startsWith(`${owner.replayScope}:`) ||
		!(owner.replayScope === work.scope || owner.replayScope.startsWith(prefix))
	)
		throw new Error("Pool topology scope mismatch");
	if (
		mutation.kind !== "checkpoint" &&
		"header" in mutation &&
		mutation.header.workflow &&
		(mutation.header.workflow.runId !== run.runId ||
			mutation.header.workflow.stageId !== ("stageId" in topology ? topology.stageId : undefined))
	)
		throw new Error("Pool session scope mismatch");
	const runEntries = view.entries("byRun", run.runId);
	if (checkpoint.kind === "tool") {
		const tool = checkpoint.topology!;
		const peers = runEntries.map((entry) => entry.checkpoint);
		const ids = new Set(
			peers.map((entry) => (entry.kind === "tool" ? entry.topology!.nodeId : entry.topology!.stageId)),
		);
		if (
			tool.version !== DURABLE_TOOL_TOPOLOGY_VERSION ||
			!tool.nodeId ||
			tool.parentIds.some((id) => id === tool.nodeId || !ids.has(id)) ||
			peers.some((entry) =>
				entry.kind === "tool"
					? entry.argsHash === checkpoint.argsHash
						? entry.topology!.nodeId !== tool.nodeId || !sameStrings(entry.topology!.parentIds, tool.parentIds)
						: entry.topology!.nodeId === tool.nodeId
					: entry.topology!.stageId === tool.nodeId,
			)
		)
			throw new Error("Pool tool topology scope mismatch");
		return;
	}
	// Every recorded stage either check can reach: the run's own stages and every stage sharing one of their groups.
	const runStages = runEntries.filter((entry): entry is IndexedStage => entry.checkpoint.kind === "stage");
	const relevant: IndexedStage[] = [...runStages];
	const groups = new Set(
		[...runStages.map((entry) => entry.checkpoint), checkpoint]
			.filter((entry) => entry === checkpoint || entry.checkpointId !== checkpoint.checkpointId)
			.map(durableStageGroupKey),
	);
	for (const group of groups) relevant.push(...view.entries("stagesByGroup", group));
	const boundary = checkpoint.topology?.boundary;
	let start: DurableStageCheckpoint | undefined;
	if (boundary) {
		const replayed = view.entries("stagesByReplayKey", checkpoint.replayKey);
		start = [...stagesExcept(replayed, checkpoint), checkpoint].find(
			(entry) => entry.replayKey === checkpoint.replayKey && entry.topology?.boundary?.event === "start",
		);
		relevant.push(...replayed);
		if (start) {
			const startTopology = start.topology!;
			relevant.push(...view.entries("boundariesByStageId", startTopology.stageId));
			relevant.push(...view.entries("boundariesByChild", startTopology.boundary!.child.runId));
		}
	}
	const next = [...stagesExcept(relevant, checkpoint), checkpoint];
	const tools = new Set(
		runEntries.flatMap((entry) => (entry.checkpoint.kind === "tool" ? [entry.checkpoint.topology!.nodeId] : [])),
	);
	const stageError = directChildTopologyError(next, owner.replayScope, run, tools);
	if (stageError) throw new Error(`Pool topology scope: ${stageError}`);
	if (!boundary) {
		if (parseWorkflowChildResult(checkpoint.output)) throw new Error("Pool boundary output without ownership");
		return;
	}
	const boundaryError = start ? boundaryTransitionError(start, next, false) : "missing start";
	if (
		!boundary.replayScope.startsWith(`${owner.replayScope}:`) ||
		boundary.child.runId === root ||
		boundary.child.runId === work.childRunId ||
		boundaryError
	)
		throw new Error(`Pool boundary scope: ${boundaryError ?? "invalid child"}`);
}

/** Recorded stages in key order, without the one `checkpoint` records again. */
function stagesExcept(entries: readonly IndexedStage[], checkpoint: DurableStageCheckpoint): DurableStageCheckpoint[] {
	return inKeyOrder(entries).filter((entry) => entry.checkpointId !== checkpoint.checkpointId);
}

async function sessionStore(tx: SqliteExecutor, prefix: string): Promise<SessionStore> {
	const database: SqliteDatabase = {
		descriptor: { adapter: "pool-transaction", location: prefix },
		exec: (sql) => tx.exec(sql),
		run: (sql, ...params) => tx.run(sql, ...params),
		get: (sql, ...params) => tx.get(sql, ...params),
		all: (sql, ...params) => tx.all(sql, ...params),
		transaction: (body) => body(tx),
		close: async () => {},
	};
	return new StorageProvider().openSessionStore(
		{ kind: "database", database, prefix },
		{ agentDir: "", domain: "sessions" },
	);
}

export async function applyPoolSession(
	tx: SqliteExecutor,
	prefix: string,
	workId: string,
	mutation: PoolSessionMutation | PoolSessionAppend,
): Promise<number> {
	const owners = `${prefix}session_owners`;
	if (mutation.kind === "session-append") {
		if (typeof mutation.sessionId !== "string" || mutation.sessionId === "")
			throw new Error("Pool sessions require database identity");
		const owner = await tx.get(`SELECT work FROM ${owners} WHERE session = ?`, mutation.sessionId);
		if (owner?.work !== workId) throw new Error("Pool session scope mismatch");
		return withSessionStore(tx, prefix, (store) =>
			store.append(mutation.sessionId, mutation.entries, { expectSeq: mutation.expectSeq }),
		);
	}
	const { sessionId, replayKey } = mutation.checkpoint;
	if (!sessionId || mutation.checkpoint.sessionFile !== undefined)
		throw new Error("Pool sessions require database identity");
	if (mutation.kind === "session-create") {
		if (mutation.header.id !== sessionId) throw new Error("Pool session identity mismatch");
		await tx.run(`INSERT INTO ${owners} VALUES (?, ?, ?)`, sessionId, workId, replayKey);
	} else {
		const owner = await tx.get(`SELECT work, replay_key FROM ${owners} WHERE session = ?`, sessionId);
		if (owner?.work !== workId || owner.replay_key !== replayKey) throw new Error("Pool session scope mismatch");
	}
	return withSessionStore(tx, prefix, (store) =>
		mutation.kind === "session-create"
			? store.create(mutation.header, mutation.entries)
			: store.replace(sessionId, mutation.header, mutation.entries, { expectSeq: mutation.expectSeq }),
	);
}

async function withSessionStore(
	tx: SqliteExecutor,
	prefix: string,
	write: (store: SessionStore) => Promise<{ readonly lastSeq: number }>,
): Promise<number> {
	const store = await sessionStore(tx, prefix);
	try {
		return (await write(store)).lastSeq;
	} finally {
		await store.close();
	}
}
