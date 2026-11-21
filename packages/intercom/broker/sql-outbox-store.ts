import { randomUUID } from "node:crypto";
import {
	dialectOf,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteValue,
	validateStoragePrefix,
} from "@bastani/atomic/storage";
import {
	OUTBOX_CLAIM_STALE_AFTER_MS,
	OUTBOX_EXPIRED_REASON,
	OUTBOX_TARGET_MAX_BYTES,
	OUTBOX_TARGET_MAX_ROWS,
	type ClaimedOutboxRow,
	type InvalidStateInput,
	type IntercomBrokerStateOptions,
	type OutboxClaim,
	type OutboxClaimWriteRejection,
	type OutboxEnqueueRequest,
	type OutboxEnqueueResult,
	type OutboxFrame,
	type OutboxRow,
	type OutboxRowState,
	type OutboxStore,
	type StateStoreInvalidReason,
} from "./multinode-state-store.js";
import { addMissingColumns } from "./sql-add-column.js";
import { ensureBrokerSchema } from "./sql-schema.js";

const UNDELIVERED = "state IN ('queued', 'claimed')";

interface OutboxRecord extends SqliteRow {
	readonly sequence: SqliteValue;
	readonly message_id: string;
	readonly target_identity: string;
	readonly origin_broker_id: string;
	readonly digest: string;
	readonly frame_json: string;
	readonly state: OutboxRowState;
	readonly claim_attempts: SqliteValue;
	readonly claimant_id: string | null;
	readonly claim_token: string | null;
	/** Store-clock milliseconds since the claim was taken or renewed; null when unclaimed. */
	readonly claim_age: SqliteValue;
	/** Store-clock milliseconds since the claim's recipient last reported it is still saving the row; null when never. */
	readonly saving_age: SqliteValue;
	readonly failure_reason: string | null;
}

const invalid = (reason: StateStoreInvalidReason): InvalidStateInput => ({ status: "invalid", reason });

function toRow(record: OutboxRecord): OutboxRow {
	const failureReason = record.failure_reason;
	return {
		sequence: Number(record.sequence),
		messageId: record.message_id,
		targetIdentity: record.target_identity,
		originBrokerId: record.origin_broker_id,
		digest: record.digest,
		frame: JSON.parse(record.frame_json) as OutboxFrame,
		state: record.state,
		claimAttempts: Number(record.claim_attempts),
		...(failureReason === null ? {} : { failureReason: JSON.parse(failureReason) as string }),
		...(record.saving_age === null || record.saving_age === undefined
			? {}
			: { savingAgeMs: Number(record.saving_age) }),
	};
}

const isSettled = (record: OutboxRecord): boolean => record.state === "delivered" || record.state === "failed";

/**
 * #5607: the wake-up hint written with an offline recipient's row failed, so neither was written. The hint is only a
 * hint: the caller writes the row again without it (`withoutFailedWake`).
 */
export class OutboxWakeFailedError extends Error {
	constructor(cause: unknown) {
		super("The wake-up hint for a queued message could not be written", { cause });
		this.name = "OutboxWakeFailedError";
	}
}

/** The SQL outbox, which can also enqueue inside a transaction the caller holds. */
export interface SqlOutboxStore extends OutboxStore {
	/**
	 * `enqueue`, as part of `executor`'s transaction: the row is written only when that transaction commits. It throws
	 * `OutboxWakeFailedError` when only the optional wake-up hint failed; run the transaction again without it then.
	 */
	enqueueIn(executor: SqliteExecutor, request: OutboxEnqueueRequest): Promise<OutboxEnqueueResult>;
}

/**
 * #5607: runs `write` for `request`, and once more for it without its wake-up hint when only that hint failed it.
 */
export async function withoutFailedWake<T>(
	request: OutboxEnqueueRequest,
	write: (request: OutboxEnqueueRequest) => Promise<T>,
): Promise<T> {
	try {
		return await write(request);
	} catch (error) {
		if (!(error instanceof OutboxWakeFailedError)) throw error;
		const { wakeHostWithinMs: _hint, ...withoutHint } = request;
		return write(withoutHint);
	}
}

