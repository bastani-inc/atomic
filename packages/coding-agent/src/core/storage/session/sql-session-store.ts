import type { SessionEntry } from "../../session-manager-types.ts";
import { SqlSnapshotBlobStore, snapshotIndexTables } from "../../worktree-snapshot/blob-store.ts";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteTransactionOptions, SqliteValue } from "../database.js";
import { dialectOf, postgresJsonb, type StorageDialect } from "../dialect.js";
import { SessionBlobError, StorageError, StorageInvalidTextError, StorageSchemaVersionError } from "../errors.js";
import { applyStorageMigrations } from "../migrations.js";
import { renderStorageIdentifiers, storageMigrationTable, validateStoragePrefix } from "../prefix.js";
import { assertStorageSchemaVersion, assertStoredSchemaVersion } from "../schema.js";
import { sha256Hex } from "./blob-hash.js";
import {
	SessionConflictError,
	SessionExistsError,
	SessionIdMismatchError,
	SessionNotFoundError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";
import { announceHistoryLoad, hasHistoryLoadObserver } from "./history-load-observer.ts";
import {
	branchRanges,
	foldSessionResume,
	foreignResumeIds,
	isSessionResumeIndex,
	latestCompactionOf,
	type SessionResumeIndex,
	sessionResumeFrom,
	sessionResumeOf,
	sessionResumePlan,
	sessionTailFrom,
	stateSeqsBefore,
} from "./session-resume.js";
import { SqlSessionSearchIndex, yieldTurn } from "./session-search-index.js";
import {
	applySessionSummaryEntries,
	materializeSessionSummaryMetadata,
	type SessionSummaryState,
	type SessionSummaryText,
} from "./session-summary.js";
import type {
	SessionBlob,
	SessionCompactionPoint,
	SessionCwdMatcher,
	SessionEntriesPage,
	SessionEntriesQuery,
	SessionEntryAt,
	SessionEntryRange,
	SessionListQuery,
	SessionOpenMarker,
	SessionOpenMarkerAge,
	SessionOpenMarkerStore,
	SessionRecordHeader,
	SessionResume,
	SessionSnapshot,
	SessionStore,
	SessionStoredEntry,
	SessionSummary,
	SessionTail,
	SessionWriteOptions,
	SessionWriteResult,
	StorageDescriptor,
} from "./types.js";
import { validateSessionEntries, validateSessionHeader, validateSessionText } from "./validation.js";

/**
 * The newest sessions schema this build reads and writes. Version 2 stores long entries in chunks (#4954), which a build
 * that knows only version 1 would read as stubs. A database stays at version 1, which older builds still open, until
 * this build writes its first chunked entry: that transaction moves the sessions meta to 2, and older builds refuse it
 * when next opened with `StorageSchemaVersionError`. Builds before 2 check only the meta row, on SQLite and Postgres alike.
 */
export const SESSION_SCHEMA_VERSION = 2;
/** The sessions schema of a database without chunked entries, which older builds read too. */
const SESSION_SCHEMA_VERSION_UNCHUNKED = 1;
/** The schema domain of the session tables in the prefix's migration ledger. */
export const SESSION_DOMAIN = "sessions";
/**
 * The most bytes of a chunked session blob one row holds. New blobs use a header row and rows of at most this size,
 * so their bound and returned values stay within it: libSQL servers cap a row and a bound value (sqld's default is
 * 5 MB) and a statement's response (10 MB), and the HTTP protocol carries a blob as base64 in JSON, about 1.4 MB for
 * this size. A different size needs different table names, because a blob's rows are addressed by their index.
 */
export const SESSION_BLOB_CHUNK_BYTES = 1024 * 1024;
/**
 * The most bytes of an entry's JSON one row of the entries table holds. A longer entry is stored as a stub in its
 * entries row, which keeps its `type`, `id` and `parentId` for the snapshot reference index, and its UTF-8 JSON in
 * rows of at most this many bytes in the entry chunks table, written in the entry's transaction (#4954). Like
 * {@link SESSION_BLOB_CHUNK_BYTES} it stays well under the smallest backend limit, sqld's 5,000,000 bytes per value
 * and per row. Snapshot entries are never split: the reference index reads their whole JSON.
 */
export const SESSION_ENTRY_CHUNK_BYTES = 1024 * 1024;
/**
 * The most characters one read of entries or listing rows returns, by the stored text's `length()`. A character is at
 * most four bytes of UTF-8 and a JSON escape at most doubles a character on a server's wire, so a page stays under
 * sqld's 10 MB response limit; a single row longer than this is a page of its own (#4954).
 */
export const SESSION_READ_PAGE_CHARS = 1024 * 1024;
/** Rows per metadata query and minimum elapsed time between durable resume checkpoints. */
export const SESSION_RESUME_REBUILD = { pageEntries: 512, checkpointIntervalMs: 60_000 } as const;
// A prefix has no entries row or blob header and belongs to the session, including on deletion.
// SQLite sweeps unreferenced entry chunks, so use a non-digest blob key. PostgreSQL's cold projection already
// opens entry chunks, not blob chunks: reserve a negative seq, outside every public entry range.
const SQLITE_CHECKPOINT = { column: "hash", value: "'resume-checkpoint'" } as const;
const POSTGRES_CHECKPOINT = { column: "seq", value: "-1" } as const;
const CHECKPOINT_BYTES = 4 * SESSION_BLOB_CHUNK_BYTES;
const CHECKPOINT_TOKEN_BYTES = 32;
/** Bound each write transaction while reusing the bytes already supplied to putBlob. */
const LEGACY_BLOB_BATCH_CHUNKS = 16;
export const SESSION_TABLES = Object.freeze({
	meta: "meta",
	sessions: "sessions",
	entries: "entries",
	searchTexts: "search_texts",
	blobs: "blobs",
	blobChunks: "blob_chunks",
	entryChunks: "entry_chunks",
});

/** The schema domain, in the prefix's migration ledger, of the table of open sessions (#4971). */
export const SESSION_PRESENCE_DOMAIN = "session-presence";
export const SESSION_PRESENCE_TABLES = Object.freeze({ open: "open" });

type Tables = Readonly<Record<keyof typeof SESSION_TABLES, string>>;
type HeaderRow = SqliteRow & { header_json: string; last_seq: number };
type SummaryStateRow = HeaderRow & { summary_state: string };
type ResumeRow = SummaryStateRow & { revision: string };

type ResumeCheckpoint = {
	readonly revision: string;
	readonly index: SessionResumeIndex;
	/** Present on the second pass, after the active branch was determined. */
	readonly topology?: readonly (readonly [number, number])[];
};
type StoredSummaryState = SessionSummaryState & {
	readonly resume?: SessionResumeIndex;
	readonly resumeCheckpoint?: ResumeCheckpoint;
	readonly epoch?: string;
};

interface ResumeSource {
	readonly header: SessionRecordHeader;
	readonly index: SessionResumeIndex;
}

const SEQ_BATCH = 500;

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
type ListingWindowRow = ListingRow & {
	upto: number | bigint | null;
	ord: number | bigint | null;
	key_row: number | bigint | null;
	fetched: number | bigint | null;
	batch_chars: number | bigint | null;
	page_chars: number | bigint | null;
};
/** A row's key and how many characters its stored text holds, for reading rows in pages. */
type SizedRow = SqliteRow & { size: number | bigint | null };
/** Cumulative text (0 when the whole batch fits), batch text, and batch row count including lookahead. */
type FetchRow = {
	fetched: number | bigint;
	batch_chars: number | bigint | null;
	page_chars: number | bigint;
};
type PageRow = FetchRow & { ord: number | bigint };

/**
 * The rows one statement of a paged read fetches, by key after the previous page, before it keeps those that fit in
 * {@link SESSION_READ_PAGE_CHARS}: each statement reads a bounded batch rather than every remaining row, so a long
 * session or listing is read in linear time. A full batch quadruples the next fetch. A clipped batch keeps its fetch
 * size when its unreturned text is at most four pages; otherwise the next fetch is twice the returned rows.
 */
export const SESSION_READ_FETCH = { first: 1024, min: 1, max: 8192 } as const;
const SESSION_READ_INLINE_BYTES = 4096;

function nextFetch(limit: number, rows: readonly FetchRow[]): { readonly more: boolean; readonly limit: number } {
	const kept = rows.length;
	const fetched = Number(rows[0]?.fetched ?? 0);
	const more = kept > 0 && kept < fetched;
	const batchChars = Number(rows[0]?.batch_chars ?? 0);
	const pageChars = Number(rows.at(-1)?.page_chars ?? 0);
	const next =
		kept === Math.min(limit, fetched)
			? limit * 4
			: batchChars - pageChars <= SESSION_READ_PAGE_CHARS * 4
				? limit
				: Math.max(SESSION_READ_FETCH.min, kept * 2);
	return { more, limit: Math.min(SESSION_READ_FETCH.max, next) };
}

/** `rows` split into runs, in order, of at most {@link SESSION_READ_PAGE_CHARS}; a longer row is a run of its own. */
function pagesOf<Row extends { readonly size: number | bigint | null }>(rows: readonly Row[]): Row[][] {
	const pages: Row[][] = [];
	let page: Row[] = [];
	let chars = 0;
	for (const row of rows) {
		const size = Number(row.size ?? 0);
		if (page.length > 0 && chars + size > SESSION_READ_PAGE_CHARS) {
			pages.push(page);
			page = [];
			chars = 0;
		}
		page.push(row);
		chars += size;
	}
	if (page.length > 0) pages.push(page);
	return pages;
}

/** An entry's JSON as its entries row stores it, and the UTF-8 chunks of a long one. */
function storedEntry(entry: SessionEntry, json: string): { readonly json: string; readonly chunks: Uint8Array[] } {
	// Every UTF-16 code unit is at most three bytes of UTF-8, so a short entry needs no encoding to be measured.
	if (json.length * 3 <= SESSION_ENTRY_CHUNK_BYTES || entry.type === "worktree_snapshot") return { json, chunks: [] };
	const bytes = Buffer.from(json, "utf8");
	if (bytes.byteLength <= SESSION_ENTRY_CHUNK_BYTES) return { json, chunks: [] };
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += SESSION_ENTRY_CHUNK_BYTES) {
		chunks.push(bytes.subarray(offset, offset + SESSION_ENTRY_CHUNK_BYTES));
	}
	const stub = { type: entry.type, id: entry.id, parentId: entry.parentId ?? null };
	return { json: JSON.stringify(stub), chunks };
}

