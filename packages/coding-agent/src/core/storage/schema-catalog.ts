import type { SqliteDatabase, SqliteExecutor, SqliteRow } from "./database.js";
import { dialectOf } from "./dialect.js";
import { StorageSchemaVersionError } from "./errors.js";
import type { SequencedStatement } from "./statement-sequence.js";
import * as statementSequence from "./statement-sequence.js";

/**
 * `transactionFinisher`, `sequenceRunner` and `statementBatch` of `statement-sequence.ts`, which the copies 0.10.3 and
 * 0.10.4 loaded lack: a process an in-place update caught keeps those copies, where a named import would fail to link.
 * Without `statementBatch`, 0.10.3's connection thread cannot run `{ script: true }` entries inside a sequence request,
 * so multi-statement scripts run via `tx.exec` instead.
 */
const finishers: Partial<Pick<typeof statementSequence, "transactionFinisher" | "sequenceRunner" | "statementBatch">> =
	statementSequence;

/** Minimal AsyncLocalStorage surface, resolved portably without a static `node:` import. */
interface AsyncScopeStore<T> {
	getStore(): T | undefined;
	run<R>(store: T, callback: () => R): R;
}

function createAsyncScopeStore<T>(): AsyncScopeStore<T> | undefined {
	const proc = (
		globalThis as {
			process?: { getBuiltinModule?: (id: string) => { AsyncLocalStorage?: new <V>() => AsyncScopeStore<V> } };
		}
	).process;
	const Ctor = proc?.getBuiltinModule?.("async_hooks")?.AsyncLocalStorage;
	return Ctor === undefined ? undefined : new Ctor<T>();
}

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
	 * Whether a function named `name` existed in the schema and this role may run it: PostgreSQL only, absent on SQLite.
	 */
	readonly hasFunction?: (name: string) => boolean;
	/**
	 * What kind of object `name` was on SQLite (`table`, `index`, `view` or `trigger`), from one read of
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
 * Every object of a SQLite database and every column of its tables, generated ones included, in one
 * statement and so one snapshot: what `tableExists`, `columnExists` and `schemaObjects` ask one at a time (#6560).
 */
const SQLITE_CATALOG_SQL = `SELECT 'object' AS kind, name, type AS detail FROM sqlite_master
UNION ALL SELECT 'column', m.name, c.name FROM sqlite_master AS m JOIN pragma_table_xinfo(m.name) AS c
	WHERE m.type = 'table'`;

/**
 * @internal The table under `ledger`'s prefix where SQLite record which revision of each store's schema
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

/** The SQLite statements that create (unless `tableExists`) and upsert `stamps` at the current `PRAGMA schema_version`. */
function sqliteStampStatements(
	stamps: readonly SqliteSchemaStamp[],
	tableExists: boolean,
): readonly SequencedStatement[] {
	const ledger = stamps[0]?.ledger;
	if (ledger === undefined) return [];
	const table = sqliteSchemaStampTable(ledger);
	const upsert: SequencedStatement = {
		sql: `INSERT INTO ${table} (domain, revision, schema_version)
		SELECT column1, column2, (SELECT schema_version FROM pragma_schema_version)
		FROM (VALUES ${stamps.map(() => "(?, ?)").join(", ")}) WHERE true
		ON CONFLICT(domain) DO UPDATE SET revision = excluded.revision, schema_version = excluded.schema_version`,
		params: stamps.flatMap(({ domain, revision }) => [stampKey(domain), revision]),
	};
	if (tableExists) return [upsert];
	return [
		{
			sql: `CREATE TABLE IF NOT EXISTS ${table} (domain TEXT NOT NULL PRIMARY KEY, revision INTEGER NOT NULL, schema_version INTEGER NOT NULL)`,
			params: [],
			script: true,
		},
		upsert,
	];
}

