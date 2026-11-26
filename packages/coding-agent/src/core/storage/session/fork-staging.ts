import type { SessionEntry } from "../../session-manager-types.ts";
import { transactionFinisher } from "../added-exports.js";
import { attachCleanupCause } from "../cleanup.js";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteStatement,
	SqliteTransactionOptions,
	SqliteValue,
} from "../database.js";
import type { StorageDialect } from "../dialect.js";
import { SessionBlobError, StorageError } from "../errors.js";
import { fencedPath } from "../fenced-paths.js";
import { statementBatch } from "../statement-batches.js";
import { SessionExistsError } from "./errors.js";
import { encodedForkRow } from "./fork-row-bytes.js";
import { foldForkRow } from "./fork-row-index.js";
import { FORK_STAGING_CLEANUP_ROWS, FORK_STAGING_LEASE_KIND as LEASE } from "./fork-staging-maintenance.js";
import { foldSessionResume, type SessionResumeIndex } from "./session-resume.js";
import { applySessionSummaryEntries, type SessionSummaryState } from "./session-summary.js";
import type {
	ForkArchiveSource,
	OversizedSessionEntry,
	SessionForkRow,
	SessionForkStream,
	SessionRecordHeader,
	SessionStore,
	SessionWriteResult,
} from "./types.js";
import { SESSION_HISTORY_CHUNK_BYTES, SESSION_HISTORY_PAGE_BYTES } from "./types.js";
import { validateSessionEntries } from "./validation.js";

/*
 * The fork staging table (#5594), `<prefix>session_fork_staging`: a full-session clone between two SQL handles that
 * cannot be proven to be one connection copies the source a page at a time into rows of its own transfer there, and
 * publishes the child in one destination transaction. Created only when such a clone first runs; session reads,
 * listings, searches and snapshot collection never read it, so older Atomic versions ignore it.
 */

/**
 * How long a transfer holds its rows after its last write, on the database's clock. A transfer renews it with every
 * staged page; once it has lapsed, a cleanup takes the transfer over and removes its rows, and the transfer itself, if
 * it still runs, fails at its next write instead of publishing.
 */
export const FORK_STAGING_LEASE_MS = 10 * 60_000;

/**
 * The staged bytes one destination transaction writes. A clone holds at most this much besides the source page or
 * chunk it is reading: every staged row is buffered until the batch is full, then written, so a commit, the costly part
 * of a write, comes once per batch rather than once per page.
 */
export const FORK_STAGING_BATCH_BYTES = 8 * 1024 * 1024;
/** The source chunk rows a clone holds for the reads its feed and its copy make of one entry. */
export const FORK_STAGING_READ_CACHE_BYTES = 8 * 1024 * 1024;
/** What a staged row costs besides its text and bytes, for the batch's bound. */
const STAGED_ROW_BYTES = 64;

/** Finishing a staged clone spends no more than this many housekeeping transactions on newly expired transfers. */
export const FORK_STAGING_TRANSFER_CLEANUPS = 8;

/** What a staged row holds; the lease row of each transfer comes first and goes last. */
const ENTRY = 1;
const ENTRY_CHUNK = 2;
const SEARCH_TEXT = 3;
const BLOB = 4;
const BLOB_CHUNK = 5;

interface StagedRow {
	readonly kind: number;
	readonly seq: number;
	readonly idx: number;
	readonly name?: string;
	readonly size?: number;
	readonly body?: string;
	readonly data?: Uint8Array;
}

/** Some bytes of a source blob, read by themselves: a stored chunk row, or a cut of a legacy one-row blob (`chunks` -1). */
export interface ForkStagingBlobPart {
	readonly bytes: number;
	readonly chunks: number;
	readonly data?: Uint8Array;
}

/** What the destination store lends a staged clone; built by `SqlSessionStore`. */
export interface ForkStagingTarget {
	readonly database: SqliteDatabase;
	readonly dialect: StorageDialect;
	readonly table: string;
	readonly tables: {
		readonly meta: string;
		readonly sessions: string;
		readonly entries: string;
		readonly entryChunks: string;
		readonly searchTexts: string;
		readonly blobs: string;
		readonly blobChunks: string;
	};
	readonly legacyBlobData: boolean;
	readonly entryChunkBytes: number;
	readonly blobChunkBytes: number;
	readonly unchunkedSchemaVersion: number;
	readonly chunkedSchemaVersion: number;
	/** False when the destination's blob methods are not its own SQL: blobs are then left to `putBlob`. */
	readonly ownsBlobs: boolean;
	/** The destination's `create`: one transaction with every entry. */
	create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<SessionWriteResult>;
	/**
	 * A write of the session `sessionId` in the destination, which checks the sessions schema version first: the only
	 * writer of that session, beside writers of other sessions (#6560). `leading` names the calls the body makes first,
	 * after the check, sent with the transaction's start where the connection is pipelined.
	 */
	transaction<T>(
		sessionId: string,
		body: (tx: SqliteExecutor) => Promise<T>,
		leading: readonly SqliteStatement[],
	): Promise<T>;
	/** The statement that writes the child's sessions row, as `create` does, from the summary and index the clone folded. */
	summaryWrite(
		header: SessionRecordHeader,
		lastSeq: number,
		summary: SessionSummaryState,
		index: SessionResumeIndex,
	): { readonly statement: SqliteStatement; readonly epoch: string };
	/**
	 * Builds the stored resume index of `sessionId` again, from its stored entries, as its first resume would: the one a
	 * clone folded a page at a time cannot know which branch is active until its last entry.
	 */
	rebuildResume(sessionId: string): Promise<void>;
	/** The entries row JSON and chunks `create` would store for `entry` encoded as `json`. */
	storedEntry(entry: SessionEntry, json: string): { readonly json: string; readonly chunks: readonly Uint8Array[] };
	encode(value: SessionEntry | string): string;
	/**
	 * How many chunks a SQL session store `store` keeps a referenced entry in, 0 when it stores it whole. Undefined for
	 * another store, which stores every entry whole.
	 */
	sourceEntryChunks(store: SessionStore): ((reference: OversizedSessionEntry) => Promise<number>) | undefined;
	/**
	 * A reader of one stored chunk row of an entry at a time, whole, when `store` is a SQL session store whose entry
	 * reads are its own: undefined for an entry it stores whole.
	 */
	sourceStoredEntryChunks(
		store: SessionStore,
	): ((reference: OversizedSessionEntry, index: number) => Promise<Uint8Array | undefined>) | undefined;
	/**
	 * A reader of a blob's bytes from an offset, one stored chunk row or, of a legacy one-row blob, at most `legacyBytes`,
	 * when `store` is a SQL session store whose blob reads are its own.
	 */
	sourceBlobParts(
		store: SessionStore,
	):
		| ((
				sessionId: string,
				hash: string,
				offset: number,
				legacyBytes: number,
		  ) => Promise<ForkStagingBlobPart | undefined>)
		| undefined;
	/**
	 * Optional. A reader of the first parts of several blobs in one source read (#6560), when `store` is a SQL session
	 * store whose blob reads are its own: for each of `hashes` the source holds, its header, and, for a blob in chunks of
	 * at most `maxBytes`, its first chunk row, as `sourceBlobParts` reads them at offset 0. A hash the source does not
	 * hold is left out.
	 */
	sourceBlobFirstParts?(
		store: SessionStore,
	):
		| ((
				sessionId: string,
				hashes: readonly string[],
				maxBytes: number,
		  ) => Promise<ReadonlyMap<string, ForkStagingBlobPart>>)
		| undefined;
}

