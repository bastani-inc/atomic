import { type SessionStore, type SqliteDatabase, type SqliteExecutor, StorageProvider } from "@bastani/atomic/storage";
import { boundaryTransitionError } from "../boundary-lifecycle.js";
import { validateCheckpointInvocationFingerprint } from "../boundary-topology.js";
import { directChildTopologyError, sameRun, sameStrings } from "../stage-topology-validation.js";
import { DURABLE_TOOL_TOPOLOGY_VERSION, type DurableCheckpoint, type DurableStageCheckpoint } from "../types.js";
import { parseWorkflowChildResult } from "../workflow-child-result.js";
import type { SqlPoolStorage } from "./internal.js";
import type { PoolWork } from "./sql-pool-queue.js";
import { RUN_EVENT_TYPES } from "./types.js";

export type PoolSessionMutation = {
	readonly checkpoint: DurableStageCheckpoint;
	readonly entries: Parameters<SessionStore["create"]>[1];
} & (
	| { readonly kind: "session-create"; readonly header: Parameters<SessionStore["create"]>[0] }
	| { readonly kind: "session-append"; readonly expectSeq: number }
	| {
			readonly kind: "session-replace";
			readonly header: Parameters<SessionStore["create"]>[0];
			readonly expectSeq: number;
	  }
);
export type PoolMutation =
	| { readonly kind: "checkpoint"; readonly checkpoint: DurableCheckpoint }
	| PoolSessionMutation;

export async function validatePoolMutation(
	tx: SqliteExecutor,
	journal: SqlPoolStorage["tables"],
	root: string,
	work: PoolWork,
	mutation: PoolMutation,
): Promise<void> {
	if (!["checkpoint", "session-create", "session-append", "session-replace"].includes(mutation.kind))
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
	const rows = await tx.all(
		`SELECT payload FROM ${journal.events} WHERE run_id = ? AND type = ?`,
		root,
		RUN_EVENT_TYPES.checkpointRecorded,
	);
	const records = rows.map((row) => JSON.parse(String(row.payload)) as DurableCheckpoint);
	const stages = records.filter((entry): entry is DurableStageCheckpoint => entry.kind === "stage");
	const topology = checkpoint.topology;
	const run = topology?.run;
	if (!topology || !run || run.rootRunId !== root || run.runId === root)
		throw new Error("Pool topology scope mismatch");
	const owner = stages.find(
		(entry) => entry.topology?.boundary?.event === "start" && entry.topology.boundary.child.runId === run.runId,
	)?.topology?.boundary;
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
	if (checkpoint.kind === "tool") {
		const tool = checkpoint.topology!;
		const peers = records.filter(
			(entry): entry is Exclude<DurableCheckpoint, { kind: "ui" }> =>
				entry.kind !== "ui" && entry.topology?.run?.runId === run.runId,
		);
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
	const next = [...stages.filter((entry) => entry.checkpointId !== checkpoint.checkpointId), checkpoint];
	const tools = new Set(
		records.flatMap((entry) =>
			entry.kind === "tool" && entry.topology?.run?.runId === run.runId ? [entry.topology.nodeId] : [],
		),
	);
	const stageError = directChildTopologyError(next, owner.replayScope, run, tools);
	if (stageError) throw new Error(`Pool topology scope: ${stageError}`);
	const boundary = checkpoint.topology?.boundary;
	if (!boundary) {
		if (parseWorkflowChildResult(checkpoint.output)) throw new Error("Pool boundary output without ownership");
		return;
	}
	const start = next.find(
		(entry) => entry.replayKey === checkpoint.replayKey && entry.topology?.boundary?.event === "start",
	);
	const boundaryError = start ? boundaryTransitionError(start, next, false) : "missing start";
	if (
		!boundary.replayScope.startsWith(`${owner.replayScope}:`) ||
		boundary.child.runId === root ||
		boundary.child.runId === work.childRunId ||
		boundaryError
	)
		throw new Error(`Pool boundary scope: ${boundaryError ?? "invalid child"}`);
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
	mutation: PoolSessionMutation,
): Promise<number> {
	const { sessionId, replayKey } = mutation.checkpoint;
	if (!sessionId || mutation.checkpoint.sessionFile !== undefined)
		throw new Error("Pool sessions require database identity");
	const owners = `${prefix}session_owners`;
	if (mutation.kind === "session-create") {
		if (mutation.header.id !== sessionId) throw new Error("Pool session identity mismatch");
		await tx.run(`INSERT INTO ${owners} VALUES (?, ?, ?)`, sessionId, workId, replayKey);
	} else {
		const owner = await tx.get(`SELECT work, replay_key FROM ${owners} WHERE session = ?`, sessionId);
		if (owner?.work !== workId || owner.replay_key !== replayKey) throw new Error("Pool session scope mismatch");
	}
	const store = await sessionStore(tx, prefix);
	try {
		const result =
			mutation.kind === "session-create"
				? await store.create(mutation.header, mutation.entries)
				: mutation.kind === "session-append"
					? await store.append(sessionId, mutation.entries, { expectSeq: mutation.expectSeq })
					: await store.replace(sessionId, mutation.header, mutation.entries, { expectSeq: mutation.expectSeq });
		return result.lastSeq;
	} finally {
		await store.close();
	}
}
