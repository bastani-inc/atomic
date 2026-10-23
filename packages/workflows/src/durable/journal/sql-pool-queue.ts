import { randomUUID } from "node:crypto";
import { assertStorageSchemaVersion, type SqliteExecutor, type SqliteRow } from "@bastani/atomic/storage";
import { assertWorkflowSerializableObject } from "../../shared/serializable.js";
import type { WorkflowSerializableObject } from "../../shared/types.js";
import { validateCheckpointInvocationFingerprint } from "../boundary-topology.js";
import { durableHash } from "../durable-hash.js";
import {
	DURABLE_BOUNDARY_TOPOLOGY_VERSION,
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableStageCheckpoint,
} from "../types.js";
import { type SqlPoolStorage, sqlPoolStorage } from "./internal.js";
import { isWorkflowLeaseExpired } from "./lease-expiry.js";
import { applyPoolSession, type PoolMutation, validatePoolMutation } from "./pool-mutations.js";
import { type Lease, RUN_EVENT_TYPES, type RunJournal, StaleLeaseError } from "./types.js";
import { journalCounter, serializeJson, validateText } from "./values.js";

export type { PoolMutation } from "./pool-mutations.js";

type Transaction = SqlPoolStorage["transaction"];
type JournalTables = SqlPoolStorage["tables"];
const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
export interface PoolWorkDescriptor {
	readonly boundaryId: string;
	readonly childRunId: string;
	readonly scope: string;
	readonly definition: string;
	readonly digest: string;
	readonly inputs: WorkflowSerializableObject;
	readonly execution: WorkflowSerializableObject;
}
export interface PoolWork extends PoolWorkDescriptor {
	readonly id: string;
	readonly state: "ready" | "leased";
	readonly generation: number;
	readonly worker: string | null;
	readonly epoch: number;
	readonly expiresAt: number;
	readonly renewedAt: number;
}
type WorkRow = SqliteRow & {
	id: string;
	root: string;
	descriptor: string;
	state: PoolWork["state"];
	generation: number;
	worker: string | null;
	epoch: number;
	expires_at: number;
	renewed_at: number;
	fingerprint: string;
};
type WorkLease = Pick<PoolWork, "id" | "generation" | "worker" | "epoch">;
export interface PoolCommitReceipt {
	readonly seq: number;
	readonly at: number;
	readonly lastSeq?: number;
}
function fromRow(row: WorkRow): PoolWork {
	return {
		...JSON.parse(row.descriptor),
		id: row.id,
		state: row.state,
		generation: Number(row.generation),
		worker: row.worker,
		epoch: Number(row.epoch),
		expiresAt: Number(row.expires_at),
		renewedAt: Number(row.renewed_at),
	};
}
function positive(value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Pool duration must be a positive safe integer");
}
function snapshotLease(lease: Lease): Lease {
	validateText("runId", lease.runId);
	validateText("holderId", lease.holderId);
	return { ...lease };
}

function expiry(now: number, duration: number): number {
	const expiresAt = now + duration;
	positive(expiresAt);
	return expiresAt;
}

