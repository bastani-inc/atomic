import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "../database.js";
import { dialectOf, type StorageDialect, type StorageTrigger } from "../dialect.js";
import { applyStorageMigrations, withShortSchemaLockWaits } from "../migrations.js";
import { renderStorageIdentifiers, storageMigrationTable } from "../prefix.js";
import type {
	SessionSearchCoverage,
	SessionSearchExtendOptions,
	SessionSearchIndex,
	SessionSearchText,
} from "./types.js";
import { yieldTurn } from "./yield-turn.js";

export { yieldTurn };

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
export const MAX_INDEXED_ENTRY_CHARS = 8 * 1024 * 1024;

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
const INSERT_ROWS_PER_STATEMENT = 32;
const MAX_LITERAL_CHARS = 200;
const BATCH_CHARS = 12_288;
const CANDIDATE_ROWS = 256;
const SEQ_WINDOW = 4_096;
const MERGE_PAGES = 8;
const MERGE_STEPS_PER_WRITE = 8;
const MAX_MERGE_BACKLOG_WRITES = 16;

interface SearchDoc {
	readonly seq: number;
	readonly part: number;
	readonly text: string;
}

function newGeneration(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return `g:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function withCoverageMeta(
	base: { readonly indexedSeq: number; readonly lastSeq: number },
	generation: string,
	revision: string,
): SessionSearchCoverage {
	const target: SessionSearchCoverage = { indexedSeq: base.indexedSeq, lastSeq: base.lastSeq };
	Object.defineProperties(target, {
		generation: { value: generation, enumerable: false },
		revision: { value: revision, enumerable: false },
	});
	return target;
}

function parseWholeSeqs(raw: string | null | undefined): number[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((part) => Number.parseInt(part, 10))
		.filter((seq) => Number.isInteger(seq) && seq >= 1);
}

function mergeWholeSeqs(existing: string | null | undefined, added: readonly number[]): string {
	if (added.length === 0) return existing ?? "";
	const merged = new Set<number>(parseWholeSeqs(existing));
	for (const seq of added) if (seq >= 1) merged.add(seq);
	return [...merged].sort((a, b) => a - b).join(",");
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

export function splitSearchTextParts(text: string): string[] {
	if (text.length <= SEARCH_PART_CHARS + SEARCH_PART_OVERLAP) return [text];
	const step = SEARCH_PART_CHARS;
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

function prepareDocs(texts: readonly SessionSearchText[]): {
	readonly docs: SearchDoc[];
	readonly oversizedSeqs: number[];
} {
	const docs: SearchDoc[] = [];
	const oversizedSeqs: number[] = [];
	for (const { seq, text, parts, oversized } of texts) {
		if (oversized === true || (text !== undefined && text.length > MAX_INDEXED_ENTRY_CHARS)) {
			oversizedSeqs.push(seq);
			continue;
		}
		const slices =
			parts !== undefined
				? parts.flatMap(splitSearchTextParts)
				: text === undefined || text.length === 0
					? []
					: splitSearchTextParts(text);
		if (slices.length > MAX_PARTS) {
			oversizedSeqs.push(seq);
			continue;
		}
		for (const [index, slice] of slices.entries()) {
			docs.push({ seq, part: index, text: slice });
		}
	}
	return { docs, oversizedSeqs };
}

type CoverageRow = SqliteRow & {
	last_seq: number | bigint;
	session_revision: string;
	sid: number | bigint | null;
	format: number | bigint | null;
	indexed_seq: number | bigint | null;
	generation: string | null;
	whole_seqs: string | null;
};

interface TrigramEngine {
	create(
		tx: SqliteExecutor,
		dialect: StorageDialect,
		tables: SearchTables,
		sessionTables: SessionTables,
	): Promise<void>;
	forgetInTrigger(tables: SearchTables): string;
	ready(database: SqliteDatabase, dialect: StorageDialect, tables: SearchTables): Promise<boolean>;
	prepareWrites(
		tx: SqliteExecutor,
		dialect: StorageDialect,
		tables: SearchTables,
		sessionTables: SessionTables,
	): Promise<void>;
	merge(tx: SqliteExecutor, tables: SearchTables, steps: number, signal?: AbortSignal): Promise<boolean>;
	insert(
		tx: SqliteExecutor,
		tables: SearchTables,
		sid: number,
		docs: readonly SearchDoc[],
		signal?: AbortSignal,
	): Promise<void>;
	forget(tx: SqliteExecutor, tables: SearchTables, sessionId: string): Promise<void>;
	candidates(
		database: SqliteDatabase,
		tables: SearchTables,
		sid: number,
		anyOf: readonly (readonly string[])[],
		fromSeq: number,
		toSeq: number,
		limit: number,
		signal?: AbortSignal,
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

function withoutNul(text: string): string {
	return text.replaceAll("\u0000", "\ufffd");
}

function foldForLike(text: string): string {
	return withoutNul(text).toLowerCase().replaceAll("\u03c2", "\u03c3").replaceAll("\u017f", "s");
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
	async ready() {
		return true;
	},
	async prepareWrites(tx, dialect, tables, sessionTables) {
		await tx.exec(dialect.renderTrigger(forgetTrigger(tables, sessionTables, sqliteFts)));
		await tx.run(`INSERT INTO ${tables.fts} (${tables.fts}, rank) VALUES ('automerge', 0)`);
	},
	async merge(tx, tables, steps, signal) {
		const totalChanges = async () =>
			Number((await tx.get<SqliteRow & { changes: number | bigint }>("SELECT total_changes() AS changes"))?.changes);
		// Nothing else runs on the transaction's connection between steps, so one step's count is the next one's start.
		let before: number | undefined;
		for (let step = 0; step < steps; step++) {
			signal?.throwIfAborted();
			before ??= await totalChanges();
			await tx.run(`INSERT INTO ${tables.fts} (${tables.fts}, rank) VALUES ('merge', ?)`, MERGE_PAGES);
			const after = await totalChanges();
			if (after - before < 2) return false;
			before = after;
			await yieldTurn();
		}
		return true;
	},
	async insert(tx, tables, sid, docs, signal) {
		for (const [index, { seq, part, text }] of docs.entries()) {
			signal?.throwIfAborted();
			await tx.run(
				`INSERT OR REPLACE INTO ${tables.fts} (rowid, body) VALUES ((? << 40) + (? << ${PART_BITS}) + ?, ?)`,
				sid,
				seq,
				part,
				withoutNul(text),
			);
			if (index + 1 < docs.length) await yieldTurn();
		}
		signal?.throwIfAborted();
	},
	async forget(tx, tables, sessionId) {
		await tx.run(
			`DELETE FROM ${tables.fts} WHERE rowid BETWEEN (SELECT sid << 40 FROM ${tables.state} WHERE session_id = ?) AND (SELECT (sid << 40) + 1099511627775 FROM ${tables.state} WHERE session_id = ?)`,
			sessionId,
			sessionId,
		);
	},
	async candidates(database, tables, sid, anyOf, fromSeq, toSeq, limit, signal) {
		signal?.throwIfAborted();
		const sets = normalizeSets(anyOf);
		if (sets.length === 0) return [];
		const seqs: number[] = [];
		if (sets.every((all) => all.length === 1)) {
			const query = sets.map((all) => `(${ftsLiteral(all[0]!)})`).join(" OR ");
			for (let from = fromSeq; from <= toSeq && seqs.length < limit; ) {
				signal?.throwIfAborted();
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
			signal?.throwIfAborted();
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

async function createTrigramIndex(tx: SqliteExecutor, dialect: StorageDialect, tables: SearchTables): Promise<void> {
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
}

async function trigramIndexExists(
	database: SqliteDatabase,
	dialect: StorageDialect,
	tables: SearchTables,
): Promise<boolean> {
	const found = await database.get(
		"SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname = current_schema() AND indexname = ?",
		dialect.identifier(tables.trigrams),
	);
	return found !== undefined;
}

const postgresTrigrams: TrigramEngine = {
	async create(tx, dialect, tables, sessionTables) {
		const { int, text } = dialect.types;
		await tx.exec(
			`CREATE TABLE IF NOT EXISTS ${tables.entries} (sid ${int} NOT NULL, seq ${int} NOT NULL, part ${int} NOT NULL, body ${text} NOT NULL, PRIMARY KEY (sid, seq, part))`,
		);
		await tx.exec(dialect.renderTrigger(forgetTrigger(tables, sessionTables, postgresTrigrams)));
		await createTrigramIndex(tx, dialect, tables);
	},
	forgetInTrigger(tables) {
		return `DELETE FROM ${tables.entries} WHERE sid IN (SELECT sid FROM ${tables.state} WHERE session_id = OLD.session_id)`;
	},
	async ready(database, dialect, tables) {
		if (await trigramIndexExists(database, dialect, tables)) return true;
		const creatable = await database.get<SqliteRow & { creatable: boolean | number }>(
			`SELECT ((EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_trgm')
				OR (EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'pg_trgm')
					AND (has_database_privilege(current_user, current_database(), 'CREATE')
						OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper))))
				AND pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')) AS creatable
			FROM pg_catalog.pg_class c
			WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ?`,
			dialect.identifier(tables.entries),
		);
		if (creatable?.creatable !== true && Number(creatable?.creatable) !== 1) return false;
		await database.transaction(
			(tx) => withShortSchemaLockWaits(tx, dialect, () => createTrigramIndex(tx, dialect, tables)),
			{ retryTransientFailures: true },
		);
		return trigramIndexExists(database, dialect, tables);
	},
	async prepareWrites() {},
	async merge() {
		return false;
	},
	async insert(tx, tables, sid, docs, signal) {
		for (let start = 0; start < docs.length; start += INSERT_ROWS_PER_STATEMENT) {
			signal?.throwIfAborted();
			const batch = docs.slice(start, start + INSERT_ROWS_PER_STATEMENT);
			await tx.run(
				`INSERT INTO ${tables.entries} (sid, seq, part, body) VALUES ${batch.map(() => "(?, ?, ?, ?)").join(", ")} ON CONFLICT (sid, seq, part) DO UPDATE SET body = excluded.body`,
				...batch.flatMap(({ seq, part, text }) => [sid, seq, part, foldForLike(text)]),
			);
			if (start + INSERT_ROWS_PER_STATEMENT < docs.length) await yieldTurn();
		}
	},
	async forget(tx, tables, sessionId) {
		const deleted = await tx.all<SqliteRow & { sid: number | bigint }>(
			`DELETE FROM ${tables.state} WHERE session_id = ? RETURNING sid`,
			sessionId,
		);
		for (const row of deleted) {
			await tx.run(`DELETE FROM ${tables.entries} WHERE sid = ?`, Number(row.sid));
		}
	},
	async candidates(database, tables, sid, anyOf, fromSeq, toSeq, limit, signal) {
		signal?.throwIfAborted();
		const sets = normalizeSets(anyOf);
		if (sets.length === 0) return [];
		const seqs: number[] = [];
		if (sets.every((all) => all.length === 1)) {
			const params: SqliteValue[] = [];
			const where = sets
				.map((all) => {
					const literal = all[0]!;
					params.push(likePattern(literal));
					return `${likeColumn(literal)} LIKE ? ESCAPE '\\'`;
				})
				.join(" OR ");
			for (let from = fromSeq; from <= toSeq && seqs.length < limit; from += SEQ_WINDOW) {
				signal?.throwIfAborted();
				const winTo = Math.min(toSeq, from + SEQ_WINDOW - 1);
				const rows = await database.all<SqliteRow & { seq: number | bigint }>(
					`SELECT DISTINCT seq FROM ${tables.entries} WHERE sid = ? AND seq >= ? AND seq <= ? AND (${where}) ORDER BY seq LIMIT ?`,
					sid,
					from,
					winTo,
					...params,
					limit - seqs.length,
				);
				for (const row of rows) seqs.push(Number(row.seq));
				if (winTo < toSeq && seqs.length < limit) await yieldTurn();
			}
			return seqs;
		}
		for (let from = fromSeq; from <= toSeq && seqs.length < limit; from += SEQ_WINDOW) {
			signal?.throwIfAborted();
			const winTo = Math.min(toSeq, from + SEQ_WINDOW - 1);
			const arms: string[] = [];
			const params: SqliteValue[] = [];
			for (const [setIndex, all] of sets.entries()) {
				for (const [litIndex, literal] of all.entries()) {
					arms.push(
						`SELECT seq, ${setIndex} AS set_id, ${litIndex} AS lit_id, ${all.length} AS need FROM ${tables.entries} WHERE sid = ? AND seq >= ? AND seq <= ? AND ${likeColumn(literal)} LIKE ? ESCAPE '\\'`,
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

function mergeCandidateSeqs(
	engineSeqs: readonly number[],
	wholeSeqs: readonly number[],
	limit: number,
): readonly number[] {
	if (wholeSeqs.length === 0) return engineSeqs;
	return [...new Set([...engineSeqs, ...wholeSeqs])].sort((a, b) => a - b).slice(0, limit);
}

export class SqlSessionSearchIndex implements SessionSearchIndex {
	private readonly database: SqliteDatabase;
	private readonly dialect: StorageDialect;
	private readonly sessionTables: SessionTables;
	private readonly tables: SearchTables;
	private readonly engine: TrigramEngine;
	private writesPrepared = false;

	private constructor(database: SqliteDatabase, sessionTables: SessionTables, tables: SearchTables) {
		this.database = database;
		this.dialect = dialectOf(database);
		this.sessionTables = sessionTables;
		this.tables = tables;
		this.engine = engineFor(this.dialect);
	}

	static async open(
		database: SqliteDatabase,
		sessionTables: SessionTables,
		prefix: string | undefined,
	): Promise<SqlSessionSearchIndex | undefined> {
		const tables = renderStorageIdentifiers("sessions", SESSION_SEARCH_TABLES, prefix);
		const engine = engineFor(dialectOf(database));
		try {
			if (await SqlSessionSearchIndex.tablesExist(database, tables))
				return new SqlSessionSearchIndex(database, sessionTables, tables);
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
			if (!(await engine.ready(database, dialectOf(database), tables))) return undefined;
		} catch {
			return undefined;
		}
		return new SqlSessionSearchIndex(database, sessionTables, tables);
	}

	private static async tablesExist(database: SqliteDatabase, tables: SearchTables): Promise<boolean> {
		const dialect = dialectOf(database);
		if (dialect.versionedMigrations) return false;
		const probes = [tables.state, tables.fts].map((table) => dialect.tableExists(table));
		const found = await Promise.all(probes.map((probe) => database.get(probe.sql, ...probe.params)));
		return found.every((row) => row !== undefined);
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
			`SELECT s.last_seq, s.revision AS session_revision, st.sid, st.format, st.indexed_seq, st.revision AS generation
			FROM ${this.sessionTables.sessions} s
			LEFT JOIN ${this.tables.state} st ON st.session_id = s.id
			WHERE s.id = ?`,
			sessionId,
		);
		if (!row) return undefined;
		const lastSeq = Number(row.last_seq);
		if (row.sid === null) {
			return withCoverageMeta({ indexedSeq: 0, lastSeq }, newGeneration(), row.session_revision);
		}
		const indexedSeq = Number(row.indexed_seq);
		const generation = row.generation ?? "";
		if (Number(row.format) === format && indexedSeq <= lastSeq && generation.startsWith("g:")) {
			return withCoverageMeta({ indexedSeq, lastSeq }, generation, row.session_revision);
		}
		await this.database.transaction((tx) => this.forget(tx, sessionId), { retryTransientFailures: true });
		return withCoverageMeta({ indexedSeq: 0, lastSeq }, newGeneration(), row.session_revision);
	}

	async extend(
		sessionId: string,
		format: number,
		afterSeq: number,
		throughSeq: number,
		texts: readonly SessionSearchText[],
		options?: SessionSearchExtendOptions,
	): Promise<boolean> {
		if (throughSeq >= SEQ_SPACE || throughSeq < afterSeq) return false;
		options?.signal?.throwIfAborted();
		const txOptions = { retryTransientFailures: true };
		const { docs, oversizedSeqs } = prepareDocs(texts);
		const totalChars = docs.reduce((sum, doc) => sum + doc.text.length, 0);
		if (totalChars <= BATCH_CHARS) {
			let backlog = false;
			const extended = await this.writeTransaction(async (tx) => {
				options?.signal?.throwIfAborted();
				const row = await tx.get<CoverageRow>(
					`SELECT s.last_seq, s.revision AS session_revision, st.sid, st.format, st.indexed_seq, st.revision AS generation, st.entry_id AS whole_seqs
					FROM ${this.sessionTables.sessions} s LEFT JOIN ${this.tables.state} st ON st.session_id = s.id
					WHERE s.id = ?`,
					sessionId,
				);
				if (!row || Number(row.last_seq) < throughSeq) return false;
				let sid: number;
				let activeGen: string;
				if (row.sid !== null) {
					if (Number(row.format) !== format || Number(row.indexed_seq) !== afterSeq) return false;
					if (options?.generation !== undefined && row.generation !== options.generation) return false;
					sid = Number(row.sid);
					activeGen = row.generation!;
				} else {
					if (afterSeq !== 0) return false;
					if (options?.revision !== undefined && row.session_revision !== options.revision) return false;
					activeGen = options?.generation ?? newGeneration();
					const created = await tx.get<SqliteRow & { sid: number | bigint }>(
						`INSERT INTO ${this.tables.state} (session_id, format, indexed_seq, revision, entry_id) VALUES (?, ?, 0, ?, '') RETURNING sid`,
						sessionId,
						format,
						activeGen,
					);
					sid = Number(created!.sid);
				}
				if (sid > MAX_SID) return false;
				if (docs.length > 0) {
					backlog = await this.engine.merge(tx, this.tables, MERGE_STEPS_PER_WRITE, options?.signal);
					await this.engine.insert(tx, this.tables, sid, docs, options?.signal);
				}
				const nextWhole = mergeWholeSeqs(row.whole_seqs, oversizedSeqs);
				const updated = await tx.run(
					`UPDATE ${this.tables.state} SET indexed_seq = ?, entry_id = ? WHERE sid = ? AND session_id = ? AND format = ? AND indexed_seq = ? AND revision = ?`,
					throughSeq,
					nextWhole,
					sid,
					sessionId,
					format,
					afterSeq,
					activeGen,
				);
				return updated.changes === 1;
			});
			if (extended && backlog) await this.mergeBacklog(options?.signal);
			return extended;
		}
		const started = await this.writeTransaction(async (tx) => {
			options?.signal?.throwIfAborted();
			const row = await tx.get<CoverageRow>(
				`SELECT s.last_seq, s.revision AS session_revision, st.sid, st.format, st.indexed_seq, st.revision AS generation, st.entry_id AS whole_seqs
				FROM ${this.sessionTables.sessions} s LEFT JOIN ${this.tables.state} st ON st.session_id = s.id
				WHERE s.id = ?`,
				sessionId,
			);
			if (!row || Number(row.last_seq) < throughSeq) return undefined;
			if (row.sid !== null) {
				if (Number(row.format) !== format || Number(row.indexed_seq) !== afterSeq) return undefined;
				if (options?.generation !== undefined && row.generation !== options.generation) return undefined;
				return { sid: Number(row.sid), generation: row.generation!, wholeSeqs: row.whole_seqs ?? "" };
			}
			if (afterSeq !== 0) return undefined;
			if (options?.revision !== undefined && row.session_revision !== options.revision) return undefined;
			const generation = options?.generation ?? newGeneration();
			const created = await tx.get<SqliteRow & { sid: number | bigint }>(
				`INSERT INTO ${this.tables.state} (session_id, format, indexed_seq, revision, entry_id) VALUES (?, ?, 0, ?, '') RETURNING sid`,
				sessionId,
				format,
				generation,
			);
			return { sid: Number(created!.sid), generation, wholeSeqs: "" };
		});
		if (started === undefined || started.sid > MAX_SID) return false;
		const { sid, generation: activeGen, wholeSeqs } = started;
		await yieldTurn();
		const lockAndCheck = async (tx: SqliteExecutor): Promise<boolean> => {
			options?.signal?.throwIfAborted();
			const locked = await tx.run(
				`UPDATE ${this.tables.state} SET indexed_seq = indexed_seq WHERE sid = ? AND session_id = ? AND format = ? AND indexed_seq = ? AND revision = ?`,
				sid,
				sessionId,
				format,
				afterSeq,
				activeGen,
			);
			return locked.changes === 1;
		};
		for (let start = 0; start < docs.length; ) {
			options?.signal?.throwIfAborted();
			let end = start + 1;
			for (
				let chars = docs[start]!.text.length;
				end < docs.length && chars + docs[end]!.text.length <= BATCH_CHARS;
				end++
			)
				chars += docs[end]!.text.length;
			const batch = docs.slice(start, end);
			let backlog = false;
			const written = await this.database.transaction(async (tx) => {
				if (!(await lockAndCheck(tx))) return false;
				backlog = await this.engine.merge(tx, this.tables, MERGE_STEPS_PER_WRITE, options?.signal);
				await this.engine.insert(tx, this.tables, sid, batch, options?.signal);
				return true;
			}, txOptions);
			if (!written) return false;
			if (backlog) await this.mergeBacklog(options?.signal);
			start = end;
			await yieldTurn();
		}
		options?.signal?.throwIfAborted();
		const nextWhole = mergeWholeSeqs(wholeSeqs, oversizedSeqs);
		return this.database.transaction(async (tx) => {
			options?.signal?.throwIfAborted();
			const session = await tx.get<SqliteRow & { last_seq: number | bigint }>(
				`SELECT last_seq FROM ${this.sessionTables.sessions} WHERE id = ?`,
				sessionId,
			);
			if (!session || Number(session.last_seq) < throughSeq) return false;
			const published = await tx.run(
				`UPDATE ${this.tables.state} SET indexed_seq = ?, entry_id = ? WHERE sid = ? AND session_id = ? AND format = ? AND indexed_seq = ? AND revision = ?`,
				throughSeq,
				nextWhole,
				sid,
				sessionId,
				format,
				afterSeq,
				activeGen,
			);
			return published.changes === 1;
		}, txOptions);
	}

	private async mergeBacklog(signal?: AbortSignal): Promise<void> {
		for (let write = 0; write < MAX_MERGE_BACKLOG_WRITES; write++) {
			await yieldTurn();
			const more = await this.database.transaction(
				(tx) => this.engine.merge(tx, this.tables, MERGE_STEPS_PER_WRITE, signal),
				{ retryTransientFailures: true },
			);
			if (!more) return;
		}
	}

	private async writeTransaction<T>(body: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
		let prepared = this.writesPrepared;
		const result = await this.database.transaction(
			async (tx) => {
				if (!this.writesPrepared) {
					await this.engine.prepareWrites(tx, this.dialect, this.tables, this.sessionTables);
					prepared = true;
				}
				return body(tx);
			},
			{ retryTransientFailures: true },
		);
		if (prepared) this.writesPrepared = true;
		return result;
	}

	async candidates(
		sessionId: string,
		anyOf: readonly (readonly string[])[],
		fromSeq: number,
		toSeq: number,
		limit: number,
		generation?: string,
		signal?: AbortSignal,
	): Promise<readonly number[] | undefined> {
		signal?.throwIfAborted();
		if (anyOf.length === 0 || fromSeq > toSeq) return [];
		const state = await this.database.get<
			SqliteRow & {
				sid: number | bigint;
				indexed_seq: number | bigint;
				generation: string;
				whole_seqs: string;
			}
		>(
			`SELECT sid, indexed_seq, revision AS generation, entry_id AS whole_seqs FROM ${this.tables.state} WHERE session_id = ?`,
			sessionId,
		);
		signal?.throwIfAborted();
		if (!state) return generation !== undefined ? undefined : [];
		const indexedSeq = Number(state.indexed_seq);
		if (generation !== undefined && (state.generation !== generation || indexedSeq < toSeq)) {
			return undefined;
		}
		const through = Math.min(toSeq, indexedSeq, SEQ_SPACE - 1);
		if (fromSeq > through) return [];
		const engineSeqs = await this.engine.candidates(
			this.database,
			this.tables,
			Number(state.sid),
			anyOf,
			fromSeq,
			through,
			limit,
			signal,
		);
		signal?.throwIfAborted();
		const wholeSeqs = parseWholeSeqs(state.whole_seqs).filter((seq) => seq >= fromSeq && seq <= through);
		return mergeCandidateSeqs(engineSeqs, wholeSeqs, limit);
	}
}
