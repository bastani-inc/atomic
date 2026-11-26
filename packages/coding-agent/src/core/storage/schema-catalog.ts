import type { SqliteDatabase, SqliteExecutor, SqliteRow } from "./database.js";
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
	 * What kind of object `name` was on SQLite and libSQL (`table`, `index`, `view` or `trigger`), from one read of
	 * `sqlite_schema`; undefined when there was none, and always on PostgreSQL.
	 */
	readonly sqliteObjectType?: (name: string) => string | undefined;
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
 * Every object of a SQLite or libSQL database and every column of its tables, generated ones included, in one
 * statement and so one snapshot: what `tableExists`, `columnExists` and `schemaObjects` ask one at a time (#6560).
 */
const SQLITE_CATALOG_SQL = `SELECT 'object' AS kind, name, type AS detail FROM sqlite_master
UNION ALL SELECT 'column', m.name, c.name FROM sqlite_master AS m JOIN pragma_table_xinfo(m.name) AS c
	WHERE m.type = 'table'`;

/**
 * @internal The table under `ledger`'s prefix where SQLite and libSQL record which revision of each store's schema
 * setup ran, and the database's schema version (`PRAGMA schema_version`) once it had: `domain`, `revision`,
 * `schema_version`. SQLite counts every change to the schema in that version, whoever makes it, an older Atomic that
 * records nothing included; a revision is believed only while the version still matches, so any later change is checked
 * again (#6560). Builds that do not know the table leave it alone.
 */
export function sqliteSchemaStampTable(ledger: string): string {
	return ledger.endsWith("atomic_migrations")
		? `${ledger.slice(0, -"atomic_migrations".length)}atomic_schema_stamps`
		: `${ledger}_schema_stamps`;
}

/** The key a store's setup is stamped under, as the PostgreSQL ledger records it. */
const stampKey = (domain: string) => `schema:${domain}`;

type StampRow = SqliteRow & { domain: string | null; revision: number | bigint | null; stamped: number | bigint };

/**
 * The revisions `ledger`'s stamps record whose schema version is the database's now, by stamp key, read in one
 * statement so the two agree. Stamps of an older schema version are left out: something changed the schema since.
 */
async function readSqliteSchemaStamps(executor: SqliteExecutor, ledger: string): Promise<Map<string, number>> {
	const rows = await executor.all<StampRow>(
		`SELECT domain, revision, schema_version AS stamped FROM ${sqliteSchemaStampTable(ledger)}
		UNION ALL SELECT NULL, NULL, schema_version FROM pragma_schema_version`,
	);
	const now = rows.find((row) => row.domain === null)?.stamped;
	const stamps = new Map<string, number>();
	for (const row of rows)
		if (row.domain !== null && now !== undefined && Number(row.stamped) === Number(now))
			stamps.set(row.domain, Number(row.revision ?? 0));
	return stamps;
}

/** @internal A store's schema setup, as its stamp records it: `ledger` names the prefix, `domain` the store. */
export interface SqliteSchemaStamp {
	readonly ledger: string;
	readonly domain: string;
	readonly revision: number;
}

/**
 * @internal Stamps each of `stamps`, in the transaction `tx` that ran their setups, with the schema version as that
 * transaction leaves it: a later open believes their revisions until the schema changes again (#6560). Creates the
 * stamps table first, so its own creation is part of the version recorded. SQLite and libSQL only; every stamp must
 * share a ledger.
 */
export async function recordSqliteSchemaStamps(
	tx: SqliteExecutor,
	stamps: readonly SqliteSchemaStamp[],
): Promise<void> {
	const ledger = stamps[0]?.ledger;
	if (ledger === undefined) return;
	const table = sqliteSchemaStampTable(ledger);
	await tx.exec(
		`CREATE TABLE IF NOT EXISTS ${table} (domain TEXT NOT NULL PRIMARY KEY, revision INTEGER NOT NULL, schema_version INTEGER NOT NULL)`,
	);
	// The revision this transaction set up, even below a newer build's: the stamp says what was checked at this version.
	for (const { domain, revision } of stamps)
		await tx.run(
			`INSERT INTO ${table} (domain, revision, schema_version) SELECT ?, ?, schema_version FROM pragma_schema_version WHERE true
			ON CONFLICT(domain) DO UPDATE SET revision = excluded.revision, schema_version = excluded.schema_version`,
			stampKey(domain),
			revision,
		);
}

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
		// SQLite records no versions: its stores' stamps are read on their own (`sqliteSchemaStampsOf`).
		recordedVersion: () => 0,
		hasTable: (table) => types.get(table) === "table",
		hasObject: (name) => types.has(name),
		hasColumn: (table, column) => columns.has(`${table}\0${column}`),
		sqliteObjectType: (name) => types.get(name),
	};
}

