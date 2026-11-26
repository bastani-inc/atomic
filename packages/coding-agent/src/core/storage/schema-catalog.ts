import type { SqliteDatabase, SqliteRow } from "./database.js";
import { dialectOf } from "./dialect.js";

/**
 * What a PostgreSQL schema held when one open read it: its relations, triggers and columns, and the versions its
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
}

const TABLE_KINDS = new Set(["r", "p", "v", "m", "f"]);

/**
 * Every relation, trigger and column of the schema the statement runs in, in one statement and so one snapshot. The
 * catalog, not information_schema, finds relations, as `tableExists` does; columns come from information_schema, as
 * `columnExists` reads them.
 */
const CATALOG_SQL = `SELECT 'relation' AS kind, c.relname::text AS name, c.relkind::text AS detail
	FROM pg_catalog.pg_class c WHERE c.relnamespace = current_schema()::regnamespace
UNION ALL SELECT 'trigger', t.tgname::text, NULL
	FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
	WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal
UNION ALL SELECT 'column', table_name::text, column_name::text
	FROM information_schema.columns WHERE table_schema = current_schema()`;

type CatalogRow = SqliteRow & { kind: string; name: string; detail: string | null };

/**
 * Reads `database`'s schema and the versions `ledger` records, in two statements sent at once, without a transaction
 * or a lock. Undefined on a dialect without versioned migrations (SQLite), whose stores set their schemas up as before,
 * and when either read fails: the stores then check each object themselves.
 */
export async function readStorageSchemaCatalog(
	database: SqliteDatabase,
	ledger: string,
): Promise<StorageSchemaCatalog | undefined> {
	const dialect = dialectOf(database);
	if (!dialect.versionedMigrations || dialect.name !== "postgres") return undefined;
	const physicalLedger = dialect.identifier(ledger);
	const versions = database
		.all<SqliteRow & { domain: string; version: number | string | null }>(
			`SELECT domain, MAX(version) AS version FROM ${ledger} GROUP BY domain`,
		)
		.then(
			(rows) => rows,
			() => undefined,
		);
	let rows: CatalogRow[];
	try {
		rows = await database.all<CatalogRow>(CATALOG_SQL);
	} catch {
		return undefined;
	}
	const tables = new Set<string>();
	const objects = new Set<string>();
	const columns = new Set<string>();
	for (const row of rows) {
		if (row.kind === "column") columns.add(`${row.name}\0${row.detail}`);
		else {
			objects.add(row.name);
			if (row.kind === "relation" && TABLE_KINDS.has(String(row.detail))) tables.add(row.name);
		}
	}
	const recorded = new Map<string, number>();
	if (tables.has(physicalLedger)) {
		const read = await versions;
		if (read === undefined) return undefined;
		for (const row of read) recorded.set(row.domain, Number(row.version ?? 0));
	}
	return {
		ledger,
		recordedVersion: (domain) => recorded.get(domain) ?? 0,
		hasTable: (table) => tables.has(dialect.identifier(table)),
		hasObject: (name) => objects.has(dialect.identifier(name)),
		hasColumn: (table, column) => columns.has(`${dialect.identifier(table)}\0${column}`),
	};
}

interface CatalogScope {
	readonly ledger: string;
	readonly catalog: Promise<StorageSchemaCatalog | undefined>;
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
		scope = { ledger, catalog: readStorageSchemaCatalog(database, ledger), users: 0 };
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
	return scope.catalog;
}
