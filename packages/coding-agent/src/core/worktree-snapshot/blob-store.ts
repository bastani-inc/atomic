import type { SqliteDatabase, SqliteExecutor, SqliteRow } from "../storage/database.js";
import { validateStoragePrefix } from "../storage/prefix.js";
import type { SnapshotBlob, SnapshotBlobStore, WorktreeSnapshot } from "./types.ts";

/** Every blob hash a snapshot needs to be restored: its chain's patches and its bundle. */
export function snapshotBlobHashes(snapshot: WorktreeSnapshot): string[] {
	const hashes = snapshot.chain.flatMap((link) => (link.patch === null ? [] : [link.patch]));
	if (snapshot.bundle) hashes.push(snapshot.bundle.blob);
	return [...new Set(hashes)];
}

export class MemorySnapshotBlobStore implements SnapshotBlobStore {
	private readonly blobs = new Map<string, Uint8Array>();

	async putBlobs(blobs: readonly SnapshotBlob[]): Promise<void> {
		for (const blob of blobs) if (!this.blobs.has(blob.hash)) this.blobs.set(blob.hash, Uint8Array.from(blob.data));
	}
	async getBlob(hash: string): Promise<Uint8Array | undefined> {
		const data = this.blobs.get(hash);
		return data === undefined ? undefined : Uint8Array.from(data);
	}
	async refreshBlobs(hashes: readonly string[]): Promise<boolean> {
		return hashes.every((hash) => this.blobs.has(hash));
	}
	async listBlobHashes(): Promise<readonly string[]> {
		return [...this.blobs.keys()];
	}
}

/**
 * The tables of one blob table's reference index, all under the blob table's prefix. Triggers on the run journal's
 * and the session store's tables keep them current in the same transaction as each write, so collection reads only
 * these tables and never a journal or a session.
 */
export interface SnapshotIndexTables {
	readonly blobs: string;
	/** `(run_id, hash)`: each blob a run's tool or stage checkpoints reference, once per run. */
	readonly runRefs: string;
	/** `(run_id, retained, seq)`: whether the run's latest status keeps its snapshots, from the event at `seq`. */
	readonly runState: string;
	/** `(session_id, seq, root, snapshot_id)`: one row per `worktree_snapshot` session entry. */
	readonly sessionRefs: string;
	/** `(session_id, seq, snapshot_id, hash)`: the blobs of each snapshot record a session entry carries. */
	readonly sessionRecords: string;
	/** One row: the last collection's claim on the database clock and its outcome. */
	readonly collection: string;
}

export function snapshotIndexTables(prefix = ""): SnapshotIndexTables {
	const p = validateStoragePrefix(prefix);
	return Object.freeze({
		blobs: `${p}snapshot_blobs`,
		runRefs: `${p}snapshot_run_refs`,
		runState: `${p}snapshot_run_state`,
		sessionRefs: `${p}snapshot_session_refs`,
		sessionRecords: `${p}snapshot_session_records`,
		collection: `${p}snapshot_collection`,
	});
}

/** Blobs one collection batch examines and deletes in one write transaction. */
export const SNAPSHOT_COLLECTION_BATCH = 256;

export interface SnapshotSweepOptions {
	readonly graceSeconds: number;
	readonly signal?: AbortSignal;
	/** Called after each batch commits with the hashes it deleted. */
	readonly onBatch?: (deleted: readonly string[]) => void;
}

type PageRow = SqliteRow & { created_at: number; hash: string };

/** The `<prefix>snapshot_blobs` table and its reference index, shared by the session store and run journal of one database. */
export class SqlSnapshotBlobStore implements SnapshotBlobStore {
	private readonly database: SqliteDatabase;
	private readonly tables: SnapshotIndexTables;
	readonly table: string;

	private constructor(database: SqliteDatabase, tables: SnapshotIndexTables) {
		this.database = database;
		this.tables = tables;
		this.table = tables.blobs;
	}

	/** Which table this store collects, for telling stores of one database and prefix apart from others. */
	get identity(): string {
		return `${this.database.descriptor.adapter}\0${this.database.descriptor.location}\0${this.table}`;
	}

