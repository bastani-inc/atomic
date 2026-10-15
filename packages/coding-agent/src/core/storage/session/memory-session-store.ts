import type { SessionEntry } from "@bastani/atomic";
import {
	SessionConflictError,
	SessionExistsError,
	SessionNotFoundError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";
import { summarizeSession } from "./session-summary.js";
import type {
	SessionListQuery,
	SessionRecordHeader,
	SessionSnapshot,
	SessionStore,
	SessionSummary,
	SessionWriteOptions,
	StorageDescriptor,
} from "./types.js";
import { validateSessionEntries, validateSessionHeader, validateSessionText } from "./validation.js";

export class MemorySessionStore implements SessionStore {
	private records = new Map<string, string>();
	private closed = false;

	get descriptor(): StorageDescriptor {
		return { adapter: "memory", location: ":memory:" };
	}

	async create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<{ readonly lastSeq: number }> {
		this.assertOpen();
		validateSessionHeader(header);
		validateSessionEntries(entries);
		if (this.records.has(header.id)) throw new SessionExistsError(header.id);
		this.records.set(header.id, this.encode({ header, entries, lastSeq: entries.length }));
		return { lastSeq: entries.length };
	}

	async append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		const previous = this.forWrite(sessionId, options);
		validateSessionEntries(entries);
		const lastSeq = previous.lastSeq + entries.length;
		this.records.set(
			sessionId,
			this.encode({ header: previous.header, entries: [...previous.entries, ...entries], lastSeq }),
		);
		return { lastSeq };
	}

	async replace(
		sessionId: string,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		this.forWrite(sessionId, options);
		validateSessionHeader(header);
		validateSessionEntries(entries);
		this.records.set(sessionId, this.encode({ header, entries, lastSeq: entries.length }));
		return { lastSeq: entries.length };
	}

	async load(sessionId: string): Promise<SessionSnapshot> {
		const snapshot = this.read(sessionId);
		if (!snapshot) throw new SessionNotFoundError(sessionId);
		return snapshot;
	}

	async readHeader(sessionId: string): Promise<SessionRecordHeader | undefined> {
		return this.read(sessionId)?.header;
	}

	async delete(sessionId: string): Promise<void> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		this.records.delete(sessionId);
	}

	async *list(query: SessionListQuery): AsyncIterable<SessionSummary> {
		this.assertOpen();
		if (query.signal?.aborted) throw new DOMException("Session listing aborted", "AbortError");
		for (const record of this.records.values()) {
			this.assertOpen();
			if (query.signal?.aborted) throw new DOMException("Session listing aborted", "AbortError");
			const snapshot = JSON.parse(record) as SessionSnapshot;
			if (query.cwd !== undefined && query.cwd !== snapshot.header.cwd) continue;
			if (!query.includeInternal && snapshot.header.internal) continue;
			yield summarizeSession(snapshot);
		}
		this.assertOpen();
		if (query.signal?.aborted) throw new DOMException("Session listing aborted", "AbortError");
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
	}

	async reopen(): Promise<MemorySessionStore> {
		const store = new MemorySessionStore();
		store.records = this.records;
		return store;
	}

	private assertOpen(): void {
		if (this.closed) throw new StoreClosedError(this.descriptor);
	}

	private read(sessionId: string): SessionSnapshot | undefined {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const record = this.records.get(sessionId);
		return record === undefined ? undefined : (JSON.parse(record) as SessionSnapshot);
	}

	private forWrite(sessionId: string, options: SessionWriteOptions): SessionSnapshot {
		const snapshot = this.read(sessionId);
		if (!snapshot) throw new SessionNotFoundError(sessionId);
		if (options.expectSeq !== snapshot.lastSeq) {
			throw new SessionConflictError(sessionId, options.expectSeq, snapshot.lastSeq);
		}
		return snapshot;
	}

	private encode(snapshot: SessionSnapshot): string {
		try {
			return JSON.stringify(snapshot);
		} catch (cause) {
			throw new StorageUnavailableError(this.descriptor, cause as Error);
		}
	}
}
