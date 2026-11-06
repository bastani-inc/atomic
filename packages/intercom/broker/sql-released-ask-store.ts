import { type SqliteExecutor, type SqliteRow, type SqliteValue, validateStoragePrefix } from "@bastani/atomic/storage";
import type {
	IntercomBrokerStateOptions,
	InvalidStateInput,
	ReleasedAsk,
	ReleasedAskClaim,
	ReleasedAskKey,
	ReleasedAskRecord,
	ReleasedAskState,
	ReleasedAskStore,
	ReleasedAskSupersede,
	StateStoreInvalidReason,
} from "./multinode-state-store.js";

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

interface ReleasedAskRow extends SqliteRow {
	readonly question_id: string;
	readonly replier_session_id: string;
	readonly asker_session_id: string;
	readonly child_name: string;
	readonly state: ReleasedAskState;
	readonly reply_message_id: string | null;
	/** 1 when the ask is open past its deadline. */
	readonly lapsed: SqliteValue;
	/** Store-clock milliseconds since the ask was last claimed; null before its first claim. */
	readonly claim_age: SqliteValue;
}

const invalid = (reason: StateStoreInvalidReason): InvalidStateInput => ({ status: "invalid", reason });

export function invalidReleasedAsk(ask: ReleasedAsk): InvalidStateInput | undefined {
	if (ask.questionId.length === 0) return invalid("empty-message-id");
	if (ask.askerSessionId.length === 0 || ask.replierSessionId.length === 0) return invalid("empty-session-id");
	return ask.childName.length === 0 ? invalid("empty-child-name") : undefined;
}

export function invalidReleasedAskKey(key: ReleasedAskKey): InvalidStateInput | undefined {
	if (key.questionId.length === 0) return invalid("empty-message-id");
	return key.replierSessionId.length === 0 ? invalid("empty-session-id") : undefined;
}

export function invalidReleasedAskClaim(claim: ReleasedAskClaim): InvalidStateInput | undefined {
	return invalidReleasedAskKey(claim) ?? (claim.replyMessageId.length === 0 ? invalid("empty-message-id") : undefined);
}

export function invalidReleasedAskSupersede(claim: ReleasedAskSupersede): InvalidStateInput | undefined {
	return invalidReleasedAskClaim(claim) ?? (claim.staleReplyMessageId.length === 0 ? invalid("empty-message-id") : undefined);
}

function toRecord(row: ReleasedAskRow): ReleasedAskRecord {
	return {
		questionId: row.question_id,
		askerSessionId: row.asker_session_id,
		replierSessionId: row.replier_session_id,
		childName: row.child_name,
		state: row.state,
		...(row.reply_message_id === null ? {} : { replyMessageId: row.reply_message_id }),
	};
}

