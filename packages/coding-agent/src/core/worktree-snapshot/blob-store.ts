import type { SqliteDatabase } from "../storage/database.js";
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
	async listBlobHashes(): Promise<readonly string[]> {
		return [...this.blobs.keys()];
	}
	async deleteBlobs(hashes: readonly string[]): Promise<void> {
		for (const hash of hashes) this.blobs.delete(hash);
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

	static async open(database: SqliteDatabase, prefix = ""): Promise<SqlSnapshotBlobStore> {
		const table = `${validateStoragePrefix(prefix)}snapshot_blobs`;
		await database.exec(
			`CREATE TABLE IF NOT EXISTS ${table} (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT`,
		);
		return new SqlSnapshotBlobStore(database, table);
	}

	async putBlobs(blobs: readonly SnapshotBlob[]): Promise<void> {
		if (blobs.length === 0) return;
		const sql = `INSERT INTO ${this.table} (hash, bytes, data) VALUES (?, ?, ?) ON CONFLICT(hash) DO NOTHING`;
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
	async deleteBlobs(hashes: readonly string[]): Promise<void> {
		if (hashes.length === 0) return;
		await this.database.transaction(async (transaction) => {
			for (const hash of hashes) await transaction.run(`DELETE FROM ${this.table} WHERE hash = ?`, hash);
		});
	}
}

/**
 * Deletes every stored blob that none of `retained` needs. Callers pass the snapshots referenced by resumable
 * checkpoints and the latest snapshot of each session; each snapshot names its whole chain, so ancestors survive.
 */
export async function collectSnapshotGarbage(
	store: SnapshotBlobStore,
	retained: Iterable<WorktreeSnapshot>,
): Promise<{ readonly deleted: readonly string[] }> {
	const keep = new Set<string>();
	for (const snapshot of retained) for (const hash of snapshotBlobHashes(snapshot)) keep.add(hash);
	const deleted = (await store.listBlobHashes()).filter((hash) => !keep.has(hash));
	await store.deleteBlobs(deleted);
	return { deleted };
}
