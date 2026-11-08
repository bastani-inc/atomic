import type { SessionEntry, SessionWorkflowMetadata } from "../../session-manager-types.ts";
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

export interface SessionStore {
	readonly descriptor: StorageDescriptor;
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
