import type { Usage } from "@bastani/atomic-ai/compat";
import type { CompactionEntry, SessionEntry, SessionWorkflowMetadata } from "../../session-manager-types.ts";
import type { SnapshotBlobStore } from "../../worktree-snapshot/types.ts";

export const SESSION_FORMAT_VERSION = 4;

/** @internal Platform-owned stores inject filesystem identity without coupling portable adapters to it. */
export type SessionCwdMatcher = (cwd: string) => (candidate: string | undefined) => boolean;

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
	readonly header: SessionRecordHeader;
	/** Entries in append order; the last entry is the leaf on reopen. */
	readonly entries: readonly SessionEntry[];
	readonly lastSeq: number;
}

/** Token and cost totals, as the session's usage figures add them up. */
export interface SessionUsageTotals {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
}

/** What a set of a session's entries adds to its usage figures and message counts (#5249). */
export interface SessionHistoryTotals {
	/** Usage of assistant messages. */
	readonly assistant: SessionUsageTotals;
	/** Usage tool results report. */
	readonly toolResult: SessionUsageTotals;
	/** Usage of compaction, branch summary and session summary entries. */
	readonly summaries: SessionUsageTotals;
	readonly userMessages: number;
	readonly assistantMessages: number;
	readonly toolResults: number;
	readonly totalMessages: number;
	readonly toolCalls: number;
	/** The usage of the last assistant message among the entries, in store order. */
	readonly latestAssistantUsage?: Usage;
}

/** A session entry and its position in store order, 1 for the first entry (#5249). */
export interface SessionStoredEntry {
	readonly seq: number;
	readonly entry: SessionEntry;
}

/** An entry before a session's tail that holds the session's state (#5249). */
export interface SessionStateEntry extends SessionStoredEntry {
	/** Whether the entry is on the branch the session continues from: its last entry, or the leaf a leaf move recorded. */
	readonly onBranch: boolean;
}

/**
 * What resuming a session reads instead of its whole history (#5249): the header, the entries from `fromSeq` on, and,
 * before them, only the entries that hold the session's state, with what the entries left out add to its usage.
 */
export interface SessionTail {
	readonly header: SessionRecordHeader;
	readonly fromSeq: number;
	/** Entries from `fromSeq` to the last, in store order; none when `fromSeq` is past the last entry. */
	readonly entries: readonly SessionEntry[];
	/**
	 * Entries before `fromSeq`, in store order, that hold the session's state: every entry except messages other than
	 * system messages, compactions, branch summaries and context edits, acknowledged task completions, background
	 * compaction results, and session names and summaries a later one replaced. A store may return more.
	 */
	readonly state: readonly SessionStateEntry[];
	/** What the entries before `fromSeq` that `state` leaves out add to the session's usage and message counts. */
	readonly omitted: SessionHistoryTotals;
	readonly lastSeq: number;
}

/** A session's entries from `startSeq` through an end seq, as far as the session goes (#5249). */
export interface SessionEntryRange {
	readonly startSeq: number;
	/** Entries in store order; none when the range starts past the last entry or ends before it starts. */
	readonly entries: readonly SessionEntry[];
	readonly lastSeq: number;
}

/** The latest compaction boundary on a branch of a session, and where the context it starts holds (#5249). */
export interface SessionCompactionPoint {
	/** The latest compaction whose details say it is a verbatim-lines boundary, on the branch. */
	readonly entry: CompactionEntry;
	readonly seq: number;
	/** The seq of the boundary's first kept entry, when that entry is on the branch before it. */
	readonly firstKeptSeq?: number;
	/** The seq of the last entry the boundary covers, when it names one on the branch before it. */
	readonly coveredThroughSeq?: number;
	/**
	 * The first entry on the branch the session's context replays: the first kept entry, else the entry after the last
	 * covered one, else the boundary itself.
	 */
	readonly retainedStartSeq: number;
	/** The branch's leaf. */
	readonly leafId: string;
	readonly lastSeq: number;
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
}

export interface SessionListQuery {
	readonly cwd?: string;
	/** Only sessions whose id starts with this text, compared case-insensitively. */
	readonly idPrefix?: string;
	readonly includeInternal?: boolean;
	readonly signal?: AbortSignal;
}

export function matchesSessionIdPrefix(id: string, prefix: string | undefined): boolean {
	return prefix === undefined || id.toLowerCase().startsWith(prefix.toLowerCase());
}

export interface SessionWriteOptions {
	readonly expectSeq: number;
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
	create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<{ readonly lastSeq: number }>;
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
	): Promise<{ readonly lastSeq: number }>;
	load(sessionId: string): Promise<SessionSnapshot>;
	/**
	 * The session's header, its entries from `fromSeq` (at least 1) on, and the entries before them that hold its state
	 * (#5249). Rejects with `SessionNotFoundError` when the session does not exist. Absent on a store that only loads
	 * whole sessions; resuming one then loads it whole.
	 */
	readTail?(sessionId: string, fromSeq: number): Promise<SessionTail>;
	/**
	 * The session's entries from `startSeq` (at least 1) through `endSeq`, as far as the session goes (#5249). Rejects
	 * with `SessionNotFoundError` when the session does not exist. Absent with `readTail`.
	 */
	readRange?(sessionId: string, startSeq: number, endSeq: number): Promise<SessionEntryRange>;
	/**
	 * The latest compaction boundary on the branch to `leafId`, by default the branch the session continues from, or
	 * undefined when the branch has none or `leafId` is not an entry of the session (#5249). Rejects with
	 * `SessionNotFoundError` when the session does not exist. Absent with `readTail`.
	 */
	findLatestCompaction?(sessionId: string, leafId?: string): Promise<SessionCompactionPoint | undefined>;
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
