import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, createReadStream, rmdir as rmdirCallback, stat as statCallback } from "node:fs";
import {
	appendFile,
	copyFile,
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
import { createSessionCwdMatcher } from "../../../utils/canonical-path.ts";
import { readLines } from "../../../utils/lines.ts";
import type { SessionEntry } from "../../session-manager-types.ts";
import { validateSessionEntryStructure } from "./entry-structure.js";
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
import {
	isCurrentSessionHeader,
	type StoredSessionHeader,
	upgradeLegacySessionEntries,
	upgradeLegacySessionHeader,
} from "./legacy-format.js";
import {
	branchRanges,
	foldSessionResume,
	foreignResumeIds,
	isSessionResumeIndex,
	latestCompactionOf,
	resumeIndexNeedsRefold,
	type SessionResumeIndex,
	sessionResumeFrom,
	sessionResumeOf,
	sessionResumePlan,
	sessionTailFrom,
	stateSeqsBefore,
} from "./session-resume.js";
import { summarizeSession } from "./session-summary.js";
import type {
	SessionCompactionPoint,
	SessionEntryRange,
	SessionListQuery,
	SessionRecordHeader,
	SessionResume,
	SessionSnapshot,
	SessionStore,
	SessionStoredEntry,
	SessionSummary,
	SessionTail,
	SessionWriteOptions,
	StorageDescriptor,
} from "./types.js";
import { matchesSessionIdPrefix } from "./types.js";
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
	readonly index: SessionResumeIndex;
	readonly sidecarSize: number;
}

interface IndexedSession {
	readonly path: string;
	readonly header: SessionRecordHeader;
	readonly jsonl: JsonlIndex;
}

export const JSONL_INDEX_VERSION = 1;
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

