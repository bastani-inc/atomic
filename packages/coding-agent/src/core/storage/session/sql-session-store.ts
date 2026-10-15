import type { SessionEntry } from "../../session-manager-types.ts";
import type { SqliteDatabase, SqliteExecutor, SqliteRow } from "../database.js";
import { renderStorageIdentifiers } from "../prefix.js";
import { assertStorageSchemaVersion } from "../schema.js";
import {
	SessionConflictError,
	SessionExistsError,
	SessionNotFoundError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";
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

export const SESSION_SCHEMA_VERSION = 1;
export const SESSION_TABLES = Object.freeze({ meta: "meta", sessions: "sessions", entries: "entries" });

type Tables = Readonly<Record<keyof typeof SESSION_TABLES, string>>;
type HeaderRow = SqliteRow & { header_json: string; last_seq: number };
type SummaryRow = HeaderRow & {
	modified_at: string;
	message_count: number;
	first_message: string;
	name: string | null;
	has_name: number;
	summary: string | null;
	summarized_through_id: string | null;
	search_text: string;
};

export class SqlSessionStore implements SessionStore {
	private readonly database: SqliteDatabase;
	private readonly tables: Tables;
	private closed = false;

	private constructor(database: SqliteDatabase, tables: Tables) {
		this.database = database;
		this.tables = tables;
	}

	static async open(database: SqliteDatabase, options: { readonly prefix?: string } = {}): Promise<SqlSessionStore> {
		const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, options.prefix);
		await database.transaction(async (tx) => {
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${tables.meta} (schema_version INTEGER NOT NULL) STRICT`);
			const versions = await tx.all(`SELECT schema_version FROM ${tables.meta}`);
			if (versions.length === 0) {
				await tx.run(`INSERT INTO ${tables.meta} VALUES (?)`, SESSION_SCHEMA_VERSION);
			}
			for (const version of versions) {
				assertStorageSchemaVersion("sessions", version.schema_version!, SESSION_SCHEMA_VERSION);
			}
			await tx.exec(`
				CREATE TABLE IF NOT EXISTS ${tables.sessions} (
					id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at TEXT NOT NULL,
					header_json TEXT NOT NULL CHECK(json_valid(header_json)), internal INTEGER NOT NULL,
					last_seq INTEGER NOT NULL, modified_at TEXT NOT NULL, message_count INTEGER NOT NULL,
					first_message TEXT NOT NULL CHECK(json_valid(first_message)),
					name TEXT CHECK(name IS NULL OR json_valid(name)), has_name INTEGER NOT NULL,
					summary TEXT CHECK(summary IS NULL OR json_valid(summary)), summarized_through_id TEXT,
					search_text TEXT NOT NULL CHECK(json_valid(search_text))
				) STRICT;
				CREATE TABLE IF NOT EXISTS ${tables.entries} (
					session_id TEXT NOT NULL, seq INTEGER NOT NULL, entry_id TEXT NOT NULL,
					entry_json TEXT NOT NULL CHECK(json_valid(entry_json)), PRIMARY KEY(session_id, seq)
				) STRICT;
			`);
		});
		return new SqlSessionStore(database, tables);
	}

	get descriptor(): StorageDescriptor {
		return { ...this.database.descriptor };
	}

	async create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<{ readonly lastSeq: number }> {
		this.assertOpen();
		validateSessionHeader(header);
		validateSessionEntries(entries);
		return this.database.transaction(async (tx) => {
			if (await tx.get(`SELECT id FROM ${this.tables.sessions} WHERE id = ?`, header.id)) {
				throw new SessionExistsError(header.id);
			}
			await this.saveSummary(tx, header.id, { header, entries, lastSeq: entries.length });
			await this.insertEntries(tx, header.id, entries, 0);
			return { lastSeq: entries.length };
		});
	}

	async append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		return this.database.transaction(async (tx) => {
			const previous = await this.forWrite(tx, sessionId, options);
			validateSessionEntries(entries);
			const lastSeq = previous.lastSeq + entries.length;
			await this.saveSummary(tx, sessionId, {
				header: previous.header,
				entries: [...previous.entries, ...entries],
				lastSeq,
			});
			await this.insertEntries(tx, sessionId, entries, previous.lastSeq);
			return { lastSeq };
		});
	}

	async replace(
		sessionId: string,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		return this.database.transaction(async (tx) => {
			await this.forWrite(tx, sessionId, options);
			validateSessionHeader(header);
			validateSessionEntries(entries);
			await tx.run(`DELETE FROM ${this.tables.entries} WHERE session_id = ?`, sessionId);
			await this.saveSummary(tx, sessionId, { header, entries, lastSeq: entries.length });
			await this.insertEntries(tx, sessionId, entries, 0);
			return { lastSeq: entries.length };
		});
	}

	async load(sessionId: string): Promise<SessionSnapshot> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		return this.database.transaction((tx) => this.read(tx, sessionId));
	}

	async readHeader(sessionId: string): Promise<SessionRecordHeader | undefined> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		const row = await this.database.get<HeaderRow>(
			`SELECT header_json FROM ${this.tables.sessions} WHERE id = ?`,
			sessionId,
		);
		return row ? (JSON.parse(row.header_json) as SessionRecordHeader) : undefined;
	}

	async delete(sessionId: string): Promise<void> {
		this.assertOpen();
		validateSessionText("sessionId", sessionId);
		await this.database.transaction(async (tx) => {
			await tx.run(`DELETE FROM ${this.tables.entries} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.sessions} WHERE id = ?`, sessionId);
		});
	}

	async *list(query: SessionListQuery): AsyncIterable<SessionSummary> {
		this.assertListing(query);
		const cwd = query.cwd;
		const rows = await this.database.all<SummaryRow>(
			`SELECT * FROM ${this.tables.sessions} WHERE (? IS NULL OR cwd = ?) AND (? = 1 OR internal = 0)`,
			cwd ?? null,
			cwd ?? null,
			query.includeInternal ? 1 : 0,
		);
		for (const row of rows) {
			this.assertListing(query);
			const header = JSON.parse(row.header_json) as SessionRecordHeader;
			if (cwd !== undefined && header.cwd !== cwd) continue;
			yield {
				id: header.id,
				cwd: header.cwd,
				...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
				internal: header.internal === true,
				...(header.workflow !== undefined ? { workflow: header.workflow } : {}),
				...(row.name !== null ? { name: JSON.parse(row.name) as string } : {}),
				hasName: row.has_name === 1,
				createdAt: header.createdAt,
				modifiedAt: row.modified_at,
				messageCount: row.message_count,
				firstMessage: JSON.parse(row.first_message) as string,
				...(row.summary !== null ? { summary: JSON.parse(row.summary) as string } : {}),
				...(row.summarized_through_id !== null ? { summarizedThroughId: row.summarized_through_id } : {}),
				searchText: JSON.parse(row.search_text) as string,
			};
		}
		this.assertListing(query);
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
	}

	private assertOpen(): void {
		if (this.closed) throw new StoreClosedError(this.descriptor);
	}

	private assertListing(query: SessionListQuery): void {
		this.assertOpen();
		if (query.signal?.aborted) throw new DOMException("Session listing aborted", "AbortError");
	}

	private async read(tx: SqliteExecutor, sessionId: string): Promise<SessionSnapshot> {
		const row = await tx.get<HeaderRow>(
			`SELECT header_json, last_seq FROM ${this.tables.sessions} WHERE id = ?`,
			sessionId,
		);
		if (!row) throw new SessionNotFoundError(sessionId);
		const entries = await tx.all<SqliteRow & { entry_json: string }>(
			`SELECT entry_json FROM ${this.tables.entries} WHERE session_id = ? ORDER BY seq`,
			sessionId,
		);
		return {
			header: JSON.parse(row.header_json) as SessionRecordHeader,
			entries: entries.map((entry) => JSON.parse(entry.entry_json) as SessionEntry),
			lastSeq: row.last_seq,
		};
	}

	private async forWrite(
		tx: SqliteExecutor,
		sessionId: string,
		options: SessionWriteOptions,
	): Promise<SessionSnapshot> {
		const snapshot = await this.read(tx, sessionId);
		if (snapshot.lastSeq !== options.expectSeq) {
			throw new SessionConflictError(sessionId, options.expectSeq, snapshot.lastSeq);
		}
		return snapshot;
	}

	private async saveSummary(tx: SqliteExecutor, sessionId: string, snapshot: SessionSnapshot): Promise<void> {
		const { header, lastSeq } = snapshot;
		const summary = summarizeSession(snapshot);
		await tx.run(
			`INSERT INTO ${this.tables.sessions}
				(id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count,
				 first_message, name, has_name, summary, summarized_through_id, search_text)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
				cwd = excluded.cwd, created_at = excluded.created_at, header_json = excluded.header_json,
				internal = excluded.internal, last_seq = excluded.last_seq, modified_at = excluded.modified_at,
				message_count = excluded.message_count, first_message = excluded.first_message, name = excluded.name,
				has_name = excluded.has_name, summary = excluded.summary,
				summarized_through_id = excluded.summarized_through_id, search_text = excluded.search_text`,
			sessionId,
			header.cwd,
			header.createdAt,
			this.encode(header),
			header.internal ? 1 : 0,
			lastSeq,
			summary.modifiedAt,
			summary.messageCount,
			this.encode(summary.firstMessage),
			summary.name === undefined ? null : this.encode(summary.name),
			summary.hasName ? 1 : 0,
			summary.summary === undefined ? null : this.encode(summary.summary),
			summary.summarizedThroughId ?? null,
			this.encode(summary.searchText),
		);
	}

	private async insertEntries(
		tx: SqliteExecutor,
		sessionId: string,
		entries: readonly SessionEntry[],
		lastSeq: number,
	): Promise<void> {
		for (const [index, entry] of entries.entries()) {
			await tx.run(
				`INSERT INTO ${this.tables.entries} (session_id, seq, entry_id, entry_json) VALUES (?, ?, ?, ?)`,
				sessionId,
				lastSeq + index + 1,
				entry.id,
				this.encode(entry),
			);
		}
	}

	private encode(value: SessionRecordHeader | SessionEntry | string): string {
		try {
			return JSON.stringify(value);
		} catch (cause) {
			throw new StorageUnavailableError(this.descriptor, cause as Error);
		}
	}
}
