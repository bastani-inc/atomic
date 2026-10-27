import { createHash, randomUUID } from "node:crypto";
import { assertStorageSchemaVersion, type SqliteExecutor, type SqliteRow, StorageError } from "@bastani/atomic/storage";
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
import { PoolCheckpointIndex, type PoolCheckpointRead } from "./pool-checkpoint-index.js";
import {
	applyPoolSession,
	type PoolCheckpointMutation,
	type PoolMutation,
	type PoolSessionAppend,
	validatePoolMutation,
} from "./pool-mutations.js";
import { poolCheckpointUsage, poolUsageSchema, upsertPoolUsage } from "./pool-stage-usage.js";
import { JournalError, type Lease, RUN_EVENT_TYPES, type RunJournal, StaleLeaseError } from "./types.js";
import { journalCounter, serializeJson, validateText } from "./values.js";

export type { PoolMutation } from "./pool-mutations.js";

type Transaction = SqlPoolStorage["transaction"];
type JournalTables = SqlPoolStorage["tables"];
const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const MAX_WORKER_CLOCK_SKEW_MS = 1_000;
/** Version 2 keeps no lease renewal rows and stores a digest, not the full request, per pool operation. */
const POOL_SCHEMA_VERSION = 2;
export const STALE_WORK_LEASE = "Stale work lease";

/**
 * A pool delivery receipt refused because its attempt no longer owns the work or the stage session. It is a
 * journal error, so the root's journal backend passes it on with its own message instead of reporting the refusal
 * as unavailable storage, and the message is what a worker receives across the process boundary.
 */
export class PoolAppendRefusedError extends JournalError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PoolAppendRefusedError";
	}
}