/**
 * Reads `database`'s schema and the versions `ledger` records, in two statements sent at once, without a transaction
 * or a lock. On SQLite and libSQL, which record no versions, reads the schema alone in one statement. Undefined when a
 * read fails: the stores then check each object themselves.
 */
export async function readStorageSchemaCatalog(
	database: SqliteDatabase,
	ledger: string,
): Promise<StorageSchemaCatalog | undefined> {
	const dialect = dialectOf(database);
	if (dialect.name === "sqlite") return readSqliteCatalog(database, ledger);
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
	/** Read when the scope starts on PostgreSQL, whose opens always ask it; on SQLite at the first question. */
	catalog: Promise<StorageSchemaCatalog | undefined> | undefined;
	readonly read: () => Promise<StorageSchemaCatalog | undefined>;
	users: number;
	/** The stamps valid when read, by stamp key, read at the first question: see {@link sqliteSchemaStampsOf}. */
	stamps: Promise<ReadonlyMap<string, number> | undefined> | undefined;
	/** The setups this open ran on SQLite, by domain, to stamp again at its end ({@link restampStorageSchemaAtOpenEnd}). */
	readonly restamp: Map<string, PendingRestamp>;
}

interface PendingRestamp {
	readonly stamp: SqliteSchemaStamp;
	readonly setup: (tx: SqliteExecutor) => Promise<unknown>;
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
		const catalog = dialectOf(database).name === "sqlite" ? undefined : read();
		scope = { ledger, catalog, read, users: 0, stamps: undefined, restamp: new Map() };
		scopes.set(database, scope);
	}
	const shared = scope;
	const handles = [database, ...views.filter((view) => !scopes.has(view))];
	for (const handle of handles.slice(1)) scopes.set(handle, shared);
	shared.users += 1;
	try {
		const value = await body();
		if (shared.users === 1 && shared.restamp.size > 0) await restamp(database, shared);
		return value;
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

/**
 * @internal The revisions the stamps under `ledger` record for the stores of `database` (SQLite and libSQL), by stamp
 * key (`schema:<domain>`), as the open of `database` in progress read them; only those whose schema version was the
 * database's then. Undefined outside such an open, and where none could be read, such as before any stamp. The first
 * question reads them, and the catalog with them where it was not read yet, so the two cost one wait: an open that asks
 * about stamps also asks about the catalog.
 */
export async function sqliteSchemaStampsOf(
	database: SqliteDatabase,
	ledger: string,
): Promise<ReadonlyMap<string, number> | undefined> {
	const scope = scopes.get(database);
	if (scope === undefined || scope.ledger !== ledger || dialectOf(database).name !== "sqlite") return undefined;
	if (scope.stamps === undefined) {
		scope.stamps = readSqliteSchemaStamps(database, ledger).then(
			(read) => read,
			() => undefined,
		);
		scope.catalog ??= scope.read();
	}
	return scope.stamps;
}

/**
 * @internal Tells the open of `database` in progress that it ran `setup`, the schema setup `stamp` names, in a
 * transaction that stamped it (SQLite and libSQL only). A schema change later in the same open, such as the next
 * store's setup, leaves that stamp behind the schema version, so the next open would check it again under the write
 * lock. The open's end reads the stamps once more and, where any it ran is behind, runs those setups again in one
 * transaction and stamps them all with the version it leaves: the next open of a current schema then takes no write
 * lock (#6560). Does nothing outside such an open.
 */
export function restampStorageSchemaAtOpenEnd(
	database: SqliteDatabase,
	stamp: SqliteSchemaStamp,
	setup: (tx: SqliteExecutor) => Promise<unknown>,
): void {
	const scope = scopes.get(database);
	if (scope === undefined || scope.ledger !== stamp.ledger || dialectOf(database).name !== "sqlite") return;
	scope.restamp.set(stamp.domain, { stamp, setup });
}

/**
 * Stamps again, in one transaction, the setups `scope`'s open ran whose stamps a later change of the schema left
 * behind; each runs again first, so its stamp vouches for what the transaction found. Housekeeping: a failure leaves
 * the stamps behind, and the next open checks those stores as it would without them.
 */
async function restamp(database: SqliteDatabase, scope: CatalogScope): Promise<void> {
	const pending = [...scope.restamp.values()];
	scope.restamp.clear();
	try {
		const current = await readSqliteSchemaStamps(database, scope.ledger);
		const behind = pending.filter(({ stamp }) => (current.get(stampKey(stamp.domain)) ?? 0) < stamp.revision);
		if (behind.length === 0) return;
		await database.transaction(
			async (tx) => {
				for (const { setup } of behind) await setup(tx);
				await recordSqliteSchemaStamps(
					tx,
					behind.map(({ stamp }) => stamp),
				);
			},
			{ retryTransientFailures: true, concurrency: { kind: "serial", domain: scope.ledger } },
		);
	} catch {
		// The next open checks them again.
	}
}
