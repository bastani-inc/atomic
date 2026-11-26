import { randomUUID } from "node:crypto";
import {
	dialectOf,
	fencedPath,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteStatement,
	type SqliteTransactionOptions,
	type SqliteValue,
	validateStoragePrefix,
} from "@bastani/atomic/storage";
import * as storage from "@bastani/atomic/storage";
import {
	OUTBOX_CLAIM_STALE_AFTER_MS,
	OUTBOX_EXPIRED_REASON,
	OUTBOX_TARGET_MAX_BYTES,
	OUTBOX_TARGET_MAX_ROWS,
	type InvalidStateInput,
	type IntercomBrokerStateOptions,
	type OutboxClaim,
	type OutboxClaimResult,
	type OutboxClaimWriteRejection,
	type OutboxDeliveredResult,
	type OutboxEnqueueRequest,
	type OutboxEnqueueResult,
	type OutboxFrame,
	type OutboxRow,
	type OutboxRowState,
	type OutboxStore,
	type StateStoreInvalidReason,
} from "./multinode-state-store.js";
import { addMissingColumns } from "./sql-add-column.js";
import { ensureBrokerSchema, withBrokerSchemaCatalog } from "./sql-schema.js";

const UNDELIVERED = "state IN ('queued', 'claimed')";
/** The most `markDelivered` calls one transaction settles together (#6560). */
const MARK_DELIVERED_BATCH_MAX = 100;

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

/**
 * What an enqueue writes first and requires: a send's reservation of its message (#6560). `first` is written just
 * before the row, in the same transaction, and the row is inserted only while `condition`, an SQL boolean expression
 * with its parameters, holds; when it does not, and no row of the message is there, the enqueue reports a conflict.
 */
export interface OutboxEnqueueGuard {
	readonly first: SqliteStatement;
	readonly condition: SqliteStatement;
}

/** The SQL outbox, which can also enqueue inside a transaction the caller holds. */
export interface SqlOutboxStore extends OutboxStore {
	/**
	 * `enqueue`, as part of `executor`'s transaction: the row is written only when that transaction commits. It throws
	 * `OutboxWakeFailedError` when only the optional wake-up hint failed; run the transaction again without it then.
	 * The transaction must hold the recipient's domain (`recipientTransaction`).
	 */
	enqueueIn(
		executor: SqliteExecutor,
		request: OutboxEnqueueRequest,
		guard?: OutboxEnqueueGuard,
	): Promise<OutboxEnqueueResult>;
	/**
	 * The reads `enqueueIn` makes first for `request`, in order, for a transaction's `leading` statements: a pipelined
	 * connection sends them with the transaction's start instead of a round trip each (#6560).
	 */
	enqueueLeading(request: OutboxEnqueueRequest): readonly SqliteStatement[];
}

/**
 * Runs `statements` as the last calls of `executor`'s transaction: on a pipelined connection they go out with the
 * commit, in one round trip; elsewhere each runs in turn as `run` runs it. The transaction's callback must make no call
 * after them (#6560).
 */
export async function runLast(executor: SqliteExecutor, ...statements: SqliteStatement[]): Promise<void> {
	if (statements.length === 0 || finisherOf?.(executor)?.(statements) === true) return;
	for (const { sql, params } of statements) await executor.run(sql, ...params);
}

/**
 * `transactionFinisher` of the storage module, where the copy the process loaded has it: a host whose Atomic predates it
 * runs every statement in turn (#6560).
 */
