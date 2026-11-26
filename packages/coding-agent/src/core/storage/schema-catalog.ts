import type { SqliteDatabase, SqliteRow } from "./database.js";
import { dialectOf } from "./dialect.js";

/**
 * What a schema held when one open read it: its relations, triggers and columns, and on PostgreSQL the versions its
 * ledger records. Only a positive answer is final: the schema only moves forward, so what existed then still exists,
 * while something missing may have been created since and is checked again under the store's lock.
 */
export interface StorageSchemaCatalog {
	/** The ledger the versions were read from. */
	readonly ledger: string;
	/** The highest version `ledger` recorded for `domain`; 0 when none, or when the ledger did not exist. */
	recordedVersion(domain: string): number;
	/** Whether a table (or view) named `table` existed. */
	hasTable(table: string): boolean;
	/** Whether a relation (table, index, sequence…) or a trigger named `name` existed. */
	hasObject(name: string): boolean;
	/** Whether `table` had a column named `column`. */
	hasColumn(table: string, column: string): boolean;
	/**
	 * Whether a function named `name` existed in the schema and this role may run it: PostgreSQL only, absent on SQLite
	 * and libSQL.
	 */
	readonly hasFunction?: (name: string) => boolean;
	/**
	 * What kind of object `name` was on SQLite and libSQL (`table`, `index`, `view` or `trigger`), from one read of
	 * `sqlite_schema`; undefined when there was none, and always on PostgreSQL.
	 */
	readonly sqliteObjectType?: (name: string) => string | undefined;
}

const TABLE_KINDS = new Set(["r", "p", "v", "m", "f"]);

/**
 * Every relation, trigger, column and function of the schema the statement runs in, in one statement and so one
 * snapshot. The catalog, not information_schema, finds relations, as `tableExists` does; columns come from
 * information_schema, as `columnExists` reads them. A function is listed with whether this role may execute it.
 */
const CATALOG_SQL = `SELECT 'relation' AS kind, c.relname::text AS name, c.relkind::text AS detail
	FROM pg_catalog.pg_class c WHERE c.relnamespace = current_schema()::regnamespace
UNION ALL SELECT 'trigger', t.tgname::text, NULL
	FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
	WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal
UNION ALL SELECT 'column', table_name::text, column_name::text
	FROM information_schema.columns WHERE table_schema = current_schema()
UNION ALL SELECT 'function', p.proname::text, CASE WHEN has_function_privilege(p.oid, 'EXECUTE') THEN 'executable' END
	FROM pg_catalog.pg_proc p WHERE p.pronamespace = current_schema()::regnamespace`;

type CatalogRow = SqliteRow & { kind: string; name: string; detail: string | null };

/**
 * Every object of a SQLite or libSQL database and every column of its tables, generated ones included, in one
 * statement and so one snapshot: what `tableExists`, `columnExists` and `schemaObjects` ask one at a time (#6560).
 */
const SQLITE_CATALOG_SQL = `SELECT 'object' AS kind, name, type AS detail FROM sqlite_master
UNION ALL SELECT 'column', m.name, c.name FROM sqlite_master AS m JOIN pragma_table_xinfo(m.name) AS c
	WHERE m.type = 'table'`;

/** The catalog of a SQLite or libSQL database, or undefined when it cannot be read, such as on a SQLite too old. */
async function readSqliteCatalog(database: SqliteDatabase, ledger: string): Promise<StorageSchemaCatalog | undefined> {
	let rows: CatalogRow[];
	try {
		rows = await database.all<CatalogRow>(SQLITE_CATALOG_SQL);
	} catch {
		return undefined;
	}
	const types = new Map<string, string>();
	const columns = new Set<string>();
	for (const row of rows) {
		if (row.kind === "column") columns.add(`${row.name}\0${row.detail}`);
		else types.set(row.name, String(row.detail));
	}
	return {
		ledger,
		// SQLite records no versions: its stores set their schemas up as before, checked against what exists.
		recordedVersion: () => 0,
		hasTable: (table) => types.get(table) === "table",
		hasObject: (name) => types.has(name),
		hasColumn: (table, column) => columns.has(`${table}\0${column}`),
		sqliteObjectType: (name) => types.get(name),
	};
}

type VersionRow = SqliteRow & { domain: string; version: number | string | null };

/** The tables, objects, columns and executable functions of PostgreSQL catalog rows (`CATALOG_SQL`'s). */
function catalogSets(rows: readonly CatalogRow[]) {
	const tables = new Set<string>();
	const objects = new Set<string>();
	const columns = new Set<string>();
	const functions = new Set<string>();
	for (const row of rows) {
		if (row.kind === "column") columns.add(`${row.name}\0${row.detail}`);
		else if (row.kind === "function") {
			if (row.detail === "executable") functions.add(row.name);
		} else {
			objects.add(row.name);
			if (row.kind === "relation" && TABLE_KINDS.has(String(row.detail))) tables.add(row.name);
		}
	}
	return { tables, objects, columns, functions };
}

/**
 * The catalog rows and the ledger's versions of `database`'s schema, read in one read-only transaction whose start
 * carries both reads, so they cost one round trip (#6560). The versions are undefined when the ledger did not exist;
 * the whole read is undefined when it failed.
 */
