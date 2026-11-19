import type { Usage } from "@bastani/atomic-ai/compat";
import type {
	CompactionEntry,
	LabelEntry,
	SessionEntry,
	SessionWorkflowMetadata,
} from "../../session-manager-types.ts";
import type { SnapshotBlobStore } from "../../worktree-snapshot/types.ts";

export const SESSION_FORMAT_VERSION = 4;

/** Yield between archive pages, including in browser-backed custom stores. */
export function yieldSessionTurn(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof setImmediate === "function") setImmediate(resolve);
		else setTimeout(resolve, 0);
	});
}

/** @internal Platform-owned stores inject filesystem identity without coupling portable adapters to it. */
export type SessionCwdMatcher = (cwd: string) => (candidate: string | undefined) => boolean | Promise<boolean>;

export interface StorageDescriptor {
	readonly adapter: string;
	readonly location: string;
	/** Non-default SQL table prefix, when the store uses one. */
	readonly prefix?: string;
}

export interface SessionRecordHeader {
	readonly id: string;
	readonly version: typeof SESSION_FORMAT_VERSION;
	readonly createdAt: string;
	readonly cwd: string;
	readonly parentSessionId?: string;
	readonly internal?: true;
	readonly workflow?: SessionWorkflowMetadata;
}

export interface SessionSnapshot {
	readonly epoch?: string;
	readonly header: SessionRecordHeader;
	/** Entries in append order; the last entry is the leaf on reopen. */
	readonly entries: readonly SessionEntry[];
	readonly lastSeq: number;
}

export interface SessionUsageTotals {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
}

export interface SessionHistoryTotals {
	readonly auxiliary?: SessionUsageTotals;
	readonly assistant: SessionUsageTotals;

	readonly toolResult: SessionUsageTotals;

	readonly summaries: SessionUsageTotals;
	readonly userMessages: number;
	readonly assistantMessages: number;
	readonly toolResults: number;
	readonly totalMessages: number;
	readonly toolCalls: number;

	readonly latestAssistantUsage?: Usage;
	readonly latestAssistantSeq?: number;
}

export interface SessionStoredEntry {
	readonly seq: number;
	readonly entry: SessionEntry;
}

export const SESSION_HISTORY_PAGE_BYTES = 1024 * 1024;
export const SESSION_HISTORY_CHUNK_BYTES = 64 * 1024;
export const SESSION_HISTORY_PAGE_ENTRIES = 64;
/** The most entries a scan that consumes every page at once, such as an export, may ask for in one page. */
export const SESSION_HISTORY_SCAN_ENTRIES = 4096;

/** How many sizes one `readEntrySizes` call returns: `SESSION_HISTORY_PAGE_ENTRIES` unless a scan asks for more. */
export function entrySizeLimit(limit: number | undefined): number {
	return limit === undefined || !Number.isSafeInteger(limit)
		? SESSION_HISTORY_PAGE_ENTRIES
		: Math.min(SESSION_HISTORY_SCAN_ENTRIES, Math.max(1, limit));
}

/** A stored entry too large for a history page. Its exact bytes are available in chunks, not a truncated entry. */
export interface OversizedSessionEntry {
	readonly kind: "oversized";
	readonly sessionId: string;
	readonly epoch: string;
	readonly seq: number;
	readonly bytes: number;
}

export type SessionHistoryItem = SessionStoredEntry | OversizedSessionEntry;

export interface SessionHistoryPage {
	readonly items: readonly SessionHistoryItem[];
	readonly nextCursor?: string;
	/** Adjacent ranges in the original snapshot, when the read requested them. */
	readonly adjacent?: { readonly older?: string; readonly newer?: string };
}

export interface SessionHistoryReadOptions {
	/** Order in which pages are visited. The entries within each page always remain chronological. */
	readonly direction?: "forward" | "backward";
	/** Include cursors to read in either direction without keeping earlier pages or a cursor stack. */
	readonly adjacent?: boolean;
	/** Only entries on the path from this stored sequence to the root, including history before compaction. */
	readonly branchLeafSeq?: number;
	readonly fromSeq?: number;
	readonly toSeq?: number;
	readonly cursor?: string;
	readonly signal?: AbortSignal;
}