/**
 * @internal Stamps each of `stamps`, in the transaction `tx` that ran their setups, with the schema version as that
 * transaction leaves it: a later open believes their revisions until the schema changes again (#6560). Creates the
 * stamps table first, unless `options.tableExists`, so its own creation is part of the version recorded. With
 * `options.last`, the stamps are the transaction's last statements: where its connection is pipelined, they go out with
 * its commit. SQLite only; every stamp must share a ledger.
 */
export async function recordSqliteSchemaStamps(
	tx: SqliteExecutor,
	stamps: readonly SqliteSchemaStamp[],
	options: { readonly tableExists?: boolean; readonly last?: boolean } = {},
): Promise<void> {
	const statements = sqliteStampStatements(stamps, options.tableExists === true);
	if (statements.length === 0) return;
	const canSequence = finishers.statementBatch !== undefined || statements.every((each) => each.script !== true);
	if (options.last === true && canSequence && finishers.transactionFinisher?.(tx)?.(statements) === true) return;
	for (const statement of statements) {
		if (statement.script === true) await tx.exec(statement.sql);
		else await tx.run(statement.sql, ...statement.params);
	}
}

/** The catalog of a SQLite database, or undefined when it cannot be read, such as on a SQLite too old. */
async function readSqliteCatalog(database: SqliteExecutor, ledger: string): Promise<StorageSchemaCatalog | undefined> {
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
 * nothing (#6560). On SQLite, which record no versions, reads the schema alone in one statement. Undefined
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

/** @internal Context passed to a queued SQLite schema setup inside an open's single write transaction (#6709). */
export interface SqliteSchemaBatchContext {
	/** The write transaction executor. */
	readonly tx: SqliteExecutor;
	/** The live schema catalog read at the start of the write transaction, authoritative under the write lock. */
	readonly catalog: StorageSchemaCatalog | undefined;
	/**
	 * Queues a SQLite write statement or multi-statement SQL script to run in order inside the transaction. Consecutive
	 * queued writes go out together to the connection thread, and the final run goes out with `COMMIT`. When
	 * `options.ignoreError` returns true for a statement's failure, that error is ignored.
	 */
	enqueue(
		statement: string | SequencedStatement,
		options?: { readonly ignoreError?: (error: unknown) => boolean },
	): void;
	/** Executes any writes queued so far; call before issuing a read on `tx` that depends on them. */
	flushWrites(): Promise<void>;
	/** Notes that this transaction added `column` to `table`, so a later queued setup does not add it again. */
	noteColumnAdded(table: string, column: string): void;
	/** Whether `table` already has `column` in `catalog` or added earlier in this transaction. */
	hasColumn(table: string, column: string): boolean;
	/** Notes that this transaction created `table`. */
	noteTableCreated(table: string): void;
	/** Whether `table` was created earlier in this transaction. */
	createdTable(table: string): boolean;
	/** Whether `table` already existed in `catalog` before this transaction began. */
	tableExisted(table: string): boolean;
}

/** @internal A SQLite schema setup queued inside an open scope (`withStorageSchemaCatalog`) to run in one transaction. */
export interface SqliteSchemaBatchSetup {
	/** Stamp recorded for this setup once the batched transaction commits, when the store uses SQLite schema stamps. */
	readonly stamp?: SqliteSchemaStamp;
	/** Whether the schema already holds everything this setup creates (for DDL-only setups without row seeds). */
	readonly verify?: (catalog: StorageSchemaCatalog) => boolean;
	/**
	 * Checks outside any write lock whether another host completed this setup while we waited on `tryMaintenance`.
	 * Throwing (such as `StorageSchemaVersionError` for a newer build's database) immediately rejects the open.
	 */
	readonly done?: (
		catalog: StorageSchemaCatalog,
		stamps: ReadonlyMap<string, number> | undefined,
	) => boolean | Promise<boolean>;
	/** Reset any mutable per-attempt JS state before each transaction attempt or retry. */
	readonly reset?: () => void;
	/** Runs this setup inside the batched write transaction. */
	readonly run: (context: SqliteSchemaBatchContext) => Promise<void> | void;
	/**
	 * Optional setup (such as an FTS5 search index): if the transaction fails, the open retries with optional setups
	 * isolated in savepoints, calling `onFailure` instead of failing the open.
	 */
	readonly optional?: boolean;
	/** Called when an optional setup fails and its savepoint rolls back. */
	readonly onFailure?: () => void;
}

interface OpenBatch {
	readonly ledger: string;
	readonly setups: SqliteSchemaBatchSetup[];
	readonly restamp: Map<string, PendingRestamp>;
}

interface CatalogScope {
	readonly ledger: string;
	/** Read when the scope starts on PostgreSQL, whose opens always ask it; on SQLite at the first question. */
	catalog: Promise<StorageSchemaCatalog | undefined> | undefined;
	readonly read: () => Promise<StorageSchemaCatalog | undefined>;
	users: number;
	/** The stamps valid when read, by stamp key, read at the first question: see {@link sqliteSchemaStampsOf}. */
	stamps: Promise<ReadonlyMap<string, number> | undefined> | undefined;
	/** Fallback batch used only on runtimes lacking `AsyncLocalStorage`. */
	readonly fallbackBatch: OpenBatch;
}

interface PendingRestamp extends SchemaStampAtOpenEnd {
	readonly stamp: SqliteSchemaStamp;
	readonly setup: (tx: SqliteExecutor) => Promise<unknown>;
}

/** @internal How the end of an open stamps a store's setup: see {@link restampStorageSchemaAtOpenEnd}. */
export interface SchemaStampAtOpenEnd {
	/**
	 * Whether the store's schema, as the end's transaction reads the catalog, holds everything `setup` creates. Given,
	 * the end runs `setup` only where it does not; absent, it runs `setup` whenever the store's stamp is behind.
	 */
	readonly verify?: (catalog: StorageSchemaCatalog) => boolean;
	/**
	 * `setup` has not run in this open and must: the end runs it whatever the stamp, and a failure fails the open, as
	 * the setup's own transaction would have. For a setup whose objects all exist and whose only other statements seed
	 * rows nothing in the open reads, such as a counter's: it then shares the end's transaction instead of taking one.
	 */
	readonly deferred?: boolean;
	/**
	 * `setup` ran in this open, in a transaction that stamped nothing: it is stamped only when the end takes a transaction
	 * for another store, never in one of its own, so a new database's first open takes none.
	 */
	readonly alongside?: boolean;
}

const scopes = new WeakMap<SqliteDatabase, CatalogScope>();
/**
 * Tracks the root open batch active on each `CatalogScope` along the current async call chain: nested opens share their
 * enclosing root's batch and commit together at the root's end, while concurrent sibling opens on the same database
 * handle each own and commit their own batch before returning (#6709).
 */
const activeOpenBatches = createAsyncScopeStore<ReadonlyMap<CatalogScope, OpenBatch>>();

/** How long a SQLite open batch polls `done` after `tryMaintenance` finds the lock busy before joining the queue. */
const SQLITE_BATCH_WAIT_MS = 1_000;
const SQLITE_BATCH_POLL_MS = 20;
const SQLITE_BATCH_MAX_POLL_MS = 250;

const pausePoll = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms * (0.5 + Math.random() / 2)));

