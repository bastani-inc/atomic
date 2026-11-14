import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { WorktreeSnapshot } from "@bastani/atomic";
import {
	assertStorageSchemaVersion,
	renderStorageIdentifiers,
	type SessionStore,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteStatement,
	type SqliteValue,
	StorageError,
	StorageProvider,
} from "@bastani/atomic/storage";
import { assertWorkflowSerializableObject } from "../../shared/serializable.js";
import type { WorkflowSerializableObject } from "../../shared/types.js";
import {
	PoolNotInitializedError,
	StaleWorkLeaseError,
	type StaleWorkLeaseReason,
} from "../../shared/worker-pool-errors.js";
import type { WorkspaceBinding } from "../../workers/workspace-binding.js";
import { validateCheckpointInvocationFingerprint } from "../boundary-topology.js";
import { durableHash } from "../durable-hash.js";
import { ForkError, ForkSessionClaimError, type ForkSessionClaimReason } from "../fork-errors.js";
import {
	DURABLE_BOUNDARY_TOPOLOGY_VERSION,
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableCheckpoint,
	type DurableStageCheckpoint,
} from "../types.js";
import { type SqlPoolStorage, sqlPoolStorage } from "./internal.js";
import { isWorkflowLeaseExpired } from "./lease-expiry.js";
import { PoolCheckpointIndex, type PoolCheckpointRead, type PoolCheckpointSource } from "./pool-checkpoint-index.js";
import { guardedPoolWrite, poolFenceSchema } from "./pool-guarded-write.js";
import {
	applyPoolSession,
	type PoolCheckpointMutation,
	type PoolMutation,
	type PoolSessionAppend,
	type PoolSessionMutation,
	poolTransactionSessionStore,
	validatePoolMutation,
} from "./pool-mutations.js";
import { isRecordedCheckpointValue, isSameCheckpointValue, type PoolRemoteJournal } from "./pool-remote-journal.js";
import { poolCheckpointUsage, poolUsageSchema, poolUsageUpsert, upsertPoolUsage } from "./pool-stage-usage.js";
import {
	isStaleLeaseError,
	JournalError,
	type Lease,
	PoolAppendRefusedError,
	type PoolAppendRefusedReason,
	RUN_EVENT_TYPES,
	type RunJournal,
	StaleLeaseError,
} from "./types.js";
import { journalCounter, serializeJson, validateText } from "./values.js";

export type { PoolMutation } from "./pool-mutations.js";

type Transaction = SqlPoolStorage["transaction"];
type JournalTables = SqlPoolStorage["tables"];
const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const MAX_WORKER_CLOCK_SKEW_MS = 1_000;
/** Version 2 keeps no lease renewal rows and stores a digest, not the full request, per pool operation. */
const POOL_SCHEMA_VERSION = 2;

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
/** How a resumed root may enqueue the work an earlier incarnation of it queued (#4200). */
export interface PoolEnqueueOptions {
	/**
	 * The resume accepted edits to the entry modules of the root's worker definitions: work an earlier incarnation
	 * queued with another digest of the same definition's entry module, and has not finished, runs the module this
	 * root loaded.
	 */
	readonly acceptEntryChanges?: boolean;
	/** Stage sessions a fork copied into the pool tables for this child, which the work takes over (#4321). */
	readonly claimSessions?: readonly PoolSessionClaim[];
}
/**
 * A stage session of a forked root's child, as the root's journal records it: a fork copies a pooled stage's session
 * into the pool tables before the work that resumes it exists, so the work takes it over when it is queued.
 */
