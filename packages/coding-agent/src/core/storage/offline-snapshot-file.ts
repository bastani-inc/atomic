import { realpath, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { SqliteDatabase } from "./database.js";
import { wrapNodeSqliteDatabase } from "./node-sqlite.js";

/** A dedicated connection, never a live application's facade. The relaxed space check requires exclusive access across commits. */
export async function withOfflineSnapshotFile(
	file: string,
	move: (database: SqliteDatabase) => Promise<void>,
): Promise<void> {
	const path = await realpath(file);
	async function requireCleanWal() {
		const wal = await stat(`${path}-wal`).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (wal && wal.size > 0)
			throw new Error(
				"Close all database users cleanly before offline chunk maintenance; the existing write-ahead log is not empty.",
			);
	}
	await requireCleanWal();
	const url = pathToFileURL(path);
	url.searchParams.set("mode", "rw"); // Never create a database at a missing path.
	const raw = new DatabaseSync(url.href);
	try {
		// Set exclusive locking BEFORE first accessing the schema. BEGIN EXCLUSIVE alone in WAL mode doesn't exclude readers.
		raw.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
		await requireCleanWal();
		if (raw.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal")
			throw new Error("Offline chunk maintenance requires a local SQLite database already in WAL mode.");
		if (raw.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum === 1)
			throw new Error("Offline chunk maintenance cannot bound the log with auto_vacuum=FULL.");
		const database = wrapNodeSqliteDatabase(raw);
		try {
			await move(database);
		} finally {
			await database.close();
		}
	} finally {
		raw.close();
	}
}
