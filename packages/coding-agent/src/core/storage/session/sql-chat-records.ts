import type { SqliteDatabase } from "../database.js";
import { dialectOf } from "../dialect.js";
import { decodeChatRecord, type SessionChatRecords } from "./chat-records.js";

/** A new physical table per format version; the main sessions schema (and all its old readers) stay unchanged. */
export function sqlChatRecords(
	database: SqliteDatabase,
	sessions: string,
	table: string,
	index: string,
): SessionChatRecords {
	const dialect = dialectOf(database);
	let initialized: Promise<void> | undefined;
	function initialize(): Promise<void> {
		initialized ??= database
			.exec(`CREATE TABLE IF NOT EXISTS ${table} (
			position ${dialect.types.serialKey}, session_id TEXT NOT NULL REFERENCES ${sessions}(id) ON DELETE CASCADE,
			epoch TEXT NOT NULL, anchor TEXT NOT NULL, data TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS ${index} ON ${table}(session_id, epoch, anchor, position);`)
			.catch((error: Error) => {
				initialized = undefined;
				throw error;
			});
		return initialized;
	}
	const current = dialect.jsonText("summary_state", "epoch");
	return {
		async append(owner, anchor, record) {
			await initialize();
			// Use the session writer's own connection and serialization. A replacement with the same public ID
			// cannot accept a delayed record from the old session. No revision or last-modified column is touched.
			await database.run(
				`INSERT INTO ${table} (session_id,epoch,anchor,data)
				SELECT id,?,?,? FROM ${sessions} WHERE id=? AND ${current}=?`,
				owner.epoch,
				anchor,
				JSON.stringify({ v: 1, ...record }),
				owner.id,
				owner.epoch,
			);
		},
		async has(owner) {
			// The table is absent until the first diagnostic. A read-only reopen never installs the schema.
			return !!(await database
				.get(`SELECT 1 AS present FROM ${table} WHERE session_id=? AND epoch=? LIMIT 1`, owner.id, owner.epoch)
				.catch(() => undefined));
		},
		async read(owner, anchors) {
			if (!anchors.length) return [];
			const rows = await database.all<{ anchor: string; data: string }>(
				`SELECT anchor,data FROM ${table} WHERE session_id=? AND epoch=? AND anchor IN (${anchors.map(() => "?").join(",")}) ORDER BY position`,
				owner.id,
				owner.epoch,
				...anchors,
			);
			return rows.flatMap(({ anchor, data }) => {
				const record = decodeChatRecord(data);
				return record ? [{ anchor, record }] : [];
			});
		},
	};
}
