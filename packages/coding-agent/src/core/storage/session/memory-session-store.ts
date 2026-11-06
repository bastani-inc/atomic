import type { SessionEntry } from "../../session-manager-types.ts";
import { getErrnoCode } from "../../tools/errno.ts";
import { SessionSpillError, type SessionSpillErrorCode, type SessionSpillErrorFields } from "../errors.js";
import { sha256Hex } from "./blob-hash.js";
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

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
const COMMA = 0x2c;
const NO_ENTRIES = new Uint8Array(0);

interface StoredSession {
	readonly header: Uint8Array;
	/** The entries held in memory: everything after the bytes its spill file holds. */
	entries: Uint8Array[];
	lastSeq: number;
	/** The directory its file is in, from the first release that wrote one. */
	directory: SessionHistoryDirectory | undefined;
	/** Its file's number in `directory`; each release that writes gives it a new file. */
	file: number;
	/** Bytes of entries its file holds, the history before `entries`. */
	spilledBytes: number;
	/** The release writing its entries to its file now; a load, a delete or another release waits for it. */
	spilling: Promise<void> | undefined;
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

/** One store's directory for released sessions' history, with files numbered from 1. */
export interface SessionHistoryDirectory {
	readonly path: string;
	/**
	 * Writes file `file`: the first `previous.bytes` bytes of file `previous.file`, when given, then `data`. The file has
	 * its name only once it is complete, so a write that fails or is cut short leaves no part of it under that name.
	 */
	write(file: number, data: Uint8Array, previous?: { readonly file: number; readonly bytes: number }): Promise<void>;
	/** The whole content of the file. */
	read(file: number): Promise<Uint8Array>;
	/** Removes the file; a file already gone is not a failure. */
	removeFile(file: number): Promise<void>;
	/** Removes the directory and every file in it; a directory already gone is not a failure. */
	remove(): Promise<void>;
}

/**
 * Where a `MemorySessionStore` moves released sessions' history: a directory per store, with a file per session.
 * `releasedHistoryFiles(agentDir)` keeps them under the agent directory. A store given none keeps all history in memory.
 */
export interface SessionHistoryFiles {
	/** Creates an empty owner-only directory for one store's files, or says why it could not (`"spill-dir-refused"`). */
	createDirectory(): Promise<SessionHistoryDirectory | SessionSpillError>;
	/** Reports a failure the store worked around: once for each code, and once for each session a listing left out. */
	report(degradation: SessionSpillError): void;
}

/** How long a store keeps its history in memory after its directory could not be created, before it tries again. */
export const SPILL_DIRECTORY_RETRY_MS = 60_000;

/**
 * Where a store, and every handle `reopen()` makes from it, keeps released sessions' history: one directory, created
 * on the first release, with a file per session. It is removed when the last handle closes. A directory that could not
 * be created is asked for again no more than once every {@link SPILL_DIRECTORY_RETRY_MS}; releases meanwhile keep
 * their history in memory.
 */
class SpillDirectory {
	private current: Promise<SessionHistoryDirectory | undefined> | undefined;
	/** When the directory could not be created, while it is not. */
	private refusedAt: number | undefined;
	private files = 0;
	private handles = 1;
	private readonly degradations = new Map<string, SessionSpillError>();

	private readonly historyFiles: SessionHistoryFiles;

	constructor(historyFiles: SessionHistoryFiles) {
		this.historyFiles = historyFiles;
	}

	attach(): void {
		this.handles += 1;
	}

	/** One handle closed; whether it was the last. */
	detach(): boolean {
		this.handles -= 1;
		return this.handles === 0;
	}

	/** The directory, created on first use; undefined, and recorded, while it could not be created. */
	directory(): Promise<SessionHistoryDirectory | undefined> {
		if (
			this.current === undefined ||
			(this.refusedAt !== undefined && Date.now() - this.refusedAt >= SPILL_DIRECTORY_RETRY_MS)
		) {
			this.refusedAt = undefined;
			this.current = this.historyFiles.createDirectory().then((created) => {
				if (!(created instanceof SessionSpillError)) return created;
				this.refusedAt = Date.now();
				this.record(created.code, created);
				return undefined;
			});
		}
		return this.current;
	}

