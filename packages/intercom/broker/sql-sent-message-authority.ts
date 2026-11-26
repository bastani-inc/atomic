import {
	dialectOf,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteStatement,
	validateStoragePrefix,
} from "@bastani/atomic/storage";
import type {
	IntercomBrokerStateOptions,
	InvalidStateInput,
	SentMessageAcceptResult,
	SentMessageAuthority,
	SentMessageForgetResult,
	SentMessageKey,
	SentMessageLookupResult,
	SentMessageReservation,
	SentMessageReserveResult,
	SentMessageState,
	SentQuestionRoute,
} from "./multinode-state-store.js";
import { rowTransaction } from "./sql-outbox-store.js";
import { ensureBrokerSchema, withBrokerSchemaCatalog } from "./sql-schema.js";

type SentRow = SqliteRow & {
	digest: string;
	target_identity: string;
	question_route_json: string | null;
	state: SentMessageState;
};

const emptyMessageId: InvalidStateInput = { status: "invalid", reason: "empty-message-id" };

function questionRouteOf(row: SentRow): { questionRoute?: SentQuestionRoute } {
	if (row.question_route_json === null) return {};
	const { targetSessionId, senderGroupIdentity } = JSON.parse(row.question_route_json) as SentQuestionRoute;
	return { questionRoute: { targetSessionId, senderGroupIdentity } };
}

/** The SQL authority, which can also run inside a transaction the caller holds: it writes only when that commits. */
export interface SqlSentMessageAuthority extends SentMessageAuthority {
	reserveIn(executor: SqliteExecutor, reservation: SentMessageReservation): Promise<SentMessageReserveResult>;
	lookupIn(executor: SqliteExecutor, key: SentMessageKey): Promise<SentMessageLookupResult>;
	forgetIn(executor: SqliteExecutor, key: SentMessageKey): Promise<SentMessageForgetResult>;
	/** The read `lookupIn` makes for `messageId`, for a transaction's `leading` statements (#6560). */
	lookupStatement(messageId: string): SqliteStatement;
	/**
	 * The one write `reserveIn` makes for `reservation`, for a caller that needs no answer from it; undefined for a
	 * reservation `reserveIn` refuses without writing (#6560).
	 */
	reserveStatement(reservation: SentMessageReservation): SqliteStatement | undefined;
	/**
	 * An SQL condition that holds while `key` is the message's reservation, in the transaction that evaluates it: a
	 * send's outbox row is inserted only under it, after the send's own `reserveStatement` (#6560).
	 */
	reservedCondition(key: SentMessageKey): SqliteStatement;
}

/**
 * S3: `SentMessageAuthority` on the shared storage adapter's database, table `<prefix>intercom_sent_messages`.
 * Digests are opaque strings computed by the caller.
 */
export function openSqlSentMessageAuthority(options: IntercomBrokerStateOptions): Promise<SqlSentMessageAuthority> {
	// Its schema checks answer from one read of the catalog, shared with an open around it: a current schema costs
	// no transaction and no lock, also when the store is opened on its own (#6560).
	return withBrokerSchemaCatalog(options.database, options.prefix, () => openSentMessageAuthorityInCatalog(options));
}

