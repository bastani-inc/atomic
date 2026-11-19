import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_TABLES,
	type SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionRecordHeader } from "../../packages/coding-agent/src/core/storage/session/types.js";

/** Seed a missing-index session on SQLite or sqld without a write round trip per entry. */
export async function seedLegacyResumeSession(
	db: SqliteDatabase,
	store: SqlSessionStore,
	header: SessionRecordHeader,
	count: number,
	prefix = "",
	forkAt = 0,
): Promise<void> {
	await store.create(header, [
		{
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: header.createdAt,
			message: { role: "user", timestamp: 1, content: "" },
		},
	]);
	const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix);
	await db.transaction(async (tx) => {
		// Clones have the same timestamp and no searchable text. Only their IDs, parents and the message count differ.
		await tx.run(
			`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ?)
			INSERT INTO ${tables.entries} (session_id,seq,entry_id,entry_json,chunks)
			SELECT template.session_id,n,'e'||n,json_set(template.entry_json,'$.id','e'||n,'$.parentId',
				'e'||(n-CASE WHEN n=? THEN 2 ELSE 1 END)),0 FROM seq CROSS JOIN ${tables.entries} AS template
			WHERE template.session_id=? AND template.seq=1 AND n>1`,
			count,
			forkAt,
			header.id,
		);
		await tx.run(
			`UPDATE ${tables.sessions} SET last_seq=?,message_count=?,
			summary_state=json_set(json_remove(summary_state,'$.resume'),'$.messageCount',?) WHERE id=?`,
			count,
			count,
			count,
			header.id,
		);
	});
}
