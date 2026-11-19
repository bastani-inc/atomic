import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, createReadStream, rmdir as rmdirCallback, stat as statCallback } from "node:fs";
import {
	appendFile,
	copyFile,
	type FileHandle,
	link,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	stat,
	truncate,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { createSessionCwdMatcherAsync } from "../../../utils/canonical-path.ts";
import { readLines } from "../../../utils/lines.ts";
import type { SessionEntry } from "../../session-manager-types.ts";
import { branchStatePages } from "./branch-state-pages.js";
import { validateSessionEntryStructure } from "./entry-structure.js";
import { EntryTypeReader, JsonTextChecker } from "./entry-type.js";
import {
	SessionConflictError,
	SessionExistsError,
	SessionFormatVersionError,
	SessionIdMismatchError,
	SessionInvalidTextError,
	SessionInvalidTimestampError,
	type SessionJsonValue,
	SessionNotFoundError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";
import { registerForkScope } from "./fork-store-scope.js";
import type { SessionHistorySource } from "./history-pages.js";
import {
	isCurrentSessionHeader,
	legacyVersion,
	type StoredSessionHeader,
	upgradeLegacySessionEntries,
	upgradeLegacySessionEntry,
	upgradeLegacySessionHeader,
} from "./legacy-format.js";
import { summarizeLegacySession } from "./legacy-session-summary.js";
import {
	branchRanges,
	foldSessionResume,
	foreignResumeIds,
	isSessionResumeIndex,
	latestCompactionOf,
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
import type {
	ChildDisplayLaunch,
	ForkArchiveSource,
	OversizedSessionEntry,
	SessionBranchPageCut,
	SessionCompactionPoint,
	SessionEntriesPage,
	SessionEntriesQuery,
	SessionEntryAt,
	SessionEntryRange,
	SessionEntrySizes,
	SessionForkRow,
	SessionForkSeed,
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

interface SessionFileState {
	readonly stamp: string;
	readonly identity: string;
	readonly headerStamp: string;
	readonly headerId: string;
	readonly lastEntryId: string | undefined;
	readonly witness: Buffer;
	readonly size: number;
	readonly lastSeq: number;
	readonly terminated: boolean;
	/** The file goes on past `size` with the start of a line its writer never finished, which the next append removes. */
	readonly torn: boolean;
	readonly summaryState?: SessionSummaryState;
}

type JsonValue = SessionJsonValue;

interface JsonlIndex {
	readonly identity: string;
	readonly birthtimeNs: string;
	readonly headerStamp: string;
	readonly fileSize: number;
	readonly mtimeNs: string;
	readonly size: number;
	readonly witness: Buffer;
	readonly terminated: boolean;
	readonly torn: boolean;
	readonly spans: readonly number[];
	readonly ids: readonly number[];
	readonly index: SessionResumeIndex;
	readonly sidecarSize: number;
}

interface FileWindowInput {
	readonly handle: FileHandle;
	readonly legacy?: StoredSessionHeader;
}

interface IndexedSession {
	readonly path: string;
	readonly header: SessionRecordHeader;
	readonly jsonl: JsonlIndex;
}

export const JSONL_INDEX_VERSION = 2;
const SIDECAR_SUFFIX = ".idx";
const SIDECAR_REFRESH_BYTES = 1024 * 1024;
const INDEX_BATCH_ENTRIES = 512;
const READ_GAP_BYTES = 64 * 1024;
const SCAN_WINDOW_BYTES = 1024 * 1024;

/** The last 64 bytes, which locate the boundary a later append starts from. */
function witnessOf(bytes: Buffer): Buffer {
	return Buffer.from(bytes.subarray(-64));
}

/**
 * The entry on a last line that has no newline after it, or `undefined` when that line is torn: its writer stopped
 * before finishing it, so it was never acknowledged. Every entry line is a JSON object, and no part of an object's
 * text is itself valid JSON, so a line that parses is complete.
 */
function parseUnterminated(line: string): SessionEntry | undefined {
	try {
		return JSON.parse(line) as SessionEntry;
	} catch {
		return undefined;
	}
}

const RANGE_MARK_EVERY = 256;
const RANGE_PROBE_BYTES = 64 * 1024;
const RANGE_CHUNK_BYTES = 64 * 1024;
const RANGE_READ_ATTEMPTS = 3;
const TYPING_RETAIN_BYTES = 1024 * 1024;
const WITNESS_BYTES = 64;
const MARK_CHECK_READS = 32;
const STUB_ENTRY: SessionEntry = {
	type: "custom",
	id: "",
	parentId: null,
	timestamp: "1970-01-01T00:00:00.000Z",
	customType: "",
};

interface RangeMark {
	readonly seq: number;
	readonly offset: number;
	readonly prefixWitness: Buffer;
}

interface RangeIndex {
	readonly identity: string;
	readonly marks: RangeMark[];
	completeEnd: number;
	completeCount: number;
	total: { readonly size: number; readonly lastSeq: number } | undefined;
	witness: Buffer;
	witnessEnd: number;
	seenStamp: string;
	seenSize: number;
}

async function witnessAt(file: FileHandle, end: number): Promise<Buffer> {
	const from = Math.max(0, end - WITNESS_BYTES);
	return readFrom(file, from, end - from);
}

async function boundaryHolds(
	file: FileHandle,
	boundary: { readonly witness: Buffer; readonly witnessEnd: number },
): Promise<boolean> {
	if (boundary.witnessEnd === 0) return true;
	const witness = await witnessAt(file, boundary.witnessEnd).catch(() => undefined);
	return witness?.equals(boundary.witness) === true;
}

async function rangeIndexHolds(
	file: FileHandle,
	index: RangeIndex,
	marks: boolean,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	if (!(await boundaryHolds(file, index))) return false;
	if (!marks) return true;
	for (let at = 0; at < index.marks.length; at += MARK_CHECK_READS) {
		signal?.throwIfAborted();
		const batch = index.marks.slice(at, at + MARK_CHECK_READS);
		const heads = await Promise.all(
			batch.map((mark) => readFrom(file, mark.offset, mark.prefixWitness.length).catch(() => undefined)),
		);
		if (!heads.every((head, offset) => head?.equals(batch[offset]!.prefixWitness) === true)) return false;
	}
	return true;
}

function isBlankLine(line: Buffer): boolean {
	for (const byte of line) {
		if (byte > 0x20 && byte < 0x80) return false;
		if (byte >= 0x80) return line.toString("utf8").trim() === "";
	}
	return true;
}

function isBlankParts(parts: readonly Buffer[]): boolean {
	for (const part of parts) if (!isBlankLine(part)) return false;
	return true;
}

function hasVisibleAscii(bytes: Buffer): boolean {
	for (const byte of bytes) if (byte > 0x20 && byte < 0x80) return true;
	return false;
}

interface RangeCursor {
	readonly offset: number;
	readonly seq: number;
	readonly header: boolean;
	readonly changed?: boolean;
}

type LineAction = "read" | "pass";

interface LineVisitor {
	readonly skipTypes: readonly string[];
	begin(seq: number): LineAction | "inspect" | "stop";
	typed(seq: number, type: string | undefined): LineAction;
	end(seq: number, parts: readonly Buffer[] | undefined, byteLength: number, terminated: boolean): boolean;
}

async function scanSessionLines(
	file: FileHandle,
	size: number,
	atEnd: boolean,
	from: RangeCursor,
	index: RangeIndex,
	signal: AbortSignal | undefined,
	visitor: LineVisitor,
): Promise<RangeCursor> {
	if (from.offset >= size) return from;
	let { seq, header } = from;
	let tail: Buffer = Buffer.alloc(0);
	if (from.offset !== 0) {
		const start = await witnessAt(file, from.offset).catch(() => undefined);
		if (start === undefined) return { offset: from.offset, seq, header: false, changed: true };
		tail = start;
	}
	let chunk = Buffer.allocUnsafe(Math.min(RANGE_CHUNK_BYTES, size - from.offset));
	let retained = false;
	let position = from.offset;
	let lineOffset = from.offset;
	let lineBytes = 0;
	const linePrefix = Buffer.alloc(WITNESS_BYTES);
	let linePrefixBytes = 0;
	let parts: Buffer[] = [];
	let partsBytes = 0;
	let completeLineRetained = true;
	let reader: EntryTypeReader | undefined;
	let mode = (header ? "header" : "blank") as "header" | "blank" | "typing" | LineAction;
	const startLine = (offset: number): void => {
		lineOffset = offset;
		lineBytes = 0;
		linePrefixBytes = 0;
		parts = [];
		partsBytes = 0;
		completeLineRetained = true;
		reader = undefined;
		mode = header ? "header" : "blank";
	};
	const drop = (): void => {
		parts = [];
		partsBytes = 0;
		completeLineRetained = false;
	};
	const keep = (segment: Buffer): void => {
		if (!completeLineRetained) return;
		parts.push(segment);
		partsBytes += segment.length;
		retained = true;
	};
	const settle = (action: LineAction): void => {
		mode = action;
		reader = undefined;
		if (action === "pass") drop();
	};
	const judge = (inspecting: EntryTypeReader): void => {
		if (inspecting.decided) {
			settle(visitor.typed(seq, inspecting.finish()));
			return;
		}
		if (partsBytes > TYPING_RETAIN_BYTES) drop();
	};
	const classify = (): boolean => {
		const action = visitor.begin(seq + 1);
		if (action === "stop") return false;
		seq++;
		if (action !== "inspect") {
			settle(action);
			return true;
		}
		const inspecting = new EntryTypeReader(visitor.skipTypes);
		reader = inspecting;
		mode = "typing";
		for (const part of parts) if (inspecting.feed(part)) break;
		judge(inspecting);
		return true;
	};
	const take = (segment: Buffer): boolean => {
		lineBytes += segment.length;
		if (linePrefixBytes < linePrefix.length) linePrefixBytes += segment.copy(linePrefix, linePrefixBytes);
		if (mode === "header" || mode === "pass") return true;
		keep(segment);
		if (mode === "typing" && reader !== undefined) {
			reader.feed(segment);
			judge(reader);
			return true;
		}
		return mode !== "blank" || !hasVisibleAscii(segment) || classify();
	};
	const rereadLine = async (): Promise<boolean> => {
		const bytes = Buffer.alloc(Math.max(0, lineBytes));
		for (let read = 0; read < bytes.length; ) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(bytes, read, bytes.length - read, lineOffset + read);
			if (bytesRead === 0) return false;
			read += bytesRead;
		}
		parts = [bytes];
		partsBytes = lineBytes;
		completeLineRetained = true;
		return true;
	};
	const finishLine = (lineEnd: number): "next" | "stop-before" | "stop-after" | "reread" => {
		if (mode === "header") {
			header = false;
			return "next";
		}
		if (mode === "blank") {
			if (isBlankParts(parts)) return "next";
			if (!classify()) return "stop-before";
		}
		if (reader !== undefined) settle(visitor.typed(seq, reader.finish()));
		if (mode === "read" && !completeLineRetained) return "reread";
		if (seq % RANGE_MARK_EVERY === 1 && !index.marks.some((candidate) => candidate.seq === seq)) {
			index.marks.push({
				seq,
				offset: lineOffset,
				prefixWitness: Buffer.from(linePrefix.subarray(0, linePrefixBytes)),
			});
			index.marks.sort((a, b) => a.seq - b.seq);
		}
		if (seq > index.completeCount) {
			index.completeCount = seq;
			index.completeEnd = lineEnd;
		}
		return visitor.end(seq, mode === "read" ? parts : undefined, lineBytes, true) ? "stop-after" : "next";
	};
	const keepWitness = (bytes: Buffer, end: number | undefined): void => {
		if (end === undefined) return;
		index.witness =
			end >= WITNESS_BYTES
				? Buffer.from(bytes.subarray(end - WITNESS_BYTES, end))
				: Buffer.concat([tail, bytes.subarray(0, end)]).subarray(-WITNESS_BYTES);
		index.witnessEnd = index.completeEnd;
	};
	while (position < size) {
		signal?.throwIfAborted();
		if (retained) {
			chunk = Buffer.allocUnsafe(Math.min(RANGE_CHUNK_BYTES, size - position));
			retained = false;
		}
		const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - position), position);
		if (bytesRead === 0) return { offset: position, seq, header: false, changed: true };
		const bytes = chunk.subarray(0, bytesRead);
		let start = 0;
		let advancedAt: number | undefined;
		for (let newline = bytes.indexOf(10); newline !== -1; newline = bytes.indexOf(10, start)) {
			if (!take(bytes.subarray(start, newline))) {
				keepWitness(bytes, advancedAt);
				return { offset: lineOffset, seq, header: false };
			}
			start = newline + 1;
			const completeEnd = index.completeEnd;
			let outcome = finishLine(position + start);
			if (outcome === "reread") {
				if (!(await rereadLine())) return { offset: lineOffset, seq: seq - 1, header: false, changed: true };
				outcome = finishLine(position + start);
			}
			if (index.completeEnd !== completeEnd) advancedAt = start;
			if (outcome !== "next") {
				keepWitness(bytes, advancedAt);
				return outcome === "stop-before"
					? { offset: lineOffset, seq, header: false }
					: { offset: position + start, seq, header: false };
			}
			startLine(position + start);
		}
		if (start < bytes.length && !take(bytes.subarray(start))) {
			keepWitness(bytes, advancedAt);
			return { offset: lineOffset, seq, header: false };
		}
		keepWitness(bytes, advancedAt);
		tail =
			bytes.length >= WITNESS_BYTES
				? Buffer.from(bytes.subarray(bytes.length - WITNESS_BYTES))
				: Buffer.concat([tail, bytes]).subarray(-WITNESS_BYTES);
		position += bytesRead;
	}
	if (lineBytes === 0 || mode === "header") return { offset: position, seq, header };
	const counted = mode !== "blank";
	if (!atEnd) return { offset: lineOffset, seq: counted ? seq - 1 : seq, header: false };
	if (!counted && isBlankParts(parts)) return { offset: position, seq, header: false };
	const checker = new JsonTextChecker();
	if (completeLineRetained) for (const part of parts) checker.feed(part);
	else {
		const buffer = Buffer.allocUnsafe(Math.min(RANGE_CHUNK_BYTES, lineBytes));
		for (let at = 0; at < lineBytes; ) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, lineBytes - at), lineOffset + at);
			if (bytesRead === 0) return { offset: lineOffset, seq: counted ? seq - 1 : seq, header: false, changed: true };
			checker.feed(buffer.subarray(0, bytesRead));
			at += bytesRead;
		}
	}
	if (!checker.finish()) return { offset: position, seq: counted ? seq - 1 : seq, header: false };
	if (!counted && !classify()) return { offset: lineOffset, seq, header: false };
	if (reader !== undefined) settle(visitor.typed(seq, reader.finish()));
	if (mode === "read" && !completeLineRetained && !(await rereadLine()))
		return { offset: lineOffset, seq: counted ? seq - 1 : seq, header: false, changed: true };
	visitor.end(seq, mode === "read" ? parts : undefined, lineBytes, false);
	return { offset: position, seq, header: false };
}