/**
 * Runs `body`, an open of one or more stores on `database`, with one catalog read for all of them: the schema checks
 * of the stores it opens ({@link schemaCatalogOf}) answer from it, so an open whose schema is current runs no schema
 * transaction and takes no lock. Opens on `database` that overlap share the read. On SQLite, setups queued inside the
 * open ({@link queueSqliteSchemaSetup}) run in one write transaction before the root open returns (#6709). `views` are
 * other handles on the same connection, such as a borrowed view, whose checks answer from the same read.
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
		scope = {
			ledger,
			catalog,
			read,
			users: 0,
			stamps: undefined,
			fallbackBatch: { ledger, setups: [], restamp: new Map() },
		};
		scopes.set(database, scope);
	}
	const shared = scope;
	const handles = [database, ...views.filter((view) => !scopes.has(view))];
	for (const handle of handles.slice(1)) scopes.set(handle, shared);
	shared.users += 1;
	const enclosing = activeOpenBatches?.getStore();
	const isRoot = activeOpenBatches === undefined ? shared.users === 1 : enclosing?.has(shared) !== true;
	const batch: OpenBatch =
		activeOpenBatches === undefined
			? shared.fallbackBatch
			: isRoot
				? { ledger, setups: [], restamp: new Map() }
				: enclosing!.get(shared)!;
	const run = async (): Promise<T> => {
		const value = await body();
		if (isRoot && (batch.setups.length > 0 || batch.restamp.size > 0)) await flushOpenBatch(database, shared, batch);
		return value;
	};
	try {
		if (!isRoot || activeOpenBatches === undefined) return await run();
		const next = new Map(enclosing);
		next.set(shared, batch);
		return await activeOpenBatches.run(next, run);
	} finally {
		shared.users -= 1;
		for (const handle of handles.slice(1)) if (scopes.get(handle) === shared) scopes.delete(handle);
		if (shared.users === 0 && scopes.get(database) === shared) scopes.delete(database);
	}
}

/**
 * Drops the catalog an open of `database` in progress read, so the next question reads the schema again: for a step of
 * the open that changed the schema the stores it opens after it ask about.
 */
