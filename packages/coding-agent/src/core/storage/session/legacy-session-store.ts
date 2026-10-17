import { existsSync } from "node:fs";
import { createSessionCwdMatcher } from "../../../utils/canonical-path.ts";
import type { SessionEntry } from "../../session-manager-types.ts";
import type { SqliteDatabase } from "../database.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { SessionExistsError, SessionNotFoundError } from "./errors.js";
import { type JsonlSessionFile, JsonlSessionStore } from "./jsonl-session-store.js";
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

const DELETED_TABLE = "session_legacy_deleted";

/**
 * The default session store, plus the JSONL sessions saved before it existed.
 *
 * Sessions from before the SQLite default stay in `<agentDir>/sessions` and are
 * listed from there, so `/resume` and `--continue` show them without any upfront
 * work. A legacy session is converted into the database only when it is opened,
 * following pi's migrate-on-load pattern; afterwards it is read from the database
 * like any other session. The JSONL files are never modified. Deleting a session
 * records its ID so a legacy copy of it is not listed again.
 */
export class LegacySessionStore implements SessionStore {
	private readonly inner: SessionStore;
	private readonly legacyDirectory: string;
	private readonly databasePath: string;
	private legacy?: Promise<JsonlSessionStore | undefined>;
	private index?: Promise<ReadonlyMap<string, JsonlSessionFile>>;
	private deletions?: Promise<SqliteDatabase>;

	constructor(inner: SessionStore, options: { readonly legacyDirectory: string; readonly databasePath: string }) {
		this.inner = inner;
		this.legacyDirectory = options.legacyDirectory;
		this.databasePath = options.databasePath;
	}

	get descriptor(): StorageDescriptor {
		return this.inner.descriptor;
	}

	create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<{ readonly lastSeq: number }> {
		return this.inner.create(header, entries);
	}

	async append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		await this.convert(sessionId);
		return this.inner.append(sessionId, entries, options);
	}

	async replace(
		sessionId: string,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		await this.convert(sessionId);
		return this.inner.replace(sessionId, header, entries, options);
	}

	async load(sessionId: string): Promise<SessionSnapshot> {
		await this.convert(sessionId);
		return this.inner.load(sessionId);
	}

	async readHeader(sessionId: string): Promise<SessionRecordHeader | undefined> {
		const header = await this.inner.readHeader(sessionId);
		if (header !== undefined) return header;
		return (await this.findLegacy(sessionId))?.header;
	}

	async delete(sessionId: string): Promise<void> {
		const legacy = await this.findLegacy(sessionId);
		if (legacy !== undefined) await this.markDeleted(sessionId);
		try {
			await this.inner.delete(sessionId);
		} catch (error) {
			if (!(error instanceof SessionNotFoundError) || legacy === undefined) throw error;
		}
	}

	async *list(query: SessionListQuery): AsyncIterable<SessionSummary> {
		const listed = new Set<string>();
		for await (const summary of this.inner.list(query)) {
			listed.add(summary.id);
			yield summary;
		}
		for await (const file of this.legacyFiles(query)) {
			if (listed.has(file.header.id) || (await this.inner.readHeader(file.header.id)) !== undefined) continue;
			const summary = await this.summarize(file);
			if (summary === undefined) continue;
			listed.add(summary.id);
			yield summary;
		}
	}

	async findMostRecent(query: {
		readonly cwd: string;
		readonly includeInternal?: boolean;
	}): Promise<SessionSummary | undefined> {
		let latest = await this.inner.findMostRecent(query);
		for await (const file of this.legacyFiles(query)) {
			if ((await this.inner.readHeader(file.header.id)) !== undefined) continue;
			const summary = await this.summarize(file);
			if (summary !== undefined && (!latest || Date.parse(summary.modifiedAt) > Date.parse(latest.modifiedAt))) {
				latest = summary;
			}
		}
		return latest;
	}

	async close(): Promise<void> {
		const legacy = this.legacy;
		const deletions = this.deletions;
		this.legacy = undefined;
		this.deletions = undefined;
		this.index = undefined;
		await Promise.all([
			legacy?.then((store) => store?.close()).catch(() => {}),
			deletions?.then((database) => database.close()).catch(() => {}),
		]);
		await this.inner.close();
	}

	/** Convert one legacy session into the database the first time it is needed. */
	private async convert(sessionId: string): Promise<void> {
		if ((await this.inner.readHeader(sessionId)) !== undefined) return;
		const file = await this.findLegacy(sessionId);
		if (file === undefined) return;
		const snapshot = await file.read();
		try {
			await this.inner.create(snapshot.header, snapshot.entries);
		} catch (error) {
			if (!(error instanceof SessionExistsError)) throw error;
		}
	}

	private async findLegacy(sessionId: string): Promise<JsonlSessionFile | undefined> {
		const file = (await this.legacyIndex()).get(sessionId);
		if (file === undefined || (await this.isDeleted(sessionId))) return undefined;
		return file;
	}

	private async *legacyFiles(query: {
		readonly cwd?: string;
		readonly includeInternal?: boolean;
	}): AsyncIterable<JsonlSessionFile> {
		const matchesCwd = query.cwd === undefined ? undefined : createSessionCwdMatcher(query.cwd);
		for (const file of (await this.legacyIndex()).values()) {
			if (matchesCwd && !matchesCwd(file.header.cwd)) continue;
			if (!query.includeInternal && file.header.internal) continue;
			if (await this.isDeleted(file.header.id)) continue;
			yield file;
		}
	}

	/** Header-only index of the legacy directory, read once; nothing writes legacy sessions any more. */
	private legacyIndex(): Promise<ReadonlyMap<string, JsonlSessionFile>> {
		this.index ??= (async () => {
			const files = new Map<string, JsonlSessionFile>();
			const legacy = await this.legacyStore();
			if (legacy === undefined) return files;
			try {
				for await (const file of legacy.scanFiles()) {
					if (!files.has(file.header.id)) files.set(file.header.id, file);
				}
			} catch {
				// An unreadable legacy directory leaves only the sessions already in the database.
			}
			return files;
		})();
		return this.index;
	}

	private async summarize(file: JsonlSessionFile): Promise<SessionSummary | undefined> {
		try {
			return summarizeSession(await file.read());
		} catch {
			return undefined;
		}
	}

	private legacyStore(): Promise<JsonlSessionStore | undefined> {
		this.legacy ??= existsSync(this.legacyDirectory)
			? JsonlSessionStore.open(this.legacyDirectory, { scanExisting: false }).catch(() => undefined)
			: Promise.resolve(undefined);
		return this.legacy;
	}

	private deletionDatabase(): Promise<SqliteDatabase> {
		this.deletions ??= openNodeSqliteDatabase(this.databasePath).then(async (database) => {
			await database.exec(
				`CREATE TABLE IF NOT EXISTS ${DELETED_TABLE}(id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)`,
			);
			return database;
		});
		return this.deletions;
	}

	private async isDeleted(sessionId: string): Promise<boolean> {
		const database = await this.deletionDatabase();
		return (await database.get(`SELECT id FROM ${DELETED_TABLE} WHERE id = ?`, sessionId)) !== undefined;
	}

	private async markDeleted(sessionId: string): Promise<void> {
		const database = await this.deletionDatabase();
		await database.run(`INSERT OR IGNORE INTO ${DELETED_TABLE} VALUES (?, ?)`, sessionId, Date.now());
	}
}