export class SqlPoolQueue {
	private readonly meta: string;
	private readonly roots: string;
	private readonly work: string;
	private readonly operations: string;
	private readonly transaction: Transaction;
	private readonly journal: JournalTables;
	private constructor(transaction: Transaction, journal: JournalTables) {
		this.transaction = transaction;
		this.journal = journal;
		this.meta = `${journal.runs}_pool_meta`;
		this.roots = `${journal.runs}_pool`;
		this.work = `${journal.runs}_work`;
		this.operations = `${journal.runs}_pool_operations`;
	}
	static async open(transaction: Transaction, journal: JournalTables): Promise<SqlPoolQueue> {
		const pool = new SqlPoolQueue(transaction, journal);
		await transaction(async (tx) => {
			if ((await tx.get("PRAGMA foreign_keys"))?.foreign_keys !== 1)
				throw new Error("Pool requires SQLite foreign keys");
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${pool.meta}(version INTEGER NOT NULL)`);
			const versions = await tx.all(`SELECT version FROM ${pool.meta}`);
			if (versions.length > 1) throw new Error("Corrupt pool schema metadata");
			if (versions.length === 0) await tx.run(`INSERT INTO ${pool.meta} VALUES (1)`);
			else assertStorageSchemaVersion("journal", versions[0]!.version!, 1);
			await tx.exec(`
				CREATE TABLE IF NOT EXISTS ${pool.roots}(root TEXT PRIMARY KEY REFERENCES ${journal.runs}(run_id) ON DELETE CASCADE, timeout INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS ${pool.work}(
					id TEXT PRIMARY KEY, root TEXT NOT NULL REFERENCES ${pool.roots}(root) ON DELETE CASCADE,
					boundary TEXT NOT NULL, descriptor TEXT NOT NULL, fingerprint TEXT NOT NULL,
					state TEXT NOT NULL DEFAULT 'ready', generation INTEGER NOT NULL DEFAULT 0,
					worker TEXT, epoch INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0,
					renewed_at INTEGER NOT NULL DEFAULT 0,
					ready_at INTEGER NOT NULL, UNIQUE(root, boundary)
				);
				CREATE INDEX IF NOT EXISTS ${pool.work}_ready ON ${pool.work}(root, state, ready_at);
				CREATE INDEX IF NOT EXISTS ${pool.work}_expiry ON ${pool.work}(state, expires_at);
				CREATE TABLE IF NOT EXISTS ${pool.journal.runs}_pool_session_owners(
					session TEXT PRIMARY KEY, work TEXT NOT NULL REFERENCES ${pool.work}(id) ON DELETE CASCADE, replay_key TEXT NOT NULL
				);
				CREATE UNIQUE INDEX IF NOT EXISTS ${pool.work}_scope ON ${pool.work}(root, json_extract(descriptor, '$.scope'));
				CREATE UNIQUE INDEX IF NOT EXISTS ${pool.work}_child ON ${pool.work}(root, json_extract(descriptor, '$.childRunId'));
				CREATE TABLE IF NOT EXISTS ${pool.operations}(
					work TEXT NOT NULL REFERENCES ${pool.work}(id) ON DELETE CASCADE,
					generation INTEGER NOT NULL, operation TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(work, generation, operation)
				);
			`);
		});
		return pool;
	}
	private async authority(
		tx: SqliteExecutor,
		lease: Lease,
		timeout?: number,
	): Promise<{ now: number; status: string }> {
		const row = await tx.get<
			SqliteRow & {
				epoch: number;
				holder_id: string;
				renewed_at: number;
				now: number;
				status: string;
				timeout: number | null;
			}
		>(
			`SELECT l.*, r.status, p.timeout, ${STORE_NOW} AS now FROM ${this.journal.leases} l JOIN ${this.journal.runs} r ON r.run_id = l.run_id LEFT JOIN ${this.roots} p ON p.root = l.run_id WHERE l.run_id = ?`,
			lease.runId,
		);
		if (row?.timeout === null && timeout === undefined) throw new Error("Pool not initialized");
		if (
			!row ||
			row.epoch !== lease.epoch ||
			row.holder_id !== lease.holderId ||
			isWorkflowLeaseExpired(row.renewed_at, row.timeout ?? timeout ?? 0, row.now)
		)
			throw new StaleLeaseError(lease.runId, lease.epoch, Number(row?.epoch ?? 0));
		return row;
	}
	async initialize(lease: Lease, coordinatorTimeoutMs: number): Promise<void> {
		positive(coordinatorTimeoutMs);
		lease = snapshotLease(lease);
		await this.transaction(async (tx) => {
			await this.authority(tx, lease, coordinatorTimeoutMs);
			await tx.run(
				`INSERT INTO ${this.roots} VALUES (?, ?) ON CONFLICT(root) DO NOTHING`,
				lease.runId,
				coordinatorTimeoutMs,
			);
			const row = await tx.get(`SELECT timeout FROM ${this.roots} WHERE root = ?`, lease.runId);
			if (row?.timeout !== coordinatorTimeoutMs) throw new Error("Pool configuration is immutable");
		});
	}
	async enqueue(lease: Lease, descriptor: PoolWorkDescriptor, boundary: DurableStageCheckpoint): Promise<PoolWork> {
		lease = snapshotLease(lease);
		const { boundaryId, childRunId, scope } = descriptor;
		const topology = boundary.topology;
		const child = topology?.boundary?.child;
		if (
			boundary.kind !== "stage" ||
			boundary.workflowId !== lease.runId ||
			boundary.checkpointId !== `boundary-start:${descriptor.scope}` ||
			topology?.stageId !== boundaryId ||
			topology.sourceOrder === undefined ||
			topology.version !== DURABLE_STAGE_TOPOLOGY_VERSION ||
			topology.status !== "running" ||
			topology.boundary?.version !== DURABLE_BOUNDARY_TOPOLOGY_VERSION ||
			topology.boundary.status !== "running" ||
			topology.run?.runId !== lease.runId ||
			topology.boundary?.event !== "start" ||
			child?.runId !== descriptor.childRunId ||
			child.rootRunId !== lease.runId ||
			child.parentStageId !== boundaryId ||
			child.parentRunId !== boundary.workflowId ||
			boundary.replayKey !== descriptor.scope ||
			topology.boundary.replayScope !== descriptor.scope
		)
			throw new Error("Pool boundary identity mismatch");
		for (const value of [
			descriptor.boundaryId,
			descriptor.childRunId,
			descriptor.scope,
			descriptor.definition,
			descriptor.digest,
		])
			validateText("key", value);
		assertWorkflowSerializableObject(descriptor.inputs, "Pool inputs");
		assertWorkflowSerializableObject(descriptor.execution, "Pool execution");
		assertWorkflowSerializableObject(boundary, "Pool boundary");
		validateCheckpointInvocationFingerprint(boundary);
		const json = serializeJson({ ...descriptor });
		const payload = serializeJson(boundary);
		const fingerprint = durableHash({ descriptor: JSON.parse(json), boundary: JSON.parse(payload) });
		const key = JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, boundary.kind, boundary.checkpointId]);
		return this.transaction(async (tx) => {
			const { now } = await this.authority(tx, lease);
			const previous = await tx.get<WorkRow>(
				`SELECT * FROM ${this.work} WHERE root = ? AND (boundary = ? OR json_extract(descriptor, '$.scope') = ? OR json_extract(descriptor, '$.childRunId') = ?)`,
				lease.runId,
				boundaryId,
				scope,
				childRunId,
			);
			if (previous) {
				if (previous.fingerprint !== fingerprint) throw new Error("Pool boundary identity conflict");
				return fromRow(previous);
			}
			const siblings = await tx.all<SqliteRow & { scope: string }>(
				`SELECT json_extract(descriptor, '$.scope') AS scope FROM ${this.work} WHERE root = ?`,
				lease.runId,
			);
			if (siblings.some((item) => scope.startsWith(`${item.scope}:`) || item.scope.startsWith(`${scope}:`)))
				throw new Error("Pool work scopes overlap");
			const id = randomUUID();
			await tx.run(
				`INSERT INTO ${this.work}(id, root, boundary, descriptor, fingerprint, ready_at) VALUES (?, ?, ?, ?, ?, ?)`,
				id,
				lease.runId,
				boundaryId,
				json,
				fingerprint,
				now,
			);
			const seq = await tx.get<SqliteRow & { seq: number }>(
				`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${this.journal.events} WHERE run_id = ?`,
				lease.runId,
			);
			await tx.run(
				`INSERT INTO ${this.journal.events} VALUES (?, ?, ?, ?, ?, ?, ?)`,
				lease.runId,
				journalCounter(lease.runId, "seq", Number(seq!.seq) + 1, "overflow"),
				lease.epoch,
				key,
				RUN_EVENT_TYPES.checkpointRecorded,
				payload,
				now,
			);
			return fromRow((await tx.get<WorkRow>(`SELECT * FROM ${this.work} WHERE id = ?`, id))!);
		});
	}
	async claim(
		lease: Lease,
		worker: string,
		definitions: readonly Pick<PoolWorkDescriptor, "definition" | "digest">[],
		durationMs: number,
	): Promise<PoolWork | undefined> {
		positive(durationMs);
		lease = snapshotLease(lease);
		const compatibleDefinitions = definitions.flatMap((d) => [d.definition, d.digest]);
		validateText("holderId", worker);
		const compatible = definitions
			.map(() => "(json_extract(descriptor, '$.definition') = ? AND json_extract(descriptor, '$.digest') = ?)")
			.join(" OR ");
		return this.transaction(async (tx) => {
			const { now, status } = await this.authority(tx, lease);
			if (status !== "running" || compatibleDefinitions.length === 0) return undefined;
			const row = await tx.get<WorkRow>(
				`SELECT * FROM ${this.work} WHERE root = ? AND state = 'ready' AND ready_at <= ? AND (${compatible}) ORDER BY ready_at, rowid LIMIT 1`,
				lease.runId,
				now,
				...compatibleDefinitions,
			);
			if (!row) return undefined;
			const generation = journalCounter(lease.runId, "epoch", Number(row.generation) + 1, "overflow");
			await tx.run(
				`UPDATE ${this.work} SET state = 'leased', generation = ?, worker = ?, epoch = ?, expires_at = ?, renewed_at = ? WHERE id = ? AND state = 'ready' AND generation = ?`,
				generation,
				worker,
				lease.epoch,
				expiry(now, durationMs),
				now,
				row.id,
				row.generation,
			);
			return fromRow((await tx.get<WorkRow>(`SELECT * FROM ${this.work} WHERE id = ?`, row.id))!);
		});
	}
	private async current(tx: SqliteExecutor, lease: Lease, token: WorkLease): Promise<WorkRow> {
		const row = await tx.get<WorkRow>(`SELECT * FROM ${this.work} WHERE id = ? AND root = ?`, token.id, lease.runId);
		if (
			row?.state !== "leased" ||
			row.epoch !== token.epoch ||
			row.generation !== token.generation ||
			row.worker !== token.worker
		)
			throw new Error("Stale work lease");
		return row;
	}
	async renew(lease: Lease, token: WorkLease, operationId: string, durationMs: number): Promise<PoolWork> {
		positive(durationMs);
		lease = snapshotLease(lease);
		token = { ...token };
		validateText("key", operationId);
		const request = JSON.stringify([token.epoch, token.generation, token.worker, durationMs]);
		return this.transaction(async (tx) => {
			const { now } = await this.authority(tx, lease);
			const row = await this.current(tx, lease, token);
			if (row.epoch !== lease.epoch || row.expires_at < now) throw new Error("Stale work lease");
			const previous = await tx.get<SqliteRow & { request: string; receipt: string }>(
				`SELECT * FROM ${this.operations} WHERE work = ? AND generation = ? AND operation = ?`,
				token.id,
				token.generation,
				operationId,
			);
			if (previous) {
				if (previous.request !== request) throw new Error("Pool operation identity conflict");
				return JSON.parse(previous.receipt) as PoolWork;
			}
			const receipt = {
				...fromRow(row),
				expiresAt: Math.max(Number(row.expires_at), expiry(now, durationMs)),
				renewedAt: now,
			};
			await tx.run(
				`UPDATE ${this.work} SET expires_at = ?, renewed_at = ? WHERE id = ?`,
				receipt.expiresAt,
				now,
				row.id,
			);
			await tx.run(
				`INSERT INTO ${this.operations} VALUES (?, ?, ?, ?, ?)`,
				row.id,
				token.generation,
				operationId,
				request,
				JSON.stringify(receipt),
			);
			return receipt;
		});
	}
	async commit(
		lease: Lease,
		token: WorkLease,
		operationId: string,
		mutation: PoolMutation,
	): Promise<PoolCommitReceipt> {
		lease = snapshotLease(lease);
		token = { ...token };
		validateText("key", operationId);
		assertWorkflowSerializableObject(mutation, "Pool mutation");
		const request = serializeJson({ epoch: token.epoch, worker: token.worker, mutation });
		mutation = JSON.parse(request).mutation as PoolMutation;
		return this.transaction(async (tx) => {
			const { now, status } = await this.authority(tx, lease);
			const row = await this.current(tx, lease, token);
			if (row.epoch !== lease.epoch) throw new Error("Stale work lease");
			const previous = await tx.get<SqliteRow & { request: string; receipt: string }>(
				`SELECT * FROM ${this.operations} WHERE work = ? AND generation = ? AND operation = ?`,
				token.id,
				token.generation,
				operationId,
			);
			if (previous) {
				if (previous.request !== request) throw new Error("Pool operation identity conflict");
				return JSON.parse(previous.receipt) as PoolCommitReceipt;
			}
			if (row.expires_at < now) throw new Error("Stale work lease");
			if (status !== "running") throw new Error("Pool root is not running");
			const checkpoint = mutation.checkpoint;
			await validatePoolMutation(tx, this.journal, lease.runId, fromRow(row), mutation);
			if (checkpoint.completedAt > now) throw new Error("Pool checkpoint timestamp is in the future");
			assertWorkflowSerializableObject(checkpoint, "Pool checkpoint");
			const key = JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, checkpoint.kind, checkpoint.checkpointId]);
			const payload = serializeJson(checkpoint);
			const existing = await tx.get<SqliteRow & { seq: number; at: number; payload: string }>(
				`SELECT seq, at, payload FROM ${this.journal.events} WHERE run_id = ? AND key = ?`,
				lease.runId,
				key,
			);
			if (existing && existing.payload !== payload) throw new Error("Pool checkpoint identity conflict");
			if (existing && mutation.kind !== "checkpoint") throw new Error("Pool session checkpoint identity conflict");
			const lastSeq =
				mutation.kind === "checkpoint"
					? undefined
					: await applyPoolSession(tx, `${this.journal.runs}_pool_`, row.id, mutation);
			const latest = await tx.get<SqliteRow & { seq: number }>(
				`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${this.journal.events} WHERE run_id = ?`,
				lease.runId,
			);
			const receipt = existing
				? { seq: Number(existing.seq), at: Number(existing.at) }
				: {
						seq: journalCounter(lease.runId, "seq", Number(latest!.seq) + 1, "overflow"),
						at: now,
						...(lastSeq === undefined ? {} : { lastSeq }),
					};
			if (!existing)
				await tx.run(
					`INSERT INTO ${this.journal.events} VALUES (?, ?, ?, ?, ?, ?, ?)`,
					lease.runId,
					receipt.seq,
					lease.epoch,
					key,
					RUN_EVENT_TYPES.checkpointRecorded,
					payload,
					now,
				);
			await tx.run(
				`INSERT INTO ${this.operations} VALUES (?, ?, ?, ?, ?)`,
				token.id,
				token.generation,
				operationId,
				request,
				JSON.stringify(receipt),
			);
			return receipt;
		});
	}
	async expire(lease: Lease, token: WorkLease): Promise<boolean> {
		lease = snapshotLease(lease);
		token = { ...token };
		return this.transaction(async (tx) => {
			const { now } = await this.authority(tx, lease);
			const row = await this.current(tx, lease, token);
			if (row.epoch === lease.epoch && row.expires_at >= now) return false;
			await tx.run(`UPDATE ${this.work} SET state = 'ready', worker = NULL, expires_at = 0 WHERE id = ?`, row.id);
			return true;
		});
	}
	async inspect(root: string): Promise<readonly PoolWork[]> {
		return this.transaction(async (tx) =>
			(await tx.all<WorkRow>(`SELECT * FROM ${this.work} WHERE root = ? ORDER BY ready_at, rowid`, root)).map(
				fromRow,
			),
		);
	}
}

export function openSqlPoolQueue(journal: RunJournal): Promise<SqlPoolQueue> {
	const storage = sqlPoolStorage(journal);
	if (!storage) return Promise.reject(new Error("Worker pool requires a SQL run journal"));
	return SqlPoolQueue.open(storage.transaction, storage.tables);
}
