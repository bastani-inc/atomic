import { type SqliteExecutor, type SqliteRow, validateStoragePrefix } from "@bastani/atomic/storage";
import type {
	IntercomBrokerStateOptions,
	InvalidStateInput,
	SentMessageAcceptResult,
	SentMessageAuthority,
	SentMessageForgetResult,
	SentMessageKey,
	SentMessageLookupResult,
	SentMessageReserveResult,
	SentMessageState,
	SentQuestionRoute,
} from "./multinode-state-store.js";

type SentRow = SqliteRow & {
	digest: string;
	target_identity: string;
	question_route_json: string | null;
	state: SentMessageState;
};

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

const emptyMessageId: InvalidStateInput = { status: "invalid", reason: "empty-message-id" };

function questionRouteOf(row: SentRow): { questionRoute?: SentQuestionRoute } {
	if (row.question_route_json === null) return {};
	const { targetSessionId, senderGroupIdentity } = JSON.parse(row.question_route_json) as SentQuestionRoute;
	return { questionRoute: { targetSessionId, senderGroupIdentity } };
}

/**
 * S3: `SentMessageAuthority` on the shared storage adapter's database, table `<prefix>intercom_sent_messages`.
 * Digests are opaque strings computed by the caller.
 */
export async function openSqlSentMessageAuthority({
	database,
	prefix,
}: IntercomBrokerStateOptions): Promise<SentMessageAuthority> {
	const table = `${validateStoragePrefix(prefix)}intercom_sent_messages`;
	await database.transaction((tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table}(
				message_id TEXT PRIMARY KEY,
				digest TEXT NOT NULL,
				target_identity TEXT NOT NULL,
				question_route_json TEXT,
				state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted')),
				recorded_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS ${table}_recorded ON ${table}(recorded_at);
		`),
	);
	const read = (executor: SqliteExecutor, messageId: string) =>
		executor.get<SentRow>(
			`SELECT digest, target_identity, question_route_json, state FROM ${table} WHERE message_id = ?`,
			messageId,
		);

	return {
		async reserve(reservation): Promise<SentMessageReserveResult> {
			if (reservation.messageId.length === 0) return emptyMessageId;
			if (reservation.targetIdentity.length === 0) return { status: "invalid", reason: "empty-target-identity" };
			const route =
				reservation.questionRoute === undefined
					? null
					: JSON.stringify({
							targetSessionId: reservation.questionRoute.targetSessionId,
							senderGroupIdentity: reservation.questionRoute.senderGroupIdentity,
						});
			return database.transaction(async (tx) => {
				const { changes } = await tx.run(
					`INSERT INTO ${table}(message_id, digest, target_identity, question_route_json, state, recorded_at)
					 VALUES (?, ?, ?, ?, 'reserved', ${STORE_NOW}) ON CONFLICT(message_id) DO NOTHING`,
					reservation.messageId,
					reservation.digest,
					reservation.targetIdentity,
					route,
				);
				if (changes === 1) return { status: "reserved" };
				const existing = await read(tx, reservation.messageId);
				if (existing === undefined || existing.digest !== reservation.digest) return { status: "conflict" };
				return { status: "match", state: existing.state };
			});
		},
		async accept(key: SentMessageKey): Promise<SentMessageAcceptResult> {
			if (key.messageId.length === 0) return emptyMessageId;
			return database.transaction(async (tx) => {
				const existing = await read(tx, key.messageId);
				if (existing === undefined) return { status: "missing" };
				if (existing.digest !== key.digest) return { status: "conflict" };
				await tx.run(`UPDATE ${table} SET state = 'accepted' WHERE message_id = ?`, key.messageId);
				return { status: "accepted" };
			});
		},
		async lookup(key: SentMessageKey): Promise<SentMessageLookupResult> {
			if (key.messageId.length === 0) return emptyMessageId;
			const existing = await read(database, key.messageId);
			if (existing === undefined) return { status: "miss" };
			if (existing.digest !== key.digest) return { status: "conflict" };
			return {
				status: "match",
				state: existing.state,
				targetIdentity: existing.target_identity,
				...questionRouteOf(existing),
			};
		},
		async forget(key: SentMessageKey): Promise<SentMessageForgetResult> {
			if (key.messageId.length === 0) return emptyMessageId;
			return database.transaction(async (tx) => {
				const existing = await read(tx, key.messageId);
				if (existing === undefined) return { status: "missing" };
				if (existing.digest !== key.digest) return { status: "conflict" };
				await tx.run(`DELETE FROM ${table} WHERE message_id = ?`, key.messageId);
				return { status: "forgotten" };
			});
		},
		async prune(olderThanMs: number): Promise<number> {
			const { changes } = await database.run(
				`DELETE FROM ${table} WHERE ${STORE_NOW} - recorded_at > ?`,
				olderThanMs,
			);
			return changes;
		},
	};
}
