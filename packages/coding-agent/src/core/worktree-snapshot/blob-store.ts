import type { SqliteDatabase, SqliteExecutor } from "../storage/database.js";
import { validateStoragePrefix } from "../storage/prefix.js";
import type { SnapshotBlob, SnapshotBlobStore, WorktreeSnapshot } from "./types.ts";

/** Every blob hash a snapshot needs to be restored: its chain's patches and its bundle. */
export function snapshotBlobHashes(snapshot: WorktreeSnapshot): string[] {
	const hashes = snapshot.chain.flatMap((link) => (link.patch === null ? [] : [link.patch]));
	if (snapshot.bundle) hashes.push(snapshot.bundle.blob);
	return [...new Set(hashes)];
}

export class MemorySnapshotBlobStore implements SnapshotBlobStore {
	private readonly blobs = new Map<string, { readonly data: Uint8Array; storedAt: number }>();
	private readonly now: () => number;

	/** `now` returns the current time in whole seconds; tests inject it to age blobs deterministically. */
	constructor(options: { readonly now?: () => number } = {}) {
		this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
	}

	async putBlobs(blobs: readonly SnapshotBlob[]): Promise<void> {
		const storedAt = this.now();
		for (const blob of blobs) {
			const existing = this.blobs.get(blob.hash);
			if (existing) existing.storedAt = storedAt;
			else this.blobs.set(blob.hash, { data: Uint8Array.from(blob.data), storedAt });
		}
	}
	async getBlob(hash: string): Promise<Uint8Array | undefined> {
		const entry = this.blobs.get(hash);
		return entry === undefined ? undefined : Uint8Array.from(entry.data);
	}
	async listBlobHashes(): Promise<readonly string[]> {
		return [...this.blobs.keys()];
	}
	async deleteBlobs(
		hashes: readonly string[],
		options: { readonly olderThanSeconds: number },
	): Promise<readonly string[]> {
		const cutoff = this.now() - options.olderThanSeconds;
		const deleted: string[] = [];
		for (const hash of hashes) {
			const entry = this.blobs.get(hash);
			if (entry === undefined || entry.storedAt > cutoff) continue;
			this.blobs.delete(hash);
			deleted.push(hash);
		}
		return deleted;
	}
}

/** The `<prefix>snapshot_blobs` table, shared by the session store and run journal of one database. */
export class SqlSnapshotBlobStore implements SnapshotBlobStore {
	private readonly database: SqliteDatabase;
	readonly table: string;

	private constructor(database: SqliteDatabase, table: string) {
		this.database = database;
		this.table = table;
	}

	/**
	 * Opens the table, creating it in its own transaction when it is missing. A store that already has the table opens
	 * without taking the write lock.
	 */
	static async open(database: SqliteDatabase, prefix = ""): Promise<SqlSnapshotBlobStore> {
		const table = `${validateStoragePrefix(prefix)}snapshot_blobs`;
		const exists = await database.get("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?", table);
		if (!exists) await database.transaction((transaction) => SqlSnapshotBlobStore.initialize(transaction, prefix));
		return new SqlSnapshotBlobStore(database, table);
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
	async listBlobHashes(): Promise<readonly string[]> {
		const rows = await this.database.all<{ hash: string }>(`SELECT hash FROM ${this.table}`);
		return rows.map((row) => row.hash);
	}
	/**
	 * Deletes each of `hashes` that was stored or re-stored at least `olderThanSeconds` ago, measured on the database's
	 * clock so that a skewed client clock can neither expose nor protect a blob. The age test and the delete are one
	 * statement, so a blob re-stored between a listing and this call is kept. Resolves with the hashes deleted.
	 */
	async deleteBlobs(
		hashes: readonly string[],
		options: { readonly olderThanSeconds: number },
	): Promise<readonly string[]> {
		if (hashes.length === 0) return [];
		return this.database.transaction(async (transaction) => {
			const deleted: string[] = [];
			for (const hash of hashes) {
				const { changes } = await transaction.run(
					`DELETE FROM ${this.table} WHERE hash = ? AND created_at <= unixepoch() - ?`,
					hash,
					options.olderThanSeconds,
				);
				if (changes > 0) deleted.push(hash);
			}
			return deleted;
		});
	}
}