/** A retried operation must repeat its request exactly; its digest is enough to prove that. */
function requestIdentity(request: string): string {
	return createHash("sha256").update(request).digest("hex");
}
export interface PoolControl {
	readonly state: "running" | "paused" | "quit";
	readonly revision: number;
}
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
	readonly state: "ready" | "leased" | "completed";
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
	/** Journal sequence of the recorded checkpoint; absent for a session append, which journals none. */
	readonly seq?: number;
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
	private readonly checkpoints = new PoolCheckpointIndex();
	private constructor(private readonly storage: SqlPoolStorage) {
		const { transaction, tables: journal } = storage;
		this.transaction = transaction;
		this.journal = journal;
		this.meta = `${journal.runs}_pool_meta`;
		this.roots = `${journal.runs}_pool`;
		this.work = `${journal.runs}_work`;
		this.operations = `${journal.runs}_pool_operations`;
	}
	static async open(storage: SqlPoolStorage): Promise<SqlPoolQueue> {
		const journal = storage.tables;
		const pool = new SqlPoolQueue(storage);
		await storage.transaction(async (tx) => {
			if ((await tx.get("PRAGMA foreign_keys"))?.foreign_keys !== 1)
				throw new Error("Pool requires SQLite foreign keys");
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${pool.meta}(version INTEGER NOT NULL)`);
			const versions = await tx.all(`SELECT version FROM ${pool.meta}`);
			if (versions.length > 1) throw new Error("Corrupt pool schema metadata");
			const version = versions[0]?.version;
			if (version === undefined) await tx.run(`INSERT INTO ${pool.meta} VALUES (?)`, POOL_SCHEMA_VERSION);
			else if (version !== 1) assertStorageSchemaVersion("journal", version, POOL_SCHEMA_VERSION);
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
				CREATE TABLE IF NOT EXISTS ${pool.work}_results(
					work TEXT PRIMARY KEY REFERENCES ${pool.work}(id) ON DELETE CASCADE, result TEXT NOT NULL
				);
			`);
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${pool.roots}_control(
				root TEXT PRIMARY KEY REFERENCES ${pool.roots}(root) ON DELETE CASCADE,
				state TEXT NOT NULL DEFAULT 'running', revision INTEGER NOT NULL DEFAULT 0
			)`);
			await tx.exec(poolUsageSchema(journal.runs));
			if (version === 1) await pool.migrateFromVersion1(tx);
		});
		return pool;
	}
	/**
	 * Version 1 stored every lease renewal as an operation row whose receipt was the full work descriptor, and every
	 * commit's full request (entries included) for retry identity. Renewals need no row at all, and a retry only needs
	 * the request's digest, so drop the renewal rows and keep a digest of each remaining request.
	 */
	private async migrateFromVersion1(tx: SqliteExecutor): Promise<void> {
		await tx.run(`DELETE FROM ${this.operations} WHERE substr(request, 1, 1) = '['`);
		for (let after = 0; ; ) {
			const rows = await tx.all<SqliteRow & { rowid: number; request: string }>(
				`SELECT rowid, request FROM ${this.operations} WHERE rowid > ? ORDER BY rowid LIMIT 256`,
				after,
			);
			if (rows.length === 0) break;
			for (const row of rows)
				await tx.run(
					`UPDATE ${this.operations} SET request = ? WHERE rowid = ?`,
					requestIdentity(String(row.request)),
					row.rowid,
				);
			after = Number(rows.at(-1)!.rowid);
		}
		await tx.run(`UPDATE ${this.meta} SET version = ?`, POOL_SCHEMA_VERSION);
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
	async control(lease: Lease): Promise<PoolControl> {
		return this.transaction(async (tx) => {
			await this.authority(tx, lease);
			const row = await tx.get(`SELECT state, revision FROM ${this.roots}_control WHERE root = ?`, lease.runId);
			return row
				? { state: row.state as PoolControl["state"], revision: Number(row.revision) }
				: { state: "running", revision: 0 };
		});
	}
	async setControl(lease: Lease, state: PoolControl["state"]): Promise<PoolControl> {
		return this.transaction(async (tx) => {
			await this.authority(tx, lease);
			await tx.run(
				`INSERT INTO ${this.roots}_control(root, state, revision) VALUES (?, ?, 1)
				ON CONFLICT(root) DO UPDATE SET state = excluded.state, revision = revision + (state != excluded.state)`,
				lease.runId,
				state,
			);
			const row = (await tx.get(`SELECT revision FROM ${this.roots}_control WHERE root = ?`, lease.runId))!;
			return { state, revision: Number(row.revision) };
		});
	}
	withCurrentAppend<T>(
		lease: Lease,
		token: WorkLease,
		assertSession: () => void,
		action: () => Promise<T>,
	): Promise<T> {
		lease = snapshotLease(lease);
		token = { ...token };
		return this.storage.withAppendGuard(async (tx, runId) => {
			try {
				if (runId !== lease.runId) throw new Error("Pool delivery cannot write another root");
				await this.authority(tx, lease).catch((error: Error) => {
					if (error instanceof StaleLeaseError)
						throw new Error("Stale pool coordinator authority", { cause: error });
					throw error;
				});
				// The attempt's identity fences it, not the clock: a lapsed lease whose worker is alive stays current
				// until the coordinator extends it, and only reassignment or an epoch change replaces it (#3888).
				const row = await this.current(tx, lease, token);
				if (row.epoch !== lease.epoch) throw new Error(STALE_WORK_LEASE);
				assertSession();
			} catch (error) {
				if (error instanceof JournalError || error instanceof StorageError || !(error instanceof Error))
					throw error;
				throw new PoolAppendRefusedError(error.message, { cause: error });
			}
		}, action);
	}

	async assertCurrent(lease: Lease, token: WorkLease): Promise<void> {
		await this.transaction(async (tx) => {
			const { now } = await this.authority(tx, lease);
			const row = await this.current(tx, lease, token);
			if (row.epoch !== lease.epoch || row.expires_at < now) throw new Error(STALE_WORK_LEASE);
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
				if (previous.state !== "ready" || previous.epoch === lease.epoch) return fromRow(previous);
				// Work of an earlier incarnation becomes claimable again once this root enqueues it (#3979).
				await tx.run(`UPDATE ${this.work} SET epoch = ? WHERE id = ?`, lease.epoch, previous.id);
				return fromRow({ ...previous, epoch: lease.epoch });
			}
			const siblings = await tx.all<SqliteRow & { scope: string }>(
				`SELECT json_extract(descriptor, '$.scope') AS scope FROM ${this.work} WHERE root = ?`,
				lease.runId,
			);
			if (siblings.some((item) => scope.startsWith(`${item.scope}:`) || item.scope.startsWith(`${scope}:`)))
				throw new Error("Pool work scopes overlap");
			const id = randomUUID();
			await tx.run(
				`INSERT INTO ${this.work}(id, root, boundary, descriptor, fingerprint, epoch, ready_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				id,
				lease.runId,
				boundaryId,
				json,
				fingerprint,
				lease.epoch,
				now,
			);
			const seq = await tx.get<SqliteRow & { seq: number }>(
				`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${this.journal.events} WHERE run_id = ?`,
				lease.runId,
			);
			const existing = await tx.get(
				`SELECT payload FROM ${this.journal.events} WHERE run_id = ? AND key = ?`,
				lease.runId,
				key,
			);
			if (existing && existing.payload !== payload) throw new Error("Pool boundary identity conflict");
			if (!existing)
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
			const control = await tx.get(`SELECT state FROM ${this.roots}_control WHERE root = ?`, lease.runId);
			if (control && control.state !== "running") return undefined;
			if (status !== "running" || compatibleDefinitions.length === 0) return undefined;
			// Only work this root incarnation enqueued: the root cannot accept an attempt of a child it has not
			// re-enqueued since resuming, so an earlier incarnation's released work waits for its enqueue (#3979).
			const row = await tx.get<WorkRow>(
				`SELECT * FROM ${this.work} WHERE root = ? AND state = 'ready' AND epoch = ? AND ready_at <= ? AND (${compatible}) ORDER BY ready_at, rowid LIMIT 1`,
				lease.runId,
				lease.epoch,
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
	private async admitsAttemptWrites(tx: SqliteExecutor, lease: Lease, status: string): Promise<boolean> {
		if (status === "running") return true;
		if (status !== "paused") return false;
		const control = await tx.get(`SELECT state FROM ${this.roots}_control WHERE root = ?`, lease.runId);
		return control?.state === "paused";
	}
	private async current(tx: SqliteExecutor, lease: Lease, token: WorkLease, allowCompleted = false): Promise<WorkRow> {
		const row = await tx.get<WorkRow>(`SELECT * FROM ${this.work} WHERE id = ? AND root = ?`, token.id, lease.runId);
		if (
			(row?.state !== "leased" && !(allowCompleted && row?.state === "completed")) ||
			row.epoch !== token.epoch ||
			row.generation !== token.generation ||
			row.worker !== token.worker
		)
			throw new Error(STALE_WORK_LEASE);
		return row;
	}
	/** Extend a held attempt's lease. Only the work row changes: a renewal leaves no operation record behind. */
	async renew(lease: Lease, token: WorkLease, durationMs: number): Promise<PoolWork> {
		positive(durationMs);
		lease = snapshotLease(lease);
		token = { ...token };
		return this.transaction(async (tx) => {
			const { now } = await this.authority(tx, lease);
			const row = await this.current(tx, lease, token);
			if (row.epoch !== lease.epoch || row.expires_at < now) throw new Error(STALE_WORK_LEASE);
			const expiresAt = Math.max(Number(row.expires_at), expiry(now, durationMs));
			await tx.run(`UPDATE ${this.work} SET expires_at = ?, renewed_at = ? WHERE id = ?`, expiresAt, now, row.id);
			return { ...fromRow(row), expiresAt, renewedAt: now };
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
		const identity = requestIdentity(request);
		mutation = JSON.parse(request).mutation as PoolMutation;
		const checkpoints = this.checkpoints.begin(lease.runId);
		const receipt = await this.transaction(async (tx) => {
			const { now, status } = await this.authority(tx, lease);
			const row = await this.current(tx, lease, token);
			if (row.epoch !== lease.epoch) throw new Error(STALE_WORK_LEASE);
			const previous = await tx.get<SqliteRow & { request: string; receipt: string }>(
				`SELECT * FROM ${this.operations} WHERE work = ? AND generation = ? AND operation = ?`,
				token.id,
				token.generation,
				operationId,
			);
			if (previous) {
				if (previous.request !== identity) throw new Error("Pool operation identity conflict");
				return JSON.parse(previous.receipt) as PoolCommitReceipt;
			}
			if (row.expires_at < now) throw new Error(STALE_WORK_LEASE);
			if (!(await this.admitsAttemptWrites(tx, lease, status))) throw new Error("Pool root is not running");
			const receipt =
				mutation.kind === "session-append"
					? await this.appendSession(tx, row, mutation, now)
					: await this.recordCheckpoint(tx, lease, token, row, mutation, now, checkpoints);
			await tx.run(
				`INSERT INTO ${this.operations} VALUES (?, ?, ?, ?, ?)`,
				token.id,
				token.generation,
				operationId,
				identity,
				JSON.stringify(receipt),
			);
			return receipt;
		});
		// Only now has the transaction committed what validation read; a rolled-back read never reaches the index.
		checkpoints.commit();
		return receipt;
	}
	private async appendSession(
		tx: SqliteExecutor,
		row: WorkRow,
		mutation: PoolSessionAppend,
		now: number,
	): Promise<PoolCommitReceipt> {
		return { at: now, lastSeq: await applyPoolSession(tx, `${this.journal.runs}_pool_`, row.id, mutation) };
	}
	private async recordCheckpoint(
		tx: SqliteExecutor,
		lease: Lease,
		token: WorkLease,
		row: WorkRow,
		mutation: PoolCheckpointMutation,
		now: number,
		checkpoints: PoolCheckpointRead,
	): Promise<PoolCommitReceipt> {
		const checkpoint = mutation.checkpoint;
		await validatePoolMutation(tx, this.journal, lease.runId, fromRow(row), mutation, checkpoints);
		if (checkpoint.completedAt > Math.max(now, Date.now()) + MAX_WORKER_CLOCK_SKEW_MS)
			throw new Error("Pool checkpoint timestamp is in the future");
		assertWorkflowSerializableObject(checkpoint, "Pool checkpoint");
		const key = JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, checkpoint.kind, checkpoint.checkpointId]);
		const payload = serializeJson(checkpoint);
		const existing = await tx.get<SqliteRow & { seq: number; at: number; payload: string }>(
			`SELECT seq, at, payload FROM ${this.journal.events} WHERE run_id = ? AND key = ?`,
			lease.runId,
			key,
		);
		if (existing && !isRecordedCheckpoint(existing.payload, payload))
			throw new Error("Pool checkpoint identity conflict");
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
		const billed = poolCheckpointUsage(checkpoint);
		if (billed && !existing)
			await upsertPoolUsage(tx, this.journal.runs, row.id, token.generation, billed.key, billed.usage);
		return receipt;
	}
	async complete(lease: Lease, token: WorkLease, result: WorkflowSerializableObject): Promise<void> {
		lease = snapshotLease(lease);
		token = { ...token };
		assertWorkflowSerializableObject(result, "Pool result");
		const payload = serializeJson(result);
		await this.transaction(async (tx) => {
			const { now, status } = await this.authority(tx, lease);
			const row = await this.current(tx, lease, token, true);
			if (row.epoch !== lease.epoch) throw new Error(STALE_WORK_LEASE);
			if (row.state === "completed") {
				const previous = await tx.get(`SELECT result FROM ${this.work}_results WHERE work = ?`, token.id);
				if (previous?.result !== payload) throw new Error("Pool result identity conflict");
				return;
			}
			if (row.expires_at < now || !(await this.admitsAttemptWrites(tx, lease, status)))
				throw new Error(STALE_WORK_LEASE);
			if (JSON.parse(payload).runId !== fromRow(row).childRunId) throw new Error("Pool result identity mismatch");
			await tx.run(`INSERT INTO ${this.work}_results VALUES (?, ?)`, token.id, payload);
			await tx.run(`UPDATE ${this.work} SET state = 'completed' WHERE id = ?`, token.id);
		});
	}
	async result(root: string, id: string): Promise<WorkflowSerializableObject | undefined> {
		return this.transaction(async (tx) => {
			const row = await tx.get(
				`SELECT r.result FROM ${this.work}_results r JOIN ${this.work} w ON w.id = r.work WHERE w.root = ? AND w.id = ?`,
				root,
				id,
			);
			return row ? (JSON.parse(String(row.result)) as WorkflowSerializableObject) : undefined;
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
	async extend(lease: Lease, token: WorkLease, durationMs: number): Promise<PoolWork> {
		positive(durationMs);
		lease = snapshotLease(lease);
		token = { ...token };
		return this.transaction(async (tx) => {
			const { now } = await this.authority(tx, lease);
			const row = await this.current(tx, lease, token);
			if (row.epoch !== lease.epoch) throw new Error(STALE_WORK_LEASE);
			const expiresAt = Math.max(Number(row.expires_at), expiry(now, durationMs));
			await tx.run(`UPDATE ${this.work} SET expires_at = ?, renewed_at = ? WHERE id = ?`, expiresAt, now, row.id);
			return { ...fromRow(row), expiresAt, renewedAt: now };
		});
	}
	async releaseExited(lease: Lease, token: WorkLease): Promise<boolean> {
		lease = snapshotLease(lease);
		token = { ...token };
		return this.transaction(async (tx) => {
			await this.authority(tx, lease);
			const row = await tx.get<WorkRow>(
				`SELECT * FROM ${this.work} WHERE id = ? AND root = ?`,
				token.id,
				lease.runId,
			);
			if (
				row?.state !== "leased" ||
				row.generation !== token.generation ||
				row.worker !== token.worker ||
				row.epoch !== token.epoch
			)
				return false;
			await tx.run(`UPDATE ${this.work} SET state = 'ready', worker = NULL, expires_at = 0 WHERE id = ?`, row.id);
			return true;
		});
	}
	/**
	 * Releases an earlier incarnation's attempt that this incarnation retained while its process groups ran. With
	 * `adopt`, because this root incarnation already enqueued it, the work takes the current epoch and is claimable
	 * now; otherwise it waits, as any released earlier work does, for this incarnation's enqueue to adopt it.
	 */
	async releaseRetained(lease: Lease, token: WorkLease, adopt: boolean): Promise<boolean> {
		lease = snapshotLease(lease);
		token = { ...token };
		return this.transaction(async (tx) => {
			await this.authority(tx, lease);
			const row = await this.current(tx, lease, token);
			if (row.epoch >= lease.epoch) return false;
			await tx.run(
				`UPDATE ${this.work} SET state = 'ready', worker = NULL, expires_at = 0, epoch = ? WHERE id = ?`,
				adopt ? lease.epoch : row.epoch,
				row.id,
			);
			return true;
		});
	}
	/**
	 * Releases the work this root incarnation's workers still hold when its pool closes (#3996), except the
	 * `retained` work ids, which stay leased. Their workers are stopped, so no attempt holds that work any more.
	 */
	async releaseClosed(lease: Lease, retained: readonly string[] = []): Promise<number> {
		lease = snapshotLease(lease);
		return this.transaction(async (tx) => {
			await this.authority(tx, lease);
			const released = await tx.run(
				`UPDATE ${this.work} SET state = 'ready', worker = NULL, expires_at = 0 WHERE root = ? AND state = 'leased' AND epoch = ? AND id NOT IN (SELECT value FROM json_each(?))`,
				lease.runId,
				lease.epoch,
				JSON.stringify(retained),
			);
			return released.changes;
		});
	}
	/** Releases work leased by earlier root incarnations, except the `retained` work ids, which stay leased. */
	async releasePreviousIncarnations(lease: Lease, retained: readonly string[] = []): Promise<number> {
		lease = snapshotLease(lease);
		return this.transaction(async (tx) => {
			await this.authority(tx, lease);
			const released = await tx.run(
				`UPDATE ${this.work} SET state = 'ready', worker = NULL, expires_at = 0 WHERE root = ? AND state = 'leased' AND epoch < ? AND id NOT IN (SELECT value FROM json_each(?))`,
				lease.runId,
				lease.epoch,
				JSON.stringify(retained),
			);
			return released.changes;
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

/**
 * Whether the checkpoint serialized as `payload` is the one already stored as `stored`, so re-recording it keeps the first write.
 * Only its times may differ: a later work generation that replays a cached stage re-records its
 * `stage-replay-meta:` checkpoint under the same content-derived id, stamped with that replay's time,
 * and one that replays a human-input prompt still pending when its worker died re-records that
 * prompt's stage checkpoint with the time the replay asked it again (#3996).
 * Any other difference is a different checkpoint and still conflicts.
 */
function isRecordedCheckpoint(stored: string, payload: string): boolean {
	if (stored === payload) return true;
	const { completedAt, startedAt } = JSON.parse(stored) as {
		readonly completedAt?: number;
		readonly startedAt?: number;
	};
	if (typeof completedAt !== "number") return false;
	const next = JSON.parse(payload) as { readonly completedAt: number; readonly startedAt?: number };
	if ((startedAt === undefined) !== (next.startedAt === undefined)) return false;
	return serializeJson({ ...next, completedAt, ...(startedAt === undefined ? {} : { startedAt }) }) === stored;
}

export function openSqlPoolQueue(journal: RunJournal): Promise<SqlPoolQueue> {
	const storage = sqlPoolStorage(journal);
	if (!storage) return Promise.reject(new Error("Worker pool requires a SQL run journal"));
	return SqlPoolQueue.open(storage);
}