/** Session files whose torn last line this process has already reported. */
const reportedTornFiles = new Set<string>();

function reportTornLine(path: string): void {
	if (reportedTornFiles.has(path)) return;
	reportedTornFiles.add(path);
	process.emitWarning(
		`Ignoring the unfinished last line of ${path}: the write that started it never completed. The next append removes it.`,
		{ code: "ATOMIC_SESSION_TORN_LINE" },
	);
}

/** One read takes the whole header line of any ordinary session; a longer line takes further reads of this size. */
const HEADER_READ_CHUNK_BYTES = 64 * 1024;
/** `"type":"session",`, which a header line carries before the fields of its record header. */
const HEADER_LINE_TYPE_BYTES = Buffer.byteLength('"type":"session",');

/** The bytes of the header line a session file with this record header stamp starts with, its newline included. */
function headerLineBytes(headerStamp: string): number {
	return Buffer.byteLength(headerStamp) + HEADER_LINE_TYPE_BYTES + 1;
}

export interface JsonlSessionFile {
	readonly location: string;
	readonly header: SessionRecordHeader;
	read(): Promise<SessionSnapshot>;
}

export { SessionFormatVersionError } from "./errors.js";

export class JsonlStoragePoisonedError extends Error {
	readonly location: string;
	override readonly cause: Error;
	readonly rollbackCause: Error;

	constructor(location: string, cause: Error, rollbackCause: Error) {
		super(`Session append and rollback failed at ${location}`, { cause });
		this.name = "JsonlStoragePoisonedError";
		this.location = location;
		this.cause = cause;
		this.rollbackCause = rollbackCause;
	}
}

/**
 * The file-system calls the session lock makes, replaceable so a test can fail the ones that only
 * fail on Windows. `rmdir` and `stat` are also what this store uses to clear a lock it could not release.
 */
export interface SessionLockFs {
	mkdir: typeof import("node:fs").mkdir;
	rmdir: typeof import("node:fs").rmdir;
	stat: typeof import("node:fs").stat;
	utimes: typeof import("node:fs").utimes;
	realpath: typeof import("node:fs").realpath;
}

/** Removing a lock directory fails with these on Windows while another handle, such as a scanner or indexer, holds it. */
const TRANSIENT_RELEASE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
/** Waits between attempts to take or remove the lock directory, about 1.5 s in all, far inside the lock's 10 s stale window. */
const LOCK_BACKOFF_MS = [10, 20, 50, 100, 200, 400, 700];

/** The name a session's file is created with: its creation time, then its id or the key of its id. */
const SESSION_FILE_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?Z_(.+)\.jsonl$/;

/** Internal exact-file input for a fork, not a way to open a live or writable session by ID. */
export const withForkFileWindow = Symbol("forkFileWindow");
/** Used only by the owner of a view opened at an explicit file path, not by ordinary directory listings. */
export const bindSessionFile = Symbol("bindSessionFile");

export class JsonlSessionStore implements SessionStore {
	private selectedFile?: { id: string; path: string };

	[bindSessionFile](id: string, path: string): void {
		this.selectedFile = { id, path: resolve(path) };
	}
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private poisoned: JsonlStoragePoisonedError | StorageUnavailableError | undefined;
	private readonly directory: string;
	private readonly fileStates = new Map<string, SessionFileState>();
	private readonly rangeIndexes = new Map<string, RangeIndex>();
	private readonly indexes = new Map<string, JsonlIndex>();

	private readonly exactDirectory: boolean;
	private readonly lockFs: SessionLockFs | undefined;
	/**
	 * Lock directories this store acquired and could not remove, by path, with the modification time they had
	 * then. Nothing refreshes them any more, so another process may take them only once they are stale; until
	 * then the store removes its own, recognised by that time, rather than waiting out the stale window.
	 */
	private readonly unreleased = new Map<string, number>();

	private constructor(directory: string, exactDirectory: boolean, lockFs?: SessionLockFs) {
		this.exactDirectory = exactDirectory;
		this.directory = resolve(directory);
		registerForkScope(this, () => ({ kind: "jsonl", directory: this.directory, exact: this.exactDirectory }));
		this.lockFs = lockFs;
	}

	static async open(
		directory: string,
		options?: { exactDirectory?: boolean; scanExisting?: boolean; lockFs?: SessionLockFs },
	): Promise<JsonlSessionStore> {
		const store = new JsonlSessionStore(directory, options?.exactDirectory === true, options?.lockFs);
		await store.run(() => mkdir(store.directory, { recursive: true }).then(() => {}), false);
		if (options?.scanExisting !== false) {
			await store.run(async () => {
				for (const path of await store.paths()) {
					try {
						await store.readSnapshot(path);
					} catch {
						store.fileStates.delete(path);
					}
				}
			});
		}
		return store;
	}

	locationFor(header: SessionRecordHeader): string {
		const projectName = `--${resolve(header.cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`;
		const project = this.exactDirectory
			? this.directory
			: join(this.directory, Buffer.byteLength(projectName) <= 180 ? projectName : `--${this.key(header.cwd)}--`);
		return join(project, `${header.createdAt.replace(/[:.]/g, "-")}_${this.key(header.id)}.jsonl`);
	}

	get descriptor(): StorageDescriptor {
		return { adapter: "jsonl", location: this.directory };
	}