/** S3 (#4386): `ReleasedAskStore` on the shared storage adapter's database, table `<prefix>intercom_released_asks`. */
export async function openSqlReleasedAskStore({ database, prefix }: IntercomBrokerStateOptions): Promise<ReleasedAskStore> {
	const table = `${validateStoragePrefix(prefix)}intercom_released_asks`;
	await database.transaction((tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table}(
				"order" INTEGER PRIMARY KEY AUTOINCREMENT,
				question_id TEXT NOT NULL,
				replier_session_id TEXT NOT NULL,
				asker_session_id TEXT NOT NULL,
				child_name TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('open', 'claimed', 'answered')),
				reply_message_id TEXT,
				claimed_at INTEGER,
				expires_at INTEGER NOT NULL,
				UNIQUE(question_id, replier_session_id)
			);
		`),
	);
	const select = (executor: SqliteExecutor, key: ReleasedAskKey) =>
		executor.get<ReleasedAskRow>(
			`SELECT question_id, replier_session_id, asker_session_id, child_name, state, reply_message_id,
				(state = 'open' AND expires_at <= ${STORE_NOW}) AS lapsed,
				CASE WHEN claimed_at IS NULL THEN NULL ELSE MAX(0, ${STORE_NOW} - claimed_at) END AS claim_age
			 FROM ${table} WHERE question_id = ? AND replier_session_id = ?`,
			key.questionId,
			key.replierSessionId,
		);
	const live = (row: ReleasedAskRow | undefined): ReleasedAskRow | undefined =>
		row === undefined || Number(row.lapsed) === 1 ? undefined : row;

	return {
		async keep(asks, ttlMs) {
			for (const ask of asks) {
				const bad = invalidReleasedAsk(ask);
				if (bad !== undefined) return bad;
			}
			const kept = await database.transaction(async (tx) => {
				let inserted = 0;
				for (const ask of asks) {
					const { changes } = await tx.run(
						`INSERT INTO ${table}(question_id, replier_session_id, asker_session_id, child_name, state, expires_at)
						 VALUES (?, ?, ?, ?, 'open', ${STORE_NOW} + ?) ON CONFLICT DO NOTHING`,
						ask.questionId,
						ask.replierSessionId,
						ask.askerSessionId,
						ask.childName,
						ttlMs,
					);
					inserted += changes;
				}
				return inserted;
			});
			return { status: "kept", kept };
		},
		async lookup(key) {
			const bad = invalidReleasedAskKey(key);
			if (bad !== undefined) return bad;
			const row = live(await select(database, key));
			return row === undefined ? { status: "missing" } : { status: "found", ask: toRecord(row) };
		},
		async claim(claim) {
			const bad = invalidReleasedAskClaim(claim);
			if (bad !== undefined) return bad;
			return database.transaction(async (tx) => {
				const row = live(await select(tx, claim));
				if (row === undefined) return { status: "missing" } as const;
				if (row.state !== "open") {
					return { status: row.reply_message_id === claim.replyMessageId ? "claimed" : "taken", ask: toRecord(row) } as const;
				}
				return claimFor(tx, claim, row);
			});
		},
		async supersede(claim) {
			const bad = invalidReleasedAskSupersede(claim);
			if (bad !== undefined) return bad;
			return database.transaction(async (tx) => {
				const row = live(await select(tx, claim));
				if (row === undefined) return { status: "missing" } as const;
				const stale =
					row.state === "claimed" &&
					row.reply_message_id === claim.staleReplyMessageId &&
					Number(row.claim_age) > claim.staleAfterMs;
				if (!stale) {
					return { status: row.reply_message_id === claim.replyMessageId ? "claimed" : "taken", ask: toRecord(row) } as const;
				}
				return claimFor(tx, claim, row);
			});
		},
		async answer(claim) {
			const bad = invalidReleasedAskClaim(claim);
			if (bad !== undefined) return bad;
			return settle(claim, "answered", ["claimed", "answered"]);
		},
		async reopen(claim) {
			const bad = invalidReleasedAskClaim(claim);
			if (bad !== undefined) return bad;
			return settle(claim, "open", ["claimed"]);
		},
		async prune(olderThanMs) {
			const { changes } = await database.run(`DELETE FROM ${table} WHERE expires_at + ? < ${STORE_NOW}`, olderThanMs);
			return changes;
		},
	};

	/** Hand the ask to this reply now. */
	async function claimFor(tx: SqliteExecutor, claim: ReleasedAskClaim, row: ReleasedAskRow) {
		await tx.run(
			`UPDATE ${table} SET state = 'claimed', reply_message_id = ?, claimed_at = ${STORE_NOW}
			 WHERE question_id = ? AND replier_session_id = ?`,
			claim.replyMessageId,
			claim.questionId,
			claim.replierSessionId,
		);
		return {
			status: "claimed",
			ask: toRecord({ ...row, state: "claimed", reply_message_id: claim.replyMessageId }),
		} as const;
	}

	/** Move an ask this reply holds in one of `from` to `to`; an open ask forgets its reply. */
	function settle(claim: ReleasedAskClaim, to: ReleasedAskState, from: readonly ReleasedAskState[]) {
		return database.transaction(async (tx) => {
			const row = await select(tx, claim);
			if (row === undefined) return { status: "missing" } as const;
			if (!from.includes(row.state) || row.reply_message_id !== claim.replyMessageId) return { status: "stale" } as const;
			await tx.run(
				`UPDATE ${table} SET state = ?, reply_message_id = ? WHERE question_id = ? AND replier_session_id = ?`,
				to,
				to === "open" ? null : claim.replyMessageId,
				claim.questionId,
				claim.replierSessionId,
			);
			return { status: "settled" } as const;
		});
	}
}
