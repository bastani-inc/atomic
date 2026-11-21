import { dialectOf, type SqliteRow, validateStoragePrefix } from "@bastani/atomic/storage";
import { addMissingColumns, addOptionalColumn } from "./sql-add-column.js";
import type {
	IntercomBrokerStateOptions,
	KnownSessionBindingResult,
	KnownSessionBindResult,
	KnownSessionLookupResult,
	KnownSessionRecordResult,
	KnownSessionOwner,
	KnownSessionOwnership,
	KnownSessionState,
	KnownSessionStore,
} from "./multinode-state-store.js";
import { ensureBrokerSchema } from "./sql-schema.js";

type BindingRow = SqliteRow & { return_address: string; owner_token?: string | null };

/** How many ids one owner renewal names: two parameters each, within SQLite's oldest bound of 999. */
const OWNER_RENEWAL_BATCH = 400;

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
 * `toLowerCase` form the lookup compares. Table `<prefix>intercom_session_bindings` binds each Intercom id to the return
 * address of the session that registered it (`""` for none).
 */
export async function openSqlKnownSessionStore({
	database,
	prefix,
}: IntercomBrokerStateOptions): Promise<KnownSessionStore> {
	const table = `${validateStoragePrefix(prefix, dialectOf(database).name)}intercom_known_sessions`;
	const bindings = `${validateStoragePrefix(prefix, dialectOf(database).name)}intercom_session_bindings`;
	const { types, nowMs, greatest } = dialectOf(database);
	const age = greatest("0", `${nowMs} - recorded_at`);
	/** `age` at the statement's one reading of the clock, from `WITH clock`. */
	const clockAge = greatest("0", "(SELECT now FROM clock) - recorded_at");
	await ensureBrokerSchema(database, prefix, "known-sessions", (tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table}(
				record_order ${types.serialKey},
				target_identity TEXT NOT NULL UNIQUE,
				intercom_session_id TEXT NOT NULL,
				name_json TEXT,
				name_key TEXT,
				atomic_session_id TEXT,
				group_name TEXT NOT NULL,
				groups_json TEXT NOT NULL,
				recipient_purpose TEXT,
				reply_capability TEXT,
				recorded_at ${types.int} NOT NULL
			);
			CREATE INDEX IF NOT EXISTS ${table}_intercom_id ON ${table}(intercom_session_id);
			CREATE INDEX IF NOT EXISTS ${table}_atomic_id ON ${table}(atomic_session_id);
			CREATE INDEX IF NOT EXISTS ${table}_name ON ${table}(name_key);
			CREATE INDEX IF NOT EXISTS ${table}_recorded ON ${table}(recorded_at);
			CREATE TABLE IF NOT EXISTS ${bindings}(
				intercom_session_id TEXT NOT NULL PRIMARY KEY,
				return_address TEXT NOT NULL,
				recorded_at ${types.int} NOT NULL
			);
			CREATE INDEX IF NOT EXISTS ${bindings}_recorded ON ${bindings}(recorded_at);
		`),
	);
	// #5154: added later: set, by store clock, once the session's broker was retired before it recorded the session
	// leaving. An older broker ignores it, and its `record` leaves it set.
	await addMissingColumns(database, table, { lost_at: types.int });
	// #5607: added later: the registration that owns each id, its broker, and when that broker last renewed it. An older
	// broker's `bind` leaves them as they are. A role that may not add them keeps binding as before, with no owners.
	const owned =
		(await addOptionalColumn(database, bindings, "owner_token", "TEXT")) &&
		(await addOptionalColumn(database, bindings, "owner_broker", "TEXT")) &&
		(await addOptionalColumn(database, bindings, "owner_renewed_at", types.int));
	const ownerAge = greatest("0", `${nowMs} - ${bindings}.owner_renewed_at`);
	const columns = `target_identity, intercom_session_id, name_json, atomic_session_id, group_name, groups_json,
					recipient_purpose, reply_capability, ${age} AS age_ms`;

	/** #5607: the owner methods, on a store that keeps owners. */
	const owners: NonNullable<KnownSessionStore["owners"]> = {
		async release({ intercomSessionId, token }) {
			await database.run(
				`UPDATE ${bindings} SET owner_token = NULL, owner_broker = NULL, owner_renewed_at = NULL
				 WHERE intercom_session_id = ? AND owner_token = ?`,
				intercomSessionId,
				token,
			);
		},
		async renew(ownerships: readonly KnownSessionOwnership[]) {
			for (let start = 0; start < ownerships.length; start += OWNER_RENEWAL_BATCH) {
				const batch = ownerships.slice(start, start + OWNER_RENEWAL_BATCH);
				await database.run(
					`UPDATE ${bindings} SET owner_renewed_at = ${nowMs}, recorded_at = ${nowMs}
					 WHERE ${batch.map(() => "(intercom_session_id = ? AND owner_token = ?)").join(" OR ")}`,
					...batch.flatMap(({ intercomSessionId, token }) => [intercomSessionId, token]),
				);
			}
		},
		async retireBroker(brokerId) {
			await database.run(
				`UPDATE ${bindings} SET owner_token = NULL, owner_broker = NULL, owner_renewed_at = NULL
				 WHERE owner_broker = ?`,
				brokerId,
			);
		},
	};

	return {
		async record(session): Promise<KnownSessionRecordResult> {
			if (session.targetIdentity.length === 0) return { status: "invalid", reason: "empty-target-identity" };
			if (session.intercomSessionId.length === 0) return { status: "invalid", reason: "empty-session-id" };
			if (session.group.length === 0) return { status: "invalid", reason: "empty-group" };
			await database.run(
				`INSERT INTO ${table}(target_identity, intercom_session_id, name_json, name_key, atomic_session_id,
					group_name, groups_json, recipient_purpose, reply_capability, recorded_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowMs})
				 ON CONFLICT(target_identity) DO UPDATE SET
					intercom_session_id = excluded.intercom_session_id,
					name_json = excluded.name_json,
					name_key = excluded.name_key,
					atomic_session_id = excluded.atomic_session_id,
					group_name = excluded.group_name,
					groups_json = excluded.groups_json,
					recipient_purpose = excluded.recipient_purpose,
					reply_capability = excluded.reply_capability,
					recorded_at = excluded.recorded_at,
					lost_at = NULL`,
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
				// One reading of the clock, so a session found within the retention reports an age within it too.
				`WITH clock AS (SELECT ${nowMs} AS now)
				SELECT target_identity, intercom_session_id, name_json, atomic_session_id, group_name, groups_json,
					recipient_purpose, reply_capability, ${clockAge} AS age_ms
				 FROM ${table}
				 WHERE (intercom_session_id = ? OR atomic_session_id = ? OR name_key = ?)
					AND ${clockAge} <= ?
				 ORDER BY record_order`,
				target,
				target,
				JSON.stringify(target.toLowerCase()),
				retentionMs,
			);
			return { status: "found", sessions: rows.map(stateFromRow) };
		},
		async bind(intercomSessionId, returnAddress, retentionMs, owner): Promise<KnownSessionBindResult> {
			if (intercomSessionId.length === 0) return { status: "invalid", reason: "empty-session-id" };
			const owning: KnownSessionOwner | undefined = owned ? owner : undefined;
			const bound = await database.transaction(
				async (tx) => {
					await tx.run(
						`DELETE FROM ${bindings} WHERE intercom_session_id = ? AND ${nowMs} - recorded_at > ?`,
						intercomSessionId,
						retentionMs,
					);
					// A known-session record kept from before bindings existed holds the id for its return address.
					await tx.run(
						`INSERT INTO ${bindings}(intercom_session_id, return_address, recorded_at)
						 SELECT intercom_session_id, COALESCE(atomic_session_id, ''), ${nowMs} FROM ${table}
						 WHERE intercom_session_id = ? AND ${age} <= ?
						 ORDER BY record_order LIMIT 1
						 ON CONFLICT(intercom_session_id) DO NOTHING`,
						intercomSessionId,
						retentionMs,
					);
					if (owning === undefined) {
						await tx.run(
							`INSERT INTO ${bindings}(intercom_session_id, return_address, recorded_at) VALUES (?, ?, ${nowMs})
							 ON CONFLICT(intercom_session_id) DO UPDATE SET recorded_at = excluded.recorded_at
							 WHERE ${bindings}.return_address = excluded.return_address`,
							intercomSessionId,
							returnAddress,
						);
						return tx.get<BindingRow>(
							`SELECT return_address FROM ${bindings} WHERE intercom_session_id = ?`,
							intercomSessionId,
						);
					}
					// #5607: one conditional write takes the id for this registration, unless another live one owns it.
					await tx.run(
						`INSERT INTO ${bindings}(intercom_session_id, return_address, recorded_at, owner_token, owner_broker,
							owner_renewed_at)
						 VALUES (?, ?, ${nowMs}, ?, ?, ${nowMs})
						 ON CONFLICT(intercom_session_id) DO UPDATE SET recorded_at = excluded.recorded_at,
							owner_token = excluded.owner_token, owner_broker = excluded.owner_broker,
							owner_renewed_at = excluded.owner_renewed_at
						 WHERE ${bindings}.return_address = excluded.return_address
							AND (${bindings}.owner_token IS NULL OR ${bindings}.owner_token = excluded.owner_token
								OR ${bindings}.owner_renewed_at IS NULL OR ${ownerAge} > ?)`,
						intercomSessionId,
						returnAddress,
						owning.token,
						owning.brokerId,
						owning.staleAfterMs,
					);
					return tx.get<BindingRow>(
						`SELECT return_address, owner_token FROM ${bindings} WHERE intercom_session_id = ?`,
						intercomSessionId,
					);
				},
				{ concurrency: { kind: "serial", domain: bindings } },
			);
			if (bound === undefined) return { status: "bound" };
			if (bound.return_address !== returnAddress) return { status: "refused", returnAddress: bound.return_address };
			return owning === undefined || bound.owner_token === owning.token ? { status: "bound" } : { status: "held" };
		},
		...(owned ? { owners } : {}),
		async binding(intercomSessionId, retentionMs): Promise<KnownSessionBindingResult> {
			if (intercomSessionId.length === 0) return { status: "invalid", reason: "empty-session-id" };
			const bound = await database.get<BindingRow>(
				`SELECT return_address FROM ${bindings} WHERE intercom_session_id = ? AND ${nowMs} - recorded_at <= ?`,
				intercomSessionId,
				retentionMs,
			);
			return bound === undefined ? { status: "unbound" } : { status: "bound", returnAddress: bound.return_address };
		},
		async prune(olderThanMs): Promise<number> {
			await database.run(`DELETE FROM ${bindings} WHERE ${nowMs} - recorded_at > ?`, olderThanMs);
			const { changes } = await database.run(
				`DELETE FROM ${table} WHERE ${nowMs} - recorded_at > ?`,
				olderThanMs,
			);
			return changes;
		},
		async markLost(targetIdentities): Promise<void> {
			if (targetIdentities.length === 0) return;
			await database.transaction(async (tx) => {
				for (const identity of targetIdentities) {
					await tx.run(
						`UPDATE ${table} SET lost_at = ${nowMs} WHERE target_identity = ? AND lost_at IS NULL`,
						identity,
					);
				}
			});
		},
		async listLost(olderThanMs): Promise<KnownSessionState[]> {
			const rows = await database.all<KnownRow>(
				`SELECT ${columns} FROM ${table}
				 WHERE lost_at IS NOT NULL AND ${greatest("0", `${nowMs} - lost_at`)} >= ?
				 ORDER BY record_order`,
				olderThanMs,
			);
			return rows.map(stateFromRow);
		},
	};
}
