import type { SessionEntry } from "../../session-manager-types.ts";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "../database.js";
import { StorageInvalidTextError } from "../errors.js";
import { renderStorageIdentifiers } from "../prefix.js";
import { assertStorageSchemaVersion } from "../schema.js";
import {
	SessionConflictError,
	SessionExistsError,
	SessionIdMismatchError,
	SessionNotFoundError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";
import {
	applySessionSummaryEntries,
	materializeSessionSummaryMetadata,
	type SessionSummaryState,
	type SessionSummaryText,
} from "./session-summary.js";
import type {
	SessionCwdMatcher,
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
export const SESSION_TABLES = Object.freeze({
	meta: "meta",
	sessions: "sessions",
	entries: "entries",
	searchTexts: "search_texts",
});

type Tables = Readonly<Record<keyof typeof SESSION_TABLES, string>>;
type HeaderRow = SqliteRow & { header_json: string; last_seq: number };
type SummaryStateRow = HeaderRow & { summary_state: string };
type ListingRow = HeaderRow & {
	id: string;
	cwd: string;
	internal: number;
	modified_at: string;
	message_count: number;
	first_message: string;
	name: string | null;
	has_name: number;
	summary: string | null;
	summarized_through_id: string | null;
};
type SummaryRow = ListingRow & { search_texts_json: string };

/** Every listing column except search text, so an unchanged row keeps its cached summary. */
const LISTING_COLUMNS =
	"id, cwd, internal, header_json, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id";
/** Rows whose search text is read per query; well under SQLite's bound-parameter limit. */
const LISTING_FETCH_BATCH = 500;
/** Listing scopes (visibility and project) kept at once; the picker uses two. */
const LISTING_SCOPES = 8;

function summaryFromRow(row: SummaryRow): SessionSummary {
	const header = JSON.parse(row.header_json) as SessionRecordHeader;
	return {
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
		searchText: (JSON.parse(row.search_texts_json) as string[]).join(" "),
	};
}

function listingVersion(row: ListingRow): string {
	return `${row.last_seq}\u0000${row.modified_at}\u0000${row.message_count}\u0000${row.has_name}\u0000${row.name}\u0000${row.summarized_through_id}\u0000${row.summary}\u0000${row.first_message}\u0000${row.header_json}`;
}

export class SqlSessionStore implements SessionStore {
	private readonly database: SqliteDatabase;
	private readonly tables: Tables;
	private readonly prefix: string;
	private closed = false;
	private readonly cwdMatcher?: SessionCwdMatcher;
	/** Session ids of each recently listed scope, valid while the store's change token is unchanged. */
	private readonly scopes = new Map<string, { readonly token: string; readonly ids: readonly string[] }>();
	/** Listed summaries of sessions that still exist at the cached version; never more than the store holds. */
	private readonly summaries = new Map<string, { readonly version: string; readonly summary: SessionSummary }>();

	private constructor(database: SqliteDatabase, tables: Tables, prefix = "", cwdMatcher?: SessionCwdMatcher) {
		this.database = database;
		this.tables = tables;
		this.prefix = prefix;
		this.cwdMatcher = cwdMatcher;
	}

	static async open(
		database: SqliteDatabase,
		options: { readonly prefix?: string; readonly cwdMatcher?: SessionCwdMatcher } = {},
	): Promise<SqlSessionStore> {
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
					summary_state TEXT NOT NULL CHECK(json_valid(summary_state))
				) STRICT;
				CREATE TABLE IF NOT EXISTS ${tables.entries} (
					session_id TEXT NOT NULL, seq INTEGER NOT NULL, entry_id TEXT NOT NULL,
					entry_json TEXT NOT NULL CHECK(json_valid(entry_json)), PRIMARY KEY(session_id, seq)
				) STRICT;
				CREATE TABLE IF NOT EXISTS ${tables.searchTexts} (
					session_id TEXT NOT NULL, seq INTEGER NOT NULL,
					text_json TEXT NOT NULL CHECK(json_valid(text_json)), PRIMARY KEY(session_id, seq)
				) STRICT;
			`);
		});
		return new SqlSessionStore(database, tables, options.prefix, options.cwdMatcher);
	}

	get descriptor(): StorageDescriptor {
		return { ...this.database.descriptor, ...(this.prefix === "" ? {} : { prefix: this.prefix }) };
	}

	async create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<{ readonly lastSeq: number }> {
		this.assertOpen();
		validateSessionHeader(header);
		validateSessionEntries(entries);
		return this.database.transaction(async (tx) => {
			if (await tx.get(`SELECT id FROM ${this.tables.sessions} WHERE id = ?`, header.id)) {
				throw new SessionExistsError(header.id);
			}
			const texts = await this.saveSummary(tx, header.id, { header, entries, lastSeq: entries.length });
			await this.insertEntries(tx, header.id, entries, 0, texts);
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
			const previous = await this.forWrite(tx, sessionId, options, true);
			validateSessionEntries(entries);
			const lastSeq = previous.last_seq + entries.length;
			const texts = await this.saveSummary(
				tx,
				sessionId,
				{ header: JSON.parse(previous.header_json) as SessionRecordHeader, entries, lastSeq },
				JSON.parse(previous.summary_state) as SessionSummaryState,
			);
			await this.insertEntries(tx, sessionId, entries, previous.last_seq, texts);
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
			if (header.id !== sessionId) throw new SessionIdMismatchError(sessionId, header.id);
			await tx.run(`DELETE FROM ${this.tables.searchTexts} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.entries} WHERE session_id = ?`, sessionId);
			const texts = await this.saveSummary(tx, sessionId, { header, entries, lastSeq: entries.length });
			await this.insertEntries(tx, sessionId, entries, 0, texts);
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
			await tx.run(`DELETE FROM ${this.tables.searchTexts} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.entries} WHERE session_id = ?`, sessionId);
			await tx.run(`DELETE FROM ${this.tables.sessions} WHERE id = ?`, sessionId);
		});
	}

	/**
	 * Lists from a per-scope cache revalidated on every call. A cheap change token, which moves on any commit
	 * from this or another connection, decides whether the scope is re-read. A scope listed for the first time
	 * is read exactly as an uncached listing; afterwards only its light columns are re-read and search text is
	 * read only for sessions whose stored listing columns changed.
	 */
	async *list(query: SessionListQuery): AsyncIterable<SessionSummary> {
		this.assertListing(query);
		// Validate the original query before binding only matching stored spellings below.
		if (query.cwd?.includes("\0")) throw new StorageInvalidTextError(0);
		// Read the token first: a commit racing the reads below moves it again before the next call.
		const token = await this.changeToken();
		const key = JSON.stringify([query.includeInternal === true, query.cwd ?? null]);
		const cached = this.scopes.get(key);
		const scope =
			cached?.token === token ? cached : { token, ids: await this.readScope(query, cached !== undefined) };
		// Map order is recency order: re-inserting marks the scope as used, and the oldest scope is evicted first.
		this.scopes.delete(key);
		this.scopes.set(key, scope);
		for (const oldest of this.scopes.keys()) {
			if (this.scopes.size <= LISTING_SCOPES) break;
			this.scopes.delete(oldest);
		}
		if (scope !== cached) this.pruneSummaries();
		// Resolve before yielding so a concurrent listing cannot change what this one returns.
		const summaries = scope.ids.flatMap((id) => this.summaries.get(id)?.summary ?? []);
		for (const summary of summaries) {
			this.assertListing(query);
			yield summary;
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
		this.scopes.clear();
		this.summaries.clear();
	}

	/**
	 * `data_version` moves when another connection commits and `total_changes()` when this one writes, so
	 * together they cover writers in every process; the table aggregates also catch a change to the sessions
	 * table if the adapter does not serve every statement from one connection.
	 */
	private async changeToken(): Promise<string> {
		const row = await this.database.get<SqliteRow>(
			`SELECT data_version, total_changes() AS changes,
				(SELECT count(*) FROM ${this.tables.sessions}) AS sessions,
				(SELECT max(rowid) FROM ${this.tables.sessions}) AS last_row
			FROM pragma_data_version`,
		);
		return JSON.stringify(Object.values(row ?? {}).map(String));
	}

	/** The scope's session ids in store order, with a current summary cached for each. */
	private async readScope(query: SessionListQuery, listedBefore: boolean): Promise<readonly string[]> {
		const matchesCwd =
			query.cwd === undefined
				? undefined
				: (this.cwdMatcher?.(query.cwd) ?? ((candidate: string | undefined) => candidate === query.cwd));
		let projectCwds: string[] | undefined;
		if (matchesCwd) {
			const projects = await this.database.all<SqliteRow & { cwd: string }>(
				`SELECT DISTINCT cwd FROM ${this.tables.sessions}`,
			);
			projectCwds = projects.map((project) => project.cwd).filter(matchesCwd);
			this.assertListing(query);
			if (projectCwds.length === 0) return [];
		}
		const scope = `(? = 1 OR internal = 0)${projectCwds ? ` AND cwd IN (${projectCwds.map(() => "?").join(", ")})` : ""}`;
		const params = [query.includeInternal ? 1 : 0, ...(projectCwds ?? [])];
		const inScope = (row: ListingRow) => !matchesCwd || matchesCwd(row.cwd);
		if (listedBefore) {
			const rows = (
				await this.database.all<ListingRow>(
					`SELECT ${LISTING_COLUMNS} FROM ${this.tables.sessions} WHERE ${scope}`,
					...params,
				)
			).filter(inScope);
			this.assertListing(query);
			const stale = rows.filter((row) => this.summaries.get(row.id)?.version !== listingVersion(row));
			// A few changed sessions are read by id; when most changed, one scan of the scope is cheaper.
			if (stale.length <= rows.length / 4) {
				for (let start = 0; start < stale.length; start += LISTING_FETCH_BATCH) {
					const ids = stale.slice(start, start + LISTING_FETCH_BATCH).map((row) => row.id);
					const fetched = new Set(
						(await this.readSummaries(`id IN (${ids.map(() => "?").join(", ")})`, ids)).map((row) => row.id),
					);
					// A session deleted after the light read must not be listed from an older cached copy.
					for (const id of ids) if (!fetched.has(id)) this.summaries.delete(id);
					this.assertListing(query);
				}
				return rows.map((row) => row.id);
			}
		}
		const rows = (await this.readSummaries(scope, params)).filter(inScope);
		this.assertListing(query);
		return rows.map((row) => row.id);
	}

	/** Reads full listing rows, search text included, and caches their summaries. */
	private async readSummaries(where: string, params: readonly SqliteValue[]): Promise<readonly SummaryRow[]> {
		// Combine encoded strings only at read time, preserving NUL and lone surrogates verbatim.
		const rows = await this.database.all<SummaryRow>(
			`SELECT ${LISTING_COLUMNS}, (
				SELECT COALESCE('[' || group_concat(text_json, ',') || ']', '[]')
				FROM (SELECT text_json FROM ${this.tables.searchTexts} WHERE session_id = s.id ORDER BY seq)
			) AS search_texts_json
			FROM ${this.tables.sessions} AS s WHERE ${where}`,
			...params,
		);
		for (const row of rows)
			this.summaries.set(row.id, { version: listingVersion(row), summary: summaryFromRow(row) });
		return rows;
	}

	/** Keeps only summaries some cached scope still lists, so memory follows the live sessions. */
	private pruneSummaries(): void {
		const listed = new Set([...this.scopes.values()].flatMap((scope) => scope.ids));
		for (const id of this.summaries.keys()) if (!listed.has(id)) this.summaries.delete(id);
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

	private forWrite(
		tx: SqliteExecutor,
		sessionId: string,
		options: SessionWriteOptions,
		includeSummaryState: true,
	): Promise<SummaryStateRow>;
	private forWrite(
		tx: SqliteExecutor,
		sessionId: string,
		options: SessionWriteOptions,
		includeSummaryState?: false,
	): Promise<HeaderRow>;
	private async forWrite(
		tx: SqliteExecutor,
		sessionId: string,
		options: SessionWriteOptions,
		includeSummaryState = false,
	): Promise<HeaderRow> {
		const row = await tx.get<HeaderRow>(
			`SELECT header_json, last_seq${includeSummaryState ? ", summary_state" : ""}
			 FROM ${this.tables.sessions} WHERE id = ?`,
			sessionId,
		);
		if (!row) throw new SessionNotFoundError(sessionId);
		if (row.last_seq !== options.expectSeq) {
			throw new SessionConflictError(sessionId, options.expectSeq, row.last_seq);
		}
		return row;
	}

	private async saveSummary(
		tx: SqliteExecutor,
		sessionId: string,
		snapshot: SessionSnapshot,
		previous?: SessionSummaryState,
	): Promise<readonly SessionSummaryText[]> {
		const { header, lastSeq } = snapshot;
		const { state, texts } = applySessionSummaryEntries(previous, snapshot.entries);
		const summary = materializeSessionSummaryMetadata(header, state);
		await tx.run(
			`INSERT INTO ${this.tables.sessions}
				(id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count,
				 first_message, name, has_name, summary, summarized_through_id, summary_state)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
				cwd = excluded.cwd, created_at = excluded.created_at, header_json = excluded.header_json,
				internal = excluded.internal, last_seq = excluded.last_seq, modified_at = excluded.modified_at,
				message_count = excluded.message_count, first_message = excluded.first_message, name = excluded.name,
				has_name = excluded.has_name, summary = excluded.summary,
				summarized_through_id = excluded.summarized_through_id,
				summary_state = excluded.summary_state`,
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
			this.encode(state),
		);
		return texts;
	}

	private async insertEntries(
		tx: SqliteExecutor,
		sessionId: string,
		entries: readonly SessionEntry[],
		lastSeq: number,
		texts: readonly SessionSummaryText[],
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
		for (const { index, text } of texts) {
			await tx.run(
				`INSERT INTO ${this.tables.searchTexts} (session_id, seq, text_json) VALUES (?, ?, ?)`,
				sessionId,
				lastSeq + index + 1,
				this.encode(text),
			);
		}
	}

	private encode(value: SessionRecordHeader | SessionEntry | SessionSummaryState | string): string {
		try {
			return JSON.stringify(value);
		} catch (cause) {
			throw new StorageUnavailableError(this.descriptor, cause as Error);
		}
	}
}
