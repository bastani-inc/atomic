import type { SessionEntry } from "../../session-manager-types.ts";
import { getErrnoCode } from "../../tools/errno.ts";
import { SessionSpillError, type SessionSpillErrorCode, type SessionSpillErrorFields } from "../errors.js";
import { sha256Hex } from "./blob-hash.js";
import { branchStatePages } from "./branch-state-pages.js";
import { EntryTypeReader } from "./entry-type.js";
import {
	SessionConflictError,
	SessionExistsError,
	SessionIdMismatchError,
	SessionNotFoundError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";
import {
	foldSessionResume,
	foreignResumeIds,
	isSessionResumeIndex,
	latestCompactionOf,
	refoldSessionResume,
	resumeIndexNeedsRefold,
	type SessionResumeIndex,
	selectResumeLeaf,
	sessionResumeFrom,
	sessionResumePlan,
	sessionTailFrom,
	stateSeqsBefore,
	transcriptBranchSpan,
} from "./session-resume.js";
import {
	applySessionSummaryEntries,
	materializeSessionSummaryMetadata,
	type SessionSummaryState,
	summarizeSession,
} from "./session-summary.js";
import { noteSnapshotGeneration, registerArchiveLoad } from "./snapshot-generation.ts";
import type {
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
	SessionListQuery,
	SessionRecordHeader,
	SessionResume,
	SessionSnapshot,
	SessionStore,
	SessionStoredEntry,
	SessionSummary,
	SessionTail,
	SessionWriteOptions,
	SessionWriteResult,
	StorageDescriptor,
} from "./types.js";
import { matchesSessionIdPrefix, SESSION_HISTORY_CHUNK_BYTES, SESSION_HISTORY_PAGE_ENTRIES } from "./types.js";
import { validateSessionEntries, validateSessionHeader, validateSessionText } from "./validation.js";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
const COMMA = 0x2c;
const NO_ENTRIES = new Uint8Array(0);
export const SPILL_BLOCK_BYTES = 64 * 1024;
const FNV_OFFSET = 0x811c9dc5;
const SCAN_WINDOW_BYTES = 1024 * 1024;
const RAW_CHUNK_BYTES = 1024 * 1024;
const TYPE_WINDOW_BYTES = 64 * 1024;
const STUB_ENTRY: SessionEntry = {
	type: "custom",
	id: "",
	parentId: null,
	timestamp: "1970-01-01T00:00:00.000Z",
	customType: "",
};

interface StoredSession {
	header: Uint8Array;
	/** The entries held in memory: everything after the bytes its spill file holds. */
	entries: Uint8Array[];
	summaryState: SessionSummaryState;
	lastSeq: number;
	/** The directory its file is in, from the first release that wrote one. */
	directory: SessionHistoryDirectory | undefined;
	/** Its file's number in `directory`; each release that writes gives it a new file. */
	file: number;
	/** Bytes of entries its file holds, the history before `entries`. */
	spilledBytes: number;
	/** Incremental FNV-1a checksum of the bytes successfully spilled, kept independently of the file. */
	spilledChecksum: number;
	/** The release writing its entries to its file now; a load, a delete or another release waits for it. */
	spilling: Promise<void> | undefined;
	readonly starts: number[];
	totalBytes: number;
	index: SessionResumeIndex;
	blocks: number[];
}

interface HeldBytes {
	readonly record: StoredSession;
	readonly directory: SessionHistoryDirectory | undefined;
	readonly file: number;
	readonly spilledBytes: number;
	readonly blocks: readonly number[];
	readonly chunks: readonly Uint8Array[];
	readonly lastSeq: number;
	readonly totalBytes: number;
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
	readRange?(
		file: number,
		position: number,
		length: number,
	): Promise<{ readonly bytes: Uint8Array; readonly size: number }>;
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

	async create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<SessionWriteResult> {
		this.assertOpen();
		validateSessionHeader(header);
		validateSessionEntries(entries);
		if (this.records.has(header.id)) throw new SessionExistsError(header.id);
		const record = this.encodeSession(header, entries);
		this.records.set(header.id, record);
		return { lastSeq: entries.length, epoch: record.index.epoch };
	}

	async append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		const record = this.forWrite(sessionId, options);
		validateSessionEntries(entries);
		if (entries.length === 0) return { lastSeq: record.lastSeq };
		const index = this.appendedIndex(record, entries);
		const encoded = this.encodeEntries(entries);
		this.addChunk(record.entries, encoded.bytes);
		let position = record.totalBytes === 0 ? 0 : record.totalBytes + 1;
		for (const length of encoded.lengths) {
			record.starts.push(position);
			position += length + 1;
		}
		record.totalBytes = position - 1;
		record.lastSeq += entries.length;
		record.index = index;
		record.summaryState = applySessionSummaryEntries(record.summaryState, entries).state;
		return { lastSeq: record.lastSeq };
	}

	private appendedIndex(record: StoredSession, entries: readonly SessionEntry[]): SessionResumeIndex {
		const previous = record.index;
		if (resumeIndexNeedsRefold(previous, entries)) return foldSessionResume(previous, entries);
		const seqs = new Map<string, number>();
		let unresolved = false;
		for (const id of foreignResumeIds(previous, entries)) {
			const seq = record.spilling === undefined ? heldSeqOf(record, id) : undefined;
			if (seq !== undefined) seqs.set(id, seq);
			else if (record.spilling !== undefined || record.directory !== undefined) unresolved = true;
		}
		const index = foldSessionResume(previous, entries, (id) => seqs.get(id));
		return unresolved ? { ...index, needsBranchRebuild: true } : index;
	}

	private async resumeIndex(sessionId: string, record: StoredSession): Promise<SessionResumeIndex | undefined> {
		if (isSessionResumeIndex(record.index, record.lastSeq)) return record.index;
		const snapshot = await this.decode(sessionId, record);
		if (snapshot === undefined || this.records.get(sessionId) !== record || record.lastSeq !== snapshot.lastSeq)
			return undefined;
		record.index = refoldSessionResume(record.index, snapshot.entries);
		return record.index;
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
	): Promise<SessionWriteResult> {
		const previous = this.forWrite(sessionId, options);
		validateSessionHeader(header);
		validateSessionEntries(entries);
		if (header.id !== sessionId) throw new SessionIdMismatchError(sessionId, header.id);
		const record = this.encodeSession(header, entries);
		this.records.set(sessionId, record);
		await this.removeSpillFile(sessionId, previous);
		return { lastSeq: entries.length, epoch: record.index.epoch };
	}

	async updateHeader(header: SessionRecordHeader, options: SessionWriteOptions): Promise<SessionWriteResult> {
		validateSessionHeader(header);
		const record = this.forWrite(header.id, options);
		record.header = this.encode(() => JSON.stringify(header));
		record.index = { ...record.index, epoch: crypto.randomUUID() };
		return { lastSeq: record.lastSeq, epoch: record.index.epoch };
	}

	async load(sessionId: string): Promise<SessionSnapshot> {
		const record = this.stored(sessionId);
		if (!record) throw new SessionNotFoundError(sessionId);
		const snapshot = await this.decode(sessionId, record);
		return snapshot
			? noteSnapshotGeneration(this, snapshot, nativeLoad, record.index, "epoch")
			: this.load(sessionId);
	}

	async readTail(sessionId: string, fromSeq: number): Promise<SessionTail> {
		for (;;) {
			const record = await this.settledRecord(sessionId);
			const index = await this.resumeIndex(sessionId, record);
			if (index === undefined) continue;
			const start = Math.max(1, fromSeq);
			const read = await this.entriesAt(sessionId, record, [
				...stateSeqsBefore(index, start),
				...seqRange(start, index.seq),
			]);
			if (read === undefined) continue;
			const state = read.filter((held) => held.seq < start);
			const tail = read.filter((held) => held.seq >= start).map((held) => held.entry);
			return sessionTailFrom(index, decodeHeader(record), start, state, tail);
		}
	}

	async readBranchSpan(sessionId: string, cut: SessionBranchPageCut) {
		const record = await this.settledRecord(sessionId);
		const index = await this.resumeIndex(sessionId, record);
		if (!index) throw new SessionConflictError(sessionId, cut.leaf, record.lastSeq);
		return transcriptBranchSpan(sessionId, index, cut);
	}

	async readEntrySizes(sessionId: string, startSeq: number, endSeq: number): Promise<SessionEntrySizes> {
		const record = await this.settledRecord(sessionId);
		const held = this.held(record);
		const start = Math.max(1, startSeq);
		const seqs = seqRange(start, Math.min(endSeq, held.lastSeq, start + SESSION_HISTORY_PAGE_ENTRIES - 1));
		return {
			epoch: record.index.epoch,
			lastSeq: held.lastSeq,
			sizes: seqs.map((seq) => {
				const [from, to] = this.spanOf(held, seq, seq);
				return { seq, bytes: to - from };
			}),
		};
	}

	async readEntryChunk(reference: OversizedSessionEntry, offset: number): Promise<Uint8Array> {
		for (;;) {
			const record = await this.settledRecord(reference.sessionId);
			if (record.index.epoch !== reference.epoch)
				throw new SessionConflictError(reference.sessionId, reference.seq, record.lastSeq);
			const held = this.held(record);
			const [start, end] = this.spanOf(held, reference.seq, reference.seq);
			if (held.directory && start < held.spilledBytes && !held.directory.readRange)
				throw new TypeError("Session spill storage must implement readRange to read historical bytes");
			const result = await this.whileHeld(reference.sessionId, record, held, () =>
				this.bytesOf(
					reference.sessionId,
					held,
					start + offset,
					Math.min(end, start + offset + SESSION_HISTORY_CHUNK_BYTES),
				),
			);
			if (result) return Uint8Array.from(result);
		}
	}

	async readRange(
		sessionId: string,
		startSeq: number,
		endSeq: number,
		expectedEpoch?: string,
	): Promise<SessionEntryRange> {
		for (;;) {
			const record = await this.settledRecord(sessionId);
			if (expectedEpoch !== undefined && expectedEpoch !== record.index.epoch)
				throw new SessionConflictError(sessionId, endSeq, record.lastSeq);
			const index = await this.resumeIndex(sessionId, record);
			if (index === undefined) continue;
			const start = Math.max(1, startSeq);
			const seqs = seqRange(start, Math.min(endSeq, index.seq));
			const read = await this.entriesAt(sessionId, record, seqs);
			if (read === undefined) continue;
			return {
				startSeq: start,
				entries: read.map((held) => held.entry),
				lastSeq: index.seq,
				epoch: index.epoch,
				seqs,
				lastEntryId: index.lastId,
			};
		}
	}

	async findLatestCompaction(sessionId: string, leafId?: string): Promise<SessionCompactionPoint | undefined> {
		if (leafId !== undefined) validateSessionText("entry.id", leafId);
		for (;;) {
			const record = await this.settledRecord(sessionId);
			const index = await this.resumeIndex(sessionId, record);
			if (index === undefined) continue;
			const leafSeq =
				leafId === undefined ? index.leafSeq : ((await this.seqOfEntry(sessionId, record, leafId)) ?? -1);
			const point = latestCompactionOf(index, leafSeq);
			if (point === undefined) return undefined;
			const read = await this.entriesAt(sessionId, record, [...new Set([point.seq, leafSeq])].sort(bySeq));
			if (read === undefined) continue;
			const boundary = read.find((held) => held.seq === point.seq)?.entry;
			const leaf = read.find((held) => held.seq === leafSeq)?.entry;
			if (boundary?.type !== "compaction" || leaf === undefined) return undefined;
			return { ...point, entry: boundary, leafId: leaf.id, lastSeq: index.seq };
		}
	}

	async readResume(sessionId: string, leafId?: string): Promise<SessionResume> {
		if (leafId !== undefined) validateSessionText("entry.id", leafId);
		for (;;) {
			const record = await this.settledRecord(sessionId);
			let index = await this.resumeIndex(sessionId, record);
			if (index === undefined) continue;
			const leafSeq =
				leafId === undefined ? index.leafSeq : ((await this.seqOfEntry(sessionId, record, leafId)) ?? 0);
			if (leafSeq !== index.leafSeq) {
				const held = this.held(record);
				if (held.directory && !held.directory.readRange)
					throw new TypeError(
						"A released session history directory must implement readRange to resume a historical branch",
					);
				const pages = branchStatePages(index.seq, {
					bytes: (seq) => {
						const [start, end] = this.spanOf(held, seq, seq);
						return end - start;
					},
					read: async (seqs) => {
						const [start, end] = this.spanOf(held, seqs[0]!, seqs.at(-1)!);
						return this.parseRun(sessionId, held, await this.bytesOf(sessionId, held, start, end)).map(
							(entry, i) => ({ seq: seqs[i]!, entry }),
						);
					},
					chunk: (seq, offset, length) => {
						const start = this.spanOf(held, seq, seq)[0] + offset;
						return this.bytesOf(sessionId, held, start, start + length);
					},
				});
				const base = index;
				const selected = await this.whileHeld(sessionId, record, held, () =>
					selectResumeLeaf(base, leafSeq, pages),
				);
				if (
					!selected ||
					this.records.get(sessionId) !== record ||
					record.lastSeq !== base.seq ||
					record.file !== held.file
				)
					continue;
				index = selected;
			}
			const plan = sessionResumePlan(index);
			const branchSeqs = plan.branch.flatMap(([low, high]) => seqRange(low, high));
			const read = await this.entriesAt(sessionId, record, [...new Set([...branchSeqs, ...plan.state])].sort(bySeq));
			if (read === undefined) continue;
			const inBranch = new Set(branchSeqs);
			const branch = read.filter((held) => inBranch.has(held.seq));
			const state = read.filter((held) => !inBranch.has(held.seq));
			const leaf = leafSeq > 0 ? (branch.find((held) => held.seq === leafSeq)?.entry.id ?? null) : null;
			return sessionResumeFrom(index, decodeHeader(record), branch, state, leaf);
		}
	}

	async findEntrySeq(sessionId: string, entryId: string): Promise<number | undefined> {
		validateSessionText("entry.id", entryId);
		for (;;) {
			const record = await this.settledRecord(sessionId);
			const seq = await this.seqOfEntry(sessionId, record, entryId);
			if (this.records.get(sessionId) === record) return seq;
		}
	}

	async readEntryRange(sessionId: string, query: SessionEntriesQuery): Promise<SessionEntriesPage> {
		for (;;) {
			query.signal?.throwIfAborted();
			const record = await this.settledRecord(sessionId);
			const held = this.held(record);
			const { lastSeq } = held;
			const fromSeq = Math.max(1, query.fromSeq);
			let throughSeq = Math.min(query.toSeq, lastSeq);
			if (fromSeq > throughSeq) return { lastSeq, entries: [], throughSeq: Math.max(throughSeq, fromSeq - 1) };
			if (query.maxChars !== undefined && query.maxChars <= 0)
				return { lastSeq, entries: [], throughSeq: fromSeq - 1 };
			const [start] = this.spanOf(held, fromSeq, fromSeq);
			if (query.maxChars !== undefined) {
				for (let seq = fromSeq; seq < throughSeq; seq++) {
					if (this.spanOf(held, seq, seq)[1] - start >= query.maxChars) {
						throughSeq = seq;
						break;
					}
				}
			}
			const entries = await this.entriesIn(sessionId, record, held, fromSeq, throughSeq, query);
			if (entries === undefined) continue;
			return { lastSeq, entries, throughSeq };
		}
	}

	private async entriesIn(
		sessionId: string,
		record: StoredSession,
		held: HeldBytes,
		fromSeq: number,
		throughSeq: number,
		query: SessionEntriesQuery,
	): Promise<SessionEntryAt[] | undefined> {
		const oversized = (seq: number): boolean => {
			if (query.largeEntryBytes === undefined) return false;
			const [entryStart, entryEnd] = this.spanOf(held, seq, seq);
			return entryEnd - entryStart > query.largeEntryBytes;
		};
		const skipped = query.skipTypes === undefined ? undefined : new Set(query.skipTypes);
		const entries: SessionEntryAt[] = [];
		for (let seq = fromSeq; seq <= throughSeq; ) {
			if (oversized(seq)) {
				const [entryStart, entryEnd] = this.spanOf(held, seq, seq);
				if (skipped !== undefined && skipped.size > 0) {
					const typed = await this.whileHeld(sessionId, record, held, () =>
						this.typeOf(sessionId, held, entryStart, entryEnd, [...skipped], query.signal),
					);
					if (typed === undefined) return undefined;
					if (typed.type !== undefined && skipped.has(typed.type)) {
						seq++;
						continue;
					}
				}
				const rawChunks = await this.whileHeld(sessionId, record, held, () =>
					this.chunksOf(sessionId, held, entryStart, entryEnd, query.signal),
				);
				if (rawChunks === undefined) return undefined;
				entries.push({ seq, entry: STUB_ENTRY, rawChunks });
				seq++;
				continue;
			}
			let last = seq;
			while (last < throughSeq && !oversized(last + 1)) last++;
			const [start, end] = this.spanOf(held, seq, last);
			const bytes = await this.whileHeld(sessionId, record, held, () => this.bytesOf(sessionId, held, start, end));
			if (bytes === undefined) return undefined;
			query.signal?.throwIfAborted();
			for (let at = seq; at <= last; at++) {
				const [entryStart, entryEnd] = this.spanOf(held, at, at);
				const raw = bytes.subarray(entryStart - start, entryEnd - start);
				const entry = this.parseRun(sessionId, held, raw)[0] as SessionEntry;
				if (!skipped?.has(entry.type)) entries.push({ seq: at, entry });
			}
			seq = last + 1;
		}
		return entries;
	}

	private async typeOf(
		sessionId: string,
		held: HeldBytes,
		start: number,
		end: number,
		types: readonly string[],
		signal: AbortSignal | undefined,
	): Promise<{ readonly type: string | undefined }> {
		const reader = new EntryTypeReader(types);
		const whole =
			held.directory !== undefined && held.directory.readRange === undefined && start < held.spilledBytes
				? await this.bytesOf(sessionId, held, start, end)
				: undefined;
		for (let offset = start; offset < end && !reader.decided && !reader.typeSeen; offset += TYPE_WINDOW_BYTES) {
			signal?.throwIfAborted();
			const windowEnd = Math.min(end, offset + TYPE_WINDOW_BYTES);
			reader.feed(
				whole?.subarray(offset - start, windowEnd - start) ??
					(await this.bytesOf(sessionId, held, offset, windowEnd)),
			);
		}
		return { type: reader.finish() };
	}

	private async chunksOf(
		sessionId: string,
		held: HeldBytes,
		start: number,
		end: number,
		signal: AbortSignal | undefined,
	): Promise<Uint8Array[]> {
		const whole =
			held.directory !== undefined && held.directory.readRange === undefined && start < held.spilledBytes
				? await this.bytesOf(sessionId, held, start, end)
				: undefined;
		const chunks: Uint8Array[] = [];
		for (let offset = start; offset < end; offset += RAW_CHUNK_BYTES) {
			signal?.throwIfAborted();
			const chunkEnd = Math.min(end, offset + RAW_CHUNK_BYTES);
			const part =
				whole?.subarray(offset - start, chunkEnd - start) ??
				(await this.bytesOf(sessionId, held, offset, chunkEnd));
			chunks.push(new Uint8Array(part));
			await nextTurn();
		}
		signal?.throwIfAborted();
		return chunks;
	}

	private async whileHeld<T>(
		sessionId: string,
		record: StoredSession,
		held: HeldBytes,
		read: () => Promise<T>,
	): Promise<T | undefined> {
		try {
			return await read();
		} catch (error) {
			this.assertOpen();
			if (this.records.get(sessionId) !== record || record.file !== held.file) return undefined;
			throw error;
		}
	}

	private async settledRecord(sessionId: string): Promise<StoredSession> {
		for (;;) {
			const record = this.stored(sessionId);
			if (!record) throw new SessionNotFoundError(sessionId);
			if (record.spilling === undefined) return record;
			await settled(record.spilling);
		}
	}

	private held(record: StoredSession): HeldBytes {
		return {
			record,
			directory: record.directory,
			file: record.file,
			spilledBytes: record.spilledBytes,
			blocks: [...record.blocks],
			chunks: [...record.entries],
			lastSeq: record.lastSeq,
			totalBytes: record.totalBytes,
		};
	}

	private spanOf(held: HeldBytes, first: number, last: number): readonly [number, number] {
		const starts = held.record.starts;
		return [starts[first - 1] as number, last < held.lastSeq ? (starts[last] as number) - 1 : held.totalBytes];
	}

	private async entriesAt(
		sessionId: string,
		record: StoredSession,
		seqs: readonly number[],
	): Promise<SessionStoredEntry[] | undefined> {
		if (record.spilling !== undefined || this.records.get(sessionId) !== record) return undefined;
		const held = this.held(record);
		const runs = runsOf(seqs.filter((seq) => seq >= 1 && seq <= held.lastSeq));
		const entries: SessionStoredEntry[] = [];
		for (const [first, last] of runs) {
			const [start, end] = this.spanOf(held, first, last);
			let bytes: Uint8Array;
			try {
				bytes = await this.bytesOf(sessionId, held, start, end);
			} catch (error) {
				this.assertOpen();
				if (this.records.get(sessionId) !== record || record.file !== held.file) return undefined;
				throw error;
			}
			const parsed = this.parseRun(sessionId, held, bytes);
			if (parsed.length !== last - first + 1)
				throw new SessionSpillError("spill-corrupt", {
					directory: held.directory?.path ?? "",
					sessionId,
					bytes: held.spilledBytes,
				});
			for (const [offset, entry] of parsed.entries()) entries.push({ seq: first + offset, entry });
		}
		return entries;
	}

	private parseRun(sessionId: string, held: HeldBytes, bytes: Uint8Array): SessionEntry[] {
		try {
			return parseEntries(bytes);
		} catch (cause) {
			if (!(cause instanceof SyntaxError) || held.directory === undefined) throw cause;
			throw new SessionSpillError(
				"spill-corrupt",
				{ directory: held.directory.path, sessionId, bytes: held.spilledBytes },
				{ cause },
			);
		}
	}

	private async bytesOf(sessionId: string, held: HeldBytes, start: number, end: number): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		const heldStart = held.directory === undefined ? 0 : held.spilledBytes + 1;
		if (held.directory !== undefined && start < held.spilledBytes) {
			parts.push(await readSpilledRange(held, sessionId, start, Math.min(end, held.spilledBytes)));
			if (end > held.spilledBytes) parts.push(Uint8Array.of(COMMA));
		}
		if (end > heldStart) parts.push(heldSlice(held.chunks, Math.max(start, heldStart) - heldStart, end - heldStart));
		return parts.length === 1 ? (parts[0] as Uint8Array) : concatBytes(parts);
	}

	private async seqOfEntry(sessionId: string, record: StoredSession, entryId: string): Promise<number | undefined> {
		for (;;) {
			while (record.spilling !== undefined) await settled(record.spilling);
			const held = this.held(record);
			try {
				return await this.scanForEntry(sessionId, held, entryId);
			} catch (error) {
				this.assertOpen();
				if (this.records.get(sessionId) === record && record.file === held.file) throw error;
				if (this.records.get(sessionId) !== record) return undefined;
			}
		}
	}

	private async scanForEntry(sessionId: string, held: HeldBytes, entryId: string): Promise<number | undefined> {
		if (held.record.index.lastId === entryId && held.record.index.seq === held.lastSeq) return held.lastSeq;
		const needle = utf8Encoder.encode(`"id":${JSON.stringify(entryId)}`);
		let last = held.lastSeq;
		let window = SPILL_BLOCK_BYTES;
		while (last >= 1) {
			let first = last;
			while (first > 1) {
				const [start] = this.spanOf(held, first - 1, last);
				const [, end] = this.spanOf(held, last, last);
				if (end - start > window) break;
				first -= 1;
			}
			window = Math.min(SCAN_WINDOW_BYTES, window * 2);
			const [start, end] = this.spanOf(held, first, last);
			const bytes = Buffer.from(await this.bytesOf(sessionId, held, start, end));
			for (let seq = last; seq >= first; seq--) {
				const [entryStart, entryEnd] = this.spanOf(held, seq, seq);
				const line = bytes.subarray(entryStart - start, entryEnd - start);
				if (line.indexOf(needle) === -1) continue;
				const entry = this.parseRun(sessionId, held, line)[0];
				if (entry?.id === entryId) return seq;
			}
			last = first - 1;
		}
		return undefined;
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
			if (!matchesSessionIdPrefix(sessionId, query.idPrefix)) continue;
			const header = decodeHeader(record);
			if (!query.includeInternal && header.internal) continue;
			if (matchesCwd && !(await matchesCwd(header.cwd))) continue;
			this.assertOpen();
			query.signal?.throwIfAborted();
			if (query.withoutSearchText) {
				yield { ...materializeSessionSummaryMetadata(header, record.summaryState), searchText: "" };
				continue;
			}
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

	private forWrite(sessionId: string, options: SessionWriteOptions, expected?: StoredSession): StoredSession {
		const record = this.stored(sessionId);
		if (!record) throw new SessionNotFoundError(sessionId);
		if (expected !== undefined && record !== expected)
			throw new SessionConflictError(sessionId, options.expectSeq, record.lastSeq);
		if (
			options.expectSeq !== record.lastSeq ||
			(options.epoch !== undefined && record.index.epoch !== options.epoch)
		) {
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
			const { directory, file, spilledBytes, spilledChecksum } = record;
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
			return { header, entries: parseHistory(directory, sessionId, spilled, held, spilledChecksum), lastSeq };
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
			record.blocks = extendBlocks(record.blocks, record.spilledBytes, data);
			record.directory = directory;
			record.file = file;
			record.spilledBytes += data.byteLength;
			record.spilledChecksum = checksum(data, record.spilledChecksum);
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
		const headerBytes = this.encode(() => JSON.stringify(header));
		const encoded = entries.length === 0 ? undefined : this.encodeEntries(entries);
		const starts: number[] = [];
		let position = 0;
		for (const length of encoded?.lengths ?? []) {
			starts.push(position);
			position += length + 1;
		}
		return {
			header: headerBytes,
			entries: encoded === undefined ? [] : [encoded.bytes],
			summaryState: applySessionSummaryEntries(undefined, entries).state,
			lastSeq: entries.length,
			directory: undefined,
			file: 0,
			spilledBytes: 0,
			spilledChecksum: FNV_OFFSET,
			spilling: undefined,
			starts,
			totalBytes: Math.max(0, position - 1),
			index: foldSessionResume(undefined, entries),
			blocks: [],
		};
	}

	private encodeEntries(entries: readonly SessionEntry[]): {
		readonly bytes: Uint8Array;
		readonly lengths: readonly number[];
	} {
		let lengths: number[] = [];
		const bytes = this.encode(() => {
			const lines = entries.map((entry) => JSON.stringify(entry));
			lengths = lines.map((line) => Buffer.byteLength(line, "utf8"));
			return lines.join(",");
		});
		return { bytes, lengths };
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
	expectedChecksum: number,
): SessionEntry[] {
	let entries: SessionEntry[];
	try {
		entries = parseEntries(held.byteLength === 0 ? spilled : joinChunks([spilled, held]));
	} catch (cause) {
		if (!(cause instanceof SyntaxError)) throw cause;
		throw new SessionSpillError(
			"spill-corrupt",
			{ directory: directory.path, sessionId, bytes: spilled.byteLength },
			{ cause },
		);
	}
	if (checksum(spilled) !== expectedChecksum)
		throw new SessionSpillError("spill-corrupt", { directory: directory.path, sessionId, bytes: spilled.byteLength });
	return entries;
}

/** Cheap accidental-corruption detection, not an authentication tag. Updating only the append avoids re-reading history. */
function checksum(bytes: Uint8Array, previous = 0x811c9dc5): number {
	let hash = previous;
	for (let index = 0; index < bytes.byteLength; index++) hash = Math.imul(hash ^ (bytes[index] as number), 0x01000193);
	return hash >>> 0;
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

function bySeq(left: number, right: number): number {
	return left - right;
}

function seqRange(first: number, last: number): number[] {
	return last < first ? [] : Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

function runsOf(seqs: readonly number[]): (readonly [number, number])[] {
	const runs: [number, number][] = [];
	for (const seq of [...new Set(seqs)].sort(bySeq)) {
		const last = runs.at(-1);
		if (last !== undefined && last[1] === seq - 1) last[1] = seq;
		else runs.push([seq, seq]);
	}
	return runs;
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}
	return joined;
}

function heldSlice(chunks: readonly Uint8Array[], start: number, end: number): Uint8Array {
	const parts: Uint8Array[] = [];
	let offset = 0;
	for (const [index, chunk] of chunks.entries()) {
		if (index > 0) {
			if (offset >= start && offset < end) parts.push(Uint8Array.of(COMMA));
			offset += 1;
		}
		const chunkEnd = offset + chunk.byteLength;
		if (chunkEnd > start && offset < end)
			parts.push(chunk.subarray(Math.max(start, offset) - offset, Math.min(end, chunkEnd) - offset));
		offset = chunkEnd;
		if (offset >= end) break;
	}
	return parts.length === 1 ? (parts[0] as Uint8Array) : concatBytes(parts);
}

function extendBlocks(blocks: readonly number[], filled: number, data: Uint8Array): number[] {
	const next = [...blocks];
	let position = filled;
	for (let offset = 0; offset < data.byteLength; ) {
		const within = position % SPILL_BLOCK_BYTES;
		const take = Math.min(SPILL_BLOCK_BYTES - within, data.byteLength - offset);
		const previous = within === 0 ? FNV_OFFSET : (next.pop() as number);
		next.push(checksum(data.subarray(offset, offset + take), previous));
		position += take;
		offset += take;
	}
	return next;
}

async function readSpilledRange(held: HeldBytes, sessionId: string, start: number, end: number): Promise<Uint8Array> {
	const directory = held.directory as SessionHistoryDirectory;
	const fields = { directory: directory.path, sessionId, bytes: held.spilledBytes };
	if (directory.readRange === undefined) {
		const whole = await readSpillFile(directory, held.file, sessionId, held.spilledBytes);
		for (let block = 0; block < held.blocks.length; block++) verifyBlock(held, sessionId, whole, block, 0);
		return whole.subarray(start, end);
	}
	const first = Math.floor(start / SPILL_BLOCK_BYTES);
	const last = Math.floor((end - 1) / SPILL_BLOCK_BYTES);
	const from = first * SPILL_BLOCK_BYTES;
	const to = Math.min(held.spilledBytes, (last + 1) * SPILL_BLOCK_BYTES);
	let read: { readonly bytes: Uint8Array; readonly size: number };
	try {
		read = await directory.readRange(held.file, from, to - from);
	} catch (cause) {
		const errno = getErrnoCode(cause);
		throw new SessionSpillError(
			errno === "ENOENT" ? "spill-missing" : "spill-read-failed",
			{ ...fields, errno },
			{ cause },
		);
	}
	if (read.size !== held.spilledBytes || read.bytes.byteLength !== to - from)
		throw new SessionSpillError(read.size < held.spilledBytes ? "spill-missing" : "spill-corrupt", {
			...fields,
			foundBytes: read.size,
		});
	for (let block = first; block <= last; block++) verifyBlock(held, sessionId, read.bytes, block, from);
	return read.bytes.subarray(start - from, end - from);
}

function verifyBlock(held: HeldBytes, sessionId: string, bytes: Uint8Array, block: number, from: number): void {
	const start = block * SPILL_BLOCK_BYTES - from;
	const end = Math.min(held.spilledBytes, (block + 1) * SPILL_BLOCK_BYTES) - from;
	if (checksum(bytes.subarray(start, end)) !== held.blocks[block])
		throw new SessionSpillError("spill-corrupt", {
			directory: held.directory?.path ?? "",
			sessionId,
			bytes: held.spilledBytes,
		});
}

const nativeLoad = registerArchiveLoad(MemorySessionStore.prototype.load);

function heldSeqOf(record: StoredSession, entryId: string): number | undefined {
	if (record.index.lastId === entryId) return record.index.seq;
	const heldStart = record.directory === undefined ? 0 : record.spilledBytes + 1;
	const needle = Buffer.from(`"id":${JSON.stringify(entryId)}`);
	for (let seq = record.lastSeq; seq >= 1; seq--) {
		const start = record.starts[seq - 1] as number;
		if (start < heldStart) return undefined;
		const end = seq < record.lastSeq ? (record.starts[seq] as number) - 1 : record.totalBytes;
		const bytes = Buffer.from(heldSlice(record.entries, start - heldStart, end - heldStart));
		if (bytes.indexOf(needle) === -1) continue;
		if ((parseEntries(bytes)[0] as SessionEntry | undefined)?.id === entryId) return seq;
	}
	return undefined;
}
