import { randomUUID } from "node:crypto";
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
	private poisoned: JsonlStoragePoisonedError | undefined;
	private readonly directory: string;

	private constructor(directory: string) {
		this.directory = resolve(directory);
	}

	static async open(directory: string): Promise<JsonlSessionStore> {
		const store = new JsonlSessionStore(directory);
		await store.run(() => mkdir(store.directory, { recursive: true }).then(() => {}));
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
			const project = join(
				this.directory,
				`--${resolve(header.cwd)
					.replace(/^[/\\]/, "")
					.replace(/[/\\:]/g, "-")}--`,
			);
			await mkdir(project, { recursive: true });
			const path = join(project, `${header.createdAt.replace(/[:.]/g, "-")}_${encodeURIComponent(header.id)}.jsonl`);
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
			return { lastSeq: entries.length };
		});
	}

	append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		return this.run(async () => {
			const { path, snapshot } = await this.forWrite(sessionId, options);
			validateSessionEntries(entries);
			if (entries.length === 0) return { lastSeq: snapshot.lastSeq };
			let payload = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
			const content = await readFile(path, "utf8");
			if (!content.endsWith("\n")) payload = `\n${payload}`;
			const offset = (await stat(path)).size;
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
			return { lastSeq: snapshot.lastSeq + entries.length };
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

	private run<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new StoreClosedError(this.descriptor));
		const result = this.queue.then(async () => {
			if (this.poisoned) throw this.poisoned;
			try {
				return await operation();
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
			const name = basename(path);
			const separator = name.indexOf("_");
			const key =
				separator === -1 ? (await this.readFirstLine(path)).id : decodeURIComponent(name.slice(separator + 1, -6));
			if (key === sessionId) return path;
		}
		return undefined;
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

	private async forWrite(
		sessionId: string,
		options: SessionWriteOptions,
	): Promise<{ path: string; snapshot: SessionSnapshot }> {
		const path = await this.locate(sessionId);
		if (!path) throw new SessionNotFoundError(sessionId);
		const snapshot = await this.readSnapshot(path);
		if (snapshot.lastSeq !== options.expectSeq)
			throw new SessionConflictError(sessionId, options.expectSeq, snapshot.lastSeq);
		return { path, snapshot };
	}

	private encode(header: SessionRecordHeader, entries: readonly SessionEntry[]): string {
		return `${[JSON.stringify({ type: "session", ...header }), ...entries.map((entry) => JSON.stringify(entry))].join("\n")}\n`;
	}
}