/** How many blobs one read of their first parts names. */
const BLOB_FIRST_PARTS_PER_READ = 64;

/** Creating the staging table: the table's own lock domain keeps concurrent creators apart. */
function stagingTransaction(table: string): SqliteTransactionOptions {
	return { retryTransientFailures: true, concurrency: { kind: "serial", domain: table } };
}

/**
 * A write of the rows of one transfer, its owner's staged batches or a cleanup's removal of them: the transfer's own
 * lock domain, so the transfers of different children never wait for each other (#6560). What decides between a
 * transfer's owner and a cleanup that took it over is the lease row: every such write first locks it by its token.
 */
function transferTransaction(table: string, transfer: string): SqliteTransactionOptions {
	return { retryTransientFailures: true, concurrency: { kind: "serial", domain: `${table}:${transfer}` } };
}

/**
 * A cleanup's claim of a lapsed transfer: it takes no lock domain, only the lease row it claims, skipping one that is
 * locked, since any lapsed transfer may be claimed in any order (`fencedPath("fork-staging-claim")`).
 */
const CLAIM_TRANSACTION: SqliteTransactionOptions = {
	retryTransientFailures: true,
	concurrency: { kind: "fenced", audit: fencedPath("fork-staging-claim") },
};

function randomId(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function lostTransfer(header: SessionRecordHeader): StorageError {
	return new StorageError(
		`The staged copy of session ${header.id} lost its lease (its process paused longer than ${FORK_STAGING_LEASE_MS} ms); nothing was published`,
	);
}

/** Creates the staging table when a clone first needs it. Its own lock domain keeps concurrent creators apart. */
export async function ensureForkStagingTable(database: SqliteDatabase, dialect: StorageDialect, table: string) {
	const probe = dialect.tableExists(table);
	if ((await database.get(probe.sql, ...probe.params)) !== undefined) return;
	const { int, text, blob } = dialect.types;
	await database.transaction(async (tx) => {
		if ((await tx.get(probe.sql, ...probe.params)) !== undefined) return;
		// `size` precedes the payload columns, so a scan of lease rows never reads a staged page's bytes.
		await tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table} (
				transfer_id ${text} NOT NULL, kind ${int} NOT NULL, seq ${int} NOT NULL, idx ${int} NOT NULL,
				name ${text}, size ${int}, body ${text}, data ${blob},
				PRIMARY KEY(transfer_id, kind, seq, idx)
			)${dialect.tableOptions};
			CREATE INDEX IF NOT EXISTS ${table}_name ON ${table} (kind, transfer_id, name);
		`);
	}, stagingTransaction(table));
}

/**
 * Removes the rows of `transfer`, a batch per transaction, while `token` still holds its lease, then the lease. Stops
 * when `budget` transactions are spent, and leaves the lease lapsed so that the next cleanup continues at once.
 * Resolves with the transactions left.
 */
async function removeTransfer(
	database: SqliteDatabase,
	dialect: StorageDialect,
	table: string,
	transfer: string,
	token: string,
	budget: number,
): Promise<number> {
	while (budget > 0) {
		budget--;
		const done = await database.transaction(
			async (tx) => {
				const held = await tx.get(
					`SELECT transfer_id FROM ${table} WHERE transfer_id = ? AND kind = ${LEASE} AND body = ?${dialect.lockClause("update")}`,
					transfer,
					token,
				);
				if (held === undefined) return true;
				const { changes } = await tx.run(
					`DELETE FROM ${table} WHERE transfer_id = ? AND kind > ${LEASE} AND (kind, seq, idx) IN (SELECT kind, seq, idx FROM ${table} WHERE transfer_id = ? AND kind > ${LEASE} LIMIT ?)`,
					transfer,
					transfer,
					FORK_STAGING_CLEANUP_ROWS,
				);
				if (changes >= FORK_STAGING_CLEANUP_ROWS) return false;
				await tx.run(
					`DELETE FROM ${table} WHERE transfer_id = ? AND kind = ${LEASE} AND body = ?`,
					transfer,
					token,
				);
				return true;
			},
			transferTransaction(table, transfer),
		);
		if (done) return budget;
	}
	await database.run(
		`UPDATE ${table} SET size = 0 WHERE transfer_id = ? AND kind = ${LEASE} AND body = ?`,
		transfer,
		token,
	);
	return 0;
}

/**
 * Takes over transfers whose lease lapsed, a process that stopped mid-copy or a cleanup that ran out of budget, and
 * removes their rows within `budget` transactions. The staging table must exist.
 */
export async function cleanupForkStaging(
	database: SqliteDatabase,
	dialect: StorageDialect,
	table: string,
	budget: number,
): Promise<void> {
	const lapsed = `SELECT transfer_id FROM ${table} WHERE kind = ${LEASE} AND size < ${dialect.nowMs} LIMIT 1`;
	// Usually nothing lapsed: one read, without taking the write lock.
	if ((await database.get(lapsed)) === undefined) return;
	while (budget > 0) {
		budget--;
		const token = randomId();
		const claimed = await database.transaction(async (tx) => {
			const row = await tx.get<SqliteRow & { transfer_id: string }>(
				`${lapsed}${dialect.lockClause("update-skip-locked")}`,
			);
			if (row === undefined) return undefined;
			const { changes } = await tx.run(
				`UPDATE ${table} SET body = ?, size = ${dialect.nowMs} + ? WHERE transfer_id = ? AND kind = ${LEASE} AND size < ${dialect.nowMs}`,
				token,
				FORK_STAGING_LEASE_MS,
				row.transfer_id,
			);
			return changes === 1 ? String(row.transfer_id) : undefined;
		}, CLAIM_TRANSACTION);
		if (claimed === undefined) return;
		budget = await removeTransfer(database, dialect, table, claimed, token, budget);
	}
}

/**
 * A statement the database refused for a privilege the role lacks: the PostgreSQL adapter's `missing-privilege`, which
 * the database facade reports as the cause of its `StorageUnavailableError`.
 */
function missingPrivilege(error: unknown): boolean {
	let at = error;
	for (let depth = 0; depth < 4 && typeof at === "object" && at !== null; depth++) {
		if ((at as { reason?: unknown }).reason === "missing-privilege") return true;
		at = (at as { cause?: unknown }).cause;
	}
	return false;
}

let missingStagingHinted = false;

/** Only classify a destination write. A source error, even with this code, is not a reason to copy it again. */
class StagingDiskFull extends Error {}
function destinationWrite<T>(work: Promise<T>): Promise<T> {
	return work.catch((error) => {
		let cause: unknown = error;
		for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
			const e = cause as { code?: unknown; errcode?: unknown; rawCode?: unknown; cause?: unknown };
			if (
				e.code === "SQLITE_FULL" ||
				e.code === "53100" ||
				e.code === "ENOSPC" ||
				e.errcode === 13 ||
				e.rawCode === 13
			)
				throw new StagingDiskFull("The staging write ran out of space", { cause: error });
			cause = e.cause;
		}
		throw error;
	});
}

/**
 * The clone as main makes it, for a role that may not create the staging table and finds none (#5594): the whole
 * source read into one array, then the child created in one transaction; its blobs are left to `copySessionBlobs`, as
 * main copies them. Hints once per process that `atomic storage migrate`, run as the owner role, enables bounded clones.
 */
async function wholeSourceFork(
	target: ForkStagingTarget,
	header: SessionRecordHeader,
	stream: SessionForkStream,
	source: ForkArchiveSource,
	hint: boolean,
): Promise<SessionWriteResult & { readonly remainingBlobs: readonly string[] }> {
	if (hint && !missingStagingHinted) {
		missingStagingHinted = true;
		globalThis.process?.emitWarning?.(
			`This database role may not create the fork staging table ${target.table}, so whole-session clones into it are read into memory. Run \`atomic storage migrate\` as the owner role to copy them in bounded batches instead.`,
		);
	}
	const entries: SessionEntry[] = [];
	const ids = new Set<string>();
	for await (const row of stream.read(source.store, async (id) => ids.has(id))) {
		let entry = row.entry;
		if (row.reference !== undefined) {
			const encoded = await encodedForkRow(source.store, row);
			const bytes = new Uint8Array(encoded.size);
			let used = 0;
			for await (const part of encoded.chunks()) {
				if (used + part.length > bytes.length)
					throw new StorageError(`Historical entry ${entries.length + 1} grew while it was copied`);
				bytes.set(part, used);
				used += part.length;
			}
			entry = JSON.parse(new TextDecoder().decode(bytes)) as SessionEntry;
		}
		entries.push(entry);
		ids.add(entry.id);
	}
	const hashes = new Set<string>(source.store.getBlob === undefined ? [] : source.hashes);
	if (source.store.getBlob !== undefined)
		for (const entry of entries) {
			const hash =
				entry.type === "custom" && entry.customType === "atomic.tool-output"
					? (entry.data as { hash?: unknown } | null | undefined)?.hash
					: undefined;
			if (typeof hash === "string") hashes.add(hash);
		}
	const created = await target.create(header, entries);
	return { ...created, remainingBlobs: [...hashes] };
}

