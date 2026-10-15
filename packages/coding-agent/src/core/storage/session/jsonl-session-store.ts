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
import {
	SessionConflictError,
	SessionExistsError,
	SessionInvalidTextError,
	SessionInvalidTimestampError,
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
	readonly size: number;
	readonly lastSeq: number;
	readonly terminated: boolean;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class SessionFormatVersionError extends Error {
	readonly path: string;
	readonly found: JsonValue | undefined;
	readonly supported = SESSION_FORMAT_VERSION;

	constructor(path: string, found: JsonValue | undefined) {
		super(`Unsupported session format at ${path}`);
		this.name = "SessionFormatVersionError";
		this.path = path;
		this.found = found;
	}
}

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
			if (existing) {
				await this.readHeaderAt(existing);
				throw new SessionExistsError(header.id);
			}
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
			await this.remember(path, entries.length, true);
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
			await this.remember(path, lastSeq, true);
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
			await this.remember(path, entries.length, true);
			return { lastSeq: entries.length };
		});
	}

	load(sessionId: string): Promise<SessionSnapshot> {
		return this.run(async () => {
			const path = await this.locate(sessionId);
			if (!path) throw new SessionNotFoundError(sessionId);
			return this.readSnapshot(path);
		});
	}

	readHeader(sessionId: string): Promise<SessionRecordHeader | undefined> {
		return this.run(async () => {
			const path = await this.locate(sessionId);
			return path ? this.readHeaderAt(path) : undefined;
		});
	}

	delete(sessionId: string): Promise<void> {
		return this.run(async () => {
			const path = await this.locate(sessionId);
			if (path) {
				await this.readHeaderAt(path);
				await unlink(path);
				this.fileStates.delete(path);
			}
		});
	}

	async *list(query: SessionListQuery): AsyncIterable<SessionSummary> {
		const paths = await this.run(() => this.paths());
		for (const path of paths) {
			const summary = await this.run(async () => {
				this.checkAbort(query);
				let header: SessionRecordHeader;
				try {
					header = await this.readHeaderAt(path);
				} catch (cause) {
					if (cause instanceof SessionFormatVersionError) return undefined;
					throw cause;
				}
				if (query.cwd !== undefined && query.cwd !== header.cwd) return undefined;
				if (!query.includeInternal && header.internal) return undefined;
				return { ...summarizeSession(await this.readSnapshot(path)), location: path };
			});
			this.checkAbort(query);
			if (summary) yield summary;
		}
		await this.run(async () => this.checkAbort(query));
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

	private run<T>(operation: () => Promise<T>, locked = true): Promise<T> {
		if (this.closed) return Promise.reject(new StoreClosedError(this.descriptor));
		const result = this.queue.then(async () => {
			if (this.poisoned) throw this.poisoned;
			try {
				return await (locked ? this.exclusive(operation) : operation());
			} catch (cause) {
				if (
					cause instanceof SessionConflictError ||
					cause instanceof SessionExistsError ||
					cause instanceof SessionNotFoundError ||
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

	private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
		let release: () => Promise<void>;
		for (;;) {
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
			if (this.poisoned) throw this.poisoned;
			const result = await operation();
			if (this.poisoned) throw this.poisoned;
			return result;
		} finally {
			await release();
		}
	}

	private checkAbort(query: SessionListQuery): void {
		if (query.signal?.aborted) throw new DOMException("Session listing aborted", "AbortError");
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

	private async locate(sessionId: string): Promise<string | undefined> {
		validateSessionText("sessionId", sessionId);
		for (const path of await this.paths()) {
			const key = basename(path).match(/_([0-9a-f]{64})\.jsonl$/)?.[1];
			if (key ? key === this.key(sessionId) : (await this.readFirstLine(path)).id === sessionId) return path;
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
			const buffer = Buffer.alloc(64 * 1024);
			let line = "";
			while (true) {
				const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
				if (!bytesRead) {
					line += decoder.end();
					break;
				}
				line += decoder.write(buffer.subarray(0, bytesRead));
				const end = line.indexOf("\n");
				if (end !== -1) {
					line = line.slice(0, end);
					break;
				}
			}
			const value = JSON.parse(line) as JsonValue;
			return value !== null && typeof value === "object" && !Array.isArray(value)
				? (value as { id?: string; version?: JsonValue })
				: {};
		} finally {
			await file.close();
		}
	}

	private async readHeaderAt(path: string): Promise<SessionRecordHeader> {
		const stored = await this.readFirstLine(path);
		if (stored.version !== SESSION_FORMAT_VERSION) throw new SessionFormatVersionError(path, stored.version);
		const { type: _type, ...header } = stored as SessionRecordHeader & { type: "session" };
		return header;
	}

	private async readSnapshot(path: string): Promise<SessionSnapshot> {
		const header = await this.readHeaderAt(path);
		const lines = (await readFile(path, "utf8")).split("\n");
		if (lines.at(-1) === "") lines.pop();
		const entries = lines.slice(1).map((line) => JSON.parse(line) as SessionEntry);
		return { header, entries, lastSeq: entries.length };
	}

	private stamp(stats: BigIntStats): string {
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	}

	private async remember(path: string, lastSeq: number, terminated: boolean): Promise<void> {
		const stats = await stat(path, { bigint: true });
		this.fileStates.set(path, { stamp: this.stamp(stats), size: Number(stats.size), lastSeq, terminated });
	}

	private async forWrite(
		sessionId: string,
		options: SessionWriteOptions,
	): Promise<{ path: string; state: SessionFileState }> {
		const path = await this.locate(sessionId);
		if (!path) throw new SessionNotFoundError(sessionId);
		await this.readHeaderAt(path);
		const stats = await stat(path, { bigint: true });
		let state = this.fileStates.get(path);
		if (!state || state.stamp !== this.stamp(stats)) {
			const snapshot = await this.readSnapshot(path);
			const file = await open(path, "r");
			const lastByte = Buffer.alloc(1);
			try {
				await file.read(lastByte, 0, 1, Number(stats.size) - 1);
			} finally {
				await file.close();
			}
			state = {
				stamp: this.stamp(stats),
				size: Number(stats.size),
				lastSeq: snapshot.lastSeq,
				terminated: lastByte[0] === 10,
			};
			this.fileStates.set(path, state);
		}
		if (state.lastSeq !== options.expectSeq)
			throw new SessionConflictError(sessionId, options.expectSeq, state.lastSeq);
		return { path, state };
	}

	private encode(header: SessionRecordHeader, entries: readonly SessionEntry[]): string {
		return `${[JSON.stringify({ type: "session", ...header }), ...entries.map((entry) => JSON.stringify(entry))].join("\n")}\n`;
	}
}
