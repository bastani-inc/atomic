import { randomUUID } from "node:crypto";
import {
	type SqliteExecutor,
	type SqliteRow,
	type SqliteValue,
	validateStoragePrefix,
} from "@bastani/atomic/storage";
import type {
	ClaimedOutboxRow,
	InvalidStateInput,
	IntercomBrokerStateOptions,
	IntercomDeliveryFrame,
	OutboxClaim,
	OutboxClaimWriteRejection,
	OutboxRow,
	OutboxRowState,
	OutboxStore,
	StateStoreInvalidReason,
} from "./multinode-state-store.js";

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
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
		frame: JSON.parse(record.frame_json) as IntercomDeliveryFrame,
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
 * S2 outbox on the shared storage adapter's database, in `<prefix>intercom_outbox`. Every read-modify-write runs in
 * one `BEGIN IMMEDIATE` transaction, and every age is measured on the database clock.
 */
export async function openSqlOutboxStore(options: IntercomBrokerStateOptions): Promise<OutboxStore> {
	const { database } = options;
	const table = `${validateStoragePrefix(options.prefix)}intercom_outbox`;
	await database.exec(`
		CREATE TABLE IF NOT EXISTS ${table}(
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			message_id TEXT NOT NULL UNIQUE,
			target_identity TEXT NOT NULL,
			origin_broker_id TEXT NOT NULL,
			digest TEXT NOT NULL,
			frame_json TEXT NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'delivered', 'failed')),
			claim_attempts INTEGER NOT NULL DEFAULT 0,
			claimant_id TEXT,
			claim_token TEXT,
			claim_renewed_at INTEGER,
			failure_reason TEXT,
			settled_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS ${table}_target ON ${table}(target_identity, state, sequence);
	`);
	// #3983: added later; a table from an older broker gets the column, and an older broker ignores it.
	const known = await database.all<{ name: string }>(`PRAGMA table_info(${table})`);
	if (!known.some((column) => column.name === "saving_at")) {
		try {
			await database.exec(`ALTER TABLE ${table} ADD COLUMN saving_at INTEGER`);
		} catch (error) {
			// Another broker added it between the check and the change.
			if (!/duplicate column/i.test(error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : ""))
				throw error;
		}
	}

	const columns = `sequence, message_id, target_identity, origin_broker_id, digest, frame_json, state,
		claim_attempts, claimant_id, claim_token, failure_reason,
		CASE WHEN claim_renewed_at IS NULL THEN NULL ELSE MAX(0, ${STORE_NOW} - claim_renewed_at) END AS claim_age,
		CASE WHEN saving_at IS NULL THEN NULL ELSE MAX(0, ${STORE_NOW} - saving_at) END AS saving_age`;
	const select = (executor: SqliteExecutor, messageId: string) =>
		executor.get<OutboxRecord>(`SELECT ${columns} FROM ${table} WHERE message_id = ?`, messageId);
	const undelivered = (executor: SqliteExecutor, targetIdentity: string) =>
		executor.all<OutboxRecord>(
			`SELECT ${columns} FROM ${table} WHERE target_identity = ? AND ${UNDELIVERED} ORDER BY sequence`,
			targetIdentity,
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
			`UPDATE ${table} SET state = ?, failure_reason = ?, settled_at = ${STORE_NOW},
				claimant_id = NULL, claim_token = NULL, claim_renewed_at = NULL, saving_at = NULL
			WHERE message_id = ?`,
			state,
			reason === null ? null : JSON.stringify(reason),
			messageId,
		);
		return toRow((await select(executor, messageId))!);
	};

	return {
		async enqueue(request) {
			if (request.targetIdentity.length === 0) return invalid("empty-target-identity");
			if (request.originBrokerId.length === 0) return invalid("empty-broker-id");
			const messageId = request.frame.message.id;
			if (messageId.length === 0) return invalid("empty-message-id");
			const frameJson = JSON.stringify(request.frame);
			return database.transaction(async (executor) => {
				const existing = await select(executor, messageId);
				if (existing !== undefined) {
					return existing.digest === request.digest
						? ({ status: "duplicate", row: toRow(existing) } as const)
						: ({ status: "conflict", messageId } as const);
				}
				await executor.run(
					`INSERT INTO ${table}(message_id, target_identity, origin_broker_id, digest, frame_json, state)
					VALUES (?, ?, ?, ?, ?, 'queued')`,
					messageId,
					request.targetIdentity,
					request.originBrokerId,
					request.digest,
					frameJson,
				);
				return { status: "inserted", row: toRow((await select(executor, messageId))!) } as const;
			});
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
							claim_token = ?, claim_renewed_at = ${STORE_NOW}, saving_at = NULL
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
					`UPDATE ${table} SET claim_renewed_at = ${STORE_NOW} WHERE message_id = ?`,
					claim.messageId,
				);
				return { status: "renewed" } as const;
			});
		},

		reportSaving(claim) {
			return withClaim(claim, async (executor) => {
				await executor.run(`UPDATE ${table} SET saving_at = ${STORE_NOW} WHERE message_id = ?`, claim.messageId);
				return { status: "renewed" } as const;
			});
		},

		releaseClaim(claim) {
			return withClaim(claim, async (executor) => {
				await executor.run(
					`UPDATE ${table} SET state = 'queued', claimant_id = NULL, claim_token = NULL, claim_renewed_at = NULL,
						saving_at = NULL
					WHERE message_id = ?`,
					claim.messageId,
				);
				return { status: "released" } as const;
			});
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

		async listUndelivered(targetIdentity) {
			if (targetIdentity.length === 0) return invalid("empty-target-identity");
			return { status: "listed", rows: (await undelivered(database, targetIdentity)).map(toRow) };
		},

		async prune(settledOlderThanMs) {
			const result = await database.run(
				`DELETE FROM ${table}
				WHERE state IN ('delivered', 'failed') AND MAX(0, ${STORE_NOW} - settled_at) > ?`,
				settledOlderThanMs,
			);
			return result.changes;
		},
	};
}
