import { type SqliteRow, validateStoragePrefix } from "@bastani/atomic/storage";
import type {
	IntercomBrokerStateOptions,
	KnownSessionLookupResult,
	KnownSessionRecordResult,
	KnownSessionState,
	KnownSessionStore,
} from "./multinode-state-store.js";

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

type KnownRow = SqliteRow & {
	target_identity: string;
	intercom_session_id: string;
	name_json: string | null;
	atomic_session_id: string | null;
	group_name: string;
	groups_json: string;
	recipient_purpose: string | null;
	reply_capability: string | null;
	age_ms: number | bigint;
};

function stateFromRow(row: KnownRow): KnownSessionState {
	return {
		targetIdentity: row.target_identity,
		intercomSessionId: row.intercom_session_id,
		...(row.name_json === null ? {} : { name: JSON.parse(row.name_json) as string }),
		...(row.atomic_session_id === null ? {} : { atomicSessionId: row.atomic_session_id }),
		group: row.group_name,
		groups: JSON.parse(row.groups_json) as string[],
		...(row.recipient_purpose === null
			? {}
			: { recipientPurpose: row.recipient_purpose as NonNullable<KnownSessionState["recipientPurpose"]> }),
		...(row.reply_capability === null
			? {}
			: { replyCapability: row.reply_capability as NonNullable<KnownSessionState["replyCapability"]> }),
		ageMs: Number(row.age_ms),
	};
}

/**
 * S5 amendment (spec §14): `KnownSessionStore` on the shared storage adapter's database, table
 * `<prefix>intercom_known_sessions`. Names are stored as JSON so any text survives; `name_key` holds the
 * `toLowerCase` form the lookup compares.
 */
export async function openSqlKnownSessionStore({
	database,
	prefix,
}: IntercomBrokerStateOptions): Promise<KnownSessionStore> {
	const table = `${validateStoragePrefix(prefix)}intercom_known_sessions`;
	await database.transaction((tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table}(
				record_order INTEGER PRIMARY KEY AUTOINCREMENT,
				target_identity TEXT NOT NULL UNIQUE,
				intercom_session_id TEXT NOT NULL,
				name_json TEXT,
				name_key TEXT,
				atomic_session_id TEXT,
				group_name TEXT NOT NULL,
				groups_json TEXT NOT NULL,
				recipient_purpose TEXT,
				reply_capability TEXT,
				recorded_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS ${table}_intercom_id ON ${table}(intercom_session_id);
			CREATE INDEX IF NOT EXISTS ${table}_atomic_id ON ${table}(atomic_session_id);
			CREATE INDEX IF NOT EXISTS ${table}_name ON ${table}(name_key);
			CREATE INDEX IF NOT EXISTS ${table}_recorded ON ${table}(recorded_at);
		`),
	);

	return {
		async record(session): Promise<KnownSessionRecordResult> {
			if (session.targetIdentity.length === 0) return { status: "invalid", reason: "empty-target-identity" };
			if (session.intercomSessionId.length === 0) return { status: "invalid", reason: "empty-session-id" };
			if (session.group.length === 0) return { status: "invalid", reason: "empty-group" };
			await database.run(
				`INSERT INTO ${table}(target_identity, intercom_session_id, name_json, name_key, atomic_session_id,
					group_name, groups_json, recipient_purpose, reply_capability, recorded_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${STORE_NOW})
				 ON CONFLICT(target_identity) DO UPDATE SET
					intercom_session_id = excluded.intercom_session_id,
					name_json = excluded.name_json,
					name_key = excluded.name_key,
					atomic_session_id = excluded.atomic_session_id,
					group_name = excluded.group_name,
					groups_json = excluded.groups_json,
					recipient_purpose = excluded.recipient_purpose,
					reply_capability = excluded.reply_capability,
					recorded_at = excluded.recorded_at`,
				session.targetIdentity,
				session.intercomSessionId,
				session.name === undefined ? null : JSON.stringify(session.name),
				session.name === undefined ? null : JSON.stringify(session.name.toLowerCase()),
				session.atomicSessionId ?? null,
				session.group,
				JSON.stringify([...session.groups]),
				session.recipientPurpose ?? null,
				session.replyCapability ?? null,
			);
			return { status: "recorded" };
		},
		async lookup(target, retentionMs): Promise<KnownSessionLookupResult> {
			if (target.length === 0) return { status: "invalid", reason: "empty-target" };
			const rows = await database.all<KnownRow>(
				`SELECT target_identity, intercom_session_id, name_json, atomic_session_id, group_name, groups_json,
					recipient_purpose, reply_capability, MAX(0, ${STORE_NOW} - recorded_at) AS age_ms
				 FROM ${table}
				 WHERE (intercom_session_id = ? OR atomic_session_id = ? OR name_key = ?)
					AND MAX(0, ${STORE_NOW} - recorded_at) <= ?
				 ORDER BY record_order`,
				target,
				target,
				JSON.stringify(target.toLowerCase()),
				retentionMs,
			);
			return { status: "found", sessions: rows.map(stateFromRow) };
		},
		async prune(olderThanMs): Promise<number> {
			const { changes } = await database.run(
				`DELETE FROM ${table} WHERE ${STORE_NOW} - recorded_at > ?`,
				olderThanMs,
			);
			return changes;
		},
	};
}