export interface SessionBranchPageCut {
	readonly leaf: number;
	readonly first: number;
	readonly last: number;
	readonly pivot: number;
	readonly backward: boolean;
	readonly epoch?: string;
}

export interface SessionBranchSpan {
	readonly start: number;
	readonly end: number;
	readonly older: boolean;
	readonly newer: boolean;
}

/** Body-free navigation record. The original entry and any long label stay at their sequence in the store. */
export interface SessionTreeOutlineEntry {
	readonly seq: number;
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
	readonly type: SessionEntry["type"];
	readonly role?: string;
	readonly hideAssistant?: boolean;
	/** Addresses only; the arguments for a visible result are read from its call on demand. */
	readonly callIds?: readonly string[];
	readonly leafMove?: boolean;
	readonly childRecord?: boolean;
	readonly labelTarget?: string;
	readonly label?: string;
}

export interface SessionEntrySizes {
	readonly epoch: string;
	readonly lastSeq: number;
	readonly sizes: readonly { readonly seq: number; readonly bytes: number }[];
}

export interface SessionStateEntry extends SessionStoredEntry {
	readonly onBranch: boolean;
}

export interface SessionTail {
	readonly epoch?: string;
	readonly seqs?: readonly number[];
	readonly lastEntryId?: string | null;
	readonly header: SessionRecordHeader;
	readonly fromSeq: number;

	readonly entries: readonly SessionEntry[];

	readonly state: readonly SessionStateEntry[];

	readonly omitted: SessionHistoryTotals;
	readonly lastSeq: number;
}

export interface SessionEntryRange {
	readonly epoch?: string;
	readonly seqs?: readonly number[];
	readonly lastEntryId?: string | null;
	readonly startSeq: number;

	readonly entries: readonly SessionEntry[];
	readonly lastSeq: number;
}

export interface SessionCompactionPoint {
	readonly entry: CompactionEntry;
	readonly seq: number;

	readonly firstKeptSeq?: number;

	readonly coveredThroughSeq?: number;

	readonly retainedStartSeq: number;

	readonly leafId: string;
	readonly lastSeq: number;
}

/** Body-free child state for launch cards and explicit action lookup. Full launch, held messages and results
 * are fetched from the saved observation only if the child is explicitly opened or continued. */
export interface ArchivedChildCatalogEntry {
	readonly firstSeq: number;
	readonly entryId: string;
	/** A later resident observation already covers every field of the archived record. Preserve historical task aliases, but do not reread the earlier payload. */
	readonly coveredBy?: string;
	readonly childId: string;
	readonly ownerSessionId: string;
	readonly runId: string;
	readonly index: number;
	readonly agent: string;
	readonly cwd: string;
	readonly state: "running" | "terminal";
	readonly terminalStatus?: string;
	readonly taskId?: string;
	readonly taskIds: readonly string[];
	readonly releasedTaskIds?: readonly string[];
	readonly childSessionId?: string;
	readonly childSessionFile?: string;
	readonly intercomTarget?: string;
	readonly intercomGroup?: string;
	readonly releasedIntercomId?: string;
	readonly managedWorktree?: boolean;
	readonly elapsedMs?: number;
	readonly elapsedSpan?: { dispatchedAt: number; endedAt?: number } | null;
}

export interface SessionRecoveryState {
	readonly workflowStarts?: Readonly<Record<string, number>>;
	/** Sorted, packed 128-bit admission-key digests, encoded as base64. Does not expose original keys. */
	readonly admissionDigests: string;
	readonly intercomDeliveredIds: readonly string[];
	readonly deliveryOpIds?: readonly string[];
}