	/**
	 * Opens the table, creating it in its own transaction when it is missing. A store that already has the table opens
	 * without taking the write lock.
	 */
	static async open(database: SqliteDatabase, prefix = ""): Promise<SqlSnapshotBlobStore> {
		const t = snapshotIndexTables(prefix);
		const exists = await database.get(
			"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
			t.collection,
		);
		if (!exists) {
			await database.transaction(async (transaction) => {
				await transaction.exec(`
					CREATE TABLE IF NOT EXISTS ${t.blobs} (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())) STRICT;
					CREATE INDEX IF NOT EXISTS ${t.blobs}_age ON ${t.blobs} (created_at, hash);
					CREATE TABLE IF NOT EXISTS ${t.runRefs} (run_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (run_id, hash)) STRICT, WITHOUT ROWID;
					CREATE INDEX IF NOT EXISTS ${t.runRefs}_hash ON ${t.runRefs} (hash);
					CREATE TABLE IF NOT EXISTS ${t.runState} (run_id TEXT PRIMARY KEY, retained INTEGER NOT NULL, seq INTEGER NOT NULL) STRICT, WITHOUT ROWID;
					CREATE TABLE IF NOT EXISTS ${t.sessionRefs} (session_id TEXT NOT NULL, seq INTEGER NOT NULL, root TEXT NOT NULL, snapshot_id TEXT NOT NULL, PRIMARY KEY (session_id, seq)) STRICT, WITHOUT ROWID;
					CREATE INDEX IF NOT EXISTS ${t.sessionRefs}_root ON ${t.sessionRefs} (session_id, root, seq);
					CREATE INDEX IF NOT EXISTS ${t.sessionRefs}_snapshot ON ${t.sessionRefs} (session_id, snapshot_id);
					CREATE TABLE IF NOT EXISTS ${t.sessionRecords} (session_id TEXT NOT NULL, seq INTEGER NOT NULL, snapshot_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (session_id, seq, hash)) STRICT, WITHOUT ROWID;
					CREATE INDEX IF NOT EXISTS ${t.sessionRecords}_hash ON ${t.sessionRecords} (hash);
					CREATE TABLE IF NOT EXISTS ${t.collection} (id INTEGER PRIMARY KEY CHECK (id = 1), claimed_at INTEGER, holder TEXT, finished_at INTEGER, deleted INTEGER, error_code TEXT) STRICT;
					INSERT OR IGNORE INTO ${t.collection} (id) VALUES (1);
				`);
			});
		}
		return new SqlSnapshotBlobStore(database, t);
	}

	/**
	 * Creates the table inside the caller's transaction, so a store that creates its own tables, such as a new run
	 * journal, takes the write lock once for both.
	 */
	static async initialize(transaction: SqliteExecutor, prefix = ""): Promise<void> {
		await transaction.exec(
			`CREATE TABLE IF NOT EXISTS ${validateStoragePrefix(prefix)}snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())) STRICT`,
		);
	}

	async putBlobs(blobs: readonly SnapshotBlob[]): Promise<void> {
		if (blobs.length === 0) return;
		const sql = `INSERT INTO ${this.table} (hash, bytes, data) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET created_at = unixepoch()`;
		const statements = blobs.map((blob) => ({ sql, params: [blob.hash, blob.data.byteLength, blob.data] }));
		if (this.database.batch) {
			await this.database.batch(statements);
			return;
		}
		await this.database.transaction(async (transaction) => {
			for (const statement of statements) await transaction.run(statement.sql, ...statement.params);
		});
	}
	async getBlob(hash: string): Promise<Uint8Array | undefined> {
		const row = await this.database.get<{ data: Uint8Array }>(`SELECT data FROM ${this.table} WHERE hash = ?`, hash);
		return row?.data;
	}
	/** Restarts the age of every stored hash in one statement on the database clock; false when any is missing. */
	async refreshBlobs(hashes: readonly string[]): Promise<boolean> {
		const unique = [...new Set(hashes)];
		if (unique.length === 0) return true;
		const { changes } = await this.database.transaction((transaction) =>
			transaction.run(
				`UPDATE ${this.table} SET created_at = unixepoch() WHERE hash IN (SELECT value FROM json_each(?))`,
				JSON.stringify(unique),
			),
		);
		return changes === unique.length;
	}
	async listBlobHashes(): Promise<readonly string[]> {
		const rows = await this.database.all<{ hash: string }>(`SELECT hash FROM ${this.table}`);
		return rows.map((row) => row.hash);
	}

