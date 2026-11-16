import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "../database.js";
import { dialectOf, type StorageDialect, type StorageTrigger } from "../dialect.js";
import { applyStorageMigrations } from "../migrations.js";
import { renderStorageIdentifiers, storageMigrationTable } from "../prefix.js";
import type { SessionSearchCoverage, SessionSearchIndex, SessionSearchText } from "./types.js";

export const SESSION_SEARCH_DOMAIN = "session-search";
export const SESSION_SEARCH_TABLES = Object.freeze({
	state: "search_state",
	fts: "search_fts",
	entries: "search_entries",
	trigrams: "search_trgm",
	entriesForget: "entries_search_forget",
});

export const SEARCH_PART_CHARS = 4_096;
export const SEARCH_PART_OVERLAP = 512;

type SearchTables = Readonly<Record<keyof typeof SESSION_SEARCH_TABLES, string>>;
interface SessionTables {
	readonly sessions: string;
	readonly entries: string;
}

const PART_BITS = 14;
const PART_SPACE = 1 << PART_BITS;
const PART_MASK = PART_SPACE - 1;
const MAX_PARTS = PART_SPACE - 4;
const SEQ_SPACE = 67_108_864;
const SEQ_MASK = SEQ_SPACE - 1;
const MAX_SID = 8_388_607;
const MAX_LITERALS_PER_SET = 8;
const MAX_TERMS_PER_SET = 24;
const INSERT_ROWS_PER_STATEMENT = 64;
const MAX_LITERAL_CHARS = 200;
const BATCH_CHARS = 32_768;
const CANDIDATE_ROWS = 256;
const SEQ_WINDOW = 4_096;

interface SearchDoc {
	readonly seq: number;
	readonly part: number;
	readonly text: string;
}

export function yieldTurn(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof setImmediate === "function") setImmediate(resolve);
		else setTimeout(resolve, 0);
	});
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

export function splitSearchTextParts(text: string): string[] {
	if (text.length <= SEARCH_PART_CHARS + SEARCH_PART_OVERLAP) return [text];
	const step = Math.max(SEARCH_PART_CHARS, Math.ceil((text.length - SEARCH_PART_OVERLAP) / MAX_PARTS));
	const parts: string[] = [];
	for (let start = 0; ; ) {
		let end = Math.min(text.length, start + step + SEARCH_PART_OVERLAP);
		if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
		parts.push(text.slice(start, end));
		if (end >= text.length) return parts;
		start += step;
		if (isHighSurrogate(text.charCodeAt(start - 1))) start--;
	}
}

function docsOf(texts: readonly SessionSearchText[]): SearchDoc[] {
	return texts.flatMap(({ seq, text, parts }) => {
		const slices =
			parts !== undefined
				? parts.flatMap(splitSearchTextParts)
				: text === undefined || text.length === 0
					? []
					: splitSearchTextParts(text);
		return slices.slice(0, MAX_PARTS).map((slice, index) => ({ seq, part: index, text: slice }));
	});
}

type CoverageRow = SqliteRow & {
	last_seq: number | bigint;
	sid: number | bigint | null;
	format: number | bigint | null;
	indexed_seq: number | bigint | null;
};

interface TrigramEngine {
	create(
		tx: SqliteExecutor,
		dialect: StorageDialect,
		tables: SearchTables,
		sessionTables: SessionTables,
	): Promise<void>;
	forgetInTrigger(tables: SearchTables): string;
	insert(tx: SqliteExecutor, tables: SearchTables, sid: number, docs: readonly SearchDoc[]): Promise<void>;
	forget(tx: SqliteExecutor, tables: SearchTables, sessionId: string): Promise<void>;
	candidates(
		database: SqliteDatabase,
		tables: SearchTables,
		sid: number,
		anyOf: readonly (readonly string[])[],
		fromSeq: number,
		toSeq: number,
		limit: number,
	): Promise<readonly number[]>;
}

