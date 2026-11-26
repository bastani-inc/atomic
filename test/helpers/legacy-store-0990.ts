/**
 * A store as Atomic 0.9.90 left it, the last release with workflows: replayed from the SQL that release's stores wrote
 * (`test/fixtures/store-0.9.90`). Later releases never open the workflow tables in it (`wf_*`), so tests seed them here
 * instead of through a workflow store, and check that nothing changes them.
 *
 * - `seedLegacyStore(database, { contents: "full" })` recreates the whole 0.9.90 database: sessions, the snapshot
 *   index, Intercom and the workflow tables, with one session, one internal workflow-stage session, and one paused run
 *   whose checkpoint references two snapshot blobs ({@link LEGACY_STORE}).
 * - `seedLegacyWorkflowTables(database)` recreates only the workflow tables, their own indexes and triggers, and their
 *   schema rows (versions and migration ledger entries): no run, and not the snapshot index's triggers on them, which a
 *   later release's snapshot store installs itself when it finds the tables.
 *
 * Both take a storage `prefix`, as 0.9.90 would have named the tables under it (on PostgreSQL through
 * `postgresDialect.identifier`), and do nothing when the database already holds the workflow tables. The full store
 * expects a database without Atomic's tables under the prefix; the workflow schema goes beside any. SQLite gets the
 * SQLite dialect's statements, PostgreSQL its own, in the schema the connection selects.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf, postgresDialect } from "../../packages/coding-agent/src/core/storage/dialect.js";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "store-0.9.90");

/** What the full 0.9.90 store holds. */
export const LEGACY_STORE = Object.freeze({
	runId: "legacy-run-1",
	sessionId: "legacy-session-1",
	stageSessionId: "legacy-stage-session",
	/** Blobs the run's checkpoint references (its patch and its bundle): a collection keeps them while it is paused. */
	runBlobs: Object.freeze([
		"3254f7ba750c24f9188363dcf05df7f3067d74f8a0b82f26a3b34669fcfc032b",
		"bd4bdfed482f4b0642c2529f61e4703fec533c93d3d9826a3b9f99540aed0856",
	]),
	/** The blob the session's snapshot entry references. */
	sessionBlob: "cc4bc80df52ef1f22d5a81e65554a62484abf6e1bc51bf16e60121b660c3222d",
} as const);

export type LegacyStoreContents = "full" | "workflow-schema" | "run-schema";

export interface LegacyStoreOptions {
	readonly prefix?: string;
	readonly contents?: LegacyStoreContents;
}

interface Statement {
	/** The object the statement creates, or the table it fills. */
	readonly object: string;
	/** The table the object belongs to: itself for a table. */
	readonly table: string;
	readonly kind: "table" | "index" | "trigger" | "function" | "sequence" | "constraint" | "rows" | "other";
	readonly sql: string;
}

/** Ledger domains of the workflow stores, in the shared `atomic_migrations` table. */
const WORKFLOW_LEDGER_DOMAINS = [
	"schema:fleet",
	"schema:pool-queue",
	"schema:pool-ship",
	"schema:pool-usage",
	"schema:rate-buckets",
	"schema:resource-admission",
	"schema:shared-pool",
];

/** Text that names one of the snapshot index's own tables, which only its triggers on workflow tables write. */
const MAIN_SNAPSHOT_INDEX = /(?<![A-Za-z0-9_])snapshot_(?:run_refs|run_state|carried_refs)\b/;

let sqliteStatements: Statement[] | undefined;
let postgresStatements: Statement[] | undefined;

function sqliteFixture(): Statement[] {
	sqliteStatements ??= readFileSync(join(FIXTURE, "sqlite.sql"), "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((sql): Statement => {
			const created =
				/^CREATE (?:VIRTUAL )?(TABLE|INDEX|UNIQUE INDEX|TRIGGER|VIEW) (?:IF NOT EXISTS )?'?([A-Za-z0-9_]+)'?/.exec(
					sql,
				);
			if (created !== null) {
				const kind = created[1] === "TABLE" ? "table" : created[1] === "TRIGGER" ? "trigger" : "index";
				const table = kind === "table" ? created[2]! : (/ ON '?([A-Za-z0-9_]+)'?/.exec(sql)?.[1] ?? created[2]!);
				return { object: created[2]!, table, kind, sql };
			}
			// A full-text table's shadow tables refuse writes from SQL; creating the table recreates its (empty) index.
			const inserted = /^INSERT INTO ([A-Za-z0-9_]+)/.exec(sql);
			if (inserted !== null) return { object: inserted[1]!, table: inserted[1]!, kind: "rows", sql };
			return { object: "", table: "", kind: "other", sql };
		});
	return sqliteStatements;
}

const PG_KINDS: Record<string, Statement["kind"]> = {
	TABLE: "table",
	INDEX: "index",
	TRIGGER: "trigger",
	FUNCTION: "function",
	SEQUENCE: "sequence",
	"SEQUENCE SET": "sequence",
	CONSTRAINT: "constraint",
	"FK CONSTRAINT": "constraint",
	"TABLE DATA": "rows",
};