async function readPostgresCatalog(
	database: SqliteDatabase,
	ledger: string,
	physicalLedger: string,
): Promise<{ rows: CatalogRow[]; versions: VersionRow[] | undefined } | undefined> {
	const versionsSql = `SELECT domain, MAX(version) AS version FROM ${ledger} GROUP BY domain`;
	let read: { rows: CatalogRow[]; versions: VersionRow[] | undefined } | undefined;
	try {
		await database.transaction(
			async (tx) => {
				read = undefined;
				const rows = await tx.all<CatalogRow>(CATALOG_SQL);
				// Taken even where the ledger does not exist and its read failed, so the transaction ends with its commit,
				// sent at once, rather than with a rollback after it.
				const ledgerExists = catalogSets(rows).tables.has(physicalLedger);
				const versions = await tx.all<VersionRow>(versionsSql).catch((error: unknown) => {
					if (ledgerExists) throw error;
					return undefined;
				});
				read = { rows, versions };
			},
			{
				readOnly: true,
				retryTransientFailures: true,
				leading: [
					{ sql: CATALOG_SQL, params: [] },
					{ sql: versionsSql, params: [] },
				],
			},
		);
	} catch {
		return undefined;
	}
	return read;
}

/**
 * Reads `database`'s schema and the versions `ledger` records, in one read-only transaction that takes no lock. On
 * PostgreSQL, an adapter that read them when it opened gives them once (`takeOpenedCatalog`), and the first open reads
 * nothing (#6560). On SQLite and libSQL, which record no versions, reads the schema alone in one statement. Undefined
 * when a read fails: the stores then check each object themselves.
 */
export async function readStorageSchemaCatalog(
	database: SqliteDatabase,
	ledger: string,
): Promise<StorageSchemaCatalog | undefined> {
	const dialect = dialectOf(database);
	if (dialect.name === "sqlite") return readSqliteCatalog(database, ledger);
	if (!dialect.versionedMigrations || dialect.name !== "postgres") return undefined;
	const physicalLedger = dialect.identifier(ledger);
	const opened = database.takeOpenedCatalog?.();
	const read =
		opened !== undefined && opened.ledger === physicalLedger
			? {
					rows: opened.rows as readonly CatalogRow[],
					versions: opened.versions as readonly VersionRow[] | undefined,
				}
			: await readPostgresCatalog(database, ledger, physicalLedger);
	if (read === undefined) return undefined;
	const { tables, objects, columns, functions } = catalogSets(read.rows);
	const recorded = new Map<string, number>();
	if (tables.has(physicalLedger)) {
		if (read.versions === undefined) return undefined;
		for (const row of read.versions) recorded.set(row.domain, Number(row.version ?? 0));
	}
	return {
		ledger,
		recordedVersion: (domain) => recorded.get(domain) ?? 0,
		hasTable: (table) => tables.has(dialect.identifier(table)),
		hasObject: (name) => objects.has(dialect.identifier(name)),
		hasColumn: (table, column) => columns.has(`${dialect.identifier(table)}\0${column}`),
		hasFunction: (name) => functions.has(dialect.identifier(name)),
	};
}

interface CatalogScope {
	readonly ledger: string;
	/** Read when the scope starts on PostgreSQL, whose opens always ask it; on SQLite at the first question. */
	catalog: Promise<StorageSchemaCatalog | undefined> | undefined;
	readonly read: () => Promise<StorageSchemaCatalog | undefined>;
	users: number;
}

const scopes = new WeakMap<SqliteDatabase, CatalogScope>();

/**
 * Runs `body`, an open of one or more stores on `database`, with one catalog read for all of them: the schema checks
 * of the stores it opens ({@link schemaCatalogOf}) answer from it, so an open whose schema is current runs no schema
 * transaction and takes no lock. Opens on `database` that overlap share the read. `views` are other handles on the
 * same connection, such as a borrowed view, whose checks answer from the same read.
 */
export async function withStorageSchemaCatalog<T>(
	database: SqliteDatabase,
	ledger: string,
	body: () => Promise<T>,
	views: readonly SqliteDatabase[] = [],
): Promise<T> {
	let scope = scopes.get(database);
	if (scope === undefined || scope.ledger !== ledger) {
		const read = () => readStorageSchemaCatalog(database, ledger);
		scope = { ledger, catalog: dialectOf(database).name === "sqlite" ? undefined : read(), read, users: 0 };
		scopes.set(database, scope);
	}
	const shared = scope;
	const handles = [database, ...views.filter((view) => !scopes.has(view))];
	for (const handle of handles.slice(1)) scopes.set(handle, shared);
	shared.users += 1;
	try {
		return await body();
	} finally {
		shared.users -= 1;
		for (const handle of handles.slice(1)) if (scopes.get(handle) === shared) scopes.delete(handle);
		if (shared.users === 0 && scopes.get(database) === shared) scopes.delete(database);
	}
}

/**
 * The catalog an open of `database` in progress read ({@link withStorageSchemaCatalog}), when it read `ledger`'s
 * versions or no `ledger` is named; undefined outside such an open, and when it could not be read.
 */
export async function schemaCatalogOf(
	database: SqliteDatabase,
	ledger?: string,
): Promise<StorageSchemaCatalog | undefined> {
	const scope = scopes.get(database);
	if (scope === undefined || (ledger !== undefined && scope.ledger !== ledger)) return undefined;
	scope.catalog ??= scope.read();
	return scope.catalog;
}
