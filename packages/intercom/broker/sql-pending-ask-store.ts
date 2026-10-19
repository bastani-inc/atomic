import { type SqliteRow, validateStoragePrefix } from "@bastani/atomic/storage";
import type {
	IntercomBrokerStateOptions,
	InvalidStateInput,
	PendingAsk,
	PendingAskClearResult,
	PendingAskMatchResult,
	PendingAskPruneResult,
	PendingAskRecordResult,
	PendingAskStore,
	PendingAskTakeResult,
	ReplyRoute,
	StateStoreInvalidReason,
} from "./multinode-state-store.js";

type AskRow = SqliteRow & { sender_session_id: string; target_session_id: string; message_id: string };

const invalid = (reason: StateStoreInvalidReason): InvalidStateInput => ({ status: "invalid", reason });

function invalidAsk(ask: PendingAsk): InvalidStateInput | undefined {
	if (ask.senderSessionId.length === 0 || ask.targetSessionId.length === 0) return invalid("empty-session-id");
	return ask.messageId.length === 0 ? invalid("empty-message-id") : undefined;
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
			return {
				status: "taken",
				asks: rows.map((row) => ({
					senderSessionId: row.sender_session_id,
					targetSessionId: row.target_session_id,
					messageId: row.message_id,
				})),
			};
		},
	};
}