export function refreshStorageSchemaCatalog(database: SqliteDatabase): void {
	const scope = scopes.get(database);
	if (scope !== undefined) {
		scope.catalog = undefined;
		scope.stamps = undefined;
	}
}

/**
 * Tells the catalog an open of `database` in progress read that the open created `tables` since, so the stores it
 * opens next find them without reading the schema again.
 */
export function noteStorageSchemaTables(database: SqliteDatabase, tables: readonly string[]): void {
	const scope = scopes.get(database);
	if (scope?.catalog === undefined) return;
	const identifier = dialectOf(database).identifier;
	const created = new Set(tables.map((table) => identifier(table)));
	scope.catalog = scope.catalog.then(
		(catalog) =>
			catalog && {
				...catalog,
				hasTable: (table) => created.has(identifier(table)) || catalog.hasTable(table),
				hasObject: (name) => created.has(identifier(name)) || catalog.hasObject(name),
			},
	);
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
 * @internal The revisions the stamps under `ledger` record for the stores of `database` (SQLite), by stamp
 * key (`schema:<domain>`), as the open of `database` in progress read them; only those whose schema version was the
 * database's then. Undefined outside such an open, and where none could be read, such as before any stamp. The first
 * question reads them after the open's catalog, and only where it holds their table.
 */
export async function sqliteSchemaStampsOf(
	database: SqliteDatabase,
	ledger: string,
): Promise<ReadonlyMap<string, number> | undefined> {
	const scope = scopes.get(database);
	if (scope === undefined || scope.ledger !== ledger || dialectOf(database).name !== "sqlite") return undefined;
	// Read once the catalog shows their table: a read of a missing table would fail, which costs a request, and makes a
	// driver may replace its connection.
	scope.stamps ??= schemaCatalogOf(database, ledger).then((catalog) =>
		catalog?.hasTable(sqliteSchemaStampTable(ledger)) === true
			? readSqliteSchemaStamps(database, ledger).then(
					(read) => read,
					() => undefined,
				)
			: undefined,
	);
	return scope.stamps;
}

/** Active root open batch for `database` on SQLite (matching `ledger` when given), or undefined outside one. */
function activeBatchFor(
	database: SqliteDatabase,
	ledger?: string,
): { readonly scope: CatalogScope; readonly batch: OpenBatch } | undefined {
	if (dialectOf(database).name !== "sqlite") return undefined;
	const scope = scopes.get(database);
	if (scope === undefined || (ledger !== undefined && scope.ledger !== ledger)) return undefined;
	const batch = activeOpenBatches === undefined ? scope.fallbackBatch : activeOpenBatches.getStore()?.get(scope);
	return batch === undefined ? undefined : { scope, batch };
}

/**
 * @internal Queues `setup` into the active SQLite open scope (`withStorageSchemaCatalog`) so that all needed setups of
 * the open execute in one write transaction before the open returns (#6709). Returns `false` outside a SQLite open
 * scope (or for a different `ledger`), in which case the caller runs `setup` immediately.
 */
export function queueSqliteSchemaSetup(
	database: SqliteDatabase,
	ledger: string | undefined,
	setup: SqliteSchemaBatchSetup,
): boolean {
	const active = activeBatchFor(database, ledger);
	if (active === undefined) return false;
	active.batch.setups.push(setup);
	return true;
}

/**
 * @internal Executes and commits any SQLite schema setups queued so far in the active open scope, before the open
 * needs their committed tables or evaluated outcomes (#6709). No-op when nothing is queued or outside a SQLite open.
 */
export async function flushStorageSchemaSetups(database: SqliteDatabase, ledger?: string): Promise<void> {
	const active = activeBatchFor(database, ledger);
	if (active === undefined) return;
	if (active.batch.setups.length === 0 && active.batch.restamp.size === 0) return;
	await flushOpenBatch(database, active.scope, active.batch);
}

/**
 * @internal Tells the open of `database` in progress that it checked `setup`, the schema setup `stamp` names, without
 * its stamp (SQLite only): it ran it in a transaction that stamped it, found every object it creates in the
 * catalog (with `verify`), or leaves it to the end (`deferred`). A schema change later in the same open, such as the
 * next store's setup or a column it adds, leaves a stamp behind the schema version, and a store found in the catalog has
 * none that is current, so the next open would check it again. The open's end checks or runs them in one transaction
 * and stamps them all with the version it leaves: the next open of a current schema then takes no write lock and answers
 * every such store from its stamp (#6560, #6709). False, and nothing is kept, outside such an open.
 */
export function restampStorageSchemaAtOpenEnd(
	database: SqliteDatabase,
	stamp: SqliteSchemaStamp,
	setup: (tx: SqliteExecutor) => Promise<unknown>,
	options: SchemaStampAtOpenEnd = {},
): boolean {
	const active = activeBatchFor(database, stamp.ledger);
	if (active === undefined) return false;
	active.batch.restamp.set(stamp.domain, { stamp, setup, ...options });
	return true;
}

interface QueuedBatchWrite {
	readonly statement: SequencedStatement;
	readonly ignoreError?: (error: unknown) => boolean;
}

/**
 * Sends `writes` on `tx`, piggybacking onto `COMMIT` when `last` is true and the connection supports it. Returns
 * `true` when sent via `transactionFinisher` (without per-statement `ignoreError` handling).
 */
async function sendBatchWrites(
	tx: SqliteExecutor,
	writes: readonly QueuedBatchWrite[],
	last: boolean,
): Promise<boolean> {
	if (writes.length === 0) return false;
	const statements = writes.map(({ statement }) => statement);
	const canSequence = finishers.statementBatch !== undefined || statements.every((each) => each.script !== true);
	if (last && canSequence && finishers.transactionFinisher?.(tx)?.(statements) === true) return true;
	const runSequence = canSequence ? finishers.sequenceRunner?.(tx) : undefined;
	if (runSequence !== undefined && writes.every(({ ignoreError }) => ignoreError === undefined)) {
		await runSequence({ statements });
		return false;
	}
	for (const { statement, ignoreError } of writes) {
		try {
			if (statement.script === true) await tx.exec(statement.sql);
			else await tx.run(statement.sql, ...statement.params);
		} catch (error) {
			if (ignoreError?.(error) !== true) throw error;
		}
	}
	return false;
}

/**
 * Checks outside any write lock whether another host completed every queued setup and restamp in this open batch.
 * Updates `scope.catalog` and `scope.stamps` when complete so later questions in the same open see the fresh schema.
 */
async function batchCompletedElsewhere(
	database: SqliteDatabase,
	scope: CatalogScope,
	setups: readonly SqliteSchemaBatchSetup[],
	restamps: readonly PendingRestamp[],
): Promise<boolean> {
	const catalog = await readSqliteCatalog(database, scope.ledger);
	if (catalog === undefined) return false;
	const stampTable = sqliteSchemaStampTable(scope.ledger);
	const needsStamps = setups.some((each) => each.stamp !== undefined) || restamps.length > 0;
	const stamps =
		needsStamps && catalog.hasTable(stampTable)
			? await readSqliteSchemaStamps(database, scope.ledger).catch(() => undefined)
			: undefined;
	for (const entry of setups) {
		if (entry.done !== undefined) {
			if (!(await entry.done(catalog, stamps))) return false;
			continue;
		}
		if (entry.stamp !== undefined) {
			if ((stamps?.get(stampKey(entry.stamp.domain)) ?? 0) < entry.stamp.revision) return false;
			continue;
		}
		if (entry.verify !== undefined) {
			if (!entry.verify(catalog)) return false;
			continue;
		}
		return false;
	}
	for (const entry of restamps) {
		if (entry.alongside === true && setups.length === 0) continue;
		if ((stamps?.get(stampKey(entry.stamp.domain)) ?? 0) < entry.stamp.revision) return false;
	}
	scope.catalog = Promise.resolve(catalog);
	scope.stamps = stamps === undefined ? undefined : Promise.resolve(stamps);
	return true;
}

/**
 * Runs every queued setup and restamp of `batch` in ONE SQLite write transaction through `tryMaintenance`, polling
 * `batchCompletedElsewhere` when another host holds the lock and falling back to a normal serial transaction after
 * {@link SQLITE_BATCH_WAIT_MS} (#6709).
 */
async function flushOpenBatch(database: SqliteDatabase, scope: CatalogScope, batch: OpenBatch): Promise<void> {
	const setups = batch.setups.splice(0);
	const pendingRestamps = [...batch.restamp.values()];
	batch.restamp.clear();
	if (setups.length === 0 && pendingRestamps.every((each) => each.alongside === true)) return;
	const required = setups.length > 0 || pendingRestamps.some((each) => each.deferred === true);
	const hasOptional = setups.some((each) => each.optional === true);
	const stampTable = sqliteSchemaStampTable(scope.ledger);

	let ignoreErrorPredicates: ((error: unknown) => boolean)[] = [];
	let usedFinisher = false;
	const runTransaction = async (tx: SqliteExecutor, isolateOptional: boolean): Promise<void> => {
		ignoreErrorPredicates = [];
		usedFinisher = false;
		for (const entry of setups) entry.reset?.();
		const catalog = await readSqliteCatalog(tx, scope.ledger);
		const writes: QueuedBatchWrite[] = [];
		const addedColumns = new Set<string>();
		const createdTables = new Set<string>();
		const flushWrites = async (): Promise<void> => {
			if (writes.length === 0) return;
			const batchWrites = writes.splice(0);
			await sendBatchWrites(tx, batchWrites, false);
		};
		const context: SqliteSchemaBatchContext = {
			tx,
			catalog,
			enqueue(statement, options) {
				const sequenced: SequencedStatement =
					typeof statement === "string" ? { sql: statement, params: [], script: true } : statement;
				if (options?.ignoreError !== undefined) ignoreErrorPredicates.push(options.ignoreError);
				writes.push({
					statement: sequenced,
					...(options?.ignoreError === undefined ? {} : { ignoreError: options.ignoreError }),
				});
			},
			flushWrites,
			noteColumnAdded(table, column) {
				addedColumns.add(`${table}\0${column}`);
			},
			hasColumn(table, column) {
				return catalog?.hasColumn(table, column) === true || addedColumns.has(`${table}\0${column}`);
			},
			noteTableCreated(table) {
				createdTables.add(table);
			},
			createdTable(table) {
				return createdTables.has(table);
			},
			tableExisted(table) {
				return catalog?.hasTable(table) === true;
			},
		};

		for (const entry of setups) {
			if (!isolateOptional || entry.optional !== true) {
				await entry.run(context);
				continue;
			}
			await flushWrites();
			await tx.exec("SAVEPOINT atomic_optional_schema_setup");
			try {
				await entry.run(context);
				await flushWrites();
			} catch {
				writes.length = 0;
				await tx.exec("ROLLBACK TO SAVEPOINT atomic_optional_schema_setup");
				entry.onFailure?.();
			}
			await tx.exec("RELEASE SAVEPOINT atomic_optional_schema_setup");
		}

		for (const { setup, verify, deferred } of pendingRestamps) {
			if (deferred === true || verify === undefined || catalog === undefined || !verify(catalog)) {
				await flushWrites();
				await setup(tx);
			}
		}

		// Collect stamps for every stamped setup and restamp in this batch (deduplicated by domain, keeping highest revision).
		const stampByDomain = new Map<string, SqliteSchemaStamp>();
		for (const entry of setups) {
			if (entry.stamp === undefined) continue;
			const prev = stampByDomain.get(entry.stamp.domain);
			if (prev === undefined || entry.stamp.revision > prev.revision)
				stampByDomain.set(entry.stamp.domain, entry.stamp);
		}
		for (const entry of pendingRestamps) {
			const prev = stampByDomain.get(entry.stamp.domain);
			if (prev === undefined || entry.stamp.revision > prev.revision)
				stampByDomain.set(entry.stamp.domain, entry.stamp);
		}
		if (stampByDomain.size > 0) {
			const stampStmts = sqliteStampStatements([...stampByDomain.values()], catalog?.hasTable(stampTable) === true);
			for (const statement of stampStmts) writes.push({ statement });
		}

		usedFinisher = await sendBatchWrites(tx, writes.splice(0), !isolateOptional);
	};

	const executeOnce = async (isolateOptional: boolean): Promise<void> => {
		const waiting = () =>
			database.transaction((tx) => runTransaction(tx, isolateOptional), {
				retryTransientFailures: true,
				concurrency: { kind: "serial", domain: scope.ledger },
			});
		const tryMaintenance = database.tryMaintenance?.bind(database);
		if (tryMaintenance === undefined) {
			await waiting();
			scope.catalog = undefined;
			scope.stamps = undefined;
			return;
		}
		const deadline = performance.now() + SQLITE_BATCH_WAIT_MS;
		for (let wait = SQLITE_BATCH_POLL_MS; ; wait = Math.min(wait * 2, SQLITE_BATCH_MAX_POLL_MS)) {
			const won = await tryMaintenance((tx) => runTransaction(tx, isolateOptional));
			if (won) {
				scope.catalog = undefined;
				scope.stamps = undefined;
				return;
			}
			if (performance.now() >= deadline) {
				await waiting();
				scope.catalog = undefined;
				scope.stamps = undefined;
				return;
			}
			await pausePoll(wait);
			if (await batchCompletedElsewhere(database, scope, setups, pendingRestamps)) return;
		}
	};

	try {
		// Pure restamp housekeeping (no queued setups, no deferred seeds): check current stamps first if any entry lacks
		// `verify`, sparing an open that changed nothing since its setups a write transaction.
		if (setups.length === 0 && !required && pendingRestamps.some((each) => each.verify === undefined)) {
			const current = await readSqliteSchemaStamps(database, scope.ledger).catch(() => new Map<string, number>());
			const behind = pendingRestamps.filter(
				({ stamp }) => (current.get(stampKey(stamp.domain)) ?? 0) < stamp.revision,
			);
			if (behind.length === 0) return;
		}
		await executeOnce(false);
	} catch (error) {
		const retryIgnored = usedFinisher && ignoreErrorPredicates.some((match) => match(error));
		if ((hasOptional || retryIgnored) && !(error instanceof StorageSchemaVersionError)) {
			try {
				await executeOnce(true);
				return;
			} catch (retryError) {
				if (required) throw retryError;
				return;
			}
		}
		if (required) throw error;
		// Pure housekeeping restamp failure: the next open checks those stores again.
	}
}
