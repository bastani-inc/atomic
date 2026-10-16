import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
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
import { basename, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
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
import { summarizeSession } from "./session-summary.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionListQuery,
	type SessionRecordHeader,
	type SessionSnapshot,
	type SessionStore,
	type SessionSummary,
	type SessionWriteOptions,
	type StorageDescriptor,
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

	private constructor(directory: string) {
		this.directory = resolve(directory);
	}

	static async open(directory: string): Promise<JsonlSessionStore> {
		const store = new JsonlSessionStore(directory);
		await store.run(() => mkdir(store.directory, { recursive: true }).then(() => {}), false);
		await store.run(async () => {
			for (const path of await store.paths()) {
				try {
					await store.readSnapshot(path);
				} catch {
					store.fileStates.delete(path);
				}
			}
		});
		return store;
	}

	get descriptor(): StorageDescriptor {
		return { adapter: "jsonl", location: this.directory };
	}

	create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<{ readonly lastSeq: number }> {
		return this.run(async () => {
			validateSessionHeader(header);
			validateSessionEntries(entries);
			const existing = await this.locate(header.id);
			if (existing) throw new SessionExistsError(header.id);
			const payload = this.encode(header, entries);
			const projectName = `--${resolve(header.cwd)
				.replace(/^[/\\]/, "")
				.replace(/[/\\:]/g, "-")}--`;
			const project = join(
				this.directory,
				Buffer.byteLength(projectName) <= 180 ? projectName : `--${this.key(header.cwd)}--`,
			);
			await mkdir(project, { recursive: true });
			const path = join(project, `${header.createdAt.replace(/[:.]/g, "-")}_${this.key(header.id)}.jsonl`);
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
			return { lastSeq: entries.length };
		});
	}

	load(sessionId: string): Promise<SessionSnapshot> {
		return this.run(async () => {
			const located = await this.locate(sessionId);
			if (!located) throw new SessionNotFoundError(sessionId);
			return this.readSnapshot(located.path, located.header);
		});
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
		const paths = await this.run(() => this.paths(), true, query.signal);
		for (const path of paths) {
			const summary = await this.run(
				async () => {
					this.checkAbort(query.signal);
					try {
						const header = await this.readHeaderAt(path);
						if (query.cwd !== undefined && query.cwd !== header.cwd) return undefined;
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

	private async exclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		let release: () => Promise<void>;
		for (;;) {
			this.checkAbort(signal);
			try {
				release = await lockfile.lock(this.directory, {
					lockfilePath: join(this.directory, ".session.lock"),
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

	private async paths(): Promise<string[]> {
		const paths: string[] = [];
		for (const entry of await readdir(this.directory, { withFileTypes: true })) {
			const path = join(this.directory, entry.name);
			if (entry.isDirectory()) {
				for (const child of await readdir(path, { withFileTypes: true })) {
					if (child.isFile() && child.name.endsWith(".jsonl")) paths.push(join(path, child.name));
				}
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
		}
		return paths;
	}

	private async locate(
		sessionId: string,
	): Promise<
		{ path: string; header: SessionRecordHeader; stats: BigIntStats; state: SessionFileState | undefined } | undefined
	> {
		validateSessionText("sessionId", sessionId);
		for (const path of await this.paths()) {
			const cached = this.fileStates.get(path);
			let stored: { id?: string; version?: JsonValue };
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
			return { path, header, stats, state };
		}
		return undefined;
	}

	private key(sessionId: string): string {
		return createHash("sha256").update(sessionId).digest("hex");
	}

	private async readFirstLine(path: string): Promise<{ id?: string; version?: JsonValue }> {
		const file = await open(path, "r");
		try {
			const decoder = new StringDecoder("utf8");
			const buffer = Buffer.alloc(1);
			let line = "";
			while (true) {
				const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
				if (!bytesRead) {
					line += decoder.end();
					break;
				}
				if (buffer[0] === 10) {
					line += decoder.end();
					break;
				}
				line += decoder.write(buffer);
			}
			const value = JSON.parse(line) as JsonValue;
			return value !== null && typeof value === "object" && !Array.isArray(value)
				? (value as { id?: string; version?: JsonValue })
				: {};
		} finally {
			await file.close();
		}
	}

	private async readHeaderAt(
		path: string,
		stored?: { id?: string; version?: JsonValue },
	): Promise<SessionRecordHeader> {
		stored ??= await this.readFirstLine(path);
		if (stored.version !== SESSION_FORMAT_VERSION) throw new SessionFormatVersionError(path, stored.version);
		const { type: _type, ...header } = stored as SessionRecordHeader & { type: "session" };
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

	private async readSnapshot(path: string, header?: SessionRecordHeader): Promise<SessionSnapshot> {
		header ??= await this.readHeaderAt(path);
		const content = await readFile(path, "utf8");
		const lines = content.split("\n");
		if (lines.at(-1) === "") lines.pop();
		const entries = lines.slice(1).map((line) => JSON.parse(line) as SessionEntry);
		validateSessionEntryStructure(entries, path);
		validateSessionEntries(entries);
		await this.remember(path, this.contentState(header, entries, content));
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
		const { path, header, stats } = located;
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
