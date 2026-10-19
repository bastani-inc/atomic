import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, createReadStream } from "node:fs";
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
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { createSessionCwdMatcher } from "../../../utils/canonical-path.ts";
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
}

type JsonValue = SessionJsonValue;

const SCAN_FIRST_LINE_CHUNK_BYTES = 4096;

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

export class JsonlSessionStore implements SessionStore {
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private poisoned: JsonlStoragePoisonedError | StorageUnavailableError | undefined;
	private readonly directory: string;
	private readonly fileStates = new Map<string, SessionFileState>();

	private readonly exactDirectory: boolean;

	private constructor(directory: string, exactDirectory: boolean) {
		this.exactDirectory = exactDirectory;
		this.directory = resolve(directory);
	}

	static async open(
		directory: string,
		options?: { exactDirectory?: boolean; scanExisting?: boolean },
	): Promise<JsonlSessionStore> {
		const store = new JsonlSessionStore(directory, options?.exactDirectory === true);
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
			const existing = await this.locate(header.id);
			if (existing) throw new SessionExistsError(header.id);
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
				witness: Buffer.from(Buffer.concat([state.witness, Buffer.from(payload)]).subarray(-64)),
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
						const header = await this.readHeaderAt(path);
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
				header = await this.run(
					async () => this.readHeaderAt(location, await this.readFirstLine(location, SCAN_FIRST_LINE_CHUNK_BYTES)),
					false,
				);
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
		let release: () => Promise<void>;
		for (;;) {
			this.checkAbort(signal);
			try {
				release = await lockfile.lock(directory, {
					lockfilePath: join(directory, ".session.lock"),
					onCompromised: (cause) => {
						this.poisoned = new StorageUnavailableError(this.descriptor, cause);
					},
				});
				break;
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "ELOCKED") throw cause;
				await delay(5);
			}
		}
		try {
			this.checkAbort(signal);
			if (this.poisoned) throw this.poisoned;
			const result = await operation();
			if (this.poisoned) throw this.poisoned;
			return result;
		} finally {
			await release();
		}
	}

	private checkAbort(signal?: AbortSignal): void {
		if (signal?.aborted) throw new DOMException("Session listing aborted", "AbortError");
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
		for (const path of await this.paths()) {
			const cached = this.fileStates.get(path);
			let stored: StoredSessionHeader;
			try {
				stored = await this.readFirstLine(path, SCAN_FIRST_LINE_CHUNK_BYTES);
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
				stored = await this.readFirstLine(path);
			} catch {
				return undefined;
			}
			if (stored.id !== sessionId) return undefined;
			const header = await this.readHeaderAt(path, stored);
			const stats = await stat(path, { bigint: true });
			return { path, header, stored, stats, state: this.fileStates.get(path) };
		}
		return undefined;
	}

	private key(sessionId: string): string {
		return createHash("sha256").update(sessionId).digest("hex");
	}

	private async readFirstLine(path: string, chunkBytes = 1): Promise<StoredSessionHeader> {
		const file = await open(path, "r");
		try {
			const chunks: Buffer[] = [];
			const buffer = Buffer.alloc(chunkBytes);
			while (true) {
				const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
				if (!bytesRead) break;
				const newline = buffer.subarray(0, bytesRead).indexOf(10);
				chunks.push(Buffer.from(buffer.subarray(0, newline === -1 ? bytesRead : newline)));
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
		const input = createReadStream(path);
		let witness: Buffer = Buffer.alloc(0);
		let terminated = false;
		input.on("data", (chunk: string | Buffer) => {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			witness = Buffer.from(Buffer.concat([witness, bytes]).subarray(-64));
			terminated = bytes.at(-1) === 10;
		});
		const lines = createInterface({ input, crlfDelay: Infinity });
		const entries: SessionEntry[] = [];
		let first = true;
		try {
			for await (const line of lines) {
				if (first) {
					first = false;
					continue;
				}
				if (line.trim()) entries.push(JSON.parse(line) as SessionEntry);
			}
		} finally {
			lines.close();
			input.destroy();
		}
		if (!isCurrentSessionHeader(stored)) {
			const upgraded = upgradeLegacySessionEntries(stored, entries, path).entries;
			validateSessionEntryStructure(upgraded, path);
			validateSessionEntries(upgraded);
			if (persistUpgrade) await this.commit(path, header, upgraded);
			return { header, entries: upgraded, lastSeq: upgraded.length };
		}
		validateSessionEntryStructure(entries, path);
		validateSessionEntries(entries);
		await this.remember(path, {
			headerStamp: JSON.stringify(header),
			headerId: header.id,
			lastSeq: entries.length,
			lastEntryId: entries.at(-1)?.id,
			witness,
			terminated,
		});
		return { header, entries, lastSeq: entries.length };
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
			witness: Buffer.from(Buffer.from(content).subarray(-64)),
		};
	}

	private async remember(path: string, state: Omit<SessionFileState, "stamp" | "identity" | "size">): Promise<void> {
		const stats = await stat(path, { bigint: true });
		this.fileStates.set(path, {
			...state,
			stamp: this.stamp(stats),
			identity: `${stats.dev}:${stats.ino}`,
			size: Number(stats.size),
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
			const lastSeq = state.lastSeq;
			const stale = () => new SessionConflictError(sessionId, options.expectSeq, lastSeq);
			if (
				state.identity !== `${stats.dev}:${stats.ino}` ||
				state.headerStamp !== JSON.stringify(header) ||
				Number(stats.size) < state.size
			)
				throw stale();
			if (state.stamp !== this.stamp(stats)) {
				const file = await open(path, "r");
				const offset = state.size - state.witness.length;
				const bytes = Buffer.alloc(Number(stats.size) - offset);
				try {
					let read = 0;
					while (read < bytes.length) {
						const { bytesRead } = await file.read(bytes, read, bytes.length - read, offset + read);
						if (!bytesRead) throw stale();
						read += bytesRead;
					}
				} finally {
					await file.close();
				}
				if (!bytes.subarray(0, state.witness.length).equals(state.witness)) throw stale();
				let appended = bytes.subarray(state.witness.length).toString("utf8");
				if (appended && !state.terminated) {
					if (!appended.startsWith("\n")) throw stale();
					appended = appended.slice(1);
				}
				const lines = appended.split("\n");
				if (lines.at(-1) === "") lines.pop();
				const entries = lines.map((line) => JSON.parse(line) as SessionEntry);
				validateSessionEntryStructure(entries, path);
				validateSessionEntries(entries);
				state = {
					...state,
					stamp: this.stamp(stats),
					size: Number(stats.size),
					lastSeq: state.lastSeq + entries.length,
					lastEntryId: entries.at(-1)?.id ?? state.lastEntryId,
					terminated: bytes.at(-1) === 10,
					witness: Buffer.from(bytes.subarray(-64)),
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