/** Each committed batch is its own durable checkpoint; the legacy bytes stay readable until publication. */
async function migrateLegacyBlobBatch(
	tx: SqliteExecutor,
	tables: Tables,
	sessionId: string,
	hash: string,
	data: Uint8Array,
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
	for (let index = next; index < end; index++) {
		await tx.run(
			`INSERT INTO ${tables.blobChunks} (session_id, hash, idx, data) VALUES (?, ?, ?, ?)`,
			...params,
			index,
			data.subarray(index * SESSION_BLOB_CHUNK_BYTES, (index + 1) * SESSION_BLOB_CHUNK_BYTES),
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
const LISTING_SELECT_COLUMNS = LISTING_COLUMNS.split(", ")
	.map((column) => `s.${column}`)
	.join(", ");
/** The characters a listing row holds, its search text aside, for reading listings in pages (#4954). */
const LISTING_SIZE =
	"length(id) + length(cwd) + length(header_json) + length(modified_at) + length(first_message) + COALESCE(length(name), 0) + COALESCE(length(summary), 0) + COALESCE(length(summarized_through_id), 0) + length(revision) + 256";
/** Rows whose search text is read per query; well under SQLite's bound-parameter limit. */
export const LISTING_FETCH_BATCH = 500;
/** Sessions one statement of a paced listing's project scan reads over a database server. */
const LISTING_CWD_PAGE = 2_000;
/**
 * Sessions one statement of a paced listing scans over this process's own SQLite connection, with a turn of the event
 * loop after each (#5480). Such a statement runs on the event loop and reads every row it scans; on a large store whose
 * pages are not cached a row can cost a disk read, so a few thousand rows per statement held the event loop for
 * seconds. A database server's statements do not hold the event loop, so listings over one keep larger statements.
 */
const LISTING_SCAN_ROWS = 256;
/** Stored project spellings a paced listing resolves at once; each is a chain of file system calls. */
const LISTING_CWD_MATCHES = 64;
const STUB_ENTRY: SessionEntry = {
	type: "custom",
	id: "",
	parentId: null,
	timestamp: "1970-01-01T00:00:00.000Z",
	customType: "",
};

/** Listing scopes (visibility and project) kept at once; the picker uses two. */
const LISTING_SCOPES = 8;
/**
 * Session reads and writes use nothing but their transaction, so one that a transient failure of a database server
 * ended before it committed runs again (#4383); `append` and `replace` check `expectSeq` again on each run.
 */
const SESSION_TRANSACTION: SqliteTransactionOptions = { retryTransientFailures: true };

/** A write revision: 32 random hex digits, the form SQLite's `lower(hex(randomblob(16)))` gave earlier builds. */
function newRevision(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

interface EntryLayout {
	readonly byteLength: (expression: string) => string;
	readonly chunkRowids: boolean;
}

async function entryLayoutOf(database: SqliteDatabase, chunks: string): Promise<EntryLayout> {
	const dialect = dialectOf(database);
	if (dialect.name === "sqlite") {
		try {
			const row = await database.get(
				`SELECT octet_length('') AS bytes, wr FROM pragma_table_list(?) WHERE schema = 'main'`,
				chunks,
			);
			return { byteLength: (expression) => `octet_length(${expression})`, chunkRowids: row?.wr === 0 };
		} catch {
			/* Older SQLite engines have no octet_length. */
		}
	}
	return { byteLength: dialect.textByteLength, chunkRowids: false };
}

export class SqlSessionStore implements SessionStore {
	private readonly database: SqliteDatabase;
	private readonly dialect: StorageDialect;
	private readonly tables: Tables;
	private readonly prefix: string;
	private readonly legacyBlobData: boolean;
	private closed = false;
	private readonly cwdMatcher?: SessionCwdMatcher;
	readonly snapshotBlobs: SqlSnapshotBlobStore;
	/** The blob table of this store's database, which appends check snapshot records against (#5077). */
	private readonly blobTable: SqlSnapshotBlobStore;
	/** Set by `open`, once the store exists (#4971). */
	openMarkers!: SqlSessionOpenMarkers;
	readonly searchIndex?: SqlSessionSearchIndex;
	private readonly entryLayout: EntryLayout;
	/** Session ids of each recently listed scope, valid while the store's change token is unchanged. */
	private readonly scopes = new Map<string, { readonly token: string | undefined; readonly ids: readonly string[] }>();
	/** Listed summaries of sessions that still exist at the cached version; never more than the store holds. */
	private readonly summaries = new Map<string, { readonly version: string; readonly summary: SessionSummary }>();
	/**
	 * Settles when the latest listing has read and updated the caches. Listings take turns, so one listing's
	 * pruning never drops summaries that another has fetched but not yet recorded under its scope.
	 */
	private listing: Promise<void> = Promise.resolve();

	private readonly resumeIndexes = new Map<
		string,
		{ readonly revision: string; readonly index: SessionResumeIndex }
	>();

	private constructor(
		database: SqliteDatabase,
		tables: Tables,
		prefix: string | undefined,
		cwdMatcher: SessionCwdMatcher | undefined,
		snapshotBlobs: SqlSnapshotBlobStore,
		legacyBlobData: boolean,
		searchIndex: SqlSessionSearchIndex | undefined,
		entryLayout: EntryLayout,
	) {
		this.database = database;
		this.dialect = dialectOf(database);
		this.entryLayout = entryLayout;
		this.tables = tables;
		this.prefix = prefix ?? "";
		this.cwdMatcher = cwdMatcher;
		this.snapshotBlobs = snapshotBlobs;
		this.blobTable = snapshotBlobs;
		this.legacyBlobData = legacyBlobData;
		if (searchIndex !== undefined) this.searchIndex = searchIndex;
	}

	static async open(
		database: SqliteDatabase,
		options: { readonly prefix?: string; readonly cwdMatcher?: SessionCwdMatcher } = {},
	): Promise<SqlSessionStore> {
		validateStoragePrefix(options.prefix, dialectOf(database).name);
		const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, options.prefix);
		let legacyBlobData = false;
		const createTables = async (tx: SqliteExecutor, dialect: StorageDialect) => {
			const { int, text, blob } = dialect.types;
			const strict = dialect.tableOptions;
			const json = (column: string) => dialect.jsonValid(column);
			const columnExists = async (table: string, column: string) => {
				const probe = dialect.columnExists(table, column);
				return (await tx.get(probe.sql, ...probe.params)) !== undefined;
			};
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${tables.meta} (schema_version ${int} NOT NULL)${strict}`);
			const versions = await tx.all(`SELECT schema_version FROM ${tables.meta}`);
			if (versions.length === 0) {
				await tx.run(`INSERT INTO ${tables.meta} VALUES (?)`, SESSION_SCHEMA_VERSION_UNCHUNKED);
			}
			for (const version of versions) {
				assertStorageSchemaVersion(
					"sessions",
					version.schema_version!,
					SESSION_SCHEMA_VERSION,
					SESSION_SCHEMA_VERSION_UNCHUNKED,
				);
			}
			// The sessions table is ordered by insertion to notice changes, and entries for the snapshot reference index.
			await tx.exec(`
				CREATE TABLE IF NOT EXISTS ${tables.sessions} (
					id ${text} PRIMARY KEY, cwd ${text} NOT NULL, created_at ${text} NOT NULL,
					header_json ${text} NOT NULL CHECK(${json("header_json")}), internal ${int} NOT NULL,
					last_seq ${int} NOT NULL, modified_at ${text} NOT NULL, message_count ${int} NOT NULL,
					first_message ${text} NOT NULL CHECK(${json("first_message")}),
					name ${text} CHECK(name IS NULL OR ${json("name")}), has_name ${int} NOT NULL,
					summary ${text} CHECK(summary IS NULL OR ${json("summary")}), summarized_through_id ${text},
					summary_state ${text} NOT NULL CHECK(${json("summary_state")}), revision ${text} NOT NULL DEFAULT ''${dialect.rowOrderColumn}
				)${strict};
				CREATE TABLE IF NOT EXISTS ${tables.entries} (
					session_id ${text} NOT NULL, seq ${int} NOT NULL, entry_id ${text} NOT NULL,
					entry_json ${text} NOT NULL CHECK(${json("entry_json")}), PRIMARY KEY(session_id, seq)${dialect.rowOrderColumn}
				)${strict};
				CREATE TABLE IF NOT EXISTS ${tables.searchTexts} (
					session_id ${text} NOT NULL, seq ${int} NOT NULL,
					text_json ${text} NOT NULL CHECK(${json("text_json")}), PRIMARY KEY(session_id, seq)
				)${strict};
				CREATE TABLE IF NOT EXISTS ${tables.blobs} (
					session_id ${text} NOT NULL, hash ${text} NOT NULL, bytes ${int} NOT NULL, chunks ${int} NOT NULL,
					PRIMARY KEY(session_id, hash)
				)${strict};
				CREATE TABLE IF NOT EXISTS ${tables.blobChunks} (
					session_id ${text} NOT NULL, hash ${text} NOT NULL, idx ${int} NOT NULL, data ${blob} NOT NULL,
					PRIMARY KEY(session_id, hash, idx)
				)${strict};
			`);
			// Sessions tables created before the write revision gain it; their rows pick one up on the next write.
			if (!(await columnExists(tables.sessions, "revision"))) {
				await tx.exec(`ALTER TABLE ${tables.sessions} ADD COLUMN revision ${text} NOT NULL DEFAULT ''`);
			}
			legacyBlobData = await columnExists(tables.blobs, "data");
			if (legacyBlobData && !(await columnExists(tables.blobs, "chunks"))) {
				await tx.exec(`ALTER TABLE ${tables.blobs} ADD COLUMN chunks ${int} NOT NULL DEFAULT -1`);
			}
		};
		const orphanedEntryKeys = `SELECT k.session_id, k.seq
			FROM (SELECT DISTINCT session_id, seq FROM ${tables.entryChunks}) AS k
			WHERE NOT EXISTS (
				SELECT 1 FROM ${tables.entries} AS e
				WHERE e.session_id = k.session_id AND e.seq = k.seq AND e.chunks > 0
			)`;
		const removeOrphanedEntryChunks = async (tx: SqliteExecutor): Promise<void> => {
			await tx.run(`DELETE FROM ${tables.entryChunks} WHERE (session_id, seq) IN (${orphanedEntryKeys})`);
		};
		/**
		 * Long entries in chunks (#4954): the entry chunks table and the entries table's `chunks` column, 0 for an entry
		 * stored whole, as every entry written before it was. Older builds read and write these tables unchanged, so the
		 * sessions meta stays where it is until the first chunked entry (`insertEntries`). Setup is idempotent and runs
		 * when the open finds the schema not current (`currentSchema`).
		 */
		const addEntryChunks = async (tx: SqliteExecutor, dialect: StorageDialect) => {
			const { int, text, blob } = dialect.types;
			await tx.exec(`
				CREATE TABLE IF NOT EXISTS ${tables.entryChunks} (
					session_id ${text} NOT NULL, seq ${int} NOT NULL, idx ${int} NOT NULL, data ${blob} NOT NULL,
					PRIMARY KEY(session_id, seq, idx)
				)${dialect.tableOptions};
			`);
			const probe = dialect.columnExists(tables.entries, "chunks");
			if ((await tx.get(probe.sql, ...probe.params)) === undefined) {
				await tx.exec(`ALTER TABLE ${tables.entries} ADD COLUMN chunks ${int} NOT NULL DEFAULT 0`);
			}
			if (database.readOnly !== true) await removeOrphanedEntryChunks(tx);
		};
		const presence = renderStorageIdentifiers("sessions", SESSION_PRESENCE_TABLES, options.prefix);
		// A SQLite schema records no ledger, so its idempotent setup would run, under the write lock, at every open. A
		// schema that is current skips it: on a server many processes share, each open otherwise held the write lock for a
		// dozen round trips while every other writer waited (#4768). Such an open writes only when it finds entry chunks
		// an older process left behind, which it removes in one transaction that checks the schema version first (#5065).
		// The removal is housekeeping, since no read reaches those rows and a chunked write first deletes its key's rows,
		// so a connection that refuses writes still opens; a newer schema is still refused.
		const current = await SqlSessionStore.currentSchema(database, tables, presence.open);
		if (current !== undefined) {
			legacyBlobData = current.legacyBlobData;
			if (
				database.readOnly !== true &&
				(await database.get(`SELECT 1 FROM (${orphanedEntryKeys}) AS orphaned LIMIT 1`)) !== undefined
			)
				await database
					.transaction(async (tx) => {
						await assertStoredSchemaVersion(
							tx,
							{ sql: `SELECT schema_version FROM ${tables.meta}` },
							"sessions",
							SESSION_SCHEMA_VERSION,
							"schema_version",
							SESSION_SCHEMA_VERSION_UNCHUNKED,
						);
						await removeOrphanedEntryChunks(tx);
					})
					.catch((error: Error) => {
						if (error instanceof StorageSchemaVersionError) throw error;
					});
		} else {
			await applyStorageMigrations(
				database,
				SESSION_DOMAIN,
				[
					{ version: 1, up: createTables },
					{ version: 2, up: addEntryChunks },
				],
				{ table: storageMigrationTable(options.prefix) },
			);
			// A domain of its own, so Atomic versions that do not know it keep opening the sessions tables (#4971). Its
			// later steps must stay additive: a build that knows fewer of them accepts a newer version and keeps marking
			// (#5065).
			await applyStorageMigrations(
				database,
				SESSION_PRESENCE_DOMAIN,
				[
					{ version: 1, up: (tx, dialect) => SqlSessionOpenMarkers.createTable(tx, dialect, presence.open) },
					{ version: 2, up: (tx, dialect) => SqlSessionOpenMarkers.addSchemaVersion(tx, dialect, presence.open) },
				],
				{ table: storageMigrationTable(options.prefix), acceptNewer: true },
			);
		}
		const blobs = await SqlSnapshotBlobStore.open(database, options.prefix);
		const searchIndex = await SqlSessionSearchIndex.open(database, tables, options.prefix);
		const store = new SqlSessionStore(
			database,
			tables,
			options.prefix,
			options.cwdMatcher,
			blobs,
			legacyBlobData,
			searchIndex,
			await entryLayoutOf(database, tables.entryChunks),
		);
		store.openMarkers = new SqlSessionOpenMarkers(database, presence.open, () => store.assertOpen());
		return store;
	}

	/**
	 * What the open's setup would find, read without the write lock, when its schema steps would change nothing: every
	 * table and column of both domains exists and the sessions meta holds only versions this build supports. Undefined
	 * otherwise, and always on a database with versioned migrations, whose ledger the setup checks. Leftover entry
	 * chunks are not part of the schema: the open removes them separately.
	 */
	private static async currentSchema(
		database: SqliteDatabase,
		tables: Tables,
		open: string,
	): Promise<{ readonly legacyBlobData: boolean } | undefined> {
		const dialect = dialectOf(database);
		if (dialect.versionedMigrations) return undefined;
		const probes = [
			...[...Object.values(tables), open].map((table) => dialect.tableExists(table)),
			dialect.columnExists(tables.sessions, "revision"),
			dialect.columnExists(tables.entries, "chunks"),
			dialect.columnExists(tables.blobs, "chunks"),
			dialect.columnExists(open, "schema_version"),
		];
		const found = await Promise.all(probes.map((probe) => database.get(probe.sql, ...probe.params)));
		if (!found.every((row) => row !== undefined)) return undefined;
		const versions = await database.all(`SELECT schema_version FROM ${tables.meta}`);
		if (
			versions.length === 0 ||
			versions.some(
				(row) =>
					row.schema_version !== SESSION_SCHEMA_VERSION_UNCHUNKED && row.schema_version !== SESSION_SCHEMA_VERSION,
			)
		)
			return undefined;
		const legacy = dialect.columnExists(tables.blobs, "data");
		return { legacyBlobData: (await database.get(legacy.sql, ...legacy.params)) !== undefined };
	}

	/**
	 * A transaction that first checks the sessions schema version again: a newer build may have upgraded the database
	 * since this store opened it, and what it writes then is not this build's to read or write (#5065).
	 */
	private transaction<T>(body: (tx: SqliteExecutor) => Promise<T>, options: SqliteTransactionOptions): Promise<T> {
		return this.database.transaction(async (tx) => {
			await this.assertReadableSchema(tx);
			return body(tx);
		}, options);
	}

	private assertReadableSchema(executor: SqliteExecutor): Promise<void> {
		return assertStoredSchemaVersion(
			executor,
			{ sql: `SELECT schema_version FROM ${this.tables.meta}` },
			"sessions",
			SESSION_SCHEMA_VERSION,
			"schema_version",
			SESSION_SCHEMA_VERSION_UNCHUNKED,
		);
	}

	get descriptor(): StorageDescriptor {
		return { ...this.database.descriptor, ...(this.prefix === "" ? {} : { prefix: this.prefix }) };
	}

	async create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<SessionWriteResult> {
		this.assertOpen();
		validateSessionHeader(header);
		validateSessionEntries(entries);
		return this.transaction(async (tx) => {
			if (await tx.get(`SELECT id FROM ${this.tables.sessions} WHERE id = ?`, header.id)) {
				throw new SessionExistsError(header.id);
			}
			const { texts, epoch } = await this.saveSummary(tx, header.id, { header, entries, lastSeq: entries.length });
			await this.insertEntries(tx, header.id, entries, 0, texts);
			return { lastSeq: entries.length, epoch };
		}, SESSION_TRANSACTION);
	}

	async append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		return this.transaction(async (tx) => {
			const { row: previous, state: summaryState } = await this.forWrite(tx, sessionId, options, true);
			validateSessionEntries(entries);
			// A new snapshot record is written only while every blob it references is still stored (#5077).
			await this.blobTable.assertStored(
				tx,
				entries.flatMap((entry) =>
					entry.type === "worktree_snapshot" && entry.snapshot !== undefined ? [entry.snapshot] : [],
				),
			);
			const lastSeq = previous.last_seq + entries.length;
			const { texts } = await this.saveSummary(
				tx,
				sessionId,
				{ header: JSON.parse(previous.header_json) as SessionRecordHeader, entries, lastSeq },
				summaryState,
				await this.appendedResume(tx, sessionId, summaryState.resume, previous.last_seq, entries),
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
	): Promise<SessionWriteResult> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		return this.transaction(async (tx) => {
			await this.forWrite(tx, sessionId, options);
			validateSessionHeader(header);
			validateSessionEntries(entries);
			if (header.id !== sessionId) throw new SessionIdMismatchError(sessionId, header.id);
			await this.searchIndex?.forgetWithin(tx, sessionId);
			await tx.run(`DELETE FROM ${this.tables.searchTexts} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.entryChunks} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.entries} WHERE session_id = ?`, sessionId);
			const { texts, epoch } = await this.saveSummary(tx, sessionId, { header, entries, lastSeq: entries.length });
			await this.insertEntries(tx, sessionId, entries, 0, texts);
			return { lastSeq: entries.length, epoch };
		}, SESSION_TRANSACTION);
	}

	async load(sessionId: string): Promise<SessionSnapshot> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		if (hasHistoryLoadObserver()) {
			const row = await this.database.get<{ last_seq: number }>(
				`SELECT last_seq FROM ${this.tables.sessions} WHERE id = ?`,
				sessionId,
			);
			if (row) announceHistoryLoad(row.last_seq);
		}
		return this.transaction((tx) => this.read(tx, sessionId), SESSION_TRANSACTION);
	}

	async readEntryRange(sessionId: string, query: SessionEntriesQuery): Promise<SessionEntriesPage> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		query.signal?.throwIfAborted();
		const session = await this.database.get<SqliteRow & { last_seq: number | bigint }>(
			`SELECT last_seq FROM ${this.tables.sessions} WHERE id = ?`,
			sessionId,
		);
		if (!session) throw new SessionNotFoundError(sessionId);
		const lastSeq = Number(session.last_seq);
		const fromSeq = Math.max(1, query.fromSeq);
		const toSeq = Math.min(query.toSeq, lastSeq);
		if (fromSeq > toSeq) return { lastSeq, entries: [], throughSeq: Math.max(toSeq, fromSeq - 1) };
		if (query.maxChars !== undefined && query.maxChars <= 0) return { lastSeq, entries: [], throughSeq: fromSeq - 1 };
		const skippedSet = query.skipTypes === undefined ? undefined : new Set(query.skipTypes);
		const skippedPrefixes = (query.skipTypes ?? []).map((type) => `{"type":${JSON.stringify(type)},`);
		const largeBytes = query.largeEntryBytes ?? 0x7fffffff;
		const rows = await this.database.all<
			SqliteRow & {
				seq: number | bigint;
				entry_json: string | null;
				entry_head: string;
				chunks: number | bigint;
				remaining: number | bigint;
				entry_type: string | null;
			}
		>(
			`WITH sized AS (
				SELECT seq, chunks, ${this.entryLayout.byteLength("entry_json")} AS raw_bytes,
					${this.entryLayout.byteLength("entry_json")} + chunks * ? AS bytes
				FROM ${this.tables.entries}
				WHERE session_id = ? AND seq >= ? AND seq <= ?
			),
			paged AS (
				SELECT seq, chunks, raw_bytes, count(*) OVER () AS remaining,
					sum(bytes) OVER (ORDER BY seq) - bytes AS before_chars
				FROM sized
			)
			SELECT p.seq, CASE WHEN p.chunks = 0 AND p.raw_bytes <= ? THEN e.entry_json END AS entry_json,
				substr(e.entry_json, 1, 64) AS entry_head, p.chunks, p.remaining,
				CASE WHEN p.chunks = 0 AND p.raw_bytes > ? AND substr(e.entry_json, 1, 8) <> '{"type":'
					THEN ${this.dialect.jsonText("e.entry_json", "type")} END AS entry_type
			FROM paged p
			JOIN ${this.tables.entries} e ON e.session_id = ? AND e.seq = p.seq
			WHERE p.before_chars < ?
			ORDER BY p.seq`,
			SESSION_ENTRY_CHUNK_BYTES,
			sessionId,
			fromSeq,
			toSeq,
			largeBytes,
			largeBytes,
			sessionId,
			query.maxChars ?? Number.MAX_SAFE_INTEGER,
		);
		const entries: SessionEntryAt[] = [];
		for (const row of rows) {
			query.signal?.throwIfAborted();
			if (skippedPrefixes.some((prefix) => row.entry_head.startsWith(prefix))) {
				continue;
			}
			const seq = Number(row.seq);
			const chunks = Number(row.chunks);
			if (chunks > 0) {
				const rawChunks = await this.readRawEntryChunks(this.database, sessionId, seq, chunks, query.signal);
				const bytes = rawChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
				if (bytes > largeBytes) entries.push({ seq, entry: STUB_ENTRY, rawChunks });
				else {
					const parsed = JSON.parse(Buffer.concat(rawChunks).toString("utf8")) as SessionEntry;
					if (!skippedSet?.has(parsed.type)) entries.push({ seq, entry: parsed });
				}
			} else if (row.entry_json === null) {
				if (row.entry_type !== null && skippedSet?.has(row.entry_type)) continue;
				const rawChunks = await this.readInlineEntryBytes(sessionId, seq);
				entries.push({ seq, entry: STUB_ENTRY, rawChunks });
			} else {
				const parsed = JSON.parse(row.entry_json) as SessionEntry;
				if (!skippedSet?.has(parsed.type)) entries.push({ seq, entry: parsed });
			}
		}
		const last = rows.at(-1);
		const throughSeq = last !== undefined && rows.length < Number(last.remaining) ? Number(last.seq) : toSeq;
		return { lastSeq, entries, throughSeq };
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
		await this.transaction(async (tx) => {
			await this.searchIndex?.forgetWithin(tx, sessionId);
			await tx.run(`DELETE FROM ${this.tables.blobChunks} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.blobs} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.searchTexts} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.entryChunks} WHERE session_id = ?`, sessionId);
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
					await this.database.transaction((tx) =>
						migrateLegacyBlobBatch(tx, this.tables, sessionId, blob.hash, stored),
					)
				) {
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
				}
			}
			return blob;
		}
		const chunks = Math.ceil(blob.bytes / SESSION_BLOB_CHUNK_BYTES);
		const { sessions, blobs, blobChunks } = this.tables;
		const sessionExists = `EXISTS (SELECT 1 FROM ${sessions} WHERE id = ?)`;
		// The data column exists only in SQLite tables written before chunked blobs; X'' is SQLite's empty BLOB.
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
	 * Reads chunked blobs a row at a time, each returning at most {@link SESSION_BLOB_CHUNK_BYTES}. Legacy blobs
	 * are read in one query: slicing their data column repeatedly would reread the entire BLOB for every chunk.
	 * Rows never change once written. A session deleted meanwhile holds nothing; missing bytes are `blob-incomplete`.
	 */
	async getBlob(sessionId: string, hash: string): Promise<Uint8Array | undefined> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		let header = await this.blobHeader(sessionId, hash);
		if (header === undefined) return undefined;
		if (header.chunks === -1) {
			const row = await this.database.get<SqliteRow & { data: Uint8Array }>(
				`SELECT data FROM ${this.tables.blobs} WHERE session_id = ? AND hash = ? AND chunks = -1`,
				sessionId,
				hash,
			);
			if (row) {
				if (row.data.byteLength === header.bytes) return row.data;
				throw new SessionBlobError("blob-incomplete", { sessionId, hash, bytes: header.bytes });
			}
			// A writer may have published the chunked layout between the header and data reads.
			header = await this.blobHeader(sessionId, hash);
			if (header === undefined) return undefined;
		}
		const data = new Uint8Array(header.bytes);
		let offset = 0;
		for (let index = 0; index < header.chunks; index++) {
			const row = await this.database.get<SqliteRow & { data: Uint8Array | null }>(
				`SELECT data FROM ${this.tables.blobChunks} WHERE idx = ? AND session_id = ? AND hash = ?`,
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
		if (query.withoutSearchText) {
			for await (const summary of this.listWithoutSearchText(query)) {
				this.assertListing(query);
				yield summary;
			}
			this.assertListing(query);
			return;
		}
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
		// A newer build may have upgraded the schema since this store opened it (#5065).
		await this.assertReadableSchema(this.database);
		// Read the token first: a commit racing the reads below moves it again before the next call.
		const token = await this.changeToken();
		const key = JSON.stringify([
			query.includeInternal === true,
			query.cwd ?? null,
			query.idPrefix?.toLowerCase() ?? null,
		]);
		const cached = this.scopes.get(key);
		// A cached id without a summary is never expected; re-reading the scope repairs it instead of dropping it.
		const scope =
			token !== undefined && cached?.token === token && cached.ids.every((id) => this.summaries.has(id))
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
	 * together they cover writers in every process, but only on one connection: Atomic's own SQLite adapter serves
	 * every statement from one. Over an adapter that may not, such as a libSQL server whose every HTTP request is a
	 * new stream, neither moves, and no column of the sessions table changes on every write by every version, so
	 * there is no token and each listing revalidates its scope (#4805).
	 */
	private async changeToken(): Promise<string | undefined> {
		if (this.database.descriptor.adapter !== "node-sqlite") return undefined;
		const { changeMarkers, rowOrder } = this.dialect;
		const row = await this.database.get<SqliteRow>(
			`SELECT ${changeMarkers.columns},
				(SELECT count(*) FROM ${this.tables.sessions}) AS sessions,
				(SELECT max(${rowOrder()}) FROM ${this.tables.sessions}) AS last_row
			${changeMarkers.from}`,
		);
		return JSON.stringify(Object.values(row ?? {}).map(String));
	}

	private async *listWithoutSearchText(query: SessionListQuery): AsyncIterable<SessionSummary> {
		await this.assertReadableSchema(this.database);
		const scope = await this.scopeOf(query, true);
		if (scope === undefined) return;
		const order = this.dialect.rowOrder();
		const bound = await this.database.get<SqliteRow & { upper: number | bigint | null }>(
			`SELECT max(${order}) AS upper FROM ${this.tables.sessions}`,
		);
		const upper = Number(bound?.upper ?? 0);
		const seen = new Set<string>();
		const scanRows = this.listingScanRows(SESSION_READ_FETCH.max);
		for (let after = 0, limit: number = Math.min(scanRows, SESSION_READ_FETCH.first); after < upper; ) {
			this.assertListing(query);
			const rows = await this.database.all<ListingWindowRow>(
				// The scan sizes each session in scope and nothing else. Numbering its rows in the same SELECT would make
				// SQLite copy every column the size reads, of every scanned session, before the scope is checked (#5480).
				`WITH scanned AS MATERIALIZED (
					SELECT ${order} AS ord, CASE WHEN ${scope.where} THEN ${LISTING_SIZE} END AS size
					FROM ${this.tables.sessions} WHERE ${order} > ? AND ${order} <= ?
					ORDER BY ${order} LIMIT ?
				), keyed AS MATERIALIZED (
					SELECT ord, row_number() OVER (ORDER BY ord) AS key_row, size FROM scanned
				), bound AS (SELECT max(ord) AS upto FROM keyed),
				page AS (
					SELECT ord, key_row, count(*) OVER () AS fetched,
						row_number() OVER (ORDER BY ord) AS page_row,
						sum(size) OVER () AS batch_chars,
						sum(size) OVER (ORDER BY ord) AS page_chars
					FROM keyed WHERE size IS NOT NULL
				), kept AS MATERIALIZED (
					SELECT ord, key_row, fetched, batch_chars, page_chars FROM page
					WHERE page_chars <= ? OR page_row = 1
				)
				SELECT bound.upto, kept.ord, kept.key_row, kept.fetched, kept.batch_chars, kept.page_chars,
					${LISTING_SELECT_COLUMNS}
				FROM bound
				LEFT JOIN kept ON 1 = 1
				LEFT JOIN ${this.tables.sessions} AS s ON ${this.dialect.rowOrder("s")} = kept.ord
				ORDER BY kept.ord`,
				...scope.params,
				after,
				upper,
				limit,
				SESSION_READ_PAGE_CHARS,
			);
			const upto = rows[0]?.upto;
			if (upto === null || upto === undefined) break;
			const listed = rows.filter((row) => row.ord !== null);
			for (const row of listed) {
				if (!seen.has(row.id) && (await scope.inScope(row))) {
					seen.add(row.id);
					yield summaryFromRow({ ...row, search_texts_json: "[]" });
				}
			}
			const last = listed.at(-1);
			const clipped = last !== undefined && listed.length < Number(last.fetched);
			after = clipped ? Number(last.ord) : Number(upto);
			const batchChars = Number(listed[0]?.batch_chars ?? 0);
			const pageChars = Number(last?.page_chars ?? 0);
			const next = !clipped
				? limit * 4
				: batchChars - pageChars <= SESSION_READ_PAGE_CHARS * 4
					? limit
					: Math.max(SESSION_READ_FETCH.min, Number(last.key_row) * 2);
			limit = Math.min(scanRows, next);
			await yieldTurn();
		}
		this.assertListing(query);
	}

	private async distinctCwds(paced: boolean, query: SessionListQuery): Promise<string[]> {
		if (!paced)
			return (
				await this.database.all<SqliteRow & { cwd: string }>(`SELECT DISTINCT cwd FROM ${this.tables.sessions}`)
			).map((project) => project.cwd);
		const order = this.dialect.rowOrder();
		const page = this.listingScanRows(LISTING_CWD_PAGE);
		const cwds = new Set<string>();
		for (let after = 0; ; ) {
			this.assertListing(query);
			const rows = await this.database.all<SqliteRow & { ord: number | bigint; cwd: string }>(
				`SELECT ${order} AS ord, cwd FROM ${this.tables.sessions} WHERE ${order} > ? ORDER BY ${order} LIMIT ?`,
				after,
				page,
			);
			for (const row of rows) cwds.add(row.cwd);
			await yieldTurn();
			if (rows.length < page) return [...cwds];
			after = Number(rows.at(-1)!.ord);
		}
	}

	/** The most sessions one statement of a paced listing scans: fewer when the statement holds the event loop. */
	private listingScanRows(overServer: number): number {
		return this.database.descriptor.adapter === "node-sqlite" ? LISTING_SCAN_ROWS : overServer;
	}

	private async scopeOf(
		query: SessionListQuery,
		paced: boolean,
	): Promise<
		| {
				readonly where: string;
				readonly params: SqliteValue[];
				readonly inScope: (row: ListingRow) => Promise<boolean> | boolean;
		  }
		| undefined
	> {
		const matchesCwd =
			query.cwd === undefined
				? undefined
				: (this.cwdMatcher?.(query.cwd) ?? ((candidate: string | undefined) => candidate === query.cwd));
		let projectCwds: string[] | undefined;
		if (matchesCwd) {
			const distinct = await this.distinctCwds(paced, query);
			// A paced listing resolves a few spellings at a time, with a turn of the event loop between them: resolving
			// each of a store's thousands of projects at once filled turns with their file system callbacks (#5480).
			const slice = paced ? LISTING_CWD_MATCHES : Math.max(1, distinct.length);
			projectCwds = [];
			for (let start = 0; start < distinct.length; start += slice) {
				const matched = await Promise.all(
					distinct.slice(start, start + slice).map(async (cwd) => ((await matchesCwd(cwd)) ? cwd : undefined)),
				);
				for (const cwd of matched) if (cwd !== undefined) projectCwds.push(cwd);
				if (paced && start + slice < distinct.length) {
					this.assertListing(query);
					await yieldTurn();
				}
			}
			this.assertListing(query);
			if (projectCwds.length === 0) return undefined;
		}
		const idPrefix = query.idPrefix?.toLowerCase();
		return {
			where: `(? = 1 OR internal = 0)${projectCwds ? ` AND cwd IN (${projectCwds.map(() => "?").join(", ")})` : ""}${idPrefix === undefined ? "" : " AND substr(lower(id), 1, ?) = ?"}`,
			params: [
				query.includeInternal ? 1 : 0,
				...(projectCwds ?? []),
				...(idPrefix === undefined ? [] : [idPrefix.length, idPrefix]),
			],
			inScope: (row: ListingRow) => !matchesCwd || matchesCwd(row.cwd),
		};
	}

	/** The scope's session ids in store order, with a current summary cached for each. */
	private async readScope(query: SessionListQuery, listedBefore: boolean): Promise<readonly string[]> {
		const resolved = await this.scopeOf(query, false);
		if (resolved === undefined) return [];
		const { where: scope, params, inScope } = resolved;
		const filterInScope = async (rows: readonly ListingRow[]): Promise<ListingRow[]> => {
			const kept = await Promise.all(rows.map(async (row) => ((await inScope(row)) ? row : undefined)));
			return kept.filter((row): row is ListingRow => row !== undefined);
		};
		if (listedBefore) {
			const rows = await filterInScope(await this.readListingRows(scope, params));
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
		const rows = await filterInScope(await this.readSummaries(scope, params));
		this.assertListing(query);
		return rows.map((row) => row.id);
	}

	/**
	 * The listing rows `where` selects, without search text, in store order, a page per statement: each fetches the next
	 * {@link SESSION_READ_FETCH} rows by key and returns those whose cumulative text fits in
	 * {@link SESSION_READ_PAGE_CHARS}, the first always, so that no response passes a libSQL server's limit however many
	 * sessions there are (#4954) and no statement reads more than its batch.
	 */
	private async readListingRows(where: string, params: readonly SqliteValue[]): Promise<ListingRow[]> {
		const order = this.dialect.rowOrder();
		const rows: ListingRow[] = [];
		for (let after = 0, limit: number = SESSION_READ_FETCH.first; ; ) {
			const page = await this.database.all<ListingRow & PageRow>(
				`WITH sized AS MATERIALIZED (
					SELECT ${LISTING_COLUMNS}, ${order} AS ord, ${LISTING_SIZE} AS size
					FROM ${this.tables.sessions} WHERE (${where}) AND ${order} > ? ORDER BY ord LIMIT ?
				) SELECT ${LISTING_COLUMNS}, ord, fetched, batch_chars, page_chars FROM (
					SELECT ${LISTING_COLUMNS}, ord, count(*) OVER () AS fetched,
						row_number() OVER (ORDER BY ord) AS page_row,
						sum(size) OVER () AS batch_chars,
						sum(size) OVER (ORDER BY ord) AS page_chars
					FROM sized
				) AS page WHERE (page_chars <= ? OR page_row = 1) AND page_row <= ? ORDER BY ord`,
				...params,
				after,
				limit + 1,
				SESSION_READ_PAGE_CHARS,
				limit,
			);
			rows.push(...page);
			const next = nextFetch(limit, page);
			if (!next.more) return rows;
			after = Number(page.at(-1)!.ord);
			limit = next.limit;
		}
	}

	/**
	 * Reads full listing rows, search text included, and caches their summaries, a page per statement as
	 * {@link readListingRows} reads, search text counted. A session whose search text alone is longer than a page has
	 * it read in pages of its own and joined here rather than by the database, whose string limit it may pass (#4954).
	 */
	private async readSummaries(where: string, params: readonly SqliteValue[]): Promise<readonly SummaryRow[]> {
		const order = this.dialect.rowOrder();
		const rows: SummaryRow[] = [];
		for (let after = 0, limit: number = SESSION_READ_FETCH.first; ; ) {
			// Combine encoded strings only at read time, preserving NUL and lone surrogates verbatim.
			const page = await this.database.all<SummaryRow & PageRow & { search_texts_json: string | null }>(
				`WITH keyed AS MATERIALIZED (
					SELECT ${LISTING_COLUMNS}, ${order} AS ord, ${LISTING_SIZE} AS size
					FROM ${this.tables.sessions} AS s WHERE (${where}) AND ${order} > ? ORDER BY ord LIMIT ?
				), sized AS MATERIALIZED (
					SELECT ${LISTING_COLUMNS}, ord, size,
						(SELECT COALESCE(sum(length(text_json) + 1) + 1, 2) FROM ${this.tables.searchTexts} WHERE session_id = keyed.id) AS search_size
					FROM keyed
				) SELECT ${LISTING_COLUMNS}, ord, fetched, batch_chars, page_chars, CASE WHEN search_size <= ? THEN (
					SELECT COALESCE('[' || ${this.dialect.orderedConcat("text_json", "','", "seq")} || ']', '[]')
					FROM (SELECT text_json, seq FROM ${this.tables.searchTexts} WHERE session_id = page.id ORDER BY seq)
				) END AS search_texts_json
				FROM (
					SELECT ${LISTING_COLUMNS}, ord, search_size, count(*) OVER () AS fetched,
						row_number() OVER (ORDER BY ord) AS page_row,
						sum(size + search_size) OVER () AS batch_chars,
						sum(size + search_size) OVER (ORDER BY ord) AS page_chars
					FROM sized
				) AS page WHERE (page_chars <= ? OR page_row = 1) AND page_row <= ? ORDER BY ord`,
				...params,
				after,
				limit + 1,
				SESSION_READ_PAGE_CHARS,
				SESSION_READ_PAGE_CHARS,
				limit,
			);
			for (const row of page) {
				const summaryRow =
					row.search_texts_json === null ? { ...row, search_texts_json: await this.readSearchTexts(row.id) } : row;
				this.summaries.set(row.id, { version: listingVersion(summaryRow), summary: summaryFromRow(summaryRow) });
				rows.push(summaryRow);
			}
			const next = nextFetch(limit, page);
			if (!next.more) return rows;
			after = Number(page.at(-1)!.ord);
			limit = next.limit;
		}
	}

	/** A session's search texts as one JSON array, read in pages of at most {@link SESSION_READ_PAGE_CHARS}. */
	private async readSearchTexts(sessionId: string): Promise<string> {
		const sizes = await this.database.all<SizedRow & { seq: number }>(
			`SELECT seq, length(text_json) AS size FROM ${this.tables.searchTexts} WHERE session_id = ? ORDER BY seq`,
			sessionId,
		);
		const texts: string[] = [];
		for (const page of pagesOf(sizes)) {
			const rows = await this.database.all<SqliteRow & { text_json: string }>(
				`SELECT text_json FROM ${this.tables.searchTexts} WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq`,
				sessionId,
				page[0]!.seq,
				page.at(-1)!.seq,
			);
			for (const row of rows) texts.push(row.text_json);
		}
		return `[${texts.join(",")}]`;
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
			`SELECT header_json, last_seq,summary_state,revision FROM ${this.tables.sessions} WHERE id = ?`,
			sessionId,
		);
		if (!row) throw new SessionNotFoundError(sessionId);
		return {
			header: JSON.parse(row.header_json) as SessionRecordHeader,
			entries: (await this.readRows(tx, sessionId)).map(({ entry }) => entry),
			lastSeq: row.last_seq,
		};
	}

	private async readRows(
		tx: SqliteExecutor,
		sessionId: string,
		filter = "",
		params: readonly SqliteValue[] = [],
	): Promise<SessionStoredEntry[]> {
		const entries: SessionStoredEntry[] = [];
		for (let after = 0, limit: number = SESSION_READ_FETCH.first; ; ) {
			const rows = await tx.all<SqliteRow & FetchRow & { seq: number; entry_json: string; chunks: number }>(
				`WITH sized AS MATERIALIZED (
					SELECT seq, chunks, length(entry_json) AS size,
						CASE WHEN ${this.dialect.textByteLength("entry_json")} <= ? THEN entry_json END AS inline_json
					FROM ${this.tables.entries} WHERE session_id = ? AND seq > ?${filter === "" ? "" : ` AND ${filter}`} ORDER BY seq LIMIT ?
				), batch AS MATERIALIZED (
					SELECT count(*) AS fetched, COALESCE(sum(size), 0) AS chars FROM sized
				), page AS (
					SELECT seq, chunks, inline_json, fetched, chars AS batch_chars, 0 AS page_chars
					FROM (SELECT seq, chunks, inline_json FROM sized ORDER BY seq LIMIT ?) AS fitting CROSS JOIN batch
					WHERE batch.chars <= ?
					UNION ALL
					SELECT seq, chunks, inline_json, fetched, batch_chars, page_chars FROM (
						SELECT seq, chunks, inline_json, batch.fetched, batch.chars AS batch_chars,
							row_number() OVER (ORDER BY seq) AS page_row,
							sum(size) OVER (ORDER BY seq) AS page_chars
						FROM sized CROSS JOIN batch WHERE batch.chars > ?
					) AS windowed WHERE (page_chars <= ? OR page_row = 1) AND page_row <= ?
				) SELECT seq, COALESCE(inline_json, (
					SELECT e.entry_json FROM ${this.tables.entries} AS e WHERE e.session_id = ? AND e.seq = page.seq
				)) AS entry_json, chunks, fetched, batch_chars, page_chars FROM page ORDER BY seq`,
				SESSION_READ_INLINE_BYTES,
				sessionId,
				after,
				...params,
				limit + 1,
				limit,
				SESSION_READ_PAGE_CHARS,
				SESSION_READ_PAGE_CHARS,
				SESSION_READ_PAGE_CHARS,
				limit,
				sessionId,
			);
			for (const entry of rows) {
				const chunks = Number(entry.chunks);
				const json = chunks === 0 ? entry.entry_json : await this.readEntryChunks(tx, sessionId, entry.seq, chunks);
				entries.push({ seq: Number(entry.seq), entry: JSON.parse(json) as SessionEntry });
			}
			const next = nextFetch(limit, rows);
			if (!next.more) return entries;
			after = Number(rows.at(-1)!.seq);
			limit = next.limit;
		}
	}

	private async readSeqs(
		tx: SqliteExecutor,
		sessionId: string,
		seqs: readonly number[],
	): Promise<SessionStoredEntry[]> {
		const entries: SessionStoredEntry[] = [];
		for (let start = 0; start < seqs.length; start += SEQ_BATCH) {
			const batch = seqs.slice(start, start + SEQ_BATCH);
			entries.push(...(await this.readRows(tx, sessionId, `seq IN (${batch.map(() => "?").join(", ")})`, batch)));
		}
		return entries;
	}

	private async resumeSource(
		tx: SqliteExecutor,
		sessionId: string,
	): Promise<ResumeSource & { readonly row: ResumeRow }> {
		const row = await tx.get<ResumeRow>(
			`SELECT header_json,last_seq,summary_state,revision FROM ${this.tables.sessions} WHERE id = ?${this.dialect.lockClause("share")}`,
			sessionId,
		);
		if (!row) throw new SessionNotFoundError(sessionId);
		const stored = (JSON.parse(row.summary_state) as StoredSummaryState).resume;
		const remembered = this.resumeIndexes.get(sessionId);
		const index = isSessionResumeIndex(stored, Number(row.last_seq))
			? stored
			: remembered?.revision === row.revision
				? remembered.index
				: undefined;
		if (!index || !isSessionResumeIndex(index, Number(row.last_seq)))
			throw new SessionConflictError(sessionId, Number(row.last_seq), Number(row.last_seq));
		return { header: JSON.parse(row.header_json) as SessionRecordHeader, index, row };
	}

	private async prepareResume(sessionId: string): Promise<void> {
		attempts: for (let attempt = 0; attempt < 3; attempt++) {
			const row = await this.database.get<ResumeRow>(
				`SELECT header_json,last_seq,summary_state,revision FROM ${this.tables.sessions} WHERE id = ?`,
				sessionId,
			);
			if (!row) throw new SessionNotFoundError(sessionId);
			const { resumeCheckpoint: legacyCheckpoint, ...state } = JSON.parse(row.summary_state) as StoredSummaryState;
			if (isSessionResumeIndex(state.resume, Number(row.last_seq))) return;
			const remembered = this.resumeIndexes.get(sessionId);
			if (remembered?.revision === row.revision && isSessionResumeIndex(remembered.index, Number(row.last_seq)))
				return;
			let index: SessionResumeIndex | undefined;
			const sqlite = this.dialect.name === "sqlite";
			// Parse once per entry on Postgres, not once for every selected path. All paths are fixed store keys.
			const j = (...path: string[]) =>
				sqlite
					? this.dialect.jsonText("entry_json", ...path)
					: this.dialect.jsonAt({ column: "entry_json", element: "parsed" }, ...path);
			const jsonType = (...path: string[]) =>
				sqlite
					? this.dialect.jsonType("entry_json", ...path)
					: `jsonb_typeof(parsed.value #> '{${path.join(",")}}')`;
			const projected = [
				"type",
				"parentId",
				"timestamp",
				"customType",
				"firstKeptEntryId",
				"coveredThroughEntryId",
				"provider",
				"modelId",
				"thinkingLevel",
				"targetId",
				"label",
				"stageAdmissionKey",
			].map((key) => [key, j(key)] as const);
			const messageKeys = ["role", "provider", "model", "usage", "toolCallId"];
			const dataKeys = [
				"childId",
				"version",
				"index",
				"agent",
				"cwd",
				"state",
				"intercomSessionId",
				"homeGroup",
				"kind",
				"worktree",
				"type",
				"timestamp",
				"completionId",
				"sessionId",
				"askId",
				"messageId",
				"attemptId",
				"runId",
				"requestId",
				"id",
				"protectedReconciliationOf",
				"historyOnly",
				"toolCallId",
				"ownerId",
				"taskId",
			];
			const dataExpr = this.dialect.jsonObject([
				...dataKeys.map(
					(key) =>
						[
							key,
							["version", "index", "timestamp"].includes(key)
								? `CASE WHEN ${jsonType("data", key)} IN ('integer','real','number') THEN CAST(${j("data", key)} AS ${this.dialect.types.real}) END`
								: j("data", key),
						] as const,
				),
				[
					"message",
					this.dialect.jsonObject(
						["id", "replyTo", "expectsReply"].map((key) => [key, j("data", "message", key)] as const),
					),
				],
				["op", `CASE WHEN ${jsonType("data", "op")} = '${sqlite ? "text" : "string"}' THEN ${j("data", "op")} END`],
				["owner", j("data", "owner")],
				["tasks", j("data", "tasks")],
				["groups", j("data", "groups")],
				...["queries", "urls"].map(
					(key) => [key, `CASE WHEN ${jsonType("data", key)} = 'array' THEN '[]' ELSE NULL END`] as const,
				),
			]);
			const detailsExpr = this.dialect.jsonObject([
				...dataKeys.map((key) => [key, j("details", key)] as const),
				[
					"message",
					this.dialect.jsonObject(
						["id", "replyTo", "expectsReply"].map((key) => [key, j("details", "message", key)] as const),
					),
				],
			]);
			const dataFieldNames =
				this.dialect.name === "sqlite"
					? `(SELECT COALESCE(json_group_array(key),'[]') FROM json_each(entry_json,'$.data'))`
					: `(SELECT COALESCE(json_agg(key)::text,'[]') FROM jsonb_object_keys(CASE WHEN jsonb_typeof(parsed.value->'data')='object' THEN parsed.value->'data' ELSE '{}'::jsonb END) AS key)`;
			const embedded = this.database.descriptor.adapter === "node-sqlite";
			// Walk only the content array. node:sqlite can pass it as JSONB without rendering large blocks back to text.
			const toolBlocks = sqlite
				? this.dialect.jsonValues(
						embedded ? "jsonb_extract(entry_json, '$.message.content')" : j("message", "content"),
					)
				: "jsonb_array_elements_text(parsed.value #> '{message,content}') AS blocks(value)";
			const columns = [
				["dataFields", `CASE WHEN ${j("type")} = 'custom' THEN ${dataFieldNames} ELSE '[]' END`],
				...projected,
				["message", this.dialect.jsonObject(messageKeys.map((key) => [key, j("message", key)] as const))],
				["data", dataExpr],
				["details", detailsExpr],
				["usage", j("usage")],
				["protectedReconciliation", j("protectedReconciliation")],
				["snapshot", `CASE WHEN ${jsonType("snapshot")} = 'object' THEN '{}' ELSE NULL END`],
				["compactionDetails", j("details", "strategy")],
				[
					"toolCalls",
					`CASE WHEN ${j("message", "role")} = 'assistant' AND ${jsonType("message", "content")} = 'array' THEN
						(SELECT count(*) FROM ${toolBlocks}
						WHERE ${this.dialect.jsonText("value", "type")} = 'toolCall') ELSE 0 END`,
				],
			];
			const select = columns
				.map(([key, expr]) => `${expr} AS ${this.dialect.identifier(`resume_${key.toLowerCase()}`)}`)
				.join(", ");
			const where = "WHERE session_id = ? AND seq > ? AND seq <= ?";
			const page = `WITH page AS (
				SELECT ${sqlite ? "" : "CASE WHEN chunks > 0 THEN session_id END AS session_id,"}seq,entry_id,chunks,entry_json FROM ${this.tables.entries}
				${where} ORDER BY seq LIMIT ${SESSION_RESUME_REBUILD.pageEntries}
			)`;
			const parts = (
				source: string,
			) => `FROM ${this.tables.entryChunks} WHERE session_id = ${sqlite ? "?1" : `${source}.session_id`}
				AND seq = ${source}.seq AND idx >= 0 AND idx < ${source}.chunks`;
			const projection = sqlite
				? `SELECT seq,entry_id,chunks,${select} FROM payloads ORDER BY seq`
				: `SELECT seq,entry_id,chunks,${select} FROM payloads
					CROSS JOIN LATERAL (SELECT ${postgresJsonb("entry_json")} AS value OFFSET 0) AS parsed ORDER BY seq`;
			// SQLite checks zeroblob against this connection's actual value limit without allocating the bytes.
			// PostgreSQL fields must be smaller than 1 GiB. Ask for byte lengths, not a trial concatenation.
			const fits = sqlite
				? "length(zeroblob(sum(length(data)))) IS NOT NULL"
				: "sum(octet_length(data)) < 1073741824";
			const joined = sqlite
				? `(SELECT group_concat(text, '') FROM (SELECT CAST(data AS TEXT) AS text ${parts("sized")} ORDER BY idx))`
				: `(SELECT convert_from(string_agg(data, ''::bytea ORDER BY idx), 'UTF8') ${parts("sized")})`;
			// On SQLite, check each entry just before joining its chunks, not a whole page ahead of the reads.
			// OFFSET 0 prevents SQLite from flattening the size check and evaluating it twice for the same entry.
			// Materialize the joined payloads once so all projected fields share them. Only metadata leaves SQL.
			const directPage = `${page}, sized AS ${sqlite ? "NOT MATERIALIZED" : "MATERIALIZED"} (
				SELECT page.*, CASE WHEN chunks = 0 OR EXISTS (SELECT 1 ${parts("page")} GROUP BY seq
					HAVING count(*) = page.chunks AND ${fits}) THEN 0 ELSE chunks END AS remaining FROM page${sqlite ? " LIMIT -1 OFFSET 0" : ""}
			), payloads AS MATERIALIZED (
				SELECT seq,entry_id,CASE WHEN remaining = 0 THEN chunks ELSE -chunks END AS chunks,
					CASE WHEN chunks > 0 AND remaining = 0 THEN ${joined} ELSE entry_json END AS entry_json
				FROM sized
			) ${projection}`;
			// A wide owner key can occupy overflow pages of SQLite's composite chunk index. Walk that index
			// once for the page, then check lengths and join by integer rowid in the same statement. Only
			// locations are staged; the bounds below permit at most 512 x 64 distinct (seq,idx) pairs.
			// Outside this window use the direct checked join, including for non-contiguous sequences.
			const keysPerEntry = 64;
			const through = `?2 + ${SESSION_RESUME_REBUILD.pageEntries}`;
			const nativePage =
				this.entryLayout.chunkRowids && Buffer.byteLength(sessionId) >= 512
					? `${page},
				keys AS MATERIALIZED (SELECT seq,idx,rowid AS rid FROM ${this.tables.entryChunks}
					WHERE session_id = ?1 AND seq > ?2 AND seq <= ?3 AND seq <= ${through} AND idx >= 0 AND idx < ${keysPerEntry}
					ORDER BY seq,idx),
				sized AS NOT MATERIALIZED (SELECT page.*, CASE WHEN chunks = 0 THEN NULL
					WHEN seq <= ${through} AND chunks <= ${keysPerEntry} THEN (
						SELECT CASE WHEN count(*) = page.chunks AND length(zeroblob(sum(bytes))) IS NOT NULL THEN json_group_array(rid) END
						FROM (SELECT k.rid,length(c.data) AS bytes FROM keys k CROSS JOIN ${this.tables.entryChunks} c
							WHERE k.seq = page.seq AND k.idx < page.chunks AND c.rowid = k.rid ORDER BY k.idx LIMIT -1 OFFSET 0))
					WHEN EXISTS (SELECT 1 ${parts("page")} GROUP BY seq HAVING count(*) = page.chunks AND ${fits}) THEN '' END AS refs
					FROM page LIMIT -1 OFFSET 0),
				payloads AS MATERIALIZED (SELECT seq,entry_id,CASE WHEN chunks > 0 AND refs IS NULL THEN -chunks ELSE chunks END AS chunks,
					CASE WHEN refs IS NULL THEN entry_json WHEN refs = '' THEN ${joined} ELSE (
						SELECT group_concat(CAST((SELECT data FROM ${this.tables.entryChunks} WHERE rowid = ids.value) AS TEXT), '')
						FROM (SELECT value FROM json_each(sized.refs) ORDER BY CAST(key AS INTEGER) LIMIT -1 OFFSET 0) ids) END AS entry_json FROM sized)
				${projection}`
					: directPage;
			const stubPage = `${page}, payloads AS (SELECT seq,entry_id,-chunks AS chunks,entry_json FROM page) ${projection}`;
			// Checkpoints are not published indexes. A revision or index-format change invalidates both passes.
			const validCheckpoint = (checkpoint?: ResumeCheckpoint): checkpoint is ResumeCheckpoint =>
				checkpoint?.revision === row.revision &&
				checkpoint.index?.seq > 0 &&
				checkpoint.index.seq < Number(row.last_seq) &&
				isSessionResumeIndex(checkpoint.index, checkpoint.index.seq);
			const slot = this.checkpointSlot();
			const checkpoint = validCheckpoint(legacyCheckpoint) ? legacyCheckpoint : undefined;
			let saved: Uint8Array | null = null;
			let checkSaved = Number(row.last_seq) > SESSION_RESUME_REBUILD.pageEntries;
			let topology = checkpoint?.topology;
			let canSave = !this.database.readOnly;
			index = checkpoint?.index;
			let nextCheckpointAt = performance.now() + SESSION_RESUME_REBUILD.checkpointIntervalMs;
			for (let pass = topology === undefined ? 0 : 1; pass < 2; pass++) {
				pages: for (let after = index?.seq ?? 0; after < Number(row.last_seq); ) {
					type ProjectedRow = SqliteRow & { seq: number; entry_id: string; chunks: number };
					const args = [sessionId, after, row.last_seq] as const;
					let rows: ProjectedRow[] = [];
					const batch: SessionEntry[] = [];
					let toolCalls = 0;
					for (const sql of [nativePage, stubPage]) {
						let canStream = true;
						try {
							if (checkSaved) {
								checkSaved = false;
								// Only a cold, multi-page rebuild can have a saved prefix. Usually there is none:
								// deliver the first page itself, without a separate round trip. A saved prefix skips it.
								const guarded = sql.replace(
									where,
									`${where} AND NOT EXISTS (
									SELECT 1 FROM ${slot.table} WHERE session_id = ${sqlite ? "?1" : "?"} AND ${slot.where})`,
								);
								rows = await this.database.all<ProjectedRow>(guarded, ...args, ...(sqlite ? [] : [sessionId]));
								if (rows.length === 0) {
									const receipt = await this.database.get<SqliteRow & { token: Uint8Array }>(
										`SELECT substr(data,1,${CHECKPOINT_TOKEN_BYTES}) AS token FROM ${slot.table} WHERE session_id = ? AND ${slot.where}`,
										sessionId,
									);
									saved = receipt?.token ?? null;
									const prior = saved ? await this.readCheckpoint(sessionId, saved) : undefined;
									if (validCheckpoint(prior)) {
										index = prior.index;
										topology = prior.topology;
										pass = topology === undefined ? 0 : 1;
										after = index.seq;
									}
									continue pages;
								}
							} else rows = await this.database.all<ProjectedRow>(sql, ...args);
							for (const entry of rows) {
								const chunks = Number(entry.chunks);
								// Zero is inline, positive is a native join, negative still needs the bounded reader.
								canStream = chunks > 0;
								let projected: SqliteRow = entry;
								if (chunks < 0) {
									try {
										const { chunkedResumeProjection } = await import("./chunked-resume-projection.js");
										projected = await chunkedResumeProjection(entry, this.dialect.name === "postgres", () =>
											this.entryChunks(sessionId, Number(entry.seq), -chunks, row.revision),
										);
									} catch (error) {
										// A replacement between chunk reads can remove a chunk or change its JSON mid-token.
										const current = await this.database.get(
											`SELECT revision FROM ${this.tables.sessions} WHERE id = ?`,
											sessionId,
										);
										if (current?.revision !== row.revision) continue attempts;
										throw error;
									}
								}
								const parsed: Record<string, unknown> = { id: entry.entry_id };
								const decode = (value: SqliteValue | undefined) =>
									typeof value === "string" && (value.startsWith("{") || value.startsWith("["))
										? JSON.parse(value)
										: value;
								for (const [key] of columns) {
									const value = projected[`resume_${key.toLowerCase()}`];
									parsed[key] = [
										"dataFields",
										"message",
										"data",
										"details",
										"usage",
										"snapshot",
										"protectedReconciliation",
									].includes(key)
										? decode(value)
										: value;
								}
								const message = parsed.message as Record<string, unknown>;
								if (message && typeof message === "object") {
									message.usage = decode(message.usage as SqliteValue);
									if (parsed.type === "message" && message.role === "assistant")
										toolCalls += Number(parsed.toolCalls ?? 0);
								}
								if (parsed.snapshot === null) delete parsed.snapshot;
								if (parsed.type === "compaction") parsed.details = { strategy: parsed.compactionDetails };
								if (parsed.type === "custom") {
									const data = parsed.data as Record<string, unknown>;
									const keys = (parsed.dataFields as string[]) ?? [];
									for (const key of Object.keys(data)) if (!keys.includes(key)) delete data[key];
									for (const key of keys) if (!(key in data)) data[key] = null;
								}
								for (const key of ["data", "details"]) {
									const data = parsed[key] as Record<string, unknown>;
									if (data && typeof data === "object") {
										data.message = decode(data.message as SqliteValue);
										data.owner = decode(data.owner as SqliteValue);
										data.tasks = decode(data.tasks as SqliteValue);
										for (const field of ["groups", "queries", "urls"])
											if (field in data) data[field] = decode(data[field] as SqliteValue);
										if (
											data.timestamp !== null &&
											data.timestamp !== undefined &&
											typeof data.timestamp === "string"
										)
											data.timestamp = Number(data.timestamp);
										if (parsed.type === "custom" && parsed.customType === "subagent-child") {
											if (data.version !== null && data.version !== undefined)
												data.version = Number(data.version);
											if (data.index !== null && data.index !== undefined) data.index = Number(data.index);
										}
										const message = data.message as Record<string, unknown>;
										if (message?.expectsReply === 1 || message?.expectsReply === "true")
											message.expectsReply = true;
										if (data.historyOnly === 1 || data.historyOnly === "true") data.historyOnly = true;
									}
								}
								batch.push(parsed as unknown as SessionEntry);
							}
							break;
						} catch (error) {
							// A native value or result page exceeded a limit, or legacy projected text wasn't JSON.
							// Read stubs and select the needed fields from chunks instead. No part of this page was folded.
							if (
								sql === stubPage ||
								!canStream ||
								!(error instanceof Error) ||
								!["SyntaxError", "StoragePayloadTooLargeError", "StorageUnavailableError"].includes(error.name)
							)
								throw error;
							if (rows.length === 0) {
								// A refused SELECT delivers no rows. Probe only the two primary indexes, bounded to this
								// page: retrying an entirely inline page would return exactly the same data or error.
								const chunked = await this.database
									.get(
										`SELECT 1 FROM ${this.tables.entryChunks}
									WHERE session_id = ? AND seq IN (SELECT seq FROM ${this.tables.entries} ${where}
									ORDER BY seq LIMIT ${SESSION_RESUME_REBUILD.pageEntries}) LIMIT 1`,
										sessionId,
										...args,
									)
									.catch(() => undefined);
								if (!chunked) throw error;
							}
							batch.length = 0;
							toolCalls = 0;
						}
					}
					if (rows.length === 0) break;
					const old = index ?? foldSessionResume(undefined, []);
					const seqs = new Map<string, number>();
					for (const id of foreignResumeIds(old, batch)) {
						const seq = await this.seqOfEntry(this.database, sessionId, id);
						if (seq !== undefined) seqs.set(id, seq);
					}
					index = foldSessionResume(
						index,
						batch,
						(id) => seqs.get(id),
						(seq) => topology === undefined || topology.some(([a, b]) => seq >= a && seq <= b),
					);
					if (toolCalls > 0)
						index = { ...index, totals: { ...index.totals, toolCalls: index.totals.toolCalls + toolCalls } };
					after = Number(rows.at(-1)!.seq);
					// Checkpoints share SQLite's write lock with other sessions. Fast rebuilds need only the final publication.
					if (
						canSave &&
						after < Number(row.last_seq) &&
						index.seq === after &&
						performance.now() >= nextCheckpointAt
					) {
						// Checkpoints feed another fold, unlike the final index. JSON null would silently turn an
						// overflowing sum back into zero on the next addition. JSON.parse("1e999") preserves Infinity.
						const next = JSON.stringify({ revision: row.revision, index, topology }, (_key, value: unknown) =>
							value === Infinity || value === -Infinity
								? (JSON as JSON & { rawJSON(text: string): object }).rawJSON(value > 0 ? "1e999" : "-1e999")
								: value,
						);

						// Check both what the session published and which prefix we started with. Never replace a
						// peer's newer checkpoint or add one after an older or newer reader finished the index.
						if (Buffer.byteLength(next) + CHECKPOINT_TOKEN_BYTES <= CHECKPOINT_BYTES) {
							const token = newRevision();
							const save = (tx: SqliteExecutor) =>
								tx.run(
									`INSERT INTO ${slot.table} (session_id,${slot.column},idx,data)
									 SELECT id,${slot.value},0,? FROM ${this.tables.sessions}
									 WHERE id = ? AND revision = ? AND summary_state = ?${this.dialect.lockClause("share")}
									 ON CONFLICT(session_id,${slot.column},idx) DO UPDATE SET data = excluded.data
									 WHERE substr(${slot.table}.data,1,${CHECKPOINT_TOKEN_BYTES}) = ?`,
									Buffer.from(token + next),
									sessionId,
									row.revision,
									row.summary_state,
									saved,
								);
							// A PG delete sweeps chunks before deleting the session row. Join its writer admission,
							// or it could commit between our existence check and insert and leave an orphan.
							// Skip this optional save, rather than waiting behind an incumbent writer.
							const result = await (sqlite
								? save(this.database)
								: this.database.transaction(save, {
										concurrency: { kind: "serial", domain: this.tables.sessions },
										lockWaitMs: 1,
									})
							).catch(() => ({ changes: 0 }));
							canSave = result.changes === 1;
							if (canSave) saved = Buffer.from(token);
						}
						nextCheckpointAt = performance.now() + SESSION_RESUME_REBUILD.checkpointIntervalMs;
					}
					if (after < Number(row.last_seq)) await yieldTurn();
				}
				if (pass !== 0 || !index || index.jumps.length === 0) break;
				topology = branchRanges(index, index.leafSeq);
				index = undefined;
			}
			index = { ...(index ?? foldSessionResume(undefined, [])), epoch: state.epoch ?? row.revision };
			const current = await this.database.get<ResumeRow>(
				`SELECT revision,last_seq FROM ${this.tables.sessions} WHERE id = ?`,
				sessionId,
			);
			if (current?.revision !== row.revision || Number(current.last_seq) !== Number(row.last_seq)) continue;
			this.resumeIndexes.set(sessionId, { revision: row.revision, index });
			while (this.resumeIndexes.size > 16) this.resumeIndexes.delete(this.resumeIndexes.keys().next().value!);
			const published = await this.database
				.run(
					`UPDATE ${this.tables.sessions} SET summary_state = ? WHERE id = ? AND revision = ? AND last_seq = ?`,
					JSON.stringify({ ...state, resume: index, epoch: index.epoch }),
					sessionId,
					row.revision,
					row.last_seq,
				)
				.catch(() => ({ changes: 0 }));
			if (published.changes === 1 && saved) await this.forgetCheckpoint(sessionId, saved);
			return;
		}
		throw new SessionConflictError(sessionId, 0, 0);
	}

	private checkpointSlot() {
		const postgres = this.dialect.name === "postgres";
		const key = postgres ? POSTGRES_CHECKPOINT : SQLITE_CHECKPOINT;
		return {
			...key,
			table: postgres ? this.tables.entryChunks : this.tables.blobChunks,
			where: `${key.column} = ${key.value} AND idx = 0`,
		};
	}

	private async readCheckpoint(sessionId: string, token: Uint8Array): Promise<ResumeCheckpoint | undefined> {
		const slot = this.checkpointSlot();
		const parts: Uint8Array[] = [];
		let size: number = SESSION_BLOB_CHUNK_BYTES;
		for (let offset = CHECKPOINT_TOKEN_BYTES; offset < CHECKPOINT_BYTES; ) {
			try {
				const row = await this.database.get<SqliteRow & { part: Uint8Array }>(
					`SELECT substr(data,?,?) AS part FROM ${slot.table} WHERE session_id = ? AND ${slot.where}
					 AND substr(data,1,${CHECKPOINT_TOKEN_BYTES}) = ?`,
					offset + 1,
					size,
					sessionId,
					token,
				);
				if (!row) return undefined;
				parts.push(row.part);
				offset += row.part.length;
				if (row.part.length < size) break;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "payload-too-large")) throw error;
				// A saved value can exceed the server's response limit, even when its write fit.
				if (size === 1) return undefined;
				size = Math.max(1, Math.floor(size / 2));
			}
		}
		return JSON.parse(Buffer.concat(parts).toString("utf8")) as ResumeCheckpoint;
	}

	private async forgetCheckpoint(sessionId: string, token: Uint8Array): Promise<void> {
		const slot = this.checkpointSlot();
		await this.database
			.run(
				`DELETE FROM ${slot.table} WHERE session_id = ? AND ${slot.where}
			 AND substr(data,1,${CHECKPOINT_TOKEN_BYTES}) = ?`,
				sessionId,
				token,
			)
			.catch(() => undefined);
	}

	async readTail(sessionId: string, fromSeq: number): Promise<SessionTail> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		await this.prepareResume(sessionId);
		const start = Math.max(1, fromSeq);
		const { tail } = await this.transaction(async (tx) => {
			const source = await this.resumeSource(tx, sessionId);
			const stateSeqs = stateSeqsBefore(source.index, start);
			if (hasHistoryLoadObserver())
				announceHistoryLoad(stateSeqs.length + Math.max(0, source.index.seq - start + 1));
			const state = await this.readSeqs(tx, sessionId, stateSeqs);
			const entries = (await this.readRows(tx, sessionId, "seq >= ?", [start])).map(({ entry }) => entry);
			return { tail: sessionTailFrom(source.index, source.header, start, state, entries), source };
		}, SESSION_TRANSACTION);

		return tail;
	}

	async readRange(sessionId: string, startSeq: number, endSeq: number): Promise<SessionEntryRange> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const start = Math.max(1, startSeq);
		return this.transaction(async (tx) => {
			const row = await tx.get<HeaderRow>(
				`SELECT last_seq, summary_state, revision FROM ${this.tables.sessions} WHERE id = ?${this.dialect.lockClause("share")}`,
				sessionId,
			);
			if (!row) throw new SessionNotFoundError(sessionId);
			const entries =
				endSeq < start ? [] : await this.readRows(tx, sessionId, "seq >= ? AND seq <= ?", [start, endSeq]);
			const meta = JSON.parse(String(row.summary_state)) as StoredSummaryState;
			return {
				startSeq: start,
				entries: entries.map(({ entry }) => entry),
				seqs: entries.map(({ seq }) => seq),
				lastSeq: Number(row.last_seq),
				epoch: meta.epoch ?? meta.resume?.epoch ?? String(row.revision),
			};
		}, SESSION_TRANSACTION);
	}

	async findEntrySeq(sessionId: string, entryId: string): Promise<number | undefined> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		validateSessionText("entry.id", entryId);
		if (!(await this.readHeader(sessionId))) throw new SessionNotFoundError(sessionId);
		return this.seqOfEntry(this.database, sessionId, entryId);
	}
	async readResume(sessionId: string, leafId?: string): Promise<SessionResume> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		if (leafId !== undefined) validateSessionText("entry.id", leafId);
		await this.prepareResume(sessionId);
		return this.transaction(async (tx) => {
			const source = await this.resumeSource(tx, sessionId);
			const leafSeq =
				leafId === undefined ? source.index.leafSeq : ((await this.seqOfEntry(tx, sessionId, leafId)) ?? 0);
			if (leafSeq !== source.index.leafSeq) {
				const all = (await this.readRows(tx, sessionId)).map((held) => held.entry);
				return sessionResumeOf(source.header, all, leafId, { ...source.index, leafSeq: source.index.leafSeq });
			}
			const index = { ...source.index, leafSeq };
			const plan = sessionResumePlan(index);
			announceHistoryLoad(plan.state.length + plan.branch.reduce((sum, [a, b]) => sum + b - a + 1, 0));
			const branch: SessionStoredEntry[] = [];
			for (const [start, end] of plan.branch)
				branch.push(...(await this.readRows(tx, sessionId, "seq >= ? AND seq <= ?", [start, end])));
			const state = await this.readSeqs(tx, sessionId, plan.state);
			const leaf =
				leafSeq <= 0
					? undefined
					: await tx.get<SqliteRow & { entry_id: string }>(
							`SELECT entry_id FROM ${this.tables.entries} WHERE session_id = ? AND seq = ?`,
							sessionId,
							leafSeq,
						);
			return sessionResumeFrom(index, source.header, branch, state, leaf?.entry_id ?? null);
		}, SESSION_TRANSACTION);
	}

	async findLatestCompaction(sessionId: string, leafId?: string): Promise<SessionCompactionPoint | undefined> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		if (leafId !== undefined) validateSessionText("entry.id", leafId);
		await this.prepareResume(sessionId);
		const { point } = await this.transaction(async (tx) => {
			const source = await this.resumeSource(tx, sessionId);
			const { index } = source;
			const leafSeq = leafId === undefined ? index.leafSeq : ((await this.seqOfEntry(tx, sessionId, leafId)) ?? -1);
			const found = latestCompactionOf(index, leafSeq);
			if (found === undefined) return { point: undefined, source };
			const [boundary] = await this.readSeqs(tx, sessionId, [found.seq]);
			const leaf = await tx.get<SqliteRow & { entry_id: string }>(
				`SELECT entry_id FROM ${this.tables.entries} WHERE session_id = ? AND seq = ?`,
				sessionId,
				leafSeq,
			);
			if (boundary === undefined || leaf === undefined) return { point: undefined, source };
			const point: SessionCompactionPoint = {
				...found,
				entry: boundary.entry as SessionCompactionPoint["entry"],
				leafId: leaf.entry_id,
				lastSeq: index.seq,
			};
			return { point, source };
		}, SESSION_TRANSACTION);

		return point;
	}

	/** The JSON of a long entry, from its chunks, one statement each. */
	private async readEntryChunks(tx: SqliteExecutor, sessionId: string, seq: number, count: number): Promise<string> {
		return Buffer.concat(await this.readRawEntryChunks(tx, sessionId, seq, count)).toString("utf8");
	}

	private async readRawEntryChunks(
		tx: SqliteExecutor,
		sessionId: string,
		seq: number,
		count: number,
		signal?: AbortSignal,
	): Promise<Uint8Array[]> {
		const chunks: Uint8Array[] = [];
		for (let index = 0; index < count; index++) {
			signal?.throwIfAborted();
			const chunk = await tx.get<SqliteRow & { data: Uint8Array }>(
				`SELECT data FROM ${this.tables.entryChunks} WHERE session_id = ? AND seq = ? AND idx = ?`,
				sessionId,
				seq,
				index,
			);
			if (chunk === undefined) {
				throw new StorageError(`Session ${sessionId} entry ${seq} is missing chunk ${index} of ${count}`);
			}
			chunks.push(chunk.data);
			if (signal !== undefined && index + 1 < count) await yieldTurn();
		}
		return chunks;
	}

	private async *entryChunks(
		sessionId: string,
		seq: number,
		count: number,
		revision: string,
	): AsyncGenerator<Uint8Array> {
		for (let index = 0; index < count; index++) {
			const chunk = await this.database.get<SqliteRow & { data: Uint8Array }>(
				`SELECT data FROM ${this.tables.entryChunks} WHERE session_id = ? AND seq = ? AND idx = ?
				 AND EXISTS (SELECT 1 FROM ${this.tables.sessions} WHERE id = ? AND revision = ?)`,
				sessionId,
				seq,
				index,
				sessionId,
				revision,
			);
			if (chunk === undefined) {
				throw new StorageError(`Session ${sessionId} entry ${seq} is missing chunk ${index} of ${count}`);
			}
			yield chunk.data;
			if (index + 1 < count) await yieldTurn();
		}
	}

	private async readInlineEntryBytes(sessionId: string, seq: number): Promise<Uint8Array[]> {
		if (this.dialect.name === "sqlite") {
			const row = await this.database.get<SqliteRow & { data: Uint8Array }>(
				`SELECT CAST(entry_json AS BLOB) AS data FROM ${this.tables.entries} WHERE session_id = ? AND seq = ?`,
				sessionId,
				seq,
			);
			return row ? [row.data] : [];
		}
		const row = await this.database.get<SqliteRow & { entry_json: string }>(
			`SELECT entry_json FROM ${this.tables.entries} WHERE session_id = ? AND seq = ?`,
			sessionId,
			seq,
		);
		return row ? [new TextEncoder().encode(row.entry_json)] : [];
	}

	private forWrite(
		tx: SqliteExecutor,
		sessionId: string,
		options: SessionWriteOptions,
		includeSummaryState: true,
	): Promise<{ readonly row: SummaryStateRow; readonly state: StoredSummaryState }>;
	private forWrite(
		tx: SqliteExecutor,
		sessionId: string,
		options: SessionWriteOptions,
		includeSummaryState?: false,
	): Promise<{ readonly row: HeaderRow; readonly state?: StoredSummaryState }>;
	private async forWrite(
		tx: SqliteExecutor,
		sessionId: string,
		options: SessionWriteOptions,
		includeSummaryState = false,
	): Promise<{ readonly row: HeaderRow; readonly state?: StoredSummaryState }> {
		const row = await tx.get<HeaderRow>(
			`SELECT header_json, last_seq${includeSummaryState || options.epoch !== undefined ? ", summary_state" : ""}
			 FROM ${this.tables.sessions} WHERE id = ?`,
			sessionId,
		);
		if (!row) throw new SessionNotFoundError(sessionId);
		const state =
			row.summary_state === undefined ? undefined : (JSON.parse(String(row.summary_state)) as StoredSummaryState);
		if (row.last_seq !== options.expectSeq || (options.epoch !== undefined && state?.epoch !== options.epoch)) {
			throw new SessionConflictError(sessionId, options.expectSeq, row.last_seq);
		}
		return { row, state };
	}

	private async appendedResume(
		tx: SqliteExecutor,
		sessionId: string,
		previous: SessionResumeIndex | undefined,
		lastSeq: number,
		entries: readonly SessionEntry[],
	): Promise<SessionResumeIndex | undefined> {
		if (!isSessionResumeIndex(previous, lastSeq)) return undefined;
		const seqs = new Map<string, number>();
		for (const id of foreignResumeIds(previous, entries)) {
			const seq = await this.seqOfEntry(tx, sessionId, id);
			if (seq !== undefined) seqs.set(id, seq);
		}
		return foldSessionResume(previous, entries, (id) => seqs.get(id));
	}

	private async seqOfEntry(executor: SqliteExecutor, sessionId: string, entryId: string): Promise<number | undefined> {
		const tables = snapshotIndexTables(this.prefix);
		const source = await executor.get<SqliteRow & { complete: number }>(
			`SELECT CASE WHEN backfilled_through >= watermark THEN 1 ELSE 0 END AS complete FROM ${tables.sources} WHERE source = 'session-entries'`,
		);
		if (Number(source?.complete) === 1) {
			const linked = await executor.get<SqliteRow & { seq: number }>(
				`SELECT seq FROM ${tables.sessionLinks} WHERE session_id = ? AND entry_id = ? ORDER BY seq DESC LIMIT 1`,
				sessionId,
				entryId,
			);
			return linked === undefined ? undefined : Number(linked.seq);
		}
		const row = await executor.get<SqliteRow & { seq: number }>(
			`SELECT seq FROM ${this.tables.entries} WHERE session_id = ? AND entry_id = ? ORDER BY seq DESC LIMIT 1`,
			sessionId,
			entryId,
		);
		return row === undefined ? undefined : Number(row.seq);
	}

	private async saveSummary(
		tx: SqliteExecutor,
		sessionId: string,
		snapshot: SessionSnapshot,
		previous?: SessionSummaryState,
		appendedResume?: SessionResumeIndex,
	): Promise<{ readonly texts: readonly SessionSummaryText[]; readonly epoch: string }> {
		const { header, lastSeq } = snapshot;
		const { state: listed, texts } = applySessionSummaryEntries(previous, snapshot.entries);
		const resume = previous === undefined ? foldSessionResume(undefined, snapshot.entries) : appendedResume;
		const epoch = resume?.epoch ?? (previous as StoredSummaryState | undefined)?.epoch ?? newRevision();
		const state: StoredSummaryState = resume === undefined ? { ...listed, epoch } : { ...listed, resume, epoch };
		const summary = materializeSessionSummaryMetadata(header, state);
		await tx.run(
			`INSERT INTO ${this.tables.sessions}
				(id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count,
				 first_message, name, has_name, summary, summarized_through_id, summary_state, revision)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
			newRevision(),
		);
		return { texts, epoch };
	}

	private async insertEntries(
		tx: SqliteExecutor,
		sessionId: string,
		entries: readonly SessionEntry[],
		lastSeq: number,
		texts: readonly SessionSummaryText[],
	): Promise<void> {
		let chunked = false;
		for (const [index, entry] of entries.entries()) {
			const seq = lastSeq + index + 1;
			const stored = storedEntry(entry, this.encode(entry));
			chunked ||= stored.chunks.length > 0;
			await tx.run(
				`INSERT INTO ${this.tables.entries} (session_id, seq, entry_id, entry_json, chunks) VALUES (?, ?, ?, ?, ?)`,
				sessionId,
				seq,
				entry.id,
				stored.json,
				stored.chunks.length,
			);
			if (stored.chunks.length > 0) {
				await tx.run(`DELETE FROM ${this.tables.entryChunks} WHERE session_id = ? AND seq = ?`, sessionId, seq);
			}
			for (const [chunk, data] of stored.chunks.entries()) {
				await tx.run(
					`INSERT INTO ${this.tables.entryChunks} (session_id, seq, idx, data) VALUES (?, ?, ?, ?)`,
					sessionId,
					seq,
					chunk,
					data,
				);
			}
		}
		// One way, in the transaction that writes the first chunked entry: a build that knows only version 1 refuses the
		// database when next opened instead of reading the entry as a stub.
		if (chunked) {
			await tx.run(
				`UPDATE ${this.tables.meta} SET schema_version = ? WHERE schema_version = ?`,
				SESSION_SCHEMA_VERSION,
				SESSION_SCHEMA_VERSION_UNCHUNKED,
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

	private encode(value: SessionRecordHeader | SessionEntry | StoredSummaryState | string): string {
		try {
			return JSON.stringify(value);
		} catch (cause) {
			throw new StorageUnavailableError(this.descriptor, cause as Error);
		}
	}
}

type OpenMarkerRow = SqliteRow & { token: string; pid: number; host: string; age_ms: number };

/** The running sessions that have a SQL store's sessions open, in a table every host sharing the store reads (#4971). */
class SqlSessionOpenMarkers implements SessionOpenMarkerStore {
	static async createTable(tx: SqliteExecutor, dialect: StorageDialect, table: string): Promise<void> {
		const { int, text } = dialect.types;
		await tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table} (
				session_id ${text} NOT NULL, token ${text} NOT NULL, pid ${int} NOT NULL, host ${text} NOT NULL,
				heartbeat_at ${int} NOT NULL, PRIMARY KEY(session_id, token)
			)${dialect.tableOptions};
		`);
	}

	/**
	 * Each marker records the sessions schema version its process reads, so a build that upgrades the schema can tell
	 * that a process which would misread the upgraded schema still has a session open (#5065). Null for markers of
	 * builds before it. Additive, as every step of this domain must be.
	 */
	static async addSchemaVersion(tx: SqliteExecutor, dialect: StorageDialect, table: string): Promise<void> {
		const probe = dialect.columnExists(table, "schema_version");
		if ((await tx.get(probe.sql, ...probe.params)) === undefined)
			await tx.exec(`ALTER TABLE ${table} ADD COLUMN schema_version ${dialect.types.int}`);
	}

	private readonly database: SqliteDatabase;
	private readonly table: string;
	private readonly assertOpen: () => void;

	constructor(database: SqliteDatabase, table: string, assertOpen: () => void) {
		this.database = database;
		this.table = table;
		this.assertOpen = assertOpen;
	}

	async put(sessionId: string, marker: SessionOpenMarker): Promise<void> {
		this.assertOpen();
		// The database's clock, not this host's: hosts whose clocks differ read the same heartbeat age.
		const now = dialectOf(this.database).nowMs;
		await this.database.run(
			`INSERT INTO ${this.table} (session_id, token, pid, host, heartbeat_at, schema_version) VALUES (?, ?, ?, ?, ${now}, ?)
			 ON CONFLICT(session_id, token) DO UPDATE SET pid = excluded.pid, host = excluded.host,
			 heartbeat_at = excluded.heartbeat_at, schema_version = excluded.schema_version`,
			sessionId,
			marker.token,
			marker.pid,
			marker.host,
			SESSION_SCHEMA_VERSION,
		);
	}

	async remove(sessionId: string, token: string): Promise<void> {
		this.assertOpen();
		await this.database.run(`DELETE FROM ${this.table} WHERE session_id = ? AND token = ?`, sessionId, token);
	}

	async list(sessionId: string): Promise<readonly SessionOpenMarkerAge[]> {
		this.assertOpen();
		const now = dialectOf(this.database).nowMs;
		const rows = await this.database.all<OpenMarkerRow>(
			`SELECT token, pid, host, ${now} - heartbeat_at AS age_ms FROM ${this.table} WHERE session_id = ?`,
			sessionId,
		);
		return rows.map((row) => ({ token: row.token, pid: Number(row.pid), host: row.host, ageMs: Number(row.age_ms) }));
	}
}
