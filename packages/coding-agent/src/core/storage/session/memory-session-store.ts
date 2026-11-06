import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "../../session-manager-types.ts";
import { getErrnoCode } from "../../tools/errno.ts";
import {
	acquireProtectedPaths,
	ensureTempDir,
	getTempRootDir,
	type ProtectedPathLease,
	SESSION_TEMP_FILE_MODE,
} from "../../tools/session-temp-dir.ts";
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
	/** The spill directory its file is in, from the first release that wrote one. */
	directory: string | undefined;
	/** Its file's number in `directory`. */
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

/** Spill directories of stores still open in this process, removed at exit if no store closed them first. */
const liveSpillDirectories = new Set<string>();
let exitCleanupInstalled = false;

function removeSpillDirectoriesAtExit(): void {
	if (exitCleanupInstalled) return;
	exitCleanupInstalled = true;
	process.once("exit", () => {
		for (const directory of liveSpillDirectories) {
			try {
				rmSync(directory, { recursive: true, force: true });
			} catch {
				// Nothing can report it while the process exits; Atomic's temp sweep removes what is left.
			}
		}
	});
}

/**
 * Where a store, and every handle `reopen()` makes from it, keeps released sessions' history: one owner-only directory
 * under Atomic's temp directory, created on the first release, with a file per session. It is removed when the last
 * handle closes, or at exit.
 */
class SpillDirectory {
	private path: string | undefined;
	private lease: ProtectedPathLease | undefined;
	private files = 0;
	private handles = 1;
	private readonly writes = new Set<Promise<void>>();
	private readonly degradations = new Map<SessionSpillErrorCode, SessionSpillError>();

	get open(): boolean {
		return this.handles > 0;
	}

	attach(): void {
		this.handles += 1;
	}

	/** The directory, created on first use; undefined, and recorded, when it cannot be created or trusted. */
	directory(): string | undefined {
		if (this.path !== undefined) return this.path;
		const path = join(getTempRootDir(), `memory-sessions-${process.pid}-${randomBytes(6).toString("hex")}`);
		try {
			ensureTempDir(path);
		} catch (cause) {
			this.degraded("spill-dir-refused", { directory: path, errno: getErrnoCode(cause) }, cause);
			return undefined;
		}
		this.path = path;
		this.lease = acquireProtectedPaths([path]);
		liveSpillDirectories.add(path);
		removeSpillDirectoriesAtExit();
		return path;
	}

	nextFile(): number {
		this.files += 1;
		return this.files;
	}

	track(write: Promise<void>): void {
		const done = settled(write);
		this.writes.add(done);
		void done.then(() => this.writes.delete(done));
	}

	/** One handle closed; the last one removes the directory once its writes have finished. */
	async detach(): Promise<void> {
		this.handles -= 1;
		if (this.handles > 0) return;
		await Promise.all(this.writes);
		const path = this.path;
		if (this.handles > 0 || path === undefined) return;
		this.path = undefined;
		this.lease?.release();
		this.lease = undefined;
		liveSpillDirectories.delete(path);
		await rm(path, { recursive: true, force: true }).catch((cause: Error) =>
			this.degraded("spill-cleanup-failed", { directory: path, errno: getErrnoCode(cause) }, cause),
		);
	}