	nextFile(): number {
		this.files += 1;
		return this.files;
	}

	/** Removes the directory and every file in it, once the last handle has closed. */
	async remove(): Promise<void> {
		const current = await this.current;
		this.current = undefined;
		this.refusedAt = undefined;
		if (current === undefined) return;
		await current
			.remove()
			.catch((cause: Error) =>
				this.degraded("spill-cleanup-failed", { directory: current.path, errno: getErrnoCode(cause) }, cause),
			);
	}

	/** Records a failure the store worked around, once per code, and reports it once. */
	degraded(code: SessionSpillErrorCode, fields: SessionSpillErrorFields, cause: unknown): void {
		this.record(code, new SessionSpillError(code, fields, { cause }));
	}

	/** Records a session a listing left out because its history could not be read back, once per session. */
	skipped(failure: SessionSpillError): void {
		this.record(`${failure.code}:${failure.sessionId}`, failure);
	}

	private record(key: string, degradation: SessionSpillError): void {
		if (this.degradations.has(key)) return;
		this.degradations.set(key, degradation);
		this.historyFiles.report(degradation);
	}

	degradation(): readonly SessionSpillError[] {
		return [...this.degradations.values()];
	}
}

/**
 * Sessions held in process memory. Each record is kept as UTF-8 JSON bytes, not a string: one character outside
 * Latin-1 makes the engine store a whole string at two bytes per character, which would double every idle agent's
 * history (#4326). An append encodes only the entries it adds, and merges it into the buffers before it while they
 * are less than twice its size, so a session of n bytes is held in at most log2(n) + 1 buffers, not one per append
 * (#4403); a load joins them into one.
 *
 * A store given {@link SessionHistoryFiles} keeps a released session's history out of process memory (#4502):
 * `releaseSession()` writes the session's history to a file of its own and keeps only its header in memory. A load
 * reads the file once and adds what was appended since; an append stays in memory until the next release writes it
 * with the history before it. The files are removed with their sessions and when the store's last handle closes. A
 * store given none, as `SessionManager.inMemory()` creates, keeps everything in memory.
 */
export class MemorySessionStore implements SessionStore {
	private records = new Map<string, StoredSession>();
	/** Each session's blobs by hash, removed with the session. */
	private blobs = new Map<string, Map<string, Uint8Array>>();
	private spill: SpillDirectory | undefined;
	private closed = false;

	private readonly cwdMatcher?: SessionCwdMatcher;

	constructor(cwdMatcher?: SessionCwdMatcher, historyFiles?: SessionHistoryFiles) {
		this.cwdMatcher = cwdMatcher;
		if (historyFiles !== undefined) this.spill = new SpillDirectory(historyFiles);
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
		if (entries.length > 0) this.addChunk(record.entries, this.encodeEntries(entries));
		record.lastSeq += entries.length;
		return { lastSeq: record.lastSeq };
	}

	/** Add an append's chunk to the session's buffers. A merge that fails leaves them as they were. */
	private addChunk(chunks: Uint8Array[], chunk: Uint8Array): void {
		try {
			appendChunk(chunks, chunk);
		} catch (cause) {
			throw new StorageUnavailableError(this.descriptor, cause as Error);
		}
	}

	async replace(
		sessionId: string,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		const previous = this.forWrite(sessionId, options);
		validateSessionHeader(header);
		validateSessionEntries(entries);
		if (header.id !== sessionId) throw new SessionIdMismatchError(sessionId, header.id);
		this.records.set(sessionId, this.encodeSession(header, entries));
		await this.removeSpillFile(sessionId, previous);
		return { lastSeq: entries.length };
	}

	async load(sessionId: string): Promise<SessionSnapshot> {
		const record = this.stored(sessionId);
		if (!record) throw new SessionNotFoundError(sessionId);
		return (await this.decode(sessionId, record)) ?? this.load(sessionId);
	}

