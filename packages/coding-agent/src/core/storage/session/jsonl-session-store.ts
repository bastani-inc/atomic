import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants, createReadStream, rmdir as rmdirCallback, stat as statCallback } from "node:fs";
import {
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
import { bindChatEpoch, boundedChatRecord, type ChatRecordOwner, type SessionChatRecords } from "./chat-records.js";
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
	appendFileChatRecord,
	deleteFileChatRecords,
	hasFileChatRecords,
	readFileChatOrders,
	readFileChatRecords,
} from "./jsonl-chat-records.js";
import { entryProjector, jsonlEntryProjection, type ProjectedEntry } from "./jsonl-entry-projection.js";
import { EPOCH_HAS_BIRTHTIME, fileEpochOf, legacyFileEpochOf } from "./jsonl-file-epoch.js";
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
	childCatalogCut,
	foldSessionResume,
	foreignResumeIds,
	isSessionResumeIndex,
	latestCompactionOf,
	readEarlierCompletionIntents,
	resumeIndexNeedsRefold,
	type SessionResumeIndex,
	selectedPagePlan,
	selectResumeLeaf,
	sessionResumeFrom,
	sessionResumePlan,
	sessionTailFrom,
	snapshotCutOf,
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
	SessionHistoryPage,
	SessionListQuery,
	SessionRecordHeader,
	SessionResume,
	SessionSnapshot,
	SessionSnapshotCut,
	SessionStore,
	SessionStoredEntry,
	SessionSummary,
	SessionTail,
	SessionWriteOptions,
	SessionWriteResult,
	StorageDescriptor,
} from "./types.js";
import {
	entrySizeLimit,
	matchesSessionIdPrefix,
	onlySeqs,
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
} from "./types.js";
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

/**
 * The state each session file was last recorded in by a store of this process, by path, least recently recorded first.
 * A store opening the directory again takes a file's state from here while the file's stat stamp is unchanged, rather
 * than read the file again (#6560). The stamp names the inode, the size and the change times, so a state taken from
 * here is one the file is in.
 */
const recordedFileStates = new Map<string, SessionFileState>();
/** The most files {@link recordedFileStates} keeps; the least recently recorded goes first. */
const RECORDED_FILE_STATES = 2048;
/** How many files an open stats at once to check them against {@link recordedFileStates}. */
const SCAN_STATS_IN_FLIGHT = 32;

function recordFileState(path: string, state: SessionFileState): void {
	recordedFileStates.delete(path);
	recordedFileStates.set(path, state);
	if (recordedFileStates.size > RECORDED_FILE_STATES)
		recordedFileStates.delete(recordedFileStates.keys().next().value as string);
}

interface AppendRequest {
	readonly sessionId: string;
	readonly entries: readonly SessionEntry[];
	readonly options: SessionWriteOptions;
	readonly resolve: (result: { readonly lastSeq: number }) => void;
	readonly reject: (cause: unknown) => void;
	/** How the group decided it, answered once the group has released the lock, as a lone append is. */
	answer?: { readonly lastSeq: number } | { readonly error: unknown };
}

/** Appends made while the one before them waited its turn, committed together under one lock. */
interface AppendGroup {
	readonly requests: AppendRequest[];
	/** How many operations the store had queued when the group was queued: one queued after it closes the group. */
	queued: number;
	started: boolean;
}

/** The appends of one group to one session file, written together. */
interface StagedFile {
	readonly sessionId: string;
	readonly path: string;
	readonly identity: string;
	readonly epoch: string;
	/** The file as the last write left it, which the staged lines go after. */
	before: SessionFileState;
	entries: SessionEntry[];
	lines: string[];
	requests: { readonly request: AppendRequest; readonly lastSeq: number }[];
}

/** A session file's handle, opened to append and kept between appends while the session is written. */
interface KeptFile {
	readonly handle: FileHandle;
	/** `dev:ino` of the file it was opened on: it is used only while the path still names that file. */
	readonly identity: string;
	idle: NodeJS.Timeout | undefined;
	/** Counts the times its idle timer was set, so a timer that was set again since does not close it. */
	armed: number;
}

/**
 * Windows refuses to remove a directory that holds an open file and may refuse to replace one, so there a handle is
 * closed once its appends are written.
 */
const KEEP_APPEND_FILES = process.platform !== "win32";
/** How long a kept handle stays open after its last use. */
const KEPT_FILE_IDLE_MS = 30_000;
/** The most handles one store keeps open; the least recently used is closed first. */
const KEPT_FILES = 16;

type JsonValue = SessionJsonValue;

type ForkCatalogType = "session_info" | "session_summary" | "branch_summary";
interface JsonlForkIndex {
	/** Latest active label per target, in insertion order (clearing and resetting moves a target to the end). */
	readonly labels: readonly number[];
	readonly catalog: readonly (readonly [number, ForkCatalogType])[];
}
function isForkCatalogType(type: string): type is ForkCatalogType {
	return type === "session_info" || type === "session_summary" || type === "branch_summary";
}

/** Update only the sparse fork metadata touched by the append. Old sidecars without it remain usable. */
function appendedForkIndex(
	cached: Pick<JsonlIndex, "fork" | "index">,
	entries: readonly SessionEntry[],
): JsonlForkIndex | undefined {
	const previous = cached.fork;
	if (!previous) return undefined;
	let labels: number[] | undefined, catalog: Array<readonly [number, ForkCatalogType]> | undefined;
	let latest: Map<string, number> | undefined;
	for (const [i, entry] of entries.entries()) {
		const seq = cached.index.seq + i + 1;
		if (isForkCatalogType(entry.type)) {
			catalog ??= [...previous.catalog];
			catalog.push([seq, entry.type]);
		}
		if (entry.type !== "label") continue;
		latest ??= new Map();
		labels ??= [...previous.labels];
		const before = latest.get(entry.targetId) ?? cached.index.latest[`label:${entry.targetId}`]?.[0];
		const pos = before === undefined ? -1 : labels.indexOf(before);
		if (entry.label) {
			if (pos < 0) labels.push(seq);
			else labels[pos] = seq;
		} else if (pos >= 0) labels.splice(pos, 1);
		latest.set(entry.targetId, seq);
	}
	return labels || catalog ? { labels: labels ?? previous.labels, catalog: catalog ?? previous.catalog } : previous;
}

