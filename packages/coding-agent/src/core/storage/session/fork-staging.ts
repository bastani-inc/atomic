import type { SessionEntry } from "../../session-manager-types.ts";
import { attachCleanupCause } from "../cleanup.js";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteTransactionOptions, SqliteValue } from "../database.js";
import type { StorageDialect } from "../dialect.js";
import { SessionBlobError, StorageError } from "../errors.js";
import { SessionExistsError } from "./errors.js";
import { encodedForkRow } from "./fork-row-bytes.js";
import { foldForkRow } from "./fork-row-index.js";
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
import { SESSION_HISTORY_CHUNK_BYTES } from "./types.js";
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

/** Rows one cleanup transaction removes, so it never holds the write lock for long. */
export const FORK_STAGING_CLEANUP_ROWS = 32;
/** Cleanup transactions a store's open spends on transfers whose lease lapsed (a process that stopped mid-copy). */
export const FORK_STAGING_OPEN_CLEANUPS = 4;
/** Cleanup transactions a staged clone spends on other lapsed transfers when it starts and when it ends. */
export const FORK_STAGING_TRANSFER_CLEANUPS = 8;

/** What a staged row holds; the lease row of each transfer comes first and goes last. */
const LEASE = 0;
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

/** One stored row of a source blob, read by itself; `chunks` -1 is the legacy one-row layout, read whole. */
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
	/** The destination's session transaction, which checks the sessions schema version first. */
	transaction<T>(body: (tx: SqliteExecutor) => Promise<T>): Promise<T>;
	/** Writes the child's sessions row, as `create` does, from the summary and index the clone folded. */
	saveSummary(
		tx: SqliteExecutor,
		header: SessionRecordHeader,
		lastSeq: number,
		summary: SessionSummaryState,
		index: SessionResumeIndex,
	): Promise<{ readonly epoch: string }>;
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
	/** A reader of one blob row at a time when `store` is a SQL session store whose blob reads are its own. */
	sourceBlobParts(
		store: SessionStore,
	): ((sessionId: string, hash: string, index: number) => Promise<ForkStagingBlobPart | undefined>) | undefined;
}

