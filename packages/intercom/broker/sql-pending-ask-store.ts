import { type SqliteRow, validateStoragePrefix } from "@bastani/atomic/storage";
import type {
	IntercomBrokerStateOptions,
	InvalidStateInput,
	PendingAsk,
	PendingAskClearResult,
	PendingAskListResult,
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
export async function openSqlPendingAskStore({
	database,
	prefix,
}: IntercomBrokerStateOptions): Promise<PendingAskStore> {
	const table = `${validateStoragePrefix(prefix)}intercom_pending_asks`;
	await database.transaction((tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table}(
				"order" INTEGER PRIMARY KEY AUTOINCREMENT,
				sender_session_id TEXT NOT NULL,
				target_session_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				UNIQUE(sender_session_id, target_session_id, message_id)
			);
			CREATE INDEX IF NOT EXISTS ${table}_target ON ${table}(target_session_id, "order");
		`),
	);
	// #4386: added later; a table from an older broker gets the columns, and an older broker ignores them.
	const known = await database.all<{ name: string }>(`PRAGMA table_info(${table})`);
	for (const column of ["park_owner", "park_key"]) {
		if (known.some((existing) => existing.name === column)) continue;
		try {
			await database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
		} catch (error) {
			// Another broker added it between the check and the change.
			if (!/duplicate column/i.test(error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : ""))
				throw error;
		}
	}
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
			const { changes } = await database.run(
				`INSERT INTO ${table}(sender_session_id, target_session_id, message_id) VALUES (?, ?, ?)
				 ON CONFLICT DO NOTHING`,
				ask.senderSessionId,
				ask.targetSessionId,
				ask.messageId,
			);
			return changes === 0 ? { status: "duplicate" } : { status: "recorded" };
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
			const { changes } = await database.run(`DELETE FROM ${table} WHERE ${reverseRoute}`, ...reverseParams(route));
			return changes === 0 ? { status: "no-match" } : { status: "cleared" };
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
			});
			return { status: "taken", asks: rows.map(toAsk) };
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
				const found = await tx.all<AskRow>(
					`SELECT sender_session_id, target_session_id, message_id FROM ${table} WHERE ${parked.where} ORDER BY "order"`,
					...parked.params,
				);
				await tx.run(
					`UPDATE ${table} SET target_session_id = ?, park_owner = NULL, park_key = NULL WHERE ${parked.where}`,
					targetSessionId,
					...parked.params,
				);
				return found;
			});
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
			});
			return { status: "taken", asks: rows.map(toAsk) };
		},
	};
}
