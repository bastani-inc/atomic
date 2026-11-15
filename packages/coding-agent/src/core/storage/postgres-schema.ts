import type { SqliteDatabase, SqliteRow } from "./database.js";
import { dialectOf } from "./dialect.js";
import { POSTGRES_STORAGE_IDENTIFIER_SUFFIXES } from "./prefix.js";

/** The schema the PostgreSQL adapter keeps Atomic's tables in by default (#5218). */
export const POSTGRES_ATOMIC_SCHEMA = "atomic";

/**
 * The schema version left in `public` for each version table a moved journal, session store or worker pool had there,
 * so a process of an earlier release that still opens `public` refuses it as newer than it knows (#4965, #5029) rather
 * than writing to tables that are gone or creating empty ones beside the moved ones (#5218).
 */
export const POSTGRES_MOVED_SCHEMA_VERSION = 1_000_000;

/** The version tables an earlier release checks before every write, each with the column it reads. */
const VERSION_TABLES: readonly { readonly suffix: string; readonly column: string }[] = [
	{ suffix: "wf_meta", column: "schema_version" },
	{ suffix: "session_meta", column: "schema_version" },
	{ suffix: "wf_ps_session_meta", column: "schema_version" },
	{ suffix: "wf_runs_pool_meta", column: "version" },
];

/** What {@link movePostgresStorageToSchema} moved. */
export interface PostgresSchemaMove {
	/** The tables moved, by their name in `public`. */
	readonly tables: readonly string[];
	/** The trigger functions moved with them. */
	readonly functions: readonly string[];
	/** The version tables left in `public` to fence earlier releases. */
	readonly fences: readonly string[];
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Moves every table Atomic created in `public`, under any prefix, with its indexes, constraints, identity sequences and
 * triggers, and the trigger functions those triggers call, into `schema`, in one transaction that holds the whole
 * database's lock (#5218). In the same transaction it leaves, for each version table it moved, one of the same name in
 * `public` holding {@link POSTGRES_MOVED_SCHEMA_VERSION}: a process of an earlier release that still uses `public`
 * refuses it at its next transaction or open, instead of writing to a stale copy. `database` must be open on a database
 * whose tables are in `public`, as the adapter opens one an earlier release set up, by a role that owns them.
 */
export async function movePostgresStorageToSchema(
	database: SqliteDatabase,
	schema = POSTGRES_ATOMIC_SCHEMA,
): Promise<PostgresSchemaMove> {
	if (dialectOf(database).name !== "postgres") return { tables: [], functions: [], fences: [] };
	// Every suffix is lowercase letters and `_`, which a regular expression matches as they are.
	const pattern = `(${POSTGRES_STORAGE_IDENTIFIER_SUFFIXES.join("|")})$`;
	return database.transaction(
		async (tx) => {
			await tx.get("SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked", `schema:${schema}`);
			await tx.exec(`CREATE SCHEMA IF NOT EXISTS ${quoted(schema)}`);
			const tables = (
				await tx.all<SqliteRow & { name: string }>(
					`SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
						WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname ~ ? ORDER BY c.relname`,
					pattern,
				)
			).map((row) => String(row.name));
			const functions = (
				await tx.all<SqliteRow & { name: string }>(
					`SELECT DISTINCT t.tgfoid::regprocedure::text AS name FROM pg_catalog.pg_trigger t
						JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
						JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
						WHERE n.nspname = 'public' AND p.pronamespace = n.oid AND NOT t.tgisinternal AND c.relname = ANY(?::text[])
						ORDER BY 1`,
					`{${tables.map((table) => `"${table}"`).join(",")}}`,
				)
			).map((row) => String(row.name));
			for (const table of tables) await tx.exec(`ALTER TABLE public.${quoted(table)} SET SCHEMA ${quoted(schema)}`);
			// A trigger function is found by the search_path when it runs, so it moves with its tables.
			for (const fn of functions) await tx.exec(`ALTER FUNCTION ${fn} SET SCHEMA ${quoted(schema)}`);
			const fences: string[] = [];
			for (const table of tables) {
				const fence = VERSION_TABLES.find(({ suffix }) => table.endsWith(suffix));
				if (fence === undefined) continue;
				await tx.exec(`CREATE TABLE public.${quoted(table)} (${fence.column} BIGINT NOT NULL)`);
				await tx.run(`INSERT INTO public.${quoted(table)} VALUES (?)`, POSTGRES_MOVED_SCHEMA_VERSION);
				await tx.exec(
					`COMMENT ON TABLE public.${quoted(table)} IS 'Atomic moved its tables to schema ${schema}: upgrade Atomic (#5218)'`,
				);
				fences.push(table);
			}
			return { tables, functions, fences };
		},
		{ concurrency: { kind: "serial" } },
	);
}
