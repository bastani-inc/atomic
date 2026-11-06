import type { SessionEntry } from "../../session-manager-types.ts";
import {
	SessionConflictError,
	SessionExistsError,
	SessionIdMismatchError,
	SessionNotFoundError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";
import { summarizeSession } from "./session-summary.js";
import type {
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

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
const COMMA = 0x2c;
const NO_ENTRIES = new Uint8Array(0);

interface StoredSession {
	readonly header: Uint8Array;
	readonly entries: Uint8Array[];
	lastSeq: number;
}

const privateStores = new WeakSet<MemorySessionStore>();

/** Mark a store as private to one session manager: nothing else holds it, so its history is gone once that manager is. */
export function markPrivateMemorySessionStore(store: MemorySessionStore): MemorySessionStore {
	privateStores.add(store);
	return store;
}

/** Whether this store is one session manager's own in-memory store, as `SessionManager.inMemory()` creates. */
export function isPrivateMemorySessionStore(store: SessionStore): boolean {
	return store instanceof MemorySessionStore && privateStores.has(store);
}

/**
 * Sessions held in process memory. Each record is kept as UTF-8 JSON bytes, not a string: one character outside
 * Latin-1 makes the engine store a whole string at two bytes per character, which would double every idle agent's
 * history (#4326). An append encodes only the entries it adds, and a load joins what was appended since the last one.
 */
export class MemorySessionStore implements SessionStore {
	private records = new Map<string, StoredSession>();
	private closed = false;

	private readonly cwdMatcher?: SessionCwdMatcher;

	constructor(cwdMatcher?: SessionCwdMatcher) {
		this.cwdMatcher = cwdMatcher;
	}

	get descriptor(): StorageDescriptor {
		return { adapter: "memory", location: ":memory:" };
	}

	async create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<{ readonly lastSeq: number }> {
		this.assertOpen();
		validateSessionHeader(header);
		validateSessionEntries(entries);
		if (this.records.has(header.id)) throw new SessionExistsError(header.id);
		this.records.set(header.id, this.encodeSession(header, entries));
		return { lastSeq: entries.length };
	}

	async append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		const record = this.forWrite(sessionId, options);
		validateSessionEntries(entries);
		if (entries.length > 0) record.entries.push(this.encodeEntries(entries));
		record.lastSeq += entries.length;
		return { lastSeq: record.lastSeq };
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
		if (header.id !== sessionId) throw new SessionIdMismatchError(sessionId, header.id);
		this.records.set(sessionId, this.encodeSession(header, entries));
		return { lastSeq: entries.length };
	}

	async load(sessionId: string): Promise<SessionSnapshot> {
		const snapshot = this.read(sessionId);
		if (!snapshot) throw new SessionNotFoundError(sessionId);
		return snapshot;
	}

	async readHeader(sessionId: string): Promise<SessionRecordHeader | undefined> {
		const record = this.stored(sessionId);
		return record === undefined ? undefined : (JSON.parse(utf8Decoder.decode(record.header)) as SessionRecordHeader);
	}

	async delete(sessionId: string): Promise<void> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		this.records.delete(sessionId);
	}

	async *list(query: SessionListQuery): AsyncIterable<SessionSummary> {
		this.assertOpen();
		query.signal?.throwIfAborted();
		const matchesCwd =
			query.cwd === undefined
				? undefined
				: (this.cwdMatcher?.(query.cwd) ?? ((candidate: string | undefined) => candidate === query.cwd));
		for (const record of this.records.values()) {
			this.assertOpen();
			query.signal?.throwIfAborted();
			const snapshot = this.decode(record);
			if (matchesCwd && !matchesCwd(snapshot.header.cwd)) continue;
			if (!query.includeInternal && snapshot.header.internal) continue;
			yield summarizeSession(snapshot);
		}
		this.assertOpen();
		query.signal?.throwIfAborted();
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
		const store = new MemorySessionStore(this.cwdMatcher);
		store.records = this.records;
		return store;
	}

	private assertOpen(): void {
		if (this.closed) throw new StoreClosedError(this.descriptor);
	}

	private stored(sessionId: string): StoredSession | undefined {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		return this.records.get(sessionId);
	}

	private read(sessionId: string): SessionSnapshot | undefined {
		const record = this.stored(sessionId);
		return record === undefined ? undefined : this.decode(record);
	}

	private forWrite(sessionId: string, options: SessionWriteOptions): StoredSession {
		const record = this.stored(sessionId);
		if (!record) throw new SessionNotFoundError(sessionId);
		if (options.expectSeq !== record.lastSeq) {
			throw new SessionConflictError(sessionId, options.expectSeq, record.lastSeq);
		}
		return record;
	}

	private decode(record: StoredSession): SessionSnapshot {
		return {
			header: JSON.parse(utf8Decoder.decode(record.header)) as SessionRecordHeader,
			entries: JSON.parse(`[${utf8Decoder.decode(joinEntries(record))}]`) as SessionEntry[],
			lastSeq: record.lastSeq,
		};
	}

	private encodeSession(header: SessionRecordHeader, entries: readonly SessionEntry[]): StoredSession {
		return {
			header: this.encode(() => JSON.stringify(header)),
			entries: entries.length === 0 ? [] : [this.encodeEntries(entries)],
			lastSeq: entries.length,
		};
	}

	private encodeEntries(entries: readonly SessionEntry[]): Uint8Array {
		return this.encode(() => JSON.stringify(entries).slice(1, -1));
	}

	private encode(text: () => string): Uint8Array {
		try {
			return utf8Encoder.encode(text());
		} catch (cause) {
			throw new StorageUnavailableError(this.descriptor, cause as Error);
		}
	}
}

function joinEntries(record: StoredSession): Uint8Array {
	if (record.entries.length <= 1) return record.entries[0] ?? NO_ENTRIES;
	let size = record.entries.length - 1;
	for (const chunk of record.entries) size += chunk.byteLength;
	const joined = new Uint8Array(size);
	let offset = 0;
	for (const [index, chunk] of record.entries.entries()) {
		if (index > 0) joined[offset++] = COMMA;
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	record.entries.splice(0, record.entries.length, joined);
	return joined;
}