/** Staging writes touch only the staging table: its own lock domain, never the sessions tables' schema check. */
function stagingTransaction(table: string): SqliteTransactionOptions {
	return { retryTransientFailures: true, concurrency: { kind: "serial", domain: table } };
}

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
		const done = await database.transaction(async (tx) => {
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
			await tx.run(`DELETE FROM ${table} WHERE transfer_id = ? AND kind = ${LEASE} AND body = ?`, transfer, token);
			return true;
		}, stagingTransaction(table));
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
		}, stagingTransaction(table));
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
): Promise<SessionWriteResult & { readonly remainingBlobs: readonly string[] }> {
	if (!missingStagingHinted) {
		missingStagingHinted = true;
		globalThis.process?.emitWarning?.(
			`This database role may not create the fork staging table ${target.table}, so whole-session clones into it are read into memory. Run \`atomic storage migrate\` as the owner role to copy them a page at a time.`,
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
 * chunks are served from that entry's stored chunk rows, each fetched whole in one source read. The most recently read
 * rows are held, up to {@link FORK_STAGING_READ_CACHE_BYTES}, so the passes the feed and the copy make over one entry
 * fetch each row once. Each fetch checks the entry's generation, as each read did; the rows of a generation never
 * change. Anything else reads as before.
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
	/** The last entry found stored whole, whose reads go to the store as without this reader. */
	let whole: string | undefined;
	const readEntryChunk = async (reference: OversizedSessionEntry, offset: number): Promise<Uint8Array> => {
		const index = Math.floor(offset / chunkBytes);
		const entry = `${reference.sessionId}\u0000${reference.epoch}\u0000${reference.seq}`;
		if (whole === entry) return read(reference, offset);
		const key = `${entry}\u0000${index}`;
		let data = held.get(key);
		if (data === undefined) {
			const fetched = await rows(reference, index);
			if (fetched === undefined) {
				whole = entry;
				return read(reference, offset);
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
		const start = offset - index * chunkBytes;
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
	const { database, dialect, table } = target;
	const options = stagingTransaction(table);
	if ((await database.get(`SELECT id FROM ${target.tables.sessions} WHERE id = ?`, header.id)) !== undefined)
		throw new SessionExistsError(header.id);
	try {
		await ensureForkStagingTable(database, dialect, table);
	} catch (error) {
		// Another role, such as the owner's `atomic storage migrate`, may have created it meanwhile: stage into it.
		const probe = dialect.tableExists(table);
		if ((await database.get(probe.sql, ...probe.params)) === undefined) {
			if (!missingPrivilege(error)) throw error;
			return wholeSourceFork(target, header, stream, source);
		}
	}
	await cleanupForkStaging(database, dialect, table, FORK_STAGING_TRANSFER_CLEANUPS).catch(() => {});
	const transfer = randomId();
	const token = randomId();
	await database.transaction(
		(tx) =>
			tx.run(
				`INSERT INTO ${table} (transfer_id, kind, seq, idx, name, size, body) VALUES (?, ${LEASE}, 0, 0, ?, ${dialect.nowMs} + ?, ?)`,
				transfer,
				header.id,
				FORK_STAGING_LEASE_MS,
				token,
			),
		options,
	);

	/** Writes `rows` in one transaction of the destination, renewing the lease; never while a source read runs. */
	const write = async (rows: readonly StagedRow[]) => {
		await database.transaction(async (tx) => {
			const { changes } = await tx.run(
				`UPDATE ${table} SET size = ${dialect.nowMs} + ? WHERE transfer_id = ? AND kind = ${LEASE} AND body = ?`,
				FORK_STAGING_LEASE_MS,
				transfer,
				token,
			);
			if (changes !== 1) throw lostTransfer(header);
			for (const row of rows) {
				await tx.run(
					`INSERT INTO ${table} (transfer_id, kind, seq, idx, name, size, body, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					transfer,
					row.kind,
					row.seq,
					row.idx,
					row.name ?? null,
					row.size ?? null,
					row.body ?? null,
					(row.data ?? null) as SqliteValue,
				);
			}
		}, options);
	};

	try {
		// The batch: rows staged since the last write, and the seq of each entry among them for the index's links.
		let pending: StagedRow[] = [];
		let pendingBytes = 0;
		let pendingIds = new Map<string, number>();
		const flush = async () => {
			if (pending.length === 0) return;
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
		for (const hash of hashes) {
			if (!target.ownsBlobs) {
				leftForPutBlob.push(hash);
				continue;
			}
			const at = ordinal++;
			const chunks = await stageBlob(target, source, hash, at, stage);
			if (chunks === undefined) missing.push(hash);
			else {
				blobRows++;
				blobChunkRows += chunks;
			}
		}
		await flush();

		const { epoch } = await target.transaction(async (tx) => {
			const { tables } = target;
			// The lease decides between this publication and a cleanup that took the transfer over.
			const { changes: held } = await tx.run(
				`UPDATE ${table} SET size = ${dialect.nowMs} + ? WHERE transfer_id = ? AND kind = ${LEASE} AND body = ?`,
				FORK_STAGING_LEASE_MS,
				transfer,
				token,
			);
			if (held !== 1) throw lostTransfer(header);
			if ((await tx.get(`SELECT id FROM ${tables.sessions} WHERE id = ?`, header.id)) !== undefined)
				throw new SessionExistsError(header.id);
			const saved = await target.saveSummary(tx, header, seq, summary, index);
			const expect = async (copied: Promise<{ readonly changes: number }>, rows: number, what: string) => {
				if ((await copied).changes !== rows)
					throw new StorageError(
						`The staged copy of session ${header.id} is missing ${what}; nothing was published`,
					);
			};
			await expect(
				tx.run(
					`INSERT INTO ${tables.entries} (session_id, seq, entry_id, entry_json, chunks) SELECT ?, seq, name, body, size FROM ${table} WHERE transfer_id = ? AND kind = ${ENTRY} ORDER BY seq`,
					header.id,
					transfer,
				),
				seq,
				"entries",
			);
			if (entryChunkRows > 0)
				await expect(
					tx.run(
						`INSERT INTO ${tables.entryChunks} (session_id, seq, idx, data) SELECT ?, seq, idx, data FROM ${table} WHERE transfer_id = ? AND kind = ${ENTRY_CHUNK} ORDER BY seq, idx`,
						header.id,
						transfer,
					),
					entryChunkRows,
					"entry chunks",
				);
			// As `create` does with its first chunked entry: a build that knows only version 1 refuses the database.
			if (chunkedEntries > 0)
				await tx.run(
					`UPDATE ${tables.meta} SET schema_version = ? WHERE schema_version = ?`,
					target.chunkedSchemaVersion,
					target.unchunkedSchemaVersion,
				);
			if (textRows > 0)
				await expect(
					tx.run(
						`INSERT INTO ${tables.searchTexts} (session_id, seq, text_json) SELECT ?, seq, body FROM ${table} WHERE transfer_id = ? AND kind = ${SEARCH_TEXT} ORDER BY seq`,
						header.id,
						transfer,
					),
					textRows,
					"search texts",
				);
			if (blobRows > 0) {
				const legacy = target.legacyBlobData;
				await expect(
					tx.run(
						`INSERT INTO ${tables.blobs} (session_id, hash, bytes, chunks${legacy ? ", data" : ""}) SELECT ?, name, size, idx${legacy ? ", X''" : ""} FROM ${table} WHERE transfer_id = ? AND kind = ${BLOB} ORDER BY seq`,
						header.id,
						transfer,
					),
					blobRows,
					"blobs",
				);
			}
			if (blobChunkRows > 0)
				await expect(
					tx.run(
						`INSERT INTO ${tables.blobChunks} (session_id, hash, idx, data) SELECT ?, h.name, c.idx, c.data FROM ${table} c JOIN ${table} h ON h.transfer_id = c.transfer_id AND h.kind = ${BLOB} AND h.seq = c.seq WHERE c.transfer_id = ? AND c.kind = ${BLOB_CHUNK} ORDER BY c.seq, c.idx`,
						header.id,
						transfer,
					),
					blobChunkRows,
					"blob chunks",
				);
			await tx.run(`DELETE FROM ${table} WHERE transfer_id = ?`, transfer);
			return saved;
		});
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

/**
 * Stages the blob `hash` of the source session under `ordinal`, one stored chunk at a time when the source is a SQL
 * session store and whole, as `copySessionBlobs` reads it, otherwise. Resolves with its chunk count, or undefined when
 * the source no longer holds it.
 */
async function stageBlob(
	target: ForkStagingTarget,
	source: ForkArchiveSource,
	hash: string,
	ordinal: number,
	stage: (row: StagedRow) => Promise<void>,
): Promise<number | undefined> {
	const size = target.blobChunkBytes;
	const parts = target.sourceBlobParts(source.store);
	const incomplete = (bytes: number) =>
		new SessionBlobError("blob-incomplete", { sessionId: source.sessionId, hash, bytes });
	if (parts !== undefined) {
		let part = await parts(source.sessionId, hash, 0);
		if (part === undefined) return undefined;
		if (part.chunks >= 0) {
			const { bytes, chunks } = part;
			if (chunks !== Math.ceil(bytes / size)) throw incomplete(bytes);
			for (let idx = 0; idx < chunks; idx++) {
				if (idx > 0) part = await parts(source.sessionId, hash, idx);
				// The session was deleted meanwhile: it holds nothing, as getBlob would report.
				if (part === undefined) return undefined;
				if (part.data?.byteLength !== Math.min(size, bytes - idx * size)) throw incomplete(bytes);
				await stage({ kind: BLOB_CHUNK, seq: ordinal, idx, data: part.data });
			}
			await stage({ kind: BLOB, seq: ordinal, idx: chunks, name: hash, size: bytes });
			return chunks;
		}
	}
	const data = await source.store.getBlob!(source.sessionId, hash);
	if (data === undefined) return undefined;
	const chunks = Math.ceil(data.byteLength / size);
	for (let idx = 0; idx < chunks; idx++)
		await stage({ kind: BLOB_CHUNK, seq: ordinal, idx, data: data.subarray(idx * size, (idx + 1) * size) });
	await stage({ kind: BLOB, seq: ordinal, idx: chunks, name: hash, size: data.byteLength });
	return chunks;
}