	create(
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		location?: string,
	): Promise<SessionWriteResult> {
		return this.run(async () => {
			validateSessionHeader(header);
			validateSessionEntries(entries);
			if (await this.claimed(header.id)) throw new SessionExistsError(header.id);
			const payload = this.encode(header, entries);
			const path = location === undefined ? this.locationFor(header) : resolve(location);
			await mkdir(resolve(path, ".."), { recursive: true });
			const temporary = `${path}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, payload, { flag: "wx" });
				try {
					await link(temporary, path);
				} catch (cause) {
					if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new SessionExistsError(header.id);
					throw cause;
				}
			} finally {
				await unlink(temporary).catch((cause: NodeJS.ErrnoException) => {
					if (cause.code !== "ENOENT") throw cause;
				});
			}
			const state = this.contentState(header, entries, payload);
			const stats = await this.remember(path, state);
			// Only successful creation of a new generation of the bound ID moves this handle's association.
			if (this.selectedFile?.id === header.id) this.selectedFile = { id: header.id, path };
			return { lastSeq: entries.length, epoch: epochOf(stats, state.headerStamp) };
		}, true);
	}

	async createFork(
		header: SessionRecordHeader,
		entries: SessionForkSeed,
		source: ForkArchiveSource,
		location?: string,
	): Promise<SessionWriteResult | undefined> {
		if (this.create !== JsonlSessionStore.prototype.create) return undefined;
		validateSessionHeader(header);
		if (!("read" in entries)) validateSessionEntries(entries);
		const path = location === undefined ? this.locationFor(header) : resolve(location);
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		const handle = await open(temporary, "wx+");
		try {
			const spans: number[] = [],
				ids: number[] = [];
			const { encodedForkRow } = await import("./fork-row-bytes.js");
			const { foldForkRow, findForkRow } = await import("./fork-row-index.js");
			const lookup = (id: string) =>
				findForkRow(id, ids, async function* (seq) {
					const end = spans[2 * seq - 1]!;
					for (let i = spans[2 * seq - 2]!; i < end; i += SESSION_HISTORY_CHUNK_BYTES)
						yield await readFrom(handle, i, Math.min(end - i, SESSION_HISTORY_CHUNK_BYTES));
				});
			const stream = "read" in entries;
			let summary = applySessionSummaryEntries(undefined, stream ? [] : entries).state;
			let index = foldSessionResume(undefined, stream ? [] : entries);
			let lastId: string | undefined;
			const rows: AsyncIterable<SessionForkRow> | Iterable<SessionForkRow> = stream
				? entries.read(source.store, async (id) => (await lookup(id)) !== undefined)
				: entries.map((entry) => ({ entry, reference: source.receipts.get(entry.id) }));
			const line = this.encode(header, []);
			let size = Buffer.byteLength(line);
			let witness: Buffer;
			try {
				await handle.writeFile(line);
				for await (const row of rows) {
					const start = size;
					const encoded = await encodedForkRow(source.store, row);
					for await (const part of encoded.chunks()) {
						await handle.writeFile(part);
						size += part.byteLength;
					}
					if (stream) {
						summary = applySessionSummaryEntries(summary, [row.entry]).state;
						index = await foldForkRow(index, row, lookup);
					}
					lastId = row.entry.id;
					ids.push(idHash(lastId));
					spans.push(start, size);
					await handle.writeFile("\n");
					size++;
				}
				witness = await witnessAt(handle, size);
			} finally {
				await handle.close();
			}
			// Reading a source through this directory's own queue must finish before taking its write lock.
			return await this.run(async () => {
				if (await this.claimed(header.id)) throw new SessionExistsError(header.id);
				try {
					await link(temporary, path);
				} catch (cause) {
					if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new SessionExistsError(header.id);
					throw cause;
				}
				const headerStamp = JSON.stringify(header);
				const stats = await this.remember(path, {
					headerStamp,
					headerId: header.id,
					lastSeq: ids.length,
					lastEntryId: lastId,
					terminated: true,
					torn: false,
					witness,
					summaryState: summary,
				});
				const epoch = epochOf(stats, headerStamp);
				await this.keepIndex(path, {
					identity: `${stats.dev}:${stats.ino}`,
					birthtimeNs: String(stats.birthtimeNs),
					headerStamp,
					fileSize: size,
					mtimeNs: String(stats.mtimeNs),
					size,
					witness,
					terminated: true,
					torn: false,
					spans,
					ids,
					index: { ...index, epoch },
					sidecarSize: 0,
				});
				return { lastSeq: ids.length, epoch };
			}, true);
		} finally {
			await unlink(temporary);
		}
	}

	append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		return this.run(async () => {
			const { path, state } = await this.forWrite(sessionId, options);
			validateSessionEntries(entries);
			if (entries.length === 0) return { lastSeq: state.lastSeq };
			if (state.torn) await truncate(path, state.size);
			const lines = entries.map((entry) => JSON.stringify(entry));
			let payload = `${lines.join("\n")}\n`;
			if (!state.terminated) payload = `\n${payload}`;
			const offset = state.size;
			if (entries.some((entry) => entry.type === "compaction")) {
				await copyFile(
					path,
					`${path}.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID()}.compact.bak`,
				);
			}
			try {
				await appendFile(path, payload);
			} catch (cause) {
				try {
					await truncate(path, offset);
				} catch (rollbackCause) {
					this.poisoned = new JsonlStoragePoisonedError(path, cause as Error, rollbackCause as Error);
					throw this.poisoned;
				}
				throw cause;
			}
			const lastSeq = state.lastSeq + entries.length;
			const appended = await this.remember(path, {
				...state,
				lastSeq,
				lastEntryId: entries.at(-1)?.id,
				terminated: true,
				torn: false,
				witness: witnessOf(Buffer.concat([state.witness, Buffer.from(payload)])),
				...(state.summaryState === undefined
					? {}
					: { summaryState: applySessionSummaryEntries(state.summaryState, entries).state }),
			});
			const rangeIndex = this.rangeIndexes.get(path);
			if (rangeIndex?.seenStamp === state.stamp) {
				rangeIndex.seenStamp = this.stamp(appended);
				rangeIndex.seenSize = Number(appended.size);
			}
			await this.indexAppended(path, state, entries, lines, offset + (state.terminated ? 0 : 1));
			return { lastSeq };
		});
	}

	replace(
		sessionId: string,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<SessionWriteResult> {
		return this.run(async () => {
			const { path } = await this.forWrite(sessionId, options);
			validateSessionHeader(header);
			validateSessionEntries(entries);
			if (header.id !== sessionId) throw new SessionIdMismatchError(sessionId, header.id);
			return { lastSeq: entries.length, epoch: await this.commit(path, header, entries) };
		});
	}

	updateHeader(header: SessionRecordHeader, options: SessionWriteOptions): Promise<SessionWriteResult> {
		return this.run(async () => {
			validateSessionHeader(header);
			const { path, state } = await this.forWrite(header.id, options);
			const temporary = `${path}.${randomUUID()}.tmp`;
			const output = await open(temporary, "wx+", 0o600);
			try {
				let witness: Buffer;
				try {
					await output.writeFile(this.encode(header, []));
					let inHeader = true;
					const source = createReadStream(path, { end: state.size - 1 });
					for await (const chunk of source as AsyncIterable<Buffer>) {
						if (!inHeader) await output.writeFile(chunk);
						else {
							const newline = chunk.indexOf(10);
							if (newline >= 0) {
								inHeader = false;
								await output.writeFile(chunk.subarray(newline + 1));
							}
						}
					}
					witness = await witnessAt(output, (await output.stat()).size);
					await output.chmod((await stat(path)).mode & 0o7777);
				} finally {
					await output.close();
				}
				await this.forgetIndex(path);
				await rename(temporary, path);
				const headerStamp = JSON.stringify(header);
				const stats = await this.remember(path, {
					...state,
					headerStamp,
					witness,
					torn: false,
					terminated: state.lastSeq === 0 || state.terminated,
				});
				return { lastSeq: state.lastSeq, epoch: epochOf(stats, headerStamp) };
			} finally {
				await unlink(temporary).catch((cause: NodeJS.ErrnoException) => {
					if (cause.code !== "ENOENT") throw cause;
				});
			}
		});
	}

	private async commit(path: string, header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<string> {
		await this.forgetIndex(path);
		const payload = this.encode(header, entries);
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, payload, { flag: "wx" });
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch((cause: NodeJS.ErrnoException) => {
				if (cause.code !== "ENOENT") throw cause;
			});
		}
		const state = this.contentState(header, entries, payload);
		return epochOf(await this.remember(path, state), state.headerStamp);
	}

	load(sessionId: string): Promise<SessionSnapshot> {
		return this.run(async () => {
			const located = await this.locate(sessionId);
			if (!located) throw new SessionNotFoundError(sessionId);
			return this.readPersisted(located.path, located.stored);
		});
	}

	readEntryRange(sessionId: string, query: SessionEntriesQuery): Promise<SessionEntriesPage> {
		return this.run(
			async () => {
				query.signal?.throwIfAborted();
				const located = await this.locate(sessionId);
				if (!located) throw new SessionNotFoundError(sessionId);
				return this.readRangeOf(located.path, query, sessionId, located.state);
			},
			false,
			query.signal,
		);
	}

	readFileEntryRange(path: string, query: SessionEntriesQuery): Promise<SessionEntriesPage> {
		return this.run(
			async () => {
				query.signal?.throwIfAborted();
				return this.readRangeOf(resolve(path), query);
			},
			false,
			query.signal,
		);
	}

	private async readRangeOf(
		path: string,
		query: SessionEntriesQuery,
		sessionId?: string,
		state?: SessionFileState,
	): Promise<SessionEntriesPage> {
		let file: FileHandle;
		try {
			file = await open(path, "r");
		} catch (cause) {
			if (sessionId !== undefined && (cause as NodeJS.ErrnoException).code === "ENOENT")
				throw new SessionNotFoundError(sessionId);
			throw cause;
		}
		try {
			for (let attempt = 1; ; attempt++) {
				const stats = await file.stat({ bigint: true });
				const stored = await readFirstLineFrom(file, HEADER_READ_CHUNK_BYTES, 0);
				await this.readHeaderAt(path, stored);
				if (sessionId !== undefined && stored.id !== sessionId) throw new SessionNotFoundError(sessionId);
				const { page, boundary, changed } = await this.readRangeFrom(file, path, query, stored, stats, state);
				if (!changed) {
					const after = await file.stat({ bigint: true });
					if (this.stamp(after) === this.stamp(stats)) return page;
					const index = this.rangeIndexes.get(path);
					if (
						index !== undefined &&
						after.size > stats.size &&
						(await boundaryHolds(file, boundary)) &&
						(await rangeIndexHolds(file, index, true, query.signal))
					) {
						index.seenStamp = this.stamp(after);
						index.seenSize = Number(after.size);
						return page;
					}
				}
				this.rangeIndexes.delete(path);
				if (attempt === RANGE_READ_ATTEMPTS) throw new Error(`${path} changed while it was being read`);
				query.signal?.throwIfAborted();
			}
		} finally {
			await file.close();
		}
	}

	private async readRangeFrom(
		file: FileHandle,
		path: string,
		query: SessionEntriesQuery,
		stored: StoredSessionHeader,
		stats: BigIntStats,
		state: SessionFileState | undefined,
	): Promise<{
		readonly page: SessionEntriesPage;
		readonly boundary: { witness: Buffer; witnessEnd: number };
		readonly changed: boolean;
	}> {
		const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}:${JSON.stringify(stored)}`;
		const size = Number(stats.size);
		const stamp = this.stamp(stats);
		let index = this.rangeIndexes.get(path);
		if (
			index === undefined ||
			index.identity !== identity ||
			(index.seenStamp !== stamp && index.seenSize >= size) ||
			index.completeEnd > size ||
			!(await rangeIndexHolds(file, index, index.seenStamp !== stamp, query.signal))
		) {
			index = {
				identity,
				marks: [],
				completeEnd: 0,
				completeCount: 0,
				total: undefined,
				witness: Buffer.alloc(0),
				witnessEnd: 0,
				seenStamp: stamp,
				seenSize: size,
			};
			this.rangeIndexes.set(path, index);
		}
		index.seenStamp = stamp;
		index.seenSize = size;
		if (index.total?.size !== size) index.total = undefined;
		const matchedState = state ?? this.fileStates.get(path);
		if (matchedState !== undefined && matchedState.stamp === stamp) {
			index.total = { size, lastSeq: matchedState.lastSeq };
			if (index.completeCount < matchedState.lastSeq) {
				index.completeEnd = matchedState.size;
				index.completeCount = matchedState.lastSeq;
				index.witness = matchedState.witness;
				index.witnessEnd = matchedState.size;
			}
		}
		const boundary = { witness: index.witness, witnessEnd: index.witnessEnd };
		const legacyHeader = isCurrentSessionHeader(stored) ? undefined : stored;
		const fromSeq = Math.max(1, query.fromSeq);
		const reads = fromSeq <= query.toSeq && (query.maxChars === undefined || query.maxChars > 0);
		const entries: SessionEntryAt[] = [];
		let stopped: number | undefined;
		let changed = false;
		if (reads) {
			let cursor: RangeCursor = { offset: 0, seq: 0, header: true };
			if (fromSeq > index.completeCount && index.completeEnd > 0)
				cursor = { offset: index.completeEnd, seq: index.completeCount, header: false };
			else {
				const mark = index.marks.findLast((candidate) => candidate.seq <= fromSeq);
				if (mark) cursor = { offset: mark.offset, seq: mark.seq - 1, header: false };
			}
			const skipTypes = query.skipTypes ?? [];
			let chars = 0;
			cursor = await scanSessionLines(file, size, true, cursor, index, query.signal, {
				skipTypes,
				begin: (seq) => {
					if (seq < fromSeq) return "pass";
					if (seq > query.toSeq) return "stop";
					return skipTypes.length === 0 ? "read" : "inspect";
				},
				typed: (_seq, type) => (type !== undefined && skipTypes.includes(type) ? "pass" : "read"),
				end: (seq, parts, byteLength) => {
					if (seq < fromSeq) return false;
					if (parts !== undefined) {
						if (query.largeEntryBytes !== undefined && byteLength > query.largeEntryBytes) {
							entries.push(
								legacyHeader === undefined
									? { seq, entry: STUB_ENTRY, rawChunks: parts }
									: {
											seq,
											entry: STUB_ENTRY,
											rawChunks: parts,
											rawFormatVersion: legacyVersion(legacyHeader, path),
										},
							);
						} else {
							const text = (parts.length === 1 ? parts[0]! : Buffer.concat(parts)).toString("utf8");
							const raw = JSON.parse(text) as SessionEntry;
							const parsed =
								legacyHeader === undefined ? raw : upgradeLegacySessionEntry(legacyHeader, raw, seq, path);
							if (!skipTypes.includes(parsed.type)) entries.push({ seq, entry: parsed });
						}
						chars += byteLength;
						if (query.maxChars !== undefined && chars >= query.maxChars && seq < query.toSeq) {
							stopped = seq;
							return true;
						}
					}
					return seq >= query.toSeq;
				},
			});
			changed = cursor.changed === true;
			if (!changed && cursor.offset >= size) index.total = { size, lastSeq: cursor.seq };
		} else if (index.total === undefined) {
			const start: RangeCursor =
				index.completeEnd > 0
					? { offset: index.completeEnd, seq: index.completeCount, header: false }
					: { offset: 0, seq: 0, header: true };
			const end = Math.min(
				size,
				start.offset + Math.max(0, Math.min(query.maxChars ?? RANGE_PROBE_BYTES, RANGE_PROBE_BYTES)),
			);
			const probe = await scanSessionLines(file, end, end === size, start, index, query.signal, {
				skipTypes: [],
				begin: () => "pass",
				typed: () => "pass",
				end: () => false,
			});
			changed = probe.changed === true;
			if (!changed && end === size) index.total = { size, lastSeq: probe.seq };
		}
		if (!changed && index.witnessEnd !== index.completeEnd) {
			index.witness = await witnessAt(file, index.completeEnd);
			index.witnessEnd = index.completeEnd;
		}
		const lastSeq = index.total?.lastSeq ?? Number.POSITIVE_INFINITY;
		if (!reads) return { page: { lastSeq, entries, throughSeq: fromSeq - 1 }, boundary, changed };
		return {
			page: { lastSeq, entries, throughSeq: Math.max(stopped ?? Math.min(query.toSeq, lastSeq), fromSeq - 1) },
			boundary,
			changed,
		};
	}

	loadFile(path: string): Promise<SessionSnapshot> {
		return this.run(() => this.readPersisted(resolve(path)));
	}

	readHeaderFile(path: string): Promise<SessionRecordHeader> {
		return this.run(() => this.readHeaderAt(resolve(path)));
	}

	readTail(sessionId: string, fromSeq: number): Promise<SessionTail> {
		return this.run(async () => {
			const { path, header, jsonl } = await this.indexed(sessionId);
			const start = Math.max(1, fromSeq);
			const read = await this.entriesAt(path, jsonl, [
				...stateSeqsBefore(jsonl.index, start),
				...seqRange(start, jsonl.index.seq),
			]);
			const state = read.filter((held) => held.seq < start);
			const tail = read.filter((held) => held.seq >= start).map((held) => held.entry);
			return sessionTailFrom(jsonl.index, header, start, state, tail);
		});
	}

	readChildDisplayCut(sessionId: string, launch: ChildDisplayLaunch) {
		return this.run(async () => {
			const { childDisplayCut } = await import("./card-view.js");
			const { path, jsonl } = await this.indexed(sessionId);
			const found =
				typeof launch.launchLeafId === "string"
					? await this.seqInFile(path, jsonl, launch.launchLeafId)
					: undefined;
			return childDisplayCut(jsonl.index, launch, found);
		});
	}

	/** Bind a short-lived archive reader to this exact file, including for duplicate exported IDs. */
	static async withFileReader<T>(path: string, read: (store: SessionStore, id: string) => Promise<T>): Promise<T> {
		const input = resolve(path);
		const store = await JsonlSessionStore.open(dirname(input), { exactDirectory: true, scanExisting: false });
		try {
			const { id } = await store.readHeaderFile(input);
			store[bindSessionFile](id, input);
			return await read(store, id);
		} finally {
			await store.close();
		}
	}

	readBranchSpan(sessionId: string, cut: SessionBranchPageCut) {
		return this.run(async () => transcriptBranchSpan(sessionId, (await this.indexed(sessionId)).jsonl.index, cut));
	}

	readEntrySizes(sessionId: string, startSeq: number, endSeq: number): Promise<SessionEntrySizes> {
		return this.run(async () => {
			const { jsonl } = await this.indexed(sessionId);
			const start = Math.max(1, startSeq);
			const seqs = seqRange(start, Math.min(endSeq, jsonl.index.seq, start + SESSION_HISTORY_PAGE_ENTRIES - 1));
			return {
				epoch: jsonl.index.epoch,
				lastSeq: jsonl.index.seq,
				sizes: seqs.map((seq) => ({ seq, bytes: spanEnd(jsonl, seq) - spanStart(jsonl, seq) })),
			};
		});
	}

	readEntryChunk(reference: OversizedSessionEntry, offset: number): Promise<Uint8Array> {
		return this.run(async () => {
			const { path, jsonl } = await this.indexed(reference.sessionId);
			if (jsonl.index.epoch !== reference.epoch)
				throw new SessionConflictError(reference.sessionId, reference.seq, jsonl.index.seq);
			const start = spanStart(jsonl, reference.seq) + offset;
			return readBytes(path, start, Math.min(SESSION_HISTORY_CHUNK_BYTES, spanEnd(jsonl, reference.seq) - start));
		});
	}

	readRange(sessionId: string, startSeq: number, endSeq: number, expectedEpoch?: string): Promise<SessionEntryRange> {
		return this.run(async () => {
			const { path, jsonl } = await this.indexed(sessionId);
			if (expectedEpoch !== undefined && expectedEpoch !== jsonl.index.epoch)
				throw new SessionConflictError(sessionId, endSeq, jsonl.index.seq);
			const start = Math.max(1, startSeq);
			const seqs = seqRange(start, Math.min(endSeq, jsonl.index.seq));
			const read = await this.entriesAt(path, jsonl, seqs);
			return {
				startSeq: start,
				entries: read.map((held) => held.entry),
				lastSeq: jsonl.index.seq,
				epoch: jsonl.index.epoch,
				seqs,
				lastEntryId: jsonl.index.lastId,
			};
		});
	}

	findLatestCompaction(sessionId: string, leafId?: string): Promise<SessionCompactionPoint | undefined> {
		return this.run(async () => {
			if (leafId !== undefined) validateSessionText("entry.id", leafId);
			const { path, jsonl } = await this.indexed(sessionId);
			const leafSeq =
				leafId === undefined ? jsonl.index.leafSeq : ((await this.seqInFile(path, jsonl, leafId)) ?? -1);
			const point = latestCompactionOf(jsonl.index, leafSeq);
			if (point === undefined) return undefined;
			const read = await this.entriesAt(path, jsonl, [point.seq, leafSeq]);
			const boundary = read.find((held) => held.seq === point.seq)?.entry;
			const leaf = read.find((held) => held.seq === leafSeq)?.entry;
			if (boundary?.type !== "compaction" || leaf === undefined) return undefined;
			return { ...point, entry: boundary, leafId: leaf.id, lastSeq: jsonl.index.seq };
		});
	}

	/** Read the window of this exact export file, not another file in the directory with the same session ID.
	 * An export is an input: do not create or rewrite a sidecar beside it. */
	[withForkFileWindow]<T>(
		file: string,
		use: (resume: SessionResume, history: SessionHistorySource) => Promise<T>,
	): Promise<T> {
		return this.run(async () => {
			const path = resolve(file);
			const handle = await open(path, "r");
			try {
				const stats = await handle.stat({ bigint: true });
				const stored = await readFirstLineFrom(handle, HEADER_READ_CHUNK_BYTES, 0);
				const header = await this.readHeaderAt(path, stored);
				const input: FileWindowInput = { handle, legacy: isCurrentSessionHeader(stored) ? undefined : stored };
				const jsonl = await this.buildIndex(path, JSON.stringify(header), stats, input);
				const resume = await this.windowFromIndex(path, header, jsonl, jsonl.index, input);
				const { epoch, lastSeq } = resume;
				const result = await use(resume, {
					descriptor: this.descriptor,
					readEntrySizes: async (_id, from, to) => ({
						epoch,
						lastSeq,
						sizes: seqRange(from, Math.min(lastSeq, to, from + SESSION_HISTORY_PAGE_ENTRIES - 1)).map((seq) => ({
							seq,
							bytes: spanEnd(jsonl, seq) - spanStart(jsonl, seq),
						})),
					}),
					readEntryChunk: (ref, offset) =>
						readFrom(
							handle,
							spanStart(jsonl, ref.seq) + offset,
							Math.min(
								SESSION_HISTORY_CHUNK_BYTES,
								spanEnd(jsonl, ref.seq) - spanStart(jsonl, ref.seq) - offset,
							),
						),
					readRange: async (_id, from, to) => ({
						epoch,
						lastSeq,
						startSeq: from,
						entries: (await this.entriesAt(path, jsonl, seqRange(from, Math.min(lastSeq, to)), input)).map(
							(held) => held.entry,
						),
					}),
				});
				const after = await handle.stat({ bigint: true });
				if (stats.size !== after.size || stats.mtimeNs !== after.mtimeNs || stats.ctimeNs !== after.ctimeNs)
					throw new SessionConflictError(header.id, lastSeq, lastSeq);
				return result;
			} finally {
				await handle.close();
			}
		}, false);
	}

	readForkWindow(sessionId: string, entryId: string, options?: { readonly archivedReceipts: true }) {
		return this.run(async () => {
			const { indexedForkWindow, rangedForkMetadata, scanForkRecords } = await import("./fork-window.js");
			for (;;) {
				const { path, header, jsonl } = await this.indexed(sessionId);
				const file = await open(path, "r");
				try {
					const stat = await file.stat({ bigint: true });
					if (
						`${stat.dev}:${stat.ino}` !== jsonl.identity ||
						String(stat.birthtimeNs) !== jsonl.birthtimeNs ||
						String(stat.mtimeNs) !== jsonl.mtimeNs
					)
						continue;
					const leaf = (await this.seqInFile(path, jsonl, entryId, file)) ?? 0;
					const many = (seqs: readonly number[]) => this.entriesAt(path, jsonl, seqs, { handle: file });
					const metadata = rangedForkMetadata(
						(seq) => [spanStart(jsonl, seq), spanEnd(jsonl, seq)],
						(start, n) => readFrom(file, start, n),
					);
					return await indexedForkWindow(
						header,
						jsonl.index,
						leaf,
						(lo, hi) => many(seqRange(lo, hi)),
						many,
						metadata,
						scanForkRecords(metadata),
						options,
					);
				} finally {
					await file.close();
				}
			}
		});
	}

	readResume(sessionId: string, leafId?: string): Promise<SessionResume> {
		return this.run(async () => {
			if (leafId !== undefined) validateSessionText("entry.id", leafId);
			const { path, header, jsonl } = await this.indexed(sessionId);
			const leafSeq =
				leafId === undefined ? jsonl.index.leafSeq : ((await this.seqInFile(path, jsonl, leafId)) ?? 0);
			const index =
				leafSeq === jsonl.index.leafSeq
					? jsonl.index
					: await selectResumeLeaf(
							jsonl.index,
							leafSeq,
							branchStatePages(jsonl.index.seq, {
								bytes: (seq) => spanEnd(jsonl, seq) - spanStart(jsonl, seq),
								read: (seqs) => this.entriesAt(path, jsonl, seqs),
								chunk: (seq, offset, length) => readBytes(path, spanStart(jsonl, seq) + offset, length),
							}),
						);
			const result = await this.windowFromIndex(path, header, jsonl, index);
			if (leafSeq !== jsonl.index.leafSeq) {
				const stats = await stat(path, { bigint: true });
				if (
					`${stats.dev}:${stats.ino}` !== jsonl.identity ||
					String(stats.mtimeNs) !== jsonl.mtimeNs ||
					Number(stats.size) !== jsonl.fileSize
				)
					throw new SessionConflictError(sessionId, index.seq, index.seq);
			}
			return result;
		});
	}

	private async windowFromIndex(
		path: string,
		header: SessionRecordHeader,
		jsonl: JsonlIndex,
		index = jsonl.index,
		input?: FileWindowInput,
	): Promise<SessionResume> {
		const plan = sessionResumePlan(index);
		const branchSeqs = plan.branch.flatMap(([low, high]) => seqRange(low, high));
		const read = await this.entriesAt(path, jsonl, [...branchSeqs, ...plan.state], input);
		const inBranch = new Set(branchSeqs);
		const branch = read.filter((held) => inBranch.has(held.seq));
		const state = read.filter((held) => !inBranch.has(held.seq));
		const leaf = index.leafSeq > 0 ? (branch.find((held) => held.seq === index.leafSeq)?.entry.id ?? null) : null;
		return sessionResumeFrom(index, header, branch, state, leaf);
	}

	findEntrySeq(sessionId: string, entryId: string): Promise<number | undefined> {
		return this.run(async () => {
			validateSessionText("entry.id", entryId);
			const { path, jsonl } = await this.indexed(sessionId);
			return this.seqInFile(path, jsonl, entryId);
		});
	}

	private async indexed(sessionId: string): Promise<IndexedSession> {
		let located = await this.locate(sessionId);
		if (!located) throw new SessionNotFoundError(sessionId);
		if (!isCurrentSessionHeader(located.stored)) {
			await this.readPersisted(located.path, located.stored);
			located = await this.locate(sessionId);
			if (!located) throw new SessionNotFoundError(sessionId);
			if (!isCurrentSessionHeader(located.stored))
				throw new SessionFormatVersionError(located.path, located.stored.version);
		}
		const { path, header } = located;
		const jsonl = await this.indexFor(path, header);
		await this.remember(
			path,
			{
				headerStamp: jsonl.headerStamp,
				headerId: header.id,
				lastSeq: jsonl.index.seq,
				lastEntryId: jsonl.index.lastId ?? undefined,
				witness: jsonl.witness,
				terminated: jsonl.terminated,
				torn: jsonl.torn,
			},
			jsonl.torn ? jsonl.size : undefined,
		);
		return { path, header, jsonl };
	}

	private async indexFor(path: string, header: SessionRecordHeader): Promise<JsonlIndex> {
		const stats = await stat(path, { bigint: true });
		const identity = `${stats.dev}:${stats.ino}`;
		const headerStamp = JSON.stringify(header);
		const cached = this.indexes.get(path) ?? (await readSidecar(path));
		if (
			cached !== undefined &&
			cached.identity === identity &&
			cached.birthtimeNs === String(stats.birthtimeNs) &&
			cached.headerStamp === headerStamp
		) {
			const fileSize = Number(stats.size);
			if (
				cached.fileSize === fileSize &&
				cached.mtimeNs === String(stats.mtimeNs) &&
				(await witnessHolds(path, cached))
			) {
				this.indexes.set(path, cached);
				return cached;
			}
			if (fileSize > cached.size && (await witnessHolds(path, cached))) {
				const grown = await this.catchUp(path, cached, stats);
				if (grown !== undefined) return this.keepIndex(path, grown);
			}
		}
		return this.keepIndex(path, await this.buildIndex(path, headerStamp, stats));
	}

	private async keepIndex(path: string, jsonl: JsonlIndex): Promise<JsonlIndex> {
		const written = await writeSidecar(path, jsonl);
		const kept = written ? { ...jsonl, sidecarSize: jsonl.size } : jsonl;
		this.indexes.set(path, kept);
		return kept;
	}

	private async forgetIndex(path: string): Promise<void> {
		this.indexes.delete(path);
		await unlink(`${path}${SIDECAR_SUFFIX}`).catch((cause: NodeJS.ErrnoException) => {
			if (cause.code !== "ENOENT") throw cause;
		});
	}

	private async buildIndex(
		path: string,
		headerStamp: string,
		stats: BigIntStats,
		input?: FileWindowInput,
	): Promise<JsonlIndex> {
		const identity = `${stats.dev}:${stats.ino}`;
		const birthtimeNs = String(stats.birthtimeNs);
		const epoch = epochOf(stats, headerStamp);
		const topology = await this.foldFile(path, epoch, () => true, input);
		const ranges =
			topology.index.jumps.length === 0 ? undefined : branchRanges(topology.index, topology.index.leafSeq);
		const folded =
			ranges === undefined
				? topology
				: await this.foldFile(path, epoch, (seq) => ranges.some(([low, high]) => seq >= low && seq <= high), input);
		return {
			identity,
			birthtimeNs,
			headerStamp,
			fileSize: Number(stats.size),
			mtimeNs: String(stats.mtimeNs),
			size: folded.size,
			witness: input
				? await readFrom(
						input.handle,
						Math.max(0, folded.size - WITNESS_BYTES),
						Math.min(folded.size, WITNESS_BYTES),
					)
				: await readWitness(path, folded.size),
			terminated: folded.terminated,
			torn: folded.torn,
			spans: folded.spans,
			ids: folded.ids,
			index: folded.index,
			sidecarSize: 0,
		};
	}

	private async foldFile(
		path: string,
		epoch: string,
		activeSeq: (seq: number) => boolean,
		pinned?: FileWindowInput,
	): Promise<{
		readonly index: SessionResumeIndex;
		readonly spans: number[];
		readonly ids: number[];
		readonly size: number;
		readonly terminated: boolean;
		readonly torn: boolean;
	}> {
		let index: SessionResumeIndex = { ...foldSessionResume(undefined, [], undefined, activeSeq), epoch };
		const spans: number[] = [];
		const hashes: number[] = [];
		const ids = new Map<string, number>();
		let batch: SessionEntry[] = [],
			batchBytes = 0,
			extraToolCalls = 0;
		const flush = () => {
			if (!batch.length) return;
			index = foldSessionResume(index, batch, (id) => ids.get(id), activeSeq);
			if (extraToolCalls)
				index = { ...index, totals: { ...index.totals, toolCalls: index.totals.toolCalls + extraToolCalls } };
			batch = [];
			batchBytes = 0;
			extraToolCalls = 0;
		};
		let parts: Buffer[] = [],
			lineStart = 0,
			position = 0,
			header = true,
			large = false;
		const take = (entry: SessionEntry, end: number, toolCalls = 0) => {
			const bytes = end - lineStart;
			if (batch.length && batchBytes + bytes > SCAN_WINDOW_BYTES) flush();
			spans.push(lineStart, end);
			hashes.push(idHash(entry.id));
			ids.set(entry.id, spans.length / 2);
			batch.push(entry);
			batchBytes += bytes;
			extraToolCalls += toolCalls;
			if (batch.length >= INDEX_BATCH_ENTRIES || batchBytes >= SCAN_WINDOW_BYTES) flush();
		};
		const file = pinned?.handle ?? (await open(path, "r"));
		const input = createReadStream(path, { fd: file, start: 0, highWaterMark: SCAN_WINDOW_BYTES, autoClose: false });
		const normalize = pinned?.legacy
			? (entry: SessionEntry) => upgradeLegacySessionEntry(pinned.legacy!, entry, spans.length / 2 + 1, path)
			: undefined;
		const add = (part: Buffer, end: number) => {
			if (!header && !large) {
				if (end - lineStart > SCAN_WINDOW_BYTES) {
					parts = [];
					large = true;
				} else parts.push(part);
			}
		};
		const shortLine = (end: number, closed: boolean) => {
			const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
			const text = line.toString("utf8");
			if (closed && !text.trim()) return true;
			const raw = closed ? (JSON.parse(text) as SessionEntry) : parseUnterminated(text);
			if (!raw && !closed) return false;
			const entry = normalize ? normalize(raw!) : raw;
			validateSessionEntryStructure([entry!], path);
			validateSessionEntries([entry!]);
			take(entry!, end);
			return true;
		};
		const longLine = async (end: number, closed: boolean) => {
			const start = lineStart;
			async function* chunks() {
				for (let at = start; at < end; ) {
					const b = await readFrom(file, at, Math.min(SESSION_HISTORY_CHUNK_BYTES, end - at));
					if (!b.length) throw new Error("Session file changed during index build");
					yield b;
					at += b.length;
				}
			}
			const checker = new JsonTextChecker(),
				decoder = new TextDecoder();
			let blank = true;
			for await (const b of chunks()) {
				checker.feed(b);
				if (blank) blank = !decoder.decode(b, { stream: true }).trim();
			}
			if (closed && blank && !decoder.decode().trim()) return true;
			if (!checker.finish()) {
				if (!closed) return false;
				// Only corrupt data reaches the native parser, to preserve its exact diagnostic and offset.
				JSON.parse((await readFrom(file, start, end - start)).toString("utf8"));
			}
			const parsed = await (await import("./jsonl-entry-projection.js")).jsonlEntryProjection(
				path,
				chunks,
				normalize,
			);
			take(parsed.entry, end, parsed.toolCalls);
			return true;
		};
		try {
			for await (const chunk of input as AsyncIterable<Buffer>) {
				let from = 0;
				for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, from)) {
					const end = position + newline;
					add(chunk.subarray(from, newline), end);
					if (header) header = false;
					else if (large) await longLine(end, true);
					else shortLine(end, true);
					from = newline + 1;
					lineStart = position + from;
					parts = [];
					large = false;
				}
				if (from < chunk.length) add(chunk.subarray(from), position + chunk.length);
				position += chunk.length;
			}
			const terminated = lineStart === position;
			const torn = !terminated && !header && !(large ? await longLine(position, false) : shortLine(position, false));
			flush();
			if (torn) reportTornLine(path);
			return { index, spans, ids: hashes, size: torn ? lineStart : position, terminated: torn || terminated, torn };
		} finally {
			if (!pinned) {
				input.destroy();
				await file.close();
			}
		}
	}

	private async catchUp(path: string, cached: JsonlIndex, stats: BigIntStats): Promise<JsonlIndex | undefined> {
		const from = cached.size - cached.witness.length;
		if (Number(stats.size) - from > SCAN_WINDOW_BYTES) return undefined; // Rebuild with the streaming reader, never retain a large appended suffix.
		const bytes = await readBytes(path, from, Number(stats.size) - from);
		let offset = cached.size;
		let appended = bytes.subarray(cached.witness.length);
		if (appended.length > 0 && !cached.terminated) {
			if (appended[0] !== 10) return undefined;
			appended = appended.subarray(1);
			offset += 1;
		}
		const spans = [...cached.spans];
		const entries: SessionEntry[] = [];
		let start = 0;
		for (let newline = appended.indexOf(10); newline !== -1; newline = appended.indexOf(10, start)) {
			const text = appended.subarray(start, newline).toString("utf8");
			if (text.trim()) {
				entries.push(JSON.parse(text) as SessionEntry);
				spans.push(offset + start, offset + newline);
			}
			start = newline + 1;
		}
		const last = appended.subarray(start);
		let size = offset + start;
		let terminated = true;
		let torn = false;
		if (last.length > 0) {
			const unterminated = parseUnterminated(last.toString("utf8"));
			if (unterminated) {
				entries.push(unterminated);
				spans.push(offset + start, offset + appended.length);
				size = offset + appended.length;
				terminated = false;
			} else {
				torn = true;
				reportTornLine(path);
			}
		}
		validateSessionEntryStructure(entries, path);
		validateSessionEntries(entries);
		if (resumeIndexNeedsRefold(cached.index, entries)) return undefined;
		const index = await this.foldAppended(path, cached, entries);
		return {
			...cached,
			fileSize: Number(stats.size),
			mtimeNs: String(stats.mtimeNs),
			size,
			witness: witnessOf(Buffer.concat([cached.witness, appended.subarray(0, size - offset)])),
			terminated: appended.length === 0 ? cached.terminated : terminated,
			torn,
			spans,
			ids: [...cached.ids, ...entries.map((entry) => idHash(entry.id))],
			index,
		};
	}

	private async foldAppended(
		path: string,
		cached: JsonlIndex,
		entries: readonly SessionEntry[],
	): Promise<SessionResumeIndex> {
		const seqs = new Map<string, number>();
		for (const id of foreignResumeIds(cached.index, entries)) {
			const seq = await this.seqInFile(path, cached, id);
			if (seq !== undefined) seqs.set(id, seq);
		}
		return foldSessionResume(cached.index, entries, (id) => seqs.get(id));
	}

	private async indexAppended(
		path: string,
		before: SessionFileState,
		entries: readonly SessionEntry[],
		lines: readonly string[],
		firstLine: number,
	): Promise<void> {
		const cached = this.indexes.get(path);
		if (
			cached === undefined ||
			cached.identity !== before.identity ||
			cached.size !== before.size ||
			cached.index.seq !== before.lastSeq ||
			resumeIndexNeedsRefold(cached.index, entries)
		) {
			this.indexes.delete(path);
			return;
		}
		const spans = [...cached.spans];
		let position = firstLine;
		for (const line of lines) {
			const length = Buffer.byteLength(line, "utf8");
			spans.push(position, position + length);
			position += length + 1;
		}
		const state = this.fileStates.get(path)!;
		const stats = await stat(path, { bigint: true });
		const next: JsonlIndex = {
			...cached,
			fileSize: Number(stats.size),
			mtimeNs: String(stats.mtimeNs),
			size: state.size,
			witness: state.witness,
			terminated: true,
			torn: false,
			spans,
			ids: [...cached.ids, ...entries.map((entry) => idHash(entry.id))],
			index: await this.foldAppended(path, cached, entries),
		};
		if (next.size - next.sidecarSize >= SIDECAR_REFRESH_BYTES) await this.keepIndex(path, next);
		else this.indexes.set(path, next);
	}

	private async entriesAt(
		path: string,
		jsonl: JsonlIndex,
		seqs: readonly number[],
		input?: FileWindowInput,
	): Promise<SessionStoredEntry[]> {
		const wanted = [...new Set(seqs.filter((seq) => seq >= 1 && seq <= jsonl.index.seq))].sort((a, b) => a - b);
		const entries: SessionStoredEntry[] = [];
		if (wanted.length === 0) return entries;
		const file = input?.handle ?? (await open(path, "r"));
		try {
			let index = 0;
			while (index < wanted.length) {
				const first = wanted[index] as number;
				let last = first;
				let next = index + 1;
				while (next < wanted.length) {
					const candidate = wanted[next] as number;
					if (spanStart(jsonl, candidate) - spanEnd(jsonl, last) > READ_GAP_BYTES) break;
					if (spanEnd(jsonl, candidate) - spanStart(jsonl, first) > SCAN_WINDOW_BYTES && candidate !== first)
						break;
					last = candidate;
					next += 1;
				}
				const from = spanStart(jsonl, first);
				const bytes = await readFrom(file, from, spanEnd(jsonl, last) - from);
				for (let position = index; position < next; position++) {
					const seq = wanted[position] as number;
					const line = bytes.subarray(spanStart(jsonl, seq) - from, spanEnd(jsonl, seq) - from);
					const raw = JSON.parse(line.toString("utf8")) as SessionEntry;
					entries.push({
						seq,
						entry: input?.legacy ? upgradeLegacySessionEntry(input.legacy, raw, seq, path) : raw,
					});
				}
				index = next;
			}
		} finally {
			if (!input) await file.close();
		}
		return entries;
	}

	private async seqInFile(
		path: string,
		jsonl: JsonlIndex,
		entryId: string,
		pinned?: FileHandle,
	): Promise<number | undefined> {
		const total = jsonl.spans.length / 2;
		if (jsonl.index.lastId === entryId && jsonl.index.seq === total) return total;
		const hash = idHash(entryId);
		const candidates: number[] = [];
		for (let seq = 1; seq <= total; seq++) if (jsonl.ids[seq - 1] === hash) candidates.push(seq);
		return (await this.entriesAt(path, jsonl, candidates, pinned ? { handle: pinned } : undefined)).findLast(
			(held) => held.entry.id === entryId,
		)?.seq;
	}

	private async readPersisted(path: string, stored?: StoredSessionHeader): Promise<SessionSnapshot> {
		stored ??= await this.readFirstLine(path);
		const directory = dirname(path);
		if (isCurrentSessionHeader(stored) || directory === this.directory) return this.readSnapshot(path, stored, true);
		return this.exclusive(() => this.readSnapshot(path, undefined, true), undefined, directory);
	}

	findFile(sessionId: string): Promise<string | undefined> {
		return this.run(async () => (await this.locate(sessionId))?.path);
	}

	readHeader(sessionId: string): Promise<SessionRecordHeader | undefined> {
		return this.run(async () => {
			return (await this.locate(sessionId))?.header;
		});
	}

	delete(sessionId: string): Promise<void> {
		return this.run(async () => {
			const known = [...this.fileStates.values()].some((state) => state.headerId === sessionId);
			const located = await this.locate(sessionId);
			if (!located) {
				if (known) throw new SessionNotFoundError(sessionId);
				return;
			}
			await unlink(located.path);
			this.fileStates.delete(located.path);
			await this.forgetIndex(located.path);
		});
	}

	async *list(query: SessionListQuery): AsyncIterable<SessionSummary> {
		this.checkAbort(query.signal);
		const matchesCwd = query.cwd === undefined ? undefined : createSessionCwdMatcherAsync(query.cwd);
		const paths = await this.run(() => this.paths(), true, query.signal);
		for (const path of paths) {
			const cached = query.withoutSearchText ? this.fileStates.get(path) : undefined;
			const summary = await this.run(
				async () => {
					this.checkAbort(query.signal);
					try {
						if (cached?.summaryState !== undefined) {
							const stats = await stat(path, { bigint: true });
							if (cached.stamp === this.stamp(stats)) {
								const header = JSON.parse(cached.headerStamp) as SessionRecordHeader;
								if (!matchesSessionIdPrefix(header.id, query.idPrefix)) return undefined;
								if (matchesCwd && !(await matchesCwd(header.cwd))) return undefined;
								if (!query.includeInternal && header.internal) return undefined;
								return {
									...materializeSessionSummaryMetadata(header, cached.summaryState),
									searchText: "",
									location: path,
								};
							}
						}
						const readOne = async (): Promise<SessionSummary | undefined> => {
							const stored = await this.readFirstLine(path);
							const header = await this.readHeaderAt(path, stored);
							if (!matchesSessionIdPrefix(header.id, query.idPrefix)) return undefined;
							if (matchesCwd && !(await matchesCwd(header.cwd))) return undefined;
							if (!query.includeInternal && header.internal) return undefined;
							if (query.withoutSearchText) {
								const stats = await stat(path, { bigint: true });
								const summarized = await summarizeLegacySession(
									{ location: path, header, read: () => this.readSnapshot(path, stored) },
									Number(stats.size),
									Number(stats.mtimeMs),
									{ whole: false },
								);
								return { ...summarized, searchText: "", location: path };
							}
							return { ...summarizeSession(await this.readSnapshot(path, stored)), location: path };
						};
						return await (cached?.summaryState !== undefined ? this.exclusive(readOne, query.signal) : readOne());
					} catch (cause) {
						const error = cause as NodeJS.ErrnoException;
						if (error.path === path && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
						if (
							cause instanceof SessionFormatVersionError ||
							cause instanceof SessionInvalidTextError ||
							cause instanceof SessionInvalidTimestampError ||
							cause instanceof SyntaxError
						)
							return undefined;
						throw cause;
					}
				},
				cached?.summaryState === undefined,
				query.signal,
			);
			this.checkAbort(query.signal);
			if (summary) yield summary;
		}
		await this.run(async () => this.checkAbort(query.signal), true, query.signal);
	}

	async *scanFiles(): AsyncIterable<JsonlSessionFile> {
		for (const location of await this.run(() => this.paths({ skipUnreadableDirectories: true }), false)) {
			let header: SessionRecordHeader;
			try {
				header = await this.run(async () => this.readHeaderAt(location, await this.readFirstLine(location)), false);
			} catch {
				continue;
			}
			yield { location, header, read: () => this.run(() => this.readSnapshot(location), false) };
		}
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

	close(): Promise<void> {
		if (this.closed) return Promise.reject(new StoreClosedError(this.descriptor));
		this.closed = true;
		return this.queue;
	}

	private run<T>(operation: () => Promise<T>, locked = true, signal?: AbortSignal): Promise<T> {
		if (this.closed) return Promise.reject(new StoreClosedError(this.descriptor));
		const result = this.queue.then(async () => {
			if (this.poisoned) throw this.poisoned;
			try {
				return await (locked ? this.exclusive(operation, signal) : operation());
			} catch (cause) {
				if (signal?.aborted && cause === signal.reason) throw cause;
				if (
					cause instanceof SessionConflictError ||
					cause instanceof SessionExistsError ||
					cause instanceof SessionNotFoundError ||
					cause instanceof SessionIdMismatchError ||
					cause instanceof SessionInvalidTextError ||
					cause instanceof SessionInvalidTimestampError ||
					cause instanceof SessionFormatVersionError ||
					cause instanceof JsonlStoragePoisonedError ||
					cause instanceof DOMException
				)
					throw cause;
				throw new StorageUnavailableError(this.descriptor, cause as Error);
			}
		});
		this.queue = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private async exclusive<T>(
		operation: () => Promise<T>,
		signal?: AbortSignal,
		directory = this.directory,
	): Promise<T> {
		const lockfilePath = join(directory, ".session.lock");
		let release: () => Promise<void>;
		let refusals = 0;
		for (;;) {
			this.checkAbort(signal);
			try {
				release = await lockfile.lock(directory, {
					lockfilePath,
					...(this.lockFs ? { fs: this.lockFs } : {}),
					onCompromised: (cause) => {
						this.poisoned = new StorageUnavailableError(this.descriptor, cause);
					},
				});
				break;
			} catch (cause) {
				const code = (cause as NodeJS.ErrnoException).code;
				if (code === "EPERM" && process.platform === "win32" && refusals < LOCK_BACKOFF_MS.length) {
					await delay(LOCK_BACKOFF_MS[refusals++]);
					continue;
				}
				if (code !== "ELOCKED") throw cause;
				if (await this.clearUnreleased(lockfilePath)) continue;
				await delay(5);
			}
		}
		let result: T;
		try {
			this.checkAbort(signal);
			if (this.poisoned) throw this.poisoned;
			result = await operation();
			if (this.poisoned) throw this.poisoned;
		} catch (cause) {
			await this.release(release, lockfilePath);
			throw cause;
		}
		await this.release(release, lockfilePath);
		return result;
	}

	/**
	 * Releases the lock. The directory removal is retried when Windows refuses it for a moment. If it never
	 * succeeds the work is still done, so the failure is not reported over it: the lock is remembered so this
	 * store's next acquire removes it at once, instead of waiting for it to go stale.
	 */
	private async release(release: () => Promise<void>, lockfilePath: string): Promise<void> {
		const fs: Pick<SessionLockFs, "rmdir" | "stat"> = this.lockFs ?? { rmdir: rmdirCallback, stat: statCallback };
		try {
			await release();
			return;
		} catch (cause) {
			if (!TRANSIENT_RELEASE_CODES.has((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
		}
		// proper-lockfile has already forgotten the lock, so removing the directory is all that is left.
		for (const wait of LOCK_BACKOFF_MS) {
			await delay(wait);
			try {
				await removeDirectory(fs, lockfilePath);
				return;
			} catch (cause) {
				if (!TRANSIENT_RELEASE_CODES.has((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
			}
		}
		const modified = await statMtimeMs(fs, lockfilePath);
		if (modified !== undefined) this.unreleased.set(lockfilePath, modified);
	}

	/** Removes a lock directory this store failed to release, if it still has the time it had then. */
	private async clearUnreleased(lockfilePath: string): Promise<boolean> {
		const expected = this.unreleased.get(lockfilePath);
		if (expected === undefined) return false;
		const fs: Pick<SessionLockFs, "rmdir" | "stat"> = this.lockFs ?? { rmdir: rmdirCallback, stat: statCallback };
		const modified = await statMtimeMs(fs, lockfilePath);
		if (modified === undefined) {
			this.unreleased.delete(lockfilePath);
			return true;
		}
		// Another process took the lock over once it went stale: it is theirs now.
		if (modified !== expected) {
			this.unreleased.delete(lockfilePath);
			return false;
		}
		try {
			await removeDirectory(fs, lockfilePath);
		} catch (cause) {
			if (!TRANSIENT_RELEASE_CODES.has((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
			return false;
		}
		this.unreleased.delete(lockfilePath);
		return true;
	}

	private checkAbort(signal?: AbortSignal): void {
		signal?.throwIfAborted();
	}

	private async paths(options: { readonly skipUnreadableDirectories?: boolean } = {}): Promise<string[]> {
		const paths: string[] = [];
		for (const entry of await readdir(this.directory, { withFileTypes: true })) {
			const path = join(this.directory, entry.name);
			if ((entry.isDirectory() || entry.isSymbolicLink()) && !this.exactDirectory) {
				const children = await readdir(path, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
					if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return [];
					if (options.skipUnreadableDirectories && (cause.code === "EACCES" || cause.code === "EPERM")) return [];
					throw cause;
				});
				for (const child of children) {
					if (child.isFile() && child.name.endsWith(".jsonl")) paths.push(join(path, child.name));
				}
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
		}
		return paths;
	}

	private async locate(sessionId: string): Promise<
		| {
				path: string;
				header: SessionRecordHeader;
				stored: StoredSessionHeader;
				stats: BigIntStats;
				state: SessionFileState | undefined;
		  }
		| undefined
	> {
		validateSessionText("sessionId", sessionId);
		if (this.selectedFile?.id === sessionId) return this.scan(sessionId, [this.selectedFile.path]);
		const known = await this.locateKnown(sessionId);
		if (known) return known;
		const suffix = `_${this.key(sessionId)}.jsonl`;
		const paths = await this.paths();
		const named = paths.filter((path) => basename(path).endsWith(suffix));
		const others = paths.filter((path) => !named.includes(path));
		return (await this.scan(sessionId, named)) ?? (await this.scan(sessionId, others));
	}

	/**
	 * Whether a file of this directory already holds `sessionId`, as {@link locate} finds it, without reading the files
	 * named for other sessions. A session's file is named for it when it is created, by this store (the key of its id) or
	 * by its session manager (its id), after its creation time; only a file named for `sessionId`, or one whose name says
	 * nothing of its session, can hold it. Creating a session in a directory of N sessions, as a project's session directory
	 * grows to, then reads no other session's file, where it read all N (#5186).
	 */
	private async claimed(sessionId: string): Promise<boolean> {
		validateSessionText("sessionId", sessionId);
		if (await this.locateKnown(sessionId)) return true;
		const key = this.key(sessionId);
		const candidates = (await this.paths()).filter((path) => {
			const named = SESSION_FILE_NAME.exec(basename(path))?.[1];
			return named === undefined || named === sessionId || named === key;
		});
		return (await this.scan(sessionId, candidates)) !== undefined;
	}

	private async scan(sessionId: string, paths: readonly string[]) {
		for (const path of paths) {
			const cached = this.fileStates.get(path);
			let stored: StoredSessionHeader;
			try {
				stored = await this.readFirstLine(path);
			} catch (cause) {
				// Preserve requested-file errors only while its cached inode still owns the path.
				if (cached?.headerId === sessionId) {
					const stats = await stat(path, { bigint: true });
					if (cached.identity === `${stats.dev}:${stats.ino}`) throw cause;
					this.fileStates.delete(path);
				} else if (basename(path).match(/_([0-9a-f]{64})\.jsonl$/)?.[1] === this.key(sessionId)) {
					throw cause;
				}
				// An unidentifiable file cannot block lookup of unrelated sessions.
				continue;
			}
			if (cached && cached.headerId !== stored.id) this.fileStates.delete(path);
			if (stored.id !== sessionId) continue;
			const header = await this.readHeaderAt(path, stored);
			const stats = await stat(path, { bigint: true });
			const state = this.fileStates.get(path);
			// Keep same-ID baselines only as conflict evidence: forWrite checks the current inode
			// and rejects structural changes until an explicit load establishes a new baseline.
			return { path, header, stored, stats, state };
		}
		return undefined;
	}

	private async locateKnown(sessionId: string) {
		for (const [path, cached] of this.fileStates) {
			if (cached.headerId !== sessionId) continue;
			const parent = dirname(path);
			if (parent !== this.directory && (this.exactDirectory || dirname(parent) !== this.directory)) return undefined;
			let stored: StoredSessionHeader;
			try {
				// A file this store knows starts with the header it last saw: read exactly that line, and no further.
				stored = await this.readFirstLine(path, headerLineBytes(cached.headerStamp));
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === "ENOENT") this.fileStates.delete(path);
				return undefined;
			}
			if (stored.id !== sessionId) {
				this.fileStates.delete(path);
				return undefined;
			}
			const header = await this.readHeaderAt(path, stored);
			const stats = await stat(path, { bigint: true });
			return { path, header, stored, stats, state: this.fileStates.get(path) };
		}
		return undefined;
	}

	private key(sessionId: string): string {
		return createHash("sha256").update(sessionId).digest("hex");
	}

	/** The first line, read `firstReadBytes` at once and then in chunks until its newline. */
	private async readFirstLine(path: string, firstReadBytes = HEADER_READ_CHUNK_BYTES): Promise<StoredSessionHeader> {
		const file = await open(path, "r");
		try {
			return await readFirstLineFrom(file, firstReadBytes);
		} finally {
			await file.close();
		}
	}

	private async readHeaderAt(path: string, stored?: StoredSessionHeader): Promise<SessionRecordHeader> {
		stored ??= await this.readFirstLine(path);
		const { type: _type, ...header } = isCurrentSessionHeader(stored)
			? (stored as SessionRecordHeader & { type: "session" })
			: upgradeLegacySessionHeader(stored, path);
		if (
			_type !== "session" ||
			typeof header.id !== "string" ||
			typeof header.cwd !== "string" ||
			typeof header.createdAt !== "string"
		) {
			throw new SessionFormatVersionError(path, stored.version);
		}
		validateSessionHeader(header);
		return header;
	}

	private async readSnapshot(
		path: string,
		stored?: StoredSessionHeader,
		persistUpgrade = false,
	): Promise<SessionSnapshot> {
		stored ??= await this.readFirstLine(path);
		const header = await this.readHeaderAt(path, stored);
		const { entries, witness, terminated, torn, size } = await this.readEntries(path);
		if (torn) reportTornLine(path);
		if (!isCurrentSessionHeader(stored)) {
			const upgraded = upgradeLegacySessionEntries(stored, entries, path).entries;
			validateSessionEntryStructure(upgraded, path);
			validateSessionEntries(upgraded);
			if (persistUpgrade) await this.commit(path, header, upgraded);
			return { header, entries: upgraded, lastSeq: upgraded.length };
		}
		validateSessionEntryStructure(entries, path);
		validateSessionEntries(entries);
		await this.remember(
			path,
			{
				headerStamp: JSON.stringify(header),
				headerId: header.id,
				lastSeq: entries.length,
				lastEntryId: entries.at(-1)?.id,
				witness,
				terminated,
				torn,
				summaryState: applySessionSummaryEntries(undefined, entries).state,
			},
			torn ? size : undefined,
		);
		return { header, entries, lastSeq: entries.length };
	}

	/**
	 * The entries after the header line. A last line without a newline is read when it is a complete record and
	 * left out when it is torn; `size` and `witness` then end at the last complete line. A malformed line before
	 * the last one is still a parse failure.
	 */
	private async readEntries(path: string): Promise<{
		entries: SessionEntry[];
		witness: Buffer;
		terminated: boolean;
		torn: boolean;
		size: number;
	}> {
		const input = createReadStream(path);
		let size = 0;
		let complete = 0;
		let witness: Buffer = Buffer.alloc(0);
		let completeWitness: Buffer = Buffer.alloc(0);
		input.on("data", (chunk: string | Buffer) => {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			const newline = bytes.lastIndexOf(10);
			if (newline !== -1) {
				complete = size + newline + 1;
				completeWitness = witnessOf(Buffer.concat([witness, bytes.subarray(0, newline + 1)]));
			}
			witness = witnessOf(Buffer.concat([witness, bytes]));
			size += bytes.length;
		});
		const entries: SessionEntry[] = [];
		let first = true;
		let last: string | undefined;
		try {
			for await (const line of readLines(input)) {
				if (first) {
					first = false;
					continue;
				}
				if (last?.trim()) entries.push(JSON.parse(last) as SessionEntry);
				last = line;
			}
		} finally {
			input.destroy();
		}
		const terminated = complete === size;
		if (last !== undefined && terminated) {
			if (last.trim()) entries.push(JSON.parse(last) as SessionEntry);
		} else if (last !== undefined) {
			const entry = parseUnterminated(last);
			if (!entry) return { entries, witness: completeWitness, terminated: true, torn: true, size: complete };
			entries.push(entry);
		}
		return { entries, witness, terminated, torn: false, size };
	}

	private stamp(stats: BigIntStats): string {
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	}

	private contentState(
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		content: string,
	): Omit<SessionFileState, "stamp" | "identity" | "size"> {
		return {
			headerStamp: JSON.stringify(header),
			lastSeq: entries.length,
			headerId: header.id,
			lastEntryId: entries.at(-1)?.id,
			terminated: content.endsWith("\n"),
			torn: false,
			witness: witnessOf(Buffer.from(content)),
			summaryState: applySessionSummaryEntries(undefined, entries).state,
		};
	}

	/** Records the file as it is now; `size` ends it before a torn last line. */
	private async remember(
		path: string,
		state: Omit<SessionFileState, "stamp" | "identity" | "size">,
		size?: number,
	): Promise<BigIntStats> {
		const stats = await stat(path, { bigint: true });
		this.fileStates.set(path, {
			...state,
			stamp: this.stamp(stats),
			identity: `${stats.dev}:${stats.ino}`,
			size: size ?? Number(stats.size),
		});
		return stats;
	}

	/**
	 * Foreign appends read only the header, at most 64 known boundary bytes, and new bytes.
	 * The witness detects a changed append boundary, not arbitrary edits in old history.
	 * Structural changes require an explicit load; they never trigger a hidden full reread.
	 */
	private async forWrite(
		sessionId: string,
		options: SessionWriteOptions,
	): Promise<{ path: string; state: SessionFileState }> {
		const located = await this.locate(sessionId);
		if (!located) throw new SessionNotFoundError(sessionId);
		const { path, header, stored, stats } = located;
		if (!isCurrentSessionHeader(stored)) throw new SessionFormatVersionError(path, stored.version);
		let state = located.state;
		if (!state) {
			await this.readSnapshot(path);
			state = this.fileStates.get(path)!;
		} else {
			// The file changed under the baseline, so its sequence comes from the file itself, not from the baseline.
			const stale = async () =>
				new SessionConflictError(sessionId, options.expectSeq, (await this.readEntries(path)).entries.length);
			if (
				state.identity !== `${stats.dev}:${stats.ino}` ||
				state.headerStamp !== JSON.stringify(header) ||
				Number(stats.size) < state.size
			)
				throw await stale();
			if (state.stamp !== this.stamp(stats)) {
				const file = await open(path, "r");
				const offset = state.size - state.witness.length;
				const bytes = Buffer.alloc(Number(stats.size) - offset);
				try {
					let read = 0;
					while (read < bytes.length) {
						const { bytesRead } = await file.read(bytes, read, bytes.length - read, offset + read);
						if (!bytesRead) throw await stale();
						read += bytesRead;
					}
				} finally {
					await file.close();
				}
				if (!bytes.subarray(0, state.witness.length).equals(state.witness)) throw await stale();
				let appended = bytes.subarray(state.witness.length).toString("utf8");
				if (appended && !state.terminated) {
					if (!appended.startsWith("\n")) throw await stale();
					appended = appended.slice(1);
				}
				const lines = appended.split("\n");
				const last = lines.pop() ?? "";
				const entries = lines.map((line) => JSON.parse(line) as SessionEntry);
				const unterminated = last === "" ? undefined : parseUnterminated(last);
				if (unterminated) entries.push(unterminated);
				const torn = last !== "" && !unterminated;
				if (torn) reportTornLine(path);
				validateSessionEntryStructure(entries, path);
				validateSessionEntries(entries);
				const end = torn ? bytes.lastIndexOf(10) + 1 : bytes.length;
				state = {
					...state,
					stamp: this.stamp(stats),
					size: offset + end,
					lastSeq: state.lastSeq + entries.length,
					lastEntryId: entries.at(-1)?.id ?? state.lastEntryId,
					terminated: bytes.at(end - 1) === 10,
					torn,
					witness: witnessOf(bytes.subarray(0, end)),
					...(state.summaryState === undefined
						? {}
						: { summaryState: applySessionSummaryEntries(state.summaryState, entries).state }),
				};
				this.fileStates.set(path, state);
			}
		}
		if (
			state.lastSeq !== options.expectSeq ||
			(options.epoch !== undefined && epochOf(stats, JSON.stringify(header)) !== options.epoch)
		)
			throw new SessionConflictError(sessionId, options.expectSeq, state.lastSeq);
		return { path, state };
	}

	private encode(header: SessionRecordHeader, entries: readonly SessionEntry[]): string {
		return `${[JSON.stringify({ type: "session", ...header }), ...entries.map((entry) => JSON.stringify(entry))].join("\n")}\n`;
	}
}

function removeDirectory(fs: Pick<SessionLockFs, "rmdir">, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		fs.rmdir(path, (error) => {
			if (error && (error as NodeJS.ErrnoException).code !== "ENOENT") reject(error);
			else resolve();
		});
	});
}

function statMtimeMs(fs: Pick<SessionLockFs, "stat">, path: string): Promise<number | undefined> {
	return new Promise((resolve) => {
		fs.stat(path, (error, stats) => resolve(error ? undefined : stats.mtimeMs));
	});
}

function seqRange(first: number, last: number): number[] {
	return last < first ? [] : Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

function spanStart(jsonl: JsonlIndex, seq: number): number {
	return jsonl.spans[2 * (seq - 1)] as number;
}

function spanEnd(jsonl: JsonlIndex, seq: number): number {
	return jsonl.spans[2 * (seq - 1) + 1] as number;
}

function idHash(id: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193);
	return hash >>> 0;
}

function encodeIdHashes(hashes: readonly number[]): string {
	const bytes = Buffer.allocUnsafe(hashes.length * 4);
	for (const [index, hash] of hashes.entries()) bytes.writeUInt32LE(hash, index * 4);
	return bytes.toString("base64");
}

function decodeIdHashes(text: string): number[] | undefined {
	const bytes = Buffer.from(text, "base64");
	if (bytes.length % 4 !== 0) return undefined;
	const hashes: number[] = [];
	for (let offset = 0; offset < bytes.length; offset += 4) hashes.push(bytes.readUInt32LE(offset));
	return hashes;
}

function epochOf(stats: BigIntStats, headerStamp: string): string {
	return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}:${createHash("sha256").update(headerStamp).digest("hex").slice(0, 16)}`;
}

async function readFrom(
	file: import("node:fs/promises").FileHandle,
	position: number,
	length: number,
): Promise<Buffer> {
	const bytes = Buffer.alloc(Math.max(0, length));
	for (let read = 0; read < bytes.length; ) {
		const { bytesRead } = await file.read(bytes, read, bytes.length - read, position + read);
		if (bytesRead === 0) throw new Error(`Session file ended before byte ${position + bytes.length}`);
		read += bytesRead;
	}
	return bytes;
}

async function readFirstLineFrom(
	file: FileHandle,
	firstReadBytes: number,
	start: number | null = null,
): Promise<StoredSessionHeader> {
	const chunks: Buffer[] = [];
	let position = start;
	for (let length = firstReadBytes; ; length = HEADER_READ_CHUNK_BYTES) {
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await file.read(buffer, 0, length, position);
		if (!bytesRead) break;
		if (position !== null) position += bytesRead;
		const newline = buffer.subarray(0, bytesRead).indexOf(10);
		chunks.push(buffer.subarray(0, newline === -1 ? bytesRead : newline));
		if (newline !== -1) break;
	}
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue;
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as StoredSessionHeader) : {};
}

async function readBytes(path: string, position: number, length: number): Promise<Buffer> {
	const file = await open(path, "r");
	try {
		return await readFrom(file, position, length);
	} finally {
		await file.close();
	}
}

async function readWitness(path: string, size: number): Promise<Buffer> {
	const from = Math.max(0, size - 64);
	return readBytes(path, from, size - from);
}

async function witnessHolds(path: string, jsonl: JsonlIndex): Promise<boolean> {
	try {
		return (await readWitness(path, jsonl.size)).equals(jsonl.witness);
	} catch {
		return false;
	}
}

function encodeDeltas(values: readonly number[]): string {
	let previous = 0;
	return values
		.map((value) => {
			const delta = (value - previous).toString(36);
			previous = value;
			return delta;
		})
		.join(".");
}

function decodeDeltas(text: string): number[] {
	if (text === "") return [];
	let previous = 0;
	return text.split(".").map((delta) => {
		previous += Number.parseInt(delta, 36);
		return previous;
	});
}

async function writeSidecar(path: string, jsonl: JsonlIndex): Promise<boolean> {
	const body = JSON.stringify({
		version: JSONL_INDEX_VERSION,
		identity: jsonl.identity,
		birthtimeNs: jsonl.birthtimeNs,
		headerStamp: jsonl.headerStamp,
		fileSize: jsonl.fileSize,
		mtimeNs: jsonl.mtimeNs,
		size: jsonl.size,
		witness: jsonl.witness.toString("base64"),
		terminated: jsonl.terminated,
		torn: jsonl.torn,
		spans: encodeDeltas(jsonl.spans),
		ids: encodeIdHashes(jsonl.ids),
		index: jsonl.index,
	});
	const sidecar = `${path}${SIDECAR_SUFFIX}`;
	const temporary = `${sidecar}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${createHash("sha256").update(body).digest("hex")}\n${body}`, { flag: "wx" });
		await rename(temporary, sidecar);
		return true;
	} catch {
		await unlink(temporary).catch(() => undefined);
		return false;
	}
}

async function readSidecar(path: string): Promise<JsonlIndex | undefined> {
	let text: string;
	try {
		text = await readFile(`${path}${SIDECAR_SUFFIX}`, "utf8");
	} catch {
		return undefined;
	}
	const newline = text.indexOf("\n");
	if (newline === -1) return undefined;
	const body = text.slice(newline + 1);
	if (createHash("sha256").update(body).digest("hex") !== text.slice(0, newline)) return undefined;
	let stored: Record<string, unknown>;
	try {
		stored = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (
		stored.version !== JSONL_INDEX_VERSION ||
		typeof stored.identity !== "string" ||
		typeof stored.birthtimeNs !== "string" ||
		typeof stored.headerStamp !== "string" ||
		typeof stored.fileSize !== "number" ||
		typeof stored.mtimeNs !== "string" ||
		typeof stored.size !== "number" ||
		typeof stored.witness !== "string" ||
		typeof stored.terminated !== "boolean" ||
		typeof stored.torn !== "boolean" ||
		typeof stored.spans !== "string" ||
		typeof stored.ids !== "string"
	)
		return undefined;
	const spans = decodeDeltas(stored.spans);
	const ids = decodeIdHashes(stored.ids);
	if (
		spans.length % 2 !== 0 ||
		ids?.length !== spans.length / 2 ||
		!isSessionResumeIndex(stored.index, spans.length / 2)
	)
		return undefined;
	return {
		identity: stored.identity,
		birthtimeNs: stored.birthtimeNs,
		headerStamp: stored.headerStamp,
		fileSize: stored.fileSize,
		mtimeNs: stored.mtimeNs,
		size: stored.size,
		witness: Buffer.from(stored.witness, "base64"),
		terminated: stored.terminated,
		torn: stored.torn,
		spans,
		ids,
		index: stored.index,
		sidecarSize: stored.size,
	};
}
