import type { SessionEntry, SessionWorkflowMetadata } from "../../session-manager-types.ts";

export const SESSION_FORMAT_VERSION = 4;

export interface StorageDescriptor {
	readonly adapter: string;
	readonly location: string;
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
	readonly includeInternal?: boolean;
	readonly signal?: AbortSignal;
}

export interface SessionWriteOptions {
	readonly expectSeq: number;
}

export interface SessionStore {
	readonly descriptor: StorageDescriptor;
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
	close(): Promise<void>;
}