function trigramsOf(literal: string): string[] {
	const chars = Array.from(literal);
	const starts = new Set<number>();
	for (let start = 0; start + 3 <= chars.length; start += 3) starts.add(start);
	starts.add(chars.length - 3);
	return [...starts].map((start) => chars.slice(start, start + 3).join(""));
}

function ftsLiteral(literal: string): string {
	const terms = [...new Set(trigramsOf(literal))].slice(0, MAX_TERMS_PER_SET);
	return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function normalizeSets(anyOf: readonly (readonly string[])[]): string[][] {
	const sets = anyOf
		.map((all) =>
			[
				...new Set(
					all
						.map((literal) => Array.from(literal).slice(0, MAX_LITERAL_CHARS).join(""))
						.filter((literal) => Array.from(literal).length >= 3),
				),
			].slice(0, MAX_LITERALS_PER_SET),
		)
		.filter((all) => all.length > 0);
	let total = sets.reduce((sum, all) => sum + all.length, 0);
	while (total > MAX_TERMS_PER_SET) {
		const multi = sets.find((all) => all.length > 1);
		if (!multi) break;
		multi.pop();
		total--;
	}
	return sets;
}

function foldForLike(text: string): string {
	return text.replaceAll("\u0000", "\ufffd").replaceAll("\u017f", "s").replaceAll("\u212a", "k");
}

function likePattern(literal: string): string {
	return `%${foldForLike(literal).replace(/[\\%_]/g, "\\$&")}%`;
}

function likeColumn(literal: string): string {
	return /[A-Za-z0-9]{3}/.test(foldForLike(literal)) ? "body" : "(body || '')";
}

function forgetTrigger(tables: SearchTables, sessionTables: SessionTables, engine: TrigramEngine): StorageTrigger {
	return {
		name: tables.entriesForget,
		table: sessionTables.entries,
		timing: "AFTER",
		event: "DELETE",
		when: `EXISTS (SELECT 1 FROM ${tables.state} WHERE session_id = OLD.session_id)`,
		statements: [engine.forgetInTrigger(tables), `DELETE FROM ${tables.state} WHERE session_id = OLD.session_id`],
	};
}

const sqliteFts: TrigramEngine = {
	async create(tx, _dialect, tables) {
		await tx.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS ${tables.fts} USING fts5(body, content='', contentless_delete=1, tokenize='trigram', detail='none')`,
		);
	},
	forgetInTrigger(tables) {
		return `DELETE FROM ${tables.fts} WHERE rowid BETWEEN (SELECT sid << 40 FROM ${tables.state} WHERE session_id = OLD.session_id) AND (SELECT (sid << 40) + 1099511627775 FROM ${tables.state} WHERE session_id = OLD.session_id)`;
	},
	async insert(tx, tables, sid, docs) {
		for (const { seq, part, text } of docs)
			await tx.run(
				`INSERT INTO ${tables.fts} (rowid, body) VALUES ((? << 40) + (? << ${PART_BITS}) + ?, ?)`,
				sid,
				seq,
				part,
				text,
			);
	},
	async forget(tx, tables, sessionId) {
		await tx.run(
			`DELETE FROM ${tables.fts} WHERE rowid BETWEEN (SELECT sid << 40 FROM ${tables.state} WHERE session_id = ?) AND (SELECT (sid << 40) + 1099511627775 FROM ${tables.state} WHERE session_id = ?)`,
			sessionId,
			sessionId,
		);
	},
	async candidates(database, tables, sid, anyOf, fromSeq, toSeq, limit) {
		const sets = normalizeSets(anyOf);
		if (sets.length === 0) return [];
		const seqs: number[] = [];
		if (sets.every((all) => all.length === 1)) {
			const query = sets.map((all) => `(${ftsLiteral(all[0]!)})`).join(" OR ");
			for (let from = fromSeq; from <= toSeq && seqs.length < limit; ) {
				const rows = await database.all<SqliteRow & { seq: number | bigint }>(
					`SELECT (rowid >> ${PART_BITS}) & ${SEQ_MASK} AS seq FROM ${tables.fts} WHERE ${tables.fts} MATCH ? AND rowid BETWEEN (? << 40) + (? << ${PART_BITS}) AND (? << 40) + (? << ${PART_BITS}) + ${PART_MASK} ORDER BY rowid LIMIT ?`,
					query,
					sid,
					from,
					sid,
					toSeq,
					CANDIDATE_ROWS,
				);
				for (const row of rows) {
					const seq = Number(row.seq);
					if (seqs.at(-1) !== seq && seqs.length < limit) seqs.push(seq);
				}
				if (rows.length < CANDIDATE_ROWS) break;
				from = Number(rows.at(-1)!.seq) + 1;
				await yieldTurn();
			}
			return seqs;
		}
		for (let from = fromSeq; from <= toSeq && seqs.length < limit; from += SEQ_WINDOW) {
			const winTo = Math.min(toSeq, from + SEQ_WINDOW - 1);
			const arms: string[] = [];
			const params: SqliteValue[] = [];
			for (const [setIndex, all] of sets.entries()) {
				for (const [litIndex, literal] of all.entries()) {
					arms.push(
						`SELECT (rowid >> ${PART_BITS}) & ${SEQ_MASK} AS seq, ${setIndex} AS set_id, ${litIndex} AS lit_id, ${all.length} AS need FROM ${tables.fts} WHERE ${tables.fts} MATCH ? AND rowid BETWEEN (? << 40) + (? << ${PART_BITS}) AND (? << 40) + (? << ${PART_BITS}) + ${PART_MASK}`,
					);
					params.push(ftsLiteral(literal), sid, from, sid, winTo);
				}
			}
			const rows = await database.all<SqliteRow & { seq: number | bigint }>(
				`SELECT DISTINCT seq FROM (
					SELECT seq, set_id FROM (${arms.join(" UNION ALL ")})
					GROUP BY seq, set_id HAVING count(DISTINCT lit_id) = max(need)
				) ORDER BY seq LIMIT ?`,
				...params,
				limit - seqs.length,
			);
			for (const row of rows) {
				const seq = Number(row.seq);
				if (seqs.at(-1) !== seq && seqs.length < limit) seqs.push(seq);
			}
			if (winTo < toSeq && seqs.length < limit) await yieldTurn();
		}
		return seqs;
	},
};

const postgresTrigrams: TrigramEngine = {
	async create(tx, dialect, tables, sessionTables) {
		const { int, text } = dialect.types;
		await tx.exec(
			`CREATE TABLE IF NOT EXISTS ${tables.entries} (sid ${int} NOT NULL, seq ${int} NOT NULL, part ${int} NOT NULL, body ${text} NOT NULL, PRIMARY KEY (sid, seq, part))`,
		);
		await tx.exec(dialect.renderTrigger(forgetTrigger(tables, sessionTables, postgresTrigrams)));
		await tx.exec("SAVEPOINT atomic_session_search_trgm");
		try {
			await tx.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm");
			const found = await tx.get<SqliteRow & { schema: string }>(
				"SELECT n.nspname AS schema FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'",
			);
			await tx.exec(
				`CREATE INDEX IF NOT EXISTS ${tables.trigrams} ON ${tables.entries} USING gin (body ${dialect.identifier(String(found?.schema))}.gin_trgm_ops)`,
			);
			await tx.exec("RELEASE SAVEPOINT atomic_session_search_trgm");
		} catch {
			await tx.exec("ROLLBACK TO SAVEPOINT atomic_session_search_trgm");
		}
	},
	forgetInTrigger(tables) {
		return `DELETE FROM ${tables.entries} WHERE sid IN (SELECT sid FROM ${tables.state} WHERE session_id = OLD.session_id)`;
	},
	async insert(tx, tables, sid, docs) {
		for (let start = 0; start < docs.length; start += INSERT_ROWS_PER_STATEMENT) {
			const batch = docs.slice(start, start + INSERT_ROWS_PER_STATEMENT);
			await tx.run(
				`INSERT INTO ${tables.entries} (sid, seq, part, body) VALUES ${batch.map(() => "(?, ?, ?, ?)").join(", ")} ON CONFLICT (sid, seq, part) DO UPDATE SET body = excluded.body`,
				...batch.flatMap(({ seq, part, text }) => [sid, seq, part, foldForLike(text)]),
			);
		}
	},
	async forget(tx, tables, sessionId) {
		await tx.run(
			`DELETE FROM ${tables.entries} WHERE sid IN (SELECT sid FROM ${tables.state} WHERE session_id = ?)`,
			sessionId,
		);
	},
	async candidates(database, tables, sid, anyOf, fromSeq, toSeq, limit) {
		const sets = normalizeSets(anyOf);
		if (sets.length === 0) return [];
		if (sets.every((all) => all.length === 1)) {
			const params: SqliteValue[] = [];
			const where = sets
				.map((all) => {
					const literal = all[0]!;
					params.push(likePattern(literal));
					return `${likeColumn(literal)} ILIKE ? ESCAPE '\\'`;
				})
				.join(" OR ");
			const rows = await database.all<SqliteRow & { seq: number | bigint }>(
				`SELECT DISTINCT seq FROM ${tables.entries} WHERE sid = ? AND seq >= ? AND seq <= ? AND (${where}) ORDER BY seq LIMIT ?`,
				sid,
				fromSeq,
				toSeq,
				...params,
				limit,
			);
			return rows.map((row) => Number(row.seq));
		}
		const seqs: number[] = [];
		for (let from = fromSeq; from <= toSeq && seqs.length < limit; from += SEQ_WINDOW) {
			const winTo = Math.min(toSeq, from + SEQ_WINDOW - 1);
			const arms: string[] = [];
			const params: SqliteValue[] = [];
			for (const [setIndex, all] of sets.entries()) {
				for (const [litIndex, literal] of all.entries()) {
					arms.push(
						`SELECT seq, ${setIndex} AS set_id, ${litIndex} AS lit_id, ${all.length} AS need FROM ${tables.entries} WHERE sid = ? AND seq >= ? AND seq <= ? AND ${likeColumn(literal)} ILIKE ? ESCAPE '\\'`,
					);
					params.push(sid, from, winTo, likePattern(literal));
				}
			}
			const rows = await database.all<SqliteRow & { seq: number | bigint }>(
				`SELECT DISTINCT seq FROM (
					SELECT seq, set_id FROM (${arms.join(" UNION ALL ")}) AS hits
					GROUP BY seq, set_id HAVING count(DISTINCT lit_id) = max(need)
				) AS matched ORDER BY seq LIMIT ?`,
				...params,
				limit - seqs.length,
			);
			for (const row of rows) {
				const seq = Number(row.seq);
				if (seqs.at(-1) !== seq && seqs.length < limit) seqs.push(seq);
			}
			if (winTo < toSeq && seqs.length < limit) await yieldTurn();
		}
		return seqs;
	},
};

function engineFor(dialect: StorageDialect): TrigramEngine {
	return dialect.name === "postgres" ? postgresTrigrams : sqliteFts;
}

export class SqlSessionSearchIndex implements SessionSearchIndex {
	private readonly database: SqliteDatabase;
	private readonly dialect: StorageDialect;
	private readonly sessionTables: SessionTables;
	private readonly tables: SearchTables;
	private readonly engine: TrigramEngine;
	private triggerInstalled = false;

	private constructor(database: SqliteDatabase, sessionTables: SessionTables, tables: SearchTables) {
		this.database = database;
		this.dialect = dialectOf(database);
		this.sessionTables = sessionTables;
		this.tables = tables;
		this.engine = engineFor(this.dialect);
		this.triggerInstalled = this.dialect.name === "postgres";
	}

	static async open(
		database: SqliteDatabase,
		sessionTables: SessionTables,
		prefix: string | undefined,
	): Promise<SqlSessionSearchIndex | undefined> {
		const tables = renderStorageIdentifiers("sessions", SESSION_SEARCH_TABLES, prefix);
		const engine = engineFor(dialectOf(database));
		try {
			await applyStorageMigrations(
				database,
				SESSION_SEARCH_DOMAIN,
				[
					{
						version: 1,
						up: async (tx, dialect) => {
							const { int, text, rowKey } = dialect.types;
							await tx.exec(
								`CREATE TABLE IF NOT EXISTS ${tables.state} (sid ${rowKey}, session_id ${text} NOT NULL UNIQUE, format ${int} NOT NULL, indexed_seq ${int} NOT NULL, revision ${text} NOT NULL, entry_id ${text} NOT NULL)${dialect.tableOptions}`,
							);
							await engine.create(tx, dialect, tables, sessionTables);
						},
					},
				],
				{ table: storageMigrationTable(prefix), acceptNewer: true },
			);
		} catch {
			return undefined;
		}
		return new SqlSessionSearchIndex(database, sessionTables, tables);
	}

	async forget(tx: SqliteExecutor, sessionId: string): Promise<void> {
		await this.engine.forget(tx, this.tables, sessionId);
		await tx.run(`DELETE FROM ${this.tables.state} WHERE session_id = ?`, sessionId);
	}

	async forgetWithin(tx: SqliteExecutor, sessionId: string): Promise<void> {
		await tx.exec("SAVEPOINT atomic_session_search_forget");
		try {
			await this.forget(tx, sessionId);
		} catch {
			await tx.exec("ROLLBACK TO SAVEPOINT atomic_session_search_forget");
		}
		await tx.exec("RELEASE SAVEPOINT atomic_session_search_forget");
	}

	async coverage(sessionId: string, format: number): Promise<SessionSearchCoverage | undefined> {
		const row = await this.database.get<CoverageRow>(
			`SELECT s.last_seq, st.sid, st.format, st.indexed_seq
			FROM ${this.sessionTables.sessions} s
			LEFT JOIN ${this.tables.state} st ON st.session_id = s.id
			WHERE s.id = ?`,
			sessionId,
		);
		if (!row) return undefined;
		const lastSeq = Number(row.last_seq);
		if (row.sid === null) return { indexedSeq: 0, lastSeq };
		const indexedSeq = Number(row.indexed_seq);
		if (Number(row.format) === format && indexedSeq <= lastSeq) return { indexedSeq, lastSeq };
		await this.database.transaction((tx) => this.forget(tx, sessionId), { retryTransientFailures: true });
		return { indexedSeq: 0, lastSeq };
	}

	async extend(
		sessionId: string,
		format: number,
		afterSeq: number,
		throughSeq: number,
		texts: readonly SessionSearchText[],
	): Promise<boolean> {
		if (throughSeq >= SEQ_SPACE || throughSeq < afterSeq) return false;
		const options = { retryTransientFailures: true };
		const docs = docsOf(texts);
		const totalChars = docs.reduce((sum, doc) => sum + doc.text.length, 0);
		if (totalChars <= BATCH_CHARS) {
			return this.database.transaction(async (tx) => {
				if (!this.triggerInstalled) {
					await tx.exec(this.dialect.renderTrigger(forgetTrigger(this.tables, this.sessionTables, this.engine)));
					this.triggerInstalled = true;
				}
				const row = await tx.get<CoverageRow & { revision: string }>(
					`SELECT s.last_seq, s.revision, st.sid, st.format, st.indexed_seq
					FROM ${this.sessionTables.sessions} s LEFT JOIN ${this.tables.state} st ON st.session_id = s.id
					WHERE s.id = ?`,
					sessionId,
				);
				if (!row || Number(row.last_seq) < throughSeq) return false;
				let sid: number;
				if (row.sid !== null) {
					if (Number(row.format) !== format || Number(row.indexed_seq) !== afterSeq) return false;
					sid = Number(row.sid);
				} else {
					if (afterSeq !== 0) return false;
					const created = await tx.get<SqliteRow & { sid: number | bigint }>(
						`INSERT INTO ${this.tables.state} (session_id, format, indexed_seq, revision, entry_id) VALUES (?, ?, 0, '', '') RETURNING sid`,
						sessionId,
						format,
					);
					sid = Number(created!.sid);
				}
				if (sid > MAX_SID) return false;
				if (docs.length > 0) await this.engine.insert(tx, this.tables, sid, docs);
				await tx.run(
					`UPDATE ${this.tables.state} SET indexed_seq = ?, revision = ? WHERE sid = ?`,
					throughSeq,
					row.revision,
					sid,
				);
				return true;
			}, options);
		}
		const sid = await this.database.transaction(async (tx) => {
			if (!this.triggerInstalled) {
				await tx.exec(this.dialect.renderTrigger(forgetTrigger(this.tables, this.sessionTables, this.engine)));
				this.triggerInstalled = true;
			}
			const row = await tx.get<CoverageRow>(
				`SELECT s.last_seq, st.sid, st.format, st.indexed_seq
				FROM ${this.sessionTables.sessions} s LEFT JOIN ${this.tables.state} st ON st.session_id = s.id
				WHERE s.id = ?`,
				sessionId,
			);
			if (!row || Number(row.last_seq) < throughSeq) return undefined;
			if (row.sid !== null)
				return Number(row.format) === format && Number(row.indexed_seq) === afterSeq ? Number(row.sid) : undefined;
			if (afterSeq !== 0) return undefined;
			const created = await tx.get<SqliteRow & { sid: number | bigint }>(
				`INSERT INTO ${this.tables.state} (session_id, format, indexed_seq, revision, entry_id) VALUES (?, ?, 0, '', '') RETURNING sid`,
				sessionId,
				format,
			);
			return Number(created!.sid);
		}, options);
		if (sid === undefined || sid > MAX_SID) return false;
		const unchanged = async (tx: SqliteExecutor) => {
			const state = await tx.get<SqliteRow & { format: number | bigint; indexed_seq: number | bigint }>(
				`SELECT format, indexed_seq FROM ${this.tables.state} WHERE sid = ? AND session_id = ?`,
				sid,
				sessionId,
			);
			return state !== undefined && Number(state.format) === format && Number(state.indexed_seq) === afterSeq;
		};
		for (let start = 0; start < docs.length; ) {
			let end = start + 1;
			for (
				let chars = docs[start]!.text.length;
				end < docs.length && chars + docs[end]!.text.length <= BATCH_CHARS;
				end++
			)
				chars += docs[end]!.text.length;
			const batch = docs.slice(start, end);
			const written = await this.database.transaction(async (tx) => {
				if (!(await unchanged(tx))) return false;
				await this.engine.insert(tx, this.tables, sid, batch);
				return true;
			}, options);
			if (!written) return false;
			start = end;
			await yieldTurn();
		}
		return this.database.transaction(async (tx) => {
			if (!(await unchanged(tx))) return false;
			const session = await tx.get<SqliteRow & { last_seq: number | bigint; revision: string }>(
				`SELECT last_seq, revision FROM ${this.sessionTables.sessions} WHERE id = ?`,
				sessionId,
			);
			if (!session || Number(session.last_seq) < throughSeq) return false;
			await tx.run(
				`UPDATE ${this.tables.state} SET indexed_seq = ?, revision = ? WHERE sid = ?`,
				throughSeq,
				session.revision,
				sid,
			);
			return true;
		}, options);
	}

	async candidates(
		sessionId: string,
		anyOf: readonly (readonly string[])[],
		fromSeq: number,
		toSeq: number,
		limit: number,
	): Promise<readonly number[]> {
		if (anyOf.length === 0 || fromSeq > toSeq) return [];
		const state = await this.database.get<SqliteRow & { sid: number | bigint; indexed_seq: number | bigint }>(
			`SELECT sid, indexed_seq FROM ${this.tables.state} WHERE session_id = ?`,
			sessionId,
		);
		if (!state) return [];
		const through = Math.min(toSeq, Number(state.indexed_seq), SEQ_SPACE - 1);
		if (fromSeq > through) return [];
		return this.engine.candidates(this.database, this.tables, Number(state.sid), anyOf, fromSeq, through, limit);
	}
}
