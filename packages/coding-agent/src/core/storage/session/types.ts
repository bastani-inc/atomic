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
	/** The parent ID refers to the source store, not necessarily a session that can be opened in this store. */
	readonly parentInOtherStore?: true;
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
	readonly adjacent?: { readonly older?: string; readonly newer?: string; readonly current?: string };
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
	/** At most this many entries per page (and never more than SESSION_HISTORY_PAGE_ENTRIES). */
	readonly limit?: number;
	readonly signal?: AbortSignal;
	/**
	 * For a scan that consumes every page at once, such as an export: up to this many entries a page, at most
	 * `SESSION_HISTORY_SCAN_ENTRIES`, still within `SESSION_HISTORY_PAGE_BYTES`, and one branch span read for each
	 * contiguous run of the branch. The pages hold the same entries in the same order. Default
	 * `SESSION_HISTORY_PAGE_ENTRIES`.
	 */
	readonly pageEntries?: number;
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
export interface ChildDisplayLaunch {
	readonly launchLeafId?: string | null;
	readonly launchLeafSeq?: number;
	readonly forked?: boolean;
}
export interface ChildDisplayCut {
	readonly epoch: string;
	readonly through: number;
	readonly leaf: number;
	readonly from: number;
	readonly earlier: readonly number[];
	readonly model?: true;
	readonly boundary?: number;
	readonly covered?: number;
}

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

/**
 * The entries a scan reads for a reader that needs only tool calls and results, as an HTML export's renderer inputs
 * pass does: every tool result message, every assistant message with a tool call whose name is not in `exceptCalls`,
 * and every entry larger than a page. A store may return more entries than these, in order, never fewer.
 */
export interface SessionToolUseSelection {
	readonly exceptCalls: readonly string[];
}

/** How a scan reads its pages, for a reader that consumes every page at once, such as an export (#5571). */
export interface SessionScanOptions {
	/** Only the entries it selects count, besides every entry larger than a page. */
	readonly select?: SessionToolUseSelection;
	/** A run of entries also ends with the entry larger than a page that follows it, as a reference. */
	readonly trailingReference?: boolean;
	/** The first this many bytes of each referenced entry's JSON, in `SessionScanPage.prefixes`. */
	readonly referencePrefix?: number;
}

