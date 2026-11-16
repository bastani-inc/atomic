import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, createReadStream, rmdir as rmdirCallback, stat as statCallback } from "node:fs";
import {
	appendFile,
	copyFile,
	link,
	mkdir,
	open,
	readdir,
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
import { summarizeLegacySession } from "./legacy-session-summary.js";
import {
	applySessionSummaryEntries,
	materializeSessionSummaryMetadata,
	type SessionSummaryState,
	summarizeSession,
} from "./session-summary.js";
import type {
	SessionEntriesPage,
	SessionEntriesQuery,
	SessionEntryAt,
	SessionListQuery,
	SessionRecordHeader,
	SessionSnapshot,
	SessionStore,
	SessionSummary,
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
	readonly summaryState?: SessionSummaryState;
}

type JsonValue = SessionJsonValue;

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
const STUB_ENTRY: SessionEntry = {
	type: "custom",
	id: "",
	parentId: null,
	timestamp: "1970-01-01T00:00:00.000Z",
	customType: "",
};

interface RangeIndex {
	readonly identity: string;
	readonly marks: { readonly seq: number; readonly offset: number }[];
	completeEnd: number;
	completeCount: number;
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

interface RangeCursor {
	readonly offset: number;
	readonly seq: number;
	readonly header: boolean;
}

async function scanSessionLines(
	path: string,
	size: number,
	from: RangeCursor,
	index: RangeIndex,
	signal: AbortSignal | undefined,
	onEntry: (seq: number, parts: readonly Buffer[], byteLength: number, terminated: boolean) => boolean,
): Promise<RangeCursor> {
	if (from.offset >= size) return from;
	let { seq, header } = from;
	let offset = from.offset;
	let lineOffset = from.offset;
	let pieces: Buffer[] = [];
	let piecesBytes = 0;
	const input = createReadStream(path, { start: from.offset, end: size - 1 });
	try {
		for await (const chunk of input) {
			signal?.throwIfAborted();
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
			let lineStart = 0;
			for (let newline = bytes.indexOf(10); newline !== -1; newline = bytes.indexOf(10, lineStart)) {
				const slice = bytes.subarray(lineStart, newline);
				const parts = pieces.length === 0 ? [slice] : [...pieces, slice];
				const byteLength = piecesBytes + slice.length;
				const at = pieces.length === 0 ? offset + lineStart : lineOffset;
				lineStart = newline + 1;
				pieces = [];
				piecesBytes = 0;
				lineOffset = offset + lineStart;
				if (header) {
					header = false;
					continue;
				}
				if (isBlankParts(parts)) continue;
				seq++;
				if (seq % RANGE_MARK_EVERY === 1 && !index.marks.some((candidate) => candidate.seq === seq)) {
					index.marks.push({ seq, offset: at });
					index.marks.sort((a, b) => a.seq - b.seq);
				}
				if (seq > index.completeCount) {
					index.completeCount = seq;
					index.completeEnd = offset + lineStart;
				}
				if (onEntry(seq, parts, byteLength, true)) return { offset: offset + lineStart, seq, header: false };
			}
			if (lineStart < bytes.length) {
				if (pieces.length === 0) lineOffset = offset + lineStart;
				const tail = bytes.subarray(lineStart);
				pieces.push(tail);
				piecesBytes += tail.length;
			}
			offset += bytes.length;
		}
	} finally {
		input.destroy();
	}
	if (piecesBytes > 0 && !header && !isBlankParts(pieces)) {
		if (onEntry(seq + 1, pieces, piecesBytes, false)) seq++;
	}
	return { offset: size, seq, header: false };
}

function entriesPage(entries: readonly SessionEntry[], query: SessionEntriesQuery): SessionEntriesPage {
	const from = Math.max(1, query.fromSeq);
	const through = Math.min(query.toSeq, entries.length);
	return {
		lastSeq: entries.length,
		entries: entries
			.slice(from - 1, Math.max(from - 1, through))
			.map((entry, index) => ({ seq: from + index, entry })),
		throughSeq: Math.max(through, from - 1),
	};
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
	private readonly rangeIndexes = new Map<string, RangeIndex>();

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
			let payload = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
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
				...(state.summaryState === undefined
					? {}
					: { summaryState: applySessionSummaryEntries(state.summaryState, entries).state }),
			});
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

	readEntryRange(sessionId: string, query: SessionEntriesQuery): Promise<SessionEntriesPage> {
		return this.run(
			async () => {
				query.signal?.throwIfAborted();
				const located = await this.locate(sessionId);
				if (!located) throw new SessionNotFoundError(sessionId);
				if (!isCurrentSessionHeader(located.stored))
					return entriesPage((await this.readPersisted(located.path, located.stored)).entries, query);
				return this.readRangeOf(located.path, query);
			},
			false,
			query.signal,
		);
	}

	private async readRangeOf(path: string, query: SessionEntriesQuery): Promise<SessionEntriesPage> {
		const stats = await stat(path, { bigint: true });
		const identity = `${stats.dev}:${stats.ino}`;
		const size = Number(stats.size);
		let index = this.rangeIndexes.get(path);
		if (index === undefined || index.identity !== identity || index.completeEnd > size) {
			index = { identity, marks: [], completeEnd: 0, completeCount: 0 };
			this.rangeIndexes.set(path, index);
		}
		const fromSeq = Math.max(1, query.fromSeq);
		const entries: SessionEntryAt[] = [];
		let chars = 0;
		let stopped: number | undefined;
		let cursor: RangeCursor = { offset: 0, seq: 0, header: true };
		if (fromSeq > index.completeCount && index.completeEnd > 0)
			cursor = { offset: index.completeEnd, seq: index.completeCount, header: false };
		else {
			const mark = index.marks.findLast((candidate) => candidate.seq <= fromSeq);
			if (mark) cursor = { offset: mark.offset, seq: mark.seq - 1, header: false };
		}
		const skipped = (query.skipTypes ?? []).map((type) => `{"type":${JSON.stringify(type)},`);
		const isSkipped = (head: string): boolean => skipped.some((prefix) => head.startsWith(prefix));
		const acceptUnterminated = (parts: readonly Buffer[]): SessionEntry | undefined => {
			const text = (parts.length === 1 ? parts[0]! : Buffer.concat(parts)).toString("utf8");
			return parseUnterminated(text);
		};
		if (fromSeq <= query.toSeq)
			cursor = await scanSessionLines(
				path,
				size,
				cursor,
				index,
				query.signal,
				(seq, parts, byteLength, terminated) => {
					if (!terminated && acceptUnterminated(parts) === undefined) return false;
					if (seq < fromSeq) return !terminated;
					if (seq > query.toSeq) return true;
					const head = parts[0]!.subarray(0, Math.min(parts[0]!.length, 64)).toString("utf8");
					if (!isSkipped(head)) {
						if (query.largeEntryBytes !== undefined && byteLength > query.largeEntryBytes) {
							entries.push({ seq, entry: STUB_ENTRY, rawChunks: parts });
						} else {
							const text = (parts.length === 1 ? parts[0]! : Buffer.concat(parts)).toString("utf8");
							const parsed = JSON.parse(text) as SessionEntry;
							if (!(query.skipTypes ?? []).includes(parsed.type)) entries.push({ seq, entry: parsed });
						}
						chars += byteLength;
						if (query.maxChars !== undefined && chars >= query.maxChars && seq < query.toSeq) {
							stopped = seq;
							return true;
						}
					}
					return !terminated || seq >= query.toSeq;
				},
			);
		const counted =
			cursor.offset >= index.completeEnd
				? cursor
				: { offset: index.completeEnd, seq: index.completeCount, header: index.completeEnd === 0 };
		const scanned = await scanSessionLines(
			path,
			size,
			counted,
			index,
			query.signal,
			(_seq, parts, _len, terminated) => (!terminated ? acceptUnterminated(parts) !== undefined : false),
		);
		const lastSeq = scanned.seq;
		const throughSeq = stopped ?? Math.min(query.toSeq, lastSeq);
		return { lastSeq, entries, throughSeq: Math.max(throughSeq, fromSeq - 1) };
	}

	loadFile(path: string): Promise<SessionSnapshot> {
		return this.run(() => this.readPersisted(resolve(path)));
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
						const stored = await this.readFirstLine(path);
						const header = await this.readHeaderAt(path, stored);
						if (!matchesSessionIdPrefix(header.id, query.idPrefix)) return undefined;
						if (matchesCwd && !matchesCwd(header.cwd)) return undefined;
						if (!query.includeInternal && header.internal) return undefined;
						if (query.withoutSearchText && isCurrentSessionHeader(stored)) {
							const stats = await stat(path, { bigint: true });
							const cached = this.fileStates.get(path);
							if (cached?.summaryState !== undefined && cached.stamp === this.stamp(stats)) {
								return {
									...materializeSessionSummaryMetadata(header, cached.summaryState),
									searchText: "",
									location: path,
								};
							}
							const summarized = await summarizeLegacySession(
								{ location: path, header, read: () => this.readSnapshot(path, stored) },
								Number(stats.size),
								Number(stats.mtimeMs),
							);
							return { ...summarized, searchText: "", location: path };
						}
						return { ...summarizeSession(await this.readSnapshot(path, stored)), location: path };
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