	/**
	 * Deletes every blob stored or re-stored at least `graceSeconds` ago on the database clock that no retained snapshot
	 * references, in batches of {@link SNAPSHOT_COLLECTION_BATCH}, and resolves with the hashes deleted. Each batch is
	 * one write transaction whose delete re-checks age and references in the same statement, so a reference published
	 * before the batch commits keeps its blob and a process killed mid-collection leaves only garbage. Reads the
	 * reference index and the blob table's age index, never a journal or a session. Checks `signal` before each batch
	 * and rejects with its reason.
	 */
	async collectGarbage(options: SnapshotSweepOptions): Promise<readonly string[]> {
		const t = this.tables;
		const unreferenced = `NOT EXISTS (
				SELECT 1 FROM ${t.runRefs} AS ref WHERE ref.hash = ${t.blobs}.hash
				AND NOT EXISTS (SELECT 1 FROM ${t.runState} AS state WHERE state.run_id = ref.run_id AND state.retained = 0)
			) AND NOT EXISTS (
				SELECT 1 FROM ${t.sessionRecords} AS record
				JOIN ${t.sessionRefs} AS head ON head.session_id = record.session_id AND head.snapshot_id = record.snapshot_id
				WHERE record.hash = ${t.blobs}.hash AND head.seq = (
					SELECT max(latest.seq) FROM ${t.sessionRefs} AS latest WHERE latest.session_id = head.session_id AND latest.root = head.root
				)
			)`;
		const deleted: string[] = [];
		let cursor: PageRow | undefined;
		for (;;) {
			options.signal?.throwIfAborted();
			const after = cursor;
			const batch = await this.database.transaction(async (transaction) => {
				const page = await this.page(transaction, options.graceSeconds, after);
				if (page.length === 0) return { page, deleted: [] };
				const rows = await transaction.all<SqliteRow & { hash: string }>(
					`DELETE FROM ${t.blobs} WHERE hash IN (SELECT value FROM json_each(?)) AND created_at <= unixepoch() - ? AND ${unreferenced} RETURNING hash`,
					JSON.stringify(page.map((row) => row.hash)),
					options.graceSeconds,
				);
				return { page, deleted: rows.map((row) => row.hash) };
			});
			deleted.push(...batch.deleted);
			options.onBatch?.(batch.deleted);
			if (batch.page.length < SNAPSHOT_COLLECTION_BATCH) return deleted;
			cursor = batch.page.at(-1);
		}
	}

	private page(transaction: SqliteExecutor, graceSeconds: number, after: PageRow | undefined): Promise<PageRow[]> {
		const t = this.tables;
		return after === undefined
			? transaction.all<PageRow>(
					`SELECT created_at, hash FROM ${t.blobs} WHERE created_at <= unixepoch() - ? ORDER BY created_at, hash LIMIT ?`,
					graceSeconds,
					SNAPSHOT_COLLECTION_BATCH,
				)
			: transaction.all<PageRow>(
					`SELECT created_at, hash FROM ${t.blobs} WHERE created_at <= unixepoch() - ? AND (created_at, hash) > (?, ?) ORDER BY created_at, hash LIMIT ?`,
					graceSeconds,
					after.created_at,
					after.hash,
					SNAPSHOT_COLLECTION_BATCH,
				);
	}

	/**
	 * Claims this table's next collection for `holder` when no collection was claimed in the last `intervalSeconds` on
	 * the database clock, so processes sharing the database collect at most once per interval. A read without the
	 * write lock answers "not due" first; only a due claim takes the lock.
	 */
	async claimCollection(intervalSeconds: number, holder: string): Promise<boolean> {
		const due = `id = 1 AND (claimed_at IS NULL OR claimed_at <= unixepoch() - ?)`;
		if (!(await this.database.get(`SELECT id FROM ${this.tables.collection} WHERE ${due}`, intervalSeconds)))
			return false;
		const { changes } = await this.database.transaction((transaction) =>
			transaction.run(
				`UPDATE ${this.tables.collection} SET claimed_at = unixepoch(), holder = ?, finished_at = NULL, deleted = NULL, error_code = NULL WHERE ${due}`,
				holder,
				intervalSeconds,
			),
		);
		return changes === 1;
	}

	/** Records how `holder`'s claimed collection ended; a later claim by another holder is left alone. */
	async recordCollection(
		holder: string,
		outcome: { readonly deleted: number; readonly errorCode: string | null },
	): Promise<void> {
		await this.database.transaction((transaction) =>
			transaction.run(
				`UPDATE ${this.tables.collection} SET finished_at = unixepoch(), deleted = ?, error_code = ? WHERE id = 1 AND holder = ?`,
				outcome.deleted,
				outcome.errorCode,
				holder,
			),
		);
	}
}
