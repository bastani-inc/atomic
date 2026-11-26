import { dialectOf, type SqliteRow, validateStoragePrefix } from "@bastani/atomic/storage";
import type {
	IntercomBrokerStateOptions,
	InvalidStateInput,
	PendingAsk,
	PendingAskClearResult,
	PendingAskListResult,
	PendingAskMarkResult,
	PendingAskMatchResult,
	PendingAskPark,
	PendingAskParkResult,
	PendingAskPruneResult,
	PendingAskRebindResult,
	PendingAskRecordResult,
	PendingAskStore,
	PendingAskTakeResult,
	ReplyRoute,
	StateStoreInvalidReason,
} from "./multinode-state-store.js";
import { SETTLED_ASK_RETENTION_MS } from "./multinode-state-store.js";
import { addMissingColumns } from "./sql-add-column.js";
import { storeNow } from "./sql-retention.js";
import { ensureBrokerSchema, RETRY_UNAPPLIED, withBrokerSchemaCatalog } from "./sql-schema.js";

type AskRow = SqliteRow & { sender_session_id: string; target_session_id: string; message_id: string };

const toAsk = (row: AskRow): PendingAsk => ({
	senderSessionId: row.sender_session_id,
	targetSessionId: row.target_session_id,
	messageId: row.message_id,
});

const invalid = (reason: StateStoreInvalidReason): InvalidStateInput => ({ status: "invalid", reason });

function invalidAsk(ask: PendingAsk): InvalidStateInput | undefined {
	if (ask.senderSessionId.length === 0 || ask.targetSessionId.length === 0) return invalid("empty-session-id");
	return ask.messageId.length === 0 ? invalid("empty-message-id") : undefined;
}

function invalidPark(park: PendingAskPark): InvalidStateInput | undefined {
	if (park.ownerSessionId.length === 0) return invalid("empty-session-id");
	return park.reservationKey.length === 0 ? invalid("empty-reservation-key") : undefined;
}

function invalidRoute(route: ReplyRoute): InvalidStateInput | undefined {
	if (route.replySenderSessionId.length === 0 || route.replyTargetSessionId.length === 0) {
		return invalid("empty-session-id");
	}
	return route.replyTo.length === 0 ? invalid("empty-message-id") : undefined;
}

/** S3: `PendingAskStore` on the shared storage adapter's database, table `<prefix>intercom_pending_asks`. */
export function openSqlPendingAskStore(options: IntercomBrokerStateOptions): Promise<PendingAskStore> {
	// Its schema checks answer from one read of the catalog, shared with an open around it: a current schema costs
	// no transaction and no lock, also when the store is opened on its own (#6560).
	return withBrokerSchemaCatalog(options.database, options.prefix, () => openPendingAskStoreInCatalog(options));
}