/**
 * `store` as the clone reads it: when the source is a SQL session store, the 64 KiB reads of an entry it keeps in
 * chunks are served from that entry's stored chunk rows, each fetched whole in one source read, and those of an entry
 * it stores whole from parts as large, each one read (#6560). The most recently read parts are held, up to
 * {@link FORK_STAGING_READ_CACHE_BYTES}, so the passes the feed and the copy make over one entry fetch each part once.
 * Each fetch checks the entry's generation, as each read did; the rows of a generation never change. Anything else
 * reads as before.
 */
function chunkRowReader(
	store: SessionStore,
	rows: ((reference: OversizedSessionEntry, index: number) => Promise<Uint8Array | undefined>) | undefined,
	chunkBytes: number,
): SessionStore {
	const read = store.readEntryChunk?.bind(store);
	if (rows === undefined || read === undefined) return store;
	const held = new Map<string, Uint8Array>();
	let heldBytes = 0;
	/** The last entry found stored whole, whose parts are read as cuts of its value. */
	let whole: string | undefined;
	const readEntryChunk = async (reference: OversizedSessionEntry, offset: number): Promise<Uint8Array> => {
		const index = Math.floor(offset / chunkBytes);
		const entry = `${reference.sessionId}\u0000${reference.epoch}\u0000${reference.seq}`;
		const key = `${entry}\u0000${index}`;
		const start = offset - index * chunkBytes;
		let data = held.get(key);
		if (data === undefined) {
			let fetched = whole === entry ? undefined : await rows(reference, index);
			if (fetched === undefined) {
				whole = entry;
				fetched = await read(reference, index * chunkBytes, Math.min(chunkBytes, SESSION_HISTORY_PAGE_BYTES));
				if (fetched.byteLength <= start) return read(reference, offset);
			}
			data = fetched;
			held.set(key, data);
			heldBytes += data.byteLength;
			for (const [oldest, value] of held) {
				if (heldBytes <= FORK_STAGING_READ_CACHE_BYTES || oldest === key) break;
				held.delete(oldest);
				heldBytes -= value.byteLength;
			}
		} else {
			held.delete(key);
			held.set(key, data);
		}
		return data.subarray(start, start + SESSION_HISTORY_CHUNK_BYTES);
	};
	return new Proxy(store, {
		get(target, key) {
			if (key === "readEntryChunk") return readEntryChunk;
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** What a staged row counts for in the batch of a move, as `moveStaged` counts it. */
function movedBytes(target: ForkStagingTarget, row: StagedRow): number {
	if (row.kind === ENTRY_CHUNK) return target.entryChunkBytes;
	if (row.kind === BLOB_CHUNK) return target.blobChunkBytes;
	if (row.kind === BLOB) return 128 + STAGED_ROW_BYTES;
	return Buffer.byteLength(row.body ?? "") + Buffer.byteLength(row.name ?? "") + STAGED_ROW_BYTES;
}

/**
 * Moves every staged row of `kind`, which fit one batch, in one statement, and removes them: sent at once, without
 * waiting for an answer, and settled once both are answered.
 */
function moveWhole(
	target: ForkStagingTarget,
	tx: SqliteExecutor,
	transfer: string,
	child: string,
	kind: number,
	count: number,
	dest: string,
	columns: string,
	fields: string,
	join = "",
): Promise<void> {
	const { table } = target;
	const inserted = tx.run(
		`INSERT INTO ${dest} (${columns}) SELECT ?, ${fields} FROM ${table} s ${join} WHERE s.transfer_id=? AND s.kind=${kind} ORDER BY s.seq,s.idx`,
		child,
		...(join ? [child] : []),
		transfer,
	);
	const removed = tx.run(`DELETE FROM ${table} WHERE transfer_id=? AND kind=${kind}`, transfer);
	return Promise.all([inserted, removed]).then(([{ changes }]) => {
		if (changes !== count) throw missingRows(child, dest);
	});
}

function missingRows(child: string, dest: string): StorageError {
	return new StorageError(`The staged copy of session ${child} is missing ${dest} rows; nothing was published`);
}

/** Move the next key ranges in this transaction instead of copying a whole table while all its staged rows
 * still occupy pages. SQLite can reuse a deleted range for the next one without exposing a partial child.
 * For entry and search rows idx carries their byte cost; chunks have the store's fixed maximum size. */
async function moveStaged(
	target: ForkStagingTarget,
	tx: SqliteExecutor,
	transfer: string,
	child: string,
	kind: number,
	count: number,
	dest: string,
	columns: string,
	fields: string,
	join = "",
) {
	if (!count) return;
	const { table } = target;
	const chunkBytes = kind === ENTRY_CHUNK ? target.entryChunkBytes : kind === BLOB_CHUNK ? target.blobChunkBytes : 0;
	const batchRows = chunkBytes ? Math.max(1, Math.floor(FORK_STAGING_BATCH_BYTES / chunkBytes)) : 1024;
	const where = `transfer_id=? AND kind=${kind} AND (seq,idx)<=(?,?)`;
	let copied = 0;
	for (;;) {
		const keys = await tx.all<SqliteRow & { seq: number; idx: number }>(
			`SELECT seq,idx FROM ${table} WHERE transfer_id=? AND kind=${kind} ORDER BY seq,idx LIMIT ?`,
			transfer,
			batchRows,
		);
		if (!keys.length) break;
		let used = 0,
			end = 0;
		for (const key of keys) {
			const bytes = chunkBytes || (kind === BLOB ? 128 : Number(key.idx)) + STAGED_ROW_BYTES;
			if (end && used + bytes > FORK_STAGING_BATCH_BYTES) break;
			used += bytes;
			end++;
		}
		const last = keys[end - 1]!;
		const args = [transfer, Number(last.seq), Number(last.idx)];
		// Legacy SQL worktree snapshots may be larger than a batch and must remain a single row. Read
		// just this row and free its staging pages before allocating its final copy, as on input.
		if (kind === ENTRY && end === 1 && used > FORK_STAGING_BATCH_BYTES) {
			const row = await tx.get<SqliteRow & { seq: number; name: string; body: string; size: number }>(
				`SELECT seq,name,body,size FROM ${table} WHERE ${where}`,
				...args,
			);
			if (!row) throw new StorageError(`Missing staged entry of session ${child}`);
			await tx.run(`DELETE FROM ${table} WHERE ${where}`, ...args);
			copied += (
				await tx.run(
					`INSERT INTO ${dest} (${columns}) VALUES (?,?,?,?,?)`,
					child,
					row.seq,
					row.name,
					row.body,
					row.size,
				)
			).changes;
		} else {
			const qualified = `s.transfer_id=? AND s.kind=${kind} AND (s.seq,s.idx)<=(?,?)`;
			copied += (
				await tx.run(
					`INSERT INTO ${dest} (${columns}) SELECT ?, ${fields} FROM ${table} s ${join} WHERE ${qualified} ORDER BY s.seq,s.idx`,
					child,
					...(join ? [child] : []),
					...args,
				)
			).changes;
			await tx.run(`DELETE FROM ${table} WHERE ${where}`, ...args);
		}
		if (end === keys.length && end < batchRows) break;
	}
	if (copied !== count) throw missingRows(child, dest);
}

/**
 * Clone a complete session from `source`, a store on a handle this one cannot prove to be its own connection, as a new
 * child `header.id` (#5594). Each page is read from the source and released before it is written to the staging
 * table, so no transaction is ever held on both handles and two handles that share one queued connection cannot wait
 * on each other. The child is published in one destination transaction with every entry, search text and blob, so a
 * reader never sees part of it. Besides the source page it reads, holds at most one batch of staged rows
 * ({@link FORK_STAGING_BATCH_BYTES}) and the source chunk rows it read last ({@link FORK_STAGING_READ_CACHE_BYTES}).
 *
 * `remainingBlobs` names only blobs the source no longer holds; the caller reports them as `copySessionBlobs` does.
 * On any failure nothing is published and the transfer's rows are removed.
 */
export async function createStagedFork(
	target: ForkStagingTarget,
	header: SessionRecordHeader,
	stream: SessionForkStream,
	source: ForkArchiveSource,
): Promise<SessionWriteResult & { readonly remainingBlobs: readonly string[] }> {
	try {
		return await stageAndPublish(target, header, stream, source);
	} catch (error) {
		if (!(error instanceof StagingDiskFull)) throw error;
		// Staging rolled back and released its rows. Retry once with the unstaged copy's exact error and memory behavior.
		return wholeSourceFork(target, header, stream, source, false);
	}
}

async function stageAndPublish(
	target: ForkStagingTarget,
	header: SessionRecordHeader,
	stream: SessionForkStream,
	source: ForkArchiveSource,
) {
	const { database, dialect, table } = target;
	if ((await database.get(`SELECT id FROM ${target.tables.sessions} WHERE id = ?`, header.id)) !== undefined)
		throw new SessionExistsError(header.id);
	try {
		await destinationWrite(ensureForkStagingTable(database, dialect, table));
	} catch (error) {
		if (error instanceof StagingDiskFull) throw error;
		// Another role, such as the owner's `atomic storage migrate`, may have created it meanwhile: stage into it.
		const probe = dialect.tableExists(table);
		if ((await database.get(probe.sql, ...probe.params)) === undefined) {
			if (!missingPrivilege(error)) throw error;
			return wholeSourceFork(target, header, stream, source, true);
		}
	}
	await cleanupForkStaging(database, dialect, table, Number.POSITIVE_INFINITY).catch(() => {});
	const transfer = randomId();
	const token = randomId();
	const options = transferTransaction(table, transfer);
	/** Renews the lease while `token` holds it, and locks its row to the commit: 0 rows once a cleanup took it over. */
	const renewal: SqliteStatement = {
		sql: `UPDATE ${table} SET size = ${dialect.nowMs} + ? WHERE transfer_id = ? AND kind = ${LEASE} AND body = ?`,
		params: [FORK_STAGING_LEASE_MS, transfer, token],
	};
	/** The lease, inserted by the first write with its rows: no transfer has staged rows without one. */
	const lease: SqliteStatement = {
		sql: `INSERT INTO ${table} (transfer_id, kind, seq, idx, name, size, body) VALUES (?, ${LEASE}, 0, 0, ?, ${dialect.nowMs} + ?, ?)`,
		params: [transfer, header.id, FORK_STAGING_LEASE_MS, token],
	};
	let leased = false;
	/** Bytes staged of each kind, as `moveStaged` counts them. */
	const stagedBytes = new Map<number, number>();

	/**
	 * Writes `rows` in one transaction of the transfer's domain, inserting or renewing the lease first; never while a
	 * source read runs. The lease statement goes with the transaction's start and the rows with its commit where the
	 * connection is pipelined: two round trips whatever the batch holds.
	 */
	const write = async (rows: readonly StagedRow[]) => {
		const first = leased ? renewal : lease;
		await destinationWrite(
			database.transaction(
				async (tx) => {
					const { changes } = await tx.run(first.sql, ...first.params);
					if (changes !== 1) throw lostTransfer(header);
					const inserts = rows.map(
						(row): SqliteStatement => ({
							sql: `INSERT INTO ${table} (transfer_id, kind, seq, idx, name, size, body, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
							params: [
								transfer,
								row.kind,
								row.seq,
								row.kind === ENTRY || row.kind === SEARCH_TEXT
									? Buffer.byteLength(row.body ?? "") + Buffer.byteLength(row.name ?? "")
									: row.idx,
								row.name ?? null,
								row.size ?? null,
								row.body ?? null,
								(row.data ?? null) as SqliteValue,
							],
						}),
					);
					const finish = transactionFinisher(tx);
					if (inserts.length === 0 || finish?.(inserts) === true) return;
					// More than the commit's request takes: a pipelined connection still takes them all without waiting
					// for each answer, in order, so a large batch costs a round trip, not one per row (#6560).
					if (finish !== undefined) {
						await Promise.all(inserts.map((insert) => tx.run(insert.sql, ...insert.params)));
						return;
					}
					await statementBatch(tx, inserts, []);
				},
				{ ...options, leading: [first] },
			),
		);
		leased = true;
		for (const row of rows) stagedBytes.set(row.kind, (stagedBytes.get(row.kind) ?? 0) + movedBytes(target, row));
	};

	try {
		// The batch: rows staged since the last write, and the seq of each entry among them for the index's links.
		let pending: StagedRow[] = [];
		let pendingBytes = 0;
		let pendingIds = new Map<string, number>();
		/** Writes the batch; the first writes the lease even without rows, so publication finds one. */
		const flush = async () => {
			if (pending.length === 0 && leased) return;
			await write(pending);
			pending = [];
			pendingBytes = 0;
			pendingIds = new Map();
		};
		/** Adds `row` to the batch, and writes the batch once it is full. Called only between source reads. */
		const stage = async (row: StagedRow) => {
			pending.push(row);
			pendingBytes += STAGED_ROW_BYTES + (row.body?.length ?? 0) + (row.data?.byteLength ?? 0);
			if (row.kind === ENTRY && row.name !== undefined) pendingIds.set(row.name, row.seq);
			if (pendingBytes >= FORK_STAGING_BATCH_BYTES) await flush();
		};
		const lookup = async (id: string) => {
			const held = pendingIds.get(id);
			if (held !== undefined) return held;
			const row = await database.get<SqliteRow & { seq: number }>(
				`SELECT seq FROM ${table} WHERE kind = ${ENTRY} AND transfer_id = ? AND name = ? ORDER BY seq DESC LIMIT 1`,
				transfer,
				id,
			);
			return row === undefined ? undefined : Number(row.seq);
		};
		const storedChunks = target.sourceEntryChunks(source.store);
		const reader = chunkRowReader(source.store, target.sourceStoredEntryChunks(source.store), target.entryChunkBytes);
		const sourceBlobs = source.store.getBlob !== undefined;
		const hashes = new Set<string>(sourceBlobs ? source.hashes : []);
		let summary = applySessionSummaryEntries(undefined, []).state;
		let index = foldSessionResume(undefined, []);
		let seq = 0;
		let chunkedEntries = 0;
		let entryChunkRows = 0;
		let textRows = 0;
		for await (const row of stream.read(reader, async (id) => (await lookup(id)) !== undefined)) {
			// The stream is suspended here: no source read runs until the next row is asked for.
			const at = seq + 1;
			let entry = row.entry;
			let staged: StagedRow | undefined;
			if (row.reference === undefined) {
				validateSessionEntries([entry]);
				const stored = target.storedEntry(entry, target.encode(entry));
				for (const [part, data] of stored.chunks.entries())
					await stage({ kind: ENTRY_CHUNK, seq: at, idx: part, data });
				if (stored.chunks.length > 0) {
					entryChunkRows += stored.chunks.length;
					chunkedEntries++;
				}
				staged = { kind: ENTRY, seq: at, idx: 0, name: entry.id, size: stored.chunks.length, body: stored.json };
			} else {
				// Only a snapshot entry the source stores whole is materialized, one at a time: the v4 snapshot
				// reference index reads its inline JSON. A row the source keeps in chunks, a snapshot too, stays streamed.
				const whole =
					entry.type === "worktree_snapshot" &&
					(storedChunks === undefined || (await storedChunks(row.reference)) === 0);
				const encoded = await encodedForkRow(reader, row);
				if (whole || encoded.size <= target.entryChunkBytes) {
					const bytes = new Uint8Array(encoded.size);
					let used = 0;
					for await (const part of encoded.chunks()) {
						if (used + part.length > bytes.length)
							throw new StorageError(`Historical entry ${at} grew while it was copied`);
						bytes.set(part, used);
						used += part.length;
					}
					if (used !== bytes.length) throw new StorageError(`Incomplete historical entry ${at} in a staged fork`);
					const json = new TextDecoder().decode(bytes);
					if (whole) {
						entry = JSON.parse(json) as SessionEntry;
						validateSessionEntries([entry]);
					}
					staged = { kind: ENTRY, seq: at, idx: 0, name: entry.id, size: 0, body: json };
				} else {
					// Re-cut into the destination's chunk size; a full chunk joins the batch once the source read returned.
					const chunks = Math.ceil(encoded.size / target.entryChunkBytes);
					let n = 0;
					let used = 0;
					let buffer = new Uint8Array(target.entryChunkBytes);
					const put = async () => {
						await stage({ kind: ENTRY_CHUNK, seq: at, idx: n++, data: buffer.subarray(0, used) });
						buffer = new Uint8Array(target.entryChunkBytes);
						used = 0;
					};
					for await (const part of encoded.chunks())
						for (let start = 0; start < part.length; ) {
							const count = Math.min(part.length - start, buffer.length - used);
							buffer.set(part.subarray(start, start + count), used);
							start += count;
							used += count;
							if (used === buffer.length) await put();
						}
					if (used > 0) await put();
					if (n !== chunks) throw new StorageError(`Incomplete historical entry ${at} in a staged fork`);
					entryChunkRows += chunks;
					chunkedEntries++;
					const stub = { type: entry.type, id: entry.id, parentId: entry.parentId ?? null };
					staged = { kind: ENTRY, seq: at, idx: 0, name: entry.id, size: chunks, body: JSON.stringify(stub) };
				}
			}
			const folded: SessionForkRow = entry === row.entry ? row : { ...row, entry };
			index = await foldForkRow(index, folded, lookup);
			const listed = applySessionSummaryEntries(summary, [entry]);
			summary = listed.state;
			if (sourceBlobs && entry.type === "custom" && entry.customType === "atomic.tool-output") {
				const hash = (entry.data as { hash?: unknown } | null | undefined)?.hash;
				if (typeof hash === "string") hashes.add(hash);
			}
			seq = at;
			await stage(staged);
			for (const { text } of listed.texts) {
				await stage({ kind: SEARCH_TEXT, seq: at, idx: 0, body: target.encode(text) });
				textRows++;
			}
		}

		const missing: string[] = [];
		const leftForPutBlob: string[] = [];
		let blobRows = 0;
		let blobChunkRows = 0;
		let ordinal = 0;
		// The headers and first chunks of small blobs, read a group at a time instead of one read per blob (#6560).
		const firstParts = target.ownsBlobs ? target.sourceBlobFirstParts?.(source.store) : undefined;
		const blobHashes = [...hashes];
		let prefetched: {
			readonly hashes: ReadonlySet<string>;
			readonly parts: ReadonlyMap<string, ForkStagingBlobPart>;
		} = { hashes: new Set(), parts: new Map() };
		for (const [index, hash] of blobHashes.entries()) {
			if (!target.ownsBlobs) {
				leftForPutBlob.push(hash);
				continue;
			}
			if (firstParts !== undefined && !prefetched.hashes.has(hash)) {
				const group = blobHashes.slice(index, index + BLOB_FIRST_PARTS_PER_READ);
				prefetched = {
					hashes: new Set(group),
					parts: await firstParts(source.sessionId, group, SESSION_HISTORY_CHUNK_BYTES),
				};
			}
			const at = ordinal++;
			const known = prefetched.hashes.has(hash) ? { first: prefetched.parts.get(hash) } : undefined;
			const chunks = await stageBlob(target, source, hash, at, stage, flush, known);
			if (chunks === undefined) missing.push(hash);
			else {
				blobRows++;
				blobChunkRows += chunks;
			}
		}
		await flush();

		const { tables } = target;
		const existing: SqliteStatement = { sql: `SELECT id FROM ${tables.sessions} WHERE id = ?`, params: [header.id] };
		const { epoch } = await destinationWrite(
			target.transaction(
				header.id,
				async (tx) => {
					// The lease decides between this publication and a cleanup that took the transfer over. Its row lock, taken
					// first and held to the commit, keeps a cleanup from taking the transfer over meanwhile: a cleanup skips a
					// locked lease, and its takeover's guarded update waits for this commit (#6560). It goes with the
					// transaction's start, behind the schema check: a check that fails rolls it back with the rest.
					const { changes: held } = await tx.run(renewal.sql, ...renewal.params);
					if (held !== 1) throw lostTransfer(header);
					if ((await tx.get(existing.sql, ...existing.params)) !== undefined)
						throw new SessionExistsError(header.id);
					const saved = target.summaryWrite(header, seq, summary, index);
					// The child's writes go out together, each behind the one before, and are answered together: a kind whose
					// staged rows fit one batch moves in one statement. A larger kind moves a batch at a time, after the rest.
					const sent: Promise<unknown>[] = [];
					const send = (work: Promise<unknown>) => {
						work.catch(() => {});
						sent.push(work);
					};
					send(tx.run(saved.statement.sql, ...saved.statement.params));
					const move = async (
						kind: number,
						count: number,
						destination: string,
						columns: string,
						fields: string,
						join?: string,
					) => {
						if (!count) return;
						if ((stagedBytes.get(kind) ?? 0) <= FORK_STAGING_BATCH_BYTES) {
							send(moveWhole(target, tx, transfer, header.id, kind, count, destination, columns, fields, join));
							return;
						}
						await Promise.all(sent.splice(0));
						await moveStaged(target, tx, transfer, header.id, kind, count, destination, columns, fields, join);
					};
					await move(
						ENTRY,
						seq,
						tables.entries,
						"session_id, seq, entry_id, entry_json, chunks",
						"s.seq, s.name, s.body, s.size",
					);
					await move(
						ENTRY_CHUNK,
						entryChunkRows,
						tables.entryChunks,
						"session_id, seq, idx, data",
						"s.seq, s.idx, s.data",
					);
					// As `create` does with its first chunked entry: a build that knows only version 1 refuses the database.
					if (chunkedEntries > 0)
						send(
							tx.run(
								`UPDATE ${tables.meta} SET schema_version = ? WHERE schema_version = ?`,
								target.chunkedSchemaVersion,
								target.unchunkedSchemaVersion,
							),
						);
					await move(SEARCH_TEXT, textRows, tables.searchTexts, "session_id, seq, text_json", "s.seq, s.body");
					await move(
						BLOB,
						blobRows,
						tables.blobs,
						`session_id, hash, bytes, chunks${target.legacyBlobData ? ", data" : ""}`,
						`s.name, s.size, s.idx${target.legacyBlobData ? ", X''" : ""}`,
					);
					// A source removed mid-read can leave incomplete chunk rows, never a published blob header.
					await move(
						BLOB_CHUNK,
						blobChunkRows,
						tables.blobChunks,
						"session_id, hash, idx, data",
						"s.name, s.idx, s.data",
						`JOIN ${tables.blobs} h ON h.session_id=? AND h.hash=s.name`,
					);
					await Promise.all(sent.splice(0));
					// The lease and what is left of the transfer go, with the commit where the connection is pipelined.
					const removal: SqliteStatement = {
						sql: `DELETE FROM ${table} WHERE transfer_id = ?`,
						params: [transfer],
					};
					if (transactionFinisher(tx)?.([removal]) !== true) await tx.run(removal.sql, ...removal.params);
					return saved;
				},
				[renewal, existing],
			),
		);
		// A session with branches: `create` folds every entry at once, knowing its leaf, and so does a resume's rebuild.
		// The child is published already; a failure here leaves the rebuild to its first resume.
		if (index.needsBranchRebuild) await target.rebuildResume(header.id).catch(() => {});
		await cleanupForkStaging(database, dialect, table, FORK_STAGING_TRANSFER_CLEANUPS).catch(() => {});
		return { lastSeq: seq, epoch, remainingBlobs: [...missing, ...leftForPutBlob] };
	} catch (error) {
		await removeTransfer(database, dialect, table, transfer, token, Number.POSITIVE_INFINITY).catch(
			(cleanupCause: unknown) => attachCleanupCause(error, cleanupCause),
		);
		throw error;
	}
}

/** Into how many cuts at most the database divides a large blob in the legacy one-row layout. */
export const FORK_STAGING_LEGACY_CUTS = 8;

/**
 * The cut of a blob of `bytes` in the legacy one-row layout: at least {@link FORK_STAGING_BATCH_BYTES}, and an eighth
 * of the blob, in whole chunks of `chunkBytes`, for a larger one. The database reads the whole value for each cut, so
 * its work stays within {@link FORK_STAGING_LEGACY_CUTS} reads of the blob; Node holds one cut.
 */
export function forkStagingLegacyCut(bytes: number, chunkBytes: number): number {
	const share = Math.ceil(Math.ceil(bytes / FORK_STAGING_LEGACY_CUTS) / chunkBytes) * chunkBytes;
	return Math.max(FORK_STAGING_BATCH_BYTES, share);
}

/**
 * Stages the blob `hash` of the source session under `ordinal`. From a SQL session store, one stored chunk row at a
 * time, or for a blob in the legacy one-row layout, {@link forkStagingLegacyCut} cuts the database makes without
 * converting it, each written before the next is read, so Node holds one. Otherwise whole, as `copySessionBlobs` reads
 * it. Resolves with its chunk count, or undefined when the source no longer holds it.
 */
async function stageBlob(
	target: ForkStagingTarget,
	source: ForkArchiveSource,
	hash: string,
	ordinal: number,
	stage: (row: StagedRow) => Promise<void>,
	flush: () => Promise<void>,
	known?: { readonly first: ForkStagingBlobPart | undefined },
): Promise<number | undefined> {
	const size = target.blobChunkBytes;
	const parts = target.sourceBlobParts(source.store);
	const incomplete = (bytes: number) =>
		new SessionBlobError("blob-incomplete", { sessionId: source.sessionId, hash, bytes });
	if (parts !== undefined) {
		// The header, and the first chunk row of a chunked blob; a legacy blob's value is not read yet. A group read may
		// have read them already, or found the blob gone; a larger blob's are read here.
		const first =
			known !== undefined &&
			(known.first === undefined ||
				known.first.chunks === -1 ||
				known.first.data !== undefined ||
				known.first.bytes === 0)
				? known.first
				: await parts(source.sessionId, hash, 0, 0);
		if (first === undefined) return undefined;
		const { bytes } = first;
		const chunks = Math.ceil(bytes / size);
		const cut = forkStagingLegacyCut(bytes, size);
		let idx = 0;
		let legacy = first.chunks === -1;
		for (let offset = 0; offset < bytes; ) {
			let part: ForkStagingBlobPart | undefined = offset === 0 && !legacy ? first : undefined;
			if (part === undefined) {
				// Write what the batch holds before the next legacy cut, so Node holds one cut and no more.
				if (legacy) await flush();
				part = await parts(source.sessionId, hash, offset, cut);
			}
			// The session was deleted meanwhile: it holds nothing, as getBlob would report.
			if (part === undefined) return undefined;
			// A legacy blob converted to chunks meanwhile keeps its bytes and their cut: it reads on from its chunk rows.
			legacy = part.chunks === -1;
			const length = Math.min(legacy ? cut : size, bytes - offset);
			if (part.bytes !== bytes || (!legacy && part.chunks !== chunks) || part.data?.byteLength !== length)
				throw incomplete(bytes);
			for (let start = 0; start < length; start += size)
				await stage({
					kind: BLOB_CHUNK,
					seq: ordinal,
					idx: idx++,
					name: hash,
					data: part.data.subarray(start, start + size),
				});
			offset += length;
		}
		if (idx !== chunks || (first.chunks !== -1 && first.chunks !== chunks)) throw incomplete(bytes);
		await stage({ kind: BLOB, seq: ordinal, idx: chunks, name: hash, size: bytes });
		return chunks;
	}
	const data = await source.store.getBlob!(source.sessionId, hash);
	if (data === undefined) return undefined;
	const chunks = Math.ceil(data.byteLength / size);
	for (let index = 0; index < chunks; index++)
		await stage({
			kind: BLOB_CHUNK,
			seq: ordinal,
			idx: index,
			name: hash,
			data: data.subarray(index * size, (index + 1) * size),
		});
	await stage({ kind: BLOB, seq: ordinal, idx: chunks, name: hash, size: data.byteLength });
	return chunks;
}
