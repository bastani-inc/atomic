import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { StoragePayloadTooLargeError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { SESSION_ENTRY_CHUNK_BYTES } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";

/** Model a backend that cannot return this chunked entry's native projection but can return its stub. */
export function refuseChunkProjection(db: SqliteDatabase, chunkedId: string): void {
	const all = db.all.bind(db);
	db.all = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
		const rows = await all<T>(sql, ...args);
		if (rows.some((row) => row.entry_id === chunkedId && Number(row.chunks) === 0 && "resume_type" in row)) {
			throw new StoragePayloadTooLargeError(SESSION_ENTRY_CHUNK_BYTES, 0, { kind: "response" });
		}
		return rows;
	};
}