export interface SessionChildAliases {
	readonly taskIds: readonly string[];
	readonly releasedTaskIds: readonly string[];
	readonly lastTask?: string;
	readonly lastStatus?: string;
}
export interface SessionChildReadCut {
	readonly epoch: string;
	readonly lastSeq: number;
	readonly seqs: readonly number[];
	readonly aliases: Readonly<Record<string, SessionChildAliases>>;
}
export interface SessionForkWindow {
	readonly header: SessionRecordHeader;
	readonly entries: SessionEntry[];
	readonly labels: LabelEntry[];
	readonly lastSeq: number;
	readonly epoch?: string;
}

/** Where a session's `worktree_snapshot` entries are, as the store's index of its history locates them (#5554). */
export interface SessionSnapshotCut {
	readonly epoch: string;
	readonly lastSeq: number;
	/** The latest entry carrying each snapshot record, by snapshot id, on any branch. */
	readonly records: Readonly<Record<string, number>>;
	/**
	 * In ascending order, every entry that can be a `worktree_snapshot` entry, on the requested branch when one was: a
	 * superset, so a reader keeps the entries whose type is.
	 */
	readonly seqs: readonly number[];
}
export interface SessionResume {
	readonly header: SessionRecordHeader;
	readonly lastSeq: number;
	readonly lastEntryId: string | null;
	readonly epoch: string;
	readonly leafId: string | null;
	readonly compaction?: SessionCompactionPoint;
	readonly branch: readonly SessionStoredEntry[];
	readonly state: readonly SessionStateEntry[];
	readonly omitted: SessionHistoryTotals;
	readonly recovery: SessionRecoveryState;
	/** Returned only on a manager's opt-in metadata read. Inspect these child headings before fetching a
	 * historical payload; an active child may need it on resume, a completed one does not. */
	readonly deferredChildren?: {
		readonly positions: readonly { seq: number; onBranch: boolean }[];
		readonly aliases: Readonly<Record<string, SessionChildAliases>>;
	};
}

export interface SessionSummary {
	readonly id: string;
	readonly cwd: string;
	readonly parentSessionId?: string;
	readonly internal: boolean;
	readonly workflow?: SessionWorkflowMetadata;
	readonly name?: string;
	readonly hasName: boolean;
	readonly createdAt: string;
	readonly modifiedAt: string;
	readonly messageCount: number;
	readonly firstMessage: string;
	readonly summary?: string;
	readonly summarizedThroughId?: string;
	readonly searchText: string;
	readonly location?: string;
	readonly estimated?: true;
}

export interface SessionListQuery {
	readonly cwd?: string;
	/** Only sessions whose id starts with this text, compared case-insensitively. */
	readonly idPrefix?: string;
	readonly includeInternal?: boolean;
	readonly withoutSearchText?: boolean;
	readonly signal?: AbortSignal;
}

export function matchesSessionIdPrefix(id: string, prefix: string | undefined): boolean {
	return prefix === undefined || id.toLowerCase().startsWith(prefix.toLowerCase());
}

export interface SessionWriteOptions {
	readonly epoch?: string;
	readonly expectSeq: number;
}

export interface SessionWriteResult {
	readonly lastSeq: number;
	readonly epoch?: string;
}

/** A blob a session holds: the lowercase hex SHA-256 of its bytes, and how many bytes it has. */
export interface SessionBlob {
	readonly hash: string;
	readonly bytes: number;
}

/** A running session's mark that it has a session open (#4971). */
export interface SessionOpenMarker {
	/** Tells apart the processes that mark one session, and a process from an earlier one given the same pid. */
	readonly token: string;
	readonly pid: number;
	readonly host: string;
}

/** A marker as a store lists it. */
export interface SessionOpenMarkerAge extends SessionOpenMarker {
	/**
	 * How long ago, in milliseconds, the marker was last refreshed, by the store's own clock: every host reads one
	 * clock, so a host whose clock is off does not take a live mark for a stale one.
	 */
	readonly ageMs: number;
}