const finisherOf: (typeof storage)["transactionFinisher"] | undefined = (
	storage as Partial<Pick<typeof storage, "transactionFinisher">>
).transactionFinisher;

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
 * The lock domain of one recipient's sends, `<outbox>:<recipient>`: a send reserves its message and queues its row in
 * one transaction of it (`reserveAndEnqueue`, `enqueue`), so sends to one recipient run one at a time, and commit their
 * rows in the order of their sequence, and a send's checks of that recipient's queue (its size budget) hold until it
 * commits. Sends to other recipients, claims and every write of one row run beside them (#6560).
 */
export function recipientTransaction(
	database: SqliteDatabase,
	prefix: string | undefined,
	targetIdentity: string,
): SqliteTransactionOptions {
	const outbox = `${validateStoragePrefix(prefix, dialectOf(database).name)}intercom_outbox`;
	return { concurrency: { kind: "serial", domain: `${outbox}:${targetIdentity}` } };
}

/**
 * A transaction of the outbox or the sent-message table that takes no lock domain: each of its writes decides on the
 * rows it locks itself (`fencedPath("intercom-outbox-row")`). It still waits for and excludes the database-wide
 * transactions an older broker runs on these tables (#6560).
 */
export function rowTransaction(): SqliteTransactionOptions {
	return { concurrency: { kind: "fenced", audit: fencedPath("intercom-outbox-row"), excludesSerial: true } };
}

/**
 * S2 outbox on the shared storage adapter's database, in `<prefix>intercom_outbox`. Every read-modify-write runs in
 * one `BEGIN IMMEDIATE` transaction, and every age is measured on the database clock. On a database whose transactions
 * run concurrently (PostgreSQL), an enqueue holds its recipient's domain (`recipientTransaction`); a claim locks the
 * recipient's rows in sequence order and every write of a claimed row is one statement guarded by its claim token
 * (`rowTransaction`), so no write waits for another recipient's (#6560).
 */
export function openSqlOutboxStore(options: IntercomBrokerStateOptions): Promise<SqlOutboxStore> {
	// Its schema checks answer from one read of the catalog, shared with an open around it: a current schema costs
	// no transaction and no lock, also when the store is opened on its own (#6560).
	return withBrokerSchemaCatalog(options.database, options.prefix, () => openOutboxStoreInCatalog(options));
}

async function openOutboxStoreInCatalog(options: IntercomBrokerStateOptions): Promise<SqlOutboxStore> {
	const { database } = options;
	const table = `${validateStoragePrefix(options.prefix, dialectOf(database).name)}intercom_outbox`;
	const { types, nowMs, greatest, lockClause, name: dialect } = dialectOf(database);
	/** Claims, claim writes and expiry: each decides on the rows it locks (#6560). */
	const fenced = rowTransaction();
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
	const selectStatement = (messageId: string): SqliteStatement => ({
		sql: `SELECT ${columns} FROM ${table} WHERE message_id = ?`,
		params: [messageId],
	});
	const select = (executor: SqliteExecutor, messageId: string) => {
		const { sql, params } = selectStatement(messageId);
		return executor.get<OutboxRecord>(sql, ...params);
	};
	// #5607: the lease store's table, whose presence leases name the broker hosting a recipient, and the wake-up bus's
	// hint log. The broker opens both before it enqueues anything.
	const leases = `${validateStoragePrefix(options.prefix, dialectOf(database).name)}intercom_leases`;
	const wakeups = `${validateStoragePrefix(options.prefix, dialectOf(database).name)}intercom_wakeups`;
	const allUndeliveredStatement = (targetIdentity: string): SqliteStatement => ({
		sql: `SELECT ${columns} FROM ${table} WHERE target_identity = ? AND ${UNDELIVERED} ORDER BY sequence`,
		params: [targetIdentity],
	});
	const undelivered = (executor: SqliteExecutor, targetIdentity: string, limit?: number) => {
		if (limit === undefined) {
			const { sql, params } = allUndeliveredStatement(targetIdentity);
			return executor.all<OutboxRecord>(sql, ...params);
		}
		return executor.all<OutboxRecord>(
			`SELECT ${columns} FROM ${table} WHERE target_identity = ? AND ${UNDELIVERED} ORDER BY sequence LIMIT ?`,
			targetIdentity,
			limit,
		);
	};

	/**
	 * Applies `assignments` (with their parameters) to the row only while `claim` is its current claim: one UPDATE whose
	 * WHERE names the claim, so the decision is made on the row's lock and its newest version, never on an earlier read.
	 * The update is the transaction's first statement, sent with its start; only when it changed nothing is the row read,
	 * to report why (#6560).
	 */
	const withClaim = <Result>(
		claim: OutboxClaim,
		assignments: string,
		params: readonly SqliteValue[],
		answer: (written: OutboxRecord) => Result,
	): Promise<Result | OutboxClaimWriteRejection> => {
		if (claim.messageId.length === 0) return Promise.resolve(invalid("empty-message-id"));
		if (claim.claimantId.length === 0) return Promise.resolve(invalid("empty-claimant-id"));
		const write: SqliteStatement = {
			sql: `UPDATE ${table} SET ${assignments}
				WHERE message_id = ? AND claim_token = ? AND claimant_id = ? AND state = 'claimed'
				RETURNING ${columns}`,
			params: [...params, claim.messageId, claim.token, claim.claimantId],
		};
		return database.transaction(
			async (executor) => {
				const written = await executor.get<OutboxRecord>(write.sql, ...write.params);
				if (written !== undefined) return answer(written);
				const record = await select(executor, claim.messageId);
				if (record === undefined) return { status: "unknown" } as const;
				if (isSettled(record)) return { status: "settled", row: toRow(record) } as const;
				return { status: "stale" } as const;
			},
			{ ...fenced, leading: [write] },
		);
	};

	const settled = `failure_reason = ?, settled_at = ${nowMs},
		claimant_id = NULL, claim_token = NULL, claim_renewed_at = NULL, saving_at = NULL`;

	/**
	 * Settles each of `claims`, of distinct rows, as delivered, in one transaction: one UPDATE, sent with its start, that
	 * locks their rows in sequence order, as a claim locks a recipient's rows, and changes those whose claim is still
	 * current. Only when it changed fewer rows than it was given are the others read, to report why (#6560).
	 */
	const markDeliveredTogether = (claims: readonly OutboxClaim[]): Promise<OutboxDeliveredResult[]> => {
		const current = claims.map(() => "(message_id = ? AND claim_token = ? AND claimant_id = ?)").join(" OR ");
		const keys = claims.flatMap((claim) => [claim.messageId, claim.token, claim.claimantId]);
		const write: SqliteStatement = {
			sql: `UPDATE ${table} SET state = 'delivered', ${settled}
				WHERE message_id IN (
					SELECT message_id FROM ${table} WHERE state = 'claimed' AND (${current})
					ORDER BY sequence${lockClause("update")}
				) AND state = 'claimed' AND (${current})
				RETURNING ${columns}`,
			params: [null, ...keys, ...keys],
		};
		return database.transaction(
			async (executor) => {
				const written = new Map(
					(await executor.all<OutboxRecord>(write.sql, ...write.params)).map((record) => [record.message_id, record]),
				);
				const others = claims.filter((claim) => !written.has(claim.messageId));
				const found =
					others.length === 0
						? new Map<string, OutboxRecord>()
						: new Map(
								(
									await executor.all<OutboxRecord>(
										`SELECT ${columns} FROM ${table} WHERE message_id IN (${others.map(() => "?").join(", ")})`,
										...others.map((claim) => claim.messageId),
									)
								).map((record) => [record.message_id, record]),
							);
				return claims.map((claim): OutboxDeliveredResult => {
					const delivered = written.get(claim.messageId);
					if (delivered !== undefined) return { status: "delivered", row: toRow(delivered) };
					const record = found.get(claim.messageId);
					if (record === undefined) return { status: "unknown" };
					if (isSettled(record)) return { status: "settled", row: toRow(record) };
					return { status: "stale" };
				});
			},
			{ ...fenced, leading: [write] },
		);
	};

	/**
	 * The `markDelivered` calls waiting for the transaction that settles them, in the order they were made. On PostgreSQL
	 * the calls made while one transaction settles others go together in the next, whose round trips they share, rather
	 * than two round trips each: one transaction at a time, so each commits after every call made before it (#6560).
	 */
	const deliveries: {
		readonly claim: OutboxClaim;
		readonly resolve: (result: OutboxDeliveredResult) => void;
		readonly reject: (error: unknown) => void;
	}[] = [];
	let delivering = false;
	const deliverQueued = async () => {
		// Calls made in the same turn as the first go with it.
		await undefined;
		while (deliveries.length > 0) {
			// The calls in order, up to one that names a row already in the batch: it goes in the next, so it finds the row as
			// the call before it left it.
			const rows = new Set<string>();
			let count = 0;
			while (
				count < deliveries.length &&
				count < MARK_DELIVERED_BATCH_MAX &&
				!rows.has(deliveries[count]!.claim.messageId)
			)
				rows.add(deliveries[count++]!.claim.messageId);
			const batch = deliveries.splice(0, count);
			try {
				const results = await markDeliveredTogether(batch.map(({ claim }) => claim));
				batch.forEach(({ resolve }, index) => resolve(results[index]!));
			} catch (error) {
				for (const { reject } of batch) reject(error);
			}
		}
		delivering = false;
	};

	/**
	 * #4896: the recipient's undelivered rows and their frame bytes, read from `<table>_target_bytes` alone. Only rows an
	 * older broker wrote, without `frame_bytes`, are measured from their frames.
	 */
	const sizedTotalsStatement = (targetIdentity: string): SqliteStatement => ({
		sql: `SELECT COUNT(*) AS row_count, COALESCE(SUM(frame_bytes), 0) AS byte_count, COUNT(*) - COUNT(frame_bytes) AS unsized
			FROM ${table} WHERE target_identity = ? AND ${UNDELIVERED}`,
		params: [targetIdentity],
	});
	const queuedTotals = async (executor: SqliteExecutor, targetIdentity: string) => {
		const totals = sizedTotalsStatement(targetIdentity);
		const sized = (await executor.get<{ row_count: SqliteValue; byte_count: SqliteValue; unsized: SqliteValue }>(
			totals.sql,
			...totals.params,
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

	const enqueueIn = async (
		executor: SqliteExecutor,
		request: OutboxEnqueueRequest,
		guard?: OutboxEnqueueGuard,
	): Promise<OutboxEnqueueResult> => {
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
		// Inserted only while the guard holds, and never over a row of the message that another recipient's send, in a
		// domain of its own, queued meanwhile: the unique message id makes that send's row, once it commits, the answer
		// (#6560). The guard's first write and the insert go out together.
		const condition = guard?.condition;
		const insert = `INSERT INTO ${table}(message_id, target_identity, origin_broker_id, digest, frame_json, state, queued_at,
				frame_bytes)
			SELECT ?, ?, ?, ?, ?, 'queued', ${nowMs}, CAST(? AS ${types.int})
			WHERE ${condition === undefined ? "1 = 1" : condition.sql}
			ON CONFLICT(message_id) DO NOTHING`;
		const values = [
			messageId,
			request.targetIdentity,
			request.originBrokerId,
			request.digest,
			frameJson,
			frameBytes,
			...(condition?.params ?? []),
		];
		const first = guard === undefined ? undefined : executor.run(guard.first.sql, ...guard.first.params);
		first?.catch(() => {});
		// The insert goes out behind the guard's write without waiting for its answer only on a pipelined transaction's
		// own handle, which sends calls in the order they are made; any other executor, a wrapper included, may run a
		// later call first, so the write is answered before the insert is made.
		if (finisherOf?.(executor) === undefined) await first;
		/** The answer of the insert, once the guard's write, sent before it, succeeded. */
		const after = async <T>(inserting: Promise<T>): Promise<T> => {
			inserting.catch(() => {});
			await first;
			return inserting;
		};
		/** Nothing was inserted: the message's row, which another send queued, or the guard's refusal. */
		const notInserted = async (): Promise<OutboxEnqueueResult> => {
			const queued = await select(executor, messageId);
			if (queued !== undefined && queued.digest === request.digest)
				return { status: "duplicate", row: toRow(queued) } as const;
			return { status: "conflict", messageId } as const;
		};
		if (request.wakeHostWithinMs === undefined) {
			// The row comes back from its insert, in the same round trip (#6560).
			const row = await after(executor.get<OutboxRecord>(`${insert} RETURNING ${columns}`, ...values));
			return row === undefined ? notInserted() : ({ status: "inserted", row: toRow(row) } as const);
		}
		// #5607: the row comes back from its insert, with the broker holding the recipient's live presence, read in this
		// transaction: a presence lease committed before it is seen here; one committed after it was written after this row,
		// and the registration that wrote it looks for the row next. Only when there is one does a second statement write
		// its wake-up hint, in this transaction too. On PostgreSQL leases are acquired beside this transaction
		// (#6560), so the read locks the lease: an acquisition under way commits first and is seen, and a later one
		// waits for this row.
		const inserted = await after(
			executor.get<OutboxRecord & { readonly presence_holder: string | null }>(
				`${insert} RETURNING ${columns}, (
				SELECT presence.holder_id FROM ${leases} presence
				WHERE presence.kind = 'presence' AND presence.key = ? AND presence.holder_id IS NOT NULL
					AND ${greatest("0", `${nowMs} - presence.renewed_at`)} <= ?${lockClause("share")}
			) AS presence_holder`,
				...values,
				request.targetIdentity,
				request.wakeHostWithinMs,
			),
		);
		if (inserted === undefined) return notInserted();
		const host = inserted.presence_holder;
		if (host !== null) {
			const hint = async () => {
				// PostgreSQL: never wait behind another session's lock on the hint log; such a hint goes without. The hint
				// is a new row, so it needs no lock domain of its own (#6560): see `fencedPath("intercom-wakeup-hint")`.
				if (dialect === "postgres") await executor.run(`LOCK TABLE ${wakeups} IN ROW EXCLUSIVE MODE NOWAIT`);
				await executor.run(
					`INSERT INTO ${wakeups}(broker_id, reason, version, created_at) VALUES (?, 'outbox', ?, ${nowMs})`,
					host,
					Number(inserted.sequence),
				);
				// Notified when it commits, as the wake-up bus's own hints are, so the host does not wait for its backup
				// poll (#6560).
				const notify = database.notifications?.notify(wakeups, host);
				if (notify !== undefined) await executor.run(notify.sql, ...notify.params);
			};
			await hint().catch((cause: unknown) => {
				throw new OutboxWakeFailedError(cause);
			});
		}
		return { status: "inserted", row: toRow(inserted), ...(host === null ? {} : { woke: host }) } as const;
	};

	const enqueueLeading = (request: OutboxEnqueueRequest): readonly SqliteStatement[] => [
		selectStatement(request.frame.message.id),
		...(request.owed === true ? [] : [sizedTotalsStatement(request.targetIdentity)]),
	];

	return {
		enqueueIn,
		enqueueLeading,
		async enqueue(request) {
			if (request.targetIdentity.length === 0) return invalid("empty-target-identity");
			if (request.originBrokerId.length === 0) return invalid("empty-broker-id");
			if (request.frame.message.id.length === 0) return invalid("empty-message-id");
			return withoutFailedWake(request, (attempt) =>
				database.transaction((executor) => enqueueIn(executor, attempt), {
					...recipientTransaction(database, options.prefix, attempt.targetIdentity),
					leading: enqueueLeading(attempt),
				}),
			);
		},

		async claim(request) {
			if (request.claimantId.length === 0) return invalid("empty-claimant-id");
			if (request.targetIdentity.length === 0) return invalid("empty-target-identity");
			const { claimantId, targetIdentity, staleAfterMs } = request;
			// Each row's token: this claim's, with the row's sequence, so every claimed row has a token of its own.
			const token = randomUUID();
			const claimed = (records: readonly OutboxRecord[]): OutboxClaimResult => ({
				status: "claimed",
				rows: [...records]
					.sort((first, second) => Number(first.sequence) - Number(second.sequence))
					.map((record) => {
						const row = toRow(record);
						const claim = { messageId: row.messageId, claimantId, token: String(record.claim_token), attempt: row.claimAttempts };
						return { row, claim };
					}),
			});
			const claiming = `state = 'claimed', claim_attempts = claim_attempts + 1, claimant_id = ?,
				claim_token = ? || ':' || CAST(sequence AS TEXT), claim_renewed_at = ${nowMs}, saving_at = NULL`;
			if (dialect === "postgres") {
				// One statement, sent with the transaction's start and its commit: one round trip whether or not there is anything
				// to claim (#6560). It locks the recipient's undelivered rows in sequence order, as every write of several rows
				// locks them, and reads them in their newest versions, so a renewal or settlement of one waits for this claim, or
				// this claim for it. It does not skip a locked row (SKIP LOCKED): an earlier row passed over could be handed out
				// after a later one, and another claimant's live claim would go unseen. Another claimant's live claim holds
				// every row; otherwise each row not live is claimed, and the claimant's own live claims stay in flight.
				const statement: SqliteStatement = {
					sql: `WITH locked AS MATERIALIZED (
						SELECT message_id, sequence, state, claimant_id, claim_renewed_at FROM ${table}
						WHERE target_identity = ? AND ${UNDELIVERED}
						ORDER BY sequence${lockClause("update")}
					), live AS MATERIALIZED (
						SELECT message_id, sequence, claimant_id FROM locked
						WHERE state = 'claimed' AND claim_renewed_at IS NOT NULL AND ${ageSince("claim_renewed_at")} <= ?
					), holder AS MATERIALIZED (
						SELECT claimant_id FROM live WHERE claimant_id <> ? ORDER BY sequence LIMIT 1
					), claimed AS (
						UPDATE ${table} SET ${claiming}
						WHERE message_id IN (SELECT message_id FROM locked)
							AND message_id NOT IN (SELECT message_id FROM live)
							AND NOT EXISTS (SELECT 1 FROM holder)
						RETURNING ${columns}
					)
					SELECT claimed.*, (SELECT claimant_id FROM holder) AS holder
					FROM (SELECT 1) AS answer LEFT JOIN claimed ON TRUE`,
					params: [targetIdentity, staleAfterMs, claimantId, claimantId, token],
				};
				return database.transaction(
					async (executor) => {
						const records = await executor.all<OutboxRecord & { readonly holder: string | null }>(
							statement.sql,
							...statement.params,
						);
						const holder = records[0]?.holder ?? null;
						if (holder !== null) return { status: "held", claimantId: holder } as const;
						return claimed(records.filter((record) => record.message_id !== null));
					},
					{ ...fenced, leading: [statement], leadingOnly: true },
				);
			}
			// SQLite and libSQL: a write statement takes the database's write lock even when it changes nothing, so a read
			// decides first, without it, whether there is anything to claim: empty scans (such as fan-out wake-up polls across
			// idle sessions) cost one read. Linearizable: if a row commits after this snapshot, its enqueue writes a new
			// wake-up hint. The same read answers a claim another claimant holds, or one of only the claimant's own rows in
			// flight. Otherwise one statement claims the rows, deciding again on what it changes (#6560).
			const live = (alias: string) =>
				`${alias}.state = 'claimed' AND ${alias}.claim_renewed_at IS NOT NULL
				AND ${ageSince(`${alias}.claim_renewed_at`)} <= ?`;
			const heldBy = `SELECT live.claimant_id FROM ${table} live
				WHERE live.target_identity = ? AND ${live("live")} AND live.claimant_id <> ?`;
			const probe = () =>
				database.get<{ holder: string | null; claimable: SqliteValue }>(
					`SELECT (${heldBy} ORDER BY live.sequence LIMIT 1) AS holder, EXISTS (
						SELECT 1 FROM ${table} pending WHERE pending.target_identity = ?
						AND pending.${UNDELIVERED} AND NOT (${live("pending")})
					) AS claimable`,
					targetIdentity,
					staleAfterMs,
					claimantId,
					targetIdentity,
					staleAfterMs,
				);
			const found = await probe();
			if (found !== undefined && found.holder !== null) return { status: "held", claimantId: found.holder } as const;
			if (Number(found?.claimable ?? 0) === 0) return { status: "claimed", rows: [] } as const;
			const records = await database.all<OutboxRecord>(
				`UPDATE ${table} SET ${claiming}
				WHERE target_identity = ? AND ${UNDELIVERED} AND NOT (${live(table)}) AND NOT EXISTS (${heldBy})
				RETURNING ${columns}`,
				claimantId,
				token,
				targetIdentity,
				staleAfterMs,
				targetIdentity,
				staleAfterMs,
				claimantId,
			);
			if (records.length > 0) return claimed(records);
			// Another claimant took the rows since the read, or they were settled: only then is the holder read again.
			const again = await probe();
			return again !== undefined && again.holder !== null
				? ({ status: "held", claimantId: again.holder } as const)
				: ({ status: "claimed", rows: [] } as const);
		},

		renewClaim(claim) {
			return withClaim(claim, `claim_renewed_at = ${nowMs}`, [], () => ({ status: "renewed" }) as const);
		},

		reportSaving(claim) {
			return withClaim(claim, `saving_at = ${nowMs}`, [], () => ({ status: "renewed" }) as const);
		},

		releaseClaim(claim, options) {
			const attempts = options?.unwritten === true ? `, claim_attempts = ${greatest("0", "claim_attempts - 1")}` : "";
			return withClaim(
				claim,
				`state = 'queued', claimant_id = NULL, claim_token = NULL, claim_renewed_at = NULL, saving_at = NULL${attempts}`,
				[],
				() => ({ status: "released" }) as const,
			);
		},

		async releaseClaimsOf(claimantId) {
			// Its rows locked in sequence order, as a claim locks them, so the two never wait for each other (#6560).
			const { changes } = await database.run(
				`UPDATE ${table} SET state = 'queued', claimant_id = NULL, claim_token = NULL, claim_renewed_at = NULL,
					saving_at = NULL
				WHERE message_id IN (
					SELECT message_id FROM ${table} WHERE state = 'claimed' AND claimant_id = ?
					ORDER BY sequence${lockClause("update")}
				)`,
				claimantId,
			);
			return changes;
		},

		markDelivered(claim) {
			if (dialect !== "postgres" || claim.messageId.length === 0 || claim.claimantId.length === 0)
				return withClaim(claim, `state = 'delivered', ${settled}`, [null], (written) => ({
					status: "delivered" as const,
					row: toRow(written),
				}));
			return new Promise<OutboxDeliveredResult>((resolve, reject) => {
				deliveries.push({ claim, resolve, reject });
				if (delivering) return;
				delivering = true;
				void deliverQueued();
			});
		},

		markFailed(claim, reason) {
			return withClaim(claim, `state = 'failed', ${settled}`, [JSON.stringify(reason)], (written) => ({
				status: "failed" as const,
				row: toRow(written),
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
				// Every recipient's rows, each locked in sequence order and decided on in its newest version, as a claim
				// locks them: a renewal that commits first keeps its row, and expiry waits for no lock domain (#6560).
				const lockedWhere = (where: string) =>
					`message_id IN (SELECT message_id FROM ${table} WHERE ${where} ORDER BY sequence${lockClause("update")})`;
				await database.transaction(async (executor) => {
					// A row an older broker queued has no time: its retention starts now.
					await executor.run(
						`UPDATE ${table} SET queued_at = ${nowMs} WHERE ${lockedWhere(`queued_at IS NULL AND ${UNDELIVERED}`)}`,
					);
					await executor.run(
						`UPDATE ${table} SET state = 'failed', ${settled}
						WHERE ${lockedWhere(
							`${UNDELIVERED} AND ${ageSince("queued_at")} > ?
							AND (claim_renewed_at IS NULL OR ${ageSince("claim_renewed_at")} > ?)`,
						)}`,
						JSON.stringify(OUTBOX_EXPIRED_REASON),
						queuedOlderThanMs,
						OUTBOX_CLAIM_STALE_AFTER_MS,
					);
				}, fenced);
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