/** A page of a forward scan with the session's header, generation and watermark, all from one read. */
export interface SessionScanPage {
	readonly header: SessionRecordHeader;
	readonly epoch: string;
	readonly lastSeq: number;
	/** The last sequence the page accounts for: its last entry, or a later one when no entry after it up to there was asked for. */
	readonly throughSeq: number;
	readonly items: readonly SessionHistoryItem[];
	/** With `referencePrefix`, the first bytes of each oversized item's JSON, by sequence. */
	readonly prefixes?: ReadonlyMap<number, Uint8Array>;
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

/**
 * A finished subagent's capture its record names, read from a record on the session's active branch before its window:
 * its own session and when that session last captured a checkout, as the record itself says.
 */
export interface ArchivedSubagentCapture {
	readonly ownerSessionId: string;
	readonly childSessionId: string;
	readonly cwd: string;
	readonly worktreeCapturedAt: string;
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
	/*
	 * #6168: a resumed window can hold an entry for another reason without the entry that took it. Each list names only
	 * entries the window holds, and is absent when there are none or the store does not report it.
	 */
	/** Entry ids of the window's protected cards that the active branch already reconciled. */
	readonly reconciledCardIds?: readonly string[];
	/** Ids of the window's saved Intercom arrivals that the active branch already took: shown, received or handled. */
	readonly intercomTakenIds?: readonly string[];
	/** Ids of the window's Intercom asks to this session that the active branch already answered or closed. */
	readonly answeredInboundIds?: readonly string[];
}

export interface SessionForkWindow {
	readonly header: SessionRecordHeader;
	readonly entries: SessionEntry[];
	readonly labels: LabelEntry[];
	readonly lastSeq: number;
	readonly epoch?: string;
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
/**
 * Per-axis provenance of the active branch's latest setting entry (`model_change` or `thinking_level_change`) in a
 * {@link SessionResume} window:
 * - `"held"`: the latest on-branch entry of that axis is at `seq` and appears on the returned branch/state.
 * - `"none"`: the active branch has no entry of that axis anywhere in the session up to this leaf.
 * - `"not-held"`: the resume plan or store did not retain this axis for the pre-window prefix.
 */
export type SessionResumeRetainedSetting =
	| { readonly status: "held"; readonly seq: number }
	| { readonly status: "none" }
	| { readonly status: "not-held" };

/** Per-axis latest-setting retention provenance carried by a {@link SessionResume}. */
export interface SessionResumeRetainedSettings {
	readonly model: SessionResumeRetainedSetting;
	readonly thinkingLevel: SessionResumeRetainedSetting;
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
	/**
	 * Per-axis retention provenance for the active branch's latest `model_change` and `thinking_level_change` entries.
	 * Optional for older or custom stores; when absent, the manager preserves pre-existing retention assumptions, and
	 * only an explicit `"not-held"` (or contradictory provenance) reports an axis as not held.
	 */
	readonly retainedSettings?: SessionResumeRetainedSettings;
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

/** The most candidates one task-reference duplicate query takes. */
export const SESSION_TASK_REFERENCE_CANDIDATES = 100;
/** The most earlier sequences one task-reference duplicate page returns. */
export const SESSION_TASK_REFERENCE_DUPLICATES_PAGE = 64;

/**
 * A task reference saved at `seq`: the entry itself (`<entry id>`), or one content block of it
 * (`<entry id>:<contentIndex>`). The store reads the entry ID at `seq` itself, so the caller never sends one.
 */
export interface SessionTaskReferenceCandidate {
	/** The stored sequence of the entry the reference was read from. */
	readonly seq: number;
	/** The content block the reference names; absent for a reference to the entry itself. */
	readonly contentIndex?: number;
	/**
	 * For a reference to the entry itself, the length of its ID's ASCII `:<digits>` suffix, when it has one: an earlier
	 * entry whose ID is the rest names the same reference through that content block. Ignored with `contentIndex`.
	 */
	readonly suffixChars?: number;
}

export interface SessionTaskReferenceDuplicateQuery {
	/** The epoch the candidates were read in; another epoch is a `SessionConflictError`. */
	readonly epoch: string;
	/**
	 * The watermark the candidates were read at. Every candidate's `seq` is at most this. Entries appended after it are
	 * allowed; a store whose history ends before it, or which has no entry at a candidate's `seq`, conflicts.
	 */
	readonly throughSeq: number;
	/** Only earlier sequences after this one: the previous page's `nextAfterSeq`. Default 0. */
	readonly afterSeq?: number;
	/** At most {@link SESSION_TASK_REFERENCE_CANDIDATES}. */
	readonly candidates: readonly SessionTaskReferenceCandidate[];
	/** At most, and by default, {@link SESSION_TASK_REFERENCE_DUPLICATES_PAGE}. */
	readonly limit?: number;
}

export interface SessionTaskReferenceDuplicatePage {
	/**
	 * Ascending and distinct: each sequence before some candidate's `seq` whose entry may name the same reference, by
	 * its entry ID alone. The entry's kind and blocks are not checked: the caller verifies each one.
	 */
	readonly seqs: readonly number[];
	/** Present when more sequences follow: the `afterSeq` of the next page. */
	readonly nextAfterSeq?: number;
}

export interface SessionForkRow {
	/** Metadata for the listing and the resume index; the exact bytes come from the reference when present. */
	readonly entry: SessionEntry;
	readonly reference?: OversizedSessionEntry;
	readonly edits?: Readonly<Record<string, string | null>>;
	readonly extraToolCalls?: number;
	readonly inlineSnapshot?: true;
}
export interface SessionForkStream {
	/** A whole saved session in append order, with sibling branches and labels unchanged. */
	readonly kind?: "complete-session";
	/** The reader is bound to the writing transaction when both sides use the same SQL connection. */
	read(
		reader: SessionStore,
		hasWritten: (id: string) => Promise<boolean>,
		inlineSnapshot?: (ref: OversizedSessionEntry) => Promise<SessionEntry | undefined>,
	): AsyncIterable<SessionForkRow>;
}
export type SessionForkSeed = readonly SessionEntry[] | SessionForkStream;

export interface ForkArchiveSource {
	readonly store: SessionStore;
	readonly sessionId: string;
	readonly epoch?: string;
	readonly hashes: readonly string[];
	/** Source positions of archived receipts. The entries supplied to createFork contain only their identifying fields. */
	readonly receipts: ReadonlyMap<string, OversizedSessionEntry>;
}

export interface SessionStore {
	readonly descriptor: StorageDescriptor;
	/** Resolve an expanded child card's saved branch and launch boundary without opening its runtime. */
	readChildDisplayCut?(sessionId: string, launch: ChildDisplayLaunch): Promise<ChildDisplayCut>;
	/** Create a new child, substituting the original encoded receipt bytes at the marked entry positions.
	 * Return undefined, without publishing anything, when this source or destination is not supported. */
	createFork?(
		header: SessionRecordHeader,
		entries: SessionForkSeed,
		source: ForkArchiveSource,
		location?: string,
	): Promise<(SessionWriteResult & { readonly remainingBlobs?: readonly string[] }) | undefined>;
	/** Optional reader-only chat data, owned by a particular incarnation of a session, outside its conversation tree. */
	readonly chatRecords?: import("./chat-records.js").SessionChatRecords;
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
	/**
	 * Metadata only; a historical page is sized before any entry is decoded. Returns at most
	 * `SESSION_HISTORY_PAGE_ENTRIES` sizes, or up to `limit` (at most `SESSION_HISTORY_SCAN_ENTRIES`) for a scan.
	 */
	readEntrySizes?(sessionId: string, startSeq: number, endSeq: number, limit?: number): Promise<SessionEntrySizes>;
	/**
	 * One page of a forward scan of generation `epoch` (of the current one when it is undefined, so an empty range reads
	 * the session's head) in a single read, which is its own snapshot: the longest run of
	 * entries from `startSeq` through at most `endSeq` of at most `limit` entries (at most `SESSION_HISTORY_SCAN_ENTRIES`)
	 * and `SESSION_HISTORY_PAGE_BYTES` bytes, or the entry at `startSeq` alone as an oversized reference when it is
	 * larger, with the session's watermark. Rejects with `SessionConflictError` when the session is of another generation.
	 * `options` select entries, end a run with the reference that follows it, or return each reference's first bytes, so
	 * a reader that consumes every page at once makes fewer reads and receives only what it uses. A store whose reads are round
	 * trips implements it so a scan costs one read a page, not a size read and a range read in transactions of their own
	 * (#5571).
	 */
	readScanPage?(
		sessionId: string,
		startSeq: number,
		endSeq: number,
		epoch: string | undefined,
		limit: number,
		options?: SessionScanOptions,
	): Promise<SessionScanPage>;
	/**
	 * Read at most `bytes` (`SESSION_HISTORY_CHUNK_BYTES` when absent, at most `SESSION_HISTORY_PAGE_BYTES`; a store may
	 * return fewer, never none before the end), rejecting a reference to a replaced generation.
	 */
	readEntryChunk?(reference: OversizedSessionEntry, offset: number, bytes?: number): Promise<Uint8Array>;

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
	/** Read the branch a forked child needs at its captured entry, with the current labels for copied targets. */
	readForkWindow?(
		sessionId: string,
		entryId: string,
		options?: { readonly archivedReceipts: true },
	): Promise<SessionForkWindow | undefined>;
	readResumeAt?(
		sessionId: string,
		leafId: string,
		throughSeq: number,
		options?: { deferChildRecords: true },
	): Promise<SessionResume>;
	findEntrySeq?(sessionId: string, entryId: string): Promise<number | undefined>;
	/**
	 * Earlier entries that may save the same task reference as each candidate, found through the store's entry-ID index
	 * without reading or sending entry bodies or IDs. Resolves with `undefined` when the store cannot answer from an
	 * index now; the caller then verifies candidates from entry metadata itself. Absent when the store never can.
	 */
	findTaskReferenceDuplicateCandidates?(
		sessionId: string,
		query: SessionTaskReferenceDuplicateQuery,
	): Promise<SessionTaskReferenceDuplicatePage | undefined>;
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