function postgresFixture(): Statement[] {
	if (postgresStatements !== undefined) return postgresStatements;
	const text = readFileSync(join(FIXTURE, "postgres.sql"), "utf8");
	const statements: Statement[] = [];
	for (const block of text.split(/^--\n-- (?=Name: |Data for Name: )/m).slice(1)) {
		const header = /^(?:Data for )?Name: ([^;]+); Type: ([^;]+);/.exec(block);
		if (header === null) continue;
		const kind = PG_KINDS[header[2]!];
		if (kind === undefined) continue;
		const names = header[1]!.replace(/\(\)$/, "").split(" ");
		const object = names.at(-1)!;
		// Constraints and triggers are named "<table> <name>"; an index or function names only itself.
		const table = names.length > 1 ? names[0]! : kind === "index" ? indexTable(block) : object;
		const sql = block
			.split("\n")
			.slice(1)
			.filter((line) => !line.startsWith("--") && !line.startsWith("\\"))
			.join("\n")
			.replace(/\batomic\.(?=[A-Za-z_"])/g, "")
			.trim();
		if (sql.length > 0) statements.push({ object, table, kind, sql });
	}
	postgresStatements = statements;
	return statements;
}

function indexTable(block: string): string {
	return /\bON (?:ONLY )?(?:atomic\.)?([A-Za-z0-9_]+)/.exec(block)?.[1] ?? "";
}

/**
 * The statements of the full store that `seedLegacyWorkflowTables` replays: the workflow tables and what belongs to
 * them, their schema rows, and the shared migration ledger when `ledger` is missing, but not the snapshot index's
 * triggers on workflow tables, nor their functions: a later snapshot store installs its own.
 */
function workflowSchema(fixture: readonly Statement[], ledger: boolean): Statement[] {
	const indexWrites = (statement: Statement) =>
		(statement.kind === "trigger" || statement.kind === "function") && MAIN_SNAPSHOT_INDEX.test(statement.sql);
	const dropped = new Set(fixture.filter(indexWrites).map((statement) => statement.object));
	const workflowLedgerRows = (sql: string) => WORKFLOW_LEDGER_DOMAINS.some((domain) => sql.includes(`'${domain}'`));
	return fixture
		.filter((statement) => {
			if (statement.kind === "other") return false;
			if (statement.table === "atomic_migrations") {
				if (statement.kind !== "rows") return !ledger;
				return workflowLedgerRows(statement.sql);
			}
			if (!statement.table.startsWith("wf_") && !statement.object.startsWith("wf_")) return false;
			if (statement.kind === "rows") return /_meta$|atomic_migrations$|_index_sources$/.test(statement.table);
			if (dropped.has(statement.object)) return false;
			// A PostgreSQL trigger names the function it runs.
			return !(statement.kind === "trigger" && [...dropped].some((name) => statement.sql.includes(`${name}(`)));
		})
		.map((statement) =>
			// PostgreSQL's dump writes every domain's ledger rows in one statement, a row a line: keep the workflow domains'.
			statement.table === "atomic_migrations" && statement.kind === "rows"
				? { ...statement, sql: statement.sql.split("\n").filter(workflowLedgerRows).join("\n") }
				: statement,
		);
}

/**
 * The names 0.9.90 gave its tables and indexes under no prefix: the prefix of every other name it gave the server, and
 * the trigram indexes, which no table's name begins.
 */
function tableNames(statements: readonly Statement[]): string[] {
	return [...new Set(statements.filter((s) => s.kind === "table" || s.kind === "index").map((s) => s.object))].sort(
		(a, b) => b.length - a.length,
	);
}

/** `sql` with every name 0.9.90 gave under no prefix renamed as it names it under `prefix`. */
function withPrefix(sql: string, prefix: string, tables: readonly string[], postgres: boolean): string {
	if (prefix === "") return sql;
	return sql.replace(/(?<![A-Za-z0-9_$])[A-Za-z_][A-Za-z0-9_]*\b/g, (token) => {
		if (!tables.some((table) => token === table || token.startsWith(`${table}_`))) return token;
		return postgres ? postgresDialect.identifier(`${prefix}${token}`) : `${prefix}${token}`;
	});
}

async function trigramsAvailable(database: SqliteDatabase): Promise<boolean> {
	try {
		await database.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm");
	} catch {
		// A role that may not install it seeds the store without the trigram indexes.
	}
	return (
		(await database.get(
			"SELECT 1 AS present FROM pg_opclass o JOIN pg_namespace n ON n.oid = o.opcnamespace WHERE o.opcname = 'gin_trgm_ops' AND n.nspname = ANY(current_schemas(false))",
		)) !== undefined
	);
}

async function exists(database: SqliteDatabase, table: string): Promise<boolean> {
	const probe = dialectOf(database).tableExists(table);
	return (await database.get(probe.sql, ...probe.params)) !== undefined;
}

/** Recreates the 0.9.90 store, or its workflow schema alone, in `database`; nothing when its run table exists. */
export async function seedLegacyStore(database: SqliteDatabase, options: LegacyStoreOptions = {}): Promise<void> {
	const prefix = options.prefix ?? "";
	const postgres = dialectOf(database).name === "postgres";
	const fixture = postgres ? postgresFixture() : sqliteFixture();
	const tables = tableNames(fixture);
	const name = (table: string) => (postgres ? postgresDialect.identifier(`${prefix}${table}`) : `${prefix}${table}`);
	if (await exists(database, name("wf_runs"))) return;
	const statements =
		options.contents === "workflow-schema" || options.contents === "run-schema"
			? workflowSchema(fixture, !postgres || (await exists(database, name("atomic_migrations")))).filter(
					(statement) =>
						options.contents !== "run-schema" ||
						/^wf_(meta|runs|events|event_chunks|leases|lease_builds)$/.test(statement.table),
				)
			: fixture.filter((statement) => statement.kind !== "other");
	// 0.9.90 indexed session search with `pg_trgm` where it could install it, as a later release does.
	const trigrams = postgres && (await trigramsAvailable(database));
	await database.exec(
		statements
			.filter((statement) => !postgres || trigrams || !statement.sql.includes("gin_trgm_ops"))
			.map((statement) => withPrefix(statement.sql, prefix, tables, postgres))
			.join("\n"),
	);
}

/** Recreates only the 0.9.90 workflow tables under `prefix`, with their schema rows and no run. */
export function seedLegacyWorkflowTables(database: SqliteDatabase, options: { readonly prefix?: string } = {}) {
	return seedLegacyStore(database, { ...options, contents: "workflow-schema" });
}

/** Every name 0.9.90 gave a workflow table, index, trigger or trigger function on PostgreSQL, under no prefix. */
export const LEGACY_WORKFLOW_IDENTIFIER_SUFFIXES: readonly string[] = Object.freeze(
	[
		...new Set(
			postgresFixture()
				.filter(
					(s) =>
						(s.kind === "table" || s.kind === "index" || s.kind === "trigger" || s.kind === "function") &&
						s.object.startsWith("wf_"),
				)
				.map((s) => s.object),
		),
	].sort(),
);

const textOf = (value: unknown): string =>
	value instanceof Uint8Array ? `x'${Buffer.from(value).toString("hex")}'` : JSON.stringify(value);

/**
 * Every workflow table under `prefix` with its definition and rows, and every index and trigger on one, as text that
 * stays the same as long as none of them changes: compare it before and after a later release used the database.
 * Every column of every row is in it, the database's own row order included, so a row written again shows.
 */
export async function dumpLegacyWorkflowTables(
	database: SqliteDatabase,
	options: { readonly prefix?: string } = {},
): Promise<string> {
	const prefix = options.prefix ?? "";
	const postgres = dialectOf(database).name === "postgres";
	const like = `${prefix.replaceAll("_", "\\_")}wf\\_%`;
	const out: string[] = [];
	let tables: string[];
	if (postgres) {
		tables = (
			await database.all<SqliteRow & { name: string }>(
				"SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE ? ESCAPE '\\' ORDER BY table_name",
				like,
			)
		).map((row) => row.name);
		for (const table of tables) {
			const columns = await database.all<SqliteRow & { name: string; type: string }>(
				"SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position",
				table,
			);
			out.push(`table ${table}(${columns.map((column) => `${column.name} ${column.type}`).join(", ")})`);
		}
		const objects = await database.all<SqliteRow & { kind: string; name: string; definition: string }>(
			`SELECT 'index' AS kind, indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = current_schema() AND tablename LIKE ? ESCAPE '\\'
			UNION ALL SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
				WHERE NOT t.tgisinternal AND c.relnamespace = current_schema()::regnamespace AND c.relname LIKE ? ESCAPE '\\'
			ORDER BY 1, 2`,
			like,
			like,
		);
		// Definitions name their schema; the same tables moved to another schema keep the same definitions.
		const schema = (await database.get<SqliteRow & { schema: string }>("SELECT current_schema() AS schema"))!.schema;
		const unqualified = new RegExp(`\\b(?:public|atomic|${schema})\\.`, "g");
		for (const object of objects)
			out.push(`${object.kind} ${object.name}: ${object.definition.replace(unqualified, "")}`);
	} else {
		const objects = await database.all<SqliteRow & { type: string; name: string; sql: string | null }>(
			"SELECT type, name, sql FROM sqlite_master WHERE tbl_name LIKE ? ESCAPE '\\' ORDER BY type, name",
			like,
		);
		tables = objects.filter((object) => object.type === "table").map((object) => object.name);
		for (const object of objects) out.push(`${object.type} ${object.name}: ${object.sql ?? ""}`);
	}
	for (const table of tables) {
		const quoted = postgres ? `"${table}"` : `'${table}'`;
		const rows = (await database.all(`SELECT * FROM ${quoted}`)).map(
			(row) =>
				`${table}: ${Object.entries(row)
					.map(([key, value]) => `${key}=${textOf(value)}`)
					.join(" ")}`,
		);
		out.push(...rows.sort());
	}
	return `${out.join("\n")}\n`;
}