async function openSentMessageAuthorityInCatalog({
	database,
	prefix,
}: IntercomBrokerStateOptions): Promise<SqlSentMessageAuthority> {
	const table = `${validateStoragePrefix(prefix, dialectOf(database).name)}intercom_sent_messages`;
	const { types, nowMs } = dialectOf(database);
	/**
	 * Its own transactions write one row each, in one statement that decides on the row's lock and newest version, so
	 * they take no lock domain. A send's `reserveAndEnqueue` writes the message's row first, in its recipient's domain,
	 * and inserts its outbox row only under it (`reservedCondition`), so a rival reservation of the message either
	 * comes first and refuses the send, or waits for it and is refused (#6560).
	 */
	const fenced = rowTransaction();
	await ensureBrokerSchema(database, prefix, "sent-messages", (tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table}(
				message_id TEXT PRIMARY KEY,
				digest TEXT NOT NULL,
				target_identity TEXT NOT NULL,
				question_route_json TEXT,
				state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted')),
				recorded_at ${types.int} NOT NULL
			);
			CREATE INDEX IF NOT EXISTS ${table}_recorded ON ${table}(recorded_at);
		`),
	);
	const lookupStatement = (messageId: string): SqliteStatement => ({
		sql: `SELECT digest, target_identity, question_route_json, state FROM ${table} WHERE message_id = ?`,
		params: [messageId],
	});
	const read = (executor: SqliteExecutor, messageId: string) => {
		const { sql, params } = lookupStatement(messageId);
		return executor.get<SentRow>(sql, ...params);
	};

	const reserveStatement = (reservation: SentMessageReservation): SqliteStatement | undefined => {
		if (reservation.messageId.length === 0 || reservation.targetIdentity.length === 0) return undefined;
		const route =
			reservation.questionRoute === undefined
				? null
				: JSON.stringify({
						targetSessionId: reservation.questionRoute.targetSessionId,
						senderGroupIdentity: reservation.questionRoute.senderGroupIdentity,
					});
		return {
			sql: `INSERT INTO ${table}(message_id, digest, target_identity, question_route_json, state, recorded_at)
			 VALUES (?, ?, ?, ?, 'reserved', ${nowMs}) ON CONFLICT(message_id) DO NOTHING`,
			params: [reservation.messageId, reservation.digest, reservation.targetIdentity, route],
		};
	};

	const reserveIn = async (
		tx: SqliteExecutor,
		reservation: SentMessageReservation,
	): Promise<SentMessageReserveResult> => {
		if (reservation.messageId.length === 0) return emptyMessageId;
		if (reservation.targetIdentity.length === 0) return { status: "invalid", reason: "empty-target-identity" };
		const { sql, params } = reserveStatement(reservation)!;
		const { changes } = await tx.run(sql, ...params);
		if (changes === 1) return { status: "reserved" };
		const existing = await read(tx, reservation.messageId);
		if (existing === undefined || existing.digest !== reservation.digest) return { status: "conflict" };
		return { status: "match", state: existing.state };
	};

	const lookupIn = async (executor: SqliteExecutor, key: SentMessageKey): Promise<SentMessageLookupResult> => {
		if (key.messageId.length === 0) return emptyMessageId;
		const existing = await read(executor, key.messageId);
		if (existing === undefined) return { status: "miss" };
		if (existing.digest !== key.digest) return { status: "conflict" };
		return {
			status: "match",
			state: existing.state,
			targetIdentity: existing.target_identity,
			...questionRouteOf(existing),
		};
	};

	/** The message's row, deleted only while it holds `key`'s digest (#6560). */
	const forgetStatement = (key: SentMessageKey): SqliteStatement => ({
		sql: `DELETE FROM ${table} WHERE message_id = ? AND digest = ?`,
		params: [key.messageId, key.digest],
	});
	const acceptStatement = (key: SentMessageKey): SqliteStatement => ({
		sql: `UPDATE ${table} SET state = 'accepted' WHERE message_id = ? AND digest = ?`,
		params: [key.messageId, key.digest],
	});
	/**
	 * Why a write guarded by `key`'s digest changed nothing: another digest holds the message, or none did when the write
	 * ran (one inserted since then came after it).
	 */
	const refusal = async (tx: SqliteExecutor, key: SentMessageKey) => {
		const existing = await read(tx, key.messageId);
		return existing !== undefined && existing.digest !== key.digest
			? ({ status: "conflict" } as const)
			: ({ status: "missing" } as const);
	};

	const forgetIn = async (tx: SqliteExecutor, key: SentMessageKey): Promise<SentMessageForgetResult> => {
		if (key.messageId.length === 0) return emptyMessageId;
		const { sql, params } = forgetStatement(key);
		const { changes } = await tx.run(sql, ...params);
		return changes > 0 ? { status: "forgotten" } : refusal(tx, key);
	};

	/** A transaction whose first statement, sent with its start on a pipelined connection, is `first` (#6560). */
	const leadingWith = (first: SqliteStatement) => ({ ...fenced, leading: [first] });

	return {
		reserveIn,
		lookupIn,
		forgetIn,
		lookupStatement,
		reserveStatement,
		reservedCondition: (key) => ({
			sql: `EXISTS (SELECT 1 FROM ${table} WHERE message_id = ? AND digest = ?)`,
			params: [key.messageId, key.digest],
		}),
		async reserve(reservation): Promise<SentMessageReserveResult> {
			if (reservation.messageId.length === 0) return emptyMessageId;
			if (reservation.targetIdentity.length === 0) return { status: "invalid", reason: "empty-target-identity" };
			return database.transaction((tx) => reserveIn(tx, reservation), leadingWith(reserveStatement(reservation)!));
		},
		async accept(key: SentMessageKey): Promise<SentMessageAcceptResult> {
			if (key.messageId.length === 0) return emptyMessageId;
			const accepting = acceptStatement(key);
			return database.transaction(async (tx) => {
				const { changes } = await tx.run(accepting.sql, ...accepting.params);
				return changes > 0 ? { status: "accepted" } : refusal(tx, key);
			}, leadingWith(accepting));
		},
		lookup(key: SentMessageKey): Promise<SentMessageLookupResult> {
			return lookupIn(database, key);
		},
		async forget(key: SentMessageKey): Promise<SentMessageForgetResult> {
			if (key.messageId.length === 0) return emptyMessageId;
			return database.transaction((tx) => forgetIn(tx, key), leadingWith(forgetStatement(key)));
		},
		async prune(olderThanMs: number): Promise<number> {
			const { changes } = await database.run(
				`DELETE FROM ${table} WHERE ${nowMs} - recorded_at > ?`,
				olderThanMs,
			);
			return changes;
		},
	};
}