interface JsonlIndex {
	readonly fork?: JsonlForkIndex;
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

interface FoldedFile {
	readonly fork: JsonlForkIndex;
	readonly index: SessionResumeIndex;
	readonly spans: number[];
	readonly ids: number[];
	readonly size: number;
	readonly terminated: boolean;
	readonly torn: boolean;
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

/** The sidecar version an older build reads, whose epochs all hold the file's creation time. */
const BIRTHTIME_INDEX_VERSION = 2;
/**
 * The version of the sidecars this build writes. One whose epoch leaves out the creation time is version 3, so an older
 * build, which compares it with an epoch that has one, indexes the file again rather than read it. Both are read.
 */
export const JSONL_INDEX_VERSION = EPOCH_HAS_BIRTHTIME ? BIRTHTIME_INDEX_VERSION : 3;
const SIDECAR_SUFFIX = ".idx";
const SIDECAR_REFRESH_BYTES = 1024 * 1024;
const INDEX_BATCH_ENTRIES = 512;
const READ_GAP_BYTES = 64 * 1024;
const SCAN_WINDOW_BYTES = 1024 * 1024;

/** The last 64 bytes, which locate the boundary a later append starts from. */
function witnessOf(bytes: Buffer): Buffer {
	return Buffer.from(bytes.subarray(-64));
}

/** The witness of `witness` followed by `bytes`, copying no more of `bytes` than the witness keeps. */
function witnessAfter(witness: Buffer, bytes: Buffer): Buffer {
	return bytes.length >= 64 ? witnessOf(bytes) : witnessOf(Buffer.concat([witness, bytes]));
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
const NEWLINE = Buffer.from("\n");
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

/**
 * Where the `count`th entry line before byte `end` starts, `end` being the end of an entry line: read backwards from
 * `end` a chunk at a time, each twice the last up to one scan window, as `tail -n` reads. A line of only whitespace is
 * not an entry, as {@link scanSessionLines} skips it. Undefined when the header comes first, or when a line holds no
 * visible ASCII but bytes of multi-byte characters, which only decoding it would call blank or not.
 */
async function lineStartFromEnd(
	file: FileHandle,
	end: number,
	count: number,
	signal: AbortSignal | undefined,
): Promise<number | undefined> {
	let found = 0;
	let visible = false;
	let wide = false;
	let chunkBytes = RANGE_CHUNK_BYTES;
	for (let position = end; position > 0; ) {
		signal?.throwIfAborted();
		const length = Math.min(chunkBytes, position);
		const bytes = await readFrom(file, position - length, length);
		position -= length;
		for (let at = length - 1; at >= 0; at--) {
			const byte = bytes[at]!;
			if (byte === 10) {
				// The newline that ends the last line ends no line before it.
				if (position + at === end - 1) continue;
				if (visible) {
					if (++found === count) return position + at + 1;
				} else if (wide) return undefined;
				visible = false;
				wide = false;
			} else if (byte > 0x20 && byte < 0x80) visible = true;
			else if (byte >= 0x80) wide = true;
		}
		chunkBytes = Math.min(2 * chunkBytes, SCAN_WINDOW_BYTES);
	}
	return undefined;
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

/**
 * Stream the entry lines of `file` from byte `from` to `end` (or its end), skipping a header line first when `header`.
 * As a whole-file load does, a malformed line throws when it is read, but the first invalid entry throws only after
 * every later line parsed: an invalid structure before any invalid text. `take` receives the valid entries until the
 * first invalid one, with the line's span and the tool calls of a replaced content array, and returns false to stop
 * the scan, which then resolves undefined. A line longer than one scan window is projected as it is read, never held
 * or decoded whole unless it is malformed, so that the parser's own diagnostic is reported.
 */
async function scanEntries(
	path: string,
	file: FileHandle,
	from: number,
	end: number | undefined,
	header: boolean,
	take: (entry: SessionEntry, start: number, end: number, toolCalls: number) => boolean | Promise<boolean>,
	legacy?: StoredSessionHeader,
): Promise<{ readonly size: number; readonly terminated: boolean; readonly torn: boolean } | undefined> {
	let invalidStructure: { readonly error: unknown } | undefined;
	let invalidText: { readonly error: unknown } | undefined;
	let stopped = false;
	// Validate the entries read in batches, as a load does, before any is taken; hold at most one scan window.
	let held: SessionEntry[] = [],
		heldSpans: number[] = [],
		heldTools: number[] = [],
		heldBytes = 0;
	const settle = async (): Promise<void> => {
		const entries = held,
			spans = heldSpans,
			tools = heldTools;
		held = [];
		heldSpans = [];
		heldTools = [];
		heldBytes = 0;
		if (!invalidStructure)
			try {
				validateSessionEntryStructure(entries, path);
			} catch (error) {
				invalidStructure = { error };
			}
		if (!invalidStructure && !invalidText)
			try {
				validateSessionEntries(entries);
			} catch (error) {
				invalidText = { error };
			}
		for (let at = 0; at < entries.length && !invalidStructure && !invalidText && !stopped; at++) {
			const taken = take(entries[at]!, spans[2 * at]!, spans[2 * at + 1]!, tools[at]!);
			if (!(typeof taken === "boolean" ? taken : await taken)) stopped = true;
		}
	};
	let legacySeq = 0;
	const accept = (entry: SessionEntry, start: number, stop: number, toolCalls: number): undefined | Promise<void> => {
		held.push(legacy ? upgradeLegacySessionEntry(legacy, entry, ++legacySeq, path) : entry);
		heldSpans.push(start, stop);
		heldTools.push(toolCalls);
		heldBytes += stop - start;
		return held.length >= INDEX_BATCH_ENTRIES || heldBytes >= SCAN_WINDOW_BYTES ? settle() : undefined;
	};
	let parts: Buffer[] = [],
		lineStart = from,
		position = from;
	// An oversized line is projected as it is read, never held whole.
	let projector: ReturnType<typeof entryProjector> | undefined;
	const add = (part: Buffer, stop: number) => {
		if (header) return;
		if (projector) projector.feed(part);
		else if (stop - lineStart > SCAN_WINDOW_BYTES) {
			projector = entryProjector();
			for (const earlier of parts) projector.feed(earlier);
			projector.feed(part);
			parts = [];
		} else parts.push(part);
	};
	const shortLine = (stop: number, closed: boolean): boolean | Promise<boolean> => {
		const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
		const text = line.toString("utf8");
		if (closed && !text.trim()) return true;
		const entry = closed ? (JSON.parse(text) as SessionEntry) : parseUnterminated(text);
		if (!entry && !closed) return false;
		const pending = accept(entry!, lineStart, stop, 0);
		return pending ? pending.then(() => true) : true;
	};
	const longLine = async (projected: ProjectedEntry | undefined, stop: number, closed: boolean): Promise<boolean> => {
		const start = lineStart;
		if (!projected) {
			if (!closed) return false;
			if (await isBlank(readChunks(file, start, stop))) return true;
		}
		// Only corrupt data reaches the native parser, to preserve its exact diagnostic and offset.
		const entry =
			projected?.entry ?? (JSON.parse((await readFrom(file, start, stop - start)).toString("utf8")) as SessionEntry);
		await accept(entry, start, stop, projected?.toolCalls ?? 0);
		return true;
	};
	// Read with the caller's handle, which a stream would close: a malformed oversized line is read again from it.
	// The next window is read while this one is parsed.
	const read = (at: number): Promise<Buffer> | undefined => {
		const length = Math.min(SCAN_WINDOW_BYTES, (end ?? Number.POSITIVE_INFINITY) - at);
		if (length <= 0) return undefined;
		const buffer = Buffer.allocUnsafe(length);
		return file.read(buffer, 0, length, at).then(({ bytesRead }) => buffer.subarray(0, bytesRead));
	};
	let next = read(position);
	try {
		for (let chunk = await next; chunk?.length; chunk = await next) {
			next = read(position + chunk.length);
			let at = 0;
			for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, at)) {
				const stop = position + newline;
				add(chunk.subarray(at, newline), stop);
				if (header) header = false;
				else if (projector) await longLine(projector.finish(), stop, true);
				else {
					const short = shortLine(stop, true);
					if (short !== true) await short;
				}
				if (stopped) return undefined;
				at = newline + 1;
				lineStart = position + at;
				parts = [];
				projector = undefined;
			}
			if (at < chunk.length) add(chunk.subarray(at), position + chunk.length);
			position += chunk.length;
		}
	} finally {
		// Settle a read ahead before the caller can close the file.
		await next?.catch(() => undefined);
	}
	const terminated = lineStart === position;
	const torn =
		!terminated &&
		!header &&
		!(projector ? await longLine(projector.finish(), position, false) : await shortLine(position, false));
	await settle();
	if (stopped) return undefined;
	if (torn) reportTornLine(path);
	if (invalidStructure) throw invalidStructure.error;
	if (invalidText) throw invalidText.error;
	return { size: torn ? lineStart : position, terminated: torn || terminated, torn };
}

/** One line's bytes in chunks of a history read. */
async function* readChunks(file: FileHandle, start: number, end: number): AsyncGenerator<Buffer> {
	for (let at = start; at < end; ) {
		const bytes = await readFrom(file, at, Math.min(SESSION_HISTORY_CHUNK_BYTES, end - at));
		yield bytes;
		at += bytes.length;
	}
}

/** Whether a line holds only what `String.prototype.trim` removes, decoded as `Buffer.toString("utf8")` would be. */
async function isBlank(chunks: AsyncIterable<Uint8Array>): Promise<boolean> {
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	for await (const chunk of chunks) if (decoder.decode(chunk, { stream: true }).trim()) return false;
	return !decoder.decode().trim();
}

/** The tool calls of an oversized assistant message, counted while its content was skipped. */
function withToolCalls(index: SessionResumeIndex, toolCalls: number): SessionResumeIndex {
	return { ...index, totals: { ...index.totals, toolCalls: index.totals.toolCalls + toolCalls } };
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
	/** Operations queued so far, counted so an append joins only a group that is still the last thing queued. */
	private queued = 0;
	private appendGroup: AppendGroup | undefined;
	private readonly keptFiles = new Map<string, KeptFile>();
	private closed = false;
	private poisoned: JsonlStoragePoisonedError | StorageUnavailableError | undefined;
	private readonly directory: string;
	private chatStore?: SessionChatRecords;
	get chatRecords(): SessionChatRecords {
		this.chatStore ??= {
			has: hasFileChatRecords,
			read: readFileChatRecords,
			readOrders: readFileChatOrders,
			append: (owner, anchor, record) => {
				record = boundedChatRecord(record);
				return this.run(async () => {
					const held = await this.locate(owner.id);
					if (
						held &&
						held.stats.birthtimeNs > 0n &&
						held.path === owner.file &&
						fileEpochOf(held.stats, JSON.stringify(held.header)) === owner.epoch
					)
						await appendFileChatRecord(owner, anchor, record);
				});
			},
		};
		return this.chatStore;
	}
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

	/**
	 * Open the store of `directory`, made when it is missing. With `createDirectory: false` a missing directory is left
	 * missing, for a caller that only reads files that are there.
	 */
	static async open(
		directory: string,
		options?: { exactDirectory?: boolean; scanExisting?: boolean; lockFs?: SessionLockFs; createDirectory?: boolean },
	): Promise<JsonlSessionStore> {
		const store = new JsonlSessionStore(directory, options?.exactDirectory === true, options?.lockFs);
		const create = options?.createDirectory !== false;
		if (options?.scanExisting === false) {
			if (create) await store.run(() => mkdir(store.directory, { recursive: true }).then(() => {}), false);
			return store;
		}
		// The scan lists the directory first, and makes it only when it is missing.
		const paths = await store.run(async () => {
			try {
				return await store.paths();
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || !create) return undefined;
				await mkdir(store.directory, { recursive: true });
				return [];
			}
		}, false);
		// A file whose stat stamp is the one a store of this process recorded is not read again: only stat.
		const unread = await store.run(async () => {
			const changed = new Set<string>();
			const all = paths ?? [];
			// The stats are independent: a batch of them is in flight at once.
			for (let at = 0; at < all.length; at += SCAN_STATS_IN_FLIGHT) {
				const batch = all.slice(at, at + SCAN_STATS_IN_FLIGHT);
				const stamps = await Promise.all(
					batch.map(async (path) => {
						// Only a state that holds what a read of the whole file finds: its listing summary too.
						const recorded = recordedFileStates.get(path);
						if (recorded?.summaryState === undefined) return undefined;
						const stats = await stat(path, { bigint: true }).catch(() => undefined);
						return stats !== undefined && store.stamp(stats) === recorded.stamp ? recorded : undefined;
					}),
				);
				for (const [index, path] of batch.entries()) {
					const recorded = stamps[index];
					if (recorded !== undefined) store.fileStates.set(path, recorded);
					else changed.add(path);
				}
			}
			return changed;
		}, false);
		if (paths === undefined || unread.size > 0) {
			await store.run(async () => {
				for (const path of paths ?? (await store.paths())) {
					if (paths !== undefined && !unread.has(path)) continue;
					try {
						await store.readSnapshot(path);
					} catch {
						store.fileStates.delete(path);
					}
				}
				// Files keep the order the directory lists them in, which a lookup of a duplicated ID follows.
				for (const path of paths ?? []) {
					const state = store.fileStates.get(path);
					if (state === undefined) continue;
					store.fileStates.delete(path);
					store.fileStates.set(path, state);
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
			const payload = Buffer.from(this.encode(header, entries));
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
			return { lastSeq: entries.length, epoch: fileEpochOf(stats, state.headerStamp) };
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
			// Rows are copied into one page-sized buffer and written a page at a time, not one write per row.
			const staging = Buffer.allocUnsafe(SESSION_HISTORY_PAGE_BYTES);
			let staged = 0;
			const flush = async () => {
				if (staged === 0) return;
				await handle.writeFile(staging.subarray(0, staged));
				staged = 0;
			};
			const write = async (part: Uint8Array) => {
				if (staged + part.byteLength > staging.length) await flush();
				if (part.byteLength >= staging.length) await handle.writeFile(part);
				else {
					staging.set(part, staged);
					staged += part.byteLength;
				}
			};
			const lookup = (id: string) =>
				findForkRow(id, ids, async function* (seq) {
					await flush();
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
				await write(Buffer.from(line));
				for await (const row of rows) {
					const start = size;
					const encoded = await encodedForkRow(source.store, row);
					for await (const part of encoded.chunks()) {
						await write(part);
						size += part.byteLength;
					}
					if (stream) {
						summary = applySessionSummaryEntries(summary, [row.entry]).state;
						index = await foldForkRow(index, row, lookup);
					}
					lastId = row.entry.id;
					ids.push(idHash(lastId));
					spans.push(start, size);
					await write(NEWLINE);
					size++;
				}
				await flush();
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
				const epoch = fileEpochOf(stats, headerStamp);
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
			await unlink(temporary).catch((cause: NodeJS.ErrnoException) => {
				if (cause.code !== "ENOENT") throw cause;
			});
		}
	}

	/**
	 * Appends made while an earlier one waits its turn join it and commit together, as a LevelDB log writer's queue does:
	 * under one lock, each is checked against the session as the appends before it leave it, and each file gets one write
	 * of all their lines. Every append is answered once its lines are written and the lock is released, as it was alone,
	 * and one that conflicts or fails validation rejects alone. Nothing is synced, as before.
	 */
	append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		if (this.closed) return Promise.reject(new StoreClosedError(this.descriptor));
		return new Promise((resolve, reject) => {
			const request: AppendRequest = { sessionId, entries, options, resolve, reject };
			const waiting = this.appendGroup;
			// Only a group still last in the queue: an append never passes an operation queued before it.
			if (waiting !== undefined && !waiting.started && waiting.queued === this.queued) {
				waiting.requests.push(request);
				return;
			}
			const group: AppendGroup = { requests: [request], queued: 0, started: false };
			this.appendGroup = group;
			this.run(() => this.commitAppends(group)).then(
				() => {
					for (const { answer, resolve, reject } of group.requests) {
						if (answer !== undefined && "lastSeq" in answer) resolve(answer);
						else reject(answer?.error);
					}
				},
				(cause: unknown) => {
					for (const pending of group.requests) pending.reject(cause);
				},
			);
			group.queued = this.queued;
		});
	}

	private async commitAppends(group: AppendGroup): Promise<void> {
		group.started = true;
		if (this.appendGroup === group) this.appendGroup = undefined;
		const staged = new Map<string, StagedFile>();
		for (const request of group.requests) {
			try {
				await this.stageAppend(staged, request);
			} catch (cause) {
				if (this.poisoned) throw this.poisoned;
				request.answer = { error: this.failure(cause) };
			}
		}
		for (const file of staged.values()) await this.writeStaged(file);
	}

	/** Checks one append against its session as the appends staged before it leave it, and stages its lines. */
	private async stageAppend(staged: Map<string, StagedFile>, request: AppendRequest): Promise<void> {
		const { sessionId, entries, options } = request;
		let file = staged.get(sessionId);
		if (file === undefined) {
			const { path, state, stats, header } = await this.forWrite(sessionId, options);
			file = {
				sessionId,
				path,
				identity: state.identity,
				epoch: fileEpochOf(stats, JSON.stringify(header)),
				before: state,
				entries: [],
				lines: [],
				requests: [],
			};
			staged.set(sessionId, file);
		} else {
			const lastSeq = file.before.lastSeq + file.entries.length;
			if (options.expectSeq !== lastSeq || (options.epoch !== undefined && options.epoch !== file.epoch))
				throw new SessionConflictError(sessionId, options.expectSeq, lastSeq);
		}
		validateSessionEntries(entries);
		// Encoded before anything is staged: an entry that cannot be encoded fails its append alone.
		const lines = entries.map((entry) => JSON.stringify(entry));
		if (entries.some((entry) => entry.type === "compaction")) {
			// The copy kept before a compaction holds every append made before it.
			if (!(await this.writeStaged(file))) {
				staged.delete(sessionId);
				throw new SessionConflictError(sessionId, options.expectSeq, file.before.lastSeq);
			}
			await copyFile(
				file.path,
				`${file.path}.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID()}.compact.bak`,
			);
		}
		for (const [index, entry] of entries.entries()) {
			file.entries.push(entry);
			file.lines.push(lines[index]!);
		}
		file.requests.push({ request, lastSeq: file.before.lastSeq + file.entries.length });
	}

	/**
	 * Writes the lines staged for `file` through its kept handle, then decides the appends they came from: false when the
	 * write failed and they fail. A failed write is cut off again; when that fails too the store is poisoned.
	 */
	private async writeStaged(file: StagedFile): Promise<boolean> {
		const { path, before, entries, lines, requests } = file;
		file.entries = [];
		file.lines = [];
		file.requests = [];
		if (entries.length === 0) {
			for (const { request, lastSeq } of requests) request.answer = { lastSeq };
			return true;
		}
		const offset = before.size;
		const payload = Buffer.from(`${before.terminated ? "" : "\n"}${lines.join("\n")}\n`);
		try {
			const kept = await this.keptFile(path, file.identity);
			// Cut by path, which names the handle's file under the lock: Windows refuses to truncate through a handle
			// opened to append.
			if (before.torn) await truncate(path, before.size);
			try {
				await writeAll(kept.handle, payload);
			} catch (cause) {
				try {
					await truncate(path, offset);
				} catch (rollbackCause) {
					this.poisoned = new JsonlStoragePoisonedError(path, cause as Error, rollbackCause as Error);
					throw this.poisoned;
				}
				throw cause;
			}
			const stats = await kept.handle.stat({ bigint: true });
			await this.remember(
				path,
				{
					...before,
					lastSeq: before.lastSeq + entries.length,
					lastEntryId: entries.at(-1)?.id,
					terminated: true,
					torn: false,
					witness: witnessAfter(before.witness, payload),
					...(before.summaryState === undefined
						? {}
						: { summaryState: applySessionSummaryEntries(before.summaryState, entries).state }),
				},
				undefined,
				stats,
			);
			file.before = this.fileStates.get(path)!;
			const rangeIndex = this.rangeIndexes.get(path);
			if (rangeIndex?.seenStamp === before.stamp) {
				rangeIndex.seenStamp = this.stamp(stats);
				rangeIndex.seenSize = Number(stats.size);
			}
			await this.indexAppended(path, before, entries, lines, offset + (before.terminated ? 0 : 1), stats);
			if (KEEP_APPEND_FILES) this.armIdle(path, kept);
			else await this.closeKept(path);
		} catch (cause) {
			await this.closeKept(path);
			const failure = cause === this.poisoned ? cause : this.failure(cause);
			for (const { request } of requests) request.answer = { error: failure };
			if (cause === this.poisoned) throw cause;
			return false;
		}
		for (const { request, lastSeq } of requests) request.answer = { lastSeq };
		return true;
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
				await this.closeKept(path);
				await rename(temporary, path);
				const headerStamp = JSON.stringify(header);
				const stats = await this.remember(path, {
					...state,
					headerStamp,
					witness,
					torn: false,
					terminated: state.lastSeq === 0 || state.terminated,
				});
				return { lastSeq: state.lastSeq, epoch: fileEpochOf(stats, headerStamp) };
			} finally {
				await unlink(temporary).catch((cause: NodeJS.ErrnoException) => {
					if (cause.code !== "ENOENT") throw cause;
				});
			}
		});
	}

	private async commit(path: string, header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<string> {
		await this.forgetIndex(path);
		await this.closeKept(path);
		const payload = Buffer.from(this.encode(header, entries));
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
		return fileEpochOf(await this.remember(path, state), state.headerStamp);
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
				const page = await this.readRangeOf(located.path, query, sessionId, located.state);
				return { ...page, entries: onlySeqs(page.entries, query.seqs) };
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
				// Fewer lines back from the end than on from the nearest known start: find the first line from the end.
				const back = index.completeCount - fromSeq + 1;
				if (index.completeEnd > 0 && back < fromSeq - 1 - cursor.seq) {
					const start = await lineStartFromEnd(file, index.completeEnd, back, query.signal);
					if (start !== undefined) cursor = { offset: start, seq: fromSeq - 1, header: false };
				}
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

	readEntrySizes(sessionId: string, startSeq: number, endSeq: number, limit?: number): Promise<SessionEntrySizes> {
		return this.run(async () => {
			const { jsonl } = await this.indexed(sessionId);
			const start = Math.max(1, startSeq);
			const seqs = seqRange(start, Math.min(endSeq, jsonl.index.seq, start + entrySizeLimit(limit) - 1));
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
			const length = Math.min(SESSION_HISTORY_CHUNK_BYTES, spanEnd(jsonl, reference.seq) - start);
			return readBytes(path, start, length, this.keptFor(path, jsonl.identity));
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

	/** Read this exact export file, not another file in the directory with the same session ID. An export is an
	 * input: do not create or rewrite a sidecar beside it. `history` reads any position of the same open file while
	 * `use` runs, and `saved.window()` reads its window when asked for: a whole-file copy never holds it. `use` awaits
	 * `saved.unchanged()` before it publishes anything it read, which rejects with a conflict when the file changed
	 * in place meanwhile. A legacy file's raw bytes are not v4 rows: `history.readRange` upgrades its entries,
	 * `readEntryChunk` does not. */
	[withForkFileWindow]<T>(
		file: string,
		use: (
			saved: {
				readonly header: SessionRecordHeader;
				readonly epoch: string;
				readonly lastSeq: number;
				readonly legacy: boolean;
				window(): Promise<SessionResume>;
				unchanged(): Promise<void>;
			},
			history: SessionHistorySource,
		) => Promise<T>,
	): Promise<T> {
		// What `use` throws, from the destination too, is the caller's failure, not this source's to wrap.
		// A failure to read this file stays this store's, as when the whole file was loaded.
		let used: { readonly error: unknown } | undefined;
		const readFailures = new WeakSet<object>();
		const reading =
			<A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
			(...args: A): Promise<R> =>
				read(...args).catch((error: unknown) => {
					if (typeof error === "object" && error !== null) readFailures.add(error);
					throw error;
				});
		return this.run(async () => {
			const path = resolve(file);
			const handle = await open(path, "r");
			try {
				const stats = await handle.stat({ bigint: true });
				const stored = await readFirstLineFrom(handle, HEADER_READ_CHUNK_BYTES, 0);
				const header = await this.readHeaderAt(path, stored);
				const input: FileWindowInput = { handle, legacy: isCurrentSessionHeader(stored) ? undefined : stored };
				const headerStamp = JSON.stringify(header);
				const topology = await this.foldFile(path, fileEpochOf(stats, headerStamp), () => true, input);
				// Positions need only the topology pass. The active branch is folded again only for the window.
				const jsonl = await this.buildIndex(path, headerStamp, stats, input, { topology, branch: false });
				const { epoch, seq: lastSeq } = jsonl.index;
				let window: Promise<SessionResume> | undefined;
				const unchanged = async () => {
					const after = await handle.stat({ bigint: true });
					if (stats.size === after.size && stats.mtimeNs === after.mtimeNs && stats.ctimeNs === after.ctimeNs)
						return;
					// A writer appending after the indexed rows leaves every row read through this handle as it was.
					if (
						after.size > stats.size &&
						(await boundaryHolds(handle, { witness: jsonl.witness, witnessEnd: jsonl.size }))
					)
						return;
					throw new SessionConflictError(header.id, lastSeq, lastSeq);
				};
				return await use(
					{
						header,
						epoch,
						lastSeq,
						legacy: input.legacy !== undefined,
						window: reading(() => {
							window ??= this.buildIndex(path, headerStamp, stats, input, { topology, branch: true }).then(
								(active) => this.windowFromIndex(path, header, active, active.index, input),
							);
							return window;
						}),
						unchanged,
					},
					{
						descriptor: this.descriptor,
						readEntrySizes: reading(async (_id: string, from: number, to: number, limit?: number) => {
							const end = Math.min(lastSeq, to, from + entrySizeLimit(limit) - 1);
							return {
								epoch,
								lastSeq,
								sizes: seqRange(from, end).map((seq) => ({
									seq,
									bytes: spanEnd(jsonl, seq) - spanStart(jsonl, seq),
								})),
							};
						}),
						readEntryChunk: reading((ref: OversizedSessionEntry, offset: number) =>
							readFrom(
								handle,
								spanStart(jsonl, ref.seq) + offset,
								Math.min(
									SESSION_HISTORY_CHUNK_BYTES,
									spanEnd(jsonl, ref.seq) - spanStart(jsonl, ref.seq) - offset,
								),
							),
						),
						readRange: reading(async (_id: string, from: number, to: number) => ({
							epoch,
							lastSeq,
							startSeq: from,
							entries: (await this.entriesAt(path, jsonl, seqRange(from, Math.min(lastSeq, to)), input)).map(
								(held) => held.entry,
							),
						})),
					},
				).catch((error: unknown) => {
					used = { error };
					throw error;
				});
			} finally {
				await handle.close();
			}
		}, false).catch((error: unknown) => {
			throw used === undefined || readFailures.has(used.error as object) ? error : used.error;
		});
	}

	readForkWindow(sessionId: string, entryId: string, options?: { readonly archivedReceipts: true }) {
		return this.run(async () => {
			const { indexedForkWindow, rangedForkMetadata, scanForkRecords } = await import("./fork-window.js");
			for (;;) {
				const { path, header, jsonl } = await this.indexed(sessionId);
				const file = await open(path, "r");
				try {
					const stat = await file.stat({ bigint: true });
					if (!matchesIndexRevision(stat, jsonl)) continue;
					const leaf = (await this.seqInFile(path, jsonl, entryId, file)) ?? 0;
					const many = (seqs: readonly number[]) => this.entriesAt(path, jsonl, seqs, { handle: file });
					const metadata = rangedForkMetadata(
						(seq) => [spanStart(jsonl, seq), spanEnd(jsonl, seq)],
						(start, n) => readFrom(file, start, n),
					);
					const scan = scanForkRecords(metadata);
					let fork = jsonl.fork;
					const forkIndex = async (): Promise<JsonlForkIndex> => {
						if (fork) return fork;
						// An older sidecar has offsets but not label order. Fill the optional cache only when
						// a fork needs it, reading bounded metadata once rather than decoding the file per fork.
						const active = new Map<string, number>(),
							catalog: Array<readonly [number, ForkCatalogType]> = [];
						for await (const m of scan(
							[[1, jsonl.index.seq]],
							[],
							["label", "session_info", "session_summary", "branch_summary"],
						)) {
							if (isForkCatalogType(m.type)) catalog.push([m.seq, m.type]);
							else {
								const target = m.label?.targetId ?? m.labelTarget;
								if (target === undefined) continue;
								if (m.label?.label || m.labelSet) active.set(target, m.seq);
								else active.delete(target);
							}
						}
						fork = { labels: [...active.values()], catalog };
						await this.keepIndex(path, { ...jsonl, fork });
						return fork;
					};
					return await indexedForkWindow(
						header,
						jsonl.index,
						leaf,
						(lo, hi) => many(seqRange(lo, hi)),
						many,
						metadata,
						async function* (ranges, kinds, types = []) {
							if (kinds.length || types.includes("label") || types.includes("custom")) {
								yield* scan(ranges, kinds, types);
								return;
							}
							for (const [seq, type] of (await forkIndex()).catalog)
								if (types.includes(type) && ranges.some(([a, b]) => seq >= a && seq <= b)) yield { seq, type };
						},
						options,
						async () => (await forkIndex()).labels,
					);
				} finally {
					await file.close();
				}
			}
		});
	}

	readChildCatalogCut(sessionId: string) {
		return this.run(async () => childCatalogCut((await this.indexed(sessionId)).jsonl.index));
	}
	/** The snapshot entries the session's index locates; no line of the file is read (#5554). */
	readSnapshotCut(
		sessionId: string,
		options: { readonly leafSeq?: number } = {},
	): Promise<SessionSnapshotCut | undefined> {
		return this.run(async () => {
			const { index } = (await this.indexed(sessionId)).jsonl;
			if (options.leafSeq !== undefined && options.leafSeq > index.seq) return undefined;
			return snapshotCutOf(index, options.leafSeq);
		});
	}
	/** The lines at `seqs`, each read from where the index places it, without reading the lines between them. */
	readSelectedPage(
		sessionId: string,
		seqs: readonly number[],
		epoch: string,
		options: { readonly limit?: number; readonly backward?: boolean } = {},
	): Promise<SessionHistoryPage> {
		return this.run(async () => {
			const limit = entrySizeLimit(options.limit);
			const wanted = options.backward ? seqs.slice(-limit) : seqs.slice(0, limit);
			if (!wanted.length) return { items: [] };
			const { path, jsonl } = await this.indexed(sessionId);
			if (jsonl.index.epoch !== epoch) throw new SessionConflictError(sessionId, wanted.at(-1)!, jsonl.index.seq);
			const plan = selectedPagePlan(
				sessionId,
				wanted,
				jsonl.index.seq,
				(seq) => spanEnd(jsonl, seq) - spanStart(jsonl, seq),
				options.backward,
			);
			if ("oversized" in plan) return { items: [{ kind: "oversized", sessionId, epoch, ...plan.oversized }] };
			return { items: await this.entriesAt(path, jsonl, plan.seqs) };
		});
	}
	readResume(sessionId: string, leafId?: string, options?: { deferChildRecords: true }): Promise<SessionResume> {
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
			const result = await this.windowFromIndex(path, header, jsonl, index, undefined, options?.deferChildRecords);
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
		deferChildRecords = false,
	): Promise<SessionResume> {
		const plan = sessionResumePlan(index, index.leafSeq, deferChildRecords);
		const branchSeqs = plan.branch.flatMap(([low, high]) => seqRange(low, high));
		const read = await this.entriesAt(path, jsonl, [...branchSeqs, ...plan.state], input);
		const inBranch = new Set(branchSeqs);
		const branch = read.filter((held) => inBranch.has(held.seq));
		const state = read.filter((held) => !inBranch.has(held.seq));
		const leaf = index.leafSeq > 0 ? (branch.find((held) => held.seq === index.leafSeq)?.entry.id ?? null) : null;
		const resume = sessionResumeFrom(index, header, branch, state, leaf, plan.children);
		if (resume.compaction)
			await readEarlierCompletionIntents(index, resume, (seqs) => this.entriesAt(path, jsonl, seqs, input, true));
		return resume;
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
		const { path, header, stats } = located;
		const jsonl = await this.indexFor(path, header, stats);
		// Indexing reads the file and writes none of it: the stat taken to find it is still the file's.
		const prior = this.fileStates.get(path);
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
				...(prior?.summaryState !== undefined && prior.stamp === this.stamp(stats)
					? { summaryState: prior.summaryState }
					: {}),
			},
			jsonl.torn ? jsonl.size : undefined,
			stats,
		);
		return { path, header, jsonl };
	}

	private async indexFor(path: string, header: SessionRecordHeader, stats: BigIntStats): Promise<JsonlIndex> {
		const identity = `${stats.dev}:${stats.ino}`;
		const headerStamp = JSON.stringify(header);
		const epoch = fileEpochOf(stats, headerStamp);
		let cached = this.indexes.get(path) ?? (await readSidecar(path));
		// An older build's sidecar holds the epoch with the creation time in it. It is this file's when the file's
		// identity, creation time and header still match it, and is read once with this build's epoch then rewritten.
		const older =
			cached !== undefined &&
			cached.index.epoch !== epoch &&
			cached.index.epoch === legacyFileEpochOf(stats, headerStamp);
		if (cached !== undefined && older) cached = { ...cached, index: { ...cached.index, epoch } };
		if (
			cached !== undefined &&
			cached.identity === identity &&
			cached.birthtimeNs === String(stats.birthtimeNs) &&
			cached.headerStamp === headerStamp &&
			cached.index.epoch === epoch
		) {
			const fileSize = Number(stats.size);
			const kept = this.keptFor(path, identity);
			if (
				cached.fileSize === fileSize &&
				cached.mtimeNs === String(stats.mtimeNs) &&
				(await witnessHolds(path, cached, kept))
			) {
				if (older) return this.keepIndex(path, cached);
				this.indexes.set(path, cached);
				return cached;
			}
			if (fileSize > cached.size && (await witnessHolds(path, cached, kept))) {
				const grown = await this.catchUp(path, cached, stats, kept);
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

	/** `folded` reuses a topology pass already made; `branch: false` keeps it and skips folding the active branch
	 * again, for a reader of positions that never selects a window. */
	private async buildIndex(
		path: string,
		headerStamp: string,
		stats: BigIntStats,
		input?: FileWindowInput,
		folded?: { readonly topology: FoldedFile; readonly branch: boolean },
	): Promise<JsonlIndex> {
		const identity = `${stats.dev}:${stats.ino}`;
		if (input === undefined) {
			// One handle reads the file for the fold and its witness: the kept one when there is one.
			const kept = this.keptFor(path, identity);
			if (kept !== undefined) return this.buildIndex(path, headerStamp, stats, { handle: kept }, folded);
			const handle = await open(path, "r");
			try {
				return await this.buildIndex(path, headerStamp, stats, { handle }, folded);
			} finally {
				await handle.close();
			}
		}
		const birthtimeNs = String(stats.birthtimeNs);
		const epoch = fileEpochOf(stats, headerStamp);
		const topology = folded?.topology ?? (await this.foldFile(path, epoch, () => true, input));
		const ranges =
			folded?.branch === false || topology.index.jumps.length === 0
				? undefined
				: branchRanges(topology.index, topology.index.leafSeq);
		const active =
			ranges === undefined
				? topology
				: await this.foldFile(path, epoch, (seq) => ranges.some(([low, high]) => seq >= low && seq <= high), input);
		return {
			identity,
			birthtimeNs,
			headerStamp,
			fileSize: Number(stats.size),
			mtimeNs: String(stats.mtimeNs),
			size: active.size,
			witness: await readFrom(
				input.handle,
				Math.max(0, active.size - WITNESS_BYTES),
				Math.min(active.size, WITNESS_BYTES),
			),
			terminated: active.terminated,
			torn: active.torn,
			spans: active.spans,
			ids: active.ids,
			fork: active.fork,
			index: active.index,
			sidecarSize: 0,
		};
	}

	private async foldFile(
		path: string,
		epoch: string,
		activeSeq: (seq: number) => boolean,
		pinned?: FileWindowInput,
	): Promise<FoldedFile> {
		let index: SessionResumeIndex = { ...foldSessionResume(undefined, [], undefined, activeSeq), epoch };
		const spans: number[] = [];
		const hashes: number[] = [];
		const activeLabels = new Map<string, number>();
		const catalog: Array<readonly [number, ForkCatalogType]> = [];
		const fork = (): JsonlForkIndex => ({ labels: [...activeLabels.values()], catalog });
		const ids = new Map<string, number>();
		let batch: SessionEntry[] = [],
			batchBytes = 0,
			extraToolCalls = 0;
		const flush = () => {
			if (!batch.length) return;
			for (const [i, entry] of batch.entries()) {
				const seq = index.seq + i + 1;
				if (entry.type === "label") {
					if (entry.label) activeLabels.set(entry.targetId, seq);
					else activeLabels.delete(entry.targetId);
				} else if (isForkCatalogType(entry.type)) catalog.push([seq, entry.type]);
			}
			index = foldSessionResume(index, batch, (id) => ids.get(id), activeSeq);
			if (extraToolCalls) index = withToolCalls(index, extraToolCalls);
			batch = [];
			batchBytes = 0;
			extraToolCalls = 0;
		};
		const take = (entry: SessionEntry, start: number, end: number, toolCalls: number) => {
			const bytes = end - start;
			if (batch.length && batchBytes + bytes > SCAN_WINDOW_BYTES) flush();
			spans.push(start, end);
			hashes.push(idHash(entry.id));
			ids.set(entry.id, spans.length / 2);
			batch.push(entry);
			batchBytes += bytes;
			extraToolCalls += toolCalls;
			if (batch.length >= INDEX_BATCH_ENTRIES || batchBytes >= SCAN_WINDOW_BYTES) flush();
			return true;
		};
		const file = pinned?.handle ?? (await open(path, "r"));
		try {
			const scanned = (await scanEntries(path, file, 0, undefined, true, take, pinned?.legacy))!;
			flush();
			return { index, spans, ids: hashes, fork: fork(), ...scanned };
		} finally {
			if (!pinned) await file.close();
		}
	}

	private async catchUp(
		path: string,
		cached: JsonlIndex,
		stats: BigIntStats,
		kept: FileHandle | undefined,
	): Promise<JsonlIndex | undefined> {
		const from = cached.size - cached.witness.length;
		if (Number(stats.size) - from > SCAN_WINDOW_BYTES) return this.streamCatchUp(path, cached, stats);
		const bytes = await readBytes(path, from, Number(stats.size) - from, kept);
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
			witness: witnessAfter(cached.witness, appended.subarray(0, size - offset)),
			terminated: appended.length === 0 ? cached.terminated : terminated,
			torn,
			spans,
			ids: [...cached.ids, ...entries.map((entry) => idHash(entry.id))],
			fork: appendedForkIndex(cached, entries),
			index,
		};
	}

	/**
	 * Index an appended suffix larger than one scan window line by line, as {@link foldFile} would, from the end of the
	 * indexed prefix, rather than read the whole file again or hold the suffix. Undefined when the cache cannot be
	 * extended: the suffix does not continue the cached last line, or it branches, which needs a full fold.
	 */
	private async streamCatchUp(path: string, cached: JsonlIndex, stats: BigIntStats): Promise<JsonlIndex | undefined> {
		const file = await open(path, "r");
		try {
			let start = cached.size;
			if (!cached.terminated) {
				if ((await readFrom(file, start, 1))[0] !== 10) return undefined;
				start += 1;
			}
			let index = cached.index;
			let fork = cached.fork;
			let lastId = cached.index.lastId;
			const spans = [...cached.spans];
			const hashes = [...cached.ids];
			const appended = new Map<string, number>();
			let batch: SessionEntry[] = [],
				batchBytes = 0,
				extraToolCalls = 0;
			const flush = async () => {
				if (!batch.length) return;
				const seqs = new Map<string, number>();
				for (const id of foreignResumeIds(index, batch)) {
					const seq = appended.get(id) ?? (await this.seqInFile(path, cached, id));
					if (seq !== undefined) seqs.set(id, seq);
				}
				fork = appendedForkIndex({ index, fork }, batch);
				index = foldSessionResume(index, batch, (id) => seqs.get(id));
				if (extraToolCalls) index = withToolCalls(index, extraToolCalls);
				let seq = index.seq - batch.length;
				for (const entry of batch) appended.set(entry.id, ++seq);
				batch = [];
				batchBytes = 0;
				extraToolCalls = 0;
			};
			const take = (entry: SessionEntry, lineStart: number, end: number, toolCalls: number) => {
				// The same condition as resumeIndexNeedsRefold: a suffix that branches is folded again from the start.
				if (entry.parentId !== lastId) return false;
				lastId = entry.id;
				spans.push(lineStart, end);
				hashes.push(idHash(entry.id));
				batch.push(entry);
				batchBytes += end - lineStart;
				extraToolCalls += toolCalls;
				return batch.length >= INDEX_BATCH_ENTRIES || batchBytes >= SCAN_WINDOW_BYTES
					? flush().then(() => true)
					: true;
			};
			const scanned = await scanEntries(path, file, start, Number(stats.size), false, take);
			if (!scanned) return undefined;
			await flush();
			return {
				...cached,
				fileSize: Number(stats.size),
				mtimeNs: String(stats.mtimeNs),
				...scanned,
				witness: await witnessAt(file, scanned.size),
				spans,
				ids: hashes,
				fork,
				index,
			};
		} finally {
			await file.close();
		}
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
		stats: BigIntStats,
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
			fork: appendedForkIndex(cached, entries),
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
		exactRevision = false,
	): Promise<SessionStoredEntry[]> {
		const wanted = [...new Set(seqs.filter((seq) => seq >= 1 && seq <= jsonl.index.seq))].sort((a, b) => a - b);
		const entries: SessionStoredEntry[] = [];
		if (wanted.length === 0) return entries;
		const kept = input === undefined ? this.keptFor(path, jsonl.identity) : undefined;
		const file = input?.handle ?? kept ?? (await open(path, "r"));
		try {
			if (exactRevision && !matchesIndexRevision(await file.stat({ bigint: true }), jsonl)) return [];
			let index = 0;
			while (index < wanted.length) {
				const first = wanted[index] as number;
				let last = first;
				let next = index + 1;
				while (next < wanted.length) {
					const candidate = wanted[next] as number;
					if (exactRevision && candidate !== last + 1) break;
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
			if (exactRevision && !matchesIndexRevision(await file.stat({ bigint: true }), jsonl)) return [];
		} finally {
			if (!input && !kept) await file.close();
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
		const oversized = (seq: number) => spanEnd(jsonl, seq) - spanStart(jsonl, seq) > SCAN_WINDOW_BYTES;
		if (!candidates.some(oversized))
			return (await this.entriesAt(path, jsonl, candidates, pinned ? { handle: pinned } : undefined)).findLast(
				(held) => held.entry.id === entryId,
			)?.seq;
		// Read an oversized candidate's ID from the same open file without decoding its body.
		const kept = pinned ? undefined : this.keptFor(path, jsonl.identity);
		const file = pinned ?? kept ?? (await open(path, "r"));
		try {
			for (let at = candidates.length - 1; at >= 0; at--) {
				const seq = candidates[at]!;
				const start = spanStart(jsonl, seq);
				const end = spanEnd(jsonl, seq);
				const entry = oversized(seq)
					? (await jsonlEntryProjection(readChunks(file, start, end)))?.entry
					: (JSON.parse((await readFrom(file, start, end - start)).toString("utf8")) as SessionEntry);
				if (entry?.id === entryId) return seq;
			}
		} finally {
			if (!pinned && !kept) await file.close();
		}
		return undefined;
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
			const owner: ChatRecordOwner = {
				file: located.path,
				id: sessionId,
				epoch: fileEpochOf(located.stats, JSON.stringify(located.header)),
			};
			await this.closeKept(located.path);
			await unlink(located.path);
			this.fileStates.delete(located.path);
			await this.forgetIndex(located.path);
			await deleteFileChatRecords(owner).catch(() => {});
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
		return this.queue.then(async () => {
			for (const path of [...this.keptFiles.keys()]) await this.closeKept(path);
		});
	}

	/** Closes the handles kept for the session's files: nothing live writes it any more. */
	releaseSession(sessionId: string): Promise<void> {
		if (this.closed) return Promise.resolve();
		return this.run(async () => {
			for (const [path, state] of this.fileStates) if (state.headerId === sessionId) await this.closeKept(path);
		}, false);
	}

	/**
	 * The handle kept open to append to the file at `path`, opened when there is none for the file `identity` names. It
	 * is used only while the caller holds the directory lock and has found that the path still names that file.
	 */
	private async keptFile(path: string, identity: string): Promise<KeptFile> {
		const kept = this.keptFiles.get(path);
		if (kept?.identity === identity) {
			this.keptFiles.delete(path);
			this.keptFiles.set(path, kept);
			return kept;
		}
		await this.closeKept(path);
		// Without O_CREAT: a file removed meanwhile is not made again.
		const handle = await open(path, constants.O_RDWR | constants.O_APPEND);
		const opened: KeptFile = { handle, identity, idle: undefined, armed: 0 };
		this.keptFiles.set(path, opened);
		while (this.keptFiles.size > KEPT_FILES) await this.closeKept(this.keptFiles.keys().next().value as string);
		return opened;
	}

	/** The kept handle of the file at `path`, while it is the file `identity` names, to read through. */
	private keptFor(path: string, identity: string): FileHandle | undefined {
		const kept = this.keptFiles.get(path);
		if (kept?.identity !== identity) return undefined;
		this.armIdle(path, kept);
		return kept.handle;
	}

	private async closeKept(path: string): Promise<void> {
		const kept = this.keptFiles.get(path);
		if (kept === undefined) return;
		this.keptFiles.delete(path);
		clearTimeout(kept.idle);
		await kept.handle.close().catch(() => undefined);
	}

	/** Closes the handle once it goes unused for {@link KEPT_FILE_IDLE_MS}, between two of this store's operations. */
	private armIdle(path: string, kept: KeptFile): void {
		clearTimeout(kept.idle);
		const armed = ++kept.armed;
		kept.idle = setTimeout(() => {
			this.queue = this.queue.then(async () => {
				if (this.keptFiles.get(path) === kept && kept.armed === armed) await this.closeKept(path);
			});
		}, KEPT_FILE_IDLE_MS);
		kept.idle.unref();
	}

	private run<T>(operation: () => Promise<T>, locked = true, signal?: AbortSignal): Promise<T> {
		if (this.closed) return Promise.reject(new StoreClosedError(this.descriptor));
		this.queued++;
		const result = this.queue.then(async () => {
			if (this.poisoned) throw this.poisoned;
			try {
				return await (locked ? this.exclusive(operation, signal) : operation());
			} catch (cause) {
				if (signal?.aborted && cause === signal.reason) throw cause;
				throw this.failure(cause);
			}
		});
		this.queue = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	/** What an operation rejects with for `cause`: the session errors as they are, any other as the store unavailable. */
	private failure(cause: unknown): unknown {
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
			return cause;
		return new StorageUnavailableError(this.descriptor, cause as Error);
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
					// The lock is the directory `lockfilePath` names, so resolving `directory`'s links, one call per part of
					// its path on every acquire, changes nothing about who holds it.
					realpath: false,
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
			// While the path names the file a handle is kept open on, its header is read through that handle, not opened.
			const kept = this.keptFiles.get(path);
			const current = kept && (await stat(path, { bigint: true }).catch(() => undefined));
			if (current !== undefined && `${current.dev}:${current.ino}` === kept?.identity) {
				const stored = await readFirstLineFrom(kept.handle, headerLineBytes(cached.headerStamp), 0).catch(
					() => undefined,
				);
				if (stored === undefined) return undefined;
				if (stored.id !== sessionId) {
					this.fileStates.delete(path);
					return undefined;
				}
				this.armIdle(path, kept);
				return { path, header: await this.readHeaderAt(path, stored), stored, stats: current, state: cached };
			}
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
		const stats = await this.remember(
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
		bindChatEpoch(header, fileEpochOf(stats, JSON.stringify(header)));
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
				completeWitness = witnessAfter(witness, bytes.subarray(0, newline + 1));
			}
			witness = witnessAfter(witness, bytes);
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
		content: Buffer,
	): Omit<SessionFileState, "stamp" | "identity" | "size"> {
		return {
			headerStamp: JSON.stringify(header),
			lastSeq: entries.length,
			headerId: header.id,
			lastEntryId: entries.at(-1)?.id,
			terminated: content.at(-1) === 10,
			torn: false,
			witness: witnessOf(content),
			summaryState: applySessionSummaryEntries(undefined, entries).state,
		};
	}

	/**
	 * Records the file as it is now; `size` ends it before a torn last line. `stats` are the file's, taken since its last
	 * change, when the caller has them.
	 */
	private async remember(
		path: string,
		state: Omit<SessionFileState, "stamp" | "identity" | "size">,
		size?: number,
		stats?: BigIntStats,
	): Promise<BigIntStats> {
		stats ??= await stat(path, { bigint: true });
		this.keepFileState(path, {
			...state,
			stamp: this.stamp(stats),
			identity: `${stats.dev}:${stats.ino}`,
			size: size ?? Number(stats.size),
		});
		return stats;
	}

	private keepFileState(path: string, state: SessionFileState): void {
		this.fileStates.set(path, state);
		recordFileState(path, state);
	}

	/**
	 * Foreign appends read only the header, at most 64 known boundary bytes, and new bytes.
	 * The witness detects a changed append boundary, not arbitrary edits in old history.
	 * Structural changes require an explicit load; they never trigger a hidden full reread.
	 */
	private async forWrite(
		sessionId: string,
		options: SessionWriteOptions,
	): Promise<{ path: string; state: SessionFileState; stats: BigIntStats; header: SessionRecordHeader }> {
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
				this.keepFileState(path, state);
			}
		}
		if (
			state.lastSeq !== options.expectSeq ||
			(options.epoch !== undefined && fileEpochOf(stats, JSON.stringify(header)) !== options.epoch)
		)
			throw new SessionConflictError(sessionId, options.expectSeq, state.lastSeq);
		return { path, state, stats, header };
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

function matchesIndexRevision(stats: BigIntStats, index: JsonlIndex): boolean {
	return (
		index.identity === `${stats.dev}:${stats.ino}` &&
		index.birthtimeNs === String(stats.birthtimeNs) &&
		index.fileSize === Number(stats.size) &&
		index.mtimeNs === String(stats.mtimeNs)
	);
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

/** Node's own write size for a file: a larger payload is written a slice at a time, as `appendFile` writes it. */
const WRITE_SLICE_BYTES = 512 * 1024;

/** Writes all of `bytes` at the end of the file `file` was opened to append to. */
async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
	for (let at = 0; at < bytes.length; ) {
		const { bytesWritten } = await file.write(bytes, at, Math.min(WRITE_SLICE_BYTES, bytes.length - at));
		at += bytesWritten;
	}
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

async function readBytes(path: string, position: number, length: number, kept?: FileHandle): Promise<Buffer> {
	if (kept !== undefined) return readFrom(kept, position, length);
	const file = await open(path, "r");
	try {
		return await readFrom(file, position, length);
	} finally {
		await file.close();
	}
}

async function readWitness(path: string, size: number, kept?: FileHandle): Promise<Buffer> {
	const from = Math.max(0, size - 64);
	return readBytes(path, from, size - from, kept);
}

async function witnessHolds(path: string, jsonl: JsonlIndex, kept?: FileHandle): Promise<boolean> {
	try {
		return (await readWitness(path, jsonl.size, kept)).equals(jsonl.witness);
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
		fork: jsonl.fork,
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

function validForkIndex(value: unknown, last: number): JsonlForkIndex | undefined {
	if (value === null || typeof value !== "object" || !("labels" in value) || !("catalog" in value)) return undefined;
	const seq = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= last;
	if (
		!Array.isArray(value.labels) ||
		!value.labels.every(seq) ||
		!Array.isArray(value.catalog) ||
		!value.catalog.every((row) => Array.isArray(row) && row.length === 2 && seq(row[0]) && isForkCatalogType(row[1]))
	)
		return undefined;
	return value as JsonlForkIndex;
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
		(stored.version !== JSONL_INDEX_VERSION && stored.version !== BIRTHTIME_INDEX_VERSION) ||
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
		fork: validForkIndex(stored.fork, stored.index.seq),
		sidecarSize: stored.size,
	};
}