	/** Records a failure the store worked around, once per code, and emits it once as a process warning. */
	degraded(code: SessionSpillErrorCode, fields: SessionSpillErrorFields, cause: unknown): void {
		if (this.degradations.has(code)) return;
		const degradation = new SessionSpillError(code, fields, { cause });
		this.degradations.set(code, degradation);
		process.emitWarning(degradation);
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
 * A released session's history leaves process memory (#4502): `releaseSession()` writes the entries held in memory to the
 * session's own file in an owner-only directory under Atomic's temp directory, and keeps only its header. A load reads
 * the file once and adds what was appended since; an append stays in memory until the next release adds it to the
 * file. The files are removed with their sessions and when the store's last handle closes. Private stores, which
 * `SessionManager.inMemory()` creates, keep everything in memory.
 */
export class MemorySessionStore implements SessionStore {
	private records = new Map<string, StoredSession>();
	/** Each session's blobs by hash, removed with the session. */
	private blobs = new Map<string, Map<string, Uint8Array>>();
	private spill = new SpillDirectory();
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
	 * release adds only what was appended since. Does nothing for a session this store does not hold, on a closed or
	 * private store, or when nothing was appended since the last release. A write that fails does not reject: the
	 * history stays in memory and the failure is recorded in {@link spillDegradation}.
	 */
	async releaseSession(sessionId: string): Promise<void> {
		if (this.closed || privateStores.has(this)) return;
		validateSessionText("sessionId", sessionId);
		const record = this.records.get(sessionId);
		if (record === undefined) return;
		const spilling: Promise<void> = settled(record.spilling)
			.then(() => this.spillEntries(sessionId, record))
			.finally(() => {
				if (record.spilling === spilling) record.spilling = undefined;
			});
		record.spilling = spilling;
		this.spill.track(spilling);
		await spilling;
	}

	/**
	 * What this store had to work around while keeping released sessions' history on disk, once per code: a spill
	 * directory it could not use (`"spill-dir-refused"`), a write that failed (`"spill-write-failed"`), whose history it
	 * kept in memory, or files it could not remove (`"spill-cleanup-failed"`). Empty while nothing went wrong.
	 */
	spillDegradation(): readonly SessionSpillError[] {
		return this.spill.degradation();
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
			const snapshot = await this.decode(sessionId, record);
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
		await this.spill.detach();
	}

	async reopen(): Promise<MemorySessionStore> {
		const store = new MemorySessionStore(this.cwdMatcher);
		store.records = this.records;
		store.blobs = this.blobs;
		store.spill = this.spill;
		this.spill.attach();
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
		while (record.spilling !== undefined) await settled(record.spilling);
		const header = decodeHeader(record);
		const lastSeq = record.lastSeq;
		const held = joinEntries(record);
		const { directory, file, spilledBytes } = record;
		if (directory === undefined || spilledBytes === 0) return { header, entries: parseEntries(held), lastSeq };
		let spilled: Uint8Array;
		try {
			spilled = await readSpillFile(directory, file, sessionId, spilledBytes);
		} catch (error) {
			this.assertOpen();
			if (this.records.get(sessionId) !== record) return undefined;
			throw error;
		}
		return {
			header,
			entries: parseEntries(held.byteLength === 0 ? spilled : joinChunks([spilled, held])),
			lastSeq,
		};
	}

	/** Writes the entries the session holds in memory after those its file already has. */
	private async spillEntries(sessionId: string, record: StoredSession): Promise<void> {
		if (!this.spill.open || this.records.get(sessionId) !== record || record.entries.length === 0) return;
		const directory = record.directory ?? this.spill.directory();
		if (directory === undefined) return;
		if (record.directory === undefined) {
			record.directory = directory;
			record.file = this.spill.nextFile();
		}
		const chunks = record.entries;
		record.entries = [];
		const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, chunks.length - 1);
		try {
			const data =
				record.spilledBytes > 0
					? joinChunks([NO_ENTRIES, ...chunks])
					: chunks.length === 1
						? (chunks[0] as Uint8Array)
						: joinChunks(chunks);
			await writeAt(join(directory, String(record.file)), data, record.spilledBytes);
			record.spilledBytes += data.byteLength;
		} catch (cause) {
			// Appends made while it was writing follow what it took.
			record.entries = record.entries.length === 0 ? chunks : [...chunks, ...record.entries];
			this.spill.degraded("spill-write-failed", { directory, sessionId, bytes, errno: getErrnoCode(cause) }, cause);
		}
	}

	/** Removes the file of a session that was deleted or replaced, once a release writing to it has finished. */
	private async removeSpillFile(sessionId: string, record: StoredSession): Promise<void> {
		while (record.spilling !== undefined) await settled(record.spilling);
		const directory = record.directory;
		if (directory === undefined) return;
		await rm(join(directory, String(record.file)), { force: true }).catch((cause: Error) =>
			this.spill.degraded("spill-cleanup-failed", { directory, sessionId, errno: getErrnoCode(cause) }, cause),
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

/** Writes `data` at `position` of the file at `path`, creating the file, or emptying it, when `position` is 0. */
async function writeAt(path: string, data: Uint8Array, position: number): Promise<void> {
	const handle = await open(path, position === 0 ? "w" : "r+", SESSION_TEMP_FILE_MODE);
	let failure: unknown;
	try {
		for (let written = 0; written < data.byteLength; ) {
			const { bytesWritten } = await handle.write(data, written, data.byteLength - written, position + written);
			written += bytesWritten;
		}
	} catch (error) {
		failure = error;
	}
	try {
		await handle.close();
	} catch (closeFailure) {
		if (failure === undefined) throw closeFailure;
		if (failure instanceof Error) Object.defineProperty(failure, "cleanupCause", { value: closeFailure });
	}
	if (failure !== undefined) throw failure;
}

/** The first `bytes` bytes of a session's file: the history written to it. */
async function readSpillFile(directory: string, file: number, sessionId: string, bytes: number): Promise<Uint8Array> {
	let data: Uint8Array;
	try {
		data = await readFile(join(directory, String(file)));
	} catch (cause) {
		const errno = getErrnoCode(cause);
		throw new SessionSpillError(
			errno === "ENOENT" ? "spill-missing" : "spill-read-failed",
			{ directory, sessionId, bytes, errno },
			{ cause },
		);
	}
	if (data.byteLength < bytes)
		throw new SessionSpillError("spill-missing", { directory, sessionId, bytes, foundBytes: data.byteLength });
	return data.byteLength === bytes ? data : data.subarray(0, bytes);
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