export interface PoolSessionClaim {
	readonly sessionId: string;
	/** Replay key of the stage that recorded the session, under the work's scope. */
	readonly replayKey: string;
	/** The run of that stage, which the copy's header names. */
	readonly runId: string;
}
export interface PoolWork extends PoolWorkDescriptor {
	readonly id: string;
	/** `failed`: not completed in its root incarnation; a resumed root that enqueues it again replays it. */
	readonly state: "ready" | "leased" | "completed" | "failed";
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
/** The workspace binding a child carries in its execution, as SQL reads it from a work row's descriptor. */
const WORKSPACE_BINDING = "json_extract(descriptor, '$.execution.workspaceBinding')";
function compatibleClause(definitions: number): string {
	return Array.from(
		{ length: definitions },
		() => "(json_extract(descriptor, '$.definition') = ? AND json_extract(descriptor, '$.digest') = ?)",
	).join(" OR ");
}
/**
 * What identifies queued work: its descriptor and boundary, without the worktree snapshot its root captured as it
 * dispatched the work (#4492). Each dispatch, a resume's included, captures that snapshot anew, and it only says where
 * the work's tree comes from, so the same child hashes the same whichever snapshot it carries.
 */
function workFingerprint(descriptor: PoolWorkDescriptor, boundary: WorkflowSerializableObject): string {
	const { workspaceSnapshot: _snapshot, ...execution } = descriptor.execution;
	return durableHash({ descriptor: { ...descriptor, execution }, boundary });
}
/**
 * The descriptor a root enqueues work with again, keeping the worktree snapshot the `queued` descriptor carries when
 * the root captured none this time (#4492): a root resumed with only its binding's identity has no worktree to capture,
 * and the earlier snapshot still restores the tree of the same binding.
 */
function withQueuedSnapshot(descriptor: PoolWorkDescriptor, queued: string): string {
	const workspaceSnapshot =
		descriptor.execution.workspaceSnapshot ?? (JSON.parse(queued) as PoolWorkDescriptor).execution.workspaceSnapshot;
	return serializeJson({ ...descriptor, execution: { ...descriptor.execution, workspaceSnapshot } });
}
/**
 * Which ready work a claim may take (shared placement, #4310): only work without a workspace binding, as the root's
 * own workers take it, or exactly one ready item a worker host chose by its binding. Unset: any ready work.
 */
export type PoolClaimPlacement =
	| { readonly kind: "unbound" }
	| { readonly kind: "work"; readonly id: string; readonly generation: number };
/** A ready work item a worker host may choose, with the workspace binding its child carries, if any. */
export interface PoolClaimCandidate {
	readonly id: string;
	readonly generation: number;
	readonly workspace?: WorkspaceBinding;
}
function staleWork(lease: Lease, token: WorkLease, reason: StaleWorkLeaseReason): StaleWorkLeaseError {
	return new StaleWorkLeaseError({ root: lease.runId, workId: token.id, generation: token.generation, reason });
}
type OutboxRow = SqliteRow & {
	work: string;
	generation: number;
	operation: string;
	request: string;
	event_key: string;
	payload: string;
	last_seq: number | null;
};
/** A commit's fences and writes, as its plan gathers them. */
interface CommitWrite {
	readonly fences: SqliteStatement[];
	readonly writes: SqliteStatement[];
}
/** The receipt a commit stores, as the SQL that builds it in the commit's own request, and its parameters. */
interface ReceiptSql {
	readonly sql: string;
	readonly params: readonly SqliteValue[];
}
/** The pool's session store, and what holds the executor its calls go to. */
interface PoolSessions {
	readonly store: SessionStore;
	readonly within: AsyncLocalStorage<SqliteExecutor>;
}
/** What a heartbeat records under the attempt's lease; its `batched` form, when present, joins the heartbeat's batch. */
export type PoolHeartbeatRecord<T> = ((tx: SqliteExecutor) => Promise<T>) & {
	readonly batched?: {
		readonly writes: readonly SqliteStatement[];
		readonly reads: readonly SqliteStatement[];
		readonly result: (rows: readonly SqliteRow[][]) => T;
	};
};
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

/** A digest as a refusal names it, as `activatePublicPool` names an edited entry module. */
function short(digest: string): string {
	return digest.slice(0, 12);
}

function shownMode(mode: unknown): string {
	return mode === undefined ? "unset" : JSON.stringify(mode);
}

export class SqlPoolQueue {
	private readonly meta: string;
	private readonly roots: string;
	private readonly work: string;
	private readonly operations: string;
	/** Checkpoint events a commit accepted that the durable journal has not recorded yet (remote journals only). */
	private readonly outbox: string;
	/** The snapshot each root's binding carries to its unbound children, while its pool is prepared (#4503). */
	private readonly rootSnapshots: string;
	private readonly transaction: Transaction;
	private readonly journal: JournalTables;
	private readonly checkpoints = new PoolCheckpointIndex();
	/** Commits in flight by work, generation and operation, so a duplicate joins the first instead of racing it. */
	private readonly committing = new Map<string, Promise<PoolCommitReceipt>>();
	private draining: Promise<number> | undefined;
	private sessions: Promise<PoolSessions> | undefined;
	/** The work row of each attempt as this queue last claimed, extended or read it: an optimistic commit plans from it. */
	private readonly attempts = new Map<string, WorkRow>();
	/** Whether the outbox may hold an event, so a claim reads it only after a commit staged one. */
	private outboxPending = false;
	private constructor(
		private readonly storage: SqlPoolStorage,
		/** The durable journal when it is not this storage's own database; undefined when it is. */
		private readonly remote?: PoolRemoteJournal,
	) {
		const { transaction, tables: journal } = storage;
		this.transaction = transaction;
		this.journal = journal;
		this.meta = `${journal.runs}_pool_meta`;
		this.roots = `${journal.runs}_pool`;
		this.work = `${journal.runs}_work`;
		this.operations = `${journal.runs}_pool_operations`;
		this.outbox = `${journal.runs}_pool_outbox`;
		this.rootSnapshots = `${journal.runs}_pool_root_snapshot`;
	}
	/**
	 * `remote` is the root's durable journal when it lives in another database than `storage`, whose run and lease rows
	 * then mirror the journal's (see {@link PoolRemoteJournal}). Without it the journal and the pool share `storage`'s
	 * database, and every commit is one transaction in it.
	 */
	static async open(storage: SqlPoolStorage, remote?: PoolRemoteJournal): Promise<SqlPoolQueue> {
		const journal = storage.tables;
		const pool = new SqlPoolQueue(storage, remote);
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
			await tx.exec(poolFenceSchema(journal.runs));
			// Keyed by the run, not the pool row: a root records its binding's snapshot before it queues anything.
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${pool.rootSnapshots}(
				root TEXT PRIMARY KEY REFERENCES ${journal.runs}(run_id) ON DELETE CASCADE,
				epoch INTEGER NOT NULL, snapshot TEXT NOT NULL
			)`);
			if (remote)
				await tx.exec(`CREATE TABLE IF NOT EXISTS ${pool.outbox}(
					work TEXT NOT NULL REFERENCES ${pool.work}(id) ON DELETE CASCADE,
					generation INTEGER NOT NULL, operation TEXT NOT NULL, request TEXT NOT NULL,
					event_key TEXT NOT NULL, payload TEXT NOT NULL, last_seq INTEGER,
					PRIMARY KEY(work, generation, operation)
				)`);
			if (remote) pool.outboxPending = (await tx.get(`SELECT 1 AS held FROM ${pool.outbox} LIMIT 1`)) !== undefined;
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
	private leaseRow(tx: SqliteExecutor, lease: Lease) {
		return tx.get<
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
	}
	private async authority(
		tx: SqliteExecutor,
		lease: Lease,
		timeout?: number,
	): Promise<{ now: number; status: string }> {
		return this.authorityOf(await this.leaseRow(tx, lease), lease, timeout);
	}
	/** {@link authority} of a lease row read already. */
	private authorityOf(
		row: Awaited<ReturnType<SqlPoolQueue["leaseRow"]>>,
		lease: Lease,
		timeout?: number,
	): { now: number; status: string } {
		if (row?.timeout === null && timeout === undefined) throw new PoolNotInitializedError({ root: lease.runId });
		if (
			!row ||
			row.epoch !== lease.epoch ||
			row.holder_id !== lease.holderId ||
			isWorkflowLeaseExpired(row.renewed_at, row.timeout ?? timeout ?? 0, row.now)
		)
			throw new StaleLeaseError(lease.runId, lease.epoch, Number(row?.epoch ?? 0));
		return row;
	}
	/**
	 * In one read: the root's lease row as {@link authority} checks it, the attempt's work row, the root's pool control,
	 * and the attempt's stored result for `operationId`, if any. A commit reads them all before it plans its write.
	 */
	private async attemptState(
		read: SqliteExecutor,
		lease: Lease,
		token: WorkLease,
		operationId: string,
		/** A checkpoint's event key: the root's latest sequence, and the event the key recorded, are read too. */
		key?: string,
		/** The root's checkpoints that validation reads, selected in the same read. */
		checkpoints?: PoolCheckpointRead,
	) {
		const prefetch = checkpoints?.prefetchColumns(this.journal.events);
		const row = await read.get<
			NonNullable<Awaited<ReturnType<SqlPoolQueue["leaseRow"]>>> & {
				control: string | null;
				work_row: string | null;
				previous: string | null;
				head: number | null;
				existing: string | null;
			}
		>(
			`SELECT l.*, r.status, p.timeout, ${STORE_NOW} AS now,
			(SELECT state FROM ${this.roots}_control WHERE root = l.run_id) AS control,
			(SELECT json_object('id', id, 'root', root, 'boundary', boundary, 'descriptor', descriptor, 'fingerprint', fingerprint,
				'state', state, 'generation', generation, 'worker', worker, 'epoch', epoch, 'expires_at', expires_at,
				'renewed_at', renewed_at, 'ready_at', ready_at) FROM ${this.work} WHERE id = ? AND root = l.run_id) AS work_row,
			(SELECT json_object('request', request, 'receipt', receipt) FROM ${this.operations} WHERE work = ? AND generation = ? AND operation = ?) AS previous,
			(SELECT COALESCE(MAX(seq), 0) FROM ${this.journal.events} WHERE run_id = l.run_id) AS head,
			(SELECT json_object('seq', seq, 'at', at, 'payload', payload) FROM ${this.journal.events} WHERE run_id = l.run_id AND key = ?) AS existing
			${prefetch === undefined ? "" : `, ${prefetch.sql}`}
			FROM ${this.journal.leases} l JOIN ${this.journal.runs} r ON r.run_id = l.run_id LEFT JOIN ${this.roots} p ON p.root = l.run_id WHERE l.run_id = ?`,
			token.id,
			token.id,
			token.generation,
			operationId,
			key ?? null,
			...(prefetch?.params ?? []),
			lease.runId,
		);
		const { now, status } = this.authorityOf(row, lease);
		if (prefetch !== undefined) checkpoints!.prefetch(row!);
		return {
			now,
			status,
			control: row!.control,
			work: row!.work_row === null ? undefined : (JSON.parse(row!.work_row) as WorkRow),
			previous:
				row!.previous === null ? undefined : (JSON.parse(row!.previous) as { request: string; receipt: string }),
			recorded: {
				head: Number(row!.head ?? 0),
				existing:
					row!.existing === null
						? undefined
						: (JSON.parse(row!.existing) as { seq: number; at: number; payload: string }),
			},
		};
	}
	/** A fence: `lease` still holds the root, renewed within its pool's window, by the database clock. */
	rootFence(lease: Lease): SqliteStatement {
		return {
			sql: `SELECT 1 FROM ${this.journal.leases} l JOIN ${this.roots} p ON p.root = l.run_id WHERE l.run_id = ? AND l.epoch = ? AND l.holder_id = ? AND ${STORE_NOW} - l.renewed_at <= p.timeout`,
			params: [lease.runId, lease.epoch, lease.holderId],
		};
	}
	/**
	 * A fence: `token`'s attempt still holds its work in `lease`'s incarnation of the root, unexpired when `unexpired`,
	 * as {@link current} and the expiry checks of each write decided.
	 */
	attemptFence(lease: Lease, token: WorkLease, unexpired: boolean): SqliteStatement {
		return {
			sql: `SELECT 1 FROM ${this.work} WHERE id = ? AND root = ? AND state = 'leased' AND epoch = ? AND epoch = ? AND generation = ? AND worker IS ?${unexpired ? ` AND expires_at >= ${STORE_NOW}` : ""}`,
			params: [token.id, lease.runId, token.epoch, lease.epoch, token.generation, token.worker],
		};
	}
	/** A fence: the root's status still admits its attempts' writes, as {@link admitsAttemptWrites} decided. */
	private admitsFence(lease: Lease): SqliteStatement {
		return {
			sql: `SELECT 1 FROM ${this.journal.runs} r WHERE r.run_id = ? AND (r.status = 'running' OR (r.status = 'paused' AND EXISTS (SELECT 1 FROM ${this.roots}_control c WHERE c.root = r.run_id AND c.state = 'paused')))`,
			params: [lease.runId],
		};
	}
	/** A fence: the attempt has no result for `operationId` yet. */
	private operationFence(token: WorkLease, operationId: string): SqliteStatement {
		return {
			sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${this.operations} WHERE work = ? AND generation = ? AND operation = ?)`,
			params: [token.id, token.generation, operationId],
		};
	}
	/**
	 * Where the root's lease stands for the pool. `current`: `lease` holds it and its last renewal is inside the pool's
	 * window. `late`: `lease` still holds it, but its last renewal is older than that window, as when the root's process
	 * is too busy to renew on time. `lost`: it was released, or granted to another holder or epoch. Every operation
	 * refuses a late lease as it refuses a lost one ({@link StaleLeaseError}), but only a lost lease ends the root's hold:
	 * a late one is renewed again by the same holder. `timeout` is the window for a root whose pool row does not exist yet.
	 */
	async rootLease(lease: Lease, timeout: number): Promise<"current" | "late" | "lost"> {
		// A read: a pool waiting for a late root takes no write lock to ask again.
		const row = await this.storage.read((executor) => this.leaseRow(executor, lease));
		if (!row || row.epoch !== lease.epoch || row.holder_id !== lease.holderId) return "lost";
		return isWorkflowLeaseExpired(row.renewed_at, row.timeout ?? timeout, row.now) ? "late" : "current";
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
	/** Whether a coordinator ever initialized this root's pool, as for a root resumed after its pool ran. */
	async initialized(root: string): Promise<boolean> {
		return (
			(await this.storage.read((executor) =>
				executor.get(`SELECT 1 AS held FROM ${this.roots} WHERE root = ?`, root),
			)) !== undefined
		);
	}
	/**
	 * Records `snapshot` as the one the root's binding carries to its unbound children (#4503), in place of any an earlier
	 * incarnation of the root recorded. The snapshot reference index keeps its blobs from collection, at any grace
	 * window, until {@link releaseRootSnapshot} or the run's deletion. Without a snapshot, as for a root resumed without
	 * a bound worktree or with snapshots disabled, it only lets go of the one an earlier incarnation recorded. A root that
	 * has queued nothing yet records it too, so only the root's lease is checked: one another holder or epoch took is a
	 * {@link StaleLeaseError}.
	 */
	async holdRootSnapshot(lease: Lease, snapshot: WorktreeSnapshot | undefined): Promise<void> {
		lease = snapshotLease(lease);
		await this.transaction(async (tx) => {
			const row = await this.leaseRow(tx, lease);
			if (row?.epoch !== lease.epoch || row.holder_id !== lease.holderId)
				throw new StaleLeaseError(lease.runId, lease.epoch, Number(row?.epoch ?? 0));
			if (snapshot === undefined) {
				await tx.run(`DELETE FROM ${this.rootSnapshots} WHERE root = ? AND epoch < ?`, lease.runId, lease.epoch);
				return;
			}
			await tx.run(
				`INSERT INTO ${this.rootSnapshots}(root, epoch, snapshot) VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET epoch = excluded.epoch, snapshot = excluded.snapshot`,
				lease.runId,
				lease.epoch,
				JSON.stringify(snapshot),
			);
		});
	}
	/** Lets go of the snapshot `lease`'s incarnation of the root recorded; one a later incarnation recorded stays. */
	async releaseRootSnapshot(lease: Lease): Promise<void> {
		lease = snapshotLease(lease);
		await this.transaction((tx) =>
			tx.run(`DELETE FROM ${this.rootSnapshots} WHERE root = ? AND epoch = ?`, lease.runId, lease.epoch),
		);
	}
	/**
	 * The root's control state for its workers. A read: every idle worker asks on each loop, and a write lock per ask
	 * would queue every host of a shared journal behind it (#4310).
	 */
	async control(lease: Lease): Promise<PoolControl> {
		return this.storage.read(async (executor) => {
			await this.authority(executor, lease);
			return this.controlIn(executor, lease);
		});
	}
	private async controlIn(tx: SqliteExecutor, lease: Lease): Promise<PoolControl> {
		const row = await tx.get(`SELECT state, revision FROM ${this.roots}_control WHERE root = ?`, lease.runId);
		return row
			? { state: row.state as PoolControl["state"], revision: Number(row.revision) }
			: { state: "running", revision: 0 };
	}
	async setControl(lease: Lease, state: PoolControl["state"]): Promise<PoolControl> {
		await this.remote?.fresh(lease);
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
		const refused = (reason: PoolAppendRefusedReason, cause?: Error) =>
			new PoolAppendRefusedError(
				{ root: lease.runId, workId: token.id, generation: token.generation, reason },
				cause === undefined ? undefined : { cause },
			);
		const guard = async (tx: SqliteExecutor, runId: string): Promise<void> => {
			if (runId !== lease.runId) throw refused("foreign-root");
			try {
				await this.authority(tx, lease);
				// The attempt's identity fences it, not the clock: a lapsed lease whose worker is alive stays current
				// until the coordinator extends it, and only reassignment or an epoch change replaces it (#3888). An
				// attempt that completed its work stays current too: its stage can end before the root's background
				// drain records the receipts of messages the stage received, and those must not be lost.
				const row = await this.current(tx, lease, token, true);
				if (row.epoch !== lease.epoch) throw staleWork(lease, token, "epoch-mismatch");
				assertSession();
			} catch (error) {
				// The pool's own authority over the root is gone: a refusal of this receipt, not a lost root journal lease.
				if (isStaleLeaseError(error)) throw refused("coordinator-authority", error);
				if (error instanceof JournalError || error instanceof StorageError || !(error instanceof Error))
					throw error;
				throw refused("attempt-refused", error);
			}
		};
		// A journal in another database cannot run the guard inside its own append transaction. The attempt is checked
		// in the coordination database right before the append starts, so only a fence that lands while the append is
		// on its way to the journal can still be missed.
		if (this.remote) return this.transaction((tx) => guard(tx, lease.runId)).then(action);
		return this.storage.withAppendGuard(guard, action);
	}

	async assertCurrent(lease: Lease, token: WorkLease): Promise<void> {
		await this.storage.read(async (executor) => {
			const { now } = await this.authority(executor, lease);
			const row = await this.current(executor, lease, token);
			if (row.epoch !== lease.epoch) throw staleWork(lease, token, "epoch-mismatch");
			if (row.expires_at < now) throw staleWork(lease, token, "expired");
		});
	}
	async enqueue(
		lease: Lease,
		descriptor: PoolWorkDescriptor,
		boundary: DurableStageCheckpoint,
		options: PoolEnqueueOptions = {},
	): Promise<PoolWork> {
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
		const fingerprint = workFingerprint(JSON.parse(json), JSON.parse(payload));
		const key = JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, boundary.kind, boundary.checkpointId]);
		// A journal in another database takes the boundary's start first, as its own idempotent write: a crash before the
		// work row below leaves a start with no work, which the root's resume enqueues again and finds already recorded.
		if (this.remote) await this.recordBoundaryStart(lease, key, boundary);
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
				const requested = withQueuedSnapshot(descriptor, previous.descriptor);
				const row =
					previous.fingerprint === fingerprint
						? previous
						: await this.rebind(tx, lease, previous, requested, JSON.parse(payload), fingerprint, options);
				await this.claimSessions(tx, lease.runId, row.id, descriptor, options.claimSessions);
				if ((row.state !== "ready" && row.state !== "failed") || row.epoch >= lease.epoch) return fromRow(row);
				// Work of an earlier incarnation becomes claimable again once this root enqueues it (#3979), including
				// work that incarnation failed or left unfinished when its pool closed. It carries the worktree snapshot this
				// incarnation captured (#4492), whose blobs are fresh.
				await tx.run(
					`UPDATE ${this.work} SET state = 'ready', epoch = ?, descriptor = ? WHERE id = ?`,
					lease.epoch,
					requested,
					row.id,
				);
				return fromRow({ ...row, state: "ready", epoch: lease.epoch, descriptor: requested });
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
			if (!this.remote) {
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
			}
			await this.claimSessions(tx, lease.runId, id, descriptor, options.claimSessions);
			return fromRow((await tx.get<WorkRow>(`SELECT * FROM ${this.work} WHERE id = ?`, id))!);
		});
	}
	/**
	 * Makes `work` the owner of each claimed session, in the transaction that queues it. Only a session nobody owns is
	 * taken over, and only when it is the fork's copy for the claimed stage: internal, copied from another session, and
	 * naming the claimed run. A session the work already owns for the same stage is claimed already. Anything else is a
	 * {@link ForkSessionClaimError}, which rolls the transaction back, so nothing is queued.
	 */
	private async claimSessions(
		tx: SqliteExecutor,
		root: string,
		work: string,
		descriptor: Pick<PoolWorkDescriptor, "childRunId" | "scope">,
		claims: readonly PoolSessionClaim[] | undefined,
	): Promise<void> {
		if (claims === undefined || claims.length === 0) return;
		const { childRunId, scope } = descriptor;
		const prefix = `${this.journal.runs}_pool_`;
		const sessions = await poolTransactionSessionStore(tx, prefix);
		let primary: unknown;
		try {
			for (const claim of claims) {
				const refuse = (reason: ForkSessionClaimReason) =>
					new ForkSessionClaimError({
						reason,
						sessionId: claim.sessionId,
						rootRunId: root,
						childRunId,
						scope,
						replayKey: claim.replayKey,
						stageRunId: claim.runId,
					});
				if (!claim.replayKey.startsWith(`${scope}:`)) throw refuse("outside-scope");
				const owner = await tx.get(
					`SELECT work, replay_key FROM ${prefix}session_owners WHERE session = ?`,
					claim.sessionId,
				);
				if (owner !== undefined) {
					if (owner.work !== work) throw refuse("owned-by-other-work");
					if (owner.replay_key !== claim.replayKey) throw refuse("claimed-for-other-stage");
					continue;
				}
				const header = await sessions.readHeader(claim.sessionId);
				if (header === undefined) throw refuse("missing");
				if (header.internal !== true || header.parentSessionId === undefined) throw refuse("not-fork-copy");
				if (header.workflow?.runId !== claim.runId) throw refuse("run-mismatch");
				await tx.run(
					`INSERT INTO ${prefix}session_owners VALUES (?, ?, ?)`,
					claim.sessionId,
					work,
					claim.replayKey,
				);
			}
		} catch (error) {
			primary = error;
			throw error;
		} finally {
			// The store reads through this transaction and owns nothing to release, but a failed close never replaces
			// the claim's own failure: it is attached to a fork error, or logged once.
			await sessions.close().catch((closeFailure: Error) => {
				if (primary === undefined) throw closeFailure;
				if (primary instanceof ForkError) primary.withCleanupCause(closeFailure);
				else console.warn("atomic-workflows: closing the pool sessions of a failed claim failed", closeFailure);
			});
		}
	}
	private async recordBoundaryStart(lease: Lease, key: string, boundary: DurableStageCheckpoint): Promise<void> {
		const remote = this.remote!;
		await remote.fresh(lease);
		const existing = await remote.entry(lease.runId, key);
		if (existing) {
			if (!isSameCheckpointValue(existing.event.payload, boundary))
				throw new Error("Pool boundary identity conflict");
			return;
		}
		const outcome = await remote.append(lease, key, boundary);
		if (outcome.status === "exists" && !isSameCheckpointValue(outcome.entry.event.payload, boundary))
			throw new Error("Pool boundary identity conflict");
	}
	/**
	 * Gives work an earlier incarnation of this root queued the descriptor `json` this incarnation enqueues it with, when
	 * the two differ only in what a resume may change for a child (#4200): its execution mode, which decides how the
	 * child's live work may ask for input and nothing it recorded, and, when the resume accepts entry module edits, the
	 * digest of its definition's entry module, which only names the module the child's next attempt loads. Its recorded
	 * steps replay from the journal either way, and its stored result, if any, is kept. Any other difference makes it
	 * another child. Work this incarnation queued keeps its descriptor: a worker may be running it.
	 *
	 * Work an earlier incarnation still holds is rebound too. Its attempt is fenced, since every write it makes needs that
	 * incarnation's root lease, and the work is claimable again only once its process groups are gone.
	 */
	private async rebind(
		tx: SqliteExecutor,
		lease: Lease,
		previous: WorkRow,
		json: string,
		boundary: WorkflowSerializableObject,
		fingerprint: string,
		options: PoolEnqueueOptions,
	): Promise<WorkRow> {
		const queued = JSON.parse(previous.descriptor) as PoolWorkDescriptor;
		const requested = JSON.parse(json) as PoolWorkDescriptor;
		const queuedMode = queued.execution.executionMode;
		const requestedMode = requested.execution.executionMode;
		// The requested work with what a resume may change put back as it was queued: the same child hashes the same.
		const { executionMode: _mode, ...execution } = requested.execution;
		const asQueued = {
			...requested,
			digest: queued.digest,
			execution: queuedMode === undefined ? execution : { ...execution, executionMode: queuedMode },
		};
		if (workFingerprint(asQueued, boundary) !== previous.fingerprint)
			throw new Error("Pool boundary identity conflict");
		const entryEdited = queued.digest !== requested.digest;
		if (previous.epoch >= lease.epoch) {
			const changes = [
				...(entryEdited ? [`entry module (sha256 ${short(queued.digest)} to ${short(requested.digest)})`] : []),
				...(queuedMode !== requestedMode
					? [`execution mode (${shownMode(queuedMode)} to ${shownMode(requestedMode)})`]
					: []),
			];
			throw new Error(
				`Pool boundary identity conflict: child ${requested.childRunId} is already queued by this incarnation of root ${lease.runId}, and its worker may be running it, so its ${changes.join(" and ")} cannot change`,
			);
		}
		if (entryEdited && options.acceptEntryChanges !== true)
			throw new Error(
				`Pool boundary identity conflict: child ${requested.childRunId} was queued by an earlier run of root ${lease.runId} with the entry module of worker definition ${requested.definition} at sha256 ${short(queued.digest)}, and the root now runs that module at sha256 ${short(requested.digest)}. Resume the root with /workflow resume ${lease.runId} --accept-entry-changes, or acceptEntryChanges: true in the SDK, to run the child with the edited module, or restore the module.`,
			);
		await tx.run(
			`UPDATE ${this.work} SET descriptor = ?, fingerprint = ? WHERE id = ?`,
			json,
			fingerprint,
			previous.id,
		);
		return { ...previous, descriptor: json, fingerprint };
	}
	async claim(
		lease: Lease,
		worker: string,
		definitions: readonly Pick<PoolWorkDescriptor, "definition" | "digest">[],
		durationMs: number,
		placement?: PoolClaimPlacement,
	): Promise<PoolWork | undefined> {
		positive(durationMs);
		lease = snapshotLease(lease);
		const compatibleDefinitions = definitions.flatMap((d) => [d.definition, d.digest]);
		validateText("holderId", worker);
		const compatible = compatibleClause(definitions.length);
		if (this.remote) {
			await this.remote.fresh(lease);
			// No work is handed out while an event this root's workers were told is committed is missing from the
			// journal: a replacement attempt replays the journal, so it must find that event there. A delivery in
			// flight counts as missing events too, since it clears the pending flag when it starts, not when it ends;
			// and a commit can stage another row after the pass this claim joined has read its rows, so ask again.
			try {
				while (this.outboxPending || this.draining !== undefined) await this.drainOutbox(lease);
			} catch (error) {
				if (error instanceof StaleLeaseError) throw error;
				return undefined;
			}
		}
		const placed =
			placement === undefined
				? { clause: "", args: [] }
				: placement.kind === "unbound"
					? { clause: `AND ${WORKSPACE_BINDING} IS NULL`, args: [] }
					: { clause: "AND id = ? AND generation = ?", args: [placement.id, placement.generation] };
		// The ready row is chosen and taken in one statement, so workers racing for the oldest one never conflict: each
		// takes whichever ready row is oldest when its batch runs.
		return guardedPoolWrite(this.storage, async (read, optimistic) => {
			// An optimistic claim reads nothing: its fences check the root's lease, status and control, and a claim one
			// refuses reads them to say whether the root takes no claims now.
			if (!optimistic || compatibleDefinitions.length === 0) {
				const row = await read.get<
					NonNullable<Awaited<ReturnType<SqlPoolQueue["leaseRow"]>>> & { control: string | null }
				>(
					`SELECT l.*, r.status, p.timeout, ${STORE_NOW} AS now, (SELECT state FROM ${this.roots}_control WHERE root = l.run_id) AS control
				FROM ${this.journal.leases} l JOIN ${this.journal.runs} r ON r.run_id = l.run_id LEFT JOIN ${this.roots} p ON p.root = l.run_id WHERE l.run_id = ?`,
					lease.runId,
				);
				const { status } = this.authorityOf(row, lease);
				if (row!.control !== null && row!.control !== "running") return { done: undefined };
				if (status !== "running" || compatibleDefinitions.length === 0) return { done: undefined };
			}
			return {
				fences: [
					this.rootFence(lease),
					{
						sql: `SELECT 1 FROM ${this.journal.runs} WHERE run_id = ? AND status = 'running' AND NOT EXISTS (SELECT 1 FROM ${this.roots}_control WHERE root = ? AND state != 'running')`,
						params: [lease.runId, lease.runId],
					},
				],
				writes: [],
				// Only work this root incarnation enqueued: the root cannot accept an attempt of a child it has not
				// re-enqueued since resuming, so an earlier incarnation's released work waits for its enqueue (#3979).
				reads: [
					{
						sql: `UPDATE ${this.work} SET state = 'leased', generation = generation + 1, worker = ?, epoch = ?, expires_at = ${STORE_NOW} + ?, renewed_at = ${STORE_NOW}
						WHERE id = (SELECT id FROM ${this.work} WHERE root = ? AND state = 'ready' AND epoch = ? AND ready_at <= ${STORE_NOW} AND (${compatible}) ${placed.clause} ORDER BY ready_at, rowid LIMIT 1)
						RETURNING *`,
						params: [
							worker,
							lease.epoch,
							durationMs,
							lease.runId,
							lease.epoch,
							...compatibleDefinitions,
							...placed.args,
						],
					},
				],
				result: ([taken]) => {
					const row = taken![0] as WorkRow | undefined;
					if (row === undefined) return undefined;
					this.attempts.set(row.id, row);
					return fromRow(row);
				},
			};
		});
	}
	/**
	 * The oldest work this root incarnation may hand out now, up to `limit` items, with each item's workspace binding:
	 * what a worker host chooses from before it claims one item by id (shared placement only). Read without the write
	 * lock; a claim re-checks everything.
	 */
	async readyCandidates(
		lease: Lease,
		definitions: readonly Pick<PoolWorkDescriptor, "definition" | "digest">[],
		limit: number,
	): Promise<readonly PoolClaimCandidate[]> {
		if (definitions.length === 0) return [];
		const rows = await this.storage.read((executor) =>
			executor.all<SqliteRow & { id: string; generation: number; workspace: string | null }>(
				`SELECT id, generation, ${WORKSPACE_BINDING} AS workspace FROM ${this.work} WHERE root = ? AND state = 'ready' AND epoch = ? AND ready_at <= ${STORE_NOW} AND (${compatibleClause(definitions.length)}) ORDER BY ready_at, rowid LIMIT ?`,
				lease.runId,
				lease.epoch,
				...definitions.flatMap((d) => [d.definition, d.digest]),
				limit,
			),
		);
		return rows.map((row) => ({
			id: row.id,
			generation: Number(row.generation),
			...(row.workspace === null ? {} : { workspace: JSON.parse(String(row.workspace)) as WorkspaceBinding }),
		}));
	}
	/**
	 * Fails ready work of this root incarnation that no worker may take, as bound work no capable host claimed within
	 * its claim window: no worker claims it again in this incarnation. False when it is no longer that ready work.
	 */
	async failUnclaimed(lease: Lease, token: Pick<PoolWork, "id" | "generation">): Promise<boolean> {
		lease = snapshotLease(lease);
		return this.transaction(async (tx) => {
			await this.authority(tx, lease);
			const failed = await tx.run(
				`UPDATE ${this.work} SET state = 'failed', worker = NULL, expires_at = 0 WHERE id = ? AND root = ? AND state = 'ready' AND generation = ? AND epoch = ?`,
				token.id,
				lease.runId,
				token.generation,
				lease.epoch,
			);
			return failed.changes === 1;
		});
	}
	/**
	 * In `tx`: whether `token` still holds its unexpired work lease in the incarnation that holds the root's lease
	 * `lease`, as every write of an attempt checks it. Returns the database time, or undefined when another attempt,
	 * epoch or nothing holds the work. A root lease that is not `lease` throws {@link StaleLeaseError}. A per-stage lease
	 * is fenced by it: whatever an attempt writes for a stage, it writes only while it holds the stage's work.
	 */
	async attemptStanding(tx: SqliteExecutor, lease: Lease, token: WorkLease): Promise<number | undefined> {
		const { now } = await this.authority(tx, snapshotLease(lease));
		const row = await tx.get<WorkRow>(`SELECT * FROM ${this.work} WHERE id = ? AND root = ?`, token.id, lease.runId);
		return row?.state === "leased" &&
			row.epoch === token.epoch &&
			row.epoch === lease.epoch &&
			row.generation === token.generation &&
			row.worker === token.worker &&
			row.expires_at >= now
			? now
			: undefined;
	}
	/** {@link attemptStanding}, refusing a replaced attempt as every other attempt write does. */
	async assertAttemptIn(tx: SqliteExecutor, lease: Lease, token: WorkLease): Promise<number> {
		const now = await this.attemptStanding(tx, lease, token);
		if (now !== undefined) return now;
		const row = await this.current(tx, lease, token);
		throw staleWork(lease, token, row.epoch === lease.epoch ? "expired" : "epoch-mismatch");
	}
	/** In `tx`: that the root's lease is `lease` and current; the database time. */
	async assertRootIn(tx: SqliteExecutor, lease: Lease): Promise<number> {
		return (await this.authority(tx, snapshotLease(lease))).now;
	}
	private async admitsAttemptWrites(tx: SqliteExecutor, lease: Lease, status: string): Promise<boolean> {
		if (status === "running") return true;
		if (status !== "paused") return false;
		const control = await tx.get(`SELECT state FROM ${this.roots}_control WHERE root = ?`, lease.runId);
		return control?.state === "paused";
	}
	private async current(tx: SqliteExecutor, lease: Lease, token: WorkLease, allowCompleted = false): Promise<WorkRow> {
		const row = await tx.get<WorkRow>(`SELECT * FROM ${this.work} WHERE id = ? AND root = ?`, token.id, lease.runId);
		return this.currentOf(row, lease, token, allowCompleted);
	}
	/** {@link current} of a work row read already. */
	private currentOf(row: WorkRow | undefined, lease: Lease, token: WorkLease, allowCompleted = false): WorkRow {
		if (row === undefined) throw staleWork(lease, token, "missing");
		if (row.state !== "leased" && !(allowCompleted && row.state === "completed"))
			throw staleWork(lease, token, "not-leased");
		if (row.epoch !== token.epoch) throw staleWork(lease, token, "epoch-mismatch");
		if (row.generation !== token.generation) throw staleWork(lease, token, "generation-mismatch");
		if (row.worker !== token.worker) throw staleWork(lease, token, "worker-mismatch");
		return row;
	}
	/** Extend a held attempt's lease. Only the work row changes: a renewal leaves no operation record behind. */
	async renew(lease: Lease, token: WorkLease, durationMs: number): Promise<PoolWork> {
		positive(durationMs);
		lease = snapshotLease(lease);
		token = { ...token };
		await this.remote?.fresh(lease);
		return guardedPoolWrite(
			this.storage,
			(read, optimistic) => this.extension(read, optimistic, lease, token, durationMs, true),
			{
				priority: true,
			},
		);
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
		if (this.remote && mutation.kind !== "session-append")
			return this.commitRemote(lease, token, operationId, mutation, identity);
		// Opened before a batched write, whose plan reads outside any transaction; a journal without batches plans inside
		// the write's own transaction, and opens it there.
		const sessions =
			mutation.kind === "checkpoint" || this.storage.batch === undefined ? undefined : await this.poolSessions();
		const checkpoints = this.checkpoints.begin(lease.runId);
		let recorded: { readonly seq: number; readonly key: string; readonly checkpoint: DurableCheckpoint } | undefined;
		const receipt = await guardedPoolWrite<PoolCommitReceipt>(this.storage, async (read, optimistic) => {
			recorded = undefined;
			const fromCache = optimistic
				? await this.optimisticCheckpoint(lease, token, operationId, mutation)
				: undefined;
			if (fromCache !== undefined) {
				const { write, receiptParts } = fromCache;
				const checkpoint = (mutation as PoolCheckpointMutation).checkpoint;
				write.writes.push({
					sql: `INSERT INTO ${this.operations} SELECT ?, ?, ?, ?, ${receiptParts.sql}`,
					params: [token.id, token.generation, operationId, identity, ...receiptParts.params],
				});
				return {
					...write,
					reads: [
						{
							sql: `SELECT receipt FROM ${this.operations} WHERE work = ? AND generation = ? AND operation = ?`,
							params: [token.id, token.generation, operationId],
						},
					],
					result: ([stored]) => {
						const value = JSON.parse(String(stored![0]!.receipt)) as PoolCommitReceipt;
						recorded = { seq: value.seq!, key: checkpointKey(checkpoint), checkpoint };
						return value;
					},
				};
			}
			const state = await this.attemptState(
				read,
				lease,
				token,
				operationId,
				mutation.kind === "session-append" ? undefined : checkpointKey(mutation.checkpoint),
				mutation.kind === "session-append" ? undefined : checkpoints,
			);
			const { now, status, previous } = state;
			const row = this.currentOf(state.work, lease, token);
			if (row.epoch !== lease.epoch) throw staleWork(lease, token, "epoch-mismatch");
			if (previous) {
				if (previous.request !== identity) throw new Error("Pool operation identity conflict");
				return { done: JSON.parse(previous.receipt) as PoolCommitReceipt };
			}
			if (row.expires_at < now) throw staleWork(lease, token, "expired");
			if (status !== "running" && !(status === "paused" && state.control === "paused"))
				throw staleWork(lease, token, "root-not-running");
			const write: CommitWrite = {
				fences: [
					this.rootFence(lease),
					this.attemptFence(lease, token, true),
					this.admitsFence(lease),
					this.operationFence(token, operationId),
				],
				writes: [],
			};
			const receiptParts =
				mutation.kind === "session-append"
					? await this.appendSession(read, row, mutation, write, sessions ?? (await this.poolSessions(read)))
					: await this.recordCheckpoint(
							read,
							lease,
							row,
							mutation,
							now,
							checkpoints,
							write,
							mutation.kind === "checkpoint" ? undefined : (sessions ?? (await this.poolSessions(read))),
							state.recorded,
						);
			write.writes.push({
				sql: `INSERT INTO ${this.operations} SELECT ?, ?, ?, ?, ${receiptParts.sql}`,
				params: [token.id, token.generation, operationId, identity, ...receiptParts.params],
			});
			return {
				...write,
				reads: [
					{
						sql: `SELECT receipt FROM ${this.operations} WHERE work = ? AND generation = ? AND operation = ?`,
						params: [token.id, token.generation, operationId],
					},
				],
				result: ([stored]) => {
					const value = JSON.parse(String(stored![0]!.receipt)) as PoolCommitReceipt;
					if (mutation.kind !== "session-append" && state.recorded.existing === undefined)
						recorded = {
							seq: value.seq!,
							key: checkpointKey(mutation.checkpoint),
							checkpoint: mutation.checkpoint,
						};
					return value;
				},
			};
		});
		// Only now has the write committed what validation read; a write that never committed never reaches the index.
		checkpoints.commit();
		if (recorded !== undefined)
			this.checkpoints.recordOwn(lease.runId, recorded.seq, recorded.key, recorded.checkpoint);
		return receipt;
	}
	/**
	 * A checkpoint commit planned without a read, for a batched write's first try: from the attempt's work row as this
	 * queue last wrote or read it, and the root's checkpoints as this process knows them. Its fences repeat every check
	 * the read would have made, and one more refuses it if anyone else recorded a checkpoint in the work's scope that the
	 * view lacks. Undefined when that is not enough to decide, so the commit plans from a read instead: no cached row or
	 * view, a session to write, or a check that fails here and might not with what the read would see.
	 */
	private async optimisticCheckpoint(
		lease: Lease,
		token: WorkLease,
		operationId: string,
		mutation: PoolMutation,
	): Promise<{ readonly write: CommitWrite; readonly receiptParts: ReceiptSql } | undefined> {
		if (mutation.kind !== "checkpoint") return undefined;
		const checkpoint = mutation.checkpoint;
		if (checkpoint.kind === "stage" && checkpoint.sessionId) return undefined;
		const row = this.attempts.get(token.id);
		if (
			row === undefined ||
			row.state !== "leased" ||
			Number(row.generation) !== token.generation ||
			row.worker !== token.worker ||
			Number(row.epoch) !== token.epoch ||
			Number(row.epoch) !== lease.epoch
		)
			return undefined;
		const known = this.checkpoints.known(lease.runId);
		if (known === undefined) return undefined;
		const write: CommitWrite = {
			fences: [
				this.rootFence(lease),
				this.attemptFence(lease, token, true),
				this.admitsFence(lease),
				this.operationFence(token, operationId),
			],
			writes: [],
		};
		const unread: SqliteExecutor = {
			get: () => Promise.reject(new Error("An optimistic pool commit reads nothing")),
			all: () => Promise.reject(new Error("An optimistic pool commit reads nothing")),
			run: () => Promise.reject(new Error("An optimistic pool commit reads nothing")),
			exec: () => Promise.reject(new Error("An optimistic pool commit reads nothing")),
		};
		try {
			const receiptParts = await this.recordCheckpoint(
				unread,
				lease,
				row,
				mutation,
				Date.now(),
				known.source,
				write,
				undefined,
				{ head: known.from, own: known.own },
			);
			return { write, receiptParts };
		} catch {
			return undefined;
		}
	}
	/**
	 * A checkpoint commit when the durable journal is in another database. The journal and the pool's tables cannot
	 * share a transaction, so the commit is three steps in an order that makes every crash between them recoverable:
	 *
	 * 1. One local transaction decides, as the single-database commit does, whether the attempt may write at all
	 *    (root lease, work lease, generation, worker, epoch, root status), validates the checkpoint, applies the
	 *    session it carries, bills its usage, and records the accepted event in the outbox. The commit point is here:
	 *    a fenced or stale attempt is refused before anything exists, exactly as before.
	 * 2. The event goes to the durable journal through its own `append`, keyed by the checkpoint's event key. A key is
	 *    recorded once, so repeating this step, after a crash or a lost reply, finds the same event.
	 * 3. One local transaction stores the receipt (the journal's sequence and time) as the operation's result and
	 *    deletes the outbox row.
	 *
	 * The journal therefore never holds an event whose session, billing or fence was not recorded first, and the pool
	 * never has an accepted event the journal will not get: a commit retried with the same operation, the next claim
	 * (which first delivers every outbox row), and a resumed root's coordinator all finish step 2 and 3. Reads of the
	 * journal happen outside the transaction, so nothing waits on the network while holding the local write lock.
	 */
	private commitRemote(
		lease: Lease,
		token: WorkLease,
		operationId: string,
		mutation: PoolCheckpointMutation,
		identity: string,
	): Promise<PoolCommitReceipt> {
		const flight = JSON.stringify([token.id, token.generation, operationId]);
		const running = this.committing.get(flight);
		if (running) return running;
		const commit = this.stageAndDeliver(lease, token, operationId, mutation, identity).finally(() => {
			this.committing.delete(flight);
		});
		this.committing.set(flight, commit);
		return commit;
	}
	private async stageAndDeliver(
		lease: Lease,
		token: WorkLease,
		operationId: string,
		mutation: PoolCheckpointMutation,
		identity: string,
	): Promise<PoolCommitReceipt> {
		const remote = this.remote!;
		await remote.fresh(lease);
		const checkpoint = mutation.checkpoint;
		const key = JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, checkpoint.kind, checkpoint.checkpointId]);
		const reads = this.checkpoints.begin(lease.runId);
		const [existing, view] = await Promise.all([
			remote.entry(lease.runId, key),
			checkpoint.kind === "ui" ? undefined : reads.readEntries(remote.events(lease.runId)),
		]);
		// What the reads saw is the journal's own state, whatever the transaction below decides.
		reads.commit();
		const source: PoolCheckpointSource = {
			read: async () => view ?? Promise.reject(new Error("Pool checkpoint view is unavailable")),
		};
		const staged = await this.transaction(async (tx) => {
			const { now, status } = await this.authority(tx, lease);
			const row = await this.current(tx, lease, token);
			if (row.epoch !== lease.epoch) throw staleWork(lease, token, "epoch-mismatch");
			const previous = await tx.get<SqliteRow & { request: string; receipt: string }>(
				`SELECT * FROM ${this.operations} WHERE work = ? AND generation = ? AND operation = ?`,
				token.id,
				token.generation,
				operationId,
			);
			if (previous) {
				if (previous.request !== identity) throw new Error("Pool operation identity conflict");
				return { receipt: JSON.parse(previous.receipt) as PoolCommitReceipt };
			}
			const held = await tx.get<OutboxRow>(
				`SELECT * FROM ${this.outbox} WHERE work = ? AND generation = ? AND operation = ?`,
				token.id,
				token.generation,
				operationId,
			);
			if (held) {
				if (held.request !== identity) throw new Error("Pool operation identity conflict");
				return { held };
			}
			if (row.expires_at < now) throw staleWork(lease, token, "expired");
			if (!(await this.admitsAttemptWrites(tx, lease, status))) throw staleWork(lease, token, "root-not-running");
			await validatePoolMutation(tx, this.journal, lease.runId, fromRow(row), mutation, source);
			if (checkpoint.completedAt > Math.max(now, Date.now()) + MAX_WORKER_CLOCK_SKEW_MS)
				throw new Error("Pool checkpoint timestamp is in the future");
			assertWorkflowSerializableObject(checkpoint, "Pool checkpoint");
			if (existing && !isRecordedCheckpointValue(existing.event.payload, checkpoint))
				throw new Error("Pool checkpoint identity conflict");
			if (existing && mutation.kind !== "checkpoint") throw new Error("Pool session checkpoint identity conflict");
			const lastSeq =
				mutation.kind === "checkpoint"
					? undefined
					: await applyPoolSession(tx, `${this.journal.runs}_pool_`, row.id, mutation);
			const billed = poolCheckpointUsage(checkpoint);
			if (billed && !existing)
				await upsertPoolUsage(tx, this.journal.runs, row.id, token.generation, billed.key, billed.usage);
			if (existing) {
				const receipt: PoolCommitReceipt = { seq: existing.seq, at: existing.at };
				await tx.run(
					`INSERT INTO ${this.operations} VALUES (?, ?, ?, ?, ?)`,
					token.id,
					token.generation,
					operationId,
					identity,
					JSON.stringify(receipt),
				);
				return { receipt };
			}
			const entry: OutboxRow = {
				work: token.id,
				generation: token.generation,
				operation: operationId,
				request: identity,
				event_key: key,
				payload: serializeJson(checkpoint),
				last_seq: lastSeq ?? null,
			};
			await tx.run(
				`INSERT INTO ${this.outbox} VALUES (?, ?, ?, ?, ?, ?, ?)`,
				entry.work,
				entry.generation,
				entry.operation,
				entry.request,
				entry.event_key,
				entry.payload,
				entry.last_seq,
			);
			return { held: entry };
		});
		if (staged.receipt !== undefined) return staged.receipt;
		this.outboxPending = true;
		return this.deliver(lease, staged.held!);
	}
	/** Steps 2 and 3 of {@link commitRemote} for one accepted event. */
	private async deliver(lease: Lease, held: OutboxRow): Promise<PoolCommitReceipt> {
		const remote = this.remote!;
		const checkpoint = JSON.parse(held.payload) as DurableCheckpoint;
		const outcome = await remote.append(lease, held.event_key, checkpoint);
		const forget = (tx: SqliteExecutor) =>
			tx.run(
				`DELETE FROM ${this.outbox} WHERE work = ? AND generation = ? AND operation = ?`,
				held.work,
				held.generation,
				held.operation,
			);
		if (outcome.status === "exists" && !isRecordedCheckpointValue(outcome.entry.event.payload, checkpoint)) {
			// Another attempt recorded a different checkpoint under this key first; there is nothing left to record.
			await this.transaction(forget);
			throw new Error("Pool checkpoint identity conflict");
		}
		const receipt: PoolCommitReceipt = {
			seq: outcome.entry.seq,
			at: outcome.entry.at,
			...(held.last_seq === null ? {} : { lastSeq: Number(held.last_seq) }),
		};
		await this.transaction(async (tx) => {
			await tx.run(
				`INSERT OR IGNORE INTO ${this.operations} VALUES (?, ?, ?, ?, ?)`,
				held.work,
				held.generation,
				held.operation,
				held.request,
				JSON.stringify(receipt),
			);
			await forget(tx);
		});
		return receipt;
	}
	/**
	 * Delivers every accepted event the durable journal has not recorded for the root, in the order they were accepted
	 * (remote journals only). A coordinator calls it first thing for a root it resumes, and a claim calls it while any
	 * may be held, so no attempt starts before the journal holds what the attempts before it were told is committed.
	 * Calls in flight together share one pass.
	 */
	drainOutbox(lease: Lease): Promise<number> {
		if (!this.remote) return Promise.resolve(0);
		lease = snapshotLease(lease);
		this.draining ??= this.deliverAll(lease).finally(() => {
			this.draining = undefined;
		});
		return this.draining;
	}
	private async deliverAll(lease: Lease): Promise<number> {
		// Cleared before reading, so a commit staging one meanwhile marks it held again.
		this.outboxPending = false;
		const rows = await this.transaction((tx) =>
			tx.all<OutboxRow>(
				`SELECT o.* FROM ${this.outbox} o JOIN ${this.work} w ON w.id = o.work WHERE w.root = ? ORDER BY o.rowid`,
				lease.runId,
			),
		);
		try {
			for (const row of rows) await this.deliver(lease, row);
		} catch (error) {
			this.outboxPending = true;
			throw error;
		}
		return rows.length;
	}
	/**
	 * The session the attempt `row` appends to, planned into `write`: its statements, and a fence on the session's
	 * sequence. Returns the receipt the operation stores, as the SQL that builds it and its parameters.
	 */
	private async appendSession(
		read: SqliteExecutor,
		row: WorkRow,
		mutation: PoolSessionAppend,
		write: CommitWrite,
		sessions: PoolSessions,
	): Promise<ReceiptSql> {
		const lastSeq = await this.planSession(read, row.id, mutation, write, sessions);
		return { sql: `json_object('at', ${STORE_NOW}, 'lastSeq', ?)`, params: [lastSeq] };
	}
	/**
	 * Plans a pool session mutation into `write` as statements, from what `read` sees: the pool's session store runs
	 * against an executor that reads through `read` and records each write. A fence keeps the session where the plan saw
	 * it (absent for a session the mutation creates, at the sequence the mutation expects otherwise); the attempt's work
	 * lease, fenced too, keeps every other writer of the session out. Returns the session's last sequence after it.
	 */
	private async planSession(
		read: SqliteExecutor,
		work: string,
		mutation: PoolSessionMutation | PoolSessionAppend,
		write: CommitWrite,
		store: PoolSessions,
	): Promise<number> {
		const prefix = `${this.journal.runs}_pool_`;
		const sessions = renderStorageIdentifiers("sessions", { sessions: "sessions" }, prefix).sessions;
		const recorder: SqliteExecutor = {
			get: (sql, ...params) => read.get(sql, ...params),
			all: (sql, ...params) => read.all(sql, ...params),
			run: async (sql, ...params) => {
				write.writes.push({ sql, params });
				return { changes: 1 };
			},
			exec: async (sql) => {
				write.writes.push({ sql, params: [] });
			},
		};
		const lastSeq = await store.within.run(recorder, () =>
			applyPoolSession(recorder, prefix, work, mutation, store.store),
		);
		const sessionId = mutation.kind === "session-append" ? mutation.sessionId : mutation.checkpoint.sessionId!;
		write.fences.push(
			mutation.kind === "session-create"
				? { sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${sessions} WHERE id = ?)`, params: [sessionId] }
				: {
						sql: `SELECT 1 FROM ${sessions} WHERE id = ? AND last_seq = ?`,
						params: [sessionId, mutation.expectSeq],
					},
		);
		return lastSeq;
	}
	/**
	 * The pool's session store, opened once with its tables, over a database whose calls go to the executor `within`
	 * holds: a planned commit runs it against its recording executor. `tx`, a write transaction the caller holds, opens it
	 * there instead of in a transaction of its own.
	 */
	private poolSessions(tx?: SqliteExecutor): Promise<PoolSessions> {
		this.sessions ??= (async () => {
			const within = new AsyncLocalStorage<SqliteExecutor>();
			const executor = () => {
				const current = within.getStore();
				if (current === undefined) throw new Error("Pool session store used outside a pool write");
				return current;
			};
			const prefix = `${this.journal.runs}_pool_`;
			const database: SqliteDatabase = {
				descriptor: { adapter: "pool-transaction", location: prefix },
				exec: (sql) => executor().exec(sql),
				run: (sql, ...params) => executor().run(sql, ...params),
				get: (sql, ...params) => executor().get(sql, ...params),
				all: (sql, ...params) => executor().all(sql, ...params),
				transaction: (body) => body(executor()),
				close: async () => {},
			};
			const open = (executor: SqliteExecutor) =>
				within.run(executor, () =>
					new StorageProvider().openSessionStore(
						{ kind: "database", database, prefix },
						{ agentDir: "", domain: "sessions" },
					),
				);
			// In the caller's transaction when it holds one, or in a transaction of its own.
			const store = await (tx === undefined ? this.transaction(open) : open(tx));
			return { store, within };
		})().catch((error: Error) => {
			this.sessions = undefined;
			throw error;
		});
		return this.sessions;
	}
	/**
	 * A checkpoint commit planned into `write`, from what `read` sees: validation against the root's recorded
	 * checkpoints, the session it carries, its event, and its usage. The event's sequence is taken in SQL, so commits of
	 * the root's other children never conflict with it; a fence refuses the write if a checkpoint of this work's scope
	 * was recorded after the read that validation saw. Returns the receipt the operation stores, as SQL.
	 */
	private async recordCheckpoint(
		read: SqliteExecutor,
		lease: Lease,
		row: WorkRow,
		mutation: PoolCheckpointMutation,
		now: number,
		checkpoints: PoolCheckpointSource,
		write: CommitWrite,
		sessions: PoolSessions | undefined,
		/**
		 * The root's latest sequence, and the event this checkpoint's key recorded, as the commit's read saw them; `own`,
		 * the root's events past `head` that the validated view holds already.
		 */
		{
			head,
			existing,
			own = [],
		}: {
			readonly head: number;
			readonly existing?: { seq: number; at: number; payload: string };
			readonly own?: readonly number[];
		},
	): Promise<ReceiptSql> {
		const checkpoint = mutation.checkpoint;
		const events = this.journal.events;
		const key = checkpointKey(checkpoint);
		const work = fromRow(row);
		await validatePoolMutation(read, this.journal, lease.runId, work, mutation, checkpoints);
		if (checkpoint.completedAt > Math.max(now, Date.now()) + MAX_WORKER_CLOCK_SKEW_MS)
			throw new Error("Pool checkpoint timestamp is in the future");
		assertWorkflowSerializableObject(checkpoint, "Pool checkpoint");
		const payload = serializeJson(checkpoint);
		if (existing && !isRecordedCheckpoint(existing.payload, payload))
			throw new Error("Pool checkpoint identity conflict");
		if (existing && mutation.kind !== "checkpoint") throw new Error("Pool session checkpoint identity conflict");
		const lastSeq =
			mutation.kind === "checkpoint" ? undefined : await this.planSession(read, row.id, mutation, write, sessions!);
		if (existing)
			return { sql: "?", params: [JSON.stringify({ seq: Number(existing.seq), at: Number(existing.at) })] };
		journalCounter(lease.runId, "seq", head + 1, "overflow");
		write.fences.push(
			{
				sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${events} WHERE run_id = ? AND key = ?)`,
				params: [lease.runId, key],
			},
			{
				sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${events} WHERE run_id = ? AND seq > ? AND type = ? AND instr(json_extract(key, '$[2]'), ?) = 1 AND seq NOT IN (SELECT value FROM json_each(?)))`,
				params: [lease.runId, head, RUN_EVENT_TYPES.checkpointRecorded, `${work.scope}:`, JSON.stringify(own)],
			},
		);
		write.writes.push({
			sql: `INSERT INTO ${events} SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ${STORE_NOW} FROM ${events} WHERE run_id = ?`,
			params: [lease.runId, lease.epoch, key, RUN_EVENT_TYPES.checkpointRecorded, payload, lease.runId],
		});
		const billed = poolCheckpointUsage(checkpoint);
		if (billed)
			write.writes.push(
				poolUsageUpsert(this.journal.runs, row.id, Number(row.generation), billed.key, billed.usage),
			);
		return {
			sql: `(SELECT json_object('seq', seq, 'at', at${lastSeq === undefined ? "" : ", 'lastSeq', ?"}) FROM ${events} WHERE run_id = ? AND key = ?)`,
			params: [...(lastSeq === undefined ? [] : [lastSeq]), lease.runId, key],
		};
	}
	async complete(lease: Lease, token: WorkLease, result: WorkflowSerializableObject): Promise<void> {
		lease = snapshotLease(lease);
		token = { ...token };
		assertWorkflowSerializableObject(result, "Pool result");
		const payload = serializeJson(result);
		await this.remote?.fresh(lease);
		const writes = [
			{ sql: `INSERT INTO ${this.work}_results VALUES (?, ?)`, params: [token.id, payload] },
			{ sql: `UPDATE ${this.work} SET state = 'completed' WHERE id = ?`, params: [token.id] },
		];
		await guardedPoolWrite(this.storage, async (read, optimistic) => {
			// Planned without a read from the attempt's row as this queue last saw it: the fences repeat every check, and
			// a completion that one refuses is planned again from a read, which names why.
			const cached = this.attempts.get(token.id);
			if (
				optimistic &&
				this.remote === undefined &&
				cached?.state === "leased" &&
				Number(cached.generation) === token.generation &&
				cached.worker === token.worker &&
				Number(cached.epoch) === token.epoch &&
				Number(cached.epoch) === lease.epoch &&
				JSON.parse(payload).runId === fromRow(cached).childRunId
			)
				return {
					fences: [this.rootFence(lease), this.attemptFence(lease, token, true), this.admitsFence(lease)],
					writes,
					result: () => undefined,
				};
			const { now, status } = await this.authority(read, lease);
			const row = await this.current(read, lease, token, true);
			if (row.epoch !== lease.epoch) throw staleWork(lease, token, "epoch-mismatch");
			if (row.state === "completed") {
				const previous = await read.get(`SELECT result FROM ${this.work}_results WHERE work = ?`, token.id);
				if (previous?.result !== payload) throw new Error("Pool result identity conflict");
				return { done: undefined };
			}
			if (row.expires_at < now) throw staleWork(lease, token, "expired");
			if (!(await this.admitsAttemptWrites(read, lease, status))) throw staleWork(lease, token, "root-not-running");
			if (JSON.parse(payload).runId !== fromRow(row).childRunId) throw new Error("Pool result identity mismatch");
			// A child's result is its journal checkpoint: it completes only once every event it was told is committed is.
			if (this.remote && (await read.get(`SELECT 1 AS held FROM ${this.outbox} WHERE work = ? LIMIT 1`, token.id)))
				throw new Error("Pool work has journal events not yet recorded");
			return {
				fences: [
					this.rootFence(lease),
					this.attemptFence(lease, token, true),
					this.admitsFence(lease),
					...(this.remote
						? [
								{
									sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${this.outbox} WHERE work = ?)`,
									params: [token.id],
								},
							]
						: []),
				],
				writes,
				result: () => undefined,
			};
		});
		this.attempts.delete(token.id);
	}
	async result(root: string, id: string): Promise<WorkflowSerializableObject | undefined> {
		return this.storage.read(async (executor) => {
			const row = await executor.get(
				`SELECT r.result FROM ${this.work}_results r JOIN ${this.work} w ON w.id = r.work WHERE w.root = ? AND w.id = ?`,
				root,
				id,
			);
			return row ? (JSON.parse(String(row.result)) as WorkflowSerializableObject) : undefined;
		});
	}
	/**
	 * Makes a child that an earlier incarnation of the root completed claimable again in this one, when `rerun` accepts
	 * its stored result: its result is dropped and its next attempt replays it from its checkpoints, as for work that
	 * incarnation left unfinished (#3979). Returns the reopened work, or undefined when it stays as it is.
	 */
	async reopenCompleted(
		lease: Lease,
		id: string,
		rerun: (result: WorkflowSerializableObject) => boolean,
	): Promise<PoolWork | undefined> {
		lease = snapshotLease(lease);
		return this.transaction(async (tx) => {
			await this.authority(tx, lease);
			const row = await tx.get<WorkRow>(`SELECT * FROM ${this.work} WHERE id = ? AND root = ?`, id, lease.runId);
			if (row?.state !== "completed" || row.epoch >= lease.epoch) return undefined;
			const stored = await tx.get(`SELECT result FROM ${this.work}_results WHERE work = ?`, id);
			if (!stored || !rerun(JSON.parse(String(stored.result)) as WorkflowSerializableObject)) return undefined;
			await tx.run(`DELETE FROM ${this.work}_results WHERE work = ?`, id);
			await tx.run(
				`UPDATE ${this.work} SET state = 'ready', worker = NULL, expires_at = 0, epoch = ? WHERE id = ?`,
				lease.epoch,
				id,
			);
			return fromRow({ ...row, state: "ready", worker: null, expires_at: 0, epoch: lease.epoch });
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
		await this.remote?.fresh(lease);
		return guardedPoolWrite(
			this.storage,
			(read, optimistic) => this.extension(read, optimistic, lease, token, durationMs, false),
			{ priority: true },
		);
	}
	/**
	 * A worker's heartbeat as one write: extends its attempt's lease as {@link extend} does, runs `record` (the
	 * attempt's usage report) under that lease, and reads pool control, so a heartbeat costs one write however much it
	 * carries. A `record` with a batched form (`SqlPoolUsage.recording`) makes it one request, on the journal's priority
	 * lane, so the heartbeat never waits behind the host's other writes.
	 */
	async heartbeat<T>(
		lease: Lease,
		token: WorkLease,
		durationMs: number,
		record: PoolHeartbeatRecord<T>,
	): Promise<{ readonly work: PoolWork; readonly recorded: T; readonly control: PoolControl }> {
		positive(durationMs);
		lease = snapshotLease(lease);
		token = { ...token };
		await this.remote?.fresh(lease);
		const batched = record.batched;
		if (batched === undefined)
			return this.transaction(async (tx) => {
				const work = await this.extendIn(tx, lease, token, durationMs);
				const recorded = await record(tx);
				return { work, recorded, control: await this.controlIn(tx, lease) };
			});
		return guardedPoolWrite(
			this.storage,
			async (read, optimistic) => {
				const extension = await this.extension(read, optimistic, lease, token, durationMs, false);
				const reads = [...extension.reads, ...batched.reads];
				return {
					fences: extension.fences,
					writes: [...extension.writes, ...batched.writes],
					reads: [
						...reads,
						{
							sql: `SELECT state, revision FROM ${this.roots}_control WHERE root = ?`,
							params: [lease.runId],
						},
					],
					result: (rows) => {
						const control = rows.at(-1)![0];
						return {
							work: extension.result(rows.slice(0, extension.reads.length)),
							recorded: batched.result(rows.slice(extension.reads.length, reads.length)),
							control: control
								? { state: control.state as PoolControl["state"], revision: Number(control.revision) }
								: { state: "running", revision: 0 },
						};
					},
				};
			},
			{ priority: true },
		);
	}
	/**
	 * Extending `token`'s lease by `durationMs` from now, never shortening it, as one planned write. An optimistic plan
	 * reads nothing: its fences hold the root's lease and the attempt, and a plan after a broken fence names the refusal.
	 * `unexpired` also refuses an attempt whose lease lapsed, as {@link renew} does; {@link extend} takes one over.
	 */
	private async extension(
		read: SqliteExecutor,
		optimistic: boolean,
		lease: Lease,
		token: WorkLease,
		durationMs: number,
		unexpired: boolean,
	): Promise<{
		readonly fences: readonly SqliteStatement[];
		readonly writes: readonly SqliteStatement[];
		readonly reads: readonly SqliteStatement[];
		readonly result: (rows: readonly SqliteRow[][]) => PoolWork;
	}> {
		if (!optimistic) {
			const { now } = await this.authority(read, lease);
			const row = await this.current(read, lease, token);
			if (row.epoch !== lease.epoch) throw staleWork(lease, token, "epoch-mismatch");
			if (unexpired && row.expires_at < now) throw staleWork(lease, token, "expired");
		}
		return {
			fences: [this.rootFence(lease), this.attemptFence(lease, token, unexpired)],
			writes: [
				{
					sql: `UPDATE ${this.work} SET expires_at = MAX(expires_at, ${STORE_NOW} + ?), renewed_at = ${STORE_NOW} WHERE id = ?`,
					params: [durationMs, token.id],
				},
			],
			reads: [{ sql: `SELECT * FROM ${this.work} WHERE id = ?`, params: [token.id] }],
			result: ([rows]) => {
				const row = rows![0] as WorkRow;
				this.attempts.set(row.id, row);
				return fromRow(row);
			},
		};
	}
	private async extendIn(tx: SqliteExecutor, lease: Lease, token: WorkLease, durationMs: number): Promise<PoolWork> {
		const { now } = await this.authority(tx, lease);
		const row = await this.current(tx, lease, token);
		if (row.epoch !== lease.epoch) throw staleWork(lease, token, "epoch-mismatch");
		const expiresAt = Math.max(Number(row.expires_at), expiry(now, durationMs));
		await tx.run(`UPDATE ${this.work} SET expires_at = ?, renewed_at = ? WHERE id = ?`, expiresAt, now, row.id);
		return { ...fromRow(row), expiresAt, renewedAt: now };
	}
	async releaseExited(lease: Lease, token: WorkLease): Promise<boolean> {
		return this.settleExited(lease, token, "ready");
	}
	/** Fails an exited attempt's work item for this root incarnation: no worker claims it again. */
	async failExited(lease: Lease, token: WorkLease): Promise<boolean> {
		return this.settleExited(lease, token, "failed");
	}
	/**
	 * Puts back work a worker host claimed but never handed to a worker, because the restore of its workspace failed
	 * (#4416): ready again at the generation it had before the claim, so the claim counts as none of the child's
	 * attempts. False when the claim no longer holds the work.
	 */
	async releaseUnplaced(lease: Lease, token: WorkLease): Promise<boolean> {
		return this.settleExited(lease, token, "ready", 1);
	}
	private async settleExited(
		lease: Lease,
		token: WorkLease,
		state: "ready" | "failed",
		rewind: 0 | 1 = 0,
	): Promise<boolean> {
		lease = snapshotLease(lease);
		token = { ...token };
		this.attempts.delete(token.id);
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
			await tx.run(
				`UPDATE ${this.work} SET state = ?, worker = NULL, expires_at = 0, generation = ? WHERE id = ?`,
				state,
				Number(row.generation) - rewind,
				row.id,
			);
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
	 * Settles the work this root left unfinished when its pool closes (#3996): work this incarnation's workers still
	 * hold, and work no worker claimed, ends `failed`, so none stays `ready` or `leased` for a root whose pool is gone.
	 * The `retained` work ids, and earlier incarnations' attempts still leased, keep their leases. A resumed root that
	 * enqueues failed work again replays it.
	 */
	async releaseClosed(lease: Lease, retained: readonly string[] = []): Promise<number> {
		lease = snapshotLease(lease);
		return this.transaction(async (tx) => {
			await this.authority(tx, lease);
			const released = await tx.run(
				`UPDATE ${this.work} SET state = 'failed', worker = NULL, expires_at = 0 WHERE root = ? AND (state = 'ready' OR (state = 'leased' AND epoch = ?)) AND id NOT IN (SELECT value FROM json_each(?))`,
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
	/** Every work item of `root`. A read: each coordinator's recovery asks every half second. */
	async inspect(root: string): Promise<readonly PoolWork[]> {
		return this.storage.read(async (executor) =>
			(await executor.all<WorkRow>(`SELECT * FROM ${this.work} WHERE root = ? ORDER BY ready_at, rowid`, root)).map(
				fromRow,
			),
		);
	}
}

/** The journal key a checkpoint's event is recorded under. */
function checkpointKey(checkpoint: DurableCheckpoint): string {
	return JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, checkpoint.kind, checkpoint.checkpointId]);
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
	return stored === payload || isRecordedCheckpointValue(JSON.parse(stored), JSON.parse(payload) as DurableCheckpoint);
}

/**
 * The pool queue in the database of `journal`, which must be a SQL journal. `remote` is the root's durable journal when
 * that lives in another database.
 */
export function openSqlPoolQueue(journal: RunJournal, remote?: PoolRemoteJournal): Promise<SqlPoolQueue> {
	const storage = sqlPoolStorage(journal);
	if (!storage) return Promise.reject(new Error("Worker pool requires a SQL run journal"));
	return SqlPoolQueue.open(storage, remote);
}
