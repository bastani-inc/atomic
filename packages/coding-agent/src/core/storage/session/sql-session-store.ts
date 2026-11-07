import type { SessionEntry } from "../../session-manager-types.ts";
import { SqlSnapshotBlobStore } from "../../worktree-snapshot/blob-store.ts";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteTransactionOptions, SqliteValue } from "../database.js";
import { SessionBlobError, StorageInvalidTextError } from "../errors.js";
import { renderStorageIdentifiers } from "../prefix.js";
import { assertStorageSchemaVersion } from "../schema.js";
import { sha256Hex } from "./blob-hash.js";
import {
	SessionConflictError,
	SessionExistsError,
	SessionIdMismatchError,
	SessionNotFoundError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";
import {
	applySessionSummaryEntries,
	materializeSessionSummaryMetadata,
	type SessionSummaryState,
	type SessionSummaryText,
} from "./session-summary.js";
import type {
	SessionBlob,
	SessionCwdMatcher,
	SessionListQuery,
	SessionRecordHeader,
	SessionSnapshot,
	SessionStore,
	SessionSummary,
	SessionWriteOptions,
	StorageDescriptor,
} from "./types.js";
import { validateSessionEntries, validateSessionHeader, validateSessionText } from "./validation.js";

export const SESSION_SCHEMA_VERSION = 1;
/**
 * The most bytes of a session blob one row holds. A blob is stored as a header row and rows of at most this size,
 * so no value a statement binds or returns exceeds it: libSQL servers cap a row and a bound value (sqld's default is
 * 5 MB) and a statement's response (10 MB), and the HTTP protocol carries a blob as base64 in JSON, about 1.4 MB for
 * this size. A different size needs different table names, because a blob's rows are addressed by their index.
 */
export const SESSION_BLOB_CHUNK_BYTES = 1024 * 1024;
/** Materialize one bounded slice once, rather than loading the entire legacy BLOB for every chunk. */
const LEGACY_BLOB_BATCH_CHUNKS = 16;
export const SESSION_TABLES = Object.freeze({
	meta: "meta",
	sessions: "sessions",
	entries: "entries",
	searchTexts: "search_texts",
	blobs: "blobs",
	blobChunks: "blob_chunks",
});

type Tables = Readonly<Record<keyof typeof SESSION_TABLES, string>>;
type HeaderRow = SqliteRow & { header_json: string; last_seq: number };
type SummaryStateRow = HeaderRow & { summary_state: string };
type ListingRow = HeaderRow & {
	id: string;
	cwd: string;
	internal: number;
	modified_at: string;
	message_count: number;
	first_message: string;
	name: string | null;
	has_name: number;
	summary: string | null;
	summarized_through_id: string | null;
	revision: string;
};
type SummaryRow = ListingRow & { search_texts_json: string };

/** Each committed batch is its own durable checkpoint; the legacy bytes stay readable until publication. */
async function migrateLegacyBlobBatch(
	tx: SqliteExecutor,
	tables: Tables,
	sessionId: string,
	hash: string,
): Promise<boolean> {
	const params = [sessionId, hash];
	const row = await tx.get<SqliteRow & { bytes: number }>(
		`SELECT bytes FROM ${tables.blobs} WHERE session_id = ? AND hash = ? AND chunks = -1`,
		...params,
	);
	if (!row) return false;
	const progress = await tx.get<SqliteRow & { next: number }>(
		`SELECT COALESCE(max(idx) + 1, 0) AS next FROM ${tables.blobChunks} WHERE session_id = ? AND hash = ?`,
		...params,
	);
	const next = Number(progress!.next);
	const chunks = Math.ceil(Number(row.bytes) / SESSION_BLOB_CHUNK_BYTES);
	const end = Math.min(next + LEGACY_BLOB_BATCH_CHUNKS, chunks);
	if (next < end) {
		await tx.run(
			`WITH RECURSIVE source(data) AS MATERIALIZED (
				SELECT substr(data, ?, ?) FROM ${tables.blobs} WHERE session_id = ? AND hash = ?
			), indices(idx) AS (
				SELECT 0 UNION ALL SELECT idx + 1 FROM indices WHERE idx + 1 < ?
			)
			INSERT INTO ${tables.blobChunks} (session_id, hash, idx, data)
			SELECT ?, ?, idx + ?, substr(data, idx * ${SESSION_BLOB_CHUNK_BYTES} + 1, ${SESSION_BLOB_CHUNK_BYTES})
			FROM source CROSS JOIN indices`,
			next * SESSION_BLOB_CHUNK_BYTES + 1,
			(end - next) * SESSION_BLOB_CHUNK_BYTES,
			...params,
			end - next,
			...params,
			next,
		);
	}
	if (end === chunks) {
		// Publish only complete chunks and release the old bytes atomically, including for empty blobs.
		await tx.run(
			`UPDATE ${tables.blobs} SET chunks = ?, data = X'' WHERE session_id = ? AND hash = ?`,
			chunks,
			...params,
		);
	}
	return true;
}
/** Every listing column except search text, so an unchanged row keeps its cached summary. */
const LISTING_COLUMNS =
	"id, cwd, internal, header_json, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, revision";
/** Rows whose search text is read per query; well under SQLite's bound-parameter limit. */
export const LISTING_FETCH_BATCH = 500;
/** Listing scopes (visibility and project) kept at once; the picker uses two. */
const LISTING_SCOPES = 8;
/**
 * Session reads and writes use nothing but their transaction, so one that a transient failure of a database server
 * ended before it committed runs again (#4383); `append` and `replace` check `expectSeq` again on each run.
 */
const SESSION_TRANSACTION: SqliteTransactionOptions = { retryTransientFailures: true };

function summaryFromRow(row: SummaryRow): SessionSummary {
	const header = JSON.parse(row.header_json) as SessionRecordHeader;
	return {
		id: header.id,
		cwd: header.cwd,
		...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
		internal: header.internal === true,
		...(header.workflow !== undefined ? { workflow: header.workflow } : {}),
		...(row.name !== null ? { name: JSON.parse(row.name) as string } : {}),
		hasName: row.has_name === 1,
		createdAt: header.createdAt,
		modifiedAt: row.modified_at,
		messageCount: row.message_count,
		firstMessage: JSON.parse(row.first_message) as string,
		...(row.summary !== null ? { summary: JSON.parse(row.summary) as string } : {}),
		...(row.summarized_through_id !== null ? { summarizedThroughId: row.summarized_through_id } : {}),
		searchText: (JSON.parse(row.search_texts_json) as string[]).join(" "),
	};
}

/** Changes on every write: `revision` catches a rewrite that leaves every other listed column as it was. */
function listingVersion(row: ListingRow): string {
	return `${row.revision}\u0000${row.last_seq}\u0000${row.modified_at}\u0000${row.message_count}\u0000${row.has_name}\u0000${row.name}\u0000${row.summarized_through_id}\u0000${row.summary}\u0000${row.first_message}\u0000${row.header_json}`;
}

export class SqlSessionStore implements SessionStore {
	private readonly database: SqliteDatabase;
	private readonly tables: Tables;
	private readonly prefix: string;
	private readonly legacyBlobData: boolean;
	private closed = false;
	private readonly cwdMatcher?: SessionCwdMatcher;
	readonly snapshotBlobs: SqlSnapshotBlobStore;
	/** Session ids of each recently listed scope, valid while the store's change token is unchanged. */
	private readonly scopes = new Map<string, { readonly token: string; readonly ids: readonly string[] }>();
	/** Listed summaries of sessions that still exist at the cached version; never more than the store holds. */
	private readonly summaries = new Map<string, { readonly version: string; readonly summary: SessionSummary }>();
	/**
	 * Settles when the latest listing has read and updated the caches. Listings take turns, so one listing's
	 * pruning never drops summaries that another has fetched but not yet recorded under its scope.
	 */
	private listing: Promise<void> = Promise.resolve();

	private constructor(
		database: SqliteDatabase,
		tables: Tables,
		prefix: string | undefined,
		cwdMatcher: SessionCwdMatcher | undefined,
		snapshotBlobs: SqlSnapshotBlobStore,
		legacyBlobData: boolean,
	) {
		this.database = database;
		this.tables = tables;
		this.prefix = prefix ?? "";
		this.cwdMatcher = cwdMatcher;
		this.snapshotBlobs = snapshotBlobs;
		this.legacyBlobData = legacyBlobData;
	}

	static async open(
		database: SqliteDatabase,
		options: { readonly prefix?: string; readonly cwdMatcher?: SessionCwdMatcher } = {},
	): Promise<SqlSessionStore> {
		const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, options.prefix);
		const legacyBlobData = await database.transaction(async (tx) => {
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${tables.meta} (schema_version INTEGER NOT NULL) STRICT`);
			const versions = await tx.all(`SELECT schema_version FROM ${tables.meta}`);
			if (versions.length === 0) {
				await tx.run(`INSERT INTO ${tables.meta} VALUES (?)`, SESSION_SCHEMA_VERSION);
			}
			for (const version of versions) {
				assertStorageSchemaVersion("sessions", version.schema_version!, SESSION_SCHEMA_VERSION);
			}
			await tx.exec(`
				CREATE TABLE IF NOT EXISTS ${tables.sessions} (
					id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at TEXT NOT NULL,
					header_json TEXT NOT NULL CHECK(json_valid(header_json)), internal INTEGER NOT NULL,
					last_seq INTEGER NOT NULL, modified_at TEXT NOT NULL, message_count INTEGER NOT NULL,
					first_message TEXT NOT NULL CHECK(json_valid(first_message)),
					name TEXT CHECK(name IS NULL OR json_valid(name)), has_name INTEGER NOT NULL,
					summary TEXT CHECK(summary IS NULL OR json_valid(summary)), summarized_through_id TEXT,
					summary_state TEXT NOT NULL CHECK(json_valid(summary_state)), revision TEXT NOT NULL DEFAULT ''
				) STRICT;
				CREATE TABLE IF NOT EXISTS ${tables.entries} (
					session_id TEXT NOT NULL, seq INTEGER NOT NULL, entry_id TEXT NOT NULL,
					entry_json TEXT NOT NULL CHECK(json_valid(entry_json)), PRIMARY KEY(session_id, seq)
				) STRICT;
				CREATE TABLE IF NOT EXISTS ${tables.searchTexts} (
					session_id TEXT NOT NULL, seq INTEGER NOT NULL,
					text_json TEXT NOT NULL CHECK(json_valid(text_json)), PRIMARY KEY(session_id, seq)
				) STRICT;
				CREATE TABLE IF NOT EXISTS ${tables.blobs} (
					session_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, chunks INTEGER NOT NULL,
					PRIMARY KEY(session_id, hash)
				) STRICT;
				CREATE TABLE IF NOT EXISTS ${tables.blobChunks} (
					session_id TEXT NOT NULL, hash TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL,
					PRIMARY KEY(session_id, hash, idx)
				) STRICT;
			`);
			// Sessions tables created before the write revision gain it; their rows pick one up on the next write.
			const revision = await tx.get(
				"SELECT name FROM pragma_table_info(?) WHERE name = 'revision'",
				tables.sessions,
			);
			if (!revision) {
				await tx.exec(`ALTER TABLE ${tables.sessions} ADD COLUMN revision TEXT NOT NULL DEFAULT ''`);
			}
			const legacy = Boolean(
				await tx.get("SELECT name FROM pragma_table_info(?) WHERE name = 'data'", tables.blobs),
			);
			if (legacy && !(await tx.get("SELECT name FROM pragma_table_info(?) WHERE name = 'chunks'", tables.blobs))) {
				await tx.exec(`ALTER TABLE ${tables.blobs} ADD COLUMN chunks INTEGER NOT NULL DEFAULT -1`);
			}
			return legacy;
		});
		const blobs = await SqlSnapshotBlobStore.open(database, options.prefix);
		return new SqlSessionStore(database, tables, options.prefix, options.cwdMatcher, blobs, legacyBlobData);
	}

	get descriptor(): StorageDescriptor {
		return { ...this.database.descriptor, ...(this.prefix === "" ? {} : { prefix: this.prefix }) };
	}

	async create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<{ readonly lastSeq: number }> {
		this.assertOpen();
		validateSessionHeader(header);
		validateSessionEntries(entries);
		return this.database.transaction(async (tx) => {
			if (await tx.get(`SELECT id FROM ${this.tables.sessions} WHERE id = ?`, header.id)) {
				throw new SessionExistsError(header.id);
			}
			const texts = await this.saveSummary(tx, header.id, { header, entries, lastSeq: entries.length });
			await this.insertEntries(tx, header.id, entries, 0, texts);
			return { lastSeq: entries.length };
		}, SESSION_TRANSACTION);
	}

	async append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		return this.database.transaction(async (tx) => {
			const previous = await this.forWrite(tx, sessionId, options, true);
			validateSessionEntries(entries);
			const lastSeq = previous.last_seq + entries.length;
			const texts = await this.saveSummary(
				tx,
				sessionId,
				{ header: JSON.parse(previous.header_json) as SessionRecordHeader, entries, lastSeq },
				JSON.parse(previous.summary_state) as SessionSummaryState,
			);
			await this.insertEntries(tx, sessionId, entries, previous.last_seq, texts);
			return { lastSeq };
		}, SESSION_TRANSACTION);
	}

	async replace(
		sessionId: string,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		return this.database.transaction(async (tx) => {
			await this.forWrite(tx, sessionId, options);
			validateSessionHeader(header);
			validateSessionEntries(entries);
			if (header.id !== sessionId) throw new SessionIdMismatchError(sessionId, header.id);
			await tx.run(`DELETE FROM ${this.tables.searchTexts} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.entries} WHERE session_id = ?`, sessionId);
			const texts = await this.saveSummary(tx, sessionId, { header, entries, lastSeq: entries.length });
			await this.insertEntries(tx, sessionId, entries, 0, texts);
			return { lastSeq: entries.length };
		}, SESSION_TRANSACTION);
	}

	async load(sessionId: string): Promise<SessionSnapshot> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		return this.database.transaction((tx) => this.read(tx, sessionId), SESSION_TRANSACTION);
	}

	async readHeader(sessionId: string): Promise<SessionRecordHeader | undefined> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const row = await this.database.get<HeaderRow>(
			`SELECT header_json FROM ${this.tables.sessions} WHERE id = ?`,
			sessionId,
		);
		return row ? (JSON.parse(row.header_json) as SessionRecordHeader) : undefined;
	}

	async delete(sessionId: string): Promise<void> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		await this.database.transaction(async (tx) => {
			await tx.run(`DELETE FROM ${this.tables.blobChunks} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.blobs} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.searchTexts} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.entries} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.sessions} WHERE id = ?`, sessionId);
		}, SESSION_TRANSACTION);
	}

	/**
	 * Stores the blob as rows of at most {@link SESSION_BLOB_CHUNK_BYTES}, then publishes its header. Every statement
	 * commits by itself and writes only while the session exists, so no transaction stays open across round trips and
	 * `delete`, which removes a session's rows in one transaction, leaves none behind. A blob is readable only once its
	 * header is there, so a writer that stops part way leaves rows of its own session that `delete` removes, and storing
	 * the same bytes again completes or skips them. Bytes a session already holds are not sent again.
	 */
	async putBlob(sessionId: string, data: Uint8Array): Promise<SessionBlob> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const stored = Uint8Array.from(data);
		const blob = { hash: await sha256Hex(stored), bytes: stored.byteLength };
		const previous = await this.blobHeader(sessionId, blob.hash);
		if (previous) {
			// Legacy bytes are converted only when written again, never on an opener's or reader's critical path.
			// Each batch releases the writer queue; a crash loses at most one batch and readers keep the old bytes.
			if (previous.chunks === -1) {
				while (
					await this.database.transaction((tx) => migrateLegacyBlobBatch(tx, this.tables, sessionId, blob.hash))
				) {
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
				}
			}
			return blob;
		}
		const chunks = Math.ceil(blob.bytes / SESSION_BLOB_CHUNK_BYTES);
		const { sessions, blobs, blobChunks } = this.tables;
		const sessionExists = `EXISTS (SELECT 1 FROM ${sessions} WHERE id = ?)`;
		for (let index = 0; index < chunks; index++) {
			await this.database.run(
				`INSERT INTO ${blobChunks} (session_id, hash, idx, data) SELECT ?, ?, ?, ? WHERE ${sessionExists}
					ON CONFLICT DO NOTHING`,
				sessionId,
				blob.hash,
				index,
				stored.subarray(index * SESSION_BLOB_CHUNK_BYTES, (index + 1) * SESSION_BLOB_CHUNK_BYTES),
				sessionId,
			);
		}
		const { changes } = await this.database.run(
			`INSERT INTO ${blobs} (session_id, hash, bytes, chunks${this.legacyBlobData ? ", data" : ""})
				SELECT ?, ?, ?, ?${this.legacyBlobData ? ", X''" : ""}
				WHERE ${sessionExists} AND (SELECT count(*) FROM ${blobChunks} WHERE session_id = ? AND hash = ?) = ?
				ON CONFLICT DO NOTHING`,
			sessionId,
			blob.hash,
			blob.bytes,
			chunks,
			sessionId,
			sessionId,
			blob.hash,
			chunks,
		);
		// No header written: another writer published the same bytes, or the session was deleted while this wrote.
		if (changes === 0 && !(await this.blobHeader(sessionId, blob.hash))) throw new SessionNotFoundError(sessionId);
		return blob;
	}

	/**
	 * Reads the blob a chunk at a time, each one statement returning at most {@link SESSION_BLOB_CHUNK_BYTES}. Rows
	 * never change once written, so no transaction is needed. A session deleted meanwhile holds nothing; a header
	 * whose rows are not all there is a `blob-incomplete` failure.
	 */
	async getBlob(sessionId: string, hash: string): Promise<Uint8Array | undefined> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const header = await this.blobHeader(sessionId, hash);
		if (header === undefined) return undefined;
		const data = new Uint8Array(header.bytes);
		let offset = 0;
		const chunks = header.chunks < 0 ? Math.ceil(header.bytes / SESSION_BLOB_CHUNK_BYTES) : header.chunks;
		for (let index = 0; index < chunks; index++) {
			const row = await this.database.get<SqliteRow & { data: Uint8Array | null }>(
				this.legacyBlobData
					? `SELECT CASE WHEN chunks = -1 THEN substr(data, ${index * SESSION_BLOB_CHUNK_BYTES + 1}, ${SESSION_BLOB_CHUNK_BYTES})
						ELSE (SELECT data FROM ${this.tables.blobChunks} WHERE session_id = b.session_id AND hash = b.hash AND idx = ?)
						END AS data FROM ${this.tables.blobs} b WHERE session_id = ? AND hash = ?`
					: `SELECT data FROM ${this.tables.blobChunks} WHERE idx = ? AND session_id = ? AND hash = ?`,
				index,
				sessionId,
				hash,
			);
			if (row?.data == null || offset + row.data.byteLength > data.byteLength) break;
			data.set(row.data, offset);
			offset += row.data.byteLength;
		}
		if (offset === data.byteLength) return data;
		if ((await this.blobHeader(sessionId, hash)) === undefined) return undefined;
		throw new SessionBlobError("blob-incomplete", { sessionId, hash, bytes: header.bytes });
	}

	private async blobHeader(
		sessionId: string,
		hash: string,
	): Promise<{ readonly bytes: number; readonly chunks: number } | undefined> {
		const row = await this.database.get<SqliteRow & { bytes: number; chunks: number }>(
			`SELECT bytes, chunks FROM ${this.tables.blobs} WHERE session_id = ? AND hash = ?`,
			sessionId,
			hash,
		);
		return row === undefined ? undefined : { bytes: Number(row.bytes), chunks: Number(row.chunks) };
	}

	/**
	 * Lists from a per-scope cache revalidated on every call. A cheap change token, which moves on any commit
	 * from this or another connection, decides whether the scope is re-read. A scope listed for the first time
	 * is read exactly as an uncached listing; afterwards only its light columns are re-read and search text is
	 * read only for sessions whose stored listing columns changed. Listings of the same store take turns
	 * reading and updating the caches; the yielding below runs outside that turn.
	 */
	async *list(query: SessionListQuery): AsyncIterable<SessionSummary> {
		this.assertListing(query);
		// Validate the original query before binding only matching stored spellings below.
		if (query.cwd?.includes("\0")) throw new StorageInvalidTextError(0);
		const listed = this.listing.then(() => this.listScope(query));
		this.listing = listed.then(
			() => {},
			() => {},
		);
		// Resolve before yielding so a concurrent listing cannot change what this one returns.
		const summaries = await listed;
		for (const summary of summaries) {
			this.assertListing(query);
			yield summary;
		}
		this.assertListing(query);
	}

	/** Revalidates one scope's cache and resolves its summaries; called for one listing at a time. */
	private async listScope(query: SessionListQuery): Promise<readonly SessionSummary[]> {
		// The store may have closed, or the caller given up, while an earlier listing held the turn.
		this.assertListing(query);
		// Read the token first: a commit racing the reads below moves it again before the next call.
		const token = await this.changeToken();
		const key = JSON.stringify([query.includeInternal === true, query.cwd ?? null]);
		const cached = this.scopes.get(key);
		// A cached id without a summary is never expected; re-reading the scope repairs it instead of dropping it.
		const scope =
			cached?.token === token && cached.ids.every((id) => this.summaries.has(id))
				? cached
				: { token, ids: await this.readScope(query, cached !== undefined) };
		// Map order is recency order: re-inserting marks the scope as used, and the oldest scope is evicted first.
		this.scopes.delete(key);
		this.scopes.set(key, scope);
		for (const oldest of this.scopes.keys()) {
			if (this.scopes.size <= LISTING_SCOPES) break;
			this.scopes.delete(oldest);
		}
		if (scope !== cached) this.pruneSummaries();
		return scope.ids.flatMap((id) => this.summaries.get(id)?.summary ?? []);
	}

	async findMostRecent(query: {
		readonly cwd: string;
		readonly includeInternal?: boolean;
	}): Promise<SessionSummary | undefined> {
		let latest: SessionSummary | undefined;
		for await (const summary of this.list(query)) {
			if (!latest || Date.parse(summary.modifiedAt) > Date.parse(latest.modifiedAt)) latest = summary;
		}
		return latest;
	}

	async close(): Promise<void> {
		this.assertOpen();
		this.closed = true;
		this.scopes.clear();
		this.summaries.clear();
	}

	/**
	 * `data_version` moves when another connection commits and `total_changes()` when this one writes, so
	 * together they cover writers in every process; the table aggregates also catch a change to the sessions
	 * table if the adapter does not serve every statement from one connection.
	 */
	private async changeToken(): Promise<string> {
		const row = await this.database.get<SqliteRow>(
			`SELECT data_version, total_changes() AS changes,
				(SELECT count(*) FROM ${this.tables.sessions}) AS sessions,
				(SELECT max(rowid) FROM ${this.tables.sessions}) AS last_row
			FROM pragma_data_version`,
		);
		return JSON.stringify(Object.values(row ?? {}).map(String));
	}

	/** The scope's session ids in store order, with a current summary cached for each. */
	private async readScope(query: SessionListQuery, listedBefore: boolean): Promise<readonly string[]> {
		const matchesCwd =
			query.cwd === undefined
				? undefined
				: (this.cwdMatcher?.(query.cwd) ?? ((candidate: string | undefined) => candidate === query.cwd));
		let projectCwds: string[] | undefined;
		if (matchesCwd) {
			const projects = await this.database.all<SqliteRow & { cwd: string }>(
				`SELECT DISTINCT cwd FROM ${this.tables.sessions}`,
			);
			projectCwds = projects.map((project) => project.cwd).filter(matchesCwd);
			this.assertListing(query);
			if (projectCwds.length === 0) return [];
		}
		const scope = `(? = 1 OR internal = 0)${projectCwds ? ` AND cwd IN (${projectCwds.map(() => "?").join(", ")})` : ""}`;
		const params = [query.includeInternal ? 1 : 0, ...(projectCwds ?? [])];
		const inScope = (row: ListingRow) => !matchesCwd || matchesCwd(row.cwd);
		if (listedBefore) {
			const rows = (
				await this.database.all<ListingRow>(
					`SELECT ${LISTING_COLUMNS} FROM ${this.tables.sessions} WHERE ${scope}`,
					...params,
				)
			).filter(inScope);
			this.assertListing(query);
			const stale = rows.filter((row) => this.summaries.get(row.id)?.version !== listingVersion(row));
			// A few changed sessions are read by id; when most changed, one scan of the scope is cheaper.
			if (stale.length <= rows.length / 4) {
				for (let start = 0; start < stale.length; start += LISTING_FETCH_BATCH) {
					const ids = stale.slice(start, start + LISTING_FETCH_BATCH).map((row) => row.id);
					const fetched = new Set(
						(await this.readSummaries(`id IN (${ids.map(() => "?").join(", ")})`, ids)).map((row) => row.id),
					);
					// A session deleted after the light read must not be listed from an older cached copy.
					for (const id of ids) if (!fetched.has(id)) this.summaries.delete(id);
					this.assertListing(query);
				}
				return rows.flatMap((row) => (this.summaries.has(row.id) ? [row.id] : []));
			}
		}
		const rows = (await this.readSummaries(scope, params)).filter(inScope);
		this.assertListing(query);
		return rows.map((row) => row.id);
	}

	/** Reads full listing rows, search text included, and caches their summaries. */
	private async readSummaries(where: string, params: readonly SqliteValue[]): Promise<readonly SummaryRow[]> {
		// Combine encoded strings only at read time, preserving NUL and lone surrogates verbatim.
		const rows = await this.database.all<SummaryRow>(
			`SELECT ${LISTING_COLUMNS}, (
				SELECT COALESCE('[' || group_concat(text_json, ',') || ']', '[]')
				FROM (SELECT text_json FROM ${this.tables.searchTexts} WHERE session_id = s.id ORDER BY seq)
			) AS search_texts_json
			FROM ${this.tables.sessions} AS s WHERE ${where}`,
			...params,
		);
		for (const row of rows)
			this.summaries.set(row.id, { version: listingVersion(row), summary: summaryFromRow(row) });
		return rows;
	}

	/**
	 * Keeps only summaries some cached scope still lists, so memory follows the live sessions. Runs in a
	 * listing's turn after it records its scope, when no other listing holds summaries it has not recorded.
	 */
	private pruneSummaries(): void {
		const listed = new Set([...this.scopes.values()].flatMap((scope) => scope.ids));
		for (const id of this.summaries.keys()) if (!listed.has(id)) this.summaries.delete(id);
	}

	private assertOpen(): void {
		if (this.closed) throw new StoreClosedError(this.descriptor);
	}

	private assertListing(query: SessionListQuery): void {
		this.assertOpen();
		query.signal?.throwIfAborted();
	}

	private async read(tx: SqliteExecutor, sessionId: string): Promise<SessionSnapshot> {
		const row = await tx.get<HeaderRow>(
			`SELECT header_json, last_seq FROM ${this.tables.sessions} WHERE id = ?`,
			sessionId,
		);
		if (!row) throw new SessionNotFoundError(sessionId);
		const entries = await tx.all<SqliteRow & { entry_json: string }>(
			`SELECT entry_json FROM ${this.tables.entries} WHERE session_id = ? ORDER BY seq`,
			sessionId,
		);
		return {
			header: JSON.parse(row.header_json) as SessionRecordHeader,
			entries: entries.map((entry) => JSON.parse(entry.entry_json) as SessionEntry),
			lastSeq: row.last_seq,
		};
	}

	private forWrite(
		tx: SqliteExecutor,
		sessionId: string,
		options: SessionWriteOptions,
		includeSummaryState: true,
	): Promise<SummaryStateRow>;
	private forWrite(
		tx: SqliteExecutor,
		sessionId: string,
		options: SessionWriteOptions,
		includeSummaryState?: false,
	): Promise<HeaderRow>;
	private async forWrite(
		tx: SqliteExecutor,
		sessionId: string,
		options: SessionWriteOptions,
		includeSummaryState = false,
	): Promise<HeaderRow> {
		const row = await tx.get<HeaderRow>(
			`SELECT header_json, last_seq${includeSummaryState ? ", summary_state" : ""}
			 FROM ${this.tables.sessions} WHERE id = ?`,
			sessionId,
		);
		if (!row) throw new SessionNotFoundError(sessionId);
		if (row.last_seq !== options.expectSeq) {
			throw new SessionConflictError(sessionId, options.expectSeq, row.last_seq);
		}
		return row;
	}

	private async saveSummary(
		tx: SqliteExecutor,
		sessionId: string,
		snapshot: SessionSnapshot,
		previous?: SessionSummaryState,
	): Promise<readonly SessionSummaryText[]> {
		const { header, lastSeq } = snapshot;
		const { state, texts } = applySessionSummaryEntries(previous, snapshot.entries);
		const summary = materializeSessionSummaryMetadata(header, state);
		await tx.run(
			`INSERT INTO ${this.tables.sessions}
				(id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count,
				 first_message, name, has_name, summary, summarized_through_id, summary_state, revision)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, lower(hex(randomblob(16))))
				ON CONFLICT(id) DO UPDATE SET
				cwd = excluded.cwd, created_at = excluded.created_at, header_json = excluded.header_json,
				internal = excluded.internal, last_seq = excluded.last_seq, modified_at = excluded.modified_at,
				message_count = excluded.message_count, first_message = excluded.first_message, name = excluded.name,
				has_name = excluded.has_name, summary = excluded.summary,
				summarized_through_id = excluded.summarized_through_id,
				summary_state = excluded.summary_state, revision = excluded.revision`,
			sessionId,
			header.cwd,
			header.createdAt,
			this.encode(header),
			header.internal ? 1 : 0,
			lastSeq,
			summary.modifiedAt,
			summary.messageCount,
			this.encode(summary.firstMessage),
			summary.name === undefined ? null : this.encode(summary.name),
			summary.hasName ? 1 : 0,
			summary.summary === undefined ? null : this.encode(summary.summary),
			summary.summarizedThroughId ?? null,
			this.encode(state),
		);
		return texts;
	}

	private async insertEntries(
		tx: SqliteExecutor,
		sessionId: string,
		entries: readonly SessionEntry[],
		lastSeq: number,
		texts: readonly SessionSummaryText[],
	): Promise<void> {
		for (const [index, entry] of entries.entries()) {
			await tx.run(
				`INSERT INTO ${this.tables.entries} (session_id, seq, entry_id, entry_json) VALUES (?, ?, ?, ?)`,
				sessionId,
				lastSeq + index + 1,
				entry.id,
				this.encode(entry),
			);
		}
		for (const { index, text } of texts) {
			await tx.run(
				`INSERT INTO ${this.tables.searchTexts} (session_id, seq, text_json) VALUES (?, ?, ?)`,
				sessionId,
				lastSeq + index + 1,
				this.encode(text),
			);
		}
	}

	private encode(value: SessionRecordHeader | SessionEntry | SessionSummaryState | string): string {
		try {
			return JSON.stringify(value);
		} catch (cause) {
			throw new StorageUnavailableError(this.descriptor, cause as Error);
		}
	}
}
