import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_PRESENCE_TABLES,
	SESSION_TABLES,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";

/** The machine an older Atomic's session runs on, in the markers these tests plant. */
export const OLDER_BUILD_HOST = "older-atomic-host";

export interface OlderBuildMarker {
	/** The marker's row, as `<prefix>session_open` holds it. */
	readonly sessionId: string;
	readonly pid: number;
	/** Back-dates the marker's heartbeat by `ms`, as a process that stopped refreshing it leaves it. */
	age(ms: number): Promise<void>;
	/** Removes the marker, as the older Atomic does when its session closes. */
	release(): Promise<void>;
}

/**
 * Keeps the sessions under `prefix` copying their forks, as a session an older Atomic runs there does (#6560): plants
 * the open-session marker such a build keeps, with a fresh heartbeat, on another machine. A session store opened on
 * the prefix while the marker's heartbeat is fresh (under a minute old) leaves the switch to shared-history forks for
 * a later open, and its forks copy; once the marker is released or aged, the next open switches. When no store has
 * opened the prefix yet, it first sets up what such a build would have: the sessions meta at version 1, since a new
 * database's sessions schema starts with shared-history forks on, and the markers table with that build's columns. So
 * it works before the first open too. Use a prefix of its own for a store that must copy beside one that shares.
 */
export async function holdOlderBuildMarker(
	database: SqliteDatabase,
	prefix = "",
	options: { readonly sessionId?: string; readonly pid?: number; readonly schemaVersion?: number | null } = {},
): Promise<OlderBuildMarker> {
	const dialect = dialectOf(database);
	const { int, text } = dialect.types;
	const table = renderStorageIdentifiers("sessions", SESSION_PRESENCE_TABLES, prefix).open;
	const meta = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix).meta;
	const sessionId = options.sessionId ?? "older-build-session";
	const pid = options.pid ?? 4242;
	const token = `${pid}-0123456789abcdef`;
	await database.exec(`CREATE TABLE IF NOT EXISTS ${meta} (schema_version ${int} NOT NULL)${dialect.tableOptions}`);
	await database.run(`INSERT INTO ${meta} (schema_version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${meta})`);
	await database.exec(`
		CREATE TABLE IF NOT EXISTS ${table} (
			session_id ${text} NOT NULL, token ${text} NOT NULL, pid ${int} NOT NULL, host ${text} NOT NULL,
			heartbeat_at ${int} NOT NULL, schema_version ${int}, PRIMARY KEY(session_id, token)
		)${dialect.tableOptions};
	`);
	await database.run(
		`INSERT INTO ${table} (session_id, token, pid, host, heartbeat_at, schema_version) VALUES (?, ?, ?, ?, ${dialect.nowMs}, ?)`,
		sessionId,
		token,
		pid,
		OLDER_BUILD_HOST,
		options.schemaVersion === undefined ? 2 : options.schemaVersion,
	);
	return {
		sessionId,
		pid,
		age: async (ms) => {
			await database.run(
				`UPDATE ${table} SET heartbeat_at = heartbeat_at - ? WHERE session_id = ? AND token = ?`,
				ms,
				sessionId,
				token,
			);
		},
		release: async () => {
			await database.run(`DELETE FROM ${table} WHERE session_id = ? AND token = ?`, sessionId, token);
		},
	};
}