/** Where a store keeps which running sessions have its sessions open, so that every host sharing it sees them (#4971). */
export interface SessionOpenMarkerStore {
	/** Adds `marker` to `sessionId`'s, or refreshes the one with its token, stamped with the store's clock. */
	put(sessionId: string, marker: SessionOpenMarker): Promise<void>;
	/** Removes `sessionId`'s marker with `token`, if there is one. */
	remove(sessionId: string, token: string): Promise<void>;
	/** `sessionId`'s markers, in no particular order. */
	list(sessionId: string): Promise<readonly SessionOpenMarkerAge[]>;
}

export interface SessionEntryAt {
	readonly seq: number;
	readonly entry: SessionEntry;
	readonly rawChunks?: readonly Uint8Array[];
	readonly rawFormatVersion?: number;
}

export interface SessionEntriesQuery {
	readonly fromSeq: number;
	readonly toSeq: number;
	readonly maxChars?: number;
	readonly largeEntryBytes?: number;
	readonly skipTypes?: readonly string[];
	readonly signal?: AbortSignal;
}

export interface SessionEntriesPage {
	readonly lastSeq: number;
	readonly entries: readonly SessionEntryAt[];
	readonly throughSeq: number;
}

export interface SessionSearchText {
	readonly seq: number;
	readonly text?: string;
	readonly parts?: readonly string[];
	readonly oversized?: boolean;
}

export interface SessionSearchCoverage {
	readonly indexedSeq: number;
	readonly lastSeq: number;
	readonly generation?: string;
	readonly revision?: string;
}

export interface SessionSearchExtendOptions {
	readonly generation?: string;
	readonly revision?: string;
	readonly signal?: AbortSignal;
}

export interface SessionSearchIndex {
	coverage(sessionId: string, format: number): Promise<SessionSearchCoverage | undefined>;
	extend(
		sessionId: string,
		format: number,
		afterSeq: number,
		throughSeq: number,
		texts: readonly SessionSearchText[],
		options?: SessionSearchExtendOptions,
	): Promise<boolean>;
	candidates(
		sessionId: string,
		anyOf: readonly (readonly string[])[],
		fromSeq: number,
		toSeq: number,
		limit: number,
		generation?: string,
		signal?: AbortSignal,
	): Promise<readonly number[] | undefined>;
}