	async readHeader(sessionId: string): Promise<SessionRecordHeader | undefined> {
		const record = this.stored(sessionId);
		return record === undefined ? undefined : decodeHeader(record);
	}

	async delete(sessionId: string): Promise<void> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const record = this.records.get(sessionId);
		this.records.delete(sessionId);
		this.blobs.delete(sessionId);
		if (record !== undefined) await this.removeSpillFile(sessionId, record);
	}

	/**
	 * Moves the session's history out of process memory into its file, keeping only its header in memory; a later
	 * release writes what was appended since after the history its file holds. Does nothing for a session this store
	 * does not hold, on a closed store or one without history files, or when nothing was appended since the last
	 * release. A write that fails does not reject: the history stays in memory and the failure is recorded in
	 * {@link spillDegradation}.
	 */
	async releaseSession(sessionId: string): Promise<void> {
		const spill = this.spill;
		if (this.closed || spill === undefined) return;
		validateSessionText("sessionId", sessionId);
		const record = this.records.get(sessionId);
		if (record === undefined) return;
		const spilling: Promise<void> = settled(record.spilling)
			.then(() => this.spillEntries(sessionId, record, spill))
			.finally(() => {
				if (record.spilling === spilling) record.spilling = undefined;
			});
		record.spilling = spilling;
		await spilling;
	}

	/**
	 * What this store had to work around while keeping released sessions' history on disk: once per code, a spill
	 * directory it could not use (`"spill-dir-refused"`), a write that failed (`"spill-write-failed"`), whose history it
	 * kept in memory, or files it could not remove (`"spill-cleanup-failed"`); and once per session, a session a listing
	 * left out because its history could not be read back (`"spill-missing"`, `"spill-corrupt"`, or a
	 * `"spill-read-failed"` that is not retryable). Empty while nothing went wrong.
	 */
	spillDegradation(): readonly SessionSpillError[] {
		return this.spill?.degradation() ?? [];
	}

	/** Bytes of session history (headers and entries) this store holds in process memory and in its files on disk. */
	historyBytes(): { readonly inMemory: number; readonly onDisk: number } {
		let inMemory = 0;
		let onDisk = 0;
		for (const record of this.records.values()) {
			inMemory += record.header.byteLength;
			for (const chunk of record.entries) inMemory += chunk.byteLength;
			onDisk += record.spilledBytes;
		}
		return { inMemory, onDisk };
	}

	async putBlob(sessionId: string, data: Uint8Array): Promise<SessionBlob> {
		const copy = Uint8Array.from(data);
		const hash = await sha256Hex(copy);
		if (!this.stored(sessionId)) throw new SessionNotFoundError(sessionId);
		this.blobs.set(sessionId, (this.blobs.get(sessionId) ?? new Map<string, Uint8Array>()).set(hash, copy));
		return { hash, bytes: copy.byteLength };
	}

