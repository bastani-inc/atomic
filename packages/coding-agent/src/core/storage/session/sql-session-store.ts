import type { SessionEntry } from "../../session-manager-types.ts";
import { installSharedHistorySnapshotIndex } from "../../worktree-snapshot/added-exports.ts";
import { SqlSnapshotBlobStore, snapshotIndexTables } from "../../worktree-snapshot/blob-store.ts";
import { ensureTableFillfactor, transactionFinisher } from "../added-exports.js";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteStatement,
	SqliteTransactionOptions,
	SqliteValue,
} from "../database.js";
import { dialectOf, postgresJsonb, type StorageDialect } from "../dialect.js";
import { SessionBlobError, StorageError, StorageInvalidTextError, StorageSchemaVersionError } from "../errors.js";
import { ensureStorageSchema } from "../migrations.js";
import { renderStorageIdentifiers, storageMigrationTable, validateStoragePrefix } from "../prefix.js";
import { assertStorageSchemaVersion, assertStoredSchemaVersion } from "../schema.js";
import {
	noteStorageSchemaTables,
	refreshStorageSchemaCatalog,
	schemaCatalogOf,
	withStorageSchemaCatalog,
} from "../schema-catalog.js";
import { applyStorageMigrationsTogether, statementBatch } from "../statement-batches.js";
import { sequenceRunner } from "../statement-sequence.js";
import { sha256Hex } from "./blob-hash.js";
import { bindChatEpoch } from "./chat-records.js";
import {
	SessionConflictError,
	SessionExistsError,
	SessionIdMismatchError,
	SessionNotFoundError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";
import {
	detachForkChildren,
	type ForkDetachOptions,
	type ForkDetachReport,
	noteForkCopyRefusal,
	resumeForkDetaches,
} from "./fork-detach.js";
import { forkDetachHost } from "./fork-detach-host.js";
import { type ForkLineageTables, ForkSegmentRuns, forkLineageWrite, forkSegmentInserts } from "./fork-lineage.js";
import {
	createOverTombstoneWithin,
	deleteForkedSessionWithin,
	forkPinReads,
	readForkPins,
	replaceForkedSessionWithin,
} from "./fork-pins.js";
import {
	type CountedStatement,
	type ForkBlobCopy,
	ForkRowRuns,
	forkBlobCopy,
	incompleteEntryRead,
} from "./fork-row-copy.js";
import {
	createSharedHistoryTables,
	type SessionForkTables,
	sessionForkTables,
	sharedHistoryTablesScript,
} from "./fork-schema.js";
import { assertForkSegments, type ForkSegment, prefixForkSegments } from "./fork-segments.js";
import { tryCleanupForkStaging } from "./fork-staging-maintenance.js";
import { forkStoreRelation, nativeForkReader, registerForkScope } from "./fork-store-scope.js";
import {
	FORK_VIEW_END,
	type ForkView,
	type ForkViewTables,
	forkView,
	forkViewOf,
	forkViewParams,
	withForkViews,
} from "./fork-view.js";
import { announceHistoryLoad, hasHistoryLoadObserver } from "./history-load-observer.ts";
import { registerHistorySnapshot } from "./history-snapshot.js";
import {
	branchRanges,
	childCatalogCut,
	foldSessionResume,
	foreignResumeIds,
	isSessionResumeIndex,
	isUpgradableSessionResumeIndex,
	latestCompactionOf,
	RESUME_UPGRADE_SOURCES,
	readEarlierCompletionIntents,
	type SessionResumeIndex,
	selectedPagePlan,
	sessionResumeFrom,
	sessionResumePlan,
	sessionResumeUpgrade,
	sessionTailFrom,
	snapshotCutOf,
	stateSeqsBefore,
	transcriptBranchSpan,
} from "./session-resume.js";
import { SqlSessionSearchIndex, yieldTurn } from "./session-search-index.js";
import {
	applySessionSummaryEntries,
	materializeSessionSummaryMetadata,
	type SessionSummaryState,
	type SessionSummaryText,
} from "./session-summary.js";
import { sessionWriteTransaction } from "./session-transactions.js";
import { sharedHistorySwitchHost } from "./shared-history-switch.js";
import { noteSnapshotGeneration, registerArchiveLoad } from "./snapshot-generation.ts";
import { type SqlSessionChatRecords, sqlChatRecords } from "./sql-chat-records.js";
import { dropStoredNotes, storedEntryNotes, storedSeqOf } from "./stored-entries.js";
import type {
	ChildDisplayLaunch,
	ForkArchiveSource,
	OversizedSessionEntry,
	SessionBlob,
	SessionBranchPageCut,
	SessionCompactionPoint,
	SessionCwdMatcher,
	SessionEntriesPage,
	SessionEntriesQuery,
	SessionEntryAt,
	SessionEntryRange,
	SessionEntrySizes,
	SessionForkSeed,
	SessionForkStream,
	SessionHistoryItem,
	SessionListQuery,
	SessionOpenMarker,
	SessionOpenMarkerAge,
	SessionOpenMarkerStore,
	SessionRecordHeader,
	SessionResume,
	SessionScanOptions,
	SessionScanPage,
	SessionSnapshot,
	SessionSnapshotCut,
	SessionStore,
	SessionStoredEntry,
	SessionSummary,
	SessionTail,
	SessionTaskReferenceDuplicatePage,
	SessionTaskReferenceDuplicateQuery,
	SessionToolUseSelection,
	SessionTreeOutlineEntry,
	SessionWriteOptions,
	SessionWriteResult,
	StorageDescriptor,
} from "./types.js";
import {
	entrySizeLimit,
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
	SESSION_HISTORY_PAGE_ENTRIES,
	SESSION_TASK_REFERENCE_CANDIDATES,
	SESSION_TASK_REFERENCE_DUPLICATES_PAGE,
} from "./types.js";
import { validateSessionEntries, validateSessionHeader, validateSessionText } from "./validation.js";

/**
 * The newest sessions schema this build reads and writes. Version 2 stores long entries in chunks (#4954), which a build
 * that knows only version 1 would read as stubs. A database stays at version 1, which older builds still open, until
 * this build writes its first chunked entry: that transaction moves the sessions meta to 2, and older builds refuse it
 * when next opened with `StorageSchemaVersionError`. Builds before 2 check only the meta row, on SQLite and Postgres alike.
 * Version 3 turns on forks that share their parent's history ({@link SESSION_SCHEMA_VERSION_SHARED_HISTORY}).
 */
export const SESSION_SCHEMA_VERSION = 3;
/** The sessions schema of a database without chunked entries, which older builds read too. */
const SESSION_SCHEMA_VERSION_UNCHUNKED = 1;
/** The sessions schema the first chunked entry raises a version 1 database to, which builds since #4954 read. */
export const SESSION_SCHEMA_VERSION_CHUNKED = 2;
/**
 * The sessions schema in which a fork shares its parent's history instead of copying it (#6560). A new database's
 * sessions schema starts at it; a store's open, or `atomic storage migrate`, raises an older one to it by itself once
 * no session of an older build runs there (`SqlSessionStore.enableSharedHistoryForks`); a fork or any other write never
 * does. Builds that know only versions 1
 * and 2 refuse it, at their open and in every transaction, rather than read a fork's own rows as its whole history.
 * `SqlSessionStore.sharedHistoryForks(tx)` tells a transaction whether its database is there.
 */
export const SESSION_SCHEMA_VERSION_SHARED_HISTORY = 3;
/** The schema domain of the session tables in the prefix's migration ledger. */
export const SESSION_DOMAIN = "sessions";
/** The ledger step, `schema:session-fillfactor`, that sets the sessions table's fillfactor on PostgreSQL (#6560). */
export const SESSION_FILLFACTOR_DOMAIN = "session-fillfactor";
/** The fillfactor of the sessions table on PostgreSQL: a fifth of each page stays free for head row updates. */
const SESSION_ROW_FILLFACTOR = 80;
/**
 * The ledger step, `schema:session-append-function`, that creates the session append function on PostgreSQL (#6599).
 * Raise its revision whenever the function's body changes: `atomic storage migrate` of an older build then leaves the
 * newer body in place.
 */
export const SESSION_APPEND_FUNCTION_DOMAIN = "session-append-function";
const SESSION_APPEND_FUNCTION_REVISION = 1;
/**
 * The session append function's name under the store's prefix. The version in the name is the function's contract:
 * its arguments and what it answers. A build that needs another contract creates a function of a new name beside
 * this one, which builds that call this one keep using.
 */
const SESSION_APPEND_FUNCTION = "append_v1";
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
 * The bytes of a chunked message's JSON an unindexed fork reads to learn its role. The role follows the entry's type,
 * IDs and timestamp, a few hundred bytes in.
 */
const FORK_ROLE_PREFIX_BYTES = 4096;
/**
 * The most characters one read of entries or listing rows returns, by the stored text's `length()`. A character is at
 * most four bytes of UTF-8 and a JSON escape at most doubles a character on a server's wire, so a page stays under
 * sqld's 10 MB response limit; a single row longer than this is a page of its own (#4954).
 */
export const SESSION_READ_PAGE_CHARS = 1024 * 1024;
/** Maximum entries folded per resume metadata query. */
export const SESSION_RESUME_REBUILD = { pageEntries: 512 } as const;
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

/**
 * The staging table of full-session clones from a handle this store cannot prove to be its own connection (#5594):
 * `<prefix>session_fork_staging`, created by the first such clone, never by an open, and not part of the sessions schema.
 */
const SESSION_FORK_STAGING_TABLES = Object.freeze({ forkStaging: "fork_staging" });

/** The schema domain, in the prefix's migration ledger, of the table of open sessions (#4971). */
export const SESSION_PRESENCE_DOMAIN = "session-presence";
export const SESSION_PRESENCE_TABLES = Object.freeze({ open: "open" });

type Tables = Readonly<Record<keyof typeof SESSION_TABLES, string>>;

/** The reads that begin a fork with shared history: see `SqlSessionStore.sharedForkReads`. */
interface SharedForkReads {
	/** The sessions the lock read locks, in id order. */
	readonly ids: readonly string[];
	readonly exists: SqliteStatement;
	readonly lock: SqliteStatement;
	readonly tombstones: SqliteStatement;
	readonly segments: SqliteStatement;
}

/** A fork's donor, locked, with the segments that say where its view's rows are stored (#6560). */
interface SharedForkDonor {
	readonly lastSeq: number;
	readonly epoch: string;
	readonly segments: readonly ForkSegment[];
	readonly state?: StoredSummaryState;
}

/** The donor's segments name a session the fork did not lock: the fork runs again, locking it too (#6560). */
class ForkSourcesMoved extends Error {
	constructor() {
		super("The fork's source moved its history while the fork read it");
	}
}
/** An entry a write stores, at seq `seq`, as `json`: see `SqlSessionStore.noteWritten`. */
interface WrittenEntry {
	readonly entry: SessionEntry;
	readonly seq: number;
	readonly json: string;
}

/** The columns of a session's row that an append plans from, as a write of this store left them. */
type WrittenRow = {
	readonly header_json: string;
	readonly summary_state: string;
	readonly revision: string;
	readonly last_seq: number;
};
/** What the session append function answers: what it did, and the value its outcome names. */
type AppendOutcomeRow = SqliteRow & { outcome: string; detail: string | null };
type HeaderRow = SqliteRow & { header_json: string; last_seq: number };
type SummaryStateRow = HeaderRow & { summary_state: string };
type ResumeRow = SummaryStateRow & { revision: string };

type StoredSummaryState = SessionSummaryState & {
	readonly resume?: SessionResumeIndex | { readonly version: number; readonly seq: number; readonly epoch?: string };
	readonly windowResume?: SessionResumeIndex;
	readonly epoch?: string;
};

function windowIndex(state: StoredSummaryState, seq: number): SessionResumeIndex | undefined {
	return isSessionResumeIndex(state.windowResume, seq)
		? state.windowResume
		: isSessionResumeIndex(state.resume, seq)
			? state.resume
			: undefined;
}

/** An older client rebuilds summary_state.resume in its own format. Do not evict that valid projection
 * on a read: once either side sees a version-5 index, keep this version in its own field. */
function windowFields(
	previous: StoredSummaryState | undefined,
	index: SessionResumeIndex | undefined,
	seq: number,
	epoch: string,
): Pick<StoredSummaryState, "resume" | "windowResume"> {
	if (previous?.resume?.version === 5 || previous?.windowResume) {
		const older = previous.resume;
		return {
			...(older?.version === 5 && older.seq === seq && older.epoch === epoch ? { resume: older } : {}),
			...(index ? { windowResume: index } : {}),
		};
	}
	return index ? { resume: index } : {};
}

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
/**
 * The seqs of a shared history one page of a selective scan reads at most (#6560): the page then accounts for the range
 * through them, and the next page reads the next ones.
 */
const SCAN_SELECT_WINDOW = 4096;
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
/**
 * A session read: one snapshot that takes no write lock, so it neither waits for writers nor makes them wait. Its
 * statements all run in that snapshot: split into separate ones, a read could join rows of two generations.
 */
const SESSION_READ: SqliteTransactionOptions = { retryTransientFailures: true, readOnly: true };

/** The largest content index or suffix length a task-reference query binds, an SQL `INTEGER` on every backend. */
const TASK_REFERENCE_INTEGER = 2 ** 31 - 1;

/**
 * A task-reference duplicate query's bounds, checked, and its candidates as `[seq, block or -1, suffix or 0]` rows:
 * integers only, so no entry ID is ever bound.
 */
function taskReferenceDuplicateQuery(query: SessionTaskReferenceDuplicateQuery): {
	readonly candidates: readonly (readonly [number, number, number])[];
	readonly afterSeq: number;
	readonly limit: number;
} {
	const within = (value: unknown, min: number, max: number) =>
		Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
	const { throughSeq, afterSeq = 0, limit = SESSION_TASK_REFERENCE_DUPLICATES_PAGE } = query;
	const invalid = (what: string) => new RangeError(`Invalid task-reference duplicate query: ${what}`);
	if (!within(throughSeq, 0, Number.MAX_SAFE_INTEGER)) throw invalid("throughSeq");
	if (!within(afterSeq, 0, Number.MAX_SAFE_INTEGER)) throw invalid("afterSeq");
	if (!within(limit, 1, SESSION_TASK_REFERENCE_DUPLICATES_PAGE)) throw invalid("limit");
	if (query.candidates.length > SESSION_TASK_REFERENCE_CANDIDATES) throw invalid("too many candidates");
	const candidates = query.candidates.map(({ seq, contentIndex, suffixChars }) => {
		if (!within(seq, 1, throughSeq)) throw invalid("candidate seq");
		if (contentIndex !== undefined && !within(contentIndex, 0, TASK_REFERENCE_INTEGER))
			throw invalid("candidate contentIndex");
		if (suffixChars !== undefined && !within(suffixChars, 0, TASK_REFERENCE_INTEGER))
			throw invalid("candidate suffixChars");
		return [seq, contentIndex ?? -1, contentIndex === undefined ? (suffixChars ?? 0) : 0] as const;
	});
	return { candidates, afterSeq, limit };
}

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

async function entryByteLengthOf(database: SqliteDatabase): Promise<(expression: string) => string> {
	const dialect = dialectOf(database);
	if (dialect.name !== "sqlite") return dialect.textByteLength;
	try {
		await database.get("SELECT octet_length('') AS bytes");
		return (expression) => `octet_length(${expression})`;
	} catch {
		return dialect.textByteLength;
	}
}

/**
 * The most bytes of statements a session write sends as one batch: an ordinary message's are far fewer. A larger
 * write, an import or a fork's whole window, runs its statements one at a time as they are made.
 */
const STATEMENT_BATCH_BYTES = 1024 * 1024;

/** The most sessions whose last written row a store remembers for appends through the append function. */
const WRITTEN_ROWS = 64;

/** About how many bytes `statement` carries: its text and its parameters. */
function statementBytes(statement: SqliteStatement): number {
	let bytes = statement.sql.length;
	for (const value of statement.params) {
		if (typeof value === "string") bytes += value.length;
		else if (value instanceof Uint8Array) bytes += value.byteLength;
		else bytes += 8;
	}
	return bytes;
}

/**
 * Writes of one transaction sent without waiting for each answer: the connection runs them in the order they were
 * sent, behind the transaction's earlier calls and ahead of its later ones, so a read made after `send` sees them. On a
 * pipelined connection they share round trips instead of taking one each. At most `STATEMENT_BATCH_BYTES` of them are
 * unanswered at a time. `settle` waits for every one sent and throws the first that failed.
 */
class SentWrites {
	private readonly tx: SqliteExecutor;
	private readonly sent: Promise<void>[] = [];
	private unansweredBytes = 0;
	private failure: { readonly error: unknown } | undefined;

	constructor(tx: SqliteExecutor) {
		this.tx = tx;
	}

	/** Sends `statements`; a counted one fails when its answer reports another number of changed rows. */
	async send(statements: Iterable<CountedStatement>): Promise<void> {
		for (const statement of statements) {
			const { changes, mismatch } = statement;
			this.sent.push(
				this.tx.run(statement.sql, ...statement.params).then(
					(result) => {
						if (changes !== undefined && result.changes !== changes)
							this.failure ??= {
								error:
									mismatch?.() ??
									new StorageError(`A write changed ${result.changes} rows where ${changes} were expected`),
							};
					},
					(error: unknown) => {
						this.failure ??= { error };
					},
				),
			);
			this.unansweredBytes += statementBytes(statement);
			if (this.unansweredBytes > STATEMENT_BATCH_BYTES) await this.settle();
		}
	}

	async settle(): Promise<void> {
		await Promise.all(this.sent.splice(0));
		this.unansweredBytes = 0;
		if (this.failure !== undefined) throw this.failure.error;
	}

	/** Settles after `body`, and reports the first write that failed before what `body` met, as its cause. */
	async around<T>(body: () => Promise<T>): Promise<T> {
		let value: T;
		try {
			value = await body();
		} catch (error) {
			await this.settle();
			throw error;
		}
		await this.settle();
		return value;
	}
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
	private chatStore?: SqlSessionChatRecords;
	/** The database's reader handle, once a read opened it: see `readerDatabase`. */
	private reader?: Promise<SqliteDatabase>;
	/** The sessions schema version each transaction read first, by its handle: see `sharedHistoryForks`. */
	private readonly schemaVersions = new WeakMap<SqliteExecutor, Promise<number>>();
	/** The fork tables under this store's prefix, which exist once its sessions schema is version 3 (#6560). */
	private readonly forkTables: SessionForkTables;
	/**
	 * Whether a read of this store found its sessions schema at {@link SESSION_SCHEMA_VERSION_SHARED_HISTORY}: one way,
	 * as the switch is. A read outside a transaction reads sessions through their views once it is set, and before that
	 * reads the tables themselves on the condition, checked in the read's own snapshot, that the schema is older.
	 */
	private sharedHistorySeen = false;
	/** For each transaction, whether each session whose row it read has fork segments, as that read found (#6560). */
	private readonly forkedIn = new WeakMap<SqliteExecutor, Map<string, boolean>>();
	/** Whether each recently read session had fork segments: only a first guess, which a read checks (#6560). */
	private readonly forkedSessions = new Map<string, boolean>();
	/** The sessions each recently forked session's segments named when this store last read them (#6560). */
	private readonly forkSources = new Map<string, readonly string[]>();
	/**
	 * Absent on a local libSQL file, which then behaves as before: @libsql/client waits for another process's write
	 * lock on the calling thread, even to begin a transaction, so a side write would stop the event loop where an
	 * ordinary turn-ending notice writes nothing (#5682).
	 */
	get chatRecords(): SqlSessionChatRecords | undefined {
		const { adapter, location } = this.database.descriptor;
		if (adapter === "libsql" && /^file:/i.test(location)) return undefined;
		if (!this.chatStore) {
			const names = renderStorageIdentifiers(
				"sessions",
				{ rows: "chat_v1", byAnchor: "chat_v1_anchor" },
				this.prefix,
			);
			this.chatStore = sqlChatRecords(
				this.database,
				this.tables.sessions,
				names.rows,
				names.byAnchor,
				storageMigrationTable(this.prefix),
			);
		}
		return this.chatStore;
	}
	private readonly entryByteLength: (expression: string) => string;
	private chunkRowids?: boolean;
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
	private readonly forkStagingTable: string;
	/** The generation each recently read session's row held at a revision: see `generation`. */
	private readonly generations = new Map<
		string,
		{ readonly revision: string; readonly lastSeq: number; readonly epoch: string }
	>();
	/**
	 * The session append function of this store's tables, when the open found it and this role may run it (#6599):
	 * `atomic storage migrate` creates it. Absent elsewhere, where appends take their two round trips as before.
	 */
	private readonly appendFunction?: string;
	/** The row each recent write of this store left for its session, which an append through the function plans from. */
	private readonly writtenRows = new Map<string, WrittenRow>();

	private constructor(
		database: SqliteDatabase,
		tables: Tables,
		prefix: string | undefined,
		cwdMatcher: SessionCwdMatcher | undefined,
		snapshotBlobs: SqlSnapshotBlobStore,
		legacyBlobData: boolean,
		searchIndex: SqlSessionSearchIndex | undefined,
		entryByteLength: (expression: string) => string,
		appendFunction?: string,
	) {
		this.database = database;
		if (appendFunction !== undefined) this.appendFunction = appendFunction;
		this.dialect = dialectOf(database);
		this.entryByteLength = entryByteLength;
		this.tables = tables;
		this.prefix = prefix ?? "";
		registerForkScope(this, () => {
			const identity = this.database.databaseIdentity?.();
			return {
				kind: "sql",
				backing: this.database,
				prefix: this.prefix,
				...(identity === undefined ? {} : { identity }),
			};
		});
		this.cwdMatcher = cwdMatcher;
		this.snapshotBlobs = snapshotBlobs;
		this.blobTable = snapshotBlobs;
		this.legacyBlobData = legacyBlobData;
		if (searchIndex !== undefined) this.searchIndex = searchIndex;
		registerHistorySnapshot(this, (sessionId, project) => {
			this.assertOpen();
			validateSessionText("sessionId", sessionId);
			return this.readTransaction(async (tx) => {
				const head = await this.historyHead(tx, sessionId, true);
				return project(head.epoch, head.lastSeq, (from, through, backward) =>
					this.historyPacket(tx, sessionId, head.epoch, from, through, backward),
				);
			});
		});
		this.forkStagingTable = renderStorageIdentifiers("sessions", SESSION_FORK_STAGING_TABLES, prefix).forkStaging;
		this.forkTables = sessionForkTables(prefix);
	}

	/** Bind an existing transcript for the storage search command. No schema setup, markers or search index. */
	static async openTranscriptReader(database: SqliteDatabase & { readonly readOnly: true }): Promise<SessionStore> {
		const tables = renderStorageIdentifiers("sessions", SESSION_TABLES);
		const reader = new SqlSessionStore(
			database,
			tables,
			undefined,
			undefined,
			SqlSnapshotBlobStore.forTranscriptReader(database),
			false,
			undefined,
			await entryByteLengthOf(database),
		);
		await reader.assertReadableSchema(database);
		return reader;
	}

	static async open(
		database: SqliteDatabase,
		options: { readonly prefix?: string; readonly cwdMatcher?: SessionCwdMatcher } = {},
	): Promise<SqlSessionStore> {
		validateStoragePrefix(options.prefix, dialectOf(database).name);
		// One read of the schema for every table set the open checks: where it is current, the open runs no schema
		// transaction and takes no lock, so processes starting together do not queue behind one another (#6560).
		return withStorageSchemaCatalog(database, storageMigrationTable(options.prefix), () =>
			SqlSessionStore.openWithCatalog(database, options),
		);
	}

	private static async openWithCatalog(
		database: SqliteDatabase,
		options: { readonly prefix?: string; readonly cwdMatcher?: SessionCwdMatcher },
	): Promise<SqlSessionStore> {
		const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, options.prefix);
		let legacyBlobData = false;
		const forkTables = sessionForkTables(options.prefix);
		// Whether this open created the sessions schema, at the version of shared-history forks.
		let createdShared = false;
		const createTables = async (tx: SqliteExecutor, dialect: StorageDialect) => {
			const { int, text, blob } = dialect.types;
			const strict = dialect.tableOptions;
			const json = (column: string) => dialect.jsonValid(column);
			const columnExists = (table: string, column: string) => {
				const probe = dialect.columnExists(table, column);
				return async () => (await tx.get(probe.sql, ...probe.params)) !== undefined;
			};
			const [versions] = await statementBatch(
				tx,
				[`CREATE TABLE IF NOT EXISTS ${tables.meta} (schema_version ${int} NOT NULL)${strict}`],
				[() => tx.all(`SELECT schema_version FROM ${tables.meta}`)],
			);
			for (const version of versions) {
				assertStorageSchemaVersion(
					"sessions",
					version.schema_version!,
					SESSION_SCHEMA_VERSION,
					SESSION_SCHEMA_VERSION_UNCHUNKED,
				);
			}
			// The sessions table is ordered by insertion to notice changes, and entries for the snapshot reference index.
			const tablesScript = `
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
			`;
			// A new database has no older build to wait for (#6560): its sessions schema starts at the version of
			// shared-history forks, with their tables, in this transaction, so its open costs no switch of its own. An
			// older build that set the schema up first wrote its version here, and the switch waits for its sessions.
			const created = versions.length === 0;
			const [revision, data] = await statementBatch(
				tx,
				[
					created && {
						sql: `INSERT INTO ${tables.meta} VALUES (?)`,
						params: [SESSION_SCHEMA_VERSION_SHARED_HISTORY],
					},
					tablesScript,
					created && sharedHistoryTablesScript(dialect, forkTables),
					created &&
						dialect.versionedMigrations && {
							sql: `INSERT INTO ${storageMigrationTable(options.prefix)} (domain, version, applied_at) VALUES (?, ?, ${dialect.nowMs}) ON CONFLICT DO NOTHING`,
							params: [SESSION_DOMAIN, SESSION_SCHEMA_VERSION_SHARED_HISTORY],
						},
				],
				[columnExists(tables.sessions, "revision"), columnExists(tables.blobs, "data")],
			);
			createdShared = created;
			legacyBlobData = data;
			const [chunks] = legacyBlobData
				? await statementBatch(tx, [], [columnExists(tables.blobs, "chunks")])
				: [true];
			await statementBatch(
				tx,
				[
					// Sessions tables created before the write revision gain it; their rows pick one up on the next write.
					!revision && `ALTER TABLE ${tables.sessions} ADD COLUMN revision ${text} NOT NULL DEFAULT ''`,
					!chunks && `ALTER TABLE ${tables.blobs} ADD COLUMN chunks ${int} NOT NULL DEFAULT -1`,
				],
				[],
			);
		};
		const orphanedEntryKeys = `SELECT k.session_id, k.seq
			FROM (SELECT DISTINCT session_id, seq FROM ${tables.entryChunks}) AS k
			WHERE NOT EXISTS (
				SELECT 1 FROM ${tables.entries} AS e
				WHERE e.session_id = k.session_id AND e.seq = k.seq AND e.chunks > 0
			)`;
		const removeOrphanedEntryChunks = {
			sql: `DELETE FROM ${tables.entryChunks} WHERE (session_id, seq) IN (${orphanedEntryKeys})`,
			params: [],
		};
		/**
		 * Long entries in chunks (#4954): the entry chunks table and the entries table's `chunks` column, 0 for an entry
		 * stored whole, as every entry written before it was. Older builds read and write these tables unchanged, so the
		 * sessions meta stays where it is until the first chunked entry (`insertEntries`). Setup is idempotent and runs
		 * when the open finds the schema not current (`currentSchema`).
		 */
		const addEntryChunks = async (tx: SqliteExecutor, dialect: StorageDialect) => {
			const { int, text, blob } = dialect.types;
			const probe = dialect.columnExists(tables.entries, "chunks");
			const [chunks] = await statementBatch(
				tx,
				[
					`
				CREATE TABLE IF NOT EXISTS ${tables.entryChunks} (
					session_id ${text} NOT NULL, seq ${int} NOT NULL, idx ${int} NOT NULL, data ${blob} NOT NULL,
					PRIMARY KEY(session_id, seq, idx)
				)${dialect.tableOptions};
			`,
				],
				[() => tx.get(probe.sql, ...probe.params)],
			);
			await statementBatch(
				tx,
				[
					chunks === undefined && `ALTER TABLE ${tables.entries} ADD COLUMN chunks ${int} NOT NULL DEFAULT 0`,
					database.readOnly !== true && removeOrphanedEntryChunks,
				],
				[],
			);
		};
		const presence = renderStorageIdentifiers("sessions", SESSION_PRESENCE_TABLES, options.prefix);
		// A SQLite schema records no ledger, so its idempotent setup would run, under the write lock, at every open. A
		// schema that is current skips it: on a server many processes share, each open otherwise held the write lock for a
		// dozen round trips while every other writer waited (#4768). Such an open writes only when it finds entry chunks
		// an older process left behind, which it removes in one transaction that checks the schema version first (#5065).
		// The removal is housekeeping, since no read reaches those rows and a chunked write first deletes its key's rows,
		// so a connection that refuses writes still opens; a newer schema is still refused.
		const current = await SqlSessionStore.currentSchema(
			database,
			tables,
			presence.open,
			database.readOnly === true ? undefined : orphanedEntryKeys,
		);
		let sharedHistory: boolean | undefined;
		if (current !== undefined) {
			legacyBlobData = current.legacyBlobData;
			sharedHistory = current.sharedHistory;
			if (current.orphaned)
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
						await tx.run(removeOrphanedEntryChunks.sql);
					})
					.catch((error: Error) => {
						if (error instanceof StorageSchemaVersionError) throw error;
					});
		} else {
			const [sessionsSchema] = await applyStorageMigrationsTogether(database, [
				{
					domain: SESSION_DOMAIN,
					steps: [
						{ version: 1, up: createTables },
						{ version: 2, up: addEntryChunks },
					],
					// Version 3 is recorded by the switch to shared-history forks (`enableSharedHistoryForks`), or by step 1
					// when it creates a new database's schema at it; builds without it refuse it here, before their snapshot or
					// search index opens (#6560).
					options: {
						table: storageMigrationTable(options.prefix),
						recordedThrough: SESSION_SCHEMA_VERSION_SHARED_HISTORY,
					},
				},
				// A domain of its own, so Atomic versions that do not know it keep opening the sessions tables (#4971). Its
				// later steps must stay additive: a build that knows fewer of them accepts a newer version and keeps marking
				// (#5065).
				{
					domain: SESSION_PRESENCE_DOMAIN,
					steps: [
						{ version: 1, up: (tx, dialect) => SqlSessionOpenMarkers.createTable(tx, dialect, presence.open) },
						{
							version: 2,
							up: (tx, dialect) => SqlSessionOpenMarkers.addSchemaVersion(tx, dialect, presence.open),
						},
						{ version: 3, up: (tx, dialect) => SqlSessionOpenMarkers.addBuild(tx, dialect, presence.open) },
					],
					options: { table: storageMigrationTable(options.prefix), acceptNewer: true },
				},
			]);
			// Where versions are recorded, the ledger tells whether the switch below ran already; elsewhere it reads. A
			// schema this open created is at that version already, and the catalog it read learns of the fork tables.
			if (createdShared) {
				sharedHistory = true;
				noteStorageSchemaTables(database, Object.values(forkTables));
			} else if (dialectOf(database).versionedMigrations)
				sharedHistory = (sessionsSchema?.version ?? 0) >= SESSION_SCHEMA_VERSION_SHARED_HISTORY;
		}
		// Room on each page for the session row's next version, which every append writes, so it stays a HOT update
		// (#6560). PostgreSQL only; a runtime role leaves it to `atomic storage migrate`.
		await ensureTableFillfactor(database, {
			ledger: storageMigrationTable(options.prefix),
			domain: SESSION_FILLFACTOR_DOMAIN,
			revision: 1,
			table: tables.sessions,
			fillfactor: SESSION_ROW_FILLFACTOR,
		});
		const markers = new SqlSessionOpenMarkers(database, presence.open, () => store.assertOpen());
		// Shared-history forks turn on by themselves (#6560). An open that found them on reads nothing more for it; one
		// that switched the database refreshes the catalog it read, so the stores it opens next see the fork tables.
		let shared = sharedHistory === true;
		if (sharedHistory !== true && database.readOnly !== true) {
			const switched = await SqlSessionStore.switchAtOpen(
				database,
				options.prefix ?? "",
				tables,
				markers,
				sharedHistory === false,
			);
			if (switched) refreshStorageSchemaCatalog(database);
			shared = switched;
		}
		// Whether a staged clone ever ran here (#5594), asked beside the rest of the open rather than after it.
		const staging = renderStorageIdentifiers("sessions", SESSION_FORK_STAGING_TABLES, options.prefix).forkStaging;
		const stagingProbe = dialectOf(database).tableExists(staging);
		const catalog = await schemaCatalogOf(database);
		const staged =
			database.readOnly === true || !database.tryMaintenance
				? Promise.resolve(false)
				: catalog !== undefined
					? Promise.resolve(catalog.hasTable(staging))
					: database.get(stagingProbe.sql, ...stagingProbe.params).then(
							(row) => row !== undefined,
							() => false,
						);
		// Neither the snapshot tables nor the search index depend on the other. Where the sessions schema was current,
		// theirs most likely is too and opening them only reads, so those reads go together. Otherwise the snapshot
		// tables are set up first, in a transaction of their own as before: set up together, the two transactions would
		// share one group commit and pay a savepoint each.
		const opening = current === undefined ? await SqlSnapshotBlobStore.open(database, options.prefix) : undefined;
		const [blobs, searchIndex, entryByteLength] = await Promise.all([
			opening ?? SqlSnapshotBlobStore.open(database, options.prefix),
			SqlSessionSearchIndex.open(database, tables, options.prefix),
			entryByteLengthOf(database),
		]);
		// The append function `atomic storage migrate` creates, found by the catalog read the open made anyway (#6599). A
		// facade or blob store loaded from an earlier release, as a process updated in place can hold, lacks what an
		// append through it needs, and appends as before.
		const appendFunction = renderStorageIdentifiers(
			"sessions",
			{ append: SESSION_APPEND_FUNCTION },
			options.prefix,
		).append;
		const appendsThroughFunction =
			catalog?.hasFunction?.(appendFunction) === true &&
			database.autocommit !== undefined &&
			typeof blobs.storedBlobsQuery === "function";
		const store = new SqlSessionStore(
			database,
			tables,
			options.prefix,
			options.cwdMatcher,
			blobs,
			legacyBlobData,
			searchIndex,
			entryByteLength,
			appendsThroughFunction ? appendFunction : undefined,
		);
		store.openMarkers = markers;
		// The switch is one way: what the open found or made holds for every later transaction.
		if (shared) store.noteSchemaVersion(SESSION_SCHEMA_VERSION_SHARED_HISTORY);
		if (await staged) await store.cleanupForkStaging();
		return store;
	}

	/**
	 * Removes, in a bounded number of short transactions, the staged rows of clones that stopped mid-copy and whose lease
	 * lapsed (#5594). Housekeeping: nothing reads those rows, so a failure leaves them to a later open or clone.
	 */
	private async cleanupForkStaging(): Promise<void> {
		try {
			await tryCleanupForkStaging(this.database, this.dialect, this.forkStagingTable);
		} catch {}
	}

	/**
	 * What the open's setup would find, read without the write lock, when its schema steps would change nothing: every
	 * table and column of both domains exists and the sessions meta holds only versions this build supports. Undefined
	 * otherwise, and always on a database with versioned migrations, whose ledger the setup checks. Leftover entry
	 * chunks are not part of the schema: `orphaned` tells whether the query `orphans` finds any, for the open to remove
	 * them separately, and is false when it is not asked. The probes are read together, then the versions with that
	 * query, so a current schema waits for two answers.
	 */
	private static async currentSchema(
		database: SqliteDatabase,
		tables: Tables,
		open: string,
		orphans: string | undefined,
	): Promise<
		{ readonly legacyBlobData: boolean; readonly orphaned: boolean; readonly sharedHistory: boolean } | undefined
	> {
		const dialect = dialectOf(database);
		if (dialect.versionedMigrations) return undefined;
		const required = [...Object.values(tables), open];
		const columns = [
			[tables.sessions, "revision"],
			[tables.entries, "chunks"],
			[tables.blobs, "chunks"],
			[open, "schema_version"],
			[open, "build"],
		] as const;
		// One read of the catalog answers every probe: on a server, one request instead of a request each (#6560).
		const reading = schemaCatalogOf(database);
		// The versions, and the leftover chunks, are asked beside the schema, so a current one waits for one answer: they
		// count only where every table and column is found, and fail unheard on a database that lacks them.
		const orphaned =
			orphans === undefined ? undefined : database.get(`SELECT 1 FROM (${orphans}) AS orphaned LIMIT 1`);
		orphaned?.catch(() => {});
		const versionsRead = database.all(`SELECT schema_version FROM ${tables.meta}`);
		versionsRead.catch(() => {});
		let legacyBlobs: boolean;
		const catalog = await reading;
		if (catalog !== undefined) {
			const present =
				required.every((table) => catalog.hasTable(table)) &&
				columns.every(([table, column]) => catalog.hasColumn(table, column));
			if (!present) return undefined;
			legacyBlobs = catalog.hasColumn(tables.blobs, "data");
		} else {
			const probes = [
				...required.map((table) => dialect.tableExists(table)),
				...columns.map(([table, column]) => dialect.columnExists(table, column)),
			];
			const legacy = dialect.columnExists(tables.blobs, "data");
			const [legacyFound, ...found] = await Promise.all(
				[legacy, ...probes].map((probe) => database.get(probe.sql, ...probe.params)),
			);
			if (!found.every((row) => row !== undefined)) return undefined;
			legacyBlobs = legacyFound !== undefined;
		}
		const versions = await versionsRead;
		if (
			versions.length === 0 ||
			versions.some(
				(row) =>
					typeof row.schema_version !== "number" ||
					!Number.isInteger(row.schema_version) ||
					row.schema_version < SESSION_SCHEMA_VERSION_UNCHUNKED ||
					row.schema_version > SESSION_SCHEMA_VERSION,
			)
		)
			return undefined;
		return {
			legacyBlobData: legacyBlobs,
			orphaned: (await orphaned) !== undefined,
			sharedHistory: versions.every((row) => Number(row.schema_version) >= SESSION_SCHEMA_VERSION_SHARED_HISTORY),
		};
	}

	/**
	 * A transaction that first checks the sessions schema version again: a newer build may have upgraded the database
	 * since this store opened it, and what it writes then is not this build's to read or write (#5065).
	 */
	private transaction<T>(body: (tx: SqliteExecutor) => Promise<T>, options: SqliteTransactionOptions): Promise<T> {
		return this.database.transaction(async (tx) => {
			await this.assertReadableSchema(tx);
			return body(tx);
		}, this.checkedFirst(options));
	}

	/**
	 * `options` with the schema check its transaction makes first, before the reads `options.leading` names, sent with
	 * the transaction's start where the connection is pipelined.
	 */
	private checkedFirst(options: SqliteTransactionOptions): SqliteTransactionOptions {
		return { ...options, leading: [this.schemaCheck(), ...(options.leading ?? [])] };
	}

	/**
	 * `transaction` for a write to the rows of the session `sessionId` only, beside writers of other sessions. `leading`
	 * names the reads the body makes first, after the schema check.
	 */
	private sessionWrite(sessionId: string, ...leading: readonly SqliteStatement[]): SqliteTransactionOptions {
		const options = sessionWriteTransaction(this.tables.sessions, sessionId);
		return leading.length === 0 ? options : { ...options, leading };
	}

	/**
	 * `transaction` for a body that only reads, in one read-only snapshot, on the database's reader handle when it
	 * offers one: its reads then wait for neither the writes queued on this store's connection nor their locks.
	 */
	private async readTransaction<T>(
		body: (tx: SqliteExecutor) => Promise<T>,
		leading: readonly SqliteStatement[] = [],
	): Promise<T> {
		const database = await this.readerDatabase();
		return database.transaction(
			async (tx) => {
				await this.assertReadableSchema(tx);
				return body(tx);
			},
			this.checkedFirst(leading.length === 0 ? SESSION_READ : { ...SESSION_READ, leading }),
		);
	}

	/**
	 * The database's reader handle, opened at the first read and closed with the store; the database without one. A
	 * reader that cannot open, such as when its file can no longer be opened anew, leaves the read on the store's own
	 * connection, as every read ran before readers, and the next read tries to open one again.
	 */
	private readerDatabase(): Promise<SqliteDatabase> | SqliteDatabase {
		if (this.database.openReader === undefined) return this.database;
		this.reader ??= this.database.openReader().catch((error: Error) => {
			this.reader = undefined;
			throw error;
		});
		return this.reader.catch(() => this.database);
	}

	/**
	 * `transaction` for a body that only reads and writes the database. The version check is sent first, as there, but on
	 * a connection thread the body's first reads go behind it without waiting for its answer: one wait for the thread
	 * fewer. The body awaits `checked` before its first write, so nothing is written unless the version is one this build
	 * reads (its answer came before the reads', so that costs no wait); a version this build does not support is the
	 * failure reported, whatever the body met.
	 */
	private transactionCheckedAlongside<T>(
		body: (tx: SqliteExecutor, checked: Promise<void>) => Promise<T>,
		options: SqliteTransactionOptions,
	): Promise<T> {
		return this.database.transaction(async (tx) => {
			if (sequenceRunner(tx) === undefined) {
				await this.assertReadableSchema(tx);
				return body(tx, Promise.resolve());
			}
			const checked = this.assertReadableSchema(tx);
			checked.catch(() => {});
			const outcome = await body(tx, checked).then(
				(value) => ({ value }),
				(failure: unknown) => ({ failure }),
			);
			await checked;
			if ("failure" in outcome) throw outcome.failure;
			return outcome.value;
		}, this.checkedFirst(options));
	}

	/** The read that checks the sessions schema version, which every transaction of this store makes first. */
	private schemaCheck(): SqliteStatement {
		return { sql: `SELECT schema_version FROM ${this.tables.meta}`, params: [] };
	}

	/**
	 * Reads the sessions schema version through `executor` and refuses one this build does not read. The answer is kept
	 * for `executor`, a transaction's own handle, so {@link sharedHistoryForks} costs that transaction no read.
	 */
	private assertReadableSchema(executor: SqliteExecutor): Promise<void> {
		const check = this.schemaCheck();
		const version = executor.get(check.sql, ...check.params).then((row) => {
			const found = row?.schema_version ?? null;
			assertStorageSchemaVersion("sessions", found, SESSION_SCHEMA_VERSION, SESSION_SCHEMA_VERSION_UNCHUNKED);
			this.noteSchemaVersion(found as number);
			return found as number;
		});
		this.schemaVersions.set(executor, version);
		return version.then(() => {});
	}

	/**
	 * Whether the database `tx` runs in has forks that share their parent's history turned on: its sessions schema, as
	 * `tx` read it, is {@link SESSION_SCHEMA_VERSION_SHARED_HISTORY} (#6560). Every transaction of this store reads the
	 * version first, so this costs no further read there; `tx` of any other transaction reads it once. Asked again in each
	 * transaction, never kept on the store: another process may turn the forks on at any time, and the switch is one way,
	 * so an answer read before it only means a fork is copied.
	 */
	async sharedHistoryForks(tx: SqliteExecutor): Promise<boolean> {
		if (!this.schemaVersions.has(tx)) await this.assertReadableSchema(tx);
		return (await this.schemaVersions.get(tx)!) >= SESSION_SCHEMA_VERSION_SHARED_HISTORY;
	}

	/** Notes a sessions schema version a read of this store found: see {@link sharedHistorySeen}. */
	private noteSchemaVersion(version: number | null | undefined): void {
		if (typeof version === "number" && version >= SESSION_SCHEMA_VERSION_SHARED_HISTORY)
			this.sharedHistorySeen = true;
	}

	/** How transaction `tx` reads a session's rows: through its view where its database has shared history (#6560). */
	private async viewTables(tx: SqliteExecutor, sessionId?: string): Promise<ForkViewTables> {
		// A session that the transaction's own read of its row found without segments reads its tables directly, as a
		// database without shared history does: the same statements and plans, in the same snapshot (#6560).
		const plain = sessionId !== undefined && this.forkedIn.get(tx)?.get(sessionId) === false;
		return {
			segments: !plain && (await this.sharedHistoryForks(tx)) ? this.forkTables.forkSegments : undefined,
			dialect: this.dialect,
		};
	}

	/**
	 * A column, `forked`, of a read of a sessions row whose id is `id`: 1 when the session has fork segments (#6560),
	 * found by the segments' key. Only where `segments`, the fork segments table, exists.
	 */
	private forkedColumn(segments: string | undefined, id = "id"): string {
		return segments === undefined
			? ""
			: `, CASE WHEN EXISTS (SELECT 1 FROM ${segments} WHERE session_id = ${id}) THEN 1 ELSE 0 END AS forked`;
	}

	/**
	 * Notes what a read of session `sessionId`'s row in transaction `tx` found, `forked` from {@link forkedColumn}: the
	 * transaction's later reads of a session without segments read its tables directly. The store remembers it too, as a
	 * first guess for a read that sends its statements before that row's answer, and checks it against that answer.
	 */
	private noteForked(tx: SqliteExecutor | undefined, sessionId: string, forked: SqliteValue | undefined): void {
		if (forked === undefined || forked === null) return;
		const value = Number(forked) === 1;
		if (tx !== undefined) {
			const known = this.forkedIn.get(tx) ?? new Map<string, boolean>();
			this.forkedIn.set(tx, known);
			known.set(sessionId, value);
		}
		this.forkedSessions.delete(sessionId);
		this.forkedSessions.set(sessionId, value);
		while (this.forkedSessions.size > 256) this.forkedSessions.delete(this.forkedSessions.keys().next().value!);
	}

	/**
	 * How a read outside a transaction reads a session's rows: through its view once this store has seen shared history,
	 * and otherwise from the tables themselves, but only while the schema, read in the same statement, is older. Such a
	 * read that finds nothing asks `outsideTransaction` to try again.
	 */
	private outsideViewTables(): ForkViewTables {
		const version = `(SELECT max(schema_version) FROM ${this.tables.meta})`;
		return this.sharedHistorySeen
			? {
					segments: this.forkTables.forkSegments,
					dialect: this.dialect,
					guard: `${version} <= ${SESSION_SCHEMA_VERSION}`,
				}
			: {
					segments: undefined,
					dialect: this.dialect,
					guard: `${version} < ${SESSION_SCHEMA_VERSION_SHARED_HISTORY}`,
				};
	}

	/**
	 * `read`, a read outside a transaction of a session's rows through `outsideViewTables`, once more through the views
	 * when it found nothing (`found` says) before this store had seen shared history, and the schema, read after it, is
	 * now at version 3: the read's own check then held its rows back. The switch is one way, so a schema older than 3
	 * read after the read was older at the read too, and its answer stands.
	 */
	private async outsideTransaction<T>(read: (tables: ForkViewTables) => Promise<T>, found: (value: T) => boolean) {
		const seen = this.sharedHistorySeen;
		const value = await read(this.outsideViewTables());
		if (found(value)) return value;
		return (await this.schemaNowShared(seen)) ? read(this.outsideViewTables()) : value;
	}

	/**
	 * `read`, a read outside a transaction of session `sessionId`'s rows that also reads, as `forked`, whether the
	 * session has fork segments, through `outsideTransaction` (#6560): from the tables themselves when this store last
	 * found the session without segments, and through its view again when the read's own answer says it now has them.
	 */
	private outsideSessionRead<T>(
		sessionId: string,
		read: (tables: ForkViewTables) => Promise<T>,
		found: (value: T) => boolean,
		forkedOf: (value: T) => SqliteValue | undefined,
	): Promise<T> {
		return this.outsideTransaction(async (tables) => {
			const plain = tables.segments !== undefined && this.forkedSessions.get(sessionId) === false;
			const value = await read(plain ? { ...tables, segments: undefined } : tables);
			const forked = forkedOf(value);
			this.noteForked(undefined, sessionId, forked);
			return plain && Number(forked) === 1 ? read(tables) : value;
		}, found);
	}

	/** The `forked` column of a read outside a transaction of the sessions row `id` names: see `outsideSessionRead`. */
	private outsideForkedColumn(id: string): string {
		return this.forkedColumn(this.sharedHistorySeen ? this.forkTables.forkSegments : undefined, id);
	}

	/**
	 * After a read outside a transaction found nothing: reads the sessions schema, refuses one this build does not read,
	 * and tells whether shared history is on now where the read, made with `seen` as it was, read the tables themselves.
	 */
	private async schemaNowShared(seen: boolean): Promise<boolean> {
		const row = await this.database.get<SqliteRow & { version: number | null }>(
			`SELECT max(schema_version) AS version FROM ${this.tables.meta}`,
		);
		const version = row?.version == null ? null : Number(row.version);
		assertStorageSchemaVersion("sessions", version, SESSION_SCHEMA_VERSION, SESSION_SCHEMA_VERSION_UNCHUNKED);
		this.noteSchemaVersion(version);
		return this.sharedHistorySeen && !seen;
	}

	/**
	 * Turns on forks that share their parent's history (#6560), as a store's open does by itself: see
	 * {@link SqlSessionStore.switchSharedHistory}. `live` judges whether the process of an older build's open-session
	 * marker still runs; the application's judge by default.
	 */
	enableSharedHistoryForks(
		options: { readonly live?: (marker: SessionOpenMarkerBuild) => Promise<boolean> } = {},
	): Promise<SharedHistoryForksOutcome> {
		this.assertOpen();
		return SqlSessionStore.switchSharedHistory(
			this.database,
			this.prefix,
			this.tables,
			this.openMarkers,
			options.live ?? sharedHistorySwitchHost().live,
		);
	}

	/**
	 * The switch to shared-history forks (#6560), in one transaction: creates the fork tables, records version 3 in the
	 * migration ledger where there is one, and raises the sessions schema to it, so that builds which do not read it
	 * refuse the database at their next open or transaction. One way: nothing lowers it again.
	 *
	 * It never leaves an older process reading what it cannot read: while `live` judges any open-session marker of an
	 * older build to be a running process, it changes nothing and is `deferred`, and the next open tries again. The
	 * transaction is the only writer of the whole database while it runs, so every session write either finished before
	 * it, or starts after it and reads the new version first. Two hosts switching at once run one after the other, and
	 * the second finds it `already` done.
	 */
	private static switchSharedHistory(
		database: SqliteDatabase,
		prefix: string,
		tables: Tables,
		markers: SqlSessionOpenMarkers,
		live: (marker: SessionOpenMarkerBuild) => Promise<boolean>,
	): Promise<SharedHistoryForksOutcome> {
		const dialect = dialectOf(database);
		return database.transaction(
			async (tx): Promise<SharedHistoryForksOutcome> => {
				const [row, older] = await statementBatch(
					tx,
					[],
					[
						() => tx.get(`SELECT max(schema_version) AS schema_version FROM ${tables.meta}`),
						() => markers.olderThan(tx, SESSION_SCHEMA_VERSION_SHARED_HISTORY),
					],
				);
				const version = row?.schema_version ?? null;
				assertStorageSchemaVersion("sessions", version, SESSION_SCHEMA_VERSION, SESSION_SCHEMA_VERSION_UNCHUNKED);
				if (Number(version) >= SESSION_SCHEMA_VERSION_SHARED_HISTORY) return { status: "already" };
				const holders = await liveMarkers(older, live);
				if (holders.length > 0) return { status: "deferred", holders };
				await createSharedHistoryTables(tx, dialect, sessionForkTables(prefix));
				// The snapshot index links the entries of forks that share history from the first one on.
				await installSharedHistorySnapshotIndex(tx, dialect, prefix);
				await statementBatch(
					tx,
					[
						dialect.versionedMigrations && {
							sql: `INSERT INTO ${storageMigrationTable(prefix)} (domain, version, applied_at) VALUES (?, ?, ${dialect.nowMs}) ON CONFLICT DO NOTHING`,
							params: [SESSION_DOMAIN, SESSION_SCHEMA_VERSION_SHARED_HISTORY],
						},
						{
							sql: `UPDATE ${tables.meta} SET schema_version = ? WHERE schema_version < ?`,
							params: [SESSION_SCHEMA_VERSION_SHARED_HISTORY, SESSION_SCHEMA_VERSION_SHARED_HISTORY],
						},
					],
					[],
				);
				return { status: "enabled" };
			},
			{ retryTransientFailures: true, concurrency: { kind: "serial" } },
		);
	}

	/**
	 * An open's switch to shared-history forks, true when it switched the database. With `precheck`, for an open that
	 * read the schema without a lock, it first reads, still without one, the version and the markers of older builds
	 * together, so an open that must leave the switch for later, while an older build runs a session, takes no lock and
	 * writes nothing; an open that set the schema up under the write lock goes straight to the switch. A switch that cannot run, such as for a role without the
	 * privilege to create tables, is left for a later open or `atomic storage migrate`; forks copy meanwhile. Either way
	 * the open goes on, and only the debug log notes it.
	 */
	private static async switchAtOpen(
		database: SqliteDatabase,
		prefix: string,
		tables: Tables,
		markers: SqlSessionOpenMarkers,
		precheck: boolean,
	): Promise<boolean> {
		const host = sharedHistorySwitchHost();
		const deferred = (holders: readonly SessionOpenMarkerBuild[]) =>
			host.skipped({
				reason: "older-sessions-running",
				prefix,
				sessions: holders.length,
				holders: holders.map((holder) => `${holder.host}:${holder.pid}`).join(", "),
			});
		try {
			if (precheck) {
				const [found, older] = await statementBatch(
					database,
					[],
					[
						() => database.get(`SELECT max(schema_version) AS schema_version FROM ${tables.meta}`),
						() => markers.olderThan(database, SESSION_SCHEMA_VERSION_SHARED_HISTORY),
					],
				);
				if (Number(found?.schema_version) >= SESSION_SCHEMA_VERSION_SHARED_HISTORY) return false;
				const holders = await liveMarkers(older, host.live);
				if (holders.length > 0) {
					deferred(holders);
					return false;
				}
			}
			const outcome = await SqlSessionStore.switchSharedHistory(database, prefix, tables, markers, host.live);
			if (outcome.status === "deferred") deferred(outcome.holders);
			return outcome.status === "enabled";
		} catch (error) {
			host.skipped({ reason: "switch-failed", prefix, error: (error as Error).message });
			return false;
		}
	}

	get descriptor(): StorageDescriptor {
		return { ...this.database.descriptor, ...(this.prefix === "" ? {} : { prefix: this.prefix }) };
	}

	async create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<SessionWriteResult> {
		this.assertOpen();
		validateSessionHeader(header);
		validateSessionEntries(entries);
		// Where this store has seen shared history, the session's lookup also tells whether a deleted session with this ID
		// left rows forks still read, in the same statement.
		const tombstones = this.sharedHistorySeen;
		const existing: SqliteStatement = tombstones
			? {
					sql: `SELECT (SELECT id FROM ${this.tables.sessions} WHERE id = ?) AS id, (SELECT session_id FROM ${this.forkTables.forkTombstones} WHERE session_id = ?) AS tombstone`,
					params: [header.id, header.id],
				}
			: { sql: `SELECT id FROM ${this.tables.sessions} WHERE id = ?`, params: [header.id] };
		let written: WrittenEntry[] = [];
		let writtenRow: WrittenRow | undefined;
		const created = await this.transactionCheckedAlongside(
			async (tx, checked) => {
				writtenRow = undefined;
				const found = await tx.get<SqliteRow & { id: string | null; tombstone?: string | null }>(
					existing.sql,
					...existing.params,
				);
				if (found?.id != null) throw new SessionExistsError(header.id);
				// A deleted session with this ID may have left rows forks still read: they get their own copies first.
				if (
					(await this.sharedHistoryForks(tx)) &&
					(tombstones ? found?.tombstone != null : await this.hasForkTombstone(tx, header.id))
				)
					// A fork whose copy a missing source chunk refuses keeps the old rows, and the create is refused with it.
					await createOverTombstoneWithin(this.forkHost(), tx, header.id).catch((error: unknown) => {
						noteForkCopyRefusal(error, "create");
						throw error;
					});
				const summary = this.summaryWrite(header.id, { header, entries, lastSeq: entries.length });
				await checked;
				written = [];
				writtenRow = summary.row;
				await this.writeEntries(
					tx,
					summary.statement,
					this.entryWrites(header.id, entries, 0, summary.texts, true, written),
				);
				return { lastSeq: entries.length, epoch: summary.epoch };
			},
			this.sessionWrite(header.id, existing),
		);
		this.noteWritten(header.id, created.epoch, written);
		this.rememberWritten(header.id, writtenRow);
		return created;
	}

	async createFork(
		header: SessionRecordHeader,
		entries: SessionForkSeed,
		source: ForkArchiveSource,
	): Promise<(SessionWriteResult & { remainingBlobs?: readonly string[] }) | undefined> {
		// Use the original connection's snapshot. A different handle may share its queue; never wait
		// for a separately scheduled read from inside a write transaction on that queue.
		if (this.create !== SqlSessionStore.prototype.create) return undefined;
		if (!this.sharesTablesWith(source.store)) {
			if ("read" in entries)
				return entries.kind === "complete-session" ? this.createStagedFork(header, entries, source) : undefined;
			if (source.receipts.size < 2) return undefined;
			// One receipt fits the compatibility copy. Never retain a list of decoded historical
			// bodies waiting for create(): send the already selected rows through the same staging transport.
			const selected: SessionForkStream = {
				async *read() {
					for (const entry of entries) yield { entry, reference: source.receipts.get(entry.id) };
				},
			};
			return this.createStagedFork(header, selected, source);
		}
		if ("read" in entries) return this.createStreamedFork(header, entries, source);
		this.assertOpen();
		validateSessionHeader(header);
		validateSessionEntries(entries);
		// Entries that need nothing of the source share nothing without shared history, which a read of the source in this
		// store has noted, or without the generation they were read in: `create` stores them in one transaction.
		if (
			source.receipts.size === 0 &&
			source.hashes.length === 0 &&
			(!this.sharedHistorySeen || source.epoch === undefined)
		)
			return undefined;
		for (let attempt = 0; ; attempt++) {
			// As a streamed fork's: once this store has seen shared history, the reads that lock the source go out first.
			const reads = this.sharedHistorySeen ? this.sharedForkReads(header.id, source.sessionId, false) : undefined;
			try {
				// The schema check goes out with the fork's first reads, as a `create`'s does: its writes wait for it.
				return await this.transactionCheckedAlongside(
					(tx, checked) => this.writeEntriesFork(tx, checked, header, entries, source, reads),
					this.sessionWrite(
						header.id,
						...(reads === undefined ? [] : [reads.exists, reads.lock, reads.tombstones, reads.segments]),
					),
				);
			} catch (error) {
				if (!(error instanceof ForkSourcesMoved) || attempt >= 3) throw error;
			}
		}
	}

	/**
	 * A fork from the entries a caller holds. Where the database has shared history (#6560) and the source is still in
	 * the generation the fork read it in, every entry the store read from the source and the caller kept unchanged, and
	 * every receipt, is named by the child's segments, not stored again: the child stores only the entries it changed or
	 * added, and their blobs. Otherwise the entries are stored as `create` stores them, receipts as the source stores
	 * them. Undefined, with nothing written, for entries with neither receipts nor blobs that share nothing: `create`
	 * then stores them, needing nothing of the source, so a source that changed or went away meanwhile does not fail it.
	 */
	private async writeEntriesFork(
		tx: SqliteExecutor,
		checked: Promise<void>,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		source: ForkArchiveSource,
		reads: SharedForkReads | undefined,
	): Promise<(SessionWriteResult & { remainingBlobs: readonly string[] }) | undefined> {
		const needsSource = source.receipts.size > 0 || source.hashes.length > 0;
		let shared: SharedForkDonor | undefined;
		// Locked in whatever generation it is: the generation the entries were read in is compared below.
		const unchecked = { ...source, epoch: undefined };
		const sharedRead = this.leadingForkDonor(tx, header.id, unchecked, reads);
		if (await this.sharedHistoryForks(tx)) {
			try {
				shared = await (sharedRead ??
					this.sharedForkDonor(
						tx,
						header.id,
						unchecked,
						this.sharedForkReads(header.id, source.sessionId, false),
					));
			} catch (error) {
				if (needsSource || !(error instanceof SessionNotFoundError)) throw error;
				return undefined;
			}
		}
		const sharing = shared !== undefined && source.epoch !== undefined && shared.epoch === source.epoch;
		if (!sharing && !needsSource) return undefined;
		if (shared !== undefined && source.epoch !== undefined && shared.epoch !== source.epoch)
			throw new SessionConflictError(source.sessionId, 0, shared.lastSeq);
		const donor = shared ?? (await this.forkDonor(tx, header.id, source));
		for (const entry of entries) {
			const ref = source.receipts.get(entry.id);
			if (ref && (source.sessionId !== ref.sessionId || donor.epoch !== ref.epoch || donor.lastSeq < ref.seq))
				throw new SessionConflictError(ref.sessionId, ref.seq, donor.lastSeq);
		}
		const summary = this.summaryWrite(header.id, { header, entries, lastSeq: entries.length });
		await checked;
		const tables = await this.viewTables(tx);
		const writes = new SentWrites(tx);
		if (!sharing) {
			const blobs = this.forkBlobCopy(source.sessionId, header.id, source.hashes);
			const remainingBlobs = await writes.around(async () => {
				await writes.send([summary.statement]);
				await writes.send(this.receiptForkWrites(tables, header.id, entries, source, donor.lastSeq));
				await writes.send(this.entryWrites(header.id, [], 0, summary.texts, false));
				return this.finishForkCopy(tx, writes, header.id, blobs, source.hashes);
			});
			await this.finishFork(tx, header.id);
			return { lastSeq: entries.length, epoch: summary.epoch, remainingBlobs };
		}
		// Where each entry is: at the source's seq for one it stores unchanged, or undefined for one the child stores. A
		// segment names the source's rows in increasing order, each once: an entry out of that order is stored.
		const places: (number | undefined)[] = [];
		let sharedThrough = 0;
		for (const entry of entries) {
			const seq = source.receipts.get(entry.id)?.seq ?? storedSeqOf(entry, source.sessionId, source.epoch);
			const shares = seq !== undefined && seq > sharedThrough && seq <= donor.lastSeq;
			if (shares) sharedThrough = seq;
			places.push(shares ? seq : undefined);
		}
		// A shared row's blob is read where its source stores it; only the child's own rows copy theirs.
		const hashes = new Set<string>();
		let copiesReceipts = false;
		for (const [index, entry] of entries.entries()) {
			if (places[index] !== undefined) continue;
			copiesReceipts ||= source.receipts.has(entry.id);
			if (entry.type !== "custom" || entry.customType !== "atomic.tool-output") continue;
			const hash = (entry.data as { hash?: string } | undefined)?.hash;
			if (typeof hash === "string" && source.hashes.includes(hash)) hashes.add(hash);
		}
		const statements = this.sharedEntriesForkWrites(tables, header, entries, places, source, shared!, summary.texts);
		if (!copiesReceipts && hashes.size === 0) {
			// Every row the child stores is written whole from what it holds: nothing to check after them, so they are the
			// transaction's last writes, and go out with its commit where the connection is pipelined.
			await this.writeEntries(tx, summary.statement, [...statements, this.forkVersionStep(header.id)]);
			return { lastSeq: entries.length, epoch: summary.epoch, remainingBlobs: [] };
		}
		const remainingBlobs = await writes.around(async () => {
			await writes.send([summary.statement]);
			await writes.send(statements);
			return this.finishForkCopy(
				tx,
				writes,
				header.id,
				this.forkBlobCopy(source.sessionId, header.id, hashes),
				hashes,
			);
		});
		await this.finishFork(tx, header.id);
		return { lastSeq: entries.length, epoch: summary.epoch, remainingBlobs };
	}

	/**
	 * The statements of a fork from `entries` with shared history (#6560), in seq order, after its session row: the
	 * segments that name the rows `places` puts in the source, each entry it does not as {@link entryForkWrites} stores it,
	 * the search texts of those, and the lineage row. Throws, before the last of them, unless the segments are well formed.
	 */
	private *sharedEntriesForkWrites(
		tables: ForkViewTables,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		places: readonly (number | undefined)[],
		source: ForkArchiveSource,
		donor: SharedForkDonor,
		texts: readonly SessionSummaryText[],
	): Generator<CountedStatement> {
		const lineage = this.lineageTables();
		const runs = new ForkSegmentRuns(lineage, header.id, {
			id: source.sessionId,
			segments: donor.segments,
			length: donor.lastSeq,
		});
		for (const [index, entry] of entries.entries()) {
			const seq = places[index];
			if (seq !== undefined) {
				runs.add(seq, index + 1, entry.id);
				if (runs.full) yield* runs.drain();
				continue;
			}
			// What the child holds is in seq order, for the snapshot index's triggers: the runs before this row first.
			yield* runs.drain();
			yield* this.entryForkWrites(tables, header.id, index, entry, source, donor.lastSeq);
		}
		yield* runs.drain();
		// The search texts of shared rows are the source's, read through the child's view.
		yield* this.entryWrites(
			header.id,
			[],
			0,
			texts.filter((text) => places[text.index] === undefined),
			false,
		);
		assertForkSegments(header.id, runs.segments, entries.length);
		yield forkLineageWrite(lineage, header.id, { parentId: source.sessionId, cutSeq: donor.lastSeq });
	}

	/**
	 * The source session's head, its row locked for share, once the child is known to be new: both reads go out together,
	 * one round trip (#6560). Fails as the source changed when it is no longer the generation the fork read.
	 */
	private async forkDonor(
		tx: SqliteExecutor,
		child: string,
		source: ForkArchiveSource,
	): Promise<{ lastSeq: number; epoch: string }> {
		const existing = tx.get(`SELECT id FROM ${this.tables.sessions} WHERE id = ?`, child);
		const head = this.historyHead(tx, source.sessionId).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		if (await existing) throw new SessionExistsError(child);
		const read = await head;
		if ("error" in read) throw read.error;
		const donor = read.value;
		if (source.epoch !== undefined && donor.epoch !== source.epoch)
			throw new SessionConflictError(source.sessionId, 0, donor.lastSeq);
		return donor;
	}

	/**
	 * The statements that store a fork's `entries`, in seq order: an entry with a receipt as the source stores it, its row
	 * and chunks copied in two statements whatever their size, and any other as `create` stores it. A receipt's row that
	 * names another entry fails the fork: the source changed under it.
	 */
	private *receiptForkWrites(
		tables: ForkViewTables,
		child: string,
		entries: readonly SessionEntry[],
		source: ForkArchiveSource,
		donorLastSeq: number,
	): Generator<CountedStatement> {
		for (const [index, entry] of entries.entries())
			yield* this.entryForkWrites(tables, child, index, entry, source, donorLastSeq);
	}

	/** The statements of {@link receiptForkWrites} that store `entry`, at index `index` of the fork's entries. */
	private *entryForkWrites(
		tables: ForkViewTables,
		child: string,
		index: number,
		entry: SessionEntry,
		source: ForkArchiveSource,
		donorLastSeq: number,
	): Generator<CountedStatement> {
		const ref = source.receipts.get(entry.id);
		if (ref === undefined) {
			yield* this.entryWrites(child, [entry], index, [], false);
			return;
		}
		// The source's row and chunks where its view stores them (#6560).
		const view = this.entriesView(tables, ref.sessionId, ref.seq - 1, ref.seq);
		yield {
			sql: withForkViews(
				[view],
				`INSERT INTO ${this.tables.entries} (session_id, seq, entry_id, entry_json, chunks) SELECT ?, ?, entry_id, entry_json, chunks FROM ${view.name} WHERE entry_id = ?`,
			),
			params: [...view.params, child, index + 1, entry.id],
			changes: 1,
			mismatch: () => new SessionConflictError(ref.sessionId, ref.seq, donorLastSeq),
		};
		yield {
			sql: withForkViews(
				[view],
				`INSERT INTO ${this.tables.entryChunks} (session_id, seq, idx, data) SELECT ?, ?, c.idx, c.data FROM ${view.name} v JOIN ${this.tables.entryChunks} c ON c.session_id = v.src_id AND c.seq = v.src_seq WHERE c.idx >= 0 AND c.idx < v.chunks ORDER BY c.idx`,
			),
			params: [...view.params, child, index + 1],
		};
	}

	/**
	 * The blob copy of a fork from session `source` of this store's tables (#6560), or undefined when a subclass stores
	 * blobs its own way: `createForkArchive` then copies every one through it.
	 */
	private forkBlobCopy(source: string, child: string, hashes: Iterable<string>): ForkBlobCopy | undefined {
		if (this.getBlob !== SqlSessionStore.prototype.getBlob || this.putBlob !== SqlSessionStore.prototype.putBlob)
			return undefined;
		return forkBlobCopy(
			this.tables,
			{ legacyBlobData: this.legacyBlobData, chunkBytes: SESSION_BLOB_CHUNK_BYTES },
			source,
			child,
			[...new Set(hashes)],
		);
	}

	/**
	 * Sends a fork's blob copy behind its entries, then checks, in one round trip with them, that every stored entry of
	 * the child has all its chunks and which blobs were copied whole. Resolves with the hashes left for
	 * `copySessionBlobs`: those the source does not hold, or all of them where this store does not copy blobs itself.
	 */
	private async finishForkCopy(
		tx: SqliteExecutor,
		writes: SentWrites,
		child: string,
		blobs: ForkBlobCopy | undefined,
		hashes: Iterable<string>,
	): Promise<string[]> {
		if (blobs) await writes.send(blobs.statements);
		const incomplete = incompleteEntryRead(this.tables, child);
		const [missing, ...answers] = await Promise.all([
			tx.get<SqliteRow & { seq: number }>(incomplete.sql, ...incomplete.params),
			...(blobs?.checks ?? []).map((check) => tx.all(check.sql, ...check.params)),
		]);
		if (missing !== undefined)
			throw new StorageUnavailableError(this.descriptor, new Error(`Missing chunk of session entry ${missing.seq}`));
		return blobs ? blobs.remaining(answers) : [...new Set(hashes)];
	}

	/**
	 * Whether `store` keeps its sessions in this store's very tables, so that this store's transaction reads its rows: this
	 * store, or another session store opened on the same database with the same prefix, such as through another handle
	 * (#6560). A wrapper that serves sessions of its own does not.
	 */
	private sharesTablesWith(store: SessionStore): boolean {
		return store === this || (store instanceof SqlSessionStore && forkStoreRelation(store, this) === "same");
	}

	/**
	 * Clone a complete session, as `create` with every source entry and blob would, from a store on a handle this one
	 * cannot prove to be its own connection (#5594). The source is read a page at a time into the staging table, never
	 * while a transaction of this store is open, and the child is published in one transaction: see `fork-staging.ts`.
	 * `remainingBlobs` names the blobs left to copy with `copySessionBlobs`: those the source no longer holds.
	 */
	async createStagedFork(
		header: SessionRecordHeader,
		stream: SessionForkStream,
		source: ForkArchiveSource,
	): Promise<SessionWriteResult & { readonly remainingBlobs: readonly string[] }> {
		this.assertOpen();
		validateSessionHeader(header);
		const { createStagedFork } = await import("./fork-staging.js");
		return createStagedFork(this.forkStagingTarget(), header, stream, source);
	}

	/**
	 * Creates the fork staging table unless it exists, as `atomic storage migrate` does as the owner role (#5594): a
	 * runtime role without DDL privileges then stages bounded clones too. Opens never create it.
	 */
	async prepareForkStaging(): Promise<void> {
		this.assertOpen();
		const { cleanupForkStaging, ensureForkStagingTable } = await import("./fork-staging.js");
		await ensureForkStagingTable(this.database, this.dialect, this.forkStagingTable);
		await cleanupForkStaging(this.database, this.dialect, this.forkStagingTable, Number.POSITIVE_INFINITY);
	}

	/**
	 * Creates the chat records' table and index unless the ledger records them, as `atomic storage migrate` does as the
	 * owner role: a runtime role without DDL privileges then saves chat records too. Opens never create them; the first
	 * chat record does where `migrate` has not run.
	 */
	async prepareChatRecords(): Promise<void> {
		this.assertOpen();
		await this.chatRecords?.initialize();
	}

	/** Whether a deleted session with ID `sessionId` left rows forks still read. */
	private async hasForkTombstone(tx: SqliteExecutor, sessionId: string): Promise<boolean> {
		return (
			(await tx.get(`SELECT session_id FROM ${this.forkTables.forkTombstones} WHERE session_id = ?`, sessionId)) !==
			undefined
		);
	}

	/** This store's side of detaching and pinning shared fork history: see fork-detach-host.ts. */
	private forkHost() {
		return forkDetachHost({
			dialect: this.dialect,
			tables: this.tables,
			forkTables: this.forkTables,
			blobs: { legacyBlobData: this.legacyBlobData, chunkBytes: SESSION_BLOB_CHUNK_BYTES },
			transaction: (body) => this.transaction(body, SESSION_TRANSACTION),
		});
	}

	/**
	 * @internal Gives every fork that shares history with `sessionId` its own copy of what it reads, so the session's
	 * rows no longer stay for them; see fork-detach.ts. Detaches a crash stopped are finished first. Nothing to do where
	 * shared-history forks are off.
	 */
	async detachForks(sessionId: string, options: ForkDetachOptions = {}): Promise<ForkDetachReport> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		if (!(await this.transaction((tx) => this.sharedHistoryForks(tx), SESSION_TRANSACTION)))
			return { detached: [], reparented: [] };
		const report = await detachForkChildren(this.forkHost(), sessionId, options).catch((error: unknown) => {
			noteForkCopyRefusal(error, "detach");
			throw error;
		});
		await this.sweepReleasedForkRows([sessionId]);
		return report;
	}

	/** @internal Finishes every detach a crash stopped. Nothing to do where shared-history forks are off. */
	async resumeForkDetaches(): Promise<ForkDetachReport> {
		this.assertOpen();
		if (!(await this.transaction((tx) => this.sharedHistoryForks(tx), SESSION_TRANSACTION)))
			return { detached: [], reparented: [] };
		return resumeForkDetaches(this.forkHost());
	}

	/**
	 * @internal Removes the rows of deleted sessions that no fork reads any more, a batch per transaction: `sessionIds`,
	 * and a few any earlier sweep left. Resolves with the sessions whose rows went.
	 */
	async sweepForkTombstones(sessionIds: readonly string[] = [], batchEntries?: number): Promise<string[]> {
		this.assertOpen();
		if (!(await this.transaction((tx) => this.sharedHistoryForks(tx), SESSION_TRANSACTION))) return [];
		const { sweepForkTombstones } = await import("./fork-sweep.js");
		return sweepForkTombstones(this.forkHost(), sessionIds, batchEntries === undefined ? {} : { batchEntries });
	}

	private forkStagingTarget(): import("./fork-staging.js").ForkStagingTarget {
		return {
			database: this.database,
			dialect: this.dialect,
			table: this.forkStagingTable,
			tables: this.tables,
			legacyBlobData: this.legacyBlobData,
			entryChunkBytes: SESSION_ENTRY_CHUNK_BYTES,
			blobChunkBytes: SESSION_BLOB_CHUNK_BYTES,
			unchunkedSchemaVersion: SESSION_SCHEMA_VERSION_UNCHUNKED,
			chunkedSchemaVersion: SESSION_SCHEMA_VERSION_CHUNKED,
			ownsBlobs:
				this.getBlob === SqlSessionStore.prototype.getBlob && this.putBlob === SqlSessionStore.prototype.putBlob,
			transaction: (sessionId, body, leading) => this.transaction(body, this.sessionWrite(sessionId, ...leading)),
			summaryWrite: (header, lastSeq, summary, index) =>
				this.summaryWrite(header.id, { header, entries: [], lastSeq }, summary, index),
			create: (header, entries) => this.create(header, entries),
			sourceStoredEntryChunks: (source) => {
				const store = nativeForkReader(source, "entry");
				return store instanceof SqlSessionStore && store.readEntryChunk === SqlSessionStore.prototype.readEntryChunk
					? (reference, index) => store.readStoredEntryChunk(reference, index)
					: undefined;
			},
			rebuildResume: async (sessionId) => {
				await this.prepareResume(sessionId);
			},
			storedEntry,
			encode: (value) => this.encode(value),
			sourceEntryChunks: (source) => {
				const store = nativeForkReader(source, "entry");
				return store instanceof SqlSessionStore && store.readEntryChunk === SqlSessionStore.prototype.readEntryChunk
					? (reference) => store.readStoredChunks(reference)
					: undefined;
			},
			sourceBlobParts: (source) => {
				const store = nativeForkReader(source, "blob");
				return store instanceof SqlSessionStore && store.getBlob === SqlSessionStore.prototype.getBlob
					? (sessionId, hash, offset, legacyBytes) => store.readBlobPart(sessionId, hash, offset, legacyBytes)
					: undefined;
			},
			sourceBlobFirstParts: (source) => {
				const store = nativeForkReader(source, "blob");
				return store instanceof SqlSessionStore && store.getBlob === SqlSessionStore.prototype.getBlob
					? (sessionId, hashes, maxBytes) => store.readBlobFirstParts(sessionId, hashes, maxBytes)
					: undefined;
			},
		};
	}

	/**
	 * The stored chunk row `index` of the entry `reference` names, whole, in its generation; undefined when the entry is
	 * stored whole. One read where `readEntryChunk` would take one per 64 KiB of it (#5594).
	 */
	private async readStoredEntryChunk(
		reference: OversizedSessionEntry,
		index: number,
	): Promise<Uint8Array | undefined> {
		this.assertOpen();
		return this.readTransaction(async (tx) => {
			const { sessionId, epoch, seq } = reference;
			const head = await this.historyHead(tx, sessionId, true);
			if (head.epoch !== epoch) throw new SessionConflictError(sessionId, seq, head.lastSeq);
			const view = this.entriesView(await this.viewTables(tx, sessionId), sessionId, seq - 1, seq);
			const row = await tx.get<SqliteRow & { chunks: number; data: Uint8Array | null }>(
				withForkViews(
					[view],
					`SELECT e.chunks, c.data FROM ${view.name} e LEFT JOIN ${this.tables.entryChunks} c
					ON c.session_id = e.src_id AND c.seq = e.src_seq AND c.idx = ?`,
				),
				...view.params,
				index,
			);
			if (!row) throw new StorageUnavailableError(this.descriptor, new Error(`Missing session entry ${seq}`));
			if (Number(row.chunks) === 0) return undefined;
			if (row.data == null)
				throw new StorageUnavailableError(this.descriptor, new Error(`Missing chunk of session entry ${seq}`));
			return row.data;
		});
	}

	/** How many chunks the entry `reference` names is stored in, 0 when it is stored whole, in its generation. */
	private async readStoredChunks(reference: OversizedSessionEntry): Promise<number> {
		this.assertOpen();
		return this.readTransaction(async (tx) => {
			const { sessionId, epoch, seq } = reference;
			const head = await this.historyHead(tx, sessionId, true);
			if (head.epoch !== epoch) throw new SessionConflictError(sessionId, seq, head.lastSeq);
			const view = this.entriesView(await this.viewTables(tx, sessionId), sessionId, seq - 1, seq);
			const row = await tx.get<SqliteRow & { chunks: number }>(
				withForkViews([view], `SELECT chunks FROM ${view.name}`),
				...view.params,
			);
			if (!row) throw new StorageUnavailableError(this.descriptor, new Error(`Missing session entry ${seq}`));
			return Number(row.chunks);
		});
	}

	/**
	 * The headers of the blobs `hashes` of session `sessionId` in one read (#6560), each with its first chunk row when it
	 * is stored in chunks of at most `maxBytes` in all, as `readBlobPart` reads them at offset 0. A blob the session does
	 * not hold is left out; one in the legacy one-row layout comes without its value.
	 */
	private async readBlobFirstParts(
		sessionId: string,
		hashes: readonly string[],
		maxBytes: number,
	): Promise<Map<string, { readonly bytes: number; readonly chunks: number; readonly data?: Uint8Array }>> {
		this.assertOpen();
		const parts = new Map<string, { readonly bytes: number; readonly chunks: number; readonly data?: Uint8Array }>();
		if (hashes.length === 0) return parts;
		// Those a fork that shares its parent's history inherits are where its sources store them, its own first (#6560).
		const rows = await this.outsideTransaction(
			(tables) =>
				this.database.all<
					SqliteRow & { hash: string; bytes: number; chunks: number; data: Uint8Array | null; own: number }
				>(
					`SELECT b.hash, b.bytes, b.chunks, CASE WHEN b.chunks >= 0 AND b.bytes <= ? THEN c.data END AS data,
						CASE WHEN w.place = 0 THEN 1 ELSE 0 END AS own
				FROM ${this.blobPlaces(tables)} w JOIN ${this.tables.blobs} b
				ON b.session_id = w.owner AND b.hash IN (${hashes.map(() => "?").join(", ")})
				LEFT JOIN ${this.tables.blobChunks} c ON c.session_id = b.session_id AND c.hash = b.hash AND c.idx = 0
				${tables.guard === undefined ? "" : `WHERE ${tables.guard}`}
				ORDER BY own DESC, b.session_id`,
					maxBytes,
					...this.blobPlaceParams(tables, sessionId),
					...hashes,
				),
			(found) => found.length > 0,
		);
		for (const row of rows)
			if (!parts.has(String(row.hash)))
				parts.set(String(row.hash), {
					bytes: Number(row.bytes),
					chunks: Number(row.chunks),
					...(row.data == null ? {} : { data: row.data }),
				});
		return parts;
	}

	/**
	 * The bytes of a blob from `offset`, a multiple of {@link SESSION_BLOB_CHUNK_BYTES}, so a staged clone never holds
	 * the whole of a large one (#5594): the stored chunk row there, or for a blob in the legacy one-row layout (`chunks`
	 * -1), at most `legacyBytes` cut from its data column by the database, which loads that one value itself for each
	 * cut; with `legacyBytes` 0, only its header. Nothing is converted or written.
	 */
	private async readBlobPart(
		sessionId: string,
		hash: string,
		offset: number,
		legacyBytes: number,
	): Promise<{ readonly bytes: number; readonly chunks: number; readonly data?: Uint8Array } | undefined> {
		this.assertOpen();
		// The data column exists only in SQLite tables written before chunked blobs.
		const cut = this.legacyBlobData && legacyBytes > 0;
		const legacy = cut ? "CASE WHEN b.chunks = -1 THEN substr(b.data, ?, ?) ELSE c.data END" : "c.data";
		// Where the session's view stores the blob (#6560), the part in the same statement.
		const row = await this.outsideTransaction(
			(tables) =>
				this.database.get<SqliteRow & { bytes: number; chunks: number; data: Uint8Array | null }>(
					`SELECT b.bytes, b.chunks, ${legacy} AS data
				FROM ${this.blobPlaces(tables)} w JOIN ${this.tables.blobs} b ON b.session_id = w.owner AND b.hash = ?
				LEFT JOIN ${this.tables.blobChunks} c ON c.session_id = b.session_id AND c.hash = b.hash AND c.idx = ?
				${tables.guard === undefined ? "" : `WHERE ${tables.guard}`}
				ORDER BY w.place, b.session_id LIMIT 1`,
					...(cut ? [offset + 1, legacyBytes] : []),
					...this.blobPlaceParams(tables, sessionId),
					hash,
					Math.floor(offset / SESSION_BLOB_CHUNK_BYTES),
				),
			(found) => found !== undefined,
		);
		if (row === undefined) return undefined;
		return { bytes: Number(row.bytes), chunks: Number(row.chunks), ...(row.data == null ? {} : { data: row.data }) };
	}

	/**
	 * A fork from a stream of the source's rows. Where the database has shared history (#6560), the child stores no copy
	 * of the rows the source stores unchanged: its segments name them, and it stores only the rows the stream changed or
	 * added. A stream of the source's whole history, as it stands, reads no row at all.
	 */
	private async createStreamedFork(header: SessionRecordHeader, stream: SessionForkStream, source: ForkArchiveSource) {
		this.assertOpen();
		validateSessionHeader(header);
		for (let attempt = 0; ; attempt++) {
			// Once this store has seen shared history, the reads that lock the source go out with the transaction's start.
			const reads = this.sharedHistorySeen
				? this.sharedForkReads(header.id, source.sessionId, stream.prefix !== undefined)
				: undefined;
			try {
				// The schema check goes out with the fork's first reads, as a `create`'s does: its writes wait for it.
				return await this.transactionCheckedAlongside(
					(tx, checked) => this.writeStreamedFork(tx, checked, header, stream, source, reads),
					this.sessionWrite(
						header.id,
						...(reads === undefined ? [] : [reads.exists, reads.lock, reads.tombstones, reads.segments]),
					),
				);
			} catch (error) {
				if (!(error instanceof ForkSourcesMoved) || attempt >= 3) throw error;
			}
		}
	}

	private async writeStreamedFork(
		tx: SqliteExecutor,
		checked: Promise<void>,
		header: SessionRecordHeader,
		stream: SessionForkStream,
		source: ForkArchiveSource,
		reads: SharedForkReads | undefined,
	) {
		const sharedRead = this.leadingForkDonor(tx, header.id, source, reads);
		const shared = (await this.sharedHistoryForks(tx))
			? await (sharedRead ??
					this.sharedForkDonor(
						tx,
						header.id,
						source,
						this.sharedForkReads(header.id, source.sessionId, stream.prefix !== undefined),
					))
			: undefined;
		const head = shared ?? (await this.forkDonor(tx, header.id, source));
		await checked;
		const { encodedForkRow } = await import("./fork-row-bytes.js");
		const { foldForkRow } = await import("./fork-row-index.js");
		const prefix = stream.prefix;
		if (
			shared !== undefined &&
			prefix !== undefined &&
			prefix.sessionId === source.sessionId &&
			prefix.through === shared.lastSeq &&
			(prefix.epoch === undefined || prefix.epoch === shared.epoch)
		) {
			const whole = await this.writeSharedPrefixFork(tx, header, source.sessionId, shared);
			if (whole !== undefined) return whole;
		}
		const reader = new SqlSessionStore(
			{
				descriptor: this.database.descriptor,
				dialect: this.dialect,
				readOnly: true,
				exec: tx.exec.bind(tx),
				get: tx.get.bind(tx),
				run: tx.run.bind(tx),
				all: tx.all.bind(tx),
				transaction: async (cb) => cb(tx),
				close: async () => {},
			},
			this.tables,
			this.prefix,
			this.cwdMatcher,
			this.blobTable,
			this.legacyBlobData,
			undefined,
			this.entryByteLength,
		);
		// The reader's reads outside a transaction run in this one, which has read the schema already.
		reader.sharedHistorySeen = await this.sharedHistoryForks(tx);
		// The source's resume index, read only for a stream that asks for a branch's span.
		let donorIndex: Promise<SessionResumeIndex> | undefined;
		reader.readBranchSpan = async (id, cut) => {
			donorIndex ??= reader.prepareResume(source.sessionId).then((prepared) => prepared.index);
			return transcriptBranchSpan(id, await donorIndex, cut);
		};
		reader.readEntryChunk = this.forkChunkReader(tx, await this.viewTables(tx), reader, source.sessionId, head.epoch);
		// The source's rows the child keeps unchanged, copied a run at a time rather than written a row at a time (#6560),
		// or, with shared history, named by the child's segments.
		const copies = new ForkRowRuns(this.tables, header.id, source.sessionId);
		const lineage = this.lineageTables();
		const runs =
			shared === undefined
				? undefined
				: new ForkSegmentRuns(lineage, header.id, {
						id: source.sessionId,
						segments: shared.segments,
						length: shared.lastSeq,
					});
		const viewTables = await this.viewTables(tx);
		const lookup = async (id: string) =>
			(runs ?? copies).heldSeq(id) ?? this.seqOfEntry(tx, viewTables, header.id, id);
		let summary = applySessionSummaryEntries(undefined, []).state;
		let index = foldSessionResume(undefined, []),
			seq = 0;
		const hashes = new Set<string>();
		const inlineSnapshot = async (ref: OversizedSessionEntry) => {
			// v4 snapshot-GC triggers inspect inline JSON. Only this one original row may
			// cross the usual page bound. Previously chunked snapshots remain streamed.
			const text = (key: string) => this.dialect.jsonText("entry_json", key);
			const ty = (key: string) => this.dialect.jsonType("entry_json", key);
			const view = this.entriesView(await this.viewTables(tx), ref.sessionId, ref.seq - 1, ref.seq);
			const s = await tx.get<
				SqliteRow & {
					id: string;
					parent: string | null;
					stamp: string;
					root: string;
					snapshot: string;
					capture: number | null;
					record: string | null;
					restore: string | null;
					unrestored: string | null;
					degraded: string | null;
				}
			>(
				withForkViews(
					[view],
					`SELECT entry_id AS id,${text("parentId")} AS parent,${text("timestamp")} AS stamp,${text("root")} AS root,${text("snapshotId")} AS snapshot,${text("captureMs")} AS capture,${ty("snapshot")} AS record,${ty("restore")} AS restore,${ty("unrestored")} AS unrestored,${text("degradedFrom")} AS degraded FROM ${view.name} WHERE chunks=0 AND ${text("type")}='worktree_snapshot'`,
				),
				...view.params,
			);
			if (!s) return undefined;
			// These flags are consumed only by the resume index. The writer copies the original v4 row.
			return {
				type: "worktree_snapshot",
				id: s.id,
				parentId: s.parent,
				timestamp: s.stamp,
				root: s.root,
				snapshotId: s.snapshot,
				...(s.capture !== null ? { captureMs: Number(s.capture) } : {}),
				...(s.record === "object" ? { snapshot: {} } : {}),
				...(s.restore === "object" ? { restore: {} } : {}),
				...(s.unrestored === "object" ? { unrestored: {} } : {}),
				...(s.degraded ? { degradedFrom: s.degraded } : {}),
			} as SessionEntry;
		};
		const writes = new SentWrites(tx);
		const blobs: { copy?: ForkBlobCopy | undefined } = {};
		// Whether a row was copied from the source's stored bytes, which `finishForkCopy` checks are complete.
		let copiedRows = false;
		const remainingBlobs = await writes.around(async () => {
			for await (const row of stream.read(reader, async (id) => (await lookup(id)) !== undefined, inlineSnapshot)) {
				index = await foldForkRow(index, row, lookup);
				const entry = row.entry;
				const listed = applySessionSummaryEntries(summary, [entry]);
				summary = listed.state;
				const unchanged = row.stored?.sessionId === source.sessionId && row.edits === undefined;
				// A shared row's blob is read where its source stores it; only the child's own rows copy theirs.
				if (entry.type === "custom" && entry.customType === "atomic.tool-output" && !(unchanged && runs)) {
					const hash = (entry.data as { hash?: string })?.hash;
					if (typeof hash === "string") hashes.add(hash);
				}
				if (unchanged && runs !== undefined) {
					// Its search texts too are the source's, read through the child's view.
					runs.add(row.stored!.seq, seq + 1, entry.id);
					if (runs.full) await writes.send(runs.drain());
					seq++;
					continue;
				}
				if (row.stored?.sessionId === source.sessionId && row.edits === undefined) {
					copiedRows = true;
					copies.add(row.stored.seq, seq + 1, entry.id);
					await writes.send(this.entryWrites(header.id, [], seq, listed.texts, false));
					if (copies.full) await writes.send(copies.drain());
					seq++;
					continue;
				}
				// What the child holds is in seq order, for the snapshot index's triggers: the runs before this row first.
				await writes.send(runs?.drain() ?? copies.drain());
				if (!row.reference) {
					await writes.send(this.entryWrites(header.id, [entry], seq, listed.texts, false));
				} else if (row.inlineSnapshot) {
					await this.writeInlineForkSnapshot(tx, reader, row.reference, header.id, seq, listed.texts, row.edits);
				} else {
					copiedRows = true;
					const encoded = await encodedForkRow(reader, row);
					const chunks = Math.ceil(encoded.size / SESSION_ENTRY_CHUNK_BYTES);
					await tx.run(
						`INSERT INTO ${this.tables.entries} (session_id,seq,entry_id,entry_json,chunks) VALUES (?,?,?,?,?)`,
						header.id,
						seq + 1,
						entry.id,
						JSON.stringify({ type: entry.type, id: entry.id, parentId: entry.parentId ?? null }),
						chunks,
					);
					let n = 0,
						used = 0,
						buffer = new Uint8Array(SESSION_ENTRY_CHUNK_BYTES);
					const write = async () => {
						await tx.run(
							`INSERT INTO ${this.tables.entryChunks} (session_id,seq,idx,data) VALUES (?,?,?,?)`,
							header.id,
							seq + 1,
							n++,
							buffer.subarray(0, used),
						);
						used = 0;
					};
					for await (const part of encoded.chunks())
						for (let start = 0; start < part.length; ) {
							const count = Math.min(part.length - start, buffer.length - used);
							buffer.set(part.subarray(start, start + count), used);
							start += count;
							used += count;
							if (used === buffer.length) await write();
						}
					if (used) await write();
					if (n !== chunks) throw new StorageError("Incomplete historical entry in fork");
					await writes.send(this.entryWrites(header.id, [], seq, listed.texts, false));
				}
				seq++;
			}
			const last: CountedStatement[] = [...(runs?.drain() ?? copies.drain())];
			if (runs !== undefined) {
				assertForkSegments(header.id, runs.segments, seq);
				last.push(forkLineageWrite(lineage, header.id, { parentId: source.sessionId, cutSeq: head.lastSeq }));
			}
			const statement = this.summaryWrite(header.id, { header, entries: [], lastSeq: seq }, summary, index);
			last.push(statement.statement);
			if (!copiedRows && hashes.size === 0) {
				// Every row the child stores was written whole from what the stream gave, and it has no blob to copy: nothing
				// to check after them, so the last writes go out with the commit where the connection is pipelined.
				last.push(this.forkVersionStep(header.id));
				if (transactionFinisher(tx)?.(last) !== true) await writes.send(last);
				return { remaining: [], epoch: statement.epoch, finished: true };
			}
			await writes.send(last);
			blobs.copy = this.forkBlobCopy(source.sessionId, header.id, hashes);
			const remaining = await this.finishForkCopy(tx, writes, header.id, blobs.copy, hashes);
			return { remaining, epoch: statement.epoch, finished: false };
		});
		if (!remainingBlobs.finished) await this.finishFork(tx, header.id);
		return { lastSeq: seq, epoch: remainingBlobs.epoch, remainingBlobs: remainingBlobs.remaining };
	}

	/**
	 * The donor `reads` read, when the fork made them, asked for at once: its reads then go out beside the schema check,
	 * in one wait for the connection, as a `create`'s first read does. The fork uses it only once the schema it checks in
	 * this transaction has shared history: a store that saw shared history may meet a database whose schema says
	 * otherwise, and a fork there never names its source's rows. Unused, its failure is nobody's.
	 */
	private leadingForkDonor(
		tx: SqliteExecutor,
		child: string,
		source: ForkArchiveSource,
		reads: SharedForkReads | undefined,
	): Promise<SharedForkDonor> | undefined {
		if (reads === undefined) return undefined;
		const read = this.sharedForkDonor(tx, child, source, reads);
		read.catch(() => {});
		return read;
	}

	/** Notes the sessions session `id`'s segments name, which a fork of it locks. */
	private noteForkSources(id: string, sources: readonly string[]): void {
		this.forkSources.delete(id);
		this.forkSources.set(id, sources);
		while (this.forkSources.size > 16) this.forkSources.delete(this.forkSources.keys().next().value!);
	}

	/** The fork tables of this store's database, which exist once it has shared history (#6560). */
	private lineageTables(): ForkLineageTables {
		return {
			sessions: this.tables.sessions,
			forkSegments: this.forkTables.forkSegments,
			forkLineage: this.forkTables.forkLineage,
		};
	}

	/**
	 * The reads that begin a fork of session `donor` into `child` with shared history (#6560), in order: whether the child
	 * exists; the rows of the donor and of the sessions its segments name, as the statement starts or as this store last
	 * saw them, each locked `key-share` in id order, unless the child exists, with the donor's watermark and generation,
	 * and with `withState` its summary state; then the donor's segments, read once those locks are held.
	 */
	private sharedForkReads(child: string, donor: string, withState: boolean): SharedForkReads {
		const ids = [...new Set([donor, ...(this.forkSources.get(donor) ?? [])])].sort();
		const epoch = `COALESCE(${this.dialect.jsonText("summary_state", "epoch")}, ${this.dialect.jsonText("summary_state", "resume", "epoch")}, revision)`;
		return {
			ids,
			exists: { sql: `SELECT id FROM ${this.tables.sessions} WHERE id = ?`, params: [child] },
			lock: {
				sql: `SELECT id, last_seq, CASE WHEN id = ? THEN ${epoch} END AS epoch${withState ? ", CASE WHEN id = ? THEN summary_state END AS summary_state" : ""}
					FROM ${this.tables.sessions} WHERE (id IN (${ids.map(() => "?").join(", ")})
						OR id IN (SELECT source_id FROM ${this.forkTables.forkSegments} WHERE session_id = ?))
					AND NOT EXISTS (SELECT 1 FROM ${this.tables.sessions} c WHERE c.id = ?) ORDER BY id${this.dialect.lockClause("key-share")}`,
				params: [donor, ...(withState ? [donor] : []), ...ids, donor, child],
			},
			// A source deleted while forks still read it keeps only a tombstone, which the sweep that removes its rows locks:
			// the fork locks it too, after the sessions rows, as every writer orders them.
			tombstones: {
				sql: `SELECT session_id FROM ${this.forkTables.forkTombstones} WHERE session_id IN (${ids.map(() => "?").join(", ")})
					OR session_id IN (SELECT source_id FROM ${this.forkTables.forkSegments} WHERE session_id = ?)
					ORDER BY session_id${this.dialect.lockClause("key-share")}`,
				params: [...ids, donor],
			},
			segments: {
				sql: `SELECT source_id, from_seq, to_seq, base_seq FROM ${this.forkTables.forkSegments} WHERE session_id = ? ORDER BY idx`,
				params: [donor],
			},
		};
	}

	/**
	 * The donor of a fork with shared history (#6560), from `reads`: its watermark, as the locking read found it, is the
	 * fork's cut-off. Throws `ForkSourcesMoved`, for the fork to run again, when the donor's segments name a session the
	 * reads did not lock: the donor's segments changed since this store last forked it.
	 */
	private async sharedForkDonor(
		tx: SqliteExecutor,
		child: string,
		source: ForkArchiveSource,
		reads: SharedForkReads,
	): Promise<SharedForkDonor> {
		type Locked = SqliteRow & { id: string; last_seq: number; epoch: string | null; summary_state?: string | null };
		type Segment = SqliteRow & { source_id: string; from_seq: number; to_seq: number; base_seq: number };
		const settle = <T>(read: Promise<T>) =>
			read.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
		const existing = settle(tx.get(reads.exists.sql, ...reads.exists.params));
		const locked = settle(tx.all<Locked>(reads.lock.sql, ...reads.lock.params));
		const tombstones = settle(
			tx.all<SqliteRow & { session_id: string }>(reads.tombstones.sql, ...reads.tombstones.params),
		);
		const segmentRows = settle(tx.all<Segment>(reads.segments.sql, ...reads.segments.params));
		for (const read of [existing, locked, tombstones, segmentRows]) {
			const answer = await read;
			if ("error" in answer) throw answer.error;
		}
		const answer = <T>(read: { value: T } | { error: unknown }) => (read as { value: T }).value;
		if (answer(await existing)) throw new SessionExistsError(child);
		const row = answer(await locked).find((candidate) => String(candidate.id) === source.sessionId);
		if (row === undefined) throw new SessionNotFoundError(source.sessionId);
		const segments = answer(await segmentRows).map((segment) => ({
			sourceId: String(segment.source_id),
			fromSeq: Number(segment.from_seq),
			toSeq: Number(segment.to_seq),
			baseSeq: Number(segment.base_seq),
		}));
		const sources = [...new Set(segments.map((segment) => segment.sourceId))].sort();
		this.noteForkSources(source.sessionId, sources);
		// The lock read found the donor's sources as its statement began. One that moved the donor's history while the read
		// waited for the donor's lock may have named others since: the fork then runs again, locking those.
		const lockedIds = new Set([
			...reads.ids,
			...answer(await locked).map((candidate) => String(candidate.id)),
			...answer(await tombstones).map((candidate) => String(candidate.session_id)),
		]);
		if (sources.some((id) => !lockedIds.has(id))) throw new ForkSourcesMoved();
		const lastSeq = Number(row.last_seq);
		const epoch = String(row.epoch);
		if (source.epoch !== undefined && epoch !== source.epoch)
			throw new SessionConflictError(source.sessionId, 0, lastSeq);
		return {
			lastSeq,
			epoch,
			segments,
			...(typeof row.summary_state === "string"
				? { state: JSON.parse(row.summary_state) as StoredSummaryState }
				: {}),
		};
	}

	/**
	 * A fork with shared history of the donor's whole view as it stands (#6560): its segments, its lineage and its
	 * session row, whose summary is the donor's in a generation of its own, and no row of any entry. Undefined, for
	 * the fork to read the donor's rows, when the donor's resume index does not cover its watermark.
	 */
	private async writeSharedPrefixFork(
		tx: SqliteExecutor,
		header: SessionRecordHeader,
		donorId: string,
		donor: SharedForkDonor,
	): Promise<(SessionWriteResult & { readonly remainingBlobs: readonly string[] }) | undefined> {
		const index = donor.state === undefined ? undefined : windowIndex(donor.state, donor.lastSeq);
		if (donor.state === undefined || index === undefined) return undefined;
		const epoch = newRevision();
		const segments = prefixForkSegments(donorId, donor.segments, donor.lastSeq, donor.lastSeq);
		const { resume: _resume, windowResume: _window, epoch: _epoch, ...listed } = donor.state;
		const summary = this.summaryWrite(
			header.id,
			{ header, entries: [], lastSeq: donor.lastSeq },
			{ ...listed, epoch } as StoredSummaryState,
			{ ...index, epoch },
		);
		const lineage = this.lineageTables();
		assertForkSegments(header.id, segments, donor.lastSeq);
		const statements = [
			...forkSegmentInserts(lineage, header.id, 0, segments),
			forkLineageWrite(lineage, header.id, { parentId: donorId, cutSeq: donor.lastSeq }),
			summary.statement,
		];
		// The transaction's last writes: where its connection is pipelined, they go out with its commit.
		if (transactionFinisher(tx)?.(statements) !== true)
			for (const { sql, params } of statements) await tx.run(sql, ...params);
		return { lastSeq: donor.lastSeq, epoch: summary.epoch, remainingBlobs: [] };
	}

	/**
	 * `readEntryChunk` for a fork's reader bound to transaction `tx`, reading session `source` in generation `epoch`: a
	 * read of an entry fetches a whole stored chunk row, or a part as large of an entry stored whole, and answers the next
	 * reads of it from that, so an entry costs a round trip a chunk, not one every 64 KiB (#6560). The fork holds the
	 * source's row, so its generation cannot change meanwhile. Other reads go to `reader` as before.
	 */
	private forkChunkReader(
		tx: SqliteExecutor,
		tables: ForkViewTables,
		reader: SqlSessionStore,
		source: string,
		epoch: string,
	): NonNullable<SessionStore["readEntryChunk"]> {
		const json = this.dialect.name === "sqlite" ? "CAST(e.entry_json AS BLOB)" : "convert_to(e.entry_json, 'UTF8')";
		let held: { readonly seq: number; readonly start: number; readonly data: Uint8Array } | undefined;
		return async (reference, offset, bytes = SESSION_HISTORY_CHUNK_BYTES) => {
			if (reference.sessionId !== source || reference.epoch !== epoch)
				return SqlSessionStore.prototype.readEntryChunk.call(reader, reference, offset, bytes);
			const part = Math.floor(offset / SESSION_ENTRY_CHUNK_BYTES);
			const start = part * SESSION_ENTRY_CHUNK_BYTES;
			if (held?.seq !== reference.seq || held.start !== start) {
				const view = this.entriesView(tables, source, reference.seq - 1, reference.seq);
				const row = await tx.get<SqliteRow & { data: Uint8Array | null }>(
					withForkViews(
						[view],
						`SELECT CASE WHEN e.chunks > 0
						THEN (SELECT c.data FROM ${this.tables.entryChunks} c WHERE c.session_id = e.src_id AND c.seq = e.src_seq AND c.idx = ?)
						ELSE substr(${json}, CAST(? AS INTEGER), CAST(? AS INTEGER)) END AS data
					FROM ${view.name} e`,
					),
					...view.params,
					part,
					start + 1,
					SESSION_ENTRY_CHUNK_BYTES,
				);
				if (row?.data == null || row.data.byteLength <= offset - start)
					return SqlSessionStore.prototype.readEntryChunk.call(reader, reference, offset, bytes);
				held = { seq: reference.seq, start, data: row.data };
			}
			const from = offset - start;
			return held.data.subarray(
				from,
				from + Math.min(Math.max(1, Math.trunc(bytes) || 1), SESSION_HISTORY_PAGE_BYTES),
			);
		};
	}

	/** Keep the legacy inline payload outside the iterator's yielded value and the caller's async frame:
	 * neither may retain this row while the next SQLite result is being delivered. */
	private async writeInlineForkSnapshot(
		tx: SqliteExecutor,
		reader: SessionStore,
		ref: OversizedSessionEntry,
		child: string,
		seq: number,
		texts: readonly SessionSummaryText[],
		edits: Readonly<Record<string, string | null>> | undefined,
	) {
		const original = (await reader.readRange!(ref.sessionId, ref.seq, ref.seq, ref.epoch)).entries[0];
		if (original?.type !== "worktree_snapshot") throw new SessionConflictError(ref.sessionId, ref.seq, seq);
		await this.insertEntries(tx, child, [edits ? { ...original, ...edits } : original], seq, texts, false);
	}

	async append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const fast = await this.appendThroughFunction(sessionId, entries, options);
		if (fast !== undefined) return fast;
		let written: WrittenEntry[] = [];
		let writtenRow: WrittenRow | undefined;
		const appended = await this.transactionCheckedAlongside(
			async (tx, checked) => {
				writtenRow = undefined;
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
				const summary = this.summaryWrite(
					sessionId,
					{ header: JSON.parse(previous.header_json) as SessionRecordHeader, entries, lastSeq },
					summaryState,
					await this.appendedResume(
						tx,
						sessionId,
						windowIndex(summaryState, previous.last_seq),
						previous.last_seq,
						entries,
					),
				);
				written = [];
				const statements = this.entryWrites(sessionId, entries, previous.last_seq, summary.texts, true, written);
				await checked;
				writtenRow = summary.row;
				await this.writeEntries(tx, summary.statement, statements);
				// The generation the session is in once this commits: the one a fork of it later finds, while only appends
				// follow.
				return { lastSeq, epoch: summary.epoch };
			},
			this.sessionWrite(sessionId, this.headRead(sessionId, options, true)),
		);
		this.noteWritten(sessionId, appended.epoch, written);
		this.rememberWritten(sessionId, writtenRow);
		return { lastSeq: appended.lastSeq };
	}

	/**
	 * Remembers `row`, the session's row a committed write of this store left, for the next append to plan from, where
	 * appends go through the append function; forgets the session's row when `row` is undefined. At most
	 * {@link WRITTEN_ROWS} sessions are remembered, the latest written.
	 */
	private rememberWritten(sessionId: string, row: WrittenRow | undefined): void {
		this.writtenRows.delete(sessionId);
		if (row === undefined || this.appendFunction === undefined) return;
		this.writtenRows.set(sessionId, row);
		while (this.writtenRows.size > WRITTEN_ROWS) this.writtenRows.delete(this.writtenRows.keys().next().value!);
	}

	/**
	 * Appends `entries` in one round trip through the session append function, planned from the row this store's last
	 * write of the session left (#6599). The function takes the session's locks as a session write transaction does,
	 * checks the schema version, the session and its expected seq as `forWrite` does, writes nothing unless the stored
	 * row is still the one planned from, checks the snapshot blobs as `assertStored` does, and writes the row, the
	 * entries and their search texts in the order an append's transaction does. Undefined, having written nothing, when
	 * the append is not one it plans (no function, no remembered row, a row other than the stored one, invalid entries,
	 * a chunked entry or more than one batch of writes, an entry that refers back past the resume window): the caller
	 * then appends in a transaction as before, which reads the row itself and reports what fails.
	 */
	private async appendThroughFunction(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number } | undefined> {
		const fn = this.appendFunction;
		const autocommit = this.database.autocommit?.bind(this.database);
		const previous = this.writtenRows.get(sessionId);
		if (fn === undefined || autocommit === undefined || previous === undefined) return undefined;
		if (previous.last_seq !== options.expectSeq) return undefined;
		const state = JSON.parse(previous.summary_state) as StoredSummaryState;
		if (options.epoch !== undefined && state.epoch !== options.epoch) return undefined;
		try {
			validateSessionEntries(entries);
		} catch {
			return undefined;
		}
		const window = windowIndex(state, previous.last_seq);
		// An entry whose resume fold looks up an earlier entry's seq reads in the append's transaction.
		if (isSessionResumeIndex(window, previous.last_seq) && foreignResumeIds(window, entries).length > 0)
			return undefined;
		const lastSeq = previous.last_seq + entries.length;
		const summary = this.summaryWrite(
			sessionId,
			{ header: JSON.parse(previous.header_json) as SessionRecordHeader, entries, lastSeq },
			state,
			await this.appendedResume(this.database, sessionId, window, previous.last_seq, entries),
		);
		const rows: [string, string][] = [];
		const written: WrittenEntry[] = [];
		let bytes = statementBytes(summary.statement);
		for (const [index, entry] of entries.entries()) {
			const json = this.encode(entry);
			const stored = storedEntry(entry, json);
			bytes += entry.id.length + stored.json.length;
			if (stored.chunks.length > 0 || bytes > STATEMENT_BATCH_BYTES) return undefined;
			rows.push([entry.id, stored.json]);
			written.push({ entry, seq: previous.last_seq + index + 1, json });
		}
		const texts = summary.texts.map(({ index, text }): [number, string] => [
			previous.last_seq + index + 1,
			this.encode(text),
		]);
		const blobs = this.blobTable.storedHashes(
			entries.flatMap((entry) =>
				entry.type === "worktree_snapshot" && entry.snapshot !== undefined ? [entry.snapshot] : [],
			),
		);
		const { concurrency = { kind: "serial" } } = sessionWriteTransaction(this.tables.sessions, sessionId);
		const [answer] = (await autocommit(
			{
				sql: `SELECT outcome, detail FROM ${fn}(${Array.from({ length: 24 }, () => "?").join(", ")})`,
				params: [
					concurrency.kind === "serial" ? (concurrency.domain ?? "") : "",
					SESSION_SCHEMA_VERSION_UNCHUNKED,
					SESSION_SCHEMA_VERSION,
					sessionId,
					previous.last_seq,
					previous.revision,
					await sha256Hex(new TextEncoder().encode(`${previous.header_json}\n${previous.summary_state}`)),
					blobs.length === 0 ? null : JSON.stringify(blobs),
					...summary.statement.params.slice(1),
					JSON.stringify(rows),
					JSON.stringify(texts),
				],
			},
			concurrency,
		)) as AppendOutcomeRow[];
		switch (answer?.outcome) {
			case "appended":
				// As an append's transaction does, for a fork of the session to share these rows (#6560).
				this.noteWritten(sessionId, summary.epoch, written);
				this.rememberWritten(sessionId, summary.row);
				return { lastSeq };
			case "version":
				assertStorageSchemaVersion(
					"sessions",
					answer.detail === null ? null : Number(answer.detail),
					SESSION_SCHEMA_VERSION,
					SESSION_SCHEMA_VERSION_UNCHUNKED,
				);
				break;
			case "missing":
				throw new SessionNotFoundError(sessionId);
			case "conflict":
				throw new SessionConflictError(sessionId, options.expectSeq, Number(answer.detail));
			case "blob":
				return this.blobTable.refuseCollected(String(answer.detail));
		}
		// The stored row is not the one planned from: another writer, or a refresh of its resume index, wrote it since.
		this.writtenRows.delete(sessionId);
		return undefined;
	}

	/**
	 * The session append function of the store's tables, `<prefix>session_append_v1`: one statement, and so one round
	 * trip, for what an append's transaction does with its two (#6599). Created by `atomic storage migrate` through
	 * {@link prepareAppendFunction}. It runs with the caller's rights, so it lets a role do nothing its table
	 * privileges do not, and in the caller's `search_path`, the schema a transaction of the store sets. It writes no
	 * chunked entry: an append that has one goes through a transaction. Its answer is one row: `appended`, or why it
	 * wrote nothing, with the stored version (`version`), the stored last seq (`conflict`), the first blob that is not
	 * stored (`blob`), no session (`missing`), or a stored row other than the one the caller planned from (`stale`).
	 */
	private appendFunctionSql(fn: string): string {
		const t = this.tables;
		return `CREATE OR REPLACE FUNCTION ${fn}(
	p_domain text, p_oldest bigint, p_newest bigint, p_session_id text, p_expect_seq bigint, p_revision text,
	p_digest text, p_blobs text, p_cwd text, p_created_at text, p_header_json text, p_internal bigint, p_last_seq bigint,
	p_modified_at text, p_message_count bigint, p_first_message text, p_name text, p_has_name bigint, p_summary text,
	p_summarized_through_id text, p_summary_state text, p_new_revision text, p_entries text, p_texts text
) RETURNS TABLE (outcome text, detail text) LANGUAGE plpgsql AS $append$
#variable_conflict use_column
DECLARE
	scope text := CASE WHEN current_schema() = 'public' THEN '' ELSE current_schema() || ':' END;
	stored_version bigint;
	head record;
	stored_blobs text[];
	missing_blob text;
BEGIN
	-- The locks of a session write transaction, waited for as long as one waits: its lock wait is the statement timeout.
	PERFORM set_config('lock_timeout', current_setting('statement_timeout'), true);
	PERFORM pg_advisory_xact_lock_shared(hashtextextended(scope || 'atomic', 0)),
		pg_advisory_xact_lock(hashtextextended(scope || p_domain, 0));
	SELECT schema_version INTO stored_version FROM ${t.meta};
	IF stored_version IS NULL OR stored_version < p_oldest OR stored_version > p_newest THEN
		RETURN QUERY SELECT 'version'::text, stored_version::text;
		RETURN;
	END IF;
	SELECT s.last_seq, s.revision,
		encode(sha256(convert_to(s.header_json || E'\n' || s.summary_state, 'UTF8')), 'hex') AS digest
		INTO head FROM ${t.sessions} AS s WHERE s.id = p_session_id;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'missing'::text, NULL::text;
		RETURN;
	END IF;
	IF head.last_seq <> p_expect_seq THEN
		RETURN QUERY SELECT 'conflict'::text, head.last_seq::text;
		RETURN;
	END IF;
	IF head.revision <> p_revision OR head.digest <> p_digest THEN
		RETURN QUERY SELECT 'stale'::text, NULL::text;
		RETURN;
	END IF;
	IF p_blobs IS NOT NULL THEN
		SELECT array_agg(locked.hash) INTO stored_blobs FROM (${this.blobTable.storedBlobsQuery("p_blobs")}) AS locked;
		SELECT h.value INTO missing_blob FROM json_array_elements_text(p_blobs::json) WITH ORDINALITY AS h(value, ord)
			WHERE h.value <> ALL (coalesce(stored_blobs, '{}'::text[])) ORDER BY h.ord LIMIT 1;
		IF missing_blob IS NOT NULL THEN
			RETURN QUERY SELECT 'blob'::text, missing_blob;
			RETURN;
		END IF;
	END IF;
	INSERT INTO ${t.sessions}
		(id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count,
		 first_message, name, has_name, summary, summarized_through_id, summary_state, revision)
		VALUES (p_session_id, p_cwd, p_created_at, p_header_json, p_internal, p_last_seq, p_modified_at, p_message_count,
		 p_first_message, p_name, p_has_name, p_summary, p_summarized_through_id, p_summary_state, p_new_revision)
		ON CONFLICT(id) DO UPDATE SET
		cwd = excluded.cwd, created_at = excluded.created_at, header_json = excluded.header_json,
		internal = excluded.internal, last_seq = excluded.last_seq, modified_at = excluded.modified_at,
		message_count = excluded.message_count, first_message = excluded.first_message, name = excluded.name,
		has_name = excluded.has_name, summary = excluded.summary,
		summarized_through_id = excluded.summarized_through_id,
		summary_state = excluded.summary_state, revision = excluded.revision;
	INSERT INTO ${t.entries} (session_id, seq, entry_id, entry_json, chunks)
		SELECT p_session_id, p_expect_seq + e.ord, e.value->>0, e.value->>1, 0
		FROM json_array_elements(p_entries::json) WITH ORDINALITY AS e(value, ord) ORDER BY e.ord;
	INSERT INTO ${t.searchTexts} (session_id, seq, text_json)
		SELECT p_session_id, (x.value->>0)::bigint, x.value->>1
		FROM json_array_elements(p_texts::json) WITH ORDINALITY AS x(value, ord) ORDER BY x.ord;
	RETURN QUERY SELECT 'appended'::text, NULL::text;
END
$append$`;
	}

	/**
	 * Creates the session append function (#6599), once per revision, as the ledger records it, and lets every role that
	 * may insert into the sessions table execute it: `atomic storage migrate` runs this as the owner role, and a
	 * runtime role appends through the function from its next open on. PostgreSQL only; does nothing elsewhere.
	 */
	async prepareAppendFunction(): Promise<void> {
		this.assertOpen();
		if (this.dialect.name !== "postgres") return;
		const fn = renderStorageIdentifiers("sessions", { append: SESSION_APPEND_FUNCTION }, this.prefix).append;
		const ledger = storageMigrationTable(this.prefix);
		const physical = (name: string) => this.dialect.identifier(name).replaceAll("'", "''");
		await this.database.transaction(
			async (tx) => {
				await ensureStorageSchema(
					tx,
					this.dialect,
					{ ledger, domain: SESSION_APPEND_FUNCTION_DOMAIN, revision: SESSION_APPEND_FUNCTION_REVISION },
					() => tx.exec(this.appendFunctionSql(fn)),
				);
				// Every role granted INSERT on the sessions table, the runtime role among them, may run the function, and
				// gains no other right by it: it runs with the caller's.
				await tx.exec(`DO $grant$
DECLARE grantee text;
BEGIN
	FOR grantee IN SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
		FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) AS a
		WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = '${physical(this.tables.sessions)}'
			AND a.privilege_type = 'INSERT' AND a.grantee <> c.relowner
	LOOP
		EXECUTE format('GRANT EXECUTE ON FUNCTION %I TO %s', '${physical(fn)}', grantee);
	END LOOP;
END
$grant$`);
			},
			{ retryTransientFailures: true, concurrency: { kind: "serial", domain: ledger } },
		);
	}

	async replace(
		sessionId: string,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<SessionWriteResult> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		this.writtenRows.delete(sessionId);
		let released: readonly string[] = [];
		let entriesWritten: WrittenEntry[] = [];
		const pinReads = this.sharedHistorySeen
			? forkPinReads(this.forkHost(), this.tables.sessions, sessionId)
			: undefined;
		const written = await this.transactionCheckedAlongside(
			async (tx, checked) => {
				released = [];
				entriesWritten = [];
				// The session's row and its fork history are read beside the schema check, in one wait for the connection.
				const [, pins] = await Promise.all([
					this.forWrite(tx, sessionId, options),
					this.readForkPinsWithin(tx, sessionId, pinReads),
				]);
				await checked;
				validateSessionHeader(header);
				validateSessionEntries(entries);
				if (header.id !== sessionId) throw new SessionIdMismatchError(sessionId, header.id);
				// Forks reading the rows about to go get their own copies; the session holds all of its new rows itself. A fork
				// whose copy a missing chunk of these rows refuses keeps reading them, so the replace is refused instead.
				if (pins !== undefined)
					released = await replaceForkedSessionWithin(this.forkHost(), tx, sessionId, pins).catch(
						(error: unknown) => {
							noteForkCopyRefusal(error, "replace");
							throw error;
						},
					);
				await this.searchIndex?.forgetWithin(tx, sessionId);
				await tx.run(`DELETE FROM ${this.tables.searchTexts} WHERE session_id = ?`, sessionId);
				await tx.run(`DELETE FROM ${this.tables.entryChunks} WHERE session_id = ?`, sessionId);
				await tx.run(`DELETE FROM ${this.tables.entries} WHERE session_id = ?`, sessionId);
				const { texts, epoch } = await this.saveSummary(tx, sessionId, {
					header,
					entries,
					lastSeq: entries.length,
				});
				await this.insertEntries(tx, sessionId, entries, 0, texts, true, entriesWritten);
				return { lastSeq: entries.length, epoch };
			},
			this.sessionWrite(
				sessionId,
				...(pinReads === undefined ? [] : [this.headRead(sessionId, options, false), ...pinReads]),
			),
		);
		this.noteWritten(sessionId, written.epoch, entriesWritten);
		await this.sweepReleasedForkRows(released);
		return written;
	}

	async updateHeader(header: SessionRecordHeader, options: SessionWriteOptions): Promise<SessionWriteResult> {
		this.assertOpen();
		validateSessionHeader(header);
		this.writtenRows.delete(header.id);
		return this.transaction(
			async (tx) => {
				const { row, state } = await this.forWrite(tx, header.id, options, true);
				const epoch = newRevision();
				const resume = windowIndex(state, row.last_seq);
				const { statement } = this.summaryWrite(
					header.id,
					{ header, entries: [], lastSeq: row.last_seq },
					{ ...state, epoch } as StoredSummaryState,
					resume && { ...resume, epoch },
				);
				// The transaction's last write: where its connection is pipelined, it goes out with the commit.
				if (transactionFinisher(tx)?.([statement]) !== true) await tx.run(statement.sql, ...statement.params);
				return { lastSeq: row.last_seq, epoch };
			},
			this.sessionWrite(header.id, this.headRead(header.id, options, true)),
		);
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
		return this.readTransaction((tx) => this.read(tx, sessionId));
	}

	async readEntryRange(sessionId: string, query: SessionEntriesQuery): Promise<SessionEntriesPage> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		query.signal?.throwIfAborted();
		const fromSeq = Math.max(1, query.fromSeq);
		const skippedSet = query.skipTypes === undefined ? undefined : new Set(query.skipTypes);
		const skippedPrefixes = (query.skipTypes ?? []).map((type) => `{"type":${JSON.stringify(type)},`);
		const largeBytes = query.largeEntryBytes ?? 0x7fffffff;
		// The session's watermark and the page up to it, in one statement and so one snapshot: a read each, in turn, cost
		// a search a second round trip for every page it reads (#6560). The session's row, joined to a page that may be
		// empty, is a row with no entry; no row at all is a session that does not exist. The page reads the session's
		// view; a page that should hold an entry and holds none was held back by the read's own check of the schema.
		const maxChars =
			query.maxChars !== undefined && query.maxChars <= 0 ? 0 : (query.maxChars ?? Number.MAX_SAFE_INTEGER);
		const read = await this.outsideSessionRead(
			sessionId,
			(tables) => {
				const view = this.entriesView(tables, sessionId, fromSeq - 1, Math.min(query.toSeq, FORK_VIEW_END));
				return this.database.all<
					SqliteRow & {
						forked?: number;
						last_seq: number | bigint;
						seq: number | bigint | null;
						entry_json: string | null;
						entry_head: string;
						chunks: number | bigint;
						remaining: number | bigint;
						entry_type: string | null;
					}
				>(
					withForkViews(
						[view],
						`WITH sized AS (
				SELECT seq, chunks, src_id, src_seq, ${this.entryByteLength("entry_json")} AS raw_bytes,
					${this.entryByteLength("entry_json")} + chunks * ? AS bytes
				FROM ${view.name}
				WHERE seq <= (SELECT last_seq FROM ${this.tables.sessions} WHERE id = ?)
			),
			paged AS (
				SELECT seq, chunks, src_id, src_seq, raw_bytes, count(*) OVER () AS remaining,
					sum(bytes) OVER (ORDER BY seq) - bytes AS before_chars
				FROM sized
			),
			page AS (
				SELECT p.seq, CASE WHEN p.chunks = 0 AND p.raw_bytes <= ? THEN e.entry_json END AS entry_json,
					substr(e.entry_json, 1, 64) AS entry_head, p.chunks, p.remaining,
					CASE WHEN p.chunks = 0 AND p.raw_bytes > ? AND substr(e.entry_json, 1, 8) <> '{"type":'
						THEN ${this.dialect.jsonText("e.entry_json", "type")} END AS entry_type
				FROM paged p
				JOIN ${this.tables.entries} e ON e.session_id = p.src_id AND e.seq = p.src_seq
				WHERE p.before_chars < ?
			)
			SELECT s.last_seq, page.seq, page.entry_json, page.entry_head, page.chunks, page.remaining, page.entry_type${this.outsideForkedColumn("s.id")}
			FROM ${this.tables.sessions} s LEFT JOIN page ON 1 = 1
			WHERE s.id = ?
			ORDER BY page.seq`,
					),
					...view.params,
					SESSION_ENTRY_CHUNK_BYTES,
					sessionId,
					largeBytes,
					largeBytes,
					maxChars,
					sessionId,
				);
			},
			(found) => {
				const session = found[0];
				if (session === undefined || maxChars <= 0) return true;
				if (fromSeq > Math.min(query.toSeq, Number(session.last_seq))) return true;
				return found.some((row) => row.seq !== null && row.seq !== undefined);
			},
			(found) => found[0]?.forked,
		);
		const session = read[0];
		if (!session) throw new SessionNotFoundError(sessionId);
		const lastSeq = Number(session.last_seq);
		const toSeq = Math.min(query.toSeq, lastSeq);
		if (fromSeq > toSeq) return { lastSeq, entries: [], throughSeq: Math.max(toSeq, fromSeq - 1) };
		if (query.maxChars !== undefined && query.maxChars <= 0) return { lastSeq, entries: [], throughSeq: fromSeq - 1 };
		const rows = read.filter(
			(row): row is typeof row & { seq: number | bigint } => row.seq !== null && row.seq !== undefined,
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
				const rawChunks = await this.readRawEntryChunks(
					this.database,
					undefined,
					sessionId,
					seq,
					chunks,
					query.signal,
				);
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
		this.writtenRows.delete(sessionId);
		let released: readonly string[] = [];
		// Where this store has seen shared history, the session's fork history is read with the transaction's start.
		const pinReads = this.sharedHistorySeen
			? forkPinReads(this.forkHost(), this.tables.sessions, sessionId)
			: undefined;
		await this.transactionCheckedAlongside(
			async (tx, checked) => {
				released = [];
				// Read beside the schema check, in one wait for the connection.
				const pins = await this.readForkPinsWithin(tx, sessionId, pinReads);
				await checked;
				await this.searchIndex?.forgetWithin(tx, sessionId);
				if (pins !== undefined) {
					const pinned = await deleteForkedSessionWithin(
						this.forkHost(),
						tx,
						sessionId,
						new Date().toISOString(),
						pins,
					);
					released = pinned.released;
					// Rows forks still read stay under a tombstone until the last of them no longer needs them.
					if (pinned.keepRows) {
						await tx.run(`DELETE FROM ${this.tables.sessions} WHERE id = ?`, sessionId);
						return;
					}
				}
				await tx.run(`DELETE FROM ${this.tables.blobChunks} WHERE session_id = ?`, sessionId);
				await tx.run(`DELETE FROM ${this.tables.blobs} WHERE session_id = ?`, sessionId);
				await tx.run(`DELETE FROM ${this.tables.searchTexts} WHERE session_id = ?`, sessionId);
				await tx.run(`DELETE FROM ${this.tables.entryChunks} WHERE session_id = ?`, sessionId);
				await tx.run(`DELETE FROM ${this.tables.entries} WHERE session_id = ?`, sessionId);
				await tx.run(`DELETE FROM ${this.tables.sessions} WHERE id = ?`, sessionId);
			},
			pinReads === undefined ? SESSION_TRANSACTION : { ...SESSION_TRANSACTION, leading: pinReads },
		);
		await this.sweepReleasedForkRows(released);
	}

	/**
	 * The fork history of `sessionId` where the transaction `tx` runs on shared history: through `reads`, the transaction's
	 * leading reads, or, for a store that had not seen shared history when the transaction began, read now.
	 */
	private async readForkPinsWithin(
		tx: SqliteExecutor,
		sessionId: string,
		reads: ReturnType<typeof forkPinReads> | undefined,
	) {
		if (reads !== undefined) return readForkPins(tx, reads);
		if (!(await this.sharedHistoryForks(tx))) return undefined;
		return readForkPins(tx, forkPinReads(this.forkHost(), this.tables.sessions, sessionId));
	}

	/**
	 * Removes the rows of deleted sessions no fork reads any more, among `released` and any an earlier sweep left, in
	 * transactions of their own after the write that released them committed. A sweep that fails leaves tombstones the
	 * next one finishes: the write it follows stands either way.
	 */
	private async sweepReleasedForkRows(released: readonly string[]): Promise<void> {
		if (released.length === 0) return;
		const { sweepForkTombstones } = await import("./fork-sweep.js");
		try {
			await sweepForkTombstones(this.forkHost(), released);
		} catch {
			/* Its tombstones stay for the next sweep. */
		}
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
		// Read with the sessions schema version, so a store a later build upgraded is refused before anything is written.
		const found = await this.database.get<
			SqliteRow & { schema_version: number | null; bytes: number | null; chunks: number | null }
		>(
			`SELECT (SELECT max(schema_version) FROM ${this.tables.meta}) AS schema_version, b.bytes, b.chunks
			FROM (SELECT 1 AS one) AS probe LEFT JOIN ${this.tables.blobs} b ON b.session_id = ? AND b.hash = ?`,
			sessionId,
			blob.hash,
		);
		assertStorageSchemaVersion(
			"sessions",
			found?.schema_version ?? null,
			SESSION_SCHEMA_VERSION,
			SESSION_SCHEMA_VERSION_UNCHUNKED,
		);
		const previous =
			found?.bytes === null || found?.bytes === undefined
				? undefined
				: { bytes: Number(found.bytes), chunks: Number(found.chunks) };
		if (previous) {
			// Legacy bytes are converted only when written again, never on an opener's or reader's critical path.
			// Each batch releases the writer queue; a crash loses at most one batch and readers keep the old bytes.
			if (previous.chunks === -1) {
				while (
					await this.database.transaction(
						(tx) => migrateLegacyBlobBatch(tx, this.tables, sessionId, blob.hash, stored),
						this.sessionWrite(sessionId),
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
		// A fork that shares its parent's history reads the blobs it inherits where its sources store them (#6560). A blob
		// is the same bytes wherever it is stored, so one found elsewhere when the first place lost it is read again there.
		for (let attempt = 0; ; attempt++) {
			const header = await this.blobOwner(sessionId, hash);
			if (header === undefined) return undefined;
			const { owner } = header;
			if (header.chunks === -1) {
				const row = await this.database.get<SqliteRow & { data: Uint8Array }>(
					`SELECT data FROM ${this.tables.blobs} WHERE session_id = ? AND hash = ? AND chunks = -1`,
					owner,
					hash,
				);
				if (row) {
					if (row.data.byteLength === header.bytes) return row.data;
					throw new SessionBlobError("blob-incomplete", { sessionId, hash, bytes: header.bytes });
				}
				// A writer may have published the chunked layout between the header and data reads.
				if (attempt < 2) continue;
				return undefined;
			}
			const data = new Uint8Array(header.bytes);
			let offset = 0;
			for (let index = 0; index < header.chunks; index++) {
				const row = await this.database.get<SqliteRow & { data: Uint8Array | null }>(
					`SELECT data FROM ${this.tables.blobChunks} WHERE idx = ? AND session_id = ? AND hash = ?`,
					index,
					owner,
					hash,
				);
				if (row?.data == null || offset + row.data.byteLength > data.byteLength) break;
				data.set(row.data, offset);
				offset += row.data.byteLength;
			}
			if (offset === data.byteLength) return data;
			const again = await this.blobOwner(sessionId, hash);
			if (again === undefined) return undefined;
			if (again.owner !== owner && attempt < 2) continue;
			throw new SessionBlobError("blob-incomplete", { sessionId, hash, bytes: header.bytes });
		}
	}

	/**
	 * Where session `sessionId`'s blob `hash` is stored, with its header: its own, or the first of its fork sources' by
	 * id, through the segments of a fork that shares its parent's history (#6560). Read outside a transaction.
	 */
	private async blobOwner(
		sessionId: string,
		hash: string,
	): Promise<{ readonly owner: string; readonly bytes: number; readonly chunks: number } | undefined> {
		const row = await this.outsideTransaction(
			(tables) =>
				this.database.get<SqliteRow & { owner: string; bytes: number; chunks: number }>(
					tables.segments === undefined
						? `SELECT session_id AS owner, bytes, chunks FROM ${this.tables.blobs} WHERE session_id = ? AND hash = ?${tables.guard === undefined ? "" : ` AND ${tables.guard}`}`
						: `SELECT b.session_id AS owner, b.bytes, b.chunks
							FROM ${this.blobPlaces(tables)} w JOIN ${this.tables.blobs} b ON b.session_id = w.owner AND b.hash = ?
							${tables.guard === undefined ? "" : `WHERE ${tables.guard}`}
							ORDER BY w.place, b.session_id LIMIT 1`,
					...(tables.segments === undefined
						? [sessionId, hash]
						: [...this.blobPlaceParams(tables, sessionId), hash]),
				),
			(found) => found !== undefined,
		);
		return row === undefined
			? undefined
			: { owner: String(row.owner), bytes: Number(row.bytes), chunks: Number(row.chunks) };
	}

	/**
	 * The sessions whose blobs a session reads (#6560), as a derived table of `owner` and `place`: the session itself,
	 * place 0, and, with shared history, the sources its segments name, place 1. A blob is then looked up by its key in
	 * each, never by a scan of the blobs of every session. Its parameters are {@link blobPlaceParams}.
	 */
	private blobPlaces(tables: ForkViewTables): string {
		const own = `SELECT CAST(? AS ${this.dialect.types.text}) AS owner, 0 AS place`;
		return tables.segments === undefined
			? `(${own})`
			: `(${own} UNION ALL SELECT source_id, 1 FROM ${tables.segments} WHERE session_id = ?)`;
	}

	private blobPlaceParams(tables: ForkViewTables, sessionId: string): SqliteValue[] {
		return tables.segments === undefined ? [sessionId] : [sessionId, sessionId];
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
		// Notes whose fingerprint is still to take go with the store: their entries are copied by a fork (#6560).
		dropStoredNotes(this);
		const reader = this.reader;
		this.reader = undefined;
		if (reader !== undefined) await (await reader.catch(() => undefined))?.close();
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
			// A fork that shares its parent's history reads the search texts it inherits through its view (#6560). Each page
			// reads the schema too: one that finds shared history newly turned on is read again through the views.
			const seen = this.sharedHistorySeen;
			// Each session's texts are looked up by its key, in both halves of its view, never by a scan of every session's.
			const texts = (session: string) =>
				forkViewOf(
					{ segments: seen ? this.forkTables.forkSegments : undefined, dialect: this.dialect },
					{ table: this.tables.searchTexts, columns: ["text_json"] },
					session,
				);
			// Combine encoded strings only at read time, preserving NUL and lone surrogates verbatim.
			const page = await this.database.all<
				SummaryRow & PageRow & { search_texts_json: string | null; schema_version: number | null }
			>(
				`WITH keyed AS MATERIALIZED (
					SELECT ${LISTING_COLUMNS}, ${order} AS ord, ${LISTING_SIZE} AS size
					FROM ${this.tables.sessions} AS s WHERE (${where}) AND ${order} > ? ORDER BY ord LIMIT ?
				), sized AS MATERIALIZED (
					SELECT ${LISTING_COLUMNS}, ord, size,
						(SELECT COALESCE(sum(length(text_json) + 1) + 1, 2) FROM ${texts("keyed.id")} AS t) AS search_size
					FROM keyed
				) SELECT ${LISTING_COLUMNS}, ord, fetched, batch_chars, page_chars, CASE WHEN search_size <= ? THEN (
					SELECT COALESCE('[' || ${this.dialect.orderedConcat("text_json", "','", "seq")} || ']', '[]')
					FROM (SELECT text_json, seq FROM ${texts("page.id")} AS t ORDER BY seq) AS ordered
				) END AS search_texts_json, (SELECT max(schema_version) FROM ${this.tables.meta}) AS schema_version
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
				assertStorageSchemaVersion(
					"sessions",
					row.schema_version,
					SESSION_SCHEMA_VERSION,
					SESSION_SCHEMA_VERSION_UNCHUNKED,
				);
				this.noteSchemaVersion(row.schema_version);
			}
			if (this.sharedHistorySeen !== seen) continue;
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

	/**
	 * A session's search texts as one JSON array, read in pages of at most {@link SESSION_READ_PAGE_CHARS}, through its
	 * view (#6560). Only a session with some text is read this way, so a read that finds none was held back.
	 */
	private async readSearchTexts(sessionId: string): Promise<string> {
		const textsView = (tables: ForkViewTables, after: number, through: number) => {
			const view = forkView(tables, {
				name: "texts_view",
				table: this.tables.searchTexts,
				columns: ["text_json"],
				sessionId,
				after,
				through,
			});
			return view;
		};
		const sizes = await this.outsideTransaction(
			(tables) => {
				const view = textsView(tables, 0, FORK_VIEW_END);
				return this.database.all<SizedRow & { seq: number }>(
					withForkViews([view], "SELECT seq, length(text_json) AS size FROM texts_view ORDER BY seq"),
					...view.params,
				);
			},
			(found) => found.length > 0,
		);
		const texts: string[] = [];
		for (const page of pagesOf(sizes)) {
			const rows = await this.outsideTransaction(
				(tables) => {
					const view = textsView(tables, Number(page[0]!.seq) - 1, Number(page.at(-1)!.seq));
					return this.database.all<SqliteRow & { text_json: string }>(
						withForkViews([view], "SELECT text_json FROM texts_view ORDER BY seq"),
						...view.params,
					);
				},
				(found) => found.length > 0,
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
		// The entries' first page is asked for beside the session's row: a pipelined connection sends both at once.
		const generation = this.generation(sessionId);
		const shared = await this.viewTables(tx);
		const head = tx.get<HeaderRow & { chat_epoch: string | null; epoch: string; forked?: number }>(
			`SELECT header_json, last_seq,CASE WHEN ${this.dialect.jsonValid("summary_state")} THEN ${this.dialect.jsonText("summary_state", "epoch")} END AS chat_epoch,revision,${generation.sql} AS epoch${this.forkedColumn(shared.segments)} FROM ${this.tables.sessions} WHERE id = ?`,
			...generation.params,
			sessionId,
		);
		// The rows go out before the row's answer, read directly when this store last found the session without
		// segments; the row then says whether that still holds in this snapshot, and a guess it disproves reads again.
		const guess: ForkViewTables =
			this.forkedSessions.get(sessionId) === false ? { ...shared, segments: undefined } : shared;
		// Each entry is noted in the generation the same snapshot reads, for a fork to share its row (#6560).
		const epoch = head.then((found) => found?.epoch);
		let [row, rows] = await Promise.all([head, this.readRows(tx, sessionId, undefined, undefined, epoch, guess)]);
		if (!row) throw new SessionNotFoundError(sessionId);
		this.noteForked(tx, sessionId, row.forked);
		if (guess.segments === undefined && shared.segments !== undefined && Number(row.forked) === 1)
			rows = await this.readRows(tx, sessionId, undefined, undefined, epoch, shared);
		const snapshot = {
			header: JSON.parse(row.header_json) as SessionRecordHeader,
			entries: rows.map(({ entry }) => entry),
			lastSeq: row.last_seq,
		};
		if (typeof row.chat_epoch === "string") bindChatEpoch(snapshot.header, row.chat_epoch);
		// The revision comes from the same transaction. An intervening write conservatively starts a new view.
		return noteSnapshotGeneration(this, snapshot, nativeLoad, row, "revision");
	}

	/**
	 * The entries of session `sessionId` from `from` through `through`, in pages, through its view (#6560): only those
	 * whose seq `seqs` lists, when it is given, which then lies in that range. With `epoch`, the session's generation in
	 * the snapshot of `tx`, each entry is noted as stored at its seq in it, for a fork of the session to share its row.
	 */
	private async readRows(
		tx: SqliteExecutor,
		sessionId: string,
		range: { readonly from?: number; readonly through?: number } = {},
		seqs?: readonly number[],
		epoch?: string | PromiseLike<string | undefined>,
		viewTables?: ForkViewTables,
	): Promise<SessionStoredEntry[]> {
		const tables = viewTables ?? (await this.viewTables(tx, sessionId));
		const through = range.through ?? FORK_VIEW_END;
		const filter = seqs === undefined ? "" : ` AND seq IN (${seqs.map(() => "?").join(", ")})`;
		const entries: SessionStoredEntry[] = [];
		for (let after = Math.max(0, (range.from ?? 1) - 1), limit: number = SESSION_READ_FETCH.first; ; ) {
			// A view's seqs are dense, so the next batch of a shared history is its next `limit + 1` seqs: each source's
			// index then reads only those rows, rather than every row after the batch's first.
			const view = this.entriesView(
				tables,
				sessionId,
				after,
				tables.segments === undefined || seqs !== undefined ? through : Math.min(through, after + limit + 1),
			);
			const rows = await tx.all<SqliteRow & FetchRow & { seq: number; entry_json: string; chunks: number }>(
				withForkViews(
					[view],
					`WITH sized AS MATERIALIZED (
					SELECT seq, chunks, src_id, src_seq, length(entry_json) AS size,
						CASE WHEN ${this.dialect.textByteLength("entry_json")} <= ? THEN entry_json END AS inline_json
					FROM ${view.name} WHERE seq > ?${filter} ORDER BY seq LIMIT ?
				), batch AS MATERIALIZED (
					SELECT count(*) AS fetched, COALESCE(sum(size), 0) AS chars FROM sized
				), page AS (
					SELECT seq, chunks, src_id, src_seq, inline_json, fetched, chars AS batch_chars, 0 AS page_chars
					FROM (SELECT seq, chunks, src_id, src_seq, inline_json FROM sized ORDER BY seq LIMIT ?) AS fitting CROSS JOIN batch
					WHERE batch.chars <= ?
					UNION ALL
					SELECT seq, chunks, src_id, src_seq, inline_json, fetched, batch_chars, page_chars FROM (
						SELECT seq, chunks, src_id, src_seq, inline_json, batch.fetched, batch.chars AS batch_chars,
							row_number() OVER (ORDER BY seq) AS page_row,
							sum(size) OVER (ORDER BY seq) AS page_chars
						FROM sized CROSS JOIN batch WHERE batch.chars > ?
					) AS windowed WHERE (page_chars <= ? OR page_row = 1) AND page_row <= ?
				) SELECT seq, COALESCE(inline_json, (
					SELECT e.entry_json FROM ${this.tables.entries} AS e WHERE e.session_id = page.src_id AND e.seq = page.src_seq
				)) AS entry_json, chunks, fetched, batch_chars, page_chars FROM page ORDER BY seq`,
				),
				...forkViewParams([view]),
				SESSION_READ_INLINE_BYTES,
				after,
				...(seqs ?? []),
				limit + 1,
				limit,
				SESSION_READ_PAGE_CHARS,
				SESSION_READ_PAGE_CHARS,
				SESSION_READ_PAGE_CHARS,
				limit,
			);
			const generation = await epoch;
			// Each entry is noted where it is stored, for a fork to share its row (#6560), only where that can happen.
			const note =
				generation === undefined || !this.sharedHistorySeen
					? undefined
					: storedEntryNotes(this, sessionId, generation);
			for (const entry of rows) {
				const chunks = Number(entry.chunks);
				const seq = Number(entry.seq);
				const json =
					chunks === 0 ? entry.entry_json : await this.readEntryChunks(tx, tables, sessionId, seq, chunks);
				const parsed = JSON.parse(json) as SessionEntry;
				note?.(parsed, seq, json);
				entries.push({ seq, entry: parsed });
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
		epoch?: string,
	): Promise<SessionStoredEntry[]> {
		const entries: SessionStoredEntry[] = [];
		for (let start = 0; start < seqs.length; start += SEQ_BATCH) {
			const batch = seqs.slice(start, start + SEQ_BATCH);
			const range = { from: Math.min(...batch), through: Math.max(...batch) };
			entries.push(...(await this.readRows(tx, sessionId, range, batch, epoch)));
		}
		return entries;
	}

	/**
	 * The read of the session's row that `resumeSource` makes first: a read transaction that starts with it names it as
	 * a leading read, so a pipelined connection sends it with the transaction's start (#6560).
	 */
	private resumeRow(sessionId: string): SqliteStatement {
		// Whether the session has fork segments, where this store has seen shared history (#6560): a leading read goes
		// out before the transaction's schema check answers.
		const forked = this.forkedColumn(this.sharedHistorySeen ? this.forkTables.forkSegments : undefined);
		return {
			sql: `SELECT header_json,last_seq,summary_state,revision${forked} FROM ${this.tables.sessions} WHERE id = ?`,
			params: [sessionId],
		};
	}

	/**
	 * The view (#6560), as `name`, of session `sessionId`'s entries after seq `after` and through seq `through`, with
	 * `entry_id`, `entry_json` and `chunks`, and where each is stored.
	 */
	private entriesView(
		tables: ForkViewTables,
		sessionId: string,
		after = 0,
		through: number = FORK_VIEW_END,
		name = "entries_view",
	): ForkView & { readonly name: string } {
		return {
			...forkView(tables, {
				name,
				table: this.tables.entries,
				columns: ["entry_id", "entry_json", "chunks"],
				sessionId,
				after,
				through,
			}),
			name,
		};
	}

	private async resumeSource(
		tx: SqliteExecutor,
		sessionId: string,
	): Promise<ResumeSource & { readonly row: ResumeRow }> {
		const read = this.resumeRow(sessionId);
		const row = await tx.get<ResumeRow & { forked?: number }>(read.sql, ...read.params);
		if (!row) throw new SessionNotFoundError(sessionId);
		this.noteForked(tx, sessionId, row.forked);
		const stored = windowIndex(JSON.parse(row.summary_state) as StoredSummaryState, Number(row.last_seq));
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

	/**
	 * Runs `read`, a read transaction that finds the session's index with `resumeSource`, at once; only when that index is
	 * missing or stale (`resumeSource` rejects with `SessionConflictError`) does it compute the index with
	 * `prepareResume` and run `read` again. A current index, the usual case, then costs no read before the transaction:
	 * on a server, one round trip fewer (#6560).
	 */
	private async withResumeIndex<T>(sessionId: string, read: () => Promise<T>): Promise<T> {
		try {
			return await read();
		} catch (error) {
			if (!(error instanceof SessionConflictError)) throw error;
		}
		await this.prepareResume(sessionId);
		return read();
	}

	private async prepareResume(
		sessionId: string,
		leafId?: string,
		throughSeq?: number,
	): Promise<{ index: SessionResumeIndex; revision: string }> {
		attempts: for (let attempt = 0; attempt < 3; attempt++) {
			const row = await this.database.get<ResumeRow & { forked?: number }>(
				`SELECT header_json,last_seq,summary_state,revision${this.outsideForkedColumn("id")} FROM ${this.tables.sessions} WHERE id = ?`,
				sessionId,
			);
			if (!row) throw new SessionNotFoundError(sessionId);
			this.noteForked(undefined, sessionId, row.forked);
			const state = JSON.parse(row.summary_state) as StoredSummaryState;
			const remembered = this.resumeIndexes.get(sessionId);
			const currentIndex =
				windowIndex(state, Number(row.last_seq)) ??
				(remembered?.revision === row.revision && isSessionResumeIndex(remembered.index, Number(row.last_seq))
					? remembered.index
					: undefined);
			const limit = throughSeq ?? Number(row.last_seq);
			if (limit > Number(row.last_seq)) throw new SessionConflictError(sessionId, limit, Number(row.last_seq));
			const selected =
				leafId === undefined
					? undefined
					: ((await this.seqOfEntry(this.database, undefined, sessionId, leafId)) ?? 0);
			const requested = selected !== undefined && selected > limit ? 0 : selected;
			if (
				currentIndex &&
				limit === currentIndex.seq &&
				(requested === undefined || requested === currentIndex.leafSeq)
			)
				return { index: currentIndex, revision: row.revision };
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
				"root",
				"snapshotId",
				"degradedFrom",
				"captureMs",
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
				"terminalStatus",
			];
			const op = `CASE WHEN ${jsonType("data", "op")} = '${sqlite ? "text" : "string"}' THEN ${j("data", "op")} END`;
			const deliveryOp = `chunks > 0 AND ${j("type")} = 'custom' AND ${j("customType")} = 'atomic-pooled-delivery-op'`;
			const dataExpr = this.dialect.jsonObject([
				...dataKeys.map(
					(key) =>
						[
							key,
							["version", "index", "timestamp"].includes(key)
								? `CASE WHEN ${jsonType("data", key)} IN ('integer','real','number') THEN CAST(${j("data", key)} AS ${this.dialect.types.real}) END`
								: key === "runId"
									? `CASE WHEN ${j("customType")} NOT IN ('workflow.run.start','workflow.run.end') OR ${jsonType("data", key)} = '${sqlite ? "text" : "string"}' THEN ${j("data", key)} END`
									: j("data", key),
						] as const,
				),
				// Run recovery needs the types of name and timestamp, not their values or the start's inputs.
				["name", `CASE WHEN ${jsonType("data", "name")} = '${sqlite ? "text" : "string"}' THEN '' END`],
				["ts", `CASE WHEN ${jsonType("data", "ts")} IN ('integer','real','number') THEN 0 END`],
				[
					"message",
					this.dialect.jsonObject(
						["id", "replyTo", "expectsReply"].map((key) => [key, j("data", "message", key)] as const),
					),
				],
				["op", op],
				// Atomic's own owner object and lists, read only as the JSON types Atomic writes them in: any other value
				// under these names, an extension's text that looks like JSON included, reads as an empty string and is
				// never parsed, as a JSONL store keeps it, a value the fold takes for none of them.
				...(
					[
						["owner", "object"],
						["tasks", "array"],
						["groups", "array"],
					] as const
				).map(
					([key, type]) =>
						[
							key,
							`CASE WHEN ${jsonType("data", key)} = '${type}' THEN ${j("data", key)} WHEN ${jsonType("data", key)} IS NULL OR ${jsonType("data", key)} = 'null' THEN NULL ELSE '' END`,
						] as const,
				),
				// Intercom's records of several asks at once: closed asks, and answered asks. They are parsed back from
				// JSON text, which an extension's own text under the same name can look like: read them only as lists.
				...["messageIds", "askIds"].map(
					(key) => [key, `CASE WHEN ${jsonType("data", key)} = 'array' THEN ${j("data", key)} END`] as const,
				),
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
			// Walk only the content array. SQLite 3.45+ can pass it without rendering large blocks back to text.
			const binaryContent =
				sqlite &&
				Number(row.last_seq) > 0 &&
				this.database.supportsJsonbExtract &&
				(await this.database.supportsJsonbExtract());
			const toolBlocks = sqlite
				? this.dialect.jsonValues(
						binaryContent ? "jsonb_extract(entry_json, '$.message.content')" : j("message", "content"),
					)
				: "jsonb_array_elements_text(parsed.value #> '{message,content}') AS blocks(value)";
			// A chunked legacy message may contain plain text where newer assistants store a block. Without
			// an opening brace it cannot encode a tool-call object. Keep inline input on the original SQL path
			// (including its JSON errors), and let each engine parse any potential object in its native syntax.
			const blockType = this.dialect.jsonText("value", "type");
			const toolType = `CASE WHEN chunks > 0 AND ${sqlite ? "type = 'text' AND instr(value, '{')" : "strpos(value, '{')"} = 0 THEN NULL ELSE ${blockType} END`;
			const columns = [
				[
					"dataFields",
					`CASE WHEN ${deliveryOp} THEN '["op"]' WHEN ${j("type")} = 'custom' THEN ${dataFieldNames} ELSE '[]' END`,
				],
				...projected,
				[
					"message",
					this.dialect.jsonObject([
						...messageKeys.map((key) => [key, j("message", key)] as const),
						...["toolsAdded", "toolsRemoved"].map(
							(key) => [key, `CASE WHEN ${jsonType("message", key)}='array' THEN 1 END`] as const,
						),
					]),
				],
				// The chunked delivery protocol uses only its operation ID. Other extension values are opaque,
				// not encoded membership lists, task records, or owners to send and parse on the client.
				["data", `CASE WHEN ${deliveryOp} THEN ${this.dialect.jsonObject([["op", op]])} ELSE ${dataExpr} END`],
				["details", detailsExpr],
				["usage", j("usage")],
				["protectedReconciliation", j("protectedReconciliation")],
				["snapshot", `CASE WHEN ${jsonType("snapshot")} = 'object' THEN '{}' ELSE NULL END`],
				["restore", `CASE WHEN ${jsonType("restore")} = 'object' THEN 1 END`],
				["unrestored", `CASE WHEN ${jsonType("unrestored")} = 'object' THEN 1 END`],
				["compactionDetails", j("details", "strategy")],
				[
					"toolCalls",
					`CASE WHEN ${j("message", "role")} = 'assistant' AND ${jsonType("message", "content")} = 'array' THEN
						(SELECT count(*) FROM ${toolBlocks}
						WHERE ${toolType} = 'toolCall') ELSE 0 END`,
				],
			];
			const select = columns
				.map(([key, expr]) => `${expr} AS ${this.dialect.identifier(`resume_${key.toLowerCase()}`)}`)
				.join(", ");
			// The first resume after an upgrade converts the 0.9 releases' index from the entries outside the
			// conversation and the extension state (and every chunked row, whose stored row names no custom type)
			// instead of folding them all.
			const upgrade =
				requested === undefined &&
				limit === Number(row.last_seq) &&
				isUpgradableSessionResumeIndex(state.resume, limit)
					? sessionResumeUpgrade(state.resume)
					: undefined;
			const list = (values: readonly string[]) =>
				values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
			const source = `chunks > 0 OR ${j("type")} IN (${list(RESUME_UPGRADE_SOURCES.types)})
				OR (${j("type")} = 'message' AND ${j("message", "role")} = 'system')
				OR (${j("type")} = 'custom' AND (${j("customType")} IN (${list(RESUME_UPGRADE_SOURCES.customTypes)})
					OR ${j("customType")} NOT IN (${list(RESUME_UPGRADE_SOURCES.atomicCustomTypes)})))`;
			const sources = !upgrade
				? ""
				: sqlite
					? ` AND (${source})`
					: ` AND EXISTS (SELECT 1 FROM (SELECT ${postgresJsonb("entry_json")} AS value OFFSET 0) AS parsed WHERE ${source})`;
			const where = `WHERE session_id = ? AND seq > ? AND seq <= ?${sources}`;
			// Bind a wide SQLite owner once without copying it into every page row. Some positional adapters
			// treat numbered SQLite parameters as named bindings rather than positional ones.
			const owner = "(SELECT id FROM bounds)";
			const lo = "(SELECT lo FROM bounds)";
			const hi = "(SELECT hi FROM bounds)";
			const pageWhere = sqlite ? `WHERE session_id = ${owner} AND seq > ${lo} AND seq <= ${hi}${sources}` : where;
			// Each page reads the session's view (#6560). A row it inherits is stored under another session, so its chunks
			// are found where the view says the row is, `src_id` and `src_seq`, rather than under the bound owner.
			// A session the row found without segments reads its tables directly (#6560). One that has them since, as a
			// session deleted and made again as a fork does, has a new revision, which the rebuild checks at its end.
			const viewed = this.outsideViewTables();
			const tables = Number(row.forked) === 0 ? { ...viewed, segments: undefined } : viewed;
			const shared = tables.segments !== undefined;
			const page = `WITH ${sqlite ? "bounds(id,lo,hi) AS NOT MATERIALIZED (VALUES (?,?,?)), " : ""}page AS (
				SELECT ${sqlite && !shared ? "" : "CASE WHEN chunks > 0 THEN src_id END AS src_id,"}seq,src_seq,entry_id,chunks,entry_json FROM entries_view
				${pageWhere} ORDER BY seq LIMIT ${SESSION_RESUME_REBUILD.pageEntries}
			)`;
			const parts = (
				source: string,
			) => `FROM ${this.tables.entryChunks} WHERE session_id = ${sqlite && !shared ? owner : `${source}.src_id`}
				AND seq = ${source}.src_seq AND idx >= 0 AND idx < ${source}.chunks`;
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
			// A positive first_rid means the checked rowids advance exactly with idx. Zero identifies
			// scattered chunks; a negative value falls back to the direct join outside the bounded window.
			const keysPerEntry = 64;
			const through = `${lo} + ${SESSION_RESUME_REBUILD.pageEntries}`;
			const wide = sqlite && !shared && Number(row.last_seq) > 0 && Buffer.byteLength(sessionId) >= 512;
			// For an unknown wide-key layout, return the actual inline page or a single marker at seq 0
			// (entry seqs start at 1). Even preparing a schema pragma can require access to that pragma.
			let inlinePage =
				wide && this.chunkRowids === undefined
					? `${page}, chunked AS MATERIALIZED (SELECT 1 FROM page WHERE chunks > 0 LIMIT 1),
				payloads AS MATERIALIZED (SELECT seq,entry_id,chunks,entry_json FROM page WHERE NOT EXISTS (SELECT 1 FROM chunked)
					UNION ALL SELECT 0,'',0,'{}' FROM chunked) ${projection}`
					: undefined;
			const rowidPage =
				wide && this.chunkRowids !== false
					? `${page},
				keys AS MATERIALIZED (SELECT seq,idx,rowid AS rid FROM ${this.tables.entryChunks}
					WHERE session_id = ${owner} AND seq > ${lo} AND seq <= ${hi} AND seq <= ${through} AND idx >= 0 AND idx < ${keysPerEntry}
					ORDER BY seq,idx),
				sized AS NOT MATERIALIZED (SELECT page.*, CASE WHEN chunks = 0 THEN NULL
					WHEN seq <= ${through} AND chunks <= ${keysPerEntry} THEN (
						SELECT CASE WHEN count(*) = page.chunks AND length(zeroblob(sum(length(c.data)))) IS NOT NULL
							THEN CASE WHEN min(k.rid) > 0 AND min(k.rid - k.idx) = max(k.rid - k.idx) THEN min(k.rid) ELSE 0 END END
						FROM keys k CROSS JOIN ${this.tables.entryChunks} c WHERE k.seq = page.seq AND k.idx < page.chunks AND c.rowid = k.rid)
					WHEN EXISTS (SELECT 1 ${parts("page")} GROUP BY seq HAVING count(*) = page.chunks AND ${fits}) THEN -1 END AS first_rid
					FROM page LIMIT -1 OFFSET 0),
				payloads AS MATERIALIZED (SELECT seq,entry_id,CASE WHEN chunks > 0 AND first_rid IS NULL THEN -chunks ELSE chunks END AS chunks,
					CASE WHEN first_rid IS NULL THEN entry_json WHEN first_rid < 0 THEN ${joined}
					WHEN first_rid > 0 THEN (SELECT group_concat(text, '') FROM (SELECT CAST(data AS TEXT) AS text FROM ${this.tables.entryChunks}
						WHERE rowid BETWEEN sized.first_rid AND sized.first_rid + (sized.chunks - 1) ORDER BY rowid))
					ELSE (SELECT group_concat(CAST((SELECT data FROM ${this.tables.entryChunks} WHERE rowid = ids.rid) AS TEXT), '')
						FROM (SELECT rid FROM keys k WHERE k.seq = sized.seq AND k.idx < sized.chunks ORDER BY k.idx LIMIT -1 OFFSET 0) ids)
					END AS entry_json FROM sized)
				${projection}`
					: directPage;
			const stubPage = `${page}, payloads AS (SELECT seq,entry_id,-chunks AS chunks,entry_json FROM page) ${projection}`;
			// Reuse topology, never branch-local recovery state, for a historical cut.
			let topology = currentIndex && requested !== undefined ? branchRanges(currentIndex, requested) : undefined;
			for (let pass = topology === undefined ? 0 : 1; pass < 2; pass++) {
				for (let after = 0; after < limit; ) {
					type ProjectedRow = SqliteRow & { seq: number; entry_id: string; chunks: number };
					// A view's seqs are dense, so a page of the view is its next seqs: each source reads only those.
					const view = this.entriesView(
						tables,
						sessionId,
						after,
						Math.min(limit, after + SESSION_RESUME_REBUILD.pageEntries),
					);
					const args = [...view.params, sessionId, after, limit] as const;
					let rows: ProjectedRow[];
					try {
						rows = await this.database.all<ProjectedRow>(
							withForkViews([view], inlinePage ?? (this.chunkRowids ? rowidPage : directPage)),
							...args,
						);
						if (inlinePage && Number(rows[0]?.seq) === 0) {
							inlinePage = undefined;
							// index_xinfo(table) detects WITHOUT ROWID; a declared rowid isn't a physical location either.
							try {
								this.chunkRowids =
									(await this.database.get(
										`SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pragma_index_xinfo(?))
									AND NOT EXISTS (SELECT 1 FROM pragma_table_xinfo(?) WHERE name = 'rowid' COLLATE NOCASE)`,
										this.tables.entryChunks,
										this.tables.entryChunks,
									)) !== undefined;
							} catch {
								// Use the direct plan for this rebuild without caching an unreadable layout.
							}
							continue;
						}
					} catch (error) {
						if (!(error instanceof Error && "code" in error && error.code === "payload-too-large")) throw error;
						// Only a size refusal, before any rows were delivered, can benefit from retrying with stubs.
						// Probe the page's keys without reading chunk bodies. An entirely inline page is already final.
						const chunked = await this.database
							.get(
								withForkViews(
									[view],
									`SELECT 1 FROM (SELECT src_id, src_seq FROM ${view.name} ${where}
							ORDER BY seq LIMIT ${SESSION_RESUME_REBUILD.pageEntries}) AS p
							JOIN ${this.tables.entryChunks} c ON c.session_id = p.src_id AND c.seq = p.src_seq LIMIT 1`,
								),
								...view.params,
								sessionId,
								after,
								limit,
							)
							.catch(() => undefined);
						if (!chunked) throw error;
						rows = await this.database.all<ProjectedRow>(withForkViews([view], stubPage), ...args);
					}
					if (rows.length === 0) {
						// A page in the range always has rows: none means the read's own check held them back.
						if (await this.schemaNowShared(viewed.segments !== undefined)) continue attempts;
						break;
					}
					const batch: SessionEntry[] = [];
					let toolCalls = 0;
					for (const entry of rows) {
						// Zero is inline, positive is a native join, negative still needs the bounded reader.
						const chunks = Number(entry.chunks);
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
								for (const field of ["groups", "queries", "urls", "messageIds", "askIds"])
									if (field in data) data[field] = decode(data[field] as SqliteValue);
								if (
									data.timestamp !== null &&
									data.timestamp !== undefined &&
									typeof data.timestamp === "string"
								)
									data.timestamp = Number(data.timestamp);
								if (parsed.type === "custom" && parsed.customType === "subagent-child") {
									if (data.version !== null && data.version !== undefined) data.version = Number(data.version);
									if (data.index !== null && data.index !== undefined) data.index = Number(data.index);
								}
								const message = data.message as Record<string, unknown>;
								if (message?.expectsReply === 1 || message?.expectsReply === "true")
									message.expectsReply = true;
								if (data.historyOnly === 1 || data.historyOnly === "true") data.historyOnly = true;
							}
						}
						if (upgrade) upgrade.add(parsed as unknown as SessionEntry, Number(entry.seq));
						else batch.push(parsed as unknown as SessionEntry);
					}
					if (upgrade) {
						after = Number(rows.at(-1)!.seq);
						if (after < limit) await yieldTurn();
						continue;
					}
					const old = index ?? foldSessionResume(undefined, []);
					const seqs = new Map<string, number>();
					for (const id of foreignResumeIds(old, batch)) {
						const seq = await this.seqOfEntry(this.database, undefined, sessionId, id);
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
					if (after < Number(row.last_seq)) await yieldTurn();
				}
				if (
					pass !== 0 ||
					!index ||
					(index.jumps.length === 0 && (requested === undefined || requested === index.leafSeq))
				)
					break;
				topology = branchRanges(index, requested ?? index.leafSeq);
				index = undefined;
			}
			if (upgrade) index = upgrade.finish();
			index = { ...(index ?? foldSessionResume(undefined, [])), epoch: state.epoch ?? row.revision };
			const current = await this.database.get<ResumeRow>(
				`SELECT revision,last_seq FROM ${this.tables.sessions} WHERE id = ?`,
				sessionId,
			);
			if (current?.revision !== row.revision || Number(current.last_seq) !== Number(row.last_seq)) continue;
			// A historical read never replaces the index or checkpoint of the session's current leaf.
			if (requested !== undefined) return { index: { ...index, leafSeq: requested }, revision: row.revision };
			this.resumeIndexes.set(sessionId, { revision: row.revision, index });
			while (this.resumeIndexes.size > 16) this.resumeIndexes.delete(this.resumeIndexes.keys().next().value!);
			await this.database
				.run(
					`UPDATE ${this.tables.sessions} SET summary_state = ? WHERE id = ? AND revision = ? AND last_seq = ?`,
					JSON.stringify({ ...state, ...windowFields(state, index, index.seq, index.epoch), epoch: index.epoch }),
					sessionId,
					row.revision,
					row.last_seq,
				)
				.catch(() => undefined);
			// The summary state changed without a new revision: its generation is read from it again.
			this.generations.delete(sessionId);
			return { index, revision: row.revision };
		}
		throw new SessionConflictError(sessionId, 0, 0);
	}

	async readTail(sessionId: string, fromSeq: number): Promise<SessionTail> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const start = Math.max(1, fromSeq);
		const { tail } = await this.withResumeIndex(sessionId, () =>
			this.readTransaction(
				async (tx) => {
					const source = await this.resumeSource(tx, sessionId);
					const stateSeqs = stateSeqsBefore(source.index, start);
					if (hasHistoryLoadObserver())
						announceHistoryLoad(stateSeqs.length + Math.max(0, source.index.seq - start + 1));
					// Neither depends on the other: a pipelined connection sends both at once (#6560).
					const [state, rows] = await Promise.all([
						this.readSeqs(tx, sessionId, stateSeqs),
						this.readRows(tx, sessionId, { from: start }),
					]);
					const entries = rows.map(({ entry }) => entry);
					return { tail: sessionTailFrom(source.index, source.header, start, state, entries), source };
				},
				[this.resumeRow(sessionId)],
			),
		);

		return tail;
	}

	async readRange(
		sessionId: string,
		startSeq: number,
		endSeq: number,
		expectedEpoch?: string,
	): Promise<SessionEntryRange> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const start = Math.max(1, startSeq);
		return this.readTransaction(async (tx) => {
			const head = await this.historyHead(tx, sessionId, true);
			if (expectedEpoch !== undefined && expectedEpoch !== head.epoch)
				throw new SessionConflictError(sessionId, endSeq, head.lastSeq);
			const entries =
				endSeq < start
					? []
					: await this.readRows(tx, sessionId, { from: start, through: endSeq }, undefined, head.epoch);
			return {
				startSeq: start,
				entries: entries.map(({ entry }) => entry),
				seqs: entries.map(({ seq }) => seq),
				lastSeq: head.lastSeq,
				epoch: head.epoch,
			};
		});
	}

	/**
	 * The session's watermark and generation; with `segments`, the fork segments table of a database with shared
	 * history, also whether the session has segments (#6560), in the same statement: a read that leaves a session without
	 * them to its tables' own keyed lookups costs no read of its own to learn it.
	 */
	private async historyHead(
		tx: SqliteExecutor,
		sessionId: string,
		readOnly = false,
	): Promise<{ lastSeq: number; epoch: string; forked: boolean }> {
		const generation = this.generation(sessionId);
		const { segments } = await this.viewTables(tx);
		const row = await tx.get<SqliteRow & { last_seq: number; revision: string; epoch: string; forked?: number }>(
			`SELECT last_seq, revision, ${generation.sql} AS epoch${this.forkedColumn(segments)} FROM ${this.tables.sessions} WHERE id = ?${readOnly ? "" : this.dialect.lockClause("share")}`,
			...generation.params,
			sessionId,
		);
		if (!row) throw new SessionNotFoundError(sessionId);
		this.noteGeneration(sessionId, row.revision, Number(row.last_seq), row.epoch);
		this.noteForked(tx, sessionId, row.forked);
		return { lastSeq: Number(row.last_seq), epoch: row.epoch, forked: Number(row.forked) === 1 };
	}

	/** Size at most one page and return only fitting bodies, in the same snapshot as the header. The first
	 * oversized row is a chunk reference; its full inline value never crosses the driver boundary. */
	private async historyPacket(
		tx: SqliteExecutor,
		sessionId: string,
		epoch: string,
		from: number,
		through: number,
		backward: boolean,
	): Promise<SessionHistoryItem[]> {
		const edge = backward ? through : from;
		const tables = await this.viewTables(tx, sessionId);
		const view = this.entriesView(tables, sessionId, from - 1, through);
		const rows = await tx.all<SqliteRow & { seq: number; bytes: number | null; chunks: number; body: string | null }>(
			withForkViews(
				[view],
				`WITH sizes AS MATERIALIZED (
				SELECT e.seq, e.chunks, e.src_id, e.src_seq, CASE WHEN e.chunks = 0 THEN ${this.entryByteLength("e.entry_json")} ELSE (e.chunks - 1) * ? +
					(SELECT length(c.data) FROM ${this.tables.entryChunks} c WHERE c.session_id = e.src_id AND c.seq = e.src_seq AND c.idx = e.chunks - 1) END AS bytes
				FROM ${view.name} e
			), sized_page AS (
				SELECT seq, chunks, src_id, src_seq, bytes, sum(bytes) OVER (ORDER BY seq ${backward ? "DESC" : "ASC"}) AS cumulative FROM sizes
			) SELECT p.seq, p.chunks, p.bytes, CASE WHEN p.chunks = 0 AND p.bytes <= ? THEN e.entry_json END AS body
			FROM sized_page p JOIN ${this.tables.entries} e ON e.session_id = p.src_id AND e.seq = p.src_seq
			WHERE p.bytes IS NULL OR p.cumulative <= ? OR p.seq = ? ORDER BY p.seq`,
			),
			...view.params,
			SESSION_ENTRY_CHUNK_BYTES,
			SESSION_HISTORY_PAGE_BYTES,
			SESSION_HISTORY_PAGE_BYTES,
			edge,
		);
		const items: SessionHistoryItem[] = [];
		for (const row of rows) {
			const seq = Number(row.seq),
				bytes = Number(row.bytes);
			if (row.bytes === null)
				throw new StorageUnavailableError(
					this.descriptor,
					new Error(`Missing final chunk of session entry ${seq}`),
				);
			if (bytes > SESSION_HISTORY_PAGE_BYTES) items.push({ kind: "oversized", sessionId, epoch, seq, bytes });
			else
				items.push({
					seq,
					entry: JSON.parse(
						row.body ?? (await this.readEntryChunks(tx, tables, sessionId, seq, Number(row.chunks))),
					) as SessionEntry,
				});
		}
		return items;
	}

	async readChildDisplayCut(sessionId: string, launch: ChildDisplayLaunch) {
		const { childDisplayCut } = await import("./card-view.js");
		const { index } = await this.prepareResume(sessionId);
		if (typeof launch.launchLeafId !== "string") return childDisplayCut(index, launch);
		return this.readTransaction(async (tx) => {
			const head = await this.historyHead(tx, sessionId, true);
			if (head.epoch !== index.epoch || head.lastSeq < index.seq)
				throw new SessionConflictError(sessionId, index.seq, head.lastSeq);
			const view = forkView(await this.viewTables(tx, sessionId), {
				name: "launched",
				table: this.tables.entries,
				columns: ["entry_id"],
				sessionId,
				after: 0,
				through: index.seq,
				match: { column: "entry_id", value: launch.launchLeafId! },
			});
			const row = await tx.get<SqliteRow & { seq: number }>(
				withForkViews([view], "SELECT seq FROM launched ORDER BY seq DESC LIMIT 1"),
				...view.params,
			);
			return childDisplayCut(index, launch, row === undefined ? undefined : Number(row.seq));
		});
	}

	/**
	 * A column expression of a sessions row's generation, `COALESCE(epoch, resume.epoch, revision)` of its summary state,
	 * that parses that state only when the row's revision or watermark is not the one this store last saw it at: every
	 * write gives the row a new revision, so the generation it held then still stands. A long session's summary state is
	 * hundreds of kilobytes, which a server would otherwise parse for every page and chunk an export reads (#5571).
	 */
	private generation(sessionId: string): { readonly sql: string; readonly params: readonly SqliteValue[] } {
		const known = this.generations.get(sessionId);
		return {
			sql: `CASE WHEN revision = ? AND last_seq = ? THEN ? ELSE COALESCE(${this.dialect.jsonText("summary_state", "epoch")}, ${this.dialect.jsonText("summary_state", "resume", "epoch")}, revision) END`,
			params: [known?.revision ?? null, known?.lastSeq ?? null, known?.epoch ?? null],
		};
	}

	private noteGeneration(sessionId: string, revision: string, lastSeq: number, epoch: string): void {
		this.generations.delete(sessionId);
		this.generations.set(sessionId, { revision, lastSeq, epoch });
		while (this.generations.size > 16) this.generations.delete(this.generations.keys().next().value!);
	}

	async readBranchSpan(sessionId: string, cut: SessionBranchPageCut) {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const { index } = await this.prepareResume(sessionId);
		return transcriptBranchSpan(sessionId, index, cut);
	}

	/** Send only tree headings over the database connection. A chunk stub has no message role or
	 * timestamp; its caller streams those fields instead of joining or decoding the stored body. */
	async readTreeOutline(
		sessionId: string,
		fromSeq: number,
		toSeq: number,
		epoch?: string,
	): Promise<readonly (SessionTreeOutlineEntry | { seq: number; streamed: true })[]> {
		this.assertOpen();
		return this.readTransaction(async (tx) => {
			const head = await this.historyHead(tx, sessionId, true);
			if ((epoch !== undefined && head.epoch !== epoch) || head.lastSeq < toSeq)
				throw new SessionConflictError(sessionId, toSeq, head.lastSeq);
			const sqlite = this.dialect.name === "sqlite";
			const j = (...path: string[]) => this.dialect.jsonText("entry_json", ...path);
			const role = j("message", "role"),
				content = j("message", "content"),
				ctype = this.dialect.jsonType("entry_json", "message", "content");
			// String.prototype.trim's WhiteSpace + LineTerminator set (SQLite trim's default is ASCII space only).
			const whites =
				"\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
			const trim = sqlite ? "trim" : "btrim";
			const hasText = sqlite
				? `EXISTS(SELECT 1 FROM json_each(entry_json,'$.message.content') b WHERE CASE WHEN b.type='object' AND json_extract(b.value,'$.type')='text' THEN length(trim(json_extract(b.value,'$.text'),?))>0 END)`
				: `EXISTS(SELECT 1 FROM jsonb_array_elements((${content})::jsonb) b WHERE b->>'type'='text' AND length(btrim(b->>'text',?))>0)`;
			const callIds = sqlite
				? `(SELECT json_group_array(json_extract(b.value,'$.id')) FROM json_each(entry_json,'$.message.content') b WHERE CASE WHEN b.type='object' THEN json_extract(b.value,'$.type')='toolCall' AND json_type(b.value,'$.id')='text' END)`
				: `(SELECT json_agg(b->>'id')::text FROM jsonb_array_elements((${content})::jsonb) b WHERE b->>'type'='toolCall' AND jsonb_typeof(b->'id')='string')`;
			const view = this.entriesView(await this.viewTables(tx, sessionId), sessionId, fromSeq - 1, toSeq);
			const rows = await tx.all(
				withForkViews(
					[view],
					`SELECT CASE WHEN ${role}='assistant' AND ${ctype}='array' THEN ${callIds} END calls,seq,entry_id,chunks,${j("type")} kind,${j("parentId")} parent,${j("timestamp")} stamp,${role} role,
				CASE WHEN ${role}='assistant' AND COALESCE(${j("message", "stopReason")},'') IN ('','toolUse','stop') AND CASE WHEN ${ctype}='array' THEN NOT ${hasText} WHEN ${ctype}='${sqlite ? "text" : "string"}' THEN length(${trim}(${content},?))=0 ELSE TRUE END THEN 1 ELSE 0 END hidden,
				CASE WHEN ${j("type")}='custom' AND ${j("customType")}='atomic.leaf' THEN 1 ELSE 0 END leaf_move,
				CASE WHEN ${j("type")}='custom' AND ${j("customType")}='subagent-child' THEN 1 ELSE 0 END child_record,
				CASE WHEN ${j("type")}='label' THEN ${j("targetId")} END target,CASE WHEN ${j("type")}='label' THEN substr(${j("label")},1,128) END label
				FROM ${view.name} WHERE session_id=? AND seq BETWEEN ? AND ? ORDER BY seq LIMIT ?`,
				),
				...view.params,
				whites,
				whites,
				sessionId,
				fromSeq,
				toSeq,
				SESSION_HISTORY_PAGE_ENTRIES,
			);
			return rows.map((row) =>
				Number(row.chunks) > 0
					? ({ seq: Number(row.seq), streamed: true } as const)
					: {
							seq: Number(row.seq),
							id: String(row.entry_id),
							parentId: row.parent === null ? null : String(row.parent),
							timestamp: String(row.stamp),
							type: row.kind as SessionEntry["type"],
							...(typeof row.role === "string" ? { role: row.role } : {}),
							...(Number(row.hidden) === 1 ? { hideAssistant: true } : {}),
							...(typeof row.calls === "string" && row.calls !== "[]"
								? { callIds: JSON.parse(row.calls) as string[] }
								: {}),
							...(Number(row.leaf_move) === 1 ? { leafMove: true } : {}),
							...(Number(row.child_record) === 1 ? { childRecord: true } : {}),
							...(typeof row.target === "string"
								? { labelTarget: row.target, label: typeof row.label === "string" ? row.label : undefined }
								: {}),
						},
			);
		});
	}

	/** Sparse page of child state in one fenced read, bounded by the same byte and row caps as a transcript page. */
	async readSelectedPage(
		sessionId: string,
		seqs: readonly number[],
		epoch: string,
		options: { readonly limit?: number; readonly backward?: boolean } = {},
	) {
		this.assertOpen();
		const limit = entrySizeLimit(options.limit);
		const wanted = options.backward ? seqs.slice(-limit) : seqs.slice(0, limit);
		if (!wanted.length) return { items: [] };
		return this.readTransaction(async (tx) => {
			const head = await this.historyHead(tx, sessionId, true);
			if (head.epoch !== epoch || head.lastSeq < wanted.at(-1)!)
				throw new SessionConflictError(sessionId, wanted.at(-1)!, head.lastSeq);
			const tail = `(SELECT length(data) FROM ${this.tables.entryChunks} c WHERE c.session_id=e.src_id AND c.seq=e.src_seq AND c.idx=e.chunks-1)`;
			const view = this.entriesView(
				await this.viewTables(tx, sessionId),
				sessionId,
				Math.min(...wanted) - 1,
				Math.max(...wanted),
			);
			const rows = await tx.all<{ seq: number; bytes: number }>(
				withForkViews(
					[view],
					`SELECT seq,CASE WHEN chunks=0 THEN ${this.entryByteLength("entry_json")} ELSE (chunks-1)*?+${tail} END bytes FROM ${view.name} e WHERE session_id=? AND seq IN (${wanted.map(() => "?").join(",")}) ORDER BY seq`,
				),
				...view.params,
				SESSION_ENTRY_CHUNK_BYTES,
				sessionId,
				...wanted,
			);
			const sizes = new Map(rows.map((row) => [Number(row.seq), row.bytes == null ? undefined : Number(row.bytes)]));
			const plan = selectedPagePlan(
				sessionId,
				wanted,
				head.lastSeq,
				(seq) => {
					const bytes = sizes.get(seq);
					if (bytes === undefined) throw new SessionConflictError(sessionId, wanted.at(-1)!, head.lastSeq);
					return bytes;
				},
				options.backward,
			);
			if ("oversized" in plan)
				return { items: [{ kind: "oversized", sessionId, epoch, ...plan.oversized } as const] };
			return { items: await this.readSeqs(tx, sessionId, plan.seqs) };
		});
	}

	/**
	 * The snapshot entries of the session's resume index, read with the index and nothing else: no entry is read, and an
	 * index that does not cover the session as it stands is not rebuilt here (#5554).
	 */
	async readSnapshotCut(
		sessionId: string,
		options: { readonly leafSeq?: number } = {},
	): Promise<SessionSnapshotCut | undefined> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const row = await this.database.get<ResumeRow>(
			`SELECT last_seq,summary_state,revision FROM ${this.tables.sessions} WHERE id = ?`,
			sessionId,
		);
		if (!row) throw new SessionNotFoundError(sessionId);
		const lastSeq = Number(row.last_seq);
		const remembered = this.resumeIndexes.get(sessionId);
		const index =
			windowIndex(JSON.parse(row.summary_state) as StoredSummaryState, lastSeq) ??
			(remembered?.revision === row.revision && isSessionResumeIndex(remembered.index, lastSeq)
				? remembered.index
				: undefined);
		if (index === undefined || (options.leafSeq !== undefined && options.leafSeq > lastSeq)) return undefined;
		return snapshotCutOf(index, options.leafSeq);
	}

	async readEntrySizes(
		sessionId: string,
		startSeq: number,
		endSeq: number,
		limit?: number,
	): Promise<SessionEntrySizes> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		return this.readTransaction(async (tx) => {
			const head = await this.historyHead(tx, sessionId, true);
			const lastChunk = `(SELECT length(data) FROM ${this.tables.entryChunks} c WHERE c.session_id = e.src_id AND c.seq = e.src_seq AND c.idx = e.chunks - 1)`;
			const tables = await this.viewTables(tx, sessionId);
			// A view's seqs are dense: a shared history reads only the seqs the limit lets through.
			const after = Math.max(1, startSeq) - 1;
			const view = this.entriesView(
				tables,
				sessionId,
				after,
				tables.segments === undefined ? endSeq : Math.min(endSeq, after + entrySizeLimit(limit)),
			);
			const rows = await tx.all<SqliteRow & { seq: number; bytes: number | null }>(
				withForkViews(
					[view],
					`SELECT seq, CASE WHEN chunks = 0 THEN ${this.entryByteLength("entry_json")} ELSE (chunks - 1) * ? + ${lastChunk} END AS bytes FROM ${view.name} e WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq LIMIT ?`,
				),
				...view.params,
				SESSION_ENTRY_CHUNK_BYTES,
				sessionId,
				startSeq,
				endSeq,
				entrySizeLimit(limit),
			);
			return {
				lastSeq: head.lastSeq,
				epoch: head.epoch,
				sizes: rows.map((row) => {
					if (row.bytes === null)
						throw new StorageUnavailableError(
							this.descriptor,
							new Error(`Missing final chunk of session entry ${row.seq}`),
						);
					return { seq: Number(row.seq), bytes: Number(row.bytes) };
				}),
			};
		});
	}

	/**
	 * One statement, so one snapshot without a transaction: the session row (its generation, watermark and schema version)
	 * sorts first as sequence 0, then the page's entries with their sizes. The page ends at the last of up to `limit`
	 * entries whose running size fits a page, or is the first entry alone, whose JSON is left out when it is larger. Each
	 * page of a scan is then one round trip to a database server (#5571). With `select`, only the entries `selected` keeps
	 * are sized and read; the session row then also says how many were sized and the last of them, so the page knows how
	 * far it accounts for the range.
	 */
	async readScanPage(
		sessionId: string,
		startSeq: number,
		endSeq: number,
		epoch: string | undefined,
		limit: number,
		options: SessionScanOptions = {},
	): Promise<SessionScanPage> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const { select, trailingReference, referencePrefix } = options;
		const generation = this.generation(sessionId);
		const count = entrySizeLimit(limit);
		// The page reads the session's view (#6560), the schema in the same statement: a page read without shared history
		// that finds it turned on is read again. A shared history is read a window at a time, so each source's index reads
		// only the seqs the page may hold: the next `count` of a view's dense seqs, or a wider window for a selection,
		// which then accounts for the range only through the window's end.
		// A session this store last found without segments is read from its tables, which the head row confirms.
		const shared = this.sharedHistorySeen;
		const plain = shared && this.forkedSessions.get(sessionId) === false;
		const tables: ForkViewTables = {
			segments: shared && !plain ? this.forkTables.forkSegments : undefined,
			dialect: this.dialect,
		};
		const scanEnd =
			tables.segments === undefined
				? endSeq
				: Math.min(endSeq, Math.max(1, startSeq) - 1 + (select === undefined ? count : SCAN_SELECT_WINDOW));
		const view = this.entriesView(tables, sessionId, startSeq - 1, scanEnd, "scan_view");
		const bytes = (row: string) =>
			`CASE WHEN ${row}.chunks = 0 THEN ${this.entryByteLength(`${row}.entry_json`)} ELSE (${row}.chunks - 1) * ? + (SELECT length(data) FROM ${this.tables.entryChunks} c WHERE c.session_id = ${row}.src_id AND c.seq = ${row}.src_seq AND c.idx = ${row}.chunks - 1) END`;
		const forked = this.outsideForkedColumn("id");
		const forkedNull = forked === "" ? "" : ", NULL";
		const head = `SELECT 0 AS seq, NULL AS bytes, NULL AS chunks, header_json AS entry_json, last_seq, revision,
				${generation.sql} AS epoch, (SELECT schema_version FROM ${this.tables.meta} LIMIT 1) AS schema_version${forked}`;
		type Row = SqliteRow & {
			seq: number;
			bytes: number | null;
			chunks: number | null;
			entry_json: string | null;
			last_seq: number | null;
			revision: string | null;
			epoch: string | null;
			schema_version: number | null;
			forked?: number | null;
			sized?: number | null;
			sized_last?: number | null;
			prefix?: Uint8Array | null;
		};
		const filter = (row: string) => (select ? ` AND ${this.selected(row, select)}` : "");
		const selectParams = select === undefined ? [] : this.selectedParams(select);
		const json = this.dialect.name === "sqlite" ? "CAST(entry_json AS BLOB)" : "convert_to(entry_json, 'UTF8')";
		const prefixLength = Math.max(1, Math.trunc(referencePrefix ?? 1) || 1);
		const rows =
			!select && !trailingReference && referencePrefix === undefined
				? await this.database.all<Row>(
						withForkViews(
							[view],
							`${head} FROM ${this.tables.sessions} WHERE id = ?
					UNION ALL
					SELECT seq, bytes, chunks, CASE WHEN bytes <= ? AND chunks = 0 THEN entry_json END, NULL, NULL, NULL, NULL${forkedNull} FROM (
						SELECT e.seq, e.chunks, e.entry_json, ${bytes("e")} AS bytes FROM ${view.name} e
						-- The cut bounds the range itself, so the read stops there, however far the range goes.
						WHERE e.session_id = ? AND e.seq BETWEEN ? AND (
							SELECT COALESCE(max(CASE WHEN total <= ? THEN seq END), min(seq)) FROM (
								SELECT seq, sum(bytes) OVER (ORDER BY seq) AS total FROM (
									SELECT s.seq, ${bytes("s")} AS bytes FROM ${view.name} s
									WHERE s.session_id = ? AND s.seq BETWEEN ? AND ? ORDER BY s.seq LIMIT ?
								) AS sized
							) AS run
						)
					) AS page
					ORDER BY seq`,
						),
						...view.params,
						...generation.params,
						sessionId,
						SESSION_HISTORY_PAGE_BYTES,
						SESSION_ENTRY_CHUNK_BYTES,
						sessionId,
						startSeq,
						SESSION_HISTORY_PAGE_BYTES,
						SESSION_ENTRY_CHUNK_BYTES,
						sessionId,
						startSeq,
						scanEnd,
						count,
					)
				: // The entries the page may hold are sized once: the cut, the coverage and the reference after the run use them.
					await this.database.all<Row>(
						withForkViews(
							[view],
							`WITH sized AS MATERIALIZED (
						SELECT s.seq, ${bytes("s")} AS bytes FROM ${view.name} s
						WHERE s.session_id = ? AND s.seq BETWEEN ? AND ?${filter("s")} ORDER BY s.seq LIMIT ?
					), cut AS (
						SELECT COALESCE(
							(SELECT max(seq) FROM (SELECT seq, sum(bytes) OVER (ORDER BY seq) AS total FROM sized) AS run WHERE total <= ?),
							(SELECT min(seq) FROM sized)
						) AS seq
					), tail AS (
						SELECT seq FROM sized
						WHERE ${trailingReference ? "" : "1 = 0 AND "}seq = (SELECT min(seq) FROM sized WHERE seq > (SELECT seq FROM cut))
							AND bytes > ? AND (SELECT bytes FROM sized WHERE seq = (SELECT seq FROM cut)) <= ?
					)
					${head}, (SELECT count(*) FROM sized) AS sized, (SELECT max(seq) FROM sized) AS sized_last, NULL AS prefix
					FROM ${this.tables.sessions} WHERE id = ?
					UNION ALL
					SELECT seq, bytes, chunks, CASE WHEN bytes <= ? AND chunks = 0 THEN entry_json END, NULL, NULL, NULL, NULL${forkedNull}, NULL, NULL,
						${
							referencePrefix === undefined
								? "NULL"
								: `CASE WHEN bytes > ? THEN CASE WHEN chunks > 0
									THEN (SELECT substr(c.data, 1, CAST(? AS INTEGER)) FROM ${this.tables.entryChunks} c WHERE c.session_id = page.src_id AND c.seq = page.src_seq AND c.idx = 0)
									ELSE substr(${json}, 1, CAST(? AS INTEGER)) END END`
						}
					FROM (
						SELECT e.seq, e.chunks, e.entry_json, e.src_id, e.src_seq, ${bytes("e")} AS bytes FROM ${view.name} e
						WHERE e.session_id = ? AND e.seq BETWEEN ? AND (SELECT seq FROM cut)${filter("e")}
						UNION ALL
						SELECT e.seq, e.chunks, e.entry_json, e.src_id, e.src_seq, ${bytes("e")} AS bytes FROM ${view.name} e
						WHERE e.session_id = ? AND e.seq = (SELECT seq FROM tail)
					) AS page
					ORDER BY seq`,
						),
						...view.params,
						SESSION_ENTRY_CHUNK_BYTES,
						sessionId,
						startSeq,
						scanEnd,
						...selectParams,
						count,
						SESSION_HISTORY_PAGE_BYTES,
						SESSION_HISTORY_PAGE_BYTES,
						SESSION_HISTORY_PAGE_BYTES,
						...generation.params,
						sessionId,
						SESSION_HISTORY_PAGE_BYTES,
						...(referencePrefix === undefined ? [] : [SESSION_HISTORY_PAGE_BYTES, prefixLength, prefixLength]),
						SESSION_ENTRY_CHUNK_BYTES,
						sessionId,
						startSeq,
						...selectParams,
						SESSION_ENTRY_CHUNK_BYTES,
						sessionId,
					);
		const first = rows[0];
		if (first === undefined || Number(first.seq) !== 0) throw new SessionNotFoundError(sessionId);
		assertStorageSchemaVersion(
			"sessions",
			first.schema_version,
			SESSION_SCHEMA_VERSION,
			SESSION_SCHEMA_VERSION_UNCHUNKED,
		);
		this.noteSchemaVersion(first.schema_version);
		this.noteForked(undefined, sessionId, first.forked);
		if (this.sharedHistorySeen !== shared || (plain && Number(first.forked) === 1))
			return SqlSessionStore.prototype.readScanPage.call(this, sessionId, startSeq, endSeq, epoch, limit, options);
		const lastSeq = Number(first.last_seq);
		this.noteGeneration(sessionId, first.revision!, lastSeq, first.epoch!);
		if (epoch !== undefined && first.epoch !== epoch) throw new SessionConflictError(sessionId, endSeq, lastSeq);
		const read = {
			header: JSON.parse(first.entry_json!) as SessionRecordHeader,
			epoch: first.epoch!,
			lastSeq,
		};
		const page = rows.slice(1);
		for (const row of page)
			if (row.bytes === null)
				throw new StorageUnavailableError(
					this.descriptor,
					new Error(`Missing final chunk of session entry ${row.seq}`),
				);
		const top = page.at(-1);
		if (top === undefined) return { ...read, throughSeq: scanEnd, items: [] };
		// The page accounts for the range through its last entry, or through the end when every entry it sized fit.
		const throughSeq =
			first.sized !== undefined && Number(first.sized) < count && Number(first.sized_last) <= Number(top.seq)
				? scanEnd
				: Number(top.seq);
		const prefixes = new Map<number, Uint8Array>();
		const reference = (row: Row): SessionHistoryItem => {
			if (row.prefix) prefixes.set(Number(row.seq), row.prefix);
			return { kind: "oversized", sessionId, epoch: read.epoch, seq: Number(row.seq), bytes: Number(row.bytes) };
		};
		const oversized = (row: Row) => Number(row.bytes) > SESSION_HISTORY_PAGE_BYTES;
		const run = page.filter((row) => !oversized(row));
		const references = page.filter(oversized).map(reference);
		const withPrefixes = { ...read, throughSeq, ...(prefixes.size ? { prefixes } : {}) };
		if (!run.length) return { ...withPrefixes, items: references };
		// Only an entry larger than a stored chunk is chunked, and so larger than a page; one that is not is read with its
		// chunks in a snapshot of its own all the same.
		if (run.some((row) => Number(row.chunks) > 0)) {
			const range = await this.readRange(sessionId, Number(run[0]!.seq), Number(run.at(-1)!.seq), read.epoch);
			const seqs = new Set(run.map((row) => Number(row.seq)));
			return {
				...withPrefixes,
				lastSeq: range.lastSeq,
				items: [
					...range.entries
						.map((entry, i) => ({ seq: range.seqs![i]!, entry }))
						.filter((item) => seqs.has(item.seq)),
					...references,
				],
			};
		}
		return {
			...withPrefixes,
			items: [
				...run.map((row) => ({ seq: Number(row.seq), entry: JSON.parse(row.entry_json!) as SessionEntry })),
				...references,
			],
		};
	}

	/**
	 * A condition on an entries row that holds for every entry `select` selects (and more): an entry larger than a page;
	 * on SQLite and libSQL, a message whose stored type and role say it is a tool result, or an assistant message with a
	 * tool call named other than `exceptCalls`, and any row that is not valid JSON; on Postgres, which would parse each
	 * row's JSON to read those, any row whose JSON holds a tool call block's `"toolCall"` or a result's `"toolResult"`,
	 * which `JSON.stringify`, the only writer of a row, always writes as such (it never escapes a letter).
	 */
	private selected(row: string, select: SessionToolUseSelection): string {
		const json = `${row}.entry_json`;
		if (this.dialect.name !== "sqlite")
			return `(${row}.chunks > 0 OR ${this.dialect.contains(json, `'"toolCall"'`)} OR ${this.dialect.contains(json, `'"toolResult"'`)})`;
		const named = select.exceptCalls.length
			? `json_type(b.value, '$.name') IS NOT 'text' OR json_extract(b.value, '$.name') NOT IN (${select.exceptCalls.map(() => "?").join(", ")})`
			: "1";
		return `(${row}.chunks > 0 OR NOT json_valid(${json}) OR json_extract(${json}, '$.type') = 'message' AND (
			json_extract(${json}, '$.message.role') = 'toolResult'
			OR json_extract(${json}, '$.message.role') = 'assistant' AND EXISTS (
				SELECT 1 FROM json_each(${json}, '$.message.content') b
				WHERE b.type = 'object' AND json_extract(b.value, '$.type') = 'toolCall' AND (${named})
			)
		))`;
	}

	private selectedParams(select: SessionToolUseSelection): readonly SqliteValue[] {
		return this.dialect.name === "sqlite" ? select.exceptCalls : [];
	}

	/**
	 * One statement, so one snapshot without a transaction: the session row's generation, watermark and schema version
	 * with the bytes, from the entry's own JSON or from the one stored chunk that holds `offset`.
	 */
	async readEntryChunk(
		reference: OversizedSessionEntry,
		offset: number,
		bytes = SESSION_HISTORY_CHUNK_BYTES,
	): Promise<Uint8Array> {
		this.assertOpen();
		const { sessionId, epoch, seq } = reference;
		const length = Math.min(Math.max(1, Math.trunc(bytes) || 1), SESSION_HISTORY_PAGE_BYTES);
		const generation = this.generation(sessionId);
		const json = this.dialect.name === "sqlite" ? "CAST(e.entry_json AS BLOB)" : "convert_to(e.entry_json, 'UTF8')";
		// The entry through the session's view (#6560), with the schema in the same statement: one read without shared
		// history that finds it turned on is read again.
		// A session this store last found without segments is read from its tables, which the same row confirms (#6560).
		const shared = this.sharedHistorySeen;
		const plain = shared && this.forkedSessions.get(sessionId) === false;
		const view = this.entriesView(
			{ segments: shared && !plain ? this.forkTables.forkSegments : undefined, dialect: this.dialect },
			sessionId,
			seq - 1,
			seq,
		);
		const row = await this.database.get<
			SqliteRow & {
				forked?: number;
				last_seq: number;
				revision: string;
				epoch: string;
				schema_version: number | null;
				chunks: number | null;
				data: Uint8Array | null;
			}
		>(
			withForkViews(
				[view],
				`SELECT s.last_seq, s.revision, ${generation.sql} AS epoch,
				(SELECT schema_version FROM ${this.tables.meta} LIMIT 1) AS schema_version, e.chunks,
				CASE WHEN e.chunks > 0
					THEN (SELECT substr(c.data, CAST(? AS INTEGER), CAST(? AS INTEGER)) FROM ${this.tables.entryChunks} c WHERE c.session_id = e.src_id AND c.seq = e.src_seq AND c.idx = ?)
					ELSE substr(${json}, CAST(? AS INTEGER), CAST(? AS INTEGER)) END AS data${this.outsideForkedColumn("s.id")}
			FROM ${this.tables.sessions} s LEFT JOIN ${view.name} e ON e.session_id = s.id
			WHERE s.id = ?`,
			),
			...view.params,
			...generation.params,
			(offset % SESSION_ENTRY_CHUNK_BYTES) + 1,
			length,
			Math.floor(offset / SESSION_ENTRY_CHUNK_BYTES),
			offset + 1,
			length,
			sessionId,
		);
		if (!row) throw new SessionNotFoundError(sessionId);
		assertStorageSchemaVersion(
			"sessions",
			row.schema_version,
			SESSION_SCHEMA_VERSION,
			SESSION_SCHEMA_VERSION_UNCHUNKED,
		);
		this.noteSchemaVersion(row.schema_version);
		this.noteForked(undefined, sessionId, row.forked);
		if (this.sharedHistorySeen !== shared || (plain && Number(row.forked) === 1))
			return SqlSessionStore.prototype.readEntryChunk.call(this, reference, offset, bytes);
		this.noteGeneration(sessionId, row.revision, Number(row.last_seq), row.epoch);
		if (row.epoch !== epoch) throw new SessionConflictError(sessionId, seq, Number(row.last_seq));
		if (row.chunks === null)
			throw new StorageUnavailableError(this.descriptor, new Error(`Missing session entry ${seq}`));
		if (row.data === null)
			throw new StorageUnavailableError(this.descriptor, new Error(`Missing chunk of session entry ${seq}`));
		return row.data;
	}

	async findEntrySeq(sessionId: string, entryId: string): Promise<number | undefined> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		validateSessionText("entry.id", entryId);
		if (!(await this.readHeader(sessionId))) throw new SessionNotFoundError(sessionId);
		return this.seqOfEntry(this.database, undefined, sessionId, entryId);
	}

	/**
	 * Earlier entries that may save the same task reference as each candidate (#5593), in one statement on the session
	 * links' entry-ID index: the statement reads each candidate's ID at its sequence itself, so no entry ID is bound or
	 * returned, and no entry body is read. `undefined` while that index is still being built.
	 */
	async findTaskReferenceDuplicateCandidates(
		sessionId: string,
		query: SessionTaskReferenceDuplicateQuery,
	): Promise<SessionTaskReferenceDuplicatePage | undefined> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const { candidates, afterSeq, limit } = taskReferenceDuplicateQuery(query);
		return this.readTransaction(async (tx) => {
			// A fork that shares its parent's history finds the links it inherits through its view (#6560); any other
			// session, which the head read tells apart, reads its own links by key.
			const tables = await this.viewTables(tx, sessionId);
			const head = await this.historyHead(tx, sessionId, true);
			if (head.epoch !== query.epoch || head.lastSeq < query.throughSeq)
				throw new SessionConflictError(sessionId, query.throughSeq, head.lastSeq);
			if (candidates.length === 0) return { seqs: [] };
			const t = snapshotIndexTables(this.prefix);
			const view = !head.forked
				? undefined
				: forkView(tables, {
						name: "links_view",
						table: t.sessionLinks,
						columns: ["entry_id"],
						sessionId,
						after: 0,
						through: query.throughSeq,
					});
			const links = view === undefined ? t.sessionLinks : "links_view";
			/**
			 * For each candidate `c`, the links row `s` at its sequence and then, with `earlier`, the rows `e` before it
			 * under an ID, each found through an index, never by walking the session. Postgres plans a lateral subquery
			 * behind `OFFSET 0` once per row before it; SQLite keeps a `CROSS JOIN`'s order. `+e.seq` keeps either from
			 * reading the session's rows by sequence instead of by ID.
			 */
			const rowsOf = (earlier?: string) => {
				const keys: [alias: string, column: string, key: string][] = [
					["s", "entry_id", "s.session_id = ? AND s.seq = c.seq"],
				];
				if (earlier !== undefined)
					keys.push([
						"e",
						"seq",
						`e.session_id = ? AND e.entry_id = ${earlier} AND +e.seq < c.seq AND +e.seq > ?`,
					]);
				if (this.dialect.name !== "postgres")
					return `c ${keys.map(([alias]) => `CROSS JOIN ${links} ${alias}`).join(" ")} WHERE ${keys.map(([, , key]) => key).join(" AND ")}`;
				return `c ${keys.map(([alias, column, key]) => `CROSS JOIN LATERAL (SELECT ${alias}.${column} FROM ${links} ${alias} WHERE ${key} OFFSET 0) ${alias}`).join(" ")}`;
			};
			// The other ID that names the same reference: `<id>:<block>` for a block, the rest of a `<root>:<digits>` ID.
			const other = `CASE WHEN c.idx >= 0 THEN s.entry_id || ':' || CAST(c.idx AS TEXT)
				WHEN c.suffix > 0 AND c.suffix <= length(s.entry_id) AND substr(s.entry_id, length(s.entry_id) - c.suffix + 1, 1) = ':'
				THEN substr(s.entry_id, 1, length(s.entry_id) - c.suffix) END`;
			const values = candidates.map(
				() => `(CAST(? AS ${this.dialect.types.int}), CAST(? AS INTEGER), CAST(? AS INTEGER))`,
			);
			const rows = await tx.all<SqliteRow & { kind: number; seq: number | null }>(
				withForkViews(
					view === undefined ? [] : [view],
					`WITH c(seq, idx, suffix) AS (VALUES ${values.join(", ")}),
				hits AS (SELECT e.seq AS seq FROM ${rowsOf("s.entry_id")} UNION SELECT e.seq FROM ${rowsOf(other)})
				SELECT 0 AS kind, (SELECT CASE WHEN backfilled_through >= watermark THEN 1 ELSE 0 END FROM ${t.sources} WHERE source = 'session-entries') AS seq
				UNION ALL SELECT 1, count(*) FROM ${rowsOf()}
				UNION ALL SELECT 2, page.seq FROM (SELECT seq FROM hits ORDER BY seq LIMIT ?) page`,
				),
				...(view?.params ?? []),
				...candidates.flat(),
				...[sessionId, sessionId, afterSeq, sessionId, sessionId, afterSeq, sessionId, limit + 1],
			);
			let indexed = false;
			let found = 0;
			const seqs: number[] = [];
			for (const row of rows) {
				if (Number(row.kind) === 0) indexed = Number(row.seq) === 1;
				else if (Number(row.kind) === 1) found = Number(row.seq);
				else seqs.push(Number(row.seq));
			}
			if (!indexed) return undefined;
			// Every candidate's row is in the epoch the caller read; one that is not is no longer the history it read.
			if (found !== candidates.length) throw new SessionConflictError(sessionId, query.throughSeq, head.lastSeq);
			seqs.sort((a, b) => a - b);
			return seqs.length > limit ? { seqs: seqs.slice(0, limit), nextAfterSeq: seqs[limit - 1]! } : { seqs };
		});
	}
	async readForkWindow(sessionId: string, entryId: string, options?: { readonly archivedReceipts: true }) {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const { indexedForkWindow, forkMetadata, byteMetadata, locateFork } = await import("./fork-window.js");
		return this.readTransaction(async (tx) => {
			// Check the index in the same snapshot as the entries. A peer can legitimately invalidate or
			// remove it when appending to a side branch; that must not make a committed fork point disappear.
			const snapshots = snapshotIndexTables(this.prefix);
			// The fork point through the session's view (#6560), from the links or the entries; read directly when this
			// store last found the session without segments, which the same row then confirms, or read again.
			const shared = await this.viewTables(tx);
			const headRead = (leafTables: ForkViewTables) => {
				const leafViews = [snapshots.sessionLinks, this.tables.entries].map((table, index) =>
					forkView(leafTables, {
						name: `leaf_${index}`,
						table,
						columns: ["entry_id"],
						sessionId,
						after: 0,
						through: FORK_VIEW_END,
						match: { column: "entry_id", value: entryId },
					}),
				);
				return tx.get<ResumeRow & { leaf_seq: number | null; forked?: number }>(
					withForkViews(
						leafViews,
						`SELECT header_json,last_seq,summary_state,revision,CASE WHEN EXISTS (SELECT 1 FROM ${snapshots.sources} WHERE source='session-entries' AND backfilled_through>=watermark) THEN (SELECT max(seq) FROM leaf_0) ELSE (SELECT max(seq) FROM leaf_1) END AS leaf_seq${this.forkedColumn(shared.segments, "s.id")} FROM ${this.tables.sessions} s WHERE s.id=?`,
					),
					...forkViewParams(leafViews),
					sessionId,
				);
			};
			const guessPlain = shared.segments !== undefined && this.forkedSessions.get(sessionId) === false;
			let row = await headRead(guessPlain ? { ...shared, segments: undefined } : shared);
			if (row && guessPlain && Number(row.forked) === 1) row = await headRead(shared);
			if (row) this.noteForked(tx, sessionId, row.forked);
			const tables = await this.viewTables(tx, sessionId);
			if (!row) throw new SessionNotFoundError(sessionId);
			const header = JSON.parse(row.header_json) as SessionRecordHeader;
			const state = JSON.parse(row.summary_state) as StoredSummaryState;
			// The session's generation in this snapshot, in which the entries read are noted for a fork to share (#6560).
			const generation = state.epoch ?? row.revision;
			const count = Number(row.last_seq);
			const cached = this.resumeIndexes.get(sessionId);
			const ready = windowIndex(state, count) ?? (cached?.revision === row.revision ? cached.index : undefined);
			const leaf = Number(row.leaf_seq);
			if (!leaf) return undefined;
			const metadata = async (seqs: readonly number[]) => {
				const result: import("./fork-window.js").ForkMetadata[] = [];
				if (!seqs.length) return result;
				const raw = this.dialect.name === "sqlite" ? "CAST(entry_json AS BLOB)" : "convert_to(entry_json,'UTF8')";
				const size = this.dialect.textByteLength("entry_json");
				const view = this.entriesView(tables, sessionId, Math.min(...seqs) - 1, Math.max(...seqs));
				const rows = await tx.all<SqliteRow & { seq: number; chunks: number; bytes: number; body: string | null }>(
					withForkViews(
						[view],
						`SELECT seq,chunks,${size} AS bytes,CASE WHEN chunks=0 AND ${size}<=512 THEN entry_json END AS body FROM ${view.name} WHERE session_id=? AND seq IN (${seqs.map(() => "?").join(",")}) ORDER BY seq`,
					),
					...view.params,
					sessionId,
					...seqs,
				);
				for (const row of rows) {
					const seq = Number(row.seq);
					if (row.body !== null) result.push(forkMetadata(seq, JSON.parse(row.body) as SessionEntry));
					else if (Number(row.chunks) > 0) {
						const { projectForkMetadata } = await import("./chunked-resume-projection.js");
						result.push(
							await projectForkMetadata(
								seq,
								this.forkEntryChunks(tx, tables, sessionId, seq, Number(row.chunks)),
							),
						);
					} else
						result.push(
							await byteMetadata(seq, Number(row.bytes), async (offset, n) => {
								const one = this.entriesView(tables, sessionId, seq - 1, seq);
								const piece = await tx.get<SqliteRow & { part: Uint8Array }>(
									withForkViews([one], `SELECT substr(${raw},?,?) AS part FROM ${one.name}`),
									...one.params,
									offset + 1,
									n,
								);
								if (!piece)
									throw new StorageError(`Session ${sessionId} entry ${seq} disappeared during its fork`);
								return piece.part;
							}),
						);
				}
				return result;
			};
			const j = (field: string) => this.dialect.jsonText("entry_json", field);
			// A shared history is scanned a window of seqs at a time, so each source's index reads only those (#6560).
			const scanWindow = (from: number, through: number) => {
				const end = tables.segments === undefined ? through : Math.min(through, from - 1 + SCAN_SELECT_WINDOW);
				return { end, view: this.entriesView(tables, sessionId, from - 1, end) };
			};
			const selected = ready
				? { index: ready, leaf, extras: undefined }
				: await locateFork(
						{
							...foldSessionResume(undefined, []),
							seq: count,
							epoch: generation,
							needsBranchRebuild: true,
						},
						entryId,
						async (seqs) => {
							// Chunked rows store their ID, parent and type inline. A chunked compaction or custom record needs the
							// bounded projection; a chunked message needs only its role, to tell a system message apart; other
							// rows need only their links for this walk.
							const pg = this.dialect.name === "postgres";
							const key = (...path: string[]) =>
								pg
									? this.dialect.jsonAt({ column: "entry_json", element: "parsed" }, ...path)
									: this.dialect.jsonText("entry_json", ...path);
							// Parse once per row on PostgreSQL, and transfer short tuples rather than repeating field names.
							const projection = this.dialect.jsonArray([
								"entry_id",
								key("parentId"),
								key("type"),
								key("customType"),
								key("firstKeptEntryId"),
								key("coveredThroughEntryId"),
								key("details", "strategy"),
								`CASE WHEN ${key("customType")} IN ('task-completion-intent','task-completion-ack') AND ${this.dialect.jsonAtIsText(pg ? { column: "entry_json", element: "parsed" } : { column: "entry_json" }, "data", "completionId")} THEN ${key("data", "completionId")} END`,
								key("message", "role"),
							]);
							const view = this.entriesView(tables, sessionId, seqs[0]! - 1, seqs.at(-1)!);
							const links = await tx.all<SqliteRow & { seq: number; chunks: number; link: string | null }>(
								withForkViews(
									[view],
									`WITH projected AS MATERIALIZED (SELECT seq,chunks,CAST(${projection} AS TEXT) AS link FROM ${view.name} ${pg ? `CROSS JOIN LATERAL (SELECT ${postgresJsonb("entry_json")} AS value OFFSET 0) AS parsed` : ""} WHERE session_id=? AND seq BETWEEN ? AND ?) SELECT seq,chunks,CASE WHEN ${this.dialect.textByteLength("link")}<=512 THEN link END AS link FROM projected ORDER BY seq`,
								),
								...view.params,
								sessionId,
								seqs[0]!,
								seqs.at(-1)!,
							);
							const parsed = links.map((r) => ({
								seq: Number(r.seq),
								chunked: Number(r.chunks) > 0,
								link:
									r.link === null
										? undefined
										: (JSON.parse(r.link) as [
												string,
												string | null,
												string,
												string | null,
												string | null,
												string | null,
												string | null,
												string | null,
												string | null,
											]),
							}));
							// Read a chunked message's role from the start of its first chunk, not from its whole payload. When
							// that prefix ends before the role, the bounded projection reads the message instead.
							const roles = new Map<number, string | undefined>();
							const chunkedMessages = parsed
								.filter((r) => r.chunked && r.link?.[2] === "message")
								.map((r) => r.seq);
							if (chunkedMessages.length) {
								const { messageRoleIn } = await import("./chunked-resume-projection.js");
								for (let i = 0; i < chunkedMessages.length; i += SEQ_BATCH) {
									const batch = chunkedMessages.slice(i, i + SEQ_BATCH);
									const view = this.entriesView(tables, sessionId, Math.min(...batch) - 1, Math.max(...batch));
									const prefixes = await tx.all<SqliteRow & { seq: number; prefix: Uint8Array }>(
										withForkViews(
											[view],
											`SELECT v.seq,substr(c.data,1,${FORK_ROLE_PREFIX_BYTES}) AS prefix FROM ${view.name} v JOIN ${this.tables.entryChunks} c ON c.session_id=v.src_id AND c.seq=v.src_seq AND c.idx=0 WHERE v.seq IN (${batch.map(() => "?").join(",")})`,
										),
										...view.params,
										...batch,
									);
									for (const row of prefixes) roles.set(Number(row.seq), messageRoleIn(row.prefix));
								}
							}
							const page: import("./fork-window.js").ForkMetadata[] = [];
							for (const { seq, chunked, link } of parsed) {
								const role = chunked ? roles.get(seq) : link?.[8];
								if (
									!link ||
									(chunked &&
										(link[2] === "custom" ||
											link[2] === "compaction" ||
											(link[2] === "message" && role === undefined)))
								)
									page.push(...(await metadata([seq])));
								else {
									const [id, parentId, type, customType, first, covered, strategy, completionId] = link;
									page.push({
										seq,
										id,
										parentId,
										type,
										customType: customType ?? undefined,
										completionId: completionId ?? undefined,
										...(type === "message" && role === "system" ? { system: true } : {}),
										...(type === "compaction" && strategy === "verbatim-lines"
											? { boundary: { first, covered: covered ?? undefined } }
											: {}),
									});
								}
							}
							return page;
						},
						true,
						SESSION_READ_FETCH.max,
					);
			const labelBody = `CASE WHEN chunks=0 AND ${this.dialect.textByteLength("entry_json")}<=512 THEN entry_json END`;
			return indexedForkWindow(
				header,
				selected.index,
				selected.leaf,
				(lo, hi) => this.readRows(tx, sessionId, { from: lo, through: hi }, undefined, generation),
				(seqs) => this.readSeqs(tx, sessionId, seqs, generation),
				metadata,
				async function* (ranges, kinds, types = []) {
					const filters: string[] = [];
					if (types.length) filters.push(`${j("type")} IN (${types.map(() => "?").join(",")})`);
					if (kinds.length)
						filters.push(
							`(${j("type")}='custom' AND (chunks>0 OR ${j("customType")} IN (${kinds.map(() => "?").join(",")})))`,
						);
					for (const [lo, hi] of ranges)
						for (let seq = lo; seq <= hi; ) {
							const labels = types.length === 1 && types[0] === "label";
							const limit = labels ? SESSION_READ_FETCH.first : SESSION_READ_FETCH.max;
							const { end, view } = scanWindow(seq, hi);
							const rows = await tx.all<SqliteRow & { seq: number; kind: string; body?: string | null }>(
								withForkViews(
									[view],
									`SELECT seq,${j("type")} AS kind${labels ? `,${labelBody} AS body` : ""} FROM ${view.name} WHERE session_id=? AND seq BETWEEN ? AND ? AND (${filters.join(" OR ")}) ORDER BY seq LIMIT ${limit}`,
								),
								...view.params,
								sessionId,
								seq,
								end,
								...types,
								...kinds,
							);
							const deferred = rows
								.filter((r) => r.kind === "custom" || (r.kind === "label" && !r.body))
								.map((r) => Number(r.seq));
							const projected = new Map<number, import("./fork-window.js").ForkMetadata>();
							for (let i = 0; i < deferred.length; i += SEQ_BATCH)
								for (const m of await metadata(deferred.slice(i, i + SEQ_BATCH))) projected.set(m.seq, m);
							for (const row of rows)
								yield projected.get(Number(row.seq)) ??
									(row.body
										? forkMetadata(Number(row.seq), JSON.parse(row.body) as SessionEntry)
										: { type: row.kind, seq: Number(row.seq) });
							if (rows.length < limit) {
								if (end >= hi) break;
								seq = end + 1;
							} else seq = Number(rows.at(-1)!.seq) + 1;
						}
				},
				{ ...selected.extras, ...options },
			);
		});
	}

	private async *forkEntryChunks(tx: SqliteExecutor, tables: ForkViewTables, id: string, seq: number, count: number) {
		for (let i = 0; i < count; i++) {
			const read = this.entryChunkRead(tables, id, seq, i);
			const row = await tx.get<SqliteRow & { data: Uint8Array }>(read.sql, ...read.params);
			if (!row) throw new StorageError(`Session ${id} entry ${seq} is missing chunk ${i} of ${count}`);
			yield row.data;
		}
	}

	async readChildCatalogCut(sessionId: string) {
		this.assertOpen();
		return childCatalogCut((await this.prepareResume(sessionId)).index);
	}
	readResumeAt(
		sessionId: string,
		leafId: string,
		throughSeq: number,
		options?: { deferChildRecords: true },
	): Promise<SessionResume> {
		return this.resumeWindow(sessionId, leafId, throughSeq, options);
	}
	readResume(sessionId: string, leafId?: string, options?: { deferChildRecords: true }): Promise<SessionResume> {
		return this.resumeWindow(sessionId, leafId, undefined, options);
	}
	private async resumeWindow(
		sessionId: string,
		leafId?: string,
		throughSeq?: number,
		options?: { deferChildRecords: true },
	): Promise<SessionResume> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		if (leafId !== undefined) validateSessionText("entry.id", leafId);
		// The session's current leaf, whose index the session row keeps: the row is read in the transaction itself, so a
		// current index costs no read before it (#6560). One that is missing or stale is computed as below.
		if (leafId === undefined && throughSeq === undefined) {
			try {
				return await this.readTransaction(
					async (tx) => {
						const { header, index } = await this.resumeSource(tx, sessionId);
						return this.resumeIn(tx, sessionId, header, index, options);
					},
					[this.resumeRow(sessionId)],
				);
			} catch (error) {
				if (!(error instanceof SessionConflictError)) throw error;
			}
		}
		for (let attempt = 0; attempt < 3; attempt++) {
			const { index, revision } = await this.prepareResume(sessionId, leafId, throughSeq);
			const resume = await this.readTransaction(async (tx) => {
				const { segments } = await this.viewTables(tx);
				const head = await tx.get<SqliteRow & { header_json: string; revision: string; forked?: number }>(
					`SELECT header_json,revision${this.forkedColumn(segments)} FROM ${this.tables.sessions} WHERE id = ?`,
					sessionId,
				);
				if (!head) throw new SessionNotFoundError(sessionId);
				this.noteForked(tx, sessionId, head.forked);
				if (revision !== head.revision) return undefined;
				return this.resumeIn(tx, sessionId, JSON.parse(head.header_json) as SessionRecordHeader, index, options);
			});
			if (resume !== undefined) return resume;
		}
		throw new SessionConflictError(sessionId, 0, 0);
	}

	/** The resume of `index`, the session's index as of the snapshot of `tx`, with `header`. */
	private async resumeIn(
		tx: SqliteExecutor,
		sessionId: string,
		header: SessionRecordHeader,
		index: SessionResumeIndex,
		options?: { deferChildRecords: true },
	): Promise<SessionResume> {
		const { leafSeq } = index;
		const plan = sessionResumePlan(index, index.leafSeq, options?.deferChildRecords);
		announceHistoryLoad(plan.state.length + plan.branch.reduce((sum, [a, b]) => sum + b - a + 1, 0));
		// The branch's ranges, the state and the leaf depend on the index alone: a pipelined connection sends them at once,
		// one round trip for all, and each range keeps its place in the branch (#6560).
		const [ranges, state, leaf] = await Promise.all([
			Promise.all(
				plan.branch.map(([start, end]) =>
					this.readRows(tx, sessionId, { from: start, through: end }, undefined, index.epoch),
				),
			),
			this.readSeqs(tx, sessionId, plan.state, index.epoch),
			leafSeq <= 0 ? undefined : this.entryIdAt(tx, sessionId, leafSeq),
		]);
		const branch: SessionStoredEntry[] = ranges.flat();
		const resume = sessionResumeFrom(index, header, branch, state, leaf?.entry_id ?? null, plan.children);
		if (resume.compaction)
			await readEarlierCompletionIntents(index, resume, (seqs) => this.readSeqs(tx, sessionId, seqs));
		return resume;
	}

	async findLatestCompaction(sessionId: string, leafId?: string): Promise<SessionCompactionPoint | undefined> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		if (leafId !== undefined) validateSessionText("entry.id", leafId);
		const { point } = await this.withResumeIndex(sessionId, () =>
			this.readTransaction(
				async (tx) => {
					const source = await this.resumeSource(tx, sessionId);
					const { index } = source;
					const leafSeq =
						leafId === undefined
							? index.leafSeq
							: ((await this.seqOfEntry(tx, await this.viewTables(tx, sessionId), sessionId, leafId)) ?? -1);
					const found = latestCompactionOf(index, leafSeq);
					if (found === undefined) return { point: undefined, source };
					// Neither depends on the other: a pipelined connection sends both at once (#6560).
					const [[boundary], leaf] = await Promise.all([
						this.readSeqs(tx, sessionId, [found.seq]),
						this.entryIdAt(tx, sessionId, leafSeq),
					]);
					if (boundary === undefined || leaf === undefined) return { point: undefined, source };
					const point: SessionCompactionPoint = {
						...found,
						entry: boundary.entry as SessionCompactionPoint["entry"],
						leafId: leaf.entry_id,
						lastSeq: index.seq,
					};
					return { point, source };
				},
				[this.resumeRow(sessionId)],
			),
		);

		return point;
	}

	/** The ID of the entry at view seq `seq` of session `sessionId`, read in transaction `tx` (#6560). */
	private async entryIdAt(
		tx: SqliteExecutor,
		sessionId: string,
		seq: number,
	): Promise<{ readonly entry_id: string } | undefined> {
		const view = this.entriesView(await this.viewTables(tx, sessionId), sessionId, seq - 1, seq);
		return tx.get<SqliteRow & { entry_id: string }>(
			withForkViews([view], `SELECT entry_id FROM ${view.name}`),
			...view.params,
		);
	}

	/** The JSON of a long entry, from its chunks, one statement each. */
	private async readEntryChunks(
		tx: SqliteExecutor,
		tables: ForkViewTables,
		sessionId: string,
		seq: number,
		count: number,
	): Promise<string> {
		return Buffer.concat(await this.readRawEntryChunks(tx, tables, sessionId, seq, count)).toString("utf8");
	}

	/**
	 * The read of chunk `index` of the entry at view seq `seq` of session `sessionId` (#6560), found through the view in
	 * the statement itself, on the condition `condition` with `params` when given.
	 */
	private entryChunkRead(
		tables: ForkViewTables,
		sessionId: string,
		seq: number,
		index: number,
		condition?: { readonly sql: string; readonly params: readonly SqliteValue[] },
	): SqliteStatement {
		const view = this.entriesView(tables, sessionId, seq - 1, seq);
		return {
			sql: withForkViews(
				[view],
				`SELECT c.data FROM ${view.name} v JOIN ${this.tables.entryChunks} c
					ON c.session_id = v.src_id AND c.seq = v.src_seq AND c.idx = ?${condition === undefined ? "" : ` WHERE ${condition.sql}`}`,
			),
			params: [...view.params, index, ...(condition?.params ?? [])],
		};
	}

	/**
	 * The chunks of the entry at view seq `seq`: in transaction `tx` with `tables`, or, with `tables` undefined, each
	 * read outside a transaction through `outsideTransaction`.
	 */
	private async readRawEntryChunks(
		tx: SqliteExecutor,
		tables: ForkViewTables | undefined,
		sessionId: string,
		seq: number,
		count: number,
		signal?: AbortSignal,
	): Promise<Uint8Array[]> {
		const chunks: Uint8Array[] = [];
		for (let index = 0; index < count; index++) {
			signal?.throwIfAborted();
			const read = (viewTables: ForkViewTables) => {
				const statement = this.entryChunkRead(viewTables, sessionId, seq, index);
				return tx.get<SqliteRow & { data: Uint8Array }>(statement.sql, ...statement.params);
			};
			const chunk =
				tables === undefined ? await this.outsideTransaction(read, (row) => row !== undefined) : await read(tables);
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
			const chunk = await this.outsideTransaction(
				(tables) => {
					const statement = this.entryChunkRead(tables, sessionId, seq, index, {
						sql: `EXISTS (SELECT 1 FROM ${this.tables.sessions} WHERE id = ? AND revision = ?)`,
						params: [sessionId, revision],
					});
					return this.database.get<SqliteRow & { data: Uint8Array }>(statement.sql, ...statement.params);
				},
				(row) => row !== undefined,
			);
			if (chunk === undefined) {
				throw new StorageError(`Session ${sessionId} entry ${seq} is missing chunk ${index} of ${count}`);
			}
			yield chunk.data;
			if (index + 1 < count) await yieldTurn();
		}
	}

	/** The JSON bytes of the entry stored whole at view seq `seq`, read outside a transaction. */
	private async readInlineEntryBytes(sessionId: string, seq: number): Promise<Uint8Array[]> {
		const sqlite = this.dialect.name === "sqlite";
		const row = await this.outsideTransaction(
			(tables) => {
				const view = this.entriesView(tables, sessionId, seq - 1, seq);
				return this.database.get<SqliteRow & { data: Uint8Array | string }>(
					withForkViews(
						[view],
						`SELECT ${sqlite ? "CAST(entry_json AS BLOB)" : "entry_json"} AS data FROM ${view.name}`,
					),
					...view.params,
				);
			},
			(found) => found !== undefined,
		);
		if (row === undefined) return [];
		return [typeof row.data === "string" ? new TextEncoder().encode(row.data) : row.data];
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
		const read = this.headRead(sessionId, options, includeSummaryState);
		const row = await tx.get<HeaderRow>(read.sql, ...read.params);
		if (!row) throw new SessionNotFoundError(sessionId);
		const state =
			row.summary_state === undefined ? undefined : (JSON.parse(String(row.summary_state)) as StoredSummaryState);
		if (row.last_seq !== options.expectSeq || (options.epoch !== undefined && state?.epoch !== options.epoch)) {
			throw new SessionConflictError(sessionId, options.expectSeq, row.last_seq);
		}
		return { row, state };
	}

	/** The read of the session's row that `forWrite` checks a write against. */
	private headRead(sessionId: string, options: SessionWriteOptions, includeSummaryState: boolean): SqliteStatement {
		return {
			sql: `SELECT header_json, last_seq${includeSummaryState || options.epoch !== undefined ? ", summary_state" : ""}
			 FROM ${this.tables.sessions} WHERE id = ?`,
			params: [sessionId],
		};
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
			const seq = await this.seqOfEntry(tx, await this.viewTables(tx), sessionId, id);
			if (seq !== undefined) seqs.set(id, seq);
		}
		return foldSessionResume(previous, entries, (id) => seqs.get(id));
	}

	/**
	 * The latest seq of session `sessionId` that holds entry `entryId`, through its view (#6560): in transaction
	 * `executor` with `tables`, or, with `tables` undefined, outside a transaction through `outsideTransaction`. A fork's
	 * inherited entries are linked under the sessions that store them, at their seqs there, which the view renumbers.
	 */
	private async seqOfEntry(
		executor: SqliteExecutor,
		tables: ForkViewTables | undefined,
		sessionId: string,
		entryId: string,
	): Promise<number | undefined> {
		const index = snapshotIndexTables(this.prefix);
		const source = await executor.get<SqliteRow & { complete: number }>(
			`SELECT CASE WHEN backfilled_through >= watermark THEN 1 ELSE 0 END AS complete FROM ${index.sources} WHERE source = 'session-entries'`,
		);
		const table = Number(source?.complete) === 1 ? index.sessionLinks : this.tables.entries;
		const read = (viewTables: ForkViewTables, forked = "") => {
			const view = forkView(viewTables, {
				name: "linked",
				table,
				columns: ["entry_id"],
				sessionId,
				after: 0,
				through: FORK_VIEW_END,
				match: { column: "entry_id", value: entryId },
			});
			return executor.get<SqliteRow & { seq: number | null; forked?: number }>(
				withForkViews([view], `SELECT (SELECT seq FROM linked ORDER BY seq DESC LIMIT 1) AS seq${forked}`),
				...view.params,
				...(forked === "" ? [] : [sessionId]),
			);
		};
		// Outside a transaction, the same statement says whether the session has segments (#6560).
		const row =
			tables === undefined
				? await this.outsideSessionRead(
						sessionId,
						(viewTables) => read(viewTables, this.outsideForkedColumn("?")),
						(found) => found?.seq != null,
						(found) => found?.forked,
					)
				: await read(tables);
		return row?.seq == null ? undefined : Number(row.seq);
	}

	private async saveSummary(
		tx: SqliteExecutor,
		sessionId: string,
		snapshot: SessionSnapshot,
		previous?: SessionSummaryState,
		appendedResume?: SessionResumeIndex,
	): Promise<{ readonly texts: readonly SessionSummaryText[]; readonly epoch: string }> {
		const { statement, texts, epoch } = this.summaryWrite(sessionId, snapshot, previous, appendedResume);
		await tx.run(statement.sql, ...statement.params);
		return { texts, epoch };
	}

	/** The statement that saves the session's row as `saveSummary` saves it, with what `saveSummary` returns. */
	private summaryWrite(
		sessionId: string,
		snapshot: SessionSnapshot,
		previous?: SessionSummaryState,
		appendedResume?: SessionResumeIndex,
	): {
		readonly statement: SqliteStatement;
		readonly texts: readonly SessionSummaryText[];
		readonly epoch: string;
		readonly row: WrittenRow;
	} {
		const { header, lastSeq } = snapshot;
		const { state: listed, texts } = applySessionSummaryEntries(previous, snapshot.entries);
		const resume = previous === undefined ? foldSessionResume(undefined, snapshot.entries) : appendedResume;
		const epoch = resume?.epoch ?? (previous as StoredSummaryState | undefined)?.epoch ?? newRevision();
		const state: StoredSummaryState = {
			...listed,
			...windowFields(previous as StoredSummaryState | undefined, resume, lastSeq, epoch),
			epoch,
		};
		const summary = materializeSessionSummaryMetadata(header, state);
		const row: WrittenRow = {
			header_json: this.encode(header),
			summary_state: this.encode(state),
			revision: newRevision(),
			last_seq: lastSeq,
		};
		const sql = `INSERT INTO ${this.tables.sessions}
				(id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count,
				 first_message, name, has_name, summary, summarized_through_id, summary_state, revision)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
				cwd = excluded.cwd, created_at = excluded.created_at, header_json = excluded.header_json,
				internal = excluded.internal, last_seq = excluded.last_seq, modified_at = excluded.modified_at,
				message_count = excluded.message_count, first_message = excluded.first_message, name = excluded.name,
				has_name = excluded.has_name, summary = excluded.summary,
				summarized_through_id = excluded.summarized_through_id,
				summary_state = excluded.summary_state, revision = excluded.revision`;
		const params = [
			sessionId,
			header.cwd,
			header.createdAt,
			row.header_json,
			header.internal ? 1 : 0,
			lastSeq,
			summary.modifiedAt,
			summary.messageCount,
			this.encode(summary.firstMessage),
			summary.name === undefined ? null : this.encode(summary.name),
			summary.hasName ? 1 : 0,
			summary.summary === undefined ? null : this.encode(summary.summary),
			summary.summarizedThroughId ?? null,
			row.summary_state,
			row.revision,
		];
		return { statement: { sql, params }, texts, epoch, row };
	}

	private async insertEntries(
		tx: SqliteExecutor,
		sessionId: string,
		entries: readonly SessionEntry[],
		lastSeq: number,
		texts: readonly SessionSummaryText[],
		versionStep = true,
		written?: WrittenEntry[],
	): Promise<void> {
		const writes = new SentWrites(tx);
		await writes.around(() =>
			writes.send(this.entryWrites(sessionId, entries, lastSeq, texts, versionStep, written)),
		);
	}

	/**
	 * Notes `written`, the entries a committed write of session `sessionId` stored in generation `epoch`, as stored there
	 * (#6560): a manager keeps the very objects it appended, so a fork of it shares their rows without reading them back.
	 * Only where this store has seen shared history, for which alone the notes count.
	 */
	private noteWritten(sessionId: string, epoch: string, written: readonly WrittenEntry[]): void {
		if (!this.sharedHistorySeen) return;
		const note = storedEntryNotes(this, sessionId, epoch);
		for (const { entry, seq, json } of written) note(entry, seq, json);
	}

	/**
	 * A fork's version step, once every entry of the child is in, as the transaction's last write: the same row order as
	 * an append, which takes the snapshot index's progress rows with its entries inserts and the schema row after them,
	 * so the two never deadlock (#6560). The body makes no call after it.
	 */
	private async finishFork(tx: SqliteExecutor, child: string): Promise<void> {
		const step = this.forkVersionStep(child);
		// The transaction's last write: where its connection is pipelined, it goes out with the commit.
		if (transactionFinisher(tx)?.([step]) !== true) await tx.run(step.sql, ...step.params);
	}

	/** The statement of {@link finishFork}. */
	private forkVersionStep(child: string): SqliteStatement {
		return {
			sql: `UPDATE ${this.tables.meta} SET schema_version = ? WHERE schema_version = ? AND EXISTS (SELECT 1 FROM ${this.tables.entries} WHERE session_id = ? AND chunks > 0)`,
			params: [SESSION_SCHEMA_VERSION_CHUNKED, SESSION_SCHEMA_VERSION_UNCHUNKED, child],
		};
	}

	/**
	 * The statements that store `entries` after `lastSeq`, in order, each entry encoded only when its statements are
	 * taken: each entry's row and its chunks, the version step a first chunked entry takes unless `versionStep` is
	 * false (a fork takes it once its last entry is in), then the entries' search texts. With `written`, each entry is
	 * added to it with its seq and its JSON as it is encoded, for {@link noteWritten} once the write commits.
	 */
	private *entryWrites(
		sessionId: string,
		entries: readonly SessionEntry[],
		lastSeq: number,
		texts: readonly SessionSummaryText[],
		versionStep = true,
		written?: WrittenEntry[],
	): Generator<SqliteStatement> {
		let chunked = false;
		for (const [index, entry] of entries.entries()) {
			const seq = lastSeq + index + 1;
			const json = this.encode(entry);
			written?.push({ entry, seq, json });
			const stored = storedEntry(entry, json);
			chunked ||= stored.chunks.length > 0;
			yield {
				sql: `INSERT INTO ${this.tables.entries} (session_id, seq, entry_id, entry_json, chunks) VALUES (?, ?, ?, ?, ?)`,
				params: [sessionId, seq, entry.id, stored.json, stored.chunks.length],
			};
			if (stored.chunks.length > 0) {
				yield {
					sql: `DELETE FROM ${this.tables.entryChunks} WHERE session_id = ? AND seq = ?`,
					params: [sessionId, seq],
				};
			}
			for (const [chunk, data] of stored.chunks.entries()) {
				yield {
					sql: `INSERT INTO ${this.tables.entryChunks} (session_id, seq, idx, data) VALUES (?, ?, ?, ?)`,
					params: [sessionId, seq, chunk, data],
				};
			}
		}
		// One way, in the transaction that writes the first chunked entry: a build that knows only version 1 refuses the
		// database when next opened instead of reading the entry as a stub.
		if (chunked && versionStep) {
			yield {
				sql: `UPDATE ${this.tables.meta} SET schema_version = ? WHERE schema_version = ?`,
				params: [SESSION_SCHEMA_VERSION_CHUNKED, SESSION_SCHEMA_VERSION_UNCHUNKED],
			};
		}
		for (const { index, text } of texts) {
			yield {
				sql: `INSERT INTO ${this.tables.searchTexts} (session_id, seq, text_json) VALUES (?, ?, ?)`,
				params: [sessionId, lastSeq + index + 1, this.encode(text)],
			};
		}
	}

	/**
	 * Runs the session row's statement, then `entries`' statements, in order. A write of up to
	 * {@link STATEMENT_BATCH_BYTES}, as an ordinary message is, goes to a connection thread as one batch that waits for
	 * it once. A larger one runs its statements one at a time as they are made, as before, so it never holds more than
	 * about that much of them, or sends it, at once.
	 */
	/** Writes the session's row and its entries as the transaction's last calls: the body makes none after them. */
	private async writeEntries(
		tx: SqliteExecutor,
		summary: SqliteStatement,
		entries: Iterable<SqliteStatement>,
	): Promise<void> {
		const batch: SqliteStatement[] = [summary];
		let bytes = statementBytes(summary);
		const pending = entries[Symbol.iterator]();
		for (let next = pending.next(); next.done !== true; next = pending.next()) {
			batch.push(next.value);
			bytes += statementBytes(next.value);
			if (bytes <= STATEMENT_BATCH_BYTES) continue;
			for (const { sql, params } of batch) await tx.run(sql, ...params);
			for (let rest = pending.next(); rest.done !== true; rest = pending.next())
				await tx.run(rest.value.sql, ...rest.value.params);
			return;
		}
		// The transaction's last writes: where its connection is pipelined, they go out with its commit.
		if (transactionFinisher(tx)?.(batch) === true) return;
		await statementBatch(tx, batch, []);
	}

	private encode(value: SessionRecordHeader | SessionEntry | StoredSummaryState | string): string {
		try {
			return JSON.stringify(value);
		} catch (cause) {
			throw new StorageUnavailableError(this.descriptor, cause as Error);
		}
	}
}

const nativeLoad = registerArchiveLoad(SqlSessionStore.prototype.load);

type OpenMarkerRow = SqliteRow & { token: string; pid: number; host: string; age_ms: number };

/** A marker of a running session, with the sessions schema and the Atomic version its process recorded. */
export interface SessionOpenMarkerBuild extends SessionOpenMarkerAge {
	readonly sessionId: string;
	/** The newest sessions schema its process reads; undefined for builds before #5065, which record none. */
	readonly schemaVersion?: number;
	/** Its process's Atomic version; undefined for builds before #6560, which record none. */
	readonly build?: string;
}

/**
 * What the switch to shared-history forks did: `enabled`, it raised the sessions schema; `already`, the schema was
 * there; `deferred`, `holders`, running processes of older builds, still have sessions open, and nothing changed.
 */
export type SharedHistoryForksOutcome =
	| { readonly status: "enabled" }
	| { readonly status: "already" }
	| { readonly status: "deferred"; readonly holders: readonly SessionOpenMarkerBuild[] };

/** The markers among `markers` whose processes `live` judges to be running. */
async function liveMarkers(
	markers: readonly SessionOpenMarkerBuild[],
	live: (marker: SessionOpenMarkerBuild) => Promise<boolean>,
): Promise<SessionOpenMarkerBuild[]> {
	const running: SessionOpenMarkerBuild[] = [];
	for (const marker of markers) if (await live(marker)) running.push(marker);
	return running;
}

/** The running sessions that have a SQL store's sessions open, in a table every host sharing the store reads (#4971). */
class SqlSessionOpenMarkers implements SessionOpenMarkerStore {
	/** A new table already has the columns the later steps add, so on a new database they find them and alter nothing. */
	static async createTable(tx: SqliteExecutor, dialect: StorageDialect, table: string): Promise<void> {
		const { int, text } = dialect.types;
		await tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table} (
				session_id ${text} NOT NULL, token ${text} NOT NULL, pid ${int} NOT NULL, host ${text} NOT NULL,
				heartbeat_at ${int} NOT NULL, schema_version ${int}, build ${text}, PRIMARY KEY(session_id, token)
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

	/**
	 * Each marker records the Atomic version of its process, so a command refused while older processes run names the
	 * version each must be upgraded from (#6560). Null for markers of builds before it. Additive.
	 */
	static async addBuild(tx: SqliteExecutor, dialect: StorageDialect, table: string): Promise<void> {
		const probe = dialect.columnExists(table, "build");
		if ((await tx.get(probe.sql, ...probe.params)) === undefined)
			await tx.exec(`ALTER TABLE ${table} ADD COLUMN build ${dialect.types.text}`);
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
			`INSERT INTO ${this.table} (session_id, token, pid, host, heartbeat_at, schema_version, build) VALUES (?, ?, ?, ?, ${now}, ?, ?)
			 ON CONFLICT(session_id, token) DO UPDATE SET pid = excluded.pid, host = excluded.host,
			 heartbeat_at = excluded.heartbeat_at, schema_version = excluded.schema_version, build = excluded.build`,
			sessionId,
			marker.token,
			marker.pid,
			marker.host,
			SESSION_SCHEMA_VERSION,
			marker.build ?? null,
		);
	}

	/**
	 * The markers, through `tx`, of processes that do not read sessions schema `version`: those that record an older
	 * one, and those of builds that record none.
	 */
	async olderThan(tx: SqliteExecutor, version: number): Promise<readonly SessionOpenMarkerBuild[]> {
		const now = dialectOf(this.database).nowMs;
		const rows = await tx.all<
			OpenMarkerRow & { session_id: string; schema_version: number | null; build: string | null }
		>(
			`SELECT session_id, token, pid, host, ${now} - heartbeat_at AS age_ms, schema_version, build FROM ${this.table}
			 WHERE schema_version IS NULL OR schema_version < ? ORDER BY host, pid, session_id`,
			version,
		);
		return rows.map((row) => ({
			sessionId: row.session_id,
			token: row.token,
			pid: Number(row.pid),
			host: row.host,
			ageMs: Number(row.age_ms),
			schemaVersion: row.schema_version === null ? undefined : Number(row.schema_version),
			build: row.build ?? undefined,
		}));
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
