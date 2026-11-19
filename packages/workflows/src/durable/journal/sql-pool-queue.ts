import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { SnapshotBlobStore, WorktreeSnapshot } from "@bastani/atomic";
import {
	assertStorageSchemaVersion,
	ensureStorageSchema,
	fencedPath,
	readStoredJsonChunks,
	renderStorageIdentifiers,
	type SessionStore,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteStatement,
	type SqliteValue,
	type SqlSnapshotBlobStore,
	STORED_JSON_CHUNK_BYTES,
	type StorageDialect,
	StorageError,
	StorageProvider,
	storedJsonChunks,
	withJournalPayloads,
} from "@bastani/atomic/storage";
import { assertWorkflowSerializableObject } from "../../shared/serializable.js";
import type { WorkflowSerializableObject } from "../../shared/types.js";
import {
	PoolNotInitializedError,
	refusedPoolEnqueue,
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
import {
	locksRows,
	poolReadyChannel,
	poolSchemaLedger,
	poolSessionPrefix,
	type SqlPoolStorage,
	STAGE_OVERVIEW_PAYLOAD_CHARS,
	sqlPoolStorage,
	storedEventPayload,
} from "./internal.js";
import { isWorkflowLeaseExpired } from "./lease-expiry.js";
import { CONFIRMED_OPERATION, HANDOFF_OPERATION } from "./pool-attempt-operations.js";
import {
	PoolCheckpointIndex,
	type PoolCheckpointRead,
	type PoolCheckpointSource,
	withRecorded,
} from "./pool-checkpoint-index.js";
import { guardedPoolWrite, poolFenceSchema, poolWriteBatch } from "./pool-guarded-write.js";
import {
	applyPoolSession,
	type PoolCheckpointMutation,
	type PoolMutation,
	type PoolSessionAppend,
	PoolSessionFold,
	type PoolSessionMutation,
	poolTransactionSessionStore,
	validatePoolMutation,
} from "./pool-mutations.js";
import {
	isRecordedCheckpointValue,
	isRecordedWithoutSnapshots,
	isSameCheckpointValue,
	type PoolRemoteJournal,
} from "./pool-remote-journal.js";
import { poolSchemaPresent } from "./pool-schema-probe.js";
import {
	poolCheckpointUsage,
	poolUsageSchema,
	poolUsageTotalsSeed,
	poolUsageUpsert,
	upsertPoolUsage,
} from "./pool-stage-usage.js";
import { fleetDrainsSchema } from "./sql-fleet.js";
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
const MAX_WORKER_CLOCK_SKEW_MS = 1_000;
/**
 * Version 2 keeps no lease renewal rows and stores a digest, not the full request, per pool operation. Version 3 stores
 * large work inputs and results in chunks (#4965), which a build of version 2 would read as their stubs, so it refuses
 * a pool of version 3.
 */
const POOL_SCHEMA_VERSION = 3;
/** The pool schema before chunked inputs and results; this build upgrades it when it opens the pool. */
const POOL_SCHEMA_VERSION_UNCHUNKED = 2;
/**
 * The revision of the pool queue's tables, indexes and triggers, recorded once they are set up (#5218): raise it with
 * every change to what {@link SqlPoolQueue.open} creates, so a schema an earlier build set up is set up again.
 */
const POOL_SCHEMA_REVISION = 1;
const POOL_READY_SCHEMA_REVISION = 2;

/** The statements that set up a pool's tables (`SqlPoolQueue.schema`). */
interface PoolSchemaStatements {
	readonly meta: string;
	readonly tables: readonly string[];
	readonly chunks: string;
	readonly outbox: string;
	readonly ship: string;
	/** The per-root ready mark and the work-table triggers that advance it, on a store without row locks (#5230). */
	readonly ready: readonly string[];
}
/** Work whose inputs a work row holds only as a stub, by the work this queue read: how many chunks hold them. */
const chunkedInputs = new WeakMap<PoolWork, number>();
/**
 * A work descriptor as its work row stores it, and the chunks of its inputs: inputs whose JSON is longer than one
 * chunk are stored in chunks (#4965) and the row's descriptor holds `{}` for them, keeping every field SQL reads.
 * `whole`: a process of an older build may be reading the pool, so the inputs stay in the row (see `olderBuildLive`).
 */
function storedDescriptor(
	json: string,
	whole: boolean,
): { readonly descriptor: string; readonly chunks: readonly Uint8Array[] } {
	if (whole) return { descriptor: json, chunks: [] };
	const descriptor = JSON.parse(json) as PoolWorkDescriptor;
	const chunks = storedJsonChunks(serializeJson(descriptor.inputs));
	if (chunks === undefined) return { descriptor: json, chunks: [] };
	return { descriptor: serializeJson({ ...descriptor, inputs: {} }), chunks };
}

/** The columns of the pool's operations table, in order. */
const OPERATION_COLUMNS = ["work", "generation", "operation", "request", "receipt"];

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
	/**
	 * The generations of this work's attempts that a worker handed back because the shared store kept refusing them
	 * (#4768): they count as none of the child's attempts. Read by {@link SqlPoolQueue.inspect}; absent elsewhere, and
	 * when there are none.
	 */
	readonly handoffs?: readonly number[];
}
type WorkRow = SqliteRow & {
	id: string;
	root: string;
	descriptor: string;
	/** How many rows of the input chunks table hold the descriptor's inputs; 0 or absent when it holds them. */
	inputs_chunks?: number | null;
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
function workspaceBinding(dialect: StorageDialect): string {
	return dialect.jsonAt({ column: "descriptor" }, "execution", "workspaceBinding");
}
function compatibleClause(dialect: StorageDialect, definitions: number): string {
	return Array.from(
		{ length: definitions },
		() => `(${dialect.jsonText("descriptor", "definition")} = ? AND ${dialect.jsonText("descriptor", "digest")} = ?)`,
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
/** A `blobs-collected` WorkspaceSnapshotError, told by name so this module does not load the snapshot code. */
function isBlobsCollected(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WorkspaceSnapshotError" &&
		(error as Error & { readonly code?: string }).code === "blobs-collected"
	);
}
/**
 * Rejects with a `blobs-collected` WorkspaceSnapshotError when `blobs` no longer hold a blob of `snapshots`, restarting
 * the age of each it holds as storing it again would (#5077).
 */
async function assertSnapshotBlobsHeld(
	blobs: SnapshotBlobStore | undefined,
	snapshots: readonly WorktreeSnapshot[],
): Promise<void> {
	if (blobs === undefined || snapshots.length === 0) return;
	const { snapshotBlobHashes, WorkspaceSnapshotError } = await import("@bastani/atomic");
	for (const hash of [...new Set(snapshots.flatMap((snapshot) => wellFormed(snapshot, snapshotBlobHashes)))])
		if (!(await blobs.refreshBlobs([hash]))) throw new WorkspaceSnapshotError("blobs-collected", hash);
}
/**
 * Reports, as a process warning, a `blobs-collected` WorkspaceSnapshotError for a checkpoint the journal holds without
 * `snapshots`, whose blobs were collected before it reached the journal (#5077).
 */
async function reportCollectedSnapshot(snapshots: readonly WorktreeSnapshot[]): Promise<void> {
	const { snapshotBlobHashes, WorkspaceSnapshotError } = await import("@bastani/atomic");
	const [hash] = snapshots.flatMap((snapshot) => wellFormed(snapshot, snapshotBlobHashes));
	// A checkpoint that asked for no snapshot lost none.
	if (hash !== undefined) process.emitWarning(new WorkspaceSnapshotError("blobs-collected", hash));
}
/** `snapshot`'s blob hashes, or none for a record that is not well formed. */
function wellFormed(snapshot: WorktreeSnapshot, hashesOf: (snapshot: WorktreeSnapshot) => string[]): string[] {
	try {
		return hashesOf(snapshot);
	} catch {
		return [];
	}
}
/** The worktree snapshots a checkpoint records, where it carries a well-formed list of them. */
function carriedSnapshots(checkpoint: DurableCheckpoint): readonly WorktreeSnapshot[] {
	const carried = (checkpoint as { readonly worktreeSnapshots?: unknown }).worktreeSnapshots;
	return Array.isArray(carried) ? (carried as readonly WorktreeSnapshot[]) : [];
}
/**
 * Which ready work a claim may take (shared placement, #4310): only work without a workspace binding, as the root's
 * own workers take it, or exactly one ready item a worker host chose by its binding. Unset: any ready work.
 */
export type PoolClaimPlacement =
	| { readonly kind: "unbound" }
	| {
			readonly kind: "work";
			readonly id: string;
			readonly generation: number;
			/**
			 * The worker host claiming, and the provider instance it runs on: the claim takes nothing once a fleet controller
			 * asked either to drain, though the host has not read the drain yet (#5072).
			 */
			readonly host?: { readonly id: string; readonly providerId?: string | undefined };
	  };
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
/**
 * What a shipped batch's plan validates and fences against: the attempt's work row, the root's latest sequence and the
 * events past it the view holds already, that view, and the payloads its keys recorded already (#4768).
 */
/** A row of a shipped batch, parsed: a checkpoint, or a session write and the checkpoint a create or replace binds with. */
type ParsedShipEvent = PoolShipBatch["events"][number] & {
	readonly checkpoint?: DurableCheckpoint;
	readonly mutation?: PoolSessionMutation | PoolSessionAppend;
};
interface ShipPlan {
	readonly row: WorkRow;
	readonly now: number;
	readonly head: number;
	readonly own: readonly number[];
	readonly source: PoolCheckpointSource;
	readonly existing?: ReadonlyMap<string, string>;
}
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
	/**
	 * The checkpoint is recorded in the host's local journal and not yet in the root's (#4768): the attempt reads it from
	 * its own view until it is shipped.
	 */
	readonly local?: true;
}
/**
 * Checkpoints and pooled stage session writes of one attempt that a worker host ships to the root's journal in one
 * request (#4768), in the order the attempt made them.
 */
export interface PoolShipBatch {
	/** The batch's content address: the same checkpoints of the same attempt are always the same batch. */
	readonly id: string;
	/** The host that ships it, as the ledger and the attempt's watermark record it. */
	readonly host: string;
	readonly events: readonly {
		readonly localSeq: number;
		readonly key: string;
		/** The checkpoint's JSON, as the host accepted it; for a session write, the whole pool mutation's. */
		readonly payload: string;
		/** A write of one of the attempt's pooled stage sessions; absent for a checkpoint. */
		readonly op?: "session-create" | "session-replace" | "session-append";
	}[];
}
/**
 * The audited fenced paths of the pool's hot writes (#5102): on PostgreSQL each runs as one fenced transaction whose
 * fences lock, in this order, the root's lease row (shared), the attempt's work row, the root's run row, and the root's
 * usage totals row; on SQLite and libSQL they run as before.
 */
const CLAIM = { audit: fencedPath("pool-claim") } as const;
const HEARTBEAT = { audit: fencedPath("pool-heartbeat"), priority: true } as const;
const COMMIT = { audit: fencedPath("pool-commit") } as const;
const COMPLETE = { audit: fencedPath("pool-complete") } as const;
function fromRow(row: WorkRow): PoolWork {
	const work: PoolWork = {
		...JSON.parse(row.descriptor),
		id: row.id,
		state: row.state,
		generation: Number(row.generation),
		worker: row.worker,
		epoch: Number(row.epoch),
		expiresAt: Number(row.expires_at),
		renewedAt: Number(row.renewed_at),
	};
	const chunks = Number(row.inputs_chunks ?? 0);
	if (chunks > 0) chunkedInputs.set(work, chunks);
	return work;
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
	/**
	 * The snapshot blobs of this database, when the root's journal is in it: work is queued with a snapshot, and a root
	 * holds its binding's, only while every blob of it is stored (#5077).
	 */
	private readonly blobs?: SqlSnapshotBlobStore;
	/** The snapshot each root's binding carries to its unbound children, while its pool is prepared (#4503). */
	private readonly rootSnapshots: string;
	private readonly transaction: Transaction;
	private readonly journal: JournalTables;
	private readonly dialect: StorageDialect;
	/** The database clock, in integer milliseconds, as SQL. */
	private readonly now: string;
	/** Whether the database runs writes concurrently, so serial writes lock the rows the hot paths write (#5102). */
	private readonly rowLocks: boolean;
	private readonly checkpoints: PoolCheckpointIndex;
	/** The executor a pool session store's calls go to, for every store this queue opens (see `openPoolSessions`). */
	private readonly poolSessionScope = new AsyncLocalStorage<SqliteExecutor>();
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
		const { transaction, tables: journal, dialect } = storage;
		this.transaction = transaction;
		this.journal = journal;
		this.dialect = dialect;
		this.now = dialect.nowMs;
		this.rowLocks = locksRows(dialect);
		this.checkpoints = new PoolCheckpointIndex(dialect);
		this.meta = `${journal.runs}_pool_meta`;
		this.roots = `${journal.runs}_pool`;
		this.work = `${journal.runs}_work`;
		this.operations = `${journal.runs}_pool_operations`;
		this.outbox = `${journal.runs}_pool_outbox`;
		this.rootSnapshots = `${journal.runs}_pool_root_snapshot`;
		// Only a journal in this database holds the blobs of the snapshots queued work carries (#5077).
		this.blobs = remote === undefined ? storage.snapshotBlobs : undefined;
	}
	/**
	 * `remote` is the root's durable journal when it lives in another database than `storage`, whose run and lease rows
	 * then mirror the journal's (see {@link PoolRemoteJournal}). Without it the journal and the pool share `storage`'s
	 * database, and every commit is one transaction in it.
	 */
	static async open(storage: SqlPoolStorage, remote?: PoolRemoteJournal): Promise<SqlPoolQueue> {
		const pool = new SqlPoolQueue(storage, remote);
		const { dialect } = storage;
		const schema = pool.schema();
		// A SQLite schema records no ledger, so its idempotent setup would run, under the write lock, at every open: every
		// pooled child's worker opens the queue, and on a server many hosts share each open held the lock for a dozen
		// round trips while every other writer waited (#4768). A schema that is current opens with reads alone.
		if (await pool.openedWithoutLock(schema)) return pool;
		await storage.transaction(async (tx) => {
			const foreignKeys = dialect.foreignKeysCheck;
			if (Number((await tx.get(foreignKeys.sql, ...foreignKeys.params))?.foreign_keys) !== 1)
				throw new Error("Pool requires SQLite foreign keys");
			const ledger = poolSchemaLedger(storage);
			let setUp = false;
			// A current schema runs no DDL, so a role with only DML privileges opens the pool (#5218).
			await ensureStorageSchema(
				tx,
				dialect,
				{ ledger, domain: "pool-queue", revision: POOL_SCHEMA_REVISION },
				async () => {
					setUp = true;
					await tx.exec(schema.meta);
					const versions = await tx.all(`SELECT version FROM ${pool.meta}`);
					if (versions.length > 1) throw new Error("Corrupt pool schema metadata");
					const version = versions[0]?.version;
					if (version === undefined) await tx.run(`INSERT INTO ${pool.meta} VALUES (?)`, POOL_SCHEMA_VERSION);
					else if (version !== 1 && version !== POOL_SCHEMA_VERSION_UNCHUNKED)
						assertStorageSchemaVersion("journal", version, POOL_SCHEMA_VERSION);
					for (const statements of schema.tables) await tx.exec(statements);
					if (version === 1) await pool.migrateFromVersion1(tx);
					await pool.addChunks(tx, schema.chunks);
				},
			);
			// Set up by an earlier open: the version is read all the same, so a newer schema is refused (#4965).
			if (!setUp) {
				const versions = await tx.all(`SELECT version FROM ${pool.meta}`);
				if (versions.length !== 1) throw new Error("Corrupt pool schema metadata");
				assertStorageSchemaVersion("journal", versions[0]!.version!, POOL_SCHEMA_VERSION);
			}
			if (remote) {
				await ensureStorageSchema(tx, dialect, { ledger, domain: "pool-outbox", revision: 1 }, () =>
					tx.exec(schema.outbox),
				);
				pool.outboxPending = (await tx.get(`SELECT 1 AS held FROM ${pool.outbox} LIMIT 1`)) !== undefined;
			}
			if (!pool.rowLocks) {
				await ensureStorageSchema(
					tx,
					dialect,
					{ ledger, domain: "pool-ready", revision: POOL_READY_SCHEMA_REVISION },
					async () => {
						for (const statement of schema.ready) await tx.exec(statement);
					},
				);
			}
			// The ledger and watermarks a shipping root's hosts write (#4768): a domain of their own, so a pool set up before
			// them gets them once, and a current one runs no DDL.
			await ensureStorageSchema(tx, dialect, { ledger, domain: "pool-ship", revision: 1 }, () =>
				tx.exec(schema.ship),
			);
		});
		return pool;
	}
	/**
	 * The statements that set up the pool's tables, in order: the meta table, then the tables, indexes and triggers in
	 * groups, each sent as one `exec`; the chunk tables that `addChunks` creates; the shipping ledger and watermarks;
	 * and the outbox of a pool whose journal is in another database.
	 */
	private schema(): PoolSchemaStatements {
		const journal = this.storage.tables;
		const { dialect } = this;
		const { int, blob } = dialect.types;
		return {
			meta: `CREATE TABLE IF NOT EXISTS ${this.meta}(version ${int} NOT NULL)`,
			tables: [
				`
				CREATE TABLE IF NOT EXISTS ${this.roots}(root TEXT PRIMARY KEY REFERENCES ${journal.runs}(run_id) ON DELETE CASCADE, timeout ${int} NOT NULL);
				CREATE TABLE IF NOT EXISTS ${this.work}(
					id TEXT PRIMARY KEY, root TEXT NOT NULL REFERENCES ${this.roots}(root) ON DELETE CASCADE,
					boundary TEXT NOT NULL, descriptor TEXT NOT NULL, fingerprint TEXT NOT NULL,
					state TEXT NOT NULL DEFAULT 'ready', generation ${int} NOT NULL DEFAULT 0,
					worker TEXT, epoch ${int} NOT NULL DEFAULT 0, expires_at ${int} NOT NULL DEFAULT 0,
					renewed_at ${int} NOT NULL DEFAULT 0,
					ready_at ${int} NOT NULL, UNIQUE(root, boundary)${dialect.rowOrderColumn}
				);
				CREATE INDEX IF NOT EXISTS ${this.work}_ready ON ${this.work}(root, state, ready_at);
				CREATE INDEX IF NOT EXISTS ${this.work}_expiry ON ${this.work}(state, expires_at);
				CREATE TABLE IF NOT EXISTS ${poolSessionPrefix(this.storage)}session_owners(
					session TEXT PRIMARY KEY, work TEXT NOT NULL REFERENCES ${this.work}(id) ON DELETE CASCADE, replay_key TEXT NOT NULL
				);
				CREATE UNIQUE INDEX IF NOT EXISTS ${this.work}_scope ON ${this.work}(root, ${dialect.jsonIndexText("descriptor", "scope")});
				CREATE UNIQUE INDEX IF NOT EXISTS ${this.work}_child ON ${this.work}(root, ${dialect.jsonIndexText("descriptor", "childRunId")});
				CREATE TABLE IF NOT EXISTS ${this.operations}(
					work TEXT NOT NULL REFERENCES ${this.work}(id) ON DELETE CASCADE,
					generation ${int} NOT NULL, operation TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(work, generation, operation)
				);
				CREATE TABLE IF NOT EXISTS ${this.work}_results(
					work TEXT PRIMARY KEY REFERENCES ${this.work}(id) ON DELETE CASCADE, result TEXT NOT NULL
				);
			`,
				`CREATE TABLE IF NOT EXISTS ${this.roots}_control(
				root TEXT PRIMARY KEY REFERENCES ${this.roots}(root) ON DELETE CASCADE,
				state TEXT NOT NULL DEFAULT 'running', revision ${int} NOT NULL DEFAULT 0
			)`,
				poolUsageSchema(journal.runs, dialect),
				poolFenceSchema(journal.runs, dialect),
				// A worker host's claims check the drains a fleet controller asked for (#5072).
				fleetDrainsSchema(journal.runs, dialect),
				// Keyed by the run, not the pool row: a root records its binding's snapshot before it queues anything.
				`CREATE TABLE IF NOT EXISTS ${this.rootSnapshots}(
				root TEXT PRIMARY KEY REFERENCES ${journal.runs}(run_id) ON DELETE CASCADE,
				epoch ${int} NOT NULL, snapshot TEXT NOT NULL${dialect.rowOrderColumn}
			)`,
			],
			chunks: `
			CREATE TABLE IF NOT EXISTS ${this.work}_input_chunks(
				work TEXT NOT NULL REFERENCES ${this.work}(id) ON DELETE CASCADE, idx ${int} NOT NULL, data ${blob} NOT NULL,
				PRIMARY KEY(work, idx)
			);
			CREATE TABLE IF NOT EXISTS ${this.work}_result_chunks(
				work TEXT NOT NULL REFERENCES ${this.work}_results(work) ON DELETE CASCADE, idx ${int} NOT NULL, data ${blob} NOT NULL,
				PRIMARY KEY(work, idx)
			);
		`,
			ship: `
			CREATE TABLE IF NOT EXISTS ${journal.runs}_ship_batches(
				batch TEXT PRIMARY KEY, work TEXT NOT NULL REFERENCES ${this.work}(id) ON DELETE CASCADE,
				generation ${int} NOT NULL, worker TEXT, epoch ${int} NOT NULL, host TEXT NOT NULL,
				first_local_seq ${int} NOT NULL, last_local_seq ${int} NOT NULL, events ${int} NOT NULL,
				shipped_at ${int} NOT NULL${dialect.rowOrderColumn}
			);
			CREATE INDEX IF NOT EXISTS ${journal.runs}_ship_batches_work ON ${journal.runs}_ship_batches(work, generation);
			CREATE TABLE IF NOT EXISTS ${journal.runs}_ship_watermarks(
				work TEXT PRIMARY KEY REFERENCES ${this.work}(id) ON DELETE CASCADE, generation ${int} NOT NULL,
				host TEXT NOT NULL, last_local_seq ${int} NOT NULL, last_event_key TEXT NOT NULL,
				shipped_at ${int} NOT NULL${dialect.rowOrderColumn}
			);
			`,
			outbox: `CREATE TABLE IF NOT EXISTS ${this.outbox}(
					work TEXT NOT NULL REFERENCES ${this.work}(id) ON DELETE CASCADE,
					generation ${int} NOT NULL, operation TEXT NOT NULL, request TEXT NOT NULL,
					event_key TEXT NOT NULL, payload TEXT NOT NULL, last_seq ${int},
					PRIMARY KEY(work, generation, operation)${dialect.rowOrderColumn}
				)`,
			ready: [
				`CREATE TABLE IF NOT EXISTS ${this.roots}_ready(
					root TEXT PRIMARY KEY REFERENCES ${this.roots}(root) ON DELETE CASCADE,
					revision ${int} NOT NULL DEFAULT 0
				)`,
				...["INSERT", "UPDATE"].map(
					(
						event,
					) => `CREATE TRIGGER IF NOT EXISTS ${this.roots}_ready_${event.toLowerCase()} AFTER ${event} ON ${this.work}
					WHEN NEW.state = 'ready'
					BEGIN
						INSERT INTO ${this.roots}_ready(root, revision) VALUES (NEW.root, 1)
						ON CONFLICT(root) DO UPDATE SET revision = revision + 1;
					END`,
				),
			],
		};
	}
	/**
	 * Opens a pool on a libSQL database whose schema is this build's already with reads alone, which never take the write
	 * lock: every table, index and trigger `schema` creates exists, so do the columns `addChunks` adds, the meta holds
	 * this build's version, and the connection enforces foreign keys. False, having changed nothing, when any of that does
	 * not hold. A database that sends no batches, as a local node:sqlite journal, holds its write lock for no network
	 * round trip and sets up under it as before; a database with versioned migrations checks its ledger under its lock.
	 */
	private async openedWithoutLock(schema: PoolSchemaStatements): Promise<boolean> {
		const { dialect } = this;
		const statements = [
			schema.meta,
			...schema.tables,
			schema.chunks,
			schema.ship,
			...(this.remote ? [schema.outbox] : []),
			...(this.rowLocks ? [] : schema.ready),
		];
		const columns = [
			[this.work, "inputs_chunks"],
			[`${this.work}_results`, "chunks"],
		] as const;
		if (!(await poolSchemaPresent(this.storage, statements, columns))) return false;
		return this.storage.read(async (read) => {
			const foreignKeys = dialect.foreignKeysCheck;
			if (Number((await read.get(foreignKeys.sql, ...foreignKeys.params))?.foreign_keys) !== 1) return false;
			const versions = await read.all(`SELECT version FROM ${this.meta}`);
			if (versions.length !== 1 || versions[0]!.version !== POOL_SCHEMA_VERSION) return false;
			if (this.remote)
				this.outboxPending = (await read.get(`SELECT 1 AS held FROM ${this.outbox} LIMIT 1`)) !== undefined;
			return true;
		});
	}

	/**
	 * Large inputs and results in chunks (#4965): each table's chunk count column, 0 for every row written before it, the
	 * chunk tables, deleted with their work or result, and the pool meta at version 3. Idempotent.
	 */
	private async addChunks(tx: SqliteExecutor, chunks: string): Promise<void> {
		const { int } = this.dialect.types;
		const has = async (table: string, column: string) => {
			const probe = this.dialect.columnExists(table, column);
			return (await tx.get(probe.sql, ...probe.params)) !== undefined;
		};
		if (!(await has(this.work, "inputs_chunks")))
			await tx.exec(`ALTER TABLE ${this.work} ADD COLUMN inputs_chunks ${int} NOT NULL DEFAULT 0`);
		if (!(await has(`${this.work}_results`, "chunks")))
			await tx.exec(`ALTER TABLE ${this.work}_results ADD COLUMN chunks ${int} NOT NULL DEFAULT 0`);
		await tx.exec(chunks);
		await tx.run(`UPDATE ${this.meta} SET version = ? WHERE version < ?`, POOL_SCHEMA_VERSION, POOL_SCHEMA_VERSION);
	}
	/**
	 * Whether JSON this write stores, any of `jsons`, must stay in its row although it may be longer than a chunk: a
	 * process of an older build may be reading the pool and would read its stub (#4965). False at once when every one
	 * is short enough, by its length, to need no chunks.
	 */
	private async keepsWhole(executor: SqliteExecutor, ...jsons: readonly string[]): Promise<boolean> {
		if (jsons.every((json) => json.length * 3 <= STORED_JSON_CHUNK_BYTES)) return false;
		return this.storage.olderBuildLive(executor);
	}
	/** `work` with its inputs read from their chunks when its work row holds only their stub; as it is otherwise. */
	private async withInputs(executor: SqliteExecutor, work: PoolWork): Promise<PoolWork>;
	private async withInputs(executor: SqliteExecutor, work: PoolWork | undefined): Promise<PoolWork | undefined>;
	private async withInputs(executor: SqliteExecutor, work: PoolWork | undefined): Promise<PoolWork | undefined> {
		const chunks = work === undefined ? undefined : chunkedInputs.get(work);
		if (chunks === undefined) return work;
		const inputs = await readStoredJsonChunks(
			executor,
			`SELECT data FROM ${this.work}_input_chunks WHERE work = ? AND idx = ?`,
			[work!.id],
			chunks,
			`Pool work ${work!.id} inputs`,
		);
		return { ...work!, inputs: JSON.parse(inputs) as WorkflowSerializableObject };
	}
	/** Writes a work row's input chunks in the caller's transaction, replacing any it had. */
	private async writeInputChunks(tx: SqliteExecutor, id: string, chunks: readonly Uint8Array[]): Promise<void> {
		await tx.run(`DELETE FROM ${this.work}_input_chunks WHERE work = ?`, id);
		for (const [index, data] of chunks.entries())
			await tx.run(`INSERT INTO ${this.work}_input_chunks VALUES (?, ?, ?)`, id, index, data);
	}
	/** A stored result's JSON, read from its chunks when it is stored in chunks. */
	private async resultJson(
		executor: SqliteExecutor,
		work: string,
		row: SqliteRow & { result?: unknown; chunks?: unknown },
	): Promise<string> {
		const chunks = Number(row.chunks ?? 0);
		if (chunks === 0) return String(row.result);
		return readStoredJsonChunks(
			executor,
			`SELECT data FROM ${this.work}_result_chunks WHERE work = ? AND idx = ?`,
			[work],
			chunks,
			`Pool work ${work} result`,
		);
	}
	/**
	 * The statements that record a checkpoint event of the root `runId` under `key`: its row, at `seq` or, when
	 * undefined, after the root's latest event, and the chunks of a payload longer than one chunk, addressed through the
	 * event's key so that they follow the row in one batch (#4965). `at` is the SQL of its time, with `atParams`.
	 */
	private eventWrites(
		runId: string,
		seq: number | undefined,
		epoch: number,
		key: string,
		payload: string,
		at: string,
		atParams: readonly SqliteValue[],
		value?: DurableCheckpoint,
		/** A process of an older build may be reading the journal: the payload stays in its row (#4965). */
		whole = false,
	): SqliteStatement[] {
		const { events, eventChunks } = this.journal;
		const stored = whole
			? { payload, chunks: [] }
			: storedEventPayload(RUN_EVENT_TYPES.checkpointRecorded, payload, value);
		const columns = "run_id, seq, epoch, key, type, payload, at, chunks";
		const row: SqliteStatement =
			seq === undefined
				? {
						sql: `INSERT INTO ${events} (${columns}) SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ${at}, ? FROM ${events} WHERE run_id = ?`,
						params: [
							runId,
							epoch,
							key,
							RUN_EVENT_TYPES.checkpointRecorded,
							stored.payload,
							...atParams,
							stored.chunks.length,
							runId,
						],
					}
				: {
						sql: `INSERT INTO ${events} (${columns}) VALUES (?, ?, ?, ?, ?, ?, ${at}, ?)`,
						params: [
							runId,
							seq,
							epoch,
							key,
							RUN_EVENT_TYPES.checkpointRecorded,
							stored.payload,
							...atParams,
							stored.chunks.length,
						],
					};
		if (stored.chunks.length === 0) return [row];
		const event = `SELECT seq FROM ${events} WHERE run_id = ? AND key = ?`;
		return [
			row,
			{ sql: `DELETE FROM ${eventChunks} WHERE run_id = ? AND seq = (${event})`, params: [runId, runId, key] },
			...stored.chunks.map((data, index) => ({
				sql: `INSERT INTO ${eventChunks} (run_id, seq, idx, data) SELECT ?, seq, ?, ? FROM ${events} WHERE run_id = ? AND key = ?`,
				params: [runId, index, data, runId, key],
			})),
		];
	}
	/**
	 * The JSON of the root's event under `key`, its payload read from its chunks when it is stored in chunks, or
	 * undefined when the root has none.
	 */
	private async eventPayload(executor: SqliteExecutor, root: string, key: string): Promise<string | undefined> {
		const row = await executor.get<SqliteRow & { run_id: string; seq: number; payload: string; chunks: number }>(
			`SELECT run_id, seq, payload, chunks FROM ${this.journal.events} WHERE run_id = ? AND key = ?`,
			root,
			key,
		);
		if (row === undefined) return undefined;
		return (await withJournalPayloads(executor, this.journal.eventChunks, [row]))[0]!.payload;
	}
	/**
	 * Version 1 stored every lease renewal as an operation row whose receipt was the full work descriptor, and every
	 * commit's full request (entries included) for retry identity. Renewals need no row at all, and a retry only needs
	 * the request's digest, so drop the renewal rows and keep a digest of each remaining request.
	 */
	private async migrateFromVersion1(tx: SqliteExecutor): Promise<void> {
		// Only SQLite pools were ever at version 1, so `rowid` is there.
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
			`SELECT l.*, r.status, p.timeout, ${this.now} AS now FROM ${this.journal.leases} l JOIN ${this.journal.runs} r ON r.run_id = l.run_id LEFT JOIN ${this.roots} p ON p.root = l.run_id WHERE l.run_id = ?`,
			lease.runId,
		);
	}
	/**
	 * On a database that locks rows, locks the rows of `table` that `where` selects for the rest of `tx` (#5102): a serial
	 * write takes the rows the fenced hot paths write before it reads them, in the hot paths' order (work row, then run
	 * row). Nothing on SQLite, whose write transactions already exclude every other writer.
	 */
	private async lockRows(
		tx: SqliteExecutor,
		table: string,
		where: string,
		...params: readonly SqliteValue[]
	): Promise<void> {
		if (this.rowLocks)
			await tx.all(`SELECT 1 FROM ${table} WHERE ${where}${this.dialect.lockClause("update")}`, ...params);
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
		const object = (...entries: (readonly [string, string])[]) => this.dialect.jsonObject(entries);
		const columns = (...names: string[]) => names.map((name) => [name, name] as const);
		const row = await read.get<
			NonNullable<Awaited<ReturnType<SqlPoolQueue["leaseRow"]>>> & {
				control: string | null;
				work_row: string | null;
				previous: string | null;
				head: number | null;
				existing: string | null;
			}
		>(
			`SELECT l.*, r.status, p.timeout, ${this.now} AS now,
			(SELECT state FROM ${this.roots}_control WHERE root = l.run_id) AS control,
			(SELECT ${object(...columns("id", "root", "boundary", "descriptor", "fingerprint", "state", "generation", "worker", "epoch", "expires_at", "renewed_at", "ready_at"))} FROM ${this.work} WHERE id = ? AND root = l.run_id) AS work_row,
			(SELECT ${object(...columns("request", "receipt"))} FROM ${this.operations} WHERE work = ? AND generation = ? AND operation = ?) AS previous,
			(SELECT COALESCE(MAX(seq), 0) FROM ${this.journal.events} WHERE run_id = l.run_id) AS head,
			(SELECT ${object(...columns("seq", "at", "payload", "chunks"))} FROM ${this.journal.events} WHERE run_id = l.run_id AND key = ?) AS existing
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
		const existing =
			row!.existing === null
				? undefined
				: (JSON.parse(row!.existing) as { seq: number; at: number; payload: string; chunks: number });
		// A checkpoint stored in chunks has its stub in the row: the identity check compares the whole payload.
		if (existing !== undefined && Number(existing.chunks) > 0)
			existing.payload = (await this.eventPayload(read, lease.runId, key!))!;
		return {
			now,
			status,
			control: row!.control,
			work: row!.work_row === null ? undefined : (JSON.parse(row!.work_row) as WorkRow),
			previous:
				row!.previous === null ? undefined : (JSON.parse(row!.previous) as { request: string; receipt: string }),
			recorded: { head: Number(row!.head ?? 0), existing },
		};
	}
	/** A fence: `lease` still holds the root, renewed within its pool's window, by the database clock. */
	rootFence(lease: Lease): SqliteStatement {
		return {
			// Key share: a takeover or release of the root's lease, which locks its row first, waits for the write, and the
			// write sees the latest one. A renewal only makes the lease fresher, so it never waits for hot paths (#5102).
			sql: `SELECT 1 FROM ${this.journal.leases} l JOIN ${this.roots} p ON p.root = l.run_id WHERE l.run_id = ? AND l.epoch = ? AND l.holder_id = ? AND ${this.now} - l.renewed_at <= p.timeout${this.dialect.lockClause("key-share")}`,
			params: [lease.runId, lease.epoch, lease.holderId],
		};
	}
	/**
	 * A fence: `token`'s attempt still holds its work in `lease`'s incarnation of the root, unexpired when `unexpired`,
	 * as {@link current} and the expiry checks of each write decided.
	 */
	attemptFence(lease: Lease, token: WorkLease, unexpired: boolean): SqliteStatement {
		return {
			sql: `SELECT 1 FROM ${this.work} WHERE id = ? AND root = ? AND state = 'leased' AND epoch = ? AND epoch = ? AND generation = ? AND ${this.dialect.isNotDistinct("worker", "?")}${unexpired ? ` AND expires_at >= ${this.now}` : ""}${this.dialect.lockClause("update")}`,
			params: [token.id, lease.runId, token.epoch, lease.epoch, token.generation, token.worker],
		};
	}
	/**
	 * Fences: the root's status still admits its attempts' writes, as {@link admitsAttemptWrites} decided. The first locks
	 * the root's run row, `update` for a write that appends to the run's events, which take its next sequence under it;
	 * a status change, which updates that row, waits for the write. The second reads pool control, which a control
	 * change writes under that row's lock: a statement of its own, so it reads what committed before the lock was taken
	 * (a statement waiting for a row lock rechecks only that row, and keeps its earlier view of every other table).
	 */
	private admitsFences(lease: Lease, lock: "update" | "share"): SqliteStatement[] {
		return [
			{
				sql: `SELECT 1 FROM ${this.journal.runs} WHERE run_id = ? AND status IN ('running', 'paused')${this.dialect.lockClause(lock)}`,
				params: [lease.runId],
			},
			{
				sql: `SELECT 1 FROM ${this.journal.runs} r WHERE r.run_id = ? AND (r.status = 'running' OR (r.status = 'paused' AND EXISTS (SELECT 1 FROM ${this.roots}_control c WHERE c.root = r.run_id AND c.state = 'paused')))`,
				params: [lease.runId],
			},
		];
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
	async holdRootSnapshot(lease: Lease, snapshot: WorktreeSnapshot | undefined): Promise<boolean> {
		lease = snapshotLease(lease);
		return this.transaction(async (tx) => {
			const row = await this.leaseRow(tx, lease);
			if (row?.epoch !== lease.epoch || row.holder_id !== lease.holderId)
				throw new StaleLeaseError(lease.runId, lease.epoch, Number(row?.epoch ?? 0));
			const held = snapshot !== undefined && (await this.blobs?.missingBlob(tx, [snapshot])) === undefined;
			if (!held) {
				await tx.run(`DELETE FROM ${this.rootSnapshots} WHERE root = ? AND epoch < ?`, lease.runId, lease.epoch);
				return snapshot === undefined;
			}
			await tx.run(
				`INSERT INTO ${this.rootSnapshots}(root, epoch, snapshot) VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET epoch = excluded.epoch, snapshot = excluded.snapshot`,
				lease.runId,
				lease.epoch,
				JSON.stringify(snapshot),
			);
			return true;
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
			// A claim checks control under the run row, shared: the change waits for claims under way.
			await this.lockRows(tx, this.journal.runs, "run_id = ?", lease.runId);
			await tx.run(
				`INSERT INTO ${this.roots}_control(root, state, revision) VALUES (?, ?, 1)
				ON CONFLICT(root) DO UPDATE SET state = excluded.state, revision = ${this.roots}_control.revision + (${this.dialect.flag(`${this.roots}_control.state != excluded.state`)})`,
				lease.runId,
				state,
			);
			const row = (await tx.get(`SELECT revision FROM ${this.roots}_control WHERE root = ?`, lease.runId))!;
			if (state === "running") await this.notifyReady(tx, lease.runId);
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
			throw refusedPoolEnqueue(new Error("Pool boundary identity mismatch"));
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
		const payload = serializeJson(boundary);
		const fingerprint = workFingerprint(JSON.parse(serializeJson({ ...descriptor })), JSON.parse(payload));
		const key = JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, boundary.kind, boundary.checkpointId]);
		// A journal in another database takes the boundary's start first, as its own idempotent write: a crash before the
		// work row below leaves a start with no work, which the root's resume enqueues again and finds already recorded.
		if (this.remote) await this.recordBoundaryStart(lease, key, boundary);
		const matching = `root = ? AND (boundary = ? OR ${this.dialect.jsonIndexText("descriptor", "scope")} = ? OR ${this.dialect.jsonIndexText("descriptor", "childRunId")} = ?)`;
		// New work in a libSQL database is queued in one request, which holds the write lock for that request only (#4768).
		const queued = await this.enqueueInOneRequest(lease, descriptor, matching, fingerprint, payload, key, options);
		if (queued !== undefined) return queued;
		return this.transaction(async (tx) => {
			const { now } = await this.authority(tx, lease);
			await this.lockRows(tx, this.work, matching, lease.runId, boundaryId, scope, childRunId);
			// Work carries its root's snapshot only while every blob of it is stored (#5077): the child of work queued
			// without one restores as for a capture that was unavailable, never from a snapshot it cannot restore.
			const queued = await this.withStoredSnapshot(tx, descriptor);
			const json = serializeJson({ ...queued });
			const previous = await tx.get<WorkRow>(
				`SELECT * FROM ${this.work} WHERE ${matching}`,
				lease.runId,
				boundaryId,
				scope,
				childRunId,
			);
			if (previous) {
				const requested = withQueuedSnapshot(queued, previous.descriptor);
				const row =
					previous.fingerprint === fingerprint
						? previous
						: await this.rebind(tx, lease, previous, requested, JSON.parse(payload), fingerprint, options);
				await this.claimSessions(tx, lease.runId, row.id, descriptor, options.claimSessions);
				if ((row.state !== "ready" && row.state !== "failed") || row.epoch >= lease.epoch)
					return this.withInputs(tx, fromRow(row));
				// Work of an earlier incarnation becomes claimable again once this root enqueues it (#3979), including
				// work that incarnation failed or left unfinished when its pool closed. It carries the worktree snapshot this
				// incarnation captured (#4492), whose blobs are fresh.
				const stored = storedDescriptor(requested, await this.keepsWhole(tx, requested));
				await tx.run(
					`UPDATE ${this.work} SET state = 'ready', epoch = ?, descriptor = ?, inputs_chunks = ? WHERE id = ?`,
					lease.epoch,
					stored.descriptor,
					stored.chunks.length,
					row.id,
				);
				await this.writeInputChunks(tx, row.id, stored.chunks);
				await this.notifyReady(tx, lease.runId);
				return {
					...fromRow({ ...row, state: "ready", epoch: lease.epoch, descriptor: requested }),
					inputs: descriptor.inputs,
				};
			}
			const siblings = await tx.all<SqliteRow & { scope: string }>(
				`SELECT ${this.dialect.jsonIndexText("descriptor", "scope")} AS scope FROM ${this.work} WHERE root = ?`,
				lease.runId,
			);
			if (siblings.some((item) => scope.startsWith(`${item.scope}:`) || item.scope.startsWith(`${scope}:`)))
				throw refusedPoolEnqueue(new Error("Pool work scopes overlap"));
			const id = randomUUID();
			const whole = await this.keepsWhole(tx, json, payload);
			const stored = storedDescriptor(json, whole);
			await tx.run(
				`INSERT INTO ${this.work}(id, root, boundary, descriptor, fingerprint, epoch, ready_at, inputs_chunks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				lease.runId,
				boundaryId,
				stored.descriptor,
				fingerprint,
				lease.epoch,
				now,
				stored.chunks.length,
			);
			await this.writeInputChunks(tx, id, stored.chunks);
			if (!this.remote) {
				// The run's next sequence, read under its run row as every append to the run does (#5102).
				await this.lockRows(tx, this.journal.runs, "run_id = ?", lease.runId);
				const seq = await tx.get<SqliteRow & { seq: number }>(
					`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${this.journal.events} WHERE run_id = ?`,
					lease.runId,
				);
				const existing = await this.eventPayload(tx, lease.runId, key);
				if (existing !== undefined && existing !== payload)
					throw refusedPoolEnqueue(new Error("Pool boundary identity conflict"));
				if (existing === undefined)
					for (const write of this.eventWrites(
						lease.runId,
						journalCounter(lease.runId, "seq", Number(seq!.seq) + 1, "overflow"),
						lease.epoch,
						key,
						payload,
						"?",
						[now],
						undefined,
						whole,
					))
						await tx.run(write.sql, ...write.params);
			}
			await this.claimSessions(tx, lease.runId, id, descriptor, options.claimSessions);
			await this.notifyReady(tx, lease.runId);
			return {
				...fromRow((await tx.get<WorkRow>(`SELECT * FROM ${this.work} WHERE id = ?`, id))!),
				inputs: descriptor.inputs,
			};
		});
	}
	/**
	 * {@link enqueue} of new work as one request on a database that sends batches (libSQL), planned from a read outside
	 * the write lock: fences repeat everything the plan decided on (the root's lease, no work of the boundary, scope or
	 * child yet, no overlapping scope, the snapshot's blobs stored, and the boundary's event not recorded yet), so the
	 * batch writes exactly what the transaction would, or nothing, and is planned again. Undefined, having written
	 * nothing, for work the transaction handles: work the root queued before (rebound or made claimable again), sessions
	 * to claim, inputs or a descriptor stored in chunks, a pool whose journal is in another database, or a database
	 * without batches.
	 */
	private async enqueueInOneRequest(
		lease: Lease,
		descriptor: PoolWorkDescriptor,
		matching: string,
		fingerprint: string,
		payload: string,
		key: string,
		options: PoolEnqueueOptions,
	): Promise<PoolWork | undefined> {
		if (
			this.storage.batch === undefined ||
			this.remote !== undefined ||
			this.rowLocks ||
			(options.claimSessions !== undefined && options.claimSessions.length > 0)
		)
			return undefined;
		const { boundaryId, childRunId, scope } = descriptor;
		const root = lease.runId;
		const scopeOf = this.dialect.jsonIndexText("descriptor", "scope");
		const handled = Symbol("handled by the transaction");
		const queued = await guardedPoolWrite<PoolWork | typeof handled>(this.storage, async (read) => {
			const { now } = await this.authority(read, lease);
			if (
				await read.get(`SELECT 1 AS held FROM ${this.work} WHERE ${matching}`, root, boundaryId, scope, childRunId)
			)
				return { done: handled };
			const siblings = await read.all<SqliteRow & { scope: string }>(
				`SELECT ${scopeOf} AS scope FROM ${this.work} WHERE root = ?`,
				root,
			);
			if (siblings.some((item) => scope.startsWith(`${item.scope}:`) || item.scope.startsWith(`${scope}:`)))
				throw refusedPoolEnqueue(new Error("Pool work scopes overlap"));
			const withSnapshot = await this.withStoredSnapshot(read, descriptor);
			const json = serializeJson({ ...withSnapshot });
			const whole = await this.keepsWhole(read, json, payload);
			const stored = storedDescriptor(json, whole);
			if (stored.chunks.length > 0) return { done: handled };
			const existing = await this.eventPayload(read, root, key);
			if (existing !== undefined && existing !== payload)
				throw refusedPoolEnqueue(new Error("Pool boundary identity conflict"));
			const head = await read.get<SqliteRow & { seq: number }>(
				`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${this.journal.events} WHERE run_id = ?`,
				root,
			);
			// The sequence is taken in SQL as the batch runs; one past the limit fails here, as the transaction fails.
			journalCounter(root, "seq", Number(head?.seq ?? 0) + 1, "overflow");
			const snapshot = withSnapshot.execution.workspaceSnapshot as unknown as WorktreeSnapshot | undefined;
			const blobsFence = snapshot === undefined ? undefined : this.blobs?.storedFence([snapshot]);
			const notice = this.readyNotice(root);
			const id = randomUUID();
			return {
				fences: [
					this.rootFence(lease),
					{
						sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${this.work} WHERE ${matching})`,
						params: [root, boundaryId, scope, childRunId],
					},
					{
						sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${this.work} WHERE root = ? AND (substr(?, 1, length(${scopeOf}) + 1) = ${scopeOf} || ':' OR substr(${scopeOf}, 1, length(?) + 1) = ? || ':'))`,
						params: [root, scope, scope, scope],
					},
					...(blobsFence === undefined ? [] : [blobsFence]),
					...(existing === undefined
						? [
								{
									sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${this.journal.events} WHERE run_id = ? AND key = ?)`,
									params: [root, key],
								},
							]
						: []),
				],
				writes: [
					{
						sql: `INSERT INTO ${this.work}(id, root, boundary, descriptor, fingerprint, epoch, ready_at, inputs_chunks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
						params: [id, root, boundaryId, stored.descriptor, fingerprint, lease.epoch, now, 0],
					},
					...(existing === undefined
						? this.eventWrites(root, undefined, lease.epoch, key, payload, "?", [now], undefined, whole)
						: []),
					...(notice === undefined ? [] : [notice]),
				],
				reads: [{ sql: `SELECT * FROM ${this.work} WHERE id = ?`, params: [id] }],
				result: ([[row]]) => ({ ...fromRow(row as WorkRow), inputs: descriptor.inputs }),
			};
		});
		return queued === handled ? undefined : queued;
	}
	/**
	 * `work` without the worktree snapshot it carries, which its row no longer carries either: for work a root queued in
	 * this database whose snapshot's blobs, kept in the root's journal in another database, were collected (#5077).
	 */
	async dropWorkSnapshot(work: PoolWork): Promise<PoolWork> {
		await this.transaction(async (tx) => {
			const row = await tx.get<SqliteRow & { descriptor: string }>(
				`SELECT descriptor FROM ${this.work} WHERE id = ?`,
				work.id,
			);
			if (row === undefined) return;
			const { workspaceSnapshot: _missing, ...execution } = (JSON.parse(row.descriptor) as PoolWorkDescriptor)
				.execution;
			const descriptor = { ...(JSON.parse(row.descriptor) as PoolWorkDescriptor), execution };
			await tx.run(`UPDATE ${this.work} SET descriptor = ? WHERE id = ?`, serializeJson(descriptor), work.id);
		});
		const { workspaceSnapshot: _missing, ...execution } = work.execution;
		return { ...work, execution };
	}
	/** `descriptor`, without the worktree snapshot it carries when this database no longer holds a blob of it. */
	private async withStoredSnapshot(tx: SqliteExecutor, descriptor: PoolWorkDescriptor): Promise<PoolWorkDescriptor> {
		const snapshot = descriptor.execution.workspaceSnapshot as unknown as WorktreeSnapshot | undefined;
		if (snapshot === undefined || (await this.blobs?.missingBlob(tx, [snapshot])) === undefined) return descriptor;
		const { workspaceSnapshot: _missing, ...execution } = descriptor.execution;
		return { ...descriptor, execution };
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
		const prefix = poolSessionPrefix(this.storage);
		const sessions = await poolTransactionSessionStore(tx, this.dialect, prefix);
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
				throw refusedPoolEnqueue(new Error("Pool boundary identity conflict"));
			return;
		}
		const outcome = await remote.append(lease, key, boundary);
		if (outcome.status === "exists" && !isSameCheckpointValue(outcome.entry.event.payload, boundary))
			throw refusedPoolEnqueue(new Error("Pool boundary identity conflict"));
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
		if (workFingerprint(asQueued, boundary) !== previous.fingerprint) {
			const error = new Error("Pool boundary identity conflict");
			throw previous.epoch < lease.epoch ? refusedPoolEnqueue(error) : error;
		}
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
			throw refusedPoolEnqueue(
				new Error(
					`Pool boundary identity conflict: child ${requested.childRunId} was queued by an earlier run of root ${lease.runId} with the entry module of worker definition ${requested.definition} at sha256 ${short(queued.digest)}, and the root now runs that module at sha256 ${short(requested.digest)}. Resume root ${lease.runId} from /resume and confirm the edited module, or pass acceptEntryChanges: true in the SDK, to run the child with the edited module, or restore the module.`,
				),
			);
		const stored = storedDescriptor(json, await this.keepsWhole(tx, json));
		await tx.run(
			`UPDATE ${this.work} SET descriptor = ?, fingerprint = ?, inputs_chunks = ? WHERE id = ?`,
			stored.descriptor,
			fingerprint,
			stored.chunks.length,
			previous.id,
		);
		await this.writeInputChunks(tx, previous.id, stored.chunks);
		return { ...previous, descriptor: stored.descriptor, fingerprint, inputs_chunks: stored.chunks.length };
	}
	async claim(
		lease: Lease,
		worker: string,
		definitions: readonly Pick<PoolWorkDescriptor, "definition" | "digest">[],
		durationMs: number,
		placement?: PoolClaimPlacement,
		outboxBlocked?: (error: unknown) => void,
	): Promise<PoolWork | undefined> {
		positive(durationMs);
		lease = snapshotLease(lease);
		const compatibleDefinitions = definitions.flatMap((d) => [d.definition, d.digest]);
		validateText("holderId", worker);
		const compatible = compatibleClause(this.dialect, definitions.length);
		if (this.remote) {
			try {
				while (this.outboxPending || this.draining !== undefined) await this.drainOutbox(lease);
			} catch (error) {
				if (error instanceof StaleLeaseError) {
					await this.remote.fresh(lease);
					throw error;
				}
				outboxBlocked?.(error);
				return undefined;
			}
			await this.remote.fresh(lease);
			try {
				while (this.outboxPending || this.draining !== undefined) await this.drainOutbox(lease);
			} catch (error) {
				if (error instanceof StaleLeaseError) throw error;
				outboxBlocked?.(error);
				return undefined;
			}
		}
		const placed =
			placement === undefined
				? { clause: "", args: [] }
				: placement.kind === "unbound"
					? { clause: `AND ${workspaceBinding(this.dialect)} IS NULL`, args: [] }
					: {
							clause: `AND id = ? AND generation = ? AND NOT EXISTS (SELECT 1 FROM ${this.journal.runs}_fleet_drains WHERE host = CAST(? AS TEXT) OR provider_id = CAST(? AS TEXT))`,
							args: [
								placement.id,
								placement.generation,
								placement.host?.id ?? null,
								placement.host?.providerId ?? null,
							],
						};
		// The ready row is chosen and taken in one statement, so workers racing for the oldest one never conflict: each
		// takes whichever ready row is oldest when its batch runs. Inputs stored in chunks are read after it (#4965):
		// a work item's inputs never change once it is queued.
		const claimed = await guardedPoolWrite(
			this.storage,
			async (read, optimistic, afterUnknown) => {
				// A claim whose answer was lost may have taken a row: a leased row of this worker that this queue does not know
				// of is that claim's, and is handed out instead of a second one.
				if (afterUnknown) {
					const held = await read.all<WorkRow>(
						`SELECT * FROM ${this.work} WHERE root = ? AND state = 'leased' AND worker = ? AND epoch = ? ORDER BY generation DESC`,
						lease.runId,
						worker,
						lease.epoch,
					);
					const lost = held.find(
						(row) => Number(this.attempts.get(row.id)?.generation) !== Number(row.generation),
					);
					if (lost !== undefined) {
						this.attempts.set(lost.id, lost);
						return { done: fromRow(lost) };
					}
				}
				// An optimistic claim reads nothing: its fences check the root's lease, status and control, and a claim one
				// refuses reads them to say whether the root takes no claims now.
				if (!optimistic || compatibleDefinitions.length === 0) {
					const row = await read.get<
						NonNullable<Awaited<ReturnType<SqlPoolQueue["leaseRow"]>>> & { control: string | null }
					>(
						`SELECT l.*, r.status, p.timeout, ${this.now} AS now, (SELECT state FROM ${this.roots}_control WHERE root = l.run_id) AS control
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
						// The run row, shared: a status change, or a control change, which takes the row first, waits for the
						// claim. Control is read in a statement of its own, after the lock: see `admitsFences`.
						{
							sql: `SELECT 1 FROM ${this.journal.runs} WHERE run_id = ? AND status = 'running'${this.dialect.lockClause("share")}`,
							params: [lease.runId],
						},
						{
							sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${this.roots}_control WHERE root = ? AND state != 'running')`,
							params: [lease.runId],
						},
					],
					writes: [],
					// Only work this root incarnation enqueued: the root cannot accept an attempt of a child it has not
					// re-enqueued since resuming, so an earlier incarnation's released work waits for its enqueue (#3979).
					reads: [
						{
							sql: `WITH clock AS (SELECT ${this.now} AS now) UPDATE ${this.work} SET state = 'leased', generation = generation + 1, worker = ?, epoch = ?, expires_at = (SELECT now FROM clock) + ?, renewed_at = (SELECT now FROM clock)
						WHERE id = (SELECT id FROM ${this.work} WHERE root = ? AND state = 'ready' AND epoch = ? AND ready_at <= ${this.now} AND (${compatible}) ${placed.clause} ORDER BY ready_at, ${this.dialect.rowOrder()} LIMIT 1${this.dialect.lockClause("update-skip-locked")})
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
			},
			CLAIM,
		);
		if (claimed === undefined || !chunkedInputs.has(claimed)) return claimed;
		return this.storage.read((executor) => this.withInputs(executor, claimed));
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
				`SELECT id, generation, ${workspaceBinding(this.dialect)} AS workspace FROM ${this.work} WHERE root = ? AND state = 'ready' AND epoch = ? AND ready_at <= ${this.now} AND (${compatibleClause(this.dialect, definitions.length)}) ORDER BY ready_at, ${this.dialect.rowOrder()} LIMIT ?`,
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
	async acceptsClaim(
		lease: Lease,
		host: { readonly id: string; readonly providerId?: string },
	): Promise<"accepted" | "control" | "drain"> {
		lease = snapshotLease(lease);
		const requested = { ...host };
		await this.remote?.fresh(lease);
		return this.storage.read(async (read) => {
			const available = this.dialect.flag(
				`NOT EXISTS (SELECT 1 FROM ${this.journal.runs}_fleet_drains WHERE host = CAST(? AS TEXT) OR provider_id = CAST(? AS TEXT))`,
			);
			const row = await read.get<
				NonNullable<Awaited<ReturnType<SqlPoolQueue["leaseRow"]>>> & {
					control: string | null;
					host_available: number | bigint;
				}
			>(
				`SELECT l.*, r.status, p.timeout, ${this.now} AS now,
				(SELECT state FROM ${this.roots}_control WHERE root = l.run_id) AS control,
				${available} AS host_available
				FROM ${this.journal.leases} l JOIN ${this.journal.runs} r ON r.run_id = l.run_id
				LEFT JOIN ${this.roots} p ON p.root = l.run_id WHERE l.run_id = ?`,
				requested.id,
				requested.providerId ?? null,
				lease.runId,
			);
			const { status } = this.authorityOf(row, lease);
			if (status !== "running" || (row!.control !== null && row!.control !== "running")) return "control";
			return Number(row!.host_available) === 1 ? "accepted" : "drain";
		});
	}

	async readyMark(root: string): Promise<string | undefined> {
		const readiness = this.rowLocks
			? "bit_xor(hash_record_extended(ROW(xmin, ctid), 0))"
			: `(SELECT revision FROM ${this.roots}_ready WHERE root = ?)`;
		const row = await (this.storage.peek ?? this.storage.read)((executor) =>
			executor.get<
				SqliteRow & {
					ready: number | bigint;
					latest: number | bigint | null;
					readiness: number | bigint | string | null;
					revision: number | bigint | null;
				}
			>(
				`SELECT COUNT(*) AS ready, MAX(ready_at) AS latest,
				${readiness} AS readiness,
				(SELECT revision FROM ${this.roots}_control WHERE root = ?) AS revision
				FROM ${this.work} WHERE root = ? AND state = 'ready' AND ready_at <= (SELECT ${this.now})`,
				...(this.rowLocks ? [] : [root]),
				root,
				root,
			),
		);
		return row === undefined || Number(row.ready) === 0
			? undefined
			: `${row.ready}:${row.latest}:${row.readiness ?? 0}:${row.revision ?? 0}`;
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
	/**
	 * The state the root's journal holds a pooled stage session in, for an attempt of `workId` that writes it for the first
	 * time though an earlier attempt of the work wrote it (#4768): its last sequence and the stage its owner row binds it
	 * to. Read without the write lock. Rejects as a commit of a write to it would: a session the journal does not hold, or
	 * one another work owns.
	 */
	async poolSessionState(
		workId: string,
		sessionId: string,
	): Promise<{ readonly lastSeq: number; readonly replayKey: string }> {
		const prefix = poolSessionPrefix(this.storage);
		const sessions = renderStorageIdentifiers("sessions", { sessions: "sessions" }, prefix).sessions;
		const { owner, row } = await this.storage.read(async (read) => ({
			owner: await read.get(`SELECT work, replay_key FROM ${prefix}session_owners WHERE session = ?`, sessionId),
			row: await read.get(`SELECT last_seq FROM ${sessions} WHERE id = ?`, sessionId),
		}));
		if (row === undefined)
			throw Object.assign(new Error(`Session not found: ${sessionId}`), { name: "SessionNotFoundError", sessionId });
		if (owner?.work !== workId) throw new Error("Pool session scope mismatch");
		return { lastSeq: Number(row.last_seq), replayKey: String(owner.replay_key) };
	}
	/**
	 * Rejects with a `blobs-collected` WorkspaceSnapshotError when this database no longer holds a blob of the worktree
	 * snapshots `checkpoint` records, as a commit of it would: a host checks them before it keeps the checkpoint to ship
	 * later (#4768). Read without the write lock; the batch that ships the checkpoint checks them again.
	 */
	async assertSnapshotsStored(checkpoint: DurableCheckpoint): Promise<void> {
		const snapshots = carriedSnapshots(checkpoint);
		if (snapshots.length === 0 || this.blobs === undefined) return;
		await this.storage.read((read) => this.blobs!.assertStored(read, snapshots));
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
			HEARTBEAT,
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
			mutation.kind === "checkpoint" || poolWriteBatch(this.storage, COMMIT) === undefined
				? undefined
				: await this.poolSessions();
		const checkpoints = this.checkpoints.begin(lease.runId);
		// A checkpoint records its worktree snapshots only while every blob of them is stored (#5077): the plan that
		// reads checks them, and a fence repeats the check in the request that writes it.
		const snapshots = mutation.kind === "checkpoint" ? carriedSnapshots(mutation.checkpoint) : [];
		const blobsFence = this.blobs?.storedFence(snapshots);
		let recorded: { readonly seq: number; readonly key: string; readonly checkpoint: DurableCheckpoint } | undefined;
		const receipt = await guardedPoolWrite<PoolCommitReceipt>(
			this.storage,
			async (read, optimistic) => {
				recorded = undefined;
				const fromCache = optimistic
					? await this.optimisticCheckpoint(lease, token, operationId, mutation)
					: undefined;
				if (fromCache !== undefined) {
					const { write, receiptParts } = fromCache;
					if (blobsFence !== undefined) write.fences.push(blobsFence);
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
				await this.blobs?.assertStored(read, snapshots);
				const write: CommitWrite = {
					// The run row last, and only as long as the write needs it: a session append adds no event.
					fences: [
						this.rootFence(lease),
						this.attemptFence(lease, token, true),
						this.operationFence(token, operationId),
						...this.admitsFences(lease, mutation.kind === "session-append" ? "share" : "update"),
						...(blobsFence === undefined ? [] : [blobsFence]),
					],
					writes: [],
				};
				// A journal without batches opens the session store in this write's transaction, for this write only.
				const own =
					sessions === undefined && mutation.kind !== "checkpoint" ? await this.poolSessions(read) : undefined;
				let receiptParts: ReceiptSql;
				try {
					const store = sessions ?? own;
					receiptParts =
						mutation.kind === "session-append"
							? await this.appendSession(read, row, mutation, write, store!)
							: await this.recordCheckpoint(
									read,
									lease,
									row,
									mutation,
									now,
									checkpoints,
									write,
									store,
									state.recorded,
								);
				} finally {
					await own?.store.close();
				}
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
			},
			// A commit that records snapshots checks their blobs under the database-wide lock shared: snapshot garbage
			// collection deletes blobs under it exclusively, so it cannot delete one between the check and the commit.
			blobsFence === undefined ? COMMIT : { ...COMMIT, excludesSerial: true },
		);
		// Only now has the write committed what validation read; a write that never committed never reaches the index.
		checkpoints.commit();
		if (recorded !== undefined)
			this.checkpoints.recordOwn(lease.runId, recorded.seq, recorded.key, recorded.checkpoint);
		return receipt;
	}
	/**
	 * Records an attempt's batch, which its host accepted in its local journal, in the root's journal (#4768), as one
	 * request: on SQLite and libSQL one batch, on PostgreSQL one fenced transaction. Its fences are those of a commit,
	 * checked once for the whole batch (the root's lease, the attempt's work lease, the root's status, no checkpoint of
	 * the attempt's scope recorded since the view validation used, none of the batch's keys recorded already, each
	 * session the batch writes where the batch's plan saw it, and the blobs of the snapshots it records), and its events
	 * go in with one multi-row insert that takes the run's next sequences under the run row. Each checkpoint is validated
	 * against the root's checkpoints and those before it in the batch.
	 *
	 * A batch also carries the attempt's pooled stage session writes, in the order the attempt made them among its
	 * checkpoints: each session's are folded into one write ({@link PoolSessionFold}) and checked as a commit checks
	 * them, and a checkpoint after a session's create is checked against the owner the batch creates. A checkpoint that
	 * bills usage records it, as a commit does; usage is kept per attempt and stage at the larger of each value, so the
	 * usage the host recorded as it accepted the checkpoint is not counted twice. A checkpoint whose snapshot blobs the
	 * store no longer holds is recorded without its snapshots, as a commit that found them collected would be, and the
	 * `blobs-collected` WorkspaceSnapshotError is reported as a process warning.
	 *
	 * Its first plan reads nothing it can skip: it validates against the checkpoints this queue knows of the root, as a
	 * commit's first plan does, and a fence that no longer holds plans it again from one read. A batch is delivered once:
	 * its id in the ledger means it was, so a retry after a lost answer writes nothing. A checkpoint the root holds
	 * already with the same payload is not recorded again; with another payload it is an identity conflict. Refused with
	 * {@link StaleWorkLeaseError}, writing nothing, once another attempt owns the work.
	 */
	async shipBatch(lease: Lease, token: WorkLease, batch: PoolShipBatch): Promise<void> {
		lease = snapshotLease(lease);
		token = { ...token };
		if (batch.events.length === 0) return;
		if (this.remote) throw new Error("A pool whose root journal is in another database does not ship checkpoints");
		validateText("key", batch.id);
		const runs = this.journal.runs;
		const parsed = batch.events.map((event): ParsedShipEvent => {
			if (event.op === undefined) {
				const checkpoint = JSON.parse(event.payload) as DurableCheckpoint;
				if (checkpointKey(checkpoint) !== event.key) throw new Error("Pool checkpoint identity conflict");
				return { ...event, checkpoint };
			}
			const mutation = JSON.parse(event.payload) as PoolSessionMutation | PoolSessionAppend;
			if (mutation?.kind !== event.op) throw new Error("Invalid pool mutation");
			if (mutation.kind === "session-append") return { ...event, mutation };
			if (checkpointKey(mutation.checkpoint) !== event.key) throw new Error("Pool checkpoint identity conflict");
			return { ...event, mutation, checkpoint: mutation.checkpoint };
		});
		// The keys the root's journal records events under: every row's but a session append's, which records none.
		const eventKeys = parsed.flatMap((event) => (event.checkpoint === undefined ? [] : [event.key]));
		const snapshotted = parsed.some(
			(event) => event.checkpoint !== undefined && carriedSnapshots(event.checkpoint).length > 0,
		);
		// Opened before a batched write, whose plan reads outside any transaction; a journal without batches plans inside
		// the write's own transaction, and opens it there.
		const sessionWrites = parsed.some((event) => event.mutation !== undefined);
		const sessions =
			!sessionWrites || poolWriteBatch(this.storage, COMMIT) === undefined ? undefined : await this.poolSessions();
		const checkpoints = this.checkpoints.begin(lease.runId);
		const shipped = { sql: `SELECT 1 FROM ${runs}_ship_batches WHERE batch = ?`, params: [batch.id] };
		const owners = `${poolSessionPrefix(this.storage)}session_owners`;
		let recorded: { readonly seq: number; readonly key: string; readonly checkpoint: DurableCheckpoint }[] = [];
		let collected: (readonly WorktreeSnapshot[])[] = [];
		const seqs = await guardedPoolWrite<ReadonlyMap<string, number>>(
			this.storage,
			async (read, optimistic) => {
				/** A plan from what `read` sees; undefined when the batch is shipped already. */
				const fromRead = async (): Promise<ShipPlan | undefined> => {
					const state = await this.attemptState(read, lease, token, `ship:${batch.id}`, undefined, checkpoints);
					if ((await read.get(shipped.sql, ...shipped.params)) !== undefined) return undefined;
					const { now, status } = state;
					const row = this.currentOf(state.work, lease, token);
					if (row.epoch !== lease.epoch) throw staleWork(lease, token, "epoch-mismatch");
					if (row.expires_at < now) throw staleWork(lease, token, "expired");
					if (status !== "running" && !(status === "paused" && state.control === "paused"))
						throw staleWork(lease, token, "root-not-running");
					return {
						row,
						now,
						head: state.recorded.head,
						own: [],
						source: checkpoints,
						existing:
							eventKeys.length === 0 ? new Map() : await this.recordedPayloads(read, lease.runId, eventKeys),
					};
				};
				/** Each row of the batch validated against `plan`, with how it is stored. */
				const validated = async (plan: ShipPlan) => {
					recorded = [];
					collected = [];
					const work = fromRow(plan.row);
					// The root's checkpoints, read once for the whole batch: each checkpoint validates against them and those
					// before it in the batch.
					const view = await plan.source.read(read, this.journal.events);
					const source: PoolCheckpointSource = { read: async () => view };
					const folded = new PoolSessionFold(work.id, async (session) => {
						const owner = await read.get(`SELECT work, replay_key FROM ${owners} WHERE session = ?`, session);
						return owner === undefined
							? undefined
							: { work: String(owner.work), replay_key: String(owner.replay_key) };
					});
					const rows: { key: string; payload: string; chunks: readonly Uint8Array[] }[] = [];
					const billed: NonNullable<ReturnType<typeof poolCheckpointUsage>>[] = [];
					const kept: WorktreeSnapshot[] = [];
					for (const event of parsed) {
						if (event.mutation?.kind === "session-append") {
							await folded.add(event.mutation);
							continue;
						}
						const checkpoint: DurableCheckpoint = event.checkpoint!;
						const existing = plan.existing?.get(event.key);
						if (existing !== undefined) {
							if (event.mutation !== undefined) throw new Error("Pool session checkpoint identity conflict");
							if (!isRecordedCheckpoint(existing, event.payload))
								throw new Error("Pool checkpoint identity conflict");
							continue;
						}
						await validatePoolMutation(
							read,
							this.storage,
							lease.runId,
							work,
							event.mutation ?? { kind: "checkpoint", checkpoint },
							recorded.length === 0 ? source : withRecorded(source, recorded),
							(session) => folded.owner(session),
						);
						if (checkpoint.completedAt > Math.max(plan.now, Date.now()) + MAX_WORKER_CLOCK_SKEW_MS)
							throw new Error("Pool checkpoint timestamp is in the future");
						assertWorkflowSerializableObject(event.checkpoint, "Pool checkpoint");
						if (event.mutation !== undefined) await folded.add(event.mutation);
						const usage = poolCheckpointUsage(checkpoint);
						if (usage !== undefined) billed.push(usage);
						// A snapshot is recorded only while every blob of it is stored: the batch's fence checks them again.
						const snapshots = carriedSnapshots(checkpoint);
						const missing = snapshots.length === 0 ? undefined : await this.blobs?.missingBlob(read, snapshots);
						// A session write's row carries the whole mutation: its event records only the checkpoint it binds with.
						let stored = {
							checkpoint,
							payload: event.mutation === undefined ? event.payload : serializeJson(event.checkpoint),
						};
						if (missing === undefined) kept.push(...snapshots);
						else {
							const { worktreeSnapshots: _collected, ...bare } = checkpoint as DurableCheckpoint & {
								readonly worktreeSnapshots?: unknown;
							};
							stored = {
								checkpoint: bare as DurableCheckpoint,
								payload: serializeJson(bare as Parameters<typeof serializeJson>[0]),
							};
							collected.push(snapshots);
						}
						// Positions past the head, in order: what validation of the next checkpoint in the batch sees.
						recorded.push({
							seq: plan.head + recorded.length + 1,
							key: event.key,
							checkpoint: stored.checkpoint,
						});
						const chunked = storedEventPayload(
							RUN_EVENT_TYPES.checkpointRecorded,
							stored.payload,
							stored.checkpoint,
						);
						const row =
							chunked.chunks.length > 0 && (await this.storage.olderBuildLive(read))
								? { payload: stored.payload, chunks: [] }
								: chunked;
						rows.push({ key: event.key, payload: row.payload, chunks: row.chunks });
					}
					return { work, rows, sessions: folded.writes(), billed, kept };
				};
				let plan: ShipPlan | undefined;
				const cached = this.attempts.get(token.id);
				const known = this.checkpoints.known(lease.runId);
				if (
					optimistic &&
					known !== undefined &&
					cached?.state === "leased" &&
					Number(cached.generation) === token.generation &&
					cached.worker === token.worker &&
					Number(cached.epoch) === token.epoch &&
					Number(cached.epoch) === lease.epoch
				)
					// Every check it skips, a fence repeats: a batch shipped already, or one of its keys recorded, breaks one, and
					// the plan that follows reads why.
					plan = { row: cached, now: Date.now(), head: known.from, own: known.own, source: known.source };
				// A plan without a read validates against the cached view of the root, which may predate what the batch
				// depends on, such as the start of a child the root began since this queue last read it (#4768): only a plan
				// from a read may refuse the batch.
				const checked = plan === undefined ? undefined : await validated(plan).catch(() => undefined);
				if (checked === undefined) plan = await fromRead();
				if (plan === undefined) return { done: new Map() };
				const { work, rows, sessions: sessionsOf, billed, kept } = checked ?? (await validated(plan));
				const keys = rows.map((row) => row.key);
				const first = batch.events[0]!;
				const last = batch.events.at(-1)!;
				const blobsFence = this.blobs?.storedFence(kept);
				const write: CommitWrite = {
					fences: [
						this.rootFence(lease),
						this.attemptFence(lease, token, true),
						...this.admitsFences(lease, "update"),
						{ sql: `SELECT 1 WHERE NOT EXISTS (${shipped.sql})`, params: shipped.params },
						...(blobsFence === undefined ? [] : [blobsFence]),
					],
					writes: [],
				};
				if (rows.length > 0) {
					journalCounter(lease.runId, "seq", plan.head + rows.length, "overflow");
					write.fences.push(
						{
							sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${this.journal.events} WHERE run_id = ? AND key IN (${keys.map(() => "?").join(", ")}))`,
							params: [lease.runId, ...keys],
						},
						this.scopeFence(lease, work.scope, plan.head, plan.own),
					);
					write.writes.push(...this.shippedEventWrites(lease, rows));
				}
				if (sessionsOf.length > 0) {
					// A journal without batches opens the session store in this write's transaction, for this write only.
					const own = sessions === undefined ? await this.poolSessions(read) : undefined;
					try {
						for (const session of sessionsOf)
							await this.planSession(read, work.id, session, write, (sessions ?? own)!);
					} finally {
						await own?.store.close();
					}
				}
				// Where writes run concurrently, the root's totals row exists before the usage's trigger adds to it (#5102).
				if (billed.length > 0 && this.rowLocks)
					write.writes.push(poolUsageTotalsSeed(this.dialect, this.journal.runs, lease.runId));
				for (const usage of billed)
					write.writes.push(
						poolUsageUpsert(this.dialect, runs, work.id, Number(token.generation), usage.key, usage.usage),
					);
				write.writes.push(
					{
						sql: `INSERT INTO ${runs}_ship_batches(batch, work, generation, worker, epoch, host, first_local_seq, last_local_seq, events, shipped_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${this.now})`,
						params: [
							batch.id,
							token.id,
							token.generation,
							token.worker,
							token.epoch,
							batch.host,
							first.localSeq,
							last.localSeq,
							batch.events.length,
						],
					},
					{
						sql: `INSERT INTO ${runs}_ship_watermarks(work, generation, host, last_local_seq, last_event_key, shipped_at)
						VALUES (?, ?, ?, ?, ?, ${this.now})
						ON CONFLICT(work) DO UPDATE SET generation = excluded.generation, host = excluded.host,
							last_local_seq = excluded.last_local_seq, last_event_key = excluded.last_event_key,
							shipped_at = excluded.shipped_at`,
						params: [token.id, token.generation, batch.host, last.localSeq, last.key],
					},
				);
				return {
					...write,
					// The sequences the batch's events took, so the next batch validates against them without a read.
					reads:
						rows.length === 0
							? []
							: [
									{
										sql: `SELECT key, seq FROM ${this.journal.events} WHERE run_id = ? AND key IN (${keys.map(() => "?").join(", ")})`,
										params: [lease.runId, ...keys],
									},
								],
					result: (read) => new Map((read[0] ?? []).map((row) => [String(row.key), Number(row.seq)] as const)),
				};
			},
			// A batch that records snapshots checks their blobs under the database-wide lock shared, as a commit does.
			snapshotted ? { ...COMMIT, excludesSerial: true } : COMMIT,
		);
		// Only now has the write committed what validation read; a write that never committed never reaches the index.
		checkpoints.commit();
		for (const entry of recorded) {
			const seq = seqs.get(entry.key);
			if (seq !== undefined) this.checkpoints.recordOwn(lease.runId, seq, entry.key, entry.checkpoint);
		}
		for (const snapshots of collected) await reportCollectedSnapshot(snapshots);
	}
	/**
	 * A shipped batch's events, as one multi-row insert that numbers them from the run's next sequence in the order
	 * given, and the chunks of those stored in chunks (#4965).
	 */
	private shippedEventWrites(
		lease: Lease,
		rows: readonly { readonly key: string; readonly payload: string; readonly chunks: readonly Uint8Array[] }[],
	): SqliteStatement[] {
		const { events, eventChunks } = this.journal;
		const int = this.dialect.types.int;
		const values = rows
			.map((_, index) =>
				index === 0 ? `(CAST(? AS ${int}), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS ${int}))` : "(?, ?, ?, ?)",
			)
			.join(", ");
		const insert: SqliteStatement = {
			sql: `INSERT INTO ${events} (run_id, seq, epoch, key, type, payload, at, chunks)
			SELECT ?, (SELECT COALESCE(MAX(seq), 0) FROM ${events} WHERE run_id = ?) + v.n, ?, v.k, ?, v.p, ${this.now}, v.c
			FROM (WITH batch(n, k, p, c) AS (VALUES ${values}) SELECT * FROM batch) AS v ORDER BY v.n`,
			params: [
				lease.runId,
				lease.runId,
				lease.epoch,
				RUN_EVENT_TYPES.checkpointRecorded,
				...rows.flatMap((row, index) => [index + 1, row.key, row.payload, row.chunks.length]),
			],
		};
		const chunked = rows.filter((row) => row.chunks.length > 0);
		return [
			insert,
			...chunked.flatMap((row) => [
				{
					sql: `DELETE FROM ${eventChunks} WHERE run_id = ? AND seq = (SELECT seq FROM ${events} WHERE run_id = ? AND key = ?)`,
					params: [lease.runId, lease.runId, row.key],
				},
				...row.chunks.map((data, index) => ({
					sql: `INSERT INTO ${eventChunks} (run_id, seq, idx, data) SELECT ?, seq, ?, ? FROM ${events} WHERE run_id = ? AND key = ?`,
					params: [lease.runId, index, data, lease.runId, row.key],
				})),
			]),
		];
	}
	/** The payloads the root's journal records under any of `keys`, whole, by key. */
	private async recordedPayloads(
		read: SqliteExecutor,
		runId: string,
		keys: readonly string[],
	): Promise<ReadonlyMap<string, string>> {
		const found = await read.all<SqliteRow & { key: string; chunks: number }>(
			`SELECT key, chunks FROM ${this.journal.events} WHERE run_id = ? AND key IN (${keys.map(() => "?").join(", ")})`,
			runId,
			...keys,
		);
		const payloads = new Map<string, string>();
		for (const row of found) payloads.set(String(row.key), (await this.eventPayload(read, runId, String(row.key)))!);
		return payloads;
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
				this.operationFence(token, operationId),
				...this.admitsFences(lease, "update"),
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
		// The journal holds the snapshot's blobs, which this database cannot check as it stages the checkpoint (#5077):
		// they are checked here, and their age restarts, so collection keeps them while the checkpoint waits to be
		// delivered for as long as the grace window. A checkpoint whose blobs are gone is refused before it is staged.
		// A resend of an operation this pool took already is answered from what it took, whatever became of the blobs.
		const known = await this.transaction(async (tx) => ({
			previous: await tx.get<SqliteRow & { request: string; receipt: string }>(
				`SELECT * FROM ${this.operations} WHERE work = ? AND generation = ? AND operation = ?`,
				token.id,
				token.generation,
				operationId,
			),
			held: await tx.get<OutboxRow>(
				`SELECT * FROM ${this.outbox} WHERE work = ? AND generation = ? AND operation = ?`,
				token.id,
				token.generation,
				operationId,
			),
		}));
		if (known.previous || known.held) {
			if ((known.previous ?? known.held)!.request !== identity) throw new Error("Pool operation identity conflict");
			if (known.previous) return JSON.parse(known.previous.receipt) as PoolCommitReceipt;
			this.outboxPending = true;
			return this.deliver(lease, known.held!);
		}
		await assertSnapshotBlobsHeld(remote.journal.snapshotBlobs, carriedSnapshots(checkpoint));
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
		let withoutSnapshots = false;
		const staged = await this.transaction(async (tx) => {
			withoutSnapshots = false;
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
			await validatePoolMutation(tx, this.storage, lease.runId, fromRow(row), mutation, source);
			if (checkpoint.completedAt > Math.max(now, Date.now()) + MAX_WORKER_CLOCK_SKEW_MS)
				throw new Error("Pool checkpoint timestamp is in the future");
			assertWorkflowSerializableObject(checkpoint, "Pool checkpoint");
			const strippedEarlier =
				existing !== undefined && isRecordedWithoutSnapshots(existing.event.payload, checkpoint);
			if (existing && !strippedEarlier && !isRecordedCheckpointValue(existing.event.payload, checkpoint))
				throw new Error("Pool checkpoint identity conflict");
			if (existing && mutation.kind !== "checkpoint") throw new Error("Pool session checkpoint identity conflict");
			const lastSeq =
				mutation.kind === "checkpoint"
					? undefined
					: await applyPoolSession(tx, this.dialect, poolSessionPrefix(this.storage), row.id, mutation);
			const billed = poolCheckpointUsage(checkpoint);
			if (billed && !existing)
				await upsertPoolUsage(
					tx,
					this.dialect,
					this.journal.runs,
					row.id,
					token.generation,
					billed.key,
					billed.usage,
				);
			if (existing) {
				// The checkpoint is recorded already, without the snapshot whose blobs were collected before it was (#5077):
				// reported once the commit is answered.
				if (strippedEarlier) withoutSnapshots = true;
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
		if (withoutSnapshots) await reportCollectedSnapshot(carriedSnapshots(checkpoint));
		if (staged.receipt !== undefined) return staged.receipt;
		this.outboxPending = true;
		return this.deliver(lease, staged.held!);
	}
	/** Steps 2 and 3 of {@link commitRemote} for one accepted event. */
	private async deliver(lease: Lease, held: OutboxRow): Promise<PoolCommitReceipt> {
		const remote = this.remote!;
		let checkpoint = JSON.parse(held.payload) as DurableCheckpoint;
		let outcome: Awaited<ReturnType<PoolRemoteJournal["append"]>>;
		try {
			outcome = await remote.append(lease, held.event_key, checkpoint);
		} catch (error) {
			if (!isBlobsCollected(error)) throw error;
			// Its snapshot's blobs were collected while it waited (#5077): the checkpoint is recorded without the snapshot,
			// so the work's progress is kept and nothing held back stops the queue.
			const { worktreeSnapshots: _collected, ...rest } = checkpoint as DurableCheckpoint & {
				readonly worktreeSnapshots?: unknown;
			};
			checkpoint = rest as DurableCheckpoint;
			process.emitWarning(error as Error);
			outcome = await remote.append(lease, held.event_key, checkpoint);
		}
		const forget = (tx: SqliteExecutor) =>
			tx.run(
				`DELETE FROM ${this.outbox} WHERE work = ? AND generation = ? AND operation = ?`,
				held.work,
				held.generation,
				held.operation,
			);
		if (
			outcome.status === "exists" &&
			!isRecordedCheckpointValue(outcome.entry.event.payload, checkpoint) &&
			!isRecordedWithoutSnapshots(outcome.entry.event.payload, checkpoint)
		) {
			// Another attempt recorded a different checkpoint under this key first; there is nothing left to record.
			await this.transaction(forget);
			throw new Error("Pool checkpoint identity conflict");
		}
		// Recorded already without the snapshot this one carries, whose blobs were collected before it was (#5077).
		if (
			outcome.status === "exists" &&
			!isRecordedCheckpointValue(outcome.entry.event.payload, checkpoint) &&
			isRecordedWithoutSnapshots(outcome.entry.event.payload, checkpoint)
		)
			await reportCollectedSnapshot(carriedSnapshots(checkpoint));
		const receipt: PoolCommitReceipt = {
			seq: outcome.entry.seq,
			at: outcome.entry.at,
			...(held.last_seq === null ? {} : { lastSeq: Number(held.last_seq) }),
		};
		await this.transaction(async (tx) => {
			await tx.run(
				this.dialect.insertOrIgnore(this.operations, OPERATION_COLUMNS, "VALUES (?, ?, ?, ?, ?)"),
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
				`SELECT o.* FROM ${this.outbox} o JOIN ${this.work} w ON w.id = o.work WHERE w.root = ? ORDER BY ${this.dialect.rowOrder("o")}`,
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
		return {
			sql: this.dialect.jsonObject([
				["at", this.now],
				["lastSeq", `CAST(? AS ${this.dialect.types.int})`],
			]),
			params: [lastSeq],
		};
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
		const prefix = poolSessionPrefix(this.storage);
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
			applyPoolSession(recorder, this.dialect, prefix, work, mutation, store.store),
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
		// Opened inside a caller's transaction, a store is that write's own: the transaction may still roll its tables
		// back, so it is not kept for later writes, which open it again as every pool session write did before (#4768).
		if (tx !== undefined) return this.openPoolSessions(tx);
		this.sessions ??= this.openPoolSessions().catch((error: Error) => {
			this.sessions = undefined;
			throw error;
		});
		return this.sessions;
	}
	private async openPoolSessions(tx?: SqliteExecutor): Promise<PoolSessions> {
		// One context per queue for every store it opens: on Node 22 an AsyncLocalStorage that ran stays registered with
		// async_hooks for the life of the process, and every async resource after it carries its slot, so one per store
		// (a journal without batches opens one per session write) grew the heap without bound (#4768).
		const within = this.poolSessionScope;
		const executor = () => {
			const current = within.getStore();
			if (current === undefined) throw new Error("Pool session store used outside a pool write");
			return current;
		};
		const prefix = poolSessionPrefix(this.storage);
		const database: SqliteDatabase = {
			descriptor: { adapter: "pool-transaction", location: prefix },
			dialect: this.dialect,
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
		await validatePoolMutation(read, this.storage, lease.runId, work, mutation, checkpoints);
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
			this.scopeFence(lease, work.scope, head, own),
		);
		write.writes.push(
			...this.eventWrites(
				lease.runId,
				undefined,
				lease.epoch,
				key,
				payload,
				this.now,
				[],
				checkpoint,
				checkpoint.kind === "stage" && payload.length > STAGE_OVERVIEW_PAYLOAD_CHARS
					? await this.storage.olderBuildLive(read)
					: await this.keepsWhole(read, payload),
			),
		);
		const billed = poolCheckpointUsage(checkpoint);
		// Where writes run concurrently, the root's totals row exists before the usage's trigger adds to it (#5102).
		if (billed && this.rowLocks) write.writes.push(poolUsageTotalsSeed(this.dialect, this.journal.runs, lease.runId));
		if (billed)
			write.writes.push(
				poolUsageUpsert(this.dialect, this.journal.runs, row.id, Number(row.generation), billed.key, billed.usage),
			);
		return {
			sql: `(SELECT ${this.dialect.jsonObject([
				["seq", "seq"],
				["at", "at"],
				...(lastSeq === undefined ? [] : [["lastSeq", `CAST(? AS ${this.dialect.types.int})`] as const]),
			])} FROM ${events} WHERE run_id = ? AND key = ?)`,
			params: [...(lastSeq === undefined ? [] : [lastSeq]), lease.runId, key],
		};
	}
	/**
	 * A fence: no checkpoint of `scope` was recorded after `head`, but the `own` events the validated view holds. A
	 * fenced commit (PostgreSQL) checks it under the root's run row, so it sees every event committed before it.
	 */
	private scopeFence(lease: Lease, scope: string, head: number, own: readonly number[]): SqliteStatement {
		const recorded = [lease.runId, head, RUN_EVENT_TYPES.checkpointRecorded];
		if (!this.rowLocks)
			return {
				sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${this.journal.events} WHERE run_id = ? AND seq > ? AND type = ? AND instr(json_extract(key, '$[2]'), ?) = 1 AND seq NOT IN (SELECT value FROM json_each(?)))`,
				params: [...recorded, `${scope}:`, JSON.stringify(own)],
			};
		// The key is the JSON array [type, kind, checkpoint id]: an element after the first that starts with `scope:` is
		// the id, since a kind has no colon, and `,"` occurs in the key text only where an element starts.
		return {
			sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${this.journal.events} WHERE run_id = ? AND seq > ? AND type = ? AND ${this.dialect.contains("key", "?")} AND CAST(seq AS TEXT) NOT IN (SELECT value FROM ${this.dialect.jsonValues("?")}))`,
			params: [...recorded, `,${JSON.stringify(`${scope}:`).slice(0, -1)}`, JSON.stringify(own.map(String))],
		};
	}
	async complete(lease: Lease, token: WorkLease, result: WorkflowSerializableObject): Promise<void> {
		lease = snapshotLease(lease);
		token = { ...token };
		assertWorkflowSerializableObject(result, "Pool result");
		const payload = serializeJson(result);
		await this.remote?.fresh(lease);
		const ready = this.readyNotice(lease.runId);
		// Where completions run concurrently (PostgreSQL), the wake-up goes after the commit, not in it: PostgreSQL commits
		// every transaction that sent a notification under one lock, which would put the completions of every host in
		// line again (#5102). A notification lost to a crash in between only leaves the root to its next poll.
		const notifyAfter = this.rowLocks ? ready : undefined;
		// A result longer than one chunk is stored in chunks, with `null` in its row (#4965), unless a process of an older
		// build may be reading the pool, which would read the `null`: then it stays whole, decided as each plan reads.
		const chunked = storedJsonChunks(payload) ?? [];
		const writesOf = (chunks: readonly Uint8Array[]) => [
			{
				sql: `INSERT INTO ${this.work}_results (work, result, chunks) VALUES (?, ?, ?)`,
				params: [token.id, chunks.length === 0 ? payload : "null", chunks.length],
			},
			...chunks.map((data, index) => ({
				sql: `INSERT INTO ${this.work}_result_chunks VALUES (?, ?, ?)`,
				params: [token.id, index, data],
			})),
			{ sql: `UPDATE ${this.work} SET state = 'completed' WHERE id = ?`, params: [token.id] },
			...(ready === undefined || notifyAfter !== undefined ? [] : [ready]),
		];
		await guardedPoolWrite(
			this.storage,
			async (read, optimistic) => {
				const writes = writesOf((await this.keepsWhole(read, payload)) ? [] : chunked);
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
						fences: [
							this.rootFence(lease),
							this.attemptFence(lease, token, true),
							...this.admitsFences(lease, "share"),
						],
						writes,
						result: () => undefined,
					};
				const { now, status } = await this.authority(read, lease);
				const row = await this.current(read, lease, token, true);
				if (row.epoch !== lease.epoch) throw staleWork(lease, token, "epoch-mismatch");
				if (row.state === "completed") {
					const previous = await read.get(
						`SELECT result, chunks FROM ${this.work}_results WHERE work = ?`,
						token.id,
					);
					if (previous === undefined || (await this.resultJson(read, token.id, previous)) !== payload)
						throw new Error("Pool result identity conflict");
					return { done: undefined };
				}
				if (row.expires_at < now) throw staleWork(lease, token, "expired");
				if (!(await this.admitsAttemptWrites(read, lease, status)))
					throw staleWork(lease, token, "root-not-running");
				if (JSON.parse(payload).runId !== fromRow(row).childRunId) throw new Error("Pool result identity mismatch");
				// A child's result is its journal checkpoint: it completes only once every event it was told is committed is.
				if (
					this.remote &&
					(await read.get(`SELECT 1 AS held FROM ${this.outbox} WHERE work = ? LIMIT 1`, token.id))
				)
					throw new Error("Pool work has journal events not yet recorded");
				return {
					fences: [
						this.rootFence(lease),
						this.attemptFence(lease, token, true),
						...this.admitsFences(lease, "share"),
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
			},
			COMPLETE,
		);
		this.attempts.delete(token.id);
		if (notifyAfter !== undefined) await this.sendNotice(notifyAfter);
	}
	/** Sends `notice` in a statement of its own. A wake-up is a hint that pollers do not depend on, so a failure is dropped. */
	private async sendNotice(notice: SqliteStatement): Promise<void> {
		await this.storage.read((executor) => executor.run(notice.sql, ...notice.params)).catch(() => {});
	}
	async result(root: string, id: string): Promise<WorkflowSerializableObject | undefined> {
		return this.storage.read(async (executor) => {
			const row = await executor.get(
				`SELECT r.result, r.chunks FROM ${this.work}_results r JOIN ${this.work} w ON w.id = r.work WHERE w.root = ? AND w.id = ?`,
				root,
				id,
			);
			return row ? (JSON.parse(await this.resultJson(executor, id, row)) as WorkflowSerializableObject) : undefined;
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
			await this.lockRows(tx, this.work, "id = ? AND root = ?", id, lease.runId);
			const row = await tx.get<WorkRow>(`SELECT * FROM ${this.work} WHERE id = ? AND root = ?`, id, lease.runId);
			if (row?.state !== "completed" || row.epoch >= lease.epoch) return undefined;
			const stored = await tx.get(`SELECT result, chunks FROM ${this.work}_results WHERE work = ?`, id);
			if (!stored || !rerun(JSON.parse(await this.resultJson(tx, id, stored)) as WorkflowSerializableObject))
				return undefined;
			await tx.run(`DELETE FROM ${this.work}_results WHERE work = ?`, id);
			await tx.run(
				`UPDATE ${this.work} SET state = 'ready', worker = NULL, expires_at = 0, epoch = ? WHERE id = ?`,
				lease.epoch,
				id,
			);
			await this.notifyReady(tx, lease.runId);
			return this.withInputs(
				tx,
				fromRow({ ...row, state: "ready", worker: null, expires_at: 0, epoch: lease.epoch }),
			);
		});
	}
	/**
	 * Puts an expired attempt's work back for another attempt. `handOffUnconfirmed`: an attempt whose worker never
	 * confirmed its claim goes back as a handoff, which counts as none of the child's attempts (#5034); one confirmed
	 * since it was read counts.
	 */
	async expire(
		lease: Lease,
		token: WorkLease,
		options: { readonly handOffUnconfirmed?: boolean } = {},
	): Promise<boolean> {
		lease = snapshotLease(lease);
		token = { ...token };
		return this.transaction(async (tx) => {
			const { now } = await this.authority(tx, lease);
			// A heartbeat under way extends the lease first, and this sees it.
			await this.lockRows(tx, this.work, "id = ? AND root = ?", token.id, lease.runId);
			const row = await this.current(tx, lease, token);
			if (row.epoch === lease.epoch && row.expires_at >= now) return false;
			await tx.run(`UPDATE ${this.work} SET state = 'ready', worker = NULL, expires_at = 0 WHERE id = ?`, row.id);
			if (options.handOffUnconfirmed === true)
				await tx.run(
					this.dialect.insertOrIgnore(
						this.operations,
						OPERATION_COLUMNS,
						`SELECT ?, ?, ?, ?, '{}' WHERE NOT EXISTS (SELECT 1 FROM ${this.operations} WHERE work = ? AND generation = ? AND operation != ?)`,
					),
					row.id,
					Number(row.generation),
					HANDOFF_OPERATION,
					HANDOFF_OPERATION,
					row.id,
					Number(row.generation),
					HANDOFF_OPERATION,
				);
			await this.notifyReady(tx, lease.runId);
			return true;
		});
	}
	/** The write that records `token`'s claim as confirmed by its worker (#5034): once per generation. */
	private confirmation(token: WorkLease): SqliteStatement {
		return {
			sql: this.dialect.insertOrIgnore(this.operations, OPERATION_COLUMNS, "VALUES (?, ?, ?, ?, '{}')"),
			params: [token.id, token.generation, CONFIRMED_OPERATION, CONFIRMED_OPERATION],
		};
	}
	async extend(lease: Lease, token: WorkLease, durationMs: number): Promise<PoolWork> {
		positive(durationMs);
		lease = snapshotLease(lease);
		token = { ...token };
		await this.remote?.fresh(lease);
		return guardedPoolWrite(
			this.storage,
			(read, optimistic) => this.extension(read, optimistic, lease, token, durationMs, false),
			HEARTBEAT,
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
				const confirm = this.confirmation(token);
				await tx.run(confirm.sql, ...confirm.params);
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
					// A worker's heartbeat confirms its claim: from now on, its attempt ending counts (#5034).
					writes: [...extension.writes, this.confirmation(token), ...batched.writes],
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
			HEARTBEAT,
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
					sql: `WITH clock AS (SELECT ${this.now} AS now) UPDATE ${this.work} SET expires_at = ${this.dialect.greatest("expires_at", "(SELECT now FROM clock) + ?")}, renewed_at = (SELECT now FROM clock) WHERE id = ?`,
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
		await this.lockRows(tx, this.work, "id = ? AND root = ?", token.id, lease.runId);
		const row = await this.current(tx, lease, token);
		if (row.epoch !== lease.epoch) throw staleWork(lease, token, "epoch-mismatch");
		const expiresAt = Math.max(Number(row.expires_at), expiry(now, durationMs));
		await tx.run(`UPDATE ${this.work} SET expires_at = ?, renewed_at = ? WHERE id = ?`, expiresAt, now, row.id);
		return { ...fromRow(row), expiresAt, renewedAt: now };
	}
	/**
	 * Puts an exited attempt's work back for another attempt. `handoff`: the attempt was handed back because the shared
	 * store kept refusing it (#4768); the work records its generation, which {@link inspect} reports in `handoffs`, and
	 * becomes claimable again only `handoff.delayMs` from now.
	 */
	async releaseExited(lease: Lease, token: WorkLease, handoff?: { readonly delayMs: number }): Promise<boolean> {
		return this.settleExited(lease, token, "ready", 0, handoff);
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
		handoff?: { readonly delayMs: number },
	): Promise<boolean> {
		lease = snapshotLease(lease);
		token = { ...token };
		this.attempts.delete(token.id);
		return this.transaction(async (tx) => {
			await this.authority(tx, lease);
			// A completion under way settles the work first, and this sees it.
			await this.lockRows(tx, this.work, "id = ? AND root = ?", token.id, lease.runId);
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
			if (handoff !== undefined) {
				await tx.run(
					`UPDATE ${this.work} SET ready_at = ${this.now} + ? WHERE id = ?`,
					Math.max(0, Math.round(handoff.delayMs)),
					row.id,
				);
				await tx.run(
					this.dialect.insertOrIgnore(this.operations, OPERATION_COLUMNS, "VALUES (?, ?, ?, ?, '{}')"),
					row.id,
					Number(row.generation),
					HANDOFF_OPERATION,
					HANDOFF_OPERATION,
				);
			}
			await this.notifyReady(tx, lease.runId);
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
			await this.lockRows(tx, this.work, "id = ? AND root = ?", token.id, lease.runId);
			const row = await this.current(tx, lease, token);
			if (row.epoch >= lease.epoch) return false;
			await tx.run(
				`UPDATE ${this.work} SET state = 'ready', worker = NULL, expires_at = 0, epoch = ? WHERE id = ?`,
				adopt ? lease.epoch : row.epoch,
				row.id,
			);
			await this.notifyReady(tx, lease.runId);
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
				`UPDATE ${this.work} SET state = 'failed', worker = NULL, expires_at = 0 WHERE root = ? AND (state = 'ready' OR (state = 'leased' AND epoch = ?)) AND id NOT IN (SELECT value FROM ${this.dialect.jsonValues("?")})`,
				lease.runId,
				lease.epoch,
				JSON.stringify(retained),
			);
			if (released.changes > 0) await this.notifyReady(tx, lease.runId);
			return released.changes;
		});
	}
	/** Releases work leased by earlier root incarnations, except the `retained` work ids, which stay leased. */
	async releasePreviousIncarnations(lease: Lease, retained: readonly string[] = []): Promise<number> {
		lease = snapshotLease(lease);
		return this.transaction(async (tx) => {
			await this.authority(tx, lease);
			const released = await tx.run(
				`UPDATE ${this.work} SET state = 'ready', worker = NULL, expires_at = 0 WHERE root = ? AND state = 'leased' AND epoch < ? AND id NOT IN (SELECT value FROM ${this.dialect.jsonValues("?")})`,
				lease.runId,
				lease.epoch,
				JSON.stringify(retained),
			);
			if (released.changes > 0) await this.notifyReady(tx, lease.runId);
			return released.changes;
		});
	}
	/**
	 * The statement that tells listening hosts and the root that `root`'s queue changed, once the transaction it runs in
	 * commits: work became ready, or an attempt ended (#5103). Undefined on a database without notifications.
	 */
	private readyNotice(root: string): SqliteStatement | undefined {
		return this.storage.notifications?.notify(poolReadyChannel(this.storage), root);
	}
	private async notifyReady(tx: SqliteExecutor, root: string): Promise<void> {
		const notice = this.readyNotice(root);
		if (notice !== undefined) await tx.run(notice.sql, ...notice.params);
	}
	/** Every work item of `root`. A read: each coordinator's recovery asks every half second. */
	async inspect(root: string): Promise<readonly PoolWork[]> {
		return this.storage.read(async (executor) =>
			(
				await executor.all<WorkRow & { handoffs: string | null }>(
					`SELECT w.*, (SELECT ${this.dialect.jsonGroupArray("o.generation")} FROM ${this.operations} o WHERE o.work = w.id AND o.operation = ?) AS handoffs
					FROM ${this.work} w WHERE w.root = ? ORDER BY w.ready_at, ${this.dialect.rowOrder("w")}`,
					HANDOFF_OPERATION,
					root,
				)
			).map((row) => {
				const handoffs = JSON.parse(row.handoffs ?? "[]") as number[];
				return handoffs.length > 0 ? { ...fromRow(row), handoffs } : fromRow(row);
			}),
		);
	}
	/**
	 * Whether a worker confirmed the claim of `token`'s attempt (#5034): its heartbeat, a commit or any other operation
	 * but a handoff was recorded under the attempt's generation. An unconfirmed attempt was never known to run.
	 */
	async confirmed(token: Pick<PoolWork, "id" | "generation">): Promise<boolean> {
		return this.storage.read(
			async (executor) =>
				(await executor.get(
					`SELECT 1 AS confirmed FROM ${this.operations} WHERE work = ? AND generation = ? AND operation != ? LIMIT 1`,
					token.id,
					token.generation,
					HANDOFF_OPERATION,
				)) !== undefined,
		);
	}
	async endedShipRoots(
		roots: readonly string[],
		works: readonly string[],
		includeUnidentified = false,
	): Promise<{
		readonly roots: ReadonlySet<string>;
		readonly works: ReadonlySet<string>;
		readonly liveRoots: ReadonlySet<string>;
	}> {
		const running = `status IN ('pending', 'running', 'paused')`;
		const listed = `IN (SELECT value FROM ${this.dialect.jsonValues("?")})`;
		return this.storage.read(async (executor) => {
			const live = async (sql: string, ids: readonly string[]): Promise<ReadonlySet<string>> =>
				ids.length === 0
					? new Set()
					: new Set(
							(await executor.all<SqliteRow & { id: string }>(sql, JSON.stringify(ids))).map((row) => row.id),
						);
			const liveRoots = includeUnidentified
				? new Set(
						(
							await executor.all<SqliteRow & { id: string }>(
								`SELECT run_id AS id FROM ${this.journal.runs} WHERE ${running}`,
							)
						).map((row) => row.id),
					)
				: await live(`SELECT run_id AS id FROM ${this.journal.runs} WHERE ${running} AND run_id ${listed}`, roots);
			const liveWorks = await live(
				`SELECT w.id AS id FROM ${this.work} w JOIN ${this.journal.runs} r ON r.run_id = w.root WHERE r.${running} AND w.id ${listed}`,
				works,
			);
			return {
				roots: new Set(roots.filter((root) => !liveRoots.has(root))),
				works: new Set(works.filter((work) => !liveWorks.has(work))),
				liveRoots,
			};
		});
	}
}

/** The journal key a checkpoint's event is recorded under. */
export function checkpointKey(checkpoint: DurableCheckpoint): string {
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