	async getBlob(sessionId: string, hash: string): Promise<Uint8Array | undefined> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const data = this.blobs.get(sessionId)?.get(hash);
		return data === undefined ? undefined : Uint8Array.from(data);
	}

	async *list(query: SessionListQuery): AsyncIterable<SessionSummary> {
		this.assertOpen();
		query.signal?.throwIfAborted();
		const matchesCwd =
			query.cwd === undefined
				? undefined
				: (this.cwdMatcher?.(query.cwd) ?? ((candidate: string | undefined) => candidate === query.cwd));
		for (const [sessionId, record] of this.records) {
			this.assertOpen();
			query.signal?.throwIfAborted();
			const header = decodeHeader(record);
			if (matchesCwd && !matchesCwd(header.cwd)) continue;
			if (!query.includeInternal && header.internal) continue;
			let snapshot: SessionSnapshot | undefined;
			try {
				snapshot = await this.decode(sessionId, record);
			} catch (error) {
				// A session whose history is lost is left out of every listing; one that may read next time fails this one.
				if (!(error instanceof SessionSpillError) || error.retryable) throw error;
				this.spill?.skipped(error);
				continue;
			}
			if (snapshot !== undefined) yield summarizeSession(snapshot);
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
		const spill = this.spill;
		if (spill === undefined || !spill.detach()) return;
		await Promise.all(Array.from(this.records.values(), (record) => settled(record.spilling)));
		await spill.remove();
	}

	async reopen(): Promise<MemorySessionStore> {
		const store = new MemorySessionStore(this.cwdMatcher);
		store.records = this.records;
		store.blobs = this.blobs;
		store.spill = this.spill;
		this.spill?.attach();
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

	private forWrite(sessionId: string, options: SessionWriteOptions): StoredSession {
		const record = this.stored(sessionId);
		if (!record) throw new SessionNotFoundError(sessionId);
		if (options.expectSeq !== record.lastSeq) {
			throw new SessionConflictError(sessionId, options.expectSeq, record.lastSeq);
		}
		return record;
	}

	/**
	 * The session as it is now: its file, read once, then the entries held in memory. Undefined when its file could
	 * not be read because the session was deleted or replaced meanwhile.
	 */
	private async decode(sessionId: string, record: StoredSession): Promise<SessionSnapshot | undefined> {
		for (;;) {
			while (record.spilling !== undefined) await settled(record.spilling);
			const header = decodeHeader(record);
			const lastSeq = record.lastSeq;
			const held = joinEntries(record);
			const { directory, file, spilledBytes } = record;
			if (directory === undefined) return { header, entries: parseEntries(held), lastSeq };
			let spilled: Uint8Array;
			try {
				spilled = await readSpillFile(directory, file, sessionId, spilledBytes);
			} catch (error) {
				this.assertOpen();
				if (this.records.get(sessionId) !== record) return undefined;
				// A release wrote the history to the session's next file meanwhile, and removed this one.
				if (record.file !== file) continue;
				throw error;
			}
			return { header, entries: parseHistory(directory, sessionId, spilled, held), lastSeq };
		}
	}

	/**
	 * Writes the session's history to its next file, the history its file holds followed by the entries held in memory,
	 * then removes the file before it.
	 */
	private async spillEntries(sessionId: string, record: StoredSession, spill: SpillDirectory): Promise<void> {
		if (this.records.get(sessionId) !== record || record.entries.length === 0) return;
		const directory = record.directory ?? (await spill.directory());
		if (directory === undefined || this.records.get(sessionId) !== record) return;
		const chunks = record.entries;
		record.entries = [];
		const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, chunks.length - 1);
		const previous = record.directory === undefined ? undefined : { file: record.file, bytes: record.spilledBytes };
		const file = spill.nextFile();
		try {
			const data =
				previous !== undefined
					? joinChunks([NO_ENTRIES, ...chunks])
					: chunks.length === 1
						? (chunks[0] as Uint8Array)
						: joinChunks(chunks);
			await directory.write(file, data, previous);
			record.directory = directory;
			record.file = file;
			record.spilledBytes += data.byteLength;
		} catch (cause) {
			record.entries = [...chunks, ...record.entries];
			spill.degraded(
				"spill-write-failed",
				{ directory: directory.path, sessionId, bytes, errno: getErrnoCode(cause) },
				cause,
			);
			return;
		}
		if (previous !== undefined) await this.removeFile(directory, sessionId, previous.file);
	}

	/** Removes the file of a session that was deleted or replaced, once a release writing to it has finished. */
	private async removeSpillFile(sessionId: string, record: StoredSession): Promise<void> {
		while (record.spilling !== undefined) await settled(record.spilling);
		if (record.directory !== undefined) await this.removeFile(record.directory, sessionId, record.file);
	}

	private async removeFile(directory: SessionHistoryDirectory, sessionId: string, file: number): Promise<void> {
		await directory
			.removeFile(file)
			.catch((cause: Error) =>
				this.spill?.degraded(
					"spill-cleanup-failed",
					{ directory: directory.path, sessionId, errno: getErrnoCode(cause) },
					cause,
				),
			);
	}

	private encodeSession(header: SessionRecordHeader, entries: readonly SessionEntry[]): StoredSession {
		return {
			header: this.encode(() => JSON.stringify(header)),
			entries: entries.length === 0 ? [] : [this.encodeEntries(entries)],
			lastSeq: entries.length,
			directory: undefined,
			file: 0,
			spilledBytes: 0,
			spilling: undefined,
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

/**
 * Resolves once `promise` has settled, either way. A release's write is awaited this way by what waits its turn after
 * it; the release that started the write reports how it went.
 */
function settled(promise: Promise<void> | undefined): Promise<void> {
	return promise === undefined ? Promise.resolve() : promise.then(noop, noop);
}

function noop(): void {}

function decodeHeader(record: StoredSession): SessionRecordHeader {
	return JSON.parse(utf8Decoder.decode(record.header)) as SessionRecordHeader;
}

function parseEntries(bytes: Uint8Array): SessionEntry[] {
	return JSON.parse(`[${utf8Decoder.decode(bytes)}]`) as SessionEntry[];
}

/** A session's file: the history written to it, which it holds whole, since each file is renamed into place complete. */
async function readSpillFile(
	directory: SessionHistoryDirectory,
	file: number,
	sessionId: string,
	bytes: number,
): Promise<Uint8Array> {
	let data: Uint8Array;
	try {
		data = await directory.read(file);
	} catch (cause) {
		const errno = getErrnoCode(cause);
		throw new SessionSpillError(
			errno === "ENOENT" ? "spill-missing" : "spill-read-failed",
			{ directory: directory.path, sessionId, bytes, errno },
			{ cause },
		);
	}
	if (data.byteLength !== bytes)
		throw new SessionSpillError(data.byteLength < bytes ? "spill-missing" : "spill-corrupt", {
			directory: directory.path,
			sessionId,
			bytes,
			foundBytes: data.byteLength,
		});
	return data;
}

/**
 * The session's entries: those its file holds, then those held in memory. Content in its file that does not parse was
 * not written by this store, so its history is lost: `"spill-corrupt"`.
 */
function parseHistory(
	directory: SessionHistoryDirectory,
	sessionId: string,
	spilled: Uint8Array,
	held: Uint8Array,
): SessionEntry[] {
	try {
		return parseEntries(held.byteLength === 0 ? spilled : joinChunks([spilled, held]));
	} catch (cause) {
		if (!(cause instanceof SyntaxError)) throw cause;
		throw new SessionSpillError(
			"spill-corrupt",
			{ directory: directory.path, sessionId, bytes: spilled.byteLength },
			{ cause },
		);
	}
}

/** The chunks as one buffer, with a comma between each two. */
function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
	let size = chunks.length - 1;
	for (const chunk of chunks) size += chunk.byteLength;
	const joined = new Uint8Array(size);
	let offset = 0;
	for (const [index, chunk] of chunks.entries()) {
		if (index > 0) joined[offset++] = COMMA;
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined;
}

/**
 * Add an append's chunk after a session's chunks, merged with the newest of them while each is less than twice the
 * size of what follows it. Every chunk then holds at least twice the bytes of the next, and a byte is copied again
 * only into a chunk at least half as large again as the one it was in, so appends copy each byte O(log n) times.
 */
function appendChunk(chunks: Uint8Array[], chunk: Uint8Array): void {
	let start = chunks.length;
	let size = chunk.byteLength;
	while (start > 0 && (chunks[start - 1] as Uint8Array).byteLength < 2 * size) {
		start -= 1;
		size += (chunks[start] as Uint8Array).byteLength + 1;
	}
	const merged = start === chunks.length ? chunk : joinChunks([...chunks.slice(start), chunk]);
	chunks.splice(start, chunks.length - start, merged);
}

function joinEntries(record: StoredSession): Uint8Array {
	if (record.entries.length <= 1) return record.entries[0] ?? NO_ENTRIES;
	const joined = joinChunks(record.entries);
	record.entries.splice(0, record.entries.length, joined);
	return joined;
}