export class JsonlSessionStore implements SessionStore {
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private poisoned: JsonlStoragePoisonedError | StorageUnavailableError | undefined;
	private readonly directory: string;
	private readonly fileStates = new Map<string, SessionFileState>();
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
	): Promise<{ readonly lastSeq: number }> {
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
			await this.remember(path, this.contentState(header, entries, payload));
			return { lastSeq: entries.length };
		}, true);
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
			await this.remember(path, {
				...state,
				lastSeq,
				lastEntryId: entries.at(-1)?.id,
				terminated: true,
				torn: false,
				witness: witnessOf(Buffer.concat([state.witness, Buffer.from(payload)])),
			});
			await this.indexAppended(path, state, entries, lines, offset + (state.terminated ? 0 : 1));
			return { lastSeq };
		});
	}

	replace(
		sessionId: string,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		return this.run(async () => {
			const { path } = await this.forWrite(sessionId, options);
			validateSessionHeader(header);
			validateSessionEntries(entries);
			if (header.id !== sessionId) throw new SessionIdMismatchError(sessionId, header.id);
			await this.commit(path, header, entries);
			return { lastSeq: entries.length };
		});
	}

	private async commit(path: string, header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<void> {
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
		await this.remember(path, this.contentState(header, entries, payload));
	}

	load(sessionId: string): Promise<SessionSnapshot> {
		return this.run(async () => {
			const located = await this.locate(sessionId);
			if (!located) throw new SessionNotFoundError(sessionId);
			return this.readPersisted(located.path, located.stored);
		});
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

	readRange(sessionId: string, startSeq: number, endSeq: number): Promise<SessionEntryRange> {
		return this.run(async () => {
			const { path, jsonl } = await this.indexed(sessionId);
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

	readResume(sessionId: string, leafId?: string): Promise<SessionResume> {
		return this.run(async () => {
			if (leafId !== undefined) validateSessionText("entry.id", leafId);
			const { path, header, jsonl } = await this.indexed(sessionId);
			const leafSeq =
				leafId === undefined ? jsonl.index.leafSeq : ((await this.seqInFile(path, jsonl, leafId)) ?? 0);
			if (leafSeq !== jsonl.index.leafSeq) {
				const read = await this.entriesAt(path, jsonl, seqRange(1, jsonl.index.seq));
				const entries = read.map((held) => held.entry);
				return { ...sessionResumeOf(header, entries, leafId), epoch: jsonl.index.epoch };
			}
			const index = jsonl.index;
			const plan = sessionResumePlan(index);
			const branchSeqs = plan.branch.flatMap(([low, high]) => seqRange(low, high));
			const read = await this.entriesAt(path, jsonl, [...branchSeqs, ...plan.state]);
			const inBranch = new Set(branchSeqs);
			const branch = read.filter((held) => inBranch.has(held.seq));
			const state = read.filter((held) => !inBranch.has(held.seq));
			const leaf = leafSeq > 0 ? (branch.find((held) => held.seq === leafSeq)?.entry.id ?? null) : null;
			return sessionResumeFrom(index, header, branch, state, leaf);
		});
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

	private async buildIndex(path: string, headerStamp: string, stats: BigIntStats): Promise<JsonlIndex> {
		const identity = `${stats.dev}:${stats.ino}`;
		const birthtimeNs = String(stats.birthtimeNs);
		const epoch = fileEpoch(`${identity}:${birthtimeNs}`, headerStamp);
		const topology = await this.foldFile(path, epoch, () => true);
		const ranges =
			topology.index.jumps.length === 0 ? undefined : branchRanges(topology.index, topology.index.leafSeq);
		const folded =
			ranges === undefined
				? topology
				: await this.foldFile(path, epoch, (seq) => ranges.some(([low, high]) => seq >= low && seq <= high));
		return {
			identity,
			birthtimeNs,
			headerStamp,
			fileSize: Number(stats.size),
			mtimeNs: String(stats.mtimeNs),
			size: folded.size,
			witness: await readWitness(path, folded.size),
			terminated: folded.terminated,
			torn: folded.torn,
			spans: folded.spans,
			index: folded.index,
			sidecarSize: 0,
		};
	}

	private async foldFile(
		path: string,
		epoch: string,
		activeSeq: (seq: number) => boolean,
	): Promise<{
		readonly index: SessionResumeIndex;
		readonly spans: number[];
		readonly size: number;
		readonly terminated: boolean;
		readonly torn: boolean;
	}> {
		let index: SessionResumeIndex = { ...foldSessionResume(undefined, [], undefined, activeSeq), epoch };
		const spans: number[] = [];
		const ids = new Map<string, number>();
		let batch: SessionEntry[] = [];
		const flush = () => {
			if (batch.length === 0) return;
			validateSessionEntryStructure(batch, path);
			validateSessionEntries(batch);
			index = foldSessionResume(index, batch, (id) => ids.get(id), activeSeq);
			batch = [];
		};
		const take = (start: number, line: Buffer) => {
			const text = line.toString("utf8");
			if (!text.trim()) return;
			const entry = JSON.parse(text) as SessionEntry;
			spans.push(start, start + line.length);
			batch.push(entry);
			ids.set(entry.id, spans.length / 2);
			if (batch.length >= INDEX_BATCH_ENTRIES) flush();
		};
		const input = createReadStream(path, { highWaterMark: SCAN_WINDOW_BYTES });
		let parts: Buffer[] = [];
		let lineStart = 0;
		let position = 0;
		let header = true;
		try {
			for await (const chunk of input as AsyncIterable<Buffer>) {
				let from = 0;
				for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, from)) {
					parts.push(chunk.subarray(from, newline));
					const line = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
					parts = [];
					if (header) header = false;
					else take(lineStart, line);
					from = newline + 1;
					lineStart = position + from;
				}
				if (from < chunk.length) parts.push(chunk.subarray(from));
				position += chunk.length;
			}
		} finally {
			input.destroy();
		}
		const rest = parts.length === 0 ? undefined : Buffer.concat(parts);
		if (rest === undefined || header) {
			flush();
			return { index, spans, size: position, terminated: rest === undefined, torn: false };
		}
		const unterminated = parseUnterminated(rest.toString("utf8"));
		if (unterminated === undefined) {
			flush();
			reportTornLine(path);
			return { index, spans, size: lineStart, terminated: true, torn: true };
		}
		spans.push(lineStart, position);
		batch.push(unterminated);
		ids.set(unterminated.id, spans.length / 2);
		flush();
		return { index, spans, size: position, terminated: false, torn: false };
	}

	private async catchUp(path: string, cached: JsonlIndex, stats: BigIntStats): Promise<JsonlIndex | undefined> {
		const from = cached.size - cached.witness.length;
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
			index: await this.foldAppended(path, cached, entries),
		};
		if (next.size - next.sidecarSize >= SIDECAR_REFRESH_BYTES) await this.keepIndex(path, next);
		else this.indexes.set(path, next);
	}

	private async entriesAt(path: string, jsonl: JsonlIndex, seqs: readonly number[]): Promise<SessionStoredEntry[]> {
		const wanted = [...new Set(seqs.filter((seq) => seq >= 1 && seq <= jsonl.index.seq))].sort((a, b) => a - b);
		const entries: SessionStoredEntry[] = [];
		if (wanted.length === 0) return entries;
		const file = await open(path, "r");
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
					entries.push({ seq, entry: JSON.parse(line.toString("utf8")) as SessionEntry });
				}
				index = next;
			}
		} finally {
			await file.close();
		}
		return entries;
	}

	private async seqInFile(path: string, jsonl: JsonlIndex, entryId: string): Promise<number | undefined> {
		const total = jsonl.spans.length / 2;
		if (jsonl.index.lastId === entryId && jsonl.index.seq === total) return total;
		const needle = Buffer.from(`"id":${JSON.stringify(entryId)}`);
		const file = await open(path, "r");
		try {
			let last = total;
			let window = READ_GAP_BYTES;
			while (last >= 1) {
				let first = last;
				while (first > 1 && spanEnd(jsonl, last) - spanStart(jsonl, first - 1) <= window) first -= 1;
				window = Math.min(SCAN_WINDOW_BYTES, window * 2);
				const from = spanStart(jsonl, first);
				const bytes = await readFrom(file, from, spanEnd(jsonl, last) - from);
				for (let seq = last; seq >= first; seq--) {
					const line = bytes.subarray(spanStart(jsonl, seq) - from, spanEnd(jsonl, seq) - from);
					if (line.indexOf(needle) === -1) continue;
					if ((JSON.parse(line.toString("utf8")) as SessionEntry).id === entryId) return seq;
				}
				last = first - 1;
			}
		} finally {
			await file.close();
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
			await unlink(located.path);
			this.fileStates.delete(located.path);
			await this.forgetIndex(located.path);
		});
	}

	async *list(query: SessionListQuery): AsyncIterable<SessionSummary> {
		this.checkAbort(query.signal);
		const matchesCwd = query.cwd === undefined ? undefined : createSessionCwdMatcher(query.cwd);
		const paths = await this.run(() => this.paths(), true, query.signal);
		for (const path of paths) {
			const summary = await this.run(
				async () => {
					this.checkAbort(query.signal);
					try {
						const header = await this.readHeaderAt(path);
						if (!matchesSessionIdPrefix(header.id, query.idPrefix)) return undefined;
						if (matchesCwd && !matchesCwd(header.cwd)) return undefined;
						if (!query.includeInternal && header.internal) return undefined;
						return { ...summarizeSession(await this.readSnapshot(path)), location: path };
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
				true,
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
			const chunks: Buffer[] = [];
			for (let length = firstReadBytes; ; length = HEADER_READ_CHUNK_BYTES) {
				const buffer = Buffer.allocUnsafe(length);
				const { bytesRead } = await file.read(buffer, 0, length, null);
				if (!bytesRead) break;
				const newline = buffer.subarray(0, bytesRead).indexOf(10);
				chunks.push(buffer.subarray(0, newline === -1 ? bytesRead : newline));
				if (newline !== -1) break;
			}
			const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue;
			return value !== null && typeof value === "object" && !Array.isArray(value)
				? (value as StoredSessionHeader)
				: {};
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
		};
	}

	/** Records the file as it is now; `size` ends it before a torn last line. */
	private async remember(
		path: string,
		state: Omit<SessionFileState, "stamp" | "identity" | "size">,
		size?: number,
	): Promise<void> {
		const stats = await stat(path, { bigint: true });
		this.fileStates.set(path, {
			...state,
			stamp: this.stamp(stats),
			identity: `${stats.dev}:${stats.ino}`,
			size: size ?? Number(stats.size),
		});
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
				};
				this.fileStates.set(path, state);
			}
		}
		if (state.lastSeq !== options.expectSeq)
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

function fileEpoch(identity: string, headerStamp: string): string {
	return `${identity}:${createHash("sha256").update(headerStamp).digest("hex").slice(0, 16)}`;
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
		typeof stored.spans !== "string"
	)
		return undefined;
	const spans = decodeDeltas(stored.spans);
	if (spans.length % 2 !== 0 || !isSessionResumeIndex(stored.index, spans.length / 2)) return undefined;
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
		index: stored.index,
		sidecarSize: stored.size,
	};
}
