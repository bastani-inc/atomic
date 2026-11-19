import type { SqliteDatabase, SqliteExecutor, SqliteRow } from "./database.js";
import { dialectOf } from "./dialect.js";
import { POSTGRES_STORAGE_IDENTIFIER_SUFFIXES } from "./prefix.js";

/** The schema the PostgreSQL adapter keeps Atomic's tables in by default (#5218). */
export const POSTGRES_ATOMIC_SCHEMA = "atomic";

/**
 * The schema version left in `public` for each version table a moved session store, or a moved workflow run journal or
 * worker pool of an earlier release, had there, so a process of an earlier release that still opens `public` refuses it
 * as newer than it knows (#4965, #5029) rather than writing to tables that are gone or creating empty ones beside the
 * moved ones (#5218).
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
	/** The tables left in `public` to fence earlier releases: version tables, and copies of Intercom's. */
	readonly fences: readonly string[];
	/** Another migration moved the tables first: this one moved nothing. */
	readonly skipped: boolean;
}

/**
 * What the comment of every fence table starts with, so a later move or check never takes one for Atomic's own, nor
 * the PostgreSQL adapter, which keeps the same text as `MOVED_FENCE_COMMENT`, for an earlier release's tables.
 */
const FENCE_COMMENT = "atomic-moved-fence:";
const MOVED_FENCE_FUNCTION = "atomic_moved_fence_fn";
const MOVED_FENCE_TRIGGER = "atomic_moved_fence";
const MOVED_MESSAGE = (schema: string) =>
	`Atomic moved its tables to schema ${schema}: this process runs an earlier Atomic or started before the move; upgrade or restart it (#5218)`;

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

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
	if (dialectOf(database).name !== "postgres") return { tables: [], functions: [], fences: [], skipped: false };
	return database.transaction(
		async (tx) => {
			await tx.get("SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked", `schema:${schema}`);
			// Another `atomic storage migrate` that held the lock first moved them: nothing is left to move (#5218).
			if ((await ledgersIn(tx, schema)).length > 0) return { tables: [], functions: [], fences: [], skipped: true };
			await tx.exec(`CREATE SCHEMA IF NOT EXISTS ${quoted(schema)}`);
			const tables = await atomicTablesIn(tx, "public");
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
				await markFence(tx, table, schema);
				fences.push(table);
			}
			// Intercom's stores read no version: a broker of an earlier release opening `public` would create them again,
			// empty, and route through them apart from every upgraded broker. A copy of each, with its columns and every
			// index under its own name, makes that broker's `CREATE … IF NOT EXISTS` change nothing, and its first write
			// fails with a statement trigger that asks for the upgrade.
			const intercom = tables.filter((table) => /intercom_[a-z_]+$/.test(table));
			if (intercom.length > 0)
				await tx.exec(`CREATE OR REPLACE FUNCTION public.${MOVED_FENCE_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $fence$
					BEGIN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = ${literal(MOVED_MESSAGE(schema))}; END $fence$`);
			for (const table of intercom) {
				await tx.exec(
					`CREATE TABLE public.${quoted(table)} (LIKE ${quoted(schema)}.${quoted(table)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
				);
				const indexes = await tx.all<SqliteRow & { definition: string }>(
					`SELECT pg_get_indexdef(i.indexrelid) AS definition FROM pg_catalog.pg_index i
						JOIN pg_catalog.pg_class c ON c.oid = i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
						WHERE n.nspname = ? AND c.relname = ?`,
					schema,
					table,
				);
				for (const { definition } of indexes)
					await tx.exec(
						String(definition)
							.replace(` ON ${quoted(schema)}.`, " ON public.")
							.replace(` ON ${schema}.`, " ON public."),
					);
				await tx.exec(
					`CREATE TRIGGER ${MOVED_FENCE_TRIGGER} BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.${quoted(table)} FOR EACH STATEMENT EXECUTE FUNCTION public.${MOVED_FENCE_FUNCTION}()`,
				);
				await markFence(tx, table, schema);
				fences.push(table);
			}
			return { tables, functions, fences, skipped: false };
		},
		{ concurrency: { kind: "serial" } },
	);
}

/**
 * Atomic's tables in `schema`, under any prefix, by the names Atomic gives them: the fences a move left are not among
 * them.
 */
async function atomicTablesIn(executor: SqliteExecutor, schema: string): Promise<string[]> {
	// Every suffix is lowercase letters and `_`, which a regular expression matches as they are.
	const pattern = `(${POSTGRES_STORAGE_IDENTIFIER_SUFFIXES.join("|")})$`;
	return (
		await executor.all<SqliteRow & { name: string }>(
			`SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = ? AND c.relkind IN ('r', 'p') AND c.relname ~ ?
				AND coalesce(obj_description(c.oid, 'pg_class'), '') NOT LIKE ? ORDER BY c.relname`,
			schema,
			pattern,
			`${FENCE_COMMENT}%`,
		)
	).map((row) => String(row.name));
}

/** The migration ledgers in `schema`, one per prefix: present once Atomic set the schema up. */
async function ledgersIn(executor: SqliteExecutor, schema: string): Promise<string[]> {
	return (
		await executor.all<SqliteRow & { name: string }>(
			`SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = ? AND c.relkind = 'r' AND c.relname ~ 'atomic_migrations$'`,
			schema,
		)
	).map((row) => String(row.name));
}

async function markFence(executor: SqliteExecutor, table: string, schema: string): Promise<void> {
	await executor.exec(
		`COMMENT ON TABLE public.${quoted(table)} IS ${literal(`${FENCE_COMMENT} ${MOVED_MESSAGE(schema)}`)}`,
	);
}

/**
 * Atomic's tables in `public` that are neither the fences a move left nor in use: ones a process created there after
 * the move to `schema`, such as one of an earlier release, or one that resolved `public` before the move. They hold
 * state the moved tables do not. Empty when `schema` holds no ledger: then `public` is still where the tables are.
 */
export async function strayPostgresStorageTables(
	database: SqliteDatabase,
	schema = POSTGRES_ATOMIC_SCHEMA,
): Promise<string[]> {
	if (dialectOf(database).name !== "postgres") return [];
	if ((await ledgersIn(database, schema)).length === 0) return [];
	return atomicTablesIn(database, "public");
}