/**
 * S2 outbox on the shared storage adapter's database, in `<prefix>intercom_outbox`. Every read-modify-write runs in
 * one `BEGIN IMMEDIATE` transaction, and every age is measured on the database clock.
 */
export async function openSqlOutboxStore(options: IntercomBrokerStateOptions): Promise<SqlOutboxStore> {
	const { database } = options;
	const table = `${validateStoragePrefix(options.prefix, dialectOf(database).name)}intercom_outbox`;
	const { types, nowMs, greatest, name: dialect } = dialectOf(database);
	const ageSince = (column: string) => greatest("0", `${nowMs} - ${column}`);
	// In a serial transaction, so brokers opening a new store at once take turns creating it (#5054).
	const schema = `
		CREATE TABLE IF NOT EXISTS ${table}(
			sequence ${types.serialKey},
			message_id TEXT NOT NULL UNIQUE,
			target_identity TEXT NOT NULL,
			origin_broker_id TEXT NOT NULL,
			digest TEXT NOT NULL,
			frame_json TEXT NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'delivered', 'failed')),
			claim_attempts ${types.int} NOT NULL DEFAULT 0,
			claimant_id TEXT,
			claim_token TEXT,
			claim_renewed_at ${types.int},
			failure_reason TEXT,
			settled_at ${types.int}
		);
		CREATE INDEX IF NOT EXISTS ${table}_target ON ${table}(target_identity, state, sequence);
	`;
	await ensureBrokerSchema(database, options.prefix, "outbox", (tx) => tx.exec(schema));
	// #3983: added later; a table from an older broker gets the column, and an older broker ignores it.
	await addMissingColumns(database, table, { saving_at: types.int });
	// #4896: when the row was queued and the size of its frame; rows an older broker wrote have neither.
	await addMissingColumns(database, table, { queued_at: types.int, frame_bytes: types.int });
	// The per-recipient cap is summed from this index alone. Summed from the rows, `frame_bytes`, stored after the
	// frame, cost a read of every queued frame (overflow pages and all) on every enqueue. In a serial transaction (#5054).
	await ensureBrokerSchema(database, options.prefix, "outbox-indexes", (tx) =>
		tx.exec(`CREATE INDEX IF NOT EXISTS ${table}_target_bytes ON ${table}(target_identity, state, frame_bytes)`),
	);

	const columns = `sequence, message_id, target_identity, origin_broker_id, digest, frame_json, state,
		claim_attempts, claimant_id, claim_token, failure_reason,
		CASE WHEN claim_renewed_at IS NULL THEN NULL ELSE ${ageSince("claim_renewed_at")} END AS claim_age,
		CASE WHEN saving_at IS NULL THEN NULL ELSE ${ageSince("saving_at")} END AS saving_age`;
	const select = (executor: SqliteExecutor, messageId: string) =>
		executor.get<OutboxRecord>(`SELECT ${columns} FROM ${table} WHERE message_id = ?`, messageId);
	// #5607: the lease store's table, whose presence leases name the broker hosting a recipient, and the wake-up bus's
	// hint log. The broker opens both before it enqueues anything.
	const leases = `${validateStoragePrefix(options.prefix, dialectOf(database).name)}intercom_leases`;
	const wakeups = `${validateStoragePrefix(options.prefix, dialectOf(database).name)}intercom_wakeups`;
	const undelivered = (executor: SqliteExecutor, targetIdentity: string, limit?: number) =>
		limit === undefined
			? executor.all<OutboxRecord>(
					`SELECT ${columns} FROM ${table} WHERE target_identity = ? AND ${UNDELIVERED} ORDER BY sequence`,
					targetIdentity,
				)
			: executor.all<OutboxRecord>(
					`SELECT ${columns} FROM ${table} WHERE target_identity = ? AND ${UNDELIVERED} ORDER BY sequence LIMIT ?`,
					targetIdentity,
					limit,
				);
	const isLive = (record: OutboxRecord, staleAfterMs: number): boolean =>
		record.claim_age !== null && Number(record.claim_age) <= staleAfterMs;

	/** Runs `write` only for the row's current claim; every other case is reported as the contract requires. */
	const withClaim = <Result>(
		claim: OutboxClaim,
		write: (executor: SqliteExecutor) => Promise<Result>,
	): Promise<Result | OutboxClaimWriteRejection> => {
		if (claim.messageId.length === 0) return Promise.resolve(invalid("empty-message-id"));
		if (claim.claimantId.length === 0) return Promise.resolve(invalid("empty-claimant-id"));
		return database.transaction(async (executor) => {
			const record = await select(executor, claim.messageId);
			if (record === undefined) return { status: "unknown" } as const;
			if (isSettled(record)) return { status: "settled", row: toRow(record) } as const;
			if (record.claim_token !== claim.token || record.claimant_id !== claim.claimantId) {
				return { status: "stale" } as const;
			}
			return write(executor);
		});
	};

	const settle = async (
		executor: SqliteExecutor,
		messageId: string,
		state: "delivered" | "failed",
		reason: string | null,
	): Promise<OutboxRow> => {
		await executor.run(
			`UPDATE ${table} SET state = ?, failure_reason = ?, settled_at = ${nowMs},
				claimant_id = NULL, claim_token = NULL, claim_renewed_at = NULL, saving_at = NULL
			WHERE message_id = ?`,
			state,
			reason === null ? null : JSON.stringify(reason),
			messageId,
		);
		return toRow((await select(executor, messageId))!);
	};

	/**
	 * #4896: the recipient's undelivered rows and their frame bytes, read from `<table>_target_bytes` alone. Only rows an
	 * older broker wrote, without `frame_bytes`, are measured from their frames.
	 */
	const queuedTotals = async (executor: SqliteExecutor, targetIdentity: string) => {
		const sized = (await executor.get<{ row_count: SqliteValue; byte_count: SqliteValue; unsized: SqliteValue }>(
			`SELECT COUNT(*) AS row_count, COALESCE(SUM(frame_bytes), 0) AS byte_count, COUNT(*) - COUNT(frame_bytes) AS unsized
			FROM ${table} WHERE target_identity = ? AND ${UNDELIVERED}`,
			targetIdentity,
		))!;
		const unsized =
			Number(sized.unsized) === 0
				? 0
				: Number(
						(await executor.get<{ byte_count: SqliteValue }>(
							`SELECT COALESCE(SUM(LENGTH(frame_json)), 0) AS byte_count
							FROM ${table} WHERE target_identity = ? AND ${UNDELIVERED} AND frame_bytes IS NULL`,
							targetIdentity,
						))!.byte_count,
					);
		return { rows: Number(sized.row_count), bytes: Number(sized.byte_count) + unsized };
	};

	const enqueueIn = async (executor: SqliteExecutor, request: OutboxEnqueueRequest): Promise<OutboxEnqueueResult> => {
		if (request.targetIdentity.length === 0) return invalid("empty-target-identity");
		if (request.originBrokerId.length === 0) return invalid("empty-broker-id");
		const messageId = request.frame.message.id;
		if (messageId.length === 0) return invalid("empty-message-id");
		const frameJson = JSON.stringify(request.frame);
		const existing = await select(executor, messageId);
		if (existing !== undefined) {
			return existing.digest === request.digest
				? ({ status: "duplicate", row: toRow(existing) } as const)
				: ({ status: "conflict", messageId } as const);
		}
		const frameBytes = Buffer.byteLength(frameJson);
		const queued = request.owed === true ? undefined : await queuedTotals(executor, request.targetIdentity);
		if (
			queued !== undefined &&
			(queued.rows >= OUTBOX_TARGET_MAX_ROWS || queued.bytes + frameBytes > OUTBOX_TARGET_MAX_BYTES)
		) {
			return { status: "full", limit: OUTBOX_TARGET_MAX_ROWS, byteLimit: OUTBOX_TARGET_MAX_BYTES } as const;
		}
		const insert = `INSERT INTO ${table}(message_id, target_identity, origin_broker_id, digest, frame_json, state, queued_at,
				frame_bytes)
			VALUES (?, ?, ?, ?, ?, 'queued', ${nowMs}, ?)`;
		const values = [messageId, request.targetIdentity, request.originBrokerId, request.digest, frameJson, frameBytes];
		if (request.wakeHostWithinMs === undefined) {
			await executor.run(insert, ...values);
			return { status: "inserted", row: toRow((await select(executor, messageId))!) } as const;
		}
		// #5607: the row comes back from its insert, with the broker holding the recipient's live presence, read in this
		// transaction: a presence lease committed before it is seen here; one committed after it was written after this row,
		// and the registration that wrote it looks for the row next. Only when there is one does a second statement write
		// its wake-up hint, in this transaction too.
		const inserted = (await executor.get<OutboxRecord & { readonly presence_holder: string | null }>(
			`${insert} RETURNING ${columns}, (
				SELECT presence.holder_id FROM ${leases} presence
				WHERE presence.kind = 'presence' AND presence.key = ? AND presence.holder_id IS NOT NULL
					AND ${greatest("0", `${nowMs} - presence.renewed_at`)} <= ?
			) AS presence_holder`,
			...values,
			request.targetIdentity,
			request.wakeHostWithinMs,
		))!;
		const host = inserted.presence_holder;
		if (host !== null) {
			const hint = async () => {
				// PostgreSQL: never wait behind another session's lock on the hint log; such a hint goes without.
				if (dialect === "postgres") await executor.run(`LOCK TABLE ${wakeups} IN ROW EXCLUSIVE MODE NOWAIT`);
				await executor.run(
					`INSERT INTO ${wakeups}(broker_id, reason, version, created_at) VALUES (?, 'outbox', ?, ${nowMs})`,
					host,
					Number(inserted.sequence),
				);
			};
			await hint().catch((cause: unknown) => {
				throw new OutboxWakeFailedError(cause);
			});
		}
		return { status: "inserted", row: toRow(inserted), ...(host === null ? {} : { woke: host }) } as const;
	};

	return {
		enqueueIn,
		async enqueue(request) {
			if (request.targetIdentity.length === 0) return invalid("empty-target-identity");
			if (request.originBrokerId.length === 0) return invalid("empty-broker-id");
			if (request.frame.message.id.length === 0) return invalid("empty-message-id");
			return withoutFailedWake(request, (attempt) =>
				database.transaction((executor) => enqueueIn(executor, attempt)),
			);
		},

		async claim(request) {
			if (request.claimantId.length === 0) return invalid("empty-claimant-id");
			if (request.targetIdentity.length === 0) return invalid("empty-target-identity");
			return database.transaction(async (executor) => {
				const records = await undelivered(executor, request.targetIdentity);
				const other = records.find(
					(record) =>
						record.state === "claimed" &&
						record.claimant_id !== request.claimantId &&
						isLive(record, request.staleAfterMs),
				);
				if (other?.claimant_id) return { status: "held", claimantId: other.claimant_id } as const;
				const rows: ClaimedOutboxRow[] = [];
				for (const record of records) {
					if (record.state === "claimed" && isLive(record, request.staleAfterMs)) continue;
					const token = randomUUID();
					await executor.run(
						`UPDATE ${table} SET state = 'claimed', claim_attempts = claim_attempts + 1, claimant_id = ?,
							claim_token = ?, claim_renewed_at = ${nowMs}, saving_at = NULL
						WHERE message_id = ?`,
						request.claimantId,
						token,
						record.message_id,
					);
					const row = toRow((await select(executor, record.message_id))!);
					rows.push({
						row,
						claim: { messageId: row.messageId, claimantId: request.claimantId, token, attempt: row.claimAttempts },
					});
				}
				return { status: "claimed", rows } as const;
			});
		},

		renewClaim(claim) {
			return withClaim(claim, async (executor) => {
				await executor.run(
					`UPDATE ${table} SET claim_renewed_at = ${nowMs} WHERE message_id = ?`,
					claim.messageId,
				);
				return { status: "renewed" } as const;
			});
		},

		reportSaving(claim) {
			return withClaim(claim, async (executor) => {
				await executor.run(`UPDATE ${table} SET saving_at = ${nowMs} WHERE message_id = ?`, claim.messageId);
				return { status: "renewed" } as const;
			});
		},

		releaseClaim(claim, options) {
			const attempts = options?.unwritten === true ? `, claim_attempts = ${greatest("0", "claim_attempts - 1")}` : "";
			return withClaim(claim, async (executor) => {
				await executor.run(
					`UPDATE ${table} SET state = 'queued', claimant_id = NULL, claim_token = NULL, claim_renewed_at = NULL,
						saving_at = NULL${attempts}
					WHERE message_id = ?`,
					claim.messageId,
				);
				return { status: "released" } as const;
			});
		},

		async releaseClaimsOf(claimantId) {
			const { changes } = await database.run(
				`UPDATE ${table} SET state = 'queued', claimant_id = NULL, claim_token = NULL, claim_renewed_at = NULL,
					saving_at = NULL
				WHERE state = 'claimed' AND claimant_id = ?`,
				claimantId,
			);
			return changes;
		},

		markDelivered(claim) {
			return withClaim(claim, async (executor) => ({
				status: "delivered" as const,
				row: await settle(executor, claim.messageId, "delivered", null),
			}));
		},

		markFailed(claim, reason) {
			return withClaim(claim, async (executor) => ({
				status: "failed" as const,
				row: await settle(executor, claim.messageId, "failed", reason),
			}));
		},

		async read(messageId) {
			if (messageId.length === 0) return invalid("empty-message-id");
			const record = await select(database, messageId);
			return record === undefined ? { status: "missing" } : { status: "found", row: toRow(record) };
		},

		async listUndelivered(targetIdentity, limit) {
			if (targetIdentity.length === 0) return invalid("empty-target-identity");
			return { status: "listed", rows: (await undelivered(database, targetIdentity, limit)).map(toRow) };
		},

		async undeliveredPosition(targetIdentity, messageId) {
			if (targetIdentity.length === 0) return invalid("empty-target-identity");
			if (messageId.length === 0) return invalid("empty-message-id");
			// Counted on the (target_identity, state, sequence) index: no row, and no frame, is read.
			const counted = await database.get<{ position: SqliteValue }>(
				`SELECT COUNT(*) AS position FROM ${table}
				WHERE target_identity = ? AND ${UNDELIVERED} AND sequence <= (
					SELECT sequence FROM ${table} WHERE message_id = ? AND target_identity = ? AND ${UNDELIVERED}
				)`,
				targetIdentity,
				messageId,
				targetIdentity,
			);
			const position = Number(counted?.position ?? 0);
			return position === 0 ? { status: "missing" } : { status: "positioned", position };
		},

		async prune(settledOlderThanMs, queuedOlderThanMs) {
			if (queuedOlderThanMs !== undefined) {
				await database.transaction(async (executor) => {
					// A row an older broker queued has no time: its retention starts now.
					await executor.run(`UPDATE ${table} SET queued_at = ${nowMs} WHERE queued_at IS NULL AND ${UNDELIVERED}`);
					await executor.run(
						`UPDATE ${table} SET state = 'failed', failure_reason = ?, settled_at = ${nowMs},
							claimant_id = NULL, claim_token = NULL, claim_renewed_at = NULL, saving_at = NULL
						WHERE ${UNDELIVERED} AND ${ageSince("queued_at")} > ?
							AND (claim_renewed_at IS NULL OR ${ageSince("claim_renewed_at")} > ?)`,
						JSON.stringify(OUTBOX_EXPIRED_REASON),
						queuedOlderThanMs,
						OUTBOX_CLAIM_STALE_AFTER_MS,
					);
				});
			}
			const result = await database.run(
				`DELETE FROM ${table}
				WHERE state IN ('delivered', 'failed') AND ${ageSince("settled_at")} > ?`,
				settledOlderThanMs,
			);
			return result.changes;
		},
	};
}