async function openPendingAskStoreInCatalog({
	database,
	prefix,
}: IntercomBrokerStateOptions): Promise<PendingAskStore> {
	const table = `${validateStoragePrefix(prefix, dialectOf(database).name)}intercom_pending_asks`;
	const { types, nowMs } = dialectOf(database);
	/**
	 * Its transactions read and write this table and the settled asks alone, which no other store touches, so they
	 * exclude one another, not every writer of the database (#6560).
	 */
	const serial = { ...RETRY_UNAPPLIED, concurrency: { kind: "serial", domain: table } } as const;
	await ensureBrokerSchema(database, prefix, "pending-asks", (tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table}(
				"order" ${types.serialKey},
				sender_session_id TEXT NOT NULL,
				target_session_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				UNIQUE(sender_session_id, target_session_id, message_id)
			);
			CREATE INDEX IF NOT EXISTS ${table}_target ON ${table}(target_session_id, "order");
		`),
	);
	// #4386: added later; a table from an older broker gets the columns, and an older broker ignores them.
	// #4992: `replied` is set once a reply to the ask is queued; an older broker ignores it.
	// #4992: `ended_at` is set, by store clock, once the target ended and its askers are owed a failure.
	await addMissingColumns(database, table, {
		park_owner: types.text,
		park_key: types.text,
		replied: types.int,
		ended_at: types.int,
	});
	/** The database clock, read once per statement: a column compared with it is answered by its index. */
	const now = storeNow(database);
	// #4997: asks answered or failed, remembered so a stopped broker's copy of one is not recorded again.
	const settled = `${validateStoragePrefix(prefix)}intercom_settled_asks`;
	await ensureBrokerSchema(database, prefix, "settled-asks", (tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${settled}(
				sender_session_id TEXT NOT NULL,
				target_session_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				settled_at ${types.int} NOT NULL,
				PRIMARY KEY(sender_session_id, target_session_id, message_id)
			);
			CREATE INDEX IF NOT EXISTS ${settled}_at ON ${settled}(settled_at);
		`),
	);
	const parkedBy = (ownerSessionId: string, reservationKey: string | undefined) =>
		reservationKey === undefined
			? { where: "park_owner = ?", params: [ownerSessionId] }
			: { where: "park_owner = ? AND park_key = ?", params: [ownerSessionId, reservationKey] };
	const reverseRoute = "sender_session_id = ? AND target_session_id = ? AND message_id = ?";
	const reverseParams = (route: ReplyRoute) =>
		[route.replyTargetSessionId, route.replySenderSessionId, route.replyTo] as const;

	return {
		async record(ask): Promise<PendingAskRecordResult> {
			const bad = invalidAsk(ask);
			if (bad !== undefined) return bad;
			const params = [ask.senderSessionId, ask.targetSessionId, ask.messageId] as const;
			return database.transaction(async (tx) => {
				const done = await tx.get(`SELECT 1 AS found FROM ${settled} WHERE ${reverseRoute}`, ...params);
				if (done !== undefined) return { status: "settled" } as const;
				const { changes } = await tx.run(
					`INSERT INTO ${table}(sender_session_id, target_session_id, message_id) VALUES (?, ?, ?)
					 ON CONFLICT DO NOTHING`,
					...params,
				);
				return changes === 0 ? ({ status: "duplicate" } as const) : ({ status: "recorded" } as const);
			}, serial);
		},
		async matchesReply(route): Promise<PendingAskMatchResult> {
			const bad = invalidRoute(route);
			if (bad !== undefined) return bad;
			const row = await database.get(`SELECT 1 AS found FROM ${table} WHERE ${reverseRoute}`, ...reverseParams(route));
			return row === undefined ? { status: "no-match" } : { status: "match" };
		},
		async clearReply(route): Promise<PendingAskClearResult> {
			const bad = invalidRoute(route);
			if (bad !== undefined) return bad;
			return database.transaction(async (tx) => {
				const { changes } = await tx.run(`DELETE FROM ${table} WHERE ${reverseRoute}`, ...reverseParams(route));
				await tx.run(
					`INSERT INTO ${settled}(sender_session_id, target_session_id, message_id, settled_at) VALUES (?, ?, ?, ${nowMs})
					 ON CONFLICT DO NOTHING`,
					...reverseParams(route),
				);
				await tx.run(`DELETE FROM ${settled} WHERE settled_at < ${now} - ?`, SETTLED_ASK_RETENTION_MS);
				return changes === 0 ? ({ status: "no-match" } as const) : ({ status: "cleared" } as const);
			}, serial);
		},
		async isSettled(route): Promise<boolean> {
			if (invalidRoute(route) !== undefined) return false;
			return (await database.get(`SELECT 1 AS found FROM ${settled} WHERE ${reverseRoute}`, ...reverseParams(route))) !== undefined;
		},
		async releaseRoute(route): Promise<PendingAskClearResult> {
			const bad = invalidRoute(route);
			if (bad !== undefined) return bad;
			const { changes } = await database.run(`DELETE FROM ${table} WHERE ${reverseRoute}`, ...reverseParams(route));
			return changes === 0 ? { status: "no-match" } : { status: "cleared" };
		},
		async markReplied(route): Promise<PendingAskMarkResult> {
			const bad = invalidRoute(route);
			if (bad !== undefined) return bad;
			const { changes } = await database.run(
				`UPDATE ${table} SET replied = 1 WHERE ${reverseRoute}`,
				...reverseParams(route),
			);
			return changes === 0 ? { status: "no-match" } : { status: "marked" };
		},
		async pruneSender(senderSessionId): Promise<PendingAskPruneResult> {
			if (senderSessionId.length === 0) return invalid("empty-session-id");
			const { changes } = await database.run(`DELETE FROM ${table} WHERE sender_session_id = ?`, senderSessionId);
			return { status: "pruned", removed: changes };
		},
		async listForSender(senderSessionId): Promise<PendingAskListResult> {
			if (senderSessionId.length === 0) return invalid("empty-session-id");
			const rows = await database.all<AskRow>(
				`SELECT sender_session_id, target_session_id, message_id FROM ${table}
				 WHERE sender_session_id = ? ORDER BY "order"`,
				senderSessionId,
			);
			return { status: "listed", asks: rows.map(toAsk) };
		},
		async takeForTarget(targetSessionId): Promise<PendingAskTakeResult> {
			if (targetSessionId.length === 0) return invalid("empty-session-id");
			const rows = await database.transaction(async (tx) => {
				const taken = await tx.all<AskRow>(
					`SELECT sender_session_id, target_session_id, message_id FROM ${table}
					 WHERE target_session_id = ? ORDER BY "order"`,
					targetSessionId,
				);
				await tx.run(`DELETE FROM ${table} WHERE target_session_id = ?`, targetSessionId);
				return taken;
			}, serial);
			return { status: "taken", asks: rows.map(toAsk) };
		},
		async listForTarget(targetSessionId): Promise<PendingAskListResult> {
			if (targetSessionId.length === 0) return invalid("empty-session-id");
			const rows = await database.all<AskRow>(
				`SELECT sender_session_id, target_session_id, message_id FROM ${table}
				 WHERE target_session_id = ? AND replied IS NULL ORDER BY "order"`,
				targetSessionId,
			);
			return { status: "listed", asks: rows.map(toAsk) };
		},
		async parkForTarget(targetSessionId, park): Promise<PendingAskParkResult> {
			if (targetSessionId.length === 0) return invalid("empty-session-id");
			const bad = invalidPark(park);
			if (bad !== undefined) return bad;
			const { changes } = await database.run(
				`UPDATE ${table} SET park_owner = ?, park_key = ? WHERE target_session_id = ?`,
				park.ownerSessionId,
				park.reservationKey,
				targetSessionId,
			);
			return { status: "parked", parked: changes };
		},
		async rebindParked(park, targetSessionId): Promise<PendingAskRebindResult> {
			if (targetSessionId.length === 0) return invalid("empty-session-id");
			const bad = invalidPark(park);
			if (bad !== undefined) return bad;
			const parked = parkedBy(park.ownerSessionId, park.reservationKey);
			const rows = await database.transaction(async (tx) => {
				// #4992: an ask that ended with its owner stays ended: it is failed, not taken up again.
				const found = await tx.all<AskRow>(
					`SELECT sender_session_id, target_session_id, message_id FROM ${table}
					 WHERE ${parked.where} AND ended_at IS NULL ORDER BY "order"`,
					...parked.params,
				);
				await tx.run(
					`UPDATE ${table} SET target_session_id = ?, park_owner = NULL, park_key = NULL
					 WHERE ${parked.where} AND ended_at IS NULL`,
					targetSessionId,
					...parked.params,
				);
				return found;
			}, serial);
			return {
				status: "rebound",
				asks: rows.map((row) => ({
					...toAsk(row),
					targetSessionId,
					previousTargetSessionId: row.target_session_id,
				})),
			};
		},
		async takeParked(ownerSessionId, reservationKey): Promise<PendingAskTakeResult> {
			if (ownerSessionId.length === 0) return invalid("empty-session-id");
			if (reservationKey !== undefined && reservationKey.length === 0) return invalid("empty-reservation-key");
			const parked = parkedBy(ownerSessionId, reservationKey);
			const rows = await database.transaction(async (tx) => {
				const taken = await tx.all<AskRow>(
					`SELECT sender_session_id, target_session_id, message_id FROM ${table} WHERE ${parked.where} ORDER BY "order"`,
					...parked.params,
				);
				await tx.run(`DELETE FROM ${table} WHERE ${parked.where}`, ...parked.params);
				return taken;
			}, serial);
			return { status: "taken", asks: rows.map(toAsk) };
		},
		async listParked(ownerSessionId, reservationKey): Promise<PendingAskListResult> {
			if (ownerSessionId.length === 0) return invalid("empty-session-id");
			if (reservationKey !== undefined && reservationKey.length === 0) return invalid("empty-reservation-key");
			const parked = parkedBy(ownerSessionId, reservationKey);
			const rows = await database.all<AskRow>(
				`SELECT sender_session_id, target_session_id, message_id FROM ${table}
				 WHERE ${parked.where} AND replied IS NULL ORDER BY "order"`,
				...parked.params,
			);
			return { status: "listed", asks: rows.map(toAsk) };
		},
		async endForTarget(targetSessionId): Promise<PendingAskListResult> {
			if (targetSessionId.length === 0) return invalid("empty-session-id");
			return endWhere("target_session_id = ?", [targetSessionId]);
		},
		async endParked(ownerSessionId, reservationKey): Promise<PendingAskListResult> {
			if (ownerSessionId.length === 0) return invalid("empty-session-id");
			if (reservationKey !== undefined && reservationKey.length === 0) return invalid("empty-reservation-key");
			const parked = parkedBy(ownerSessionId, reservationKey);
			return endWhere(parked.where, parked.params);
		},
		async listEnded(olderThanMs): Promise<PendingAskListResult> {
			const rows = await database.all<AskRow>(
				`SELECT sender_session_id, target_session_id, message_id FROM ${table}
				 WHERE ended_at IS NOT NULL AND replied IS NULL AND ended_at <= ${now} - ?
				 ORDER BY ended_at, "order"`,
				olderThanMs,
			);
			return { status: "listed", asks: rows.map(toAsk) };
		},
		async endLost(targetSessionId): Promise<PendingAskListResult> {
			if (targetSessionId.length === 0) return invalid("empty-session-id");
			const rows = await database.transaction(async (tx) => {
				const open = await tx.all<AskRow & { order: number | bigint }>(
					`SELECT "order", sender_session_id, target_session_id, message_id FROM ${table}
					 WHERE target_session_id = ? AND park_owner IS NULL AND replied IS NULL AND ended_at IS NULL
					 ORDER BY "order"`,
					targetSessionId,
				);
				const marked: AskRow[] = [];
				for (const row of open) {
					const { changes } = await tx.run(
						`UPDATE ${table} SET ended_at = ${nowMs} WHERE "order" = ? AND ended_at IS NULL AND replied IS NULL`,
						row.order,
					);
					if (Number(changes) === 1) marked.push(row);
				}
				return marked;
			}, serial);
			return { status: "listed", asks: rows.map(toAsk) };
		},
		async unmarkEnded(route): Promise<PendingAskMarkResult> {
			const bad = invalidRoute(route);
			if (bad !== undefined) return bad;
			const { changes } = await database.run(
				`UPDATE ${table} SET ended_at = NULL WHERE ${reverseRoute}`,
				...reverseParams(route),
			);
			return changes === 0 ? { status: "no-match" } : { status: "marked" };
		},
	};

	/** Mark the unanswered asks `where` selects ended, keeping an earlier mark, and return them. */
	async function endWhere(where: string, params: readonly string[]): Promise<PendingAskListResult> {
		const rows = await database.transaction(async (tx) => {
			await tx.run(
				`UPDATE ${table} SET ended_at = ${nowMs} WHERE ${where} AND replied IS NULL AND ended_at IS NULL`,
				...params,
			);
			return tx.all<AskRow>(
				`SELECT sender_session_id, target_session_id, message_id FROM ${table}
				 WHERE ${where} AND replied IS NULL AND ended_at IS NOT NULL ORDER BY "order"`,
				...params,
			);
		}, serial);
		return { status: "listed", asks: rows.map(toAsk) };
	}
}
