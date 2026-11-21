import { dialectOf, type SqliteExecutor, type SqliteRow, validateStoragePrefix } from "@bastani/atomic/storage";
import { addMissingColumns, addOptionalColumn } from "./sql-add-column.js";
import type {
	IntercomBrokerStateOptions,
	KnownSessionBindingResult,
	KnownSessionBindResult,
	KnownSessionLookupResult,
	KnownSessionRecordResult,
	KnownSessionState,
	KnownSessionStore,
	SessionIdReclaim,
	SessionIdReclaimResult,
} from "./multinode-state-store.js";
import { ensureBrokerSchema } from "./sql-schema.js";

type BindingRow = SqliteRow & { return_address: string };

/**
 * The start every delivery identity of a session with `returnAddress` shares, whatever its group (`deliveryTargetIdentity`
 * writes `["return", returnAddress, group]`).
 */
function returnIdentityPrefix(returnAddress: string): string {
	return `${JSON.stringify(["return", returnAddress]).slice(0, -1)},`;
}

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
	// The lease store's table, which the broker opens first: `reclaim` reads its presence leases.
	const leases = `${validateStoragePrefix(prefix, dialectOf(database).name)}intercom_leases`;
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
	// #5607: added later: the claim of the registration that last bound the id, written by `bind` when it is given one.
	// An older broker's `bind` leaves it as it is. Without it (a role that may not add it) there is no `reclaim`.
	const claims = await addOptionalColumn(database, bindings, "latest_claim", "TEXT");
	const columns = `target_identity, intercom_session_id, name_json, atomic_session_id, group_name, groups_json,
					recipient_purpose, reply_capability, ${age} AS age_ms`;

	/** `bind`'s statements, in the caller's serial transaction on `bindings`. */
	const bindIn = async (
		tx: SqliteExecutor,
		intercomSessionId: string,
		returnAddress: string,
		retentionMs: number,
		claim: string | undefined,
	): Promise<KnownSessionBindResult> => {
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
		// One conditional write: a binding held by another return address is left as it is.
		if (claims) {
			await tx.run(
				`INSERT INTO ${bindings}(intercom_session_id, return_address, recorded_at, latest_claim) VALUES (?, ?, ${nowMs}, ?)
				 ON CONFLICT(intercom_session_id) DO UPDATE SET recorded_at = excluded.recorded_at, latest_claim = excluded.latest_claim
				 WHERE ${bindings}.return_address = excluded.return_address`,
				intercomSessionId,
				returnAddress,
				claim ?? null,
			);
		} else {
			await tx.run(
				`INSERT INTO ${bindings}(intercom_session_id, return_address, recorded_at) VALUES (?, ?, ${nowMs})
				 ON CONFLICT(intercom_session_id) DO UPDATE SET recorded_at = excluded.recorded_at
				 WHERE ${bindings}.return_address = excluded.return_address`,
				intercomSessionId,
				returnAddress,
			);
		}
		const bound = await tx.get<BindingRow>(
			`SELECT return_address FROM ${bindings} WHERE intercom_session_id = ?`,
			intercomSessionId,
		);
		if (bound === undefined || bound.return_address === returnAddress) return { status: "bound" };
		return { status: "refused", returnAddress: bound.return_address };
	};

	const reclaim = async (request: SessionIdReclaim): Promise<SessionIdReclaimResult> => {
		if (request.intercomSessionId.length === 0 || request.freshId.length === 0)
			return { status: "invalid", reason: "empty-session-id" };
		return database.transaction(
			async (tx) => {
				// A session of this return address that another broker presents, in any group, holds the id there.
				const identities = returnIdentityPrefix(request.returnAddress);
				const { changes } = await tx.run(
					`UPDATE ${bindings} SET recorded_at = ${nowMs}
					 WHERE intercom_session_id = ? AND return_address = ? AND latest_claim = ? AND ${nowMs} - recorded_at <= ?
						AND NOT EXISTS (
							SELECT 1 FROM ${leases} presence
							WHERE presence.kind = 'presence' AND substr(presence.key, 1, ?) = ? AND presence.holder_id IS NOT NULL
								AND presence.holder_id <> ? AND ${greatest("0", `${nowMs} - presence.renewed_at`)} <= ?
						)`,
					request.intercomSessionId,
					request.returnAddress,
					request.claim,
					request.retentionMs,
					identities.length,
					identities,
					request.brokerId,
					request.presenceStaleAfterMs,
				);
				if (changes === 1) return { status: "kept" } as const;
				// A fresh id, made at random for this registration, has no binding or record yet: one write binds it, and only an
				// id already there, bound or recorded, takes `bind`'s whole way.
				const inserted = await tx.run(
					`INSERT INTO ${bindings}(intercom_session_id, return_address, recorded_at)
					 SELECT ?, ?, ${nowMs}
					 WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE intercom_session_id = ? AND ${age} <= ?)
					 ON CONFLICT(intercom_session_id) DO NOTHING`,
					request.freshId,
					request.returnAddress,
					request.freshId,
					request.retentionMs,
				);
				const binding =
					inserted.changes === 1
						? ({ status: "bound" } as const)
						: await bindIn(tx, request.freshId, request.returnAddress, request.retentionMs, undefined);
				return { status: "fresh", binding } as const;
			},
			{ concurrency: { kind: "serial", domain: bindings } },
		);
	};

	return {
		...(claims ? { reclaim } : {}),
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
		async bind(intercomSessionId, returnAddress, retentionMs, claim): Promise<KnownSessionBindResult> {
			if (intercomSessionId.length === 0) return { status: "invalid", reason: "empty-session-id" };
			return database.transaction((tx) => bindIn(tx, intercomSessionId, returnAddress, retentionMs, claim), {
				concurrency: { kind: "serial", domain: bindings },
			});
		},
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