export interface SessionStore {
	readonly descriptor: StorageDescriptor;
	/**
	 * Which running sessions have this store's sessions open (#4971). Absent when the store keeps none: markers are then
	 * files under the agent directory, seen only by processes that share it.
	 */
	readonly openMarkers?: SessionOpenMarkerStore;
	/**
	 * Content-addressed blobs for `worktree_snapshot` entries, in the store's own storage. Absent when the store cannot
	 * hold them; snapshots are then not recorded.
	 */
	readonly snapshotBlobs?: SnapshotBlobStore;
	/**
	 * Stores `data` for the session under the SHA-256 of its bytes, apart from its entries, and resolves with that hash
	 * and the size; storing the same bytes again keeps one copy. The blob is deleted with its session. Rejects with
	 * `SessionNotFoundError` when the session does not exist. Absent when the store cannot hold blobs.
	 */
	putBlob?(sessionId: string, data: Uint8Array): Promise<SessionBlob>;
	/** The bytes the session stored under `hash`, or `undefined` when it holds none. Absent with `putBlob`. */
	getBlob?(sessionId: string, hash: string): Promise<Uint8Array | undefined>;
	create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<SessionWriteResult>;
	append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }>;
	replace(
		sessionId: string,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<SessionWriteResult>;
	/** Change the header without materializing its existing entries. Existing readers see a new epoch. */
	updateHeader?(header: SessionRecordHeader, options: SessionWriteOptions): Promise<SessionWriteResult>;
	load(sessionId: string): Promise<SessionSnapshot>;
	readEntryRange?(sessionId: string, query: SessionEntriesQuery): Promise<SessionEntriesPage>;
	readonly searchIndex?: SessionSearchIndex;

	readTail?(sessionId: string, fromSeq: number): Promise<SessionTail>;

	readRange?(sessionId: string, startSeq: number, endSeq: number, expectedEpoch?: string): Promise<SessionEntryRange>;
	/** Project structural metadata for tree navigation; never return a message body or tool arguments. */
	readTreeOutline?(
		sessionId: string,
		fromSeq: number,
		toSeq: number,
		epoch?: string,
	): Promise<readonly (SessionTreeOutlineEntry | { readonly seq: number; readonly streamed: true })[]>;
	/** Locate a contiguous range on the requested branch without reading neighboring conversation bodies. */
	readBranchSpan?(sessionId: string, cut: SessionBranchPageCut): Promise<SessionBranchSpan | undefined>;
	/** Metadata only; a historical page is sized before any entry is decoded. */
	readEntrySizes?(sessionId: string, startSeq: number, endSeq: number): Promise<SessionEntrySizes>;
	/** Read at most SESSION_HISTORY_CHUNK_BYTES, rejecting a reference to a replaced generation. */
	readEntryChunk?(reference: OversizedSessionEntry, offset: number): Promise<Uint8Array>;

	findLatestCompaction?(sessionId: string, leafId?: string): Promise<SessionCompactionPoint | undefined>;
	readResume?(sessionId: string, leafId?: string, options?: { deferChildRecords: true }): Promise<SessionResume>;
	readChildCatalogCut?(sessionId: string): Promise<SessionChildReadCut>;
	/**
	 * Where the session's snapshot entries are, from the index the store keeps of its history, without reading an entry:
	 * with `leafSeq`, only those on the branch from that sequence to the root. Undefined when that index does not cover
	 * the session's history as it stands; a reader then reads the history itself. A store with it reads
	 * `readSelectedPage` with its `limit` and `backward` options.
	 */
	readSnapshotCut?(
		sessionId: string,
		options?: { readonly leafSeq?: number },
	): Promise<SessionSnapshotCut | undefined>;
	/**
	 * The entries at `seqs`, ascending, of generation `epoch`, in ascending order: the longest prefix of them (with
	 * `backward`, suffix) of at most `SESSION_HISTORY_PAGE_ENTRIES` entries (or `limit`, up to
	 * `SESSION_HISTORY_SCAN_ENTRIES`) and `SESSION_HISTORY_PAGE_BYTES` bytes, or its first (last) entry alone as an
	 * oversized reference when that is larger. Rejects with `SessionConflictError` when the session is of another
	 * generation or holds no entry at one of them.
	 */
	readSelectedPage?(
		sessionId: string,
		seqs: readonly number[],
		epoch: string,
		options?: { readonly limit?: number; readonly backward?: boolean },
	): Promise<SessionHistoryPage>;
	/** A local navigation from a stale manager may select a branch as of its original sequence watermark. */
	readResumeAt?(
		sessionId: string,
		leafId: string,
		throughSeq: number,
		options?: { deferChildRecords: true },
	): Promise<SessionResume>;
	/** Read the branch a forked child needs at its captured entry, with the current labels for copied targets. */
	readForkWindow?(sessionId: string, entryId: string): Promise<SessionForkWindow | undefined>;
	findEntrySeq?(sessionId: string, entryId: string): Promise<number | undefined>;
	readHeader(sessionId: string): Promise<SessionRecordHeader | undefined>;
	delete(sessionId: string): Promise<void>;
	list(query: SessionListQuery): AsyncIterable<SessionSummary>;
	findMostRecent(query: {
		readonly cwd: string;
		readonly includeInternal?: boolean;
	}): Promise<SessionSummary | undefined>;
	/**
	 * Nothing live holds the session any more: it was released, and its history is read again only when the session is
	 * reopened. The store may move that history out of process memory until then. A hint that never changes what the
	 * store returns: it does nothing for a session the store does not hold or on a closed store. Absent when the store
	 * keeps nothing in memory to move.
	 */
	releaseSession?(sessionId: string): Promise<void>;
	close(): Promise<void>;
}
