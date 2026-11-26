import { refreshStorageSchemaCatalog } from "./added-exports-0-10-11.js";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteStatement, TransactionConcurrency } from "./database.js";
import { dialectOf, type StorageDialect } from "./dialect.js";
import { StorageConfigError, StorageSchemaVersionError } from "./errors.js";
import { fencedPath } from "./fenced-paths.js";
import { recordSqliteSchemaStamps, schemaCatalogOf, sqliteSchemaStampsOf } from "./schema-catalog.js";
import type { SequencedStatement } from "./statement-sequence.js";
import * as statementSequence from "./statement-sequence.js";

/**
 * `transactionFinisher` of `statement-sequence.ts`, which the copies 0.10.3 and 0.10.4 loaded lack: taken from the module
 * namespace, so this module links against them too. Without it a setup's last statements go out before its commit.
 */
const finishers: Partial<Pick<typeof statementSequence, "transactionFinisher">> = statementSequence;

/** One version of a domain's schema. */
export interface StorageMigrationStep {
	/** A positive integer; a domain's steps are listed in increasing order. */
	readonly version: number;
	/**
	 * Brings the schema from the previous version to this one. It may use only `transaction`: the runner may run the
	 * whole migration again after a transient failure. On a dialect without `versionedMigrations` (SQLite) every step
	 * runs each time, so its statements must be idempotent (`CREATE … IF NOT EXISTS`).
	 */
	up(transaction: SqliteExecutor, dialect: StorageDialect): Promise<void>;
}

export interface StorageMigrationOptions {
	/** The ledger table, already prefixed (`renderStorageIdentifiers`); default `atomic_migrations`. */
	readonly table?: string;
	/**
	 * A recorded version newer than the last step is accepted, and nothing runs, instead of refusing with
	 * `StorageSchemaVersionError`. Only for a domain whose later steps stay additive, so a build that knows fewer of
	 * them still reads and writes it correctly (#5065).
	 */
	readonly acceptNewer?: boolean;
}

export interface StorageMigrationResult {
	/** The versions this call ran, in order. */
	readonly applied: readonly number[];
	/** The domain's schema version after the call. */
	readonly version: number;
}

const DEFAULT_MIGRATION_TABLE = "atomic_migrations";

function checkSteps(steps: readonly StorageMigrationStep[]): void {
	let previous = 0;
	for (const step of steps) {
		if (!Number.isSafeInteger(step.version) || step.version <= previous)
			throw new StorageConfigError(
				"sdk",
				"steps",
				"versions-increasing",
				"Number migration steps 1, 2, 3, … in increasing order",
			);
		previous = step.version;
	}
}

/** Whether `table` exists, read from the catalog: no DDL, so a role without CREATE can ask (#5218). */
async function tableExists(executor: SqliteExecutor, dialect: StorageDialect, table: string): Promise<boolean> {
	const probe = dialect.tableExists(table);
	return (await executor.get(probe.sql, ...probe.params)) !== undefined;
}

/**
 * Refuses, before any DDL, a role that cannot use the schema the database runs in: the setup would fail with a bare
 * `3F000` or `42501` that names neither the grant nor the role (#5218). PostgreSQL only.
 */
async function assertSchemaUsage(executor: SqliteExecutor, dialect: StorageDialect): Promise<void> {
	if (dialect.name !== "postgres") return;
	refuseWithoutSchemaUsage(await executor.get<SchemaAccess>(SCHEMA_USAGE_SQL));
}

type SchemaAccess = SqliteRow & { schema: string; role: string; present: number; usage: number };

/** The schema the transaction runs in, whether it exists, and whether this role may use it: PostgreSQL only. */
const SCHEMA_USAGE_SQL = `SELECT s.name AS schema, current_user AS role, (n.oid IS NOT NULL)::int AS present,
			coalesce(has_schema_privilege(n.oid, 'USAGE'), false)::int AS usage
		FROM (SELECT trim(both '"' from split_part(current_setting('search_path'), ',', 1)) AS name) s
		LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = s.name`;

/** Throws for `access`, a row of {@link SCHEMA_USAGE_SQL}, where the schema exists and this role may not use it. */
function refuseWithoutSchemaUsage(access: SchemaAccess | undefined): void {
	if (access === undefined || Number(access.present) === 0 || Number(access.usage) === 1) return;
	throw new StorageConfigError(
		"sdk",
		"privileges",
		"missing-privilege",
		`Role "${access.role}" has no USAGE on schema ${access.schema}, so it can neither find Atomic's tables there nor create them. Grant it as the schema's owner: GRANT USAGE ON SCHEMA ${access.schema} TO "${access.role}"; and, for a runtime role, the table grants in "Set up the database" in docs/storage/postgres.md`,
	);
}

/** Creates the ledger `table` unless it exists, so a current schema runs no DDL (#5218). */
async function createLedger(
	executor: SqliteExecutor,
	dialect: StorageDialect,
	table: string,
	/** The transaction holds the prefix's setup lock, exclusive, already: a {@link setUpStorageOnce} try took it. */
	locked = false,
): Promise<void> {
	if (await tableExists(executor, dialect, table)) return;
	await assertSchemaUsage(executor, dialect);
	// Two stores that set up their schemas at once never race to create the ledger they share.
	if (dialect.name === "postgres" && !locked) {
		await executor.get("SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked", `${table}:schema`);
		if (await tableExists(executor, dialect, table)) return;
	}
	const { int, text } = dialect.types;
	await executor.exec(
		`CREATE TABLE IF NOT EXISTS ${table} (domain ${text} NOT NULL, version ${int} NOT NULL, applied_at ${int} NOT NULL, PRIMARY KEY (domain, version))${dialect.tableOptions}`,
	);
}

/** The highest version `table` records for `domain`, 0 when none or when the ledger does not exist yet. */
async function recordedVersion(
	executor: SqliteExecutor,
	dialect: StorageDialect,
	table: string,
	domain: string,
	/** The ledger is known to exist: it is not looked up first. */
	exists = false,
): Promise<number> {
	if (!exists && !(await tableExists(executor, dialect, table))) return 0;
	const row = await executor.get<SqliteRow & { version: number | null }>(...versionRead(table, domain));
	return Number(row?.version ?? 0);
}

async function applyVersioned(
	transaction: SqliteExecutor,
	dialect: StorageDialect,
	table: string,
	domain: string,
	steps: readonly StorageMigrationStep[],
	acceptNewer = false,
	/** The ledger is known to exist, as a catalog read before the transaction found it: it is read, not looked up. */
	ledgerExists = false,
	/** The transaction holds the setup's locks already: see {@link setUpStorageOnce}. */
	locked = false,
): Promise<StorageMigrationResult> {
	const current = ledgerExists
		? Number(
				(await transaction.get<SqliteRow & { version: number | null }>(...versionRead(table, domain)))?.version ??
					0,
			)
		: await recordedVersion(transaction, dialect, table, domain);
	const supported = steps.at(-1)?.version ?? 0;
	if (current > supported) {
		if (acceptNewer) return { applied: [], version: current };
		throw new StorageSchemaVersionError(domain, current, supported);
	}
	const applied: number[] = [];
	// Probed first: a current schema, whose ledger exists, runs no DDL (#5218).
	if (!ledgerExists) await createLedger(transaction, dialect, table, locked);
	// Each step's record goes out with the next step's first statement, on a connection that pipelines a transaction's
	// statements; a failed one fails the migration.
	const records: Promise<unknown>[] = [];
	for (const step of steps) {
		if (step.version <= current) continue;
		await step.up(transaction, dialect);
		const recorded = transaction.run(`INSERT INTO ${table} VALUES (?, ?, ${dialect.nowMs})`, domain, step.version);
		recorded.catch(() => {});
		records.push(recorded);
		applied.push(step.version);
	}
	await Promise.all(records);
	return { applied, version: Math.max(current, supported) };
}

/** The read of the highest version `table` records for `domain`, as arguments of `get`. */
function versionRead(table: string, domain: string): [string, string] {
	return [`SELECT MAX(version) AS version FROM ${table} WHERE domain = ?`, domain];
}

/**
 * Advances `domain`'s schema to the last of `steps`, or refuses. Runs in one `serial` transaction whose domain is the ledger
 * table's name, so concurrent migrators under one prefix run one after another and a failed step rolls back the
 * whole call. Where the dialect has `versionedMigrations` (Postgres), applied versions are recorded in `table`: only
 * missing steps run, and a recorded version newer than the last step is a `StorageSchemaVersionError`. On SQLite
 * nothing is recorded (schemas stay what older Atomic versions share) and every step runs, idempotently; the domain's
 * own version row stays authoritative there.
 */
export async function applyStorageMigrations(
	database: SqliteDatabase,
	domain: string,
	steps: readonly StorageMigrationStep[],
	options: StorageMigrationOptions = {},
): Promise<StorageMigrationResult> {
	checkSteps(steps);
	const dialect = dialectOf(database);
	const table = options.table ?? DEFAULT_MIGRATION_TABLE;
	const recorded = dialect.versionedMigrations ? await recordedInCatalog(database, table, domain) : undefined;
	const supported = steps.at(-1)?.version ?? 0;
	if (recorded !== undefined && recorded >= supported && supported > 0) {
		if (recorded > supported && !options.acceptNewer)
			throw new StorageSchemaVersionError(domain, recorded, supported);
		return { applied: [], version: recorded };
	}
	// One process sets a new database up while the others that open it at once wait for it to finish, without holding a
	// lock or a connection: the locks are those an earlier build's migration and setup take, so it waits for those too.
	if (dialect.name === "postgres" && supported > 0) {
		let ledgerExists = await ledgerInCatalog(database, table);
		return setUpStorageOnce(database, {
			// An earlier build migrates in a serial transaction of the ledger's domain: the database's lock and the domain's,
			// which this takes shared, so the domains migrate beside one another but never beside an earlier build's.
			get locks() {
				return [
					...setupLocks(table, domain, ledgerExists),
					{ scope: POSTGRES_DATABASE_LOCK_SCOPE, inSchema: true, shared: true },
					{ scope: table, inSchema: true, shared: true },
				];
			},
			done: async () => {
				const version = await recordedNow(database, table, domain, ledgerExists);
				ledgerExists ||= await ledgerInCatalog(database, table);
				if (version < supported) return undefined;
				if (version > supported && !options.acceptNewer)
					throw new StorageSchemaVersionError(domain, version, supported);
				return { applied: [], version };
			},
			get leading() {
				const [sql, key] = versionRead(table, domain);
				return ledgerExists ? [{ sql, params: [key] }] : [];
			},
			setup: (transaction, locked) =>
				applyVersioned(
					transaction,
					dialect,
					table,
					domain,
					steps,
					options.acceptNewer,
					locked && ledgerExists,
					locked,
				),
			concurrency: { kind: "serial", domain: table },
		});
	}
	return database.transaction(
		async (transaction) => {
			if (dialect.versionedMigrations)
				return applyVersioned(transaction, dialect, table, domain, steps, options.acceptNewer);
			for (const step of steps) await step.up(transaction, dialect);
			return { applied: steps.map((step) => step.version), version: steps.at(-1)?.version ?? 0 };
		},
		{ retryTransientFailures: true, concurrency: { kind: "serial", domain: table } },
	);
}

/**
 * The version `table` records for `domain` in the catalog an open in progress read, or undefined outside one: an open
 * that finds every step recorded neither locks nor runs a transaction, as the steps would change nothing (#6560).
 */
async function recordedInCatalog(database: SqliteDatabase, table: string, domain: string): Promise<number | undefined> {
	const catalog = await schemaCatalogOf(database, table);
	if (catalog === undefined || !catalog.hasTable(table)) return undefined;
	return catalog.recordedVersion(domain);
}

/**
 * The version `ledger` records for `domain` now, read without a lock or a transaction of its own; 0 where the ledger
 * does not exist. Where `ledgerExists`, one read of the ledger answers; otherwise, inside an open
 * (`withStorageSchemaCatalog`), the open's catalog is read again. Either way, once the version is found, the open's
 * catalog is read again at its next question, so the stores the open sets up next find what another process set up.
 */
async function recordedNow(
	database: SqliteDatabase,
	ledger: string,
	domain: string,
	ledgerExists: boolean,
): Promise<number> {
	if (ledgerExists) {
		const version = Number(
			(await database.get<SqliteRow & { version: number | null }>(...versionRead(ledger, domain)))?.version ?? 0,
		);
		if (version > 0) refreshStorageSchemaCatalog(database);
		return version;
	}
	refreshStorageSchemaCatalog(database);
	const catalog = await schemaCatalogOf(database, ledger);
	if (catalog !== undefined) return catalog.recordedVersion(domain);
	return recordedVersion(database, dialectOf(database), ledger, domain);
}

/** Whether the catalog of the open in progress on `database` holds `ledger`: once it does, it always will. */
async function ledgerInCatalog(database: SqliteDatabase, ledger: string): Promise<boolean> {
	return (await schemaCatalogOf(database, ledger))?.hasTable(ledger) === true;
}

/**
 * The advisory lock a serial transaction without a domain takes on PostgreSQL, and one with a domain takes shared: the
 * adapter's `DATABASE_LOCK_SCOPE`, named in the transaction's schema.
 */
const POSTGRES_DATABASE_LOCK_SCOPE = "atomic";

/**
 * How long a setup that another process holds the lock for waits, polling, before it waits for the lock itself: only a
 * holder that stalls keeps it that long on PostgreSQL, since setting a schema up takes a few round trips.
 */
const SETUP_WAIT_MS = 15_000;
/**
 * The same on a SQLite file, whose write lock a try also finds taken while other writers wait in its queue, as every
 * process's own writes do when many open at once: after this long it joins the queue, which hands the lock on in turn.
 */
const SQLITE_SETUP_WAIT_MS = 1_000;
/** The first pause between two polls of a setup that another process runs; each later one doubles, up to the last. */
const SETUP_POLL_MS = 20;
const SETUP_MAX_POLL_MS = 250;

/** @internal An advisory lock a {@link setUpStorageOnce} setup takes on PostgreSQL, without waiting for it. */
export interface StorageSetupLock {
	/** The lock's name. */
	readonly scope: string;
	/**
	 * The name is qualified by the transaction's schema, as the adapter names the locks of a serial transaction's domain
	 * (`<schema>:<scope>`, and `<scope>` alone in `public`): one that excludes such transactions, as an earlier build runs.
	 */
	readonly inSchema?: boolean;
	/** Taken shared, as a serial transaction with a domain takes the database's lock. */
	readonly shared?: boolean;
}

/** @internal A schema setup that {@link setUpStorageOnce} runs once among the processes that start it together. */
export interface StorageSetupOnce<T> {
	/**
	 * The advisory locks the setup holds on PostgreSQL: every lock a setup of the same objects by an earlier build takes,
	 * so the two never run at once.
	 */
	readonly locks: readonly StorageSetupLock[];
	/**
	 * On PostgreSQL, the reads the setup makes first, in this order, sent with the try's start: see the transaction
	 * option `leading`. Read, with `locks`, at each try.
	 */
	readonly leading?: readonly SqliteStatement[];
	/**
	 * Reads, without a lock or a transaction, whether the setup is done, such as by another process meanwhile: its answer
	 * then, or undefined while it is not. Asked only after a try found the lock held.
	 */
	readonly done: () => Promise<T | undefined>;
	/**
	 * The setup, in its transaction: it checks again, under the lock, what it would change, and changes only that.
	 * `locked` tells that the transaction holds `locks`, which it does not where it waited in the transaction
	 * `concurrency` names.
	 */
	readonly setup: (transaction: SqliteExecutor, locked: boolean) => Promise<T>;
	/** How the setup's transaction waits for the lock after polling for {@link SETUP_WAIT_MS}, as it did before. */
	readonly concurrency: TransactionConcurrency;
}

/** The schema the transaction runs in, as `<schema>:`, and empty in `public`: what the adapter prefixes its locks with. */
const SCHEMA_LOCK_PREFIX = `(SELECT CASE WHEN name = 'public' THEN '' ELSE name || ':' END
	FROM (SELECT trim(both '"' from split_part(current_setting('search_path'), ',', 1)) AS name) AS search)`;

/** One read that takes every one of `locks` it can without waiting, and tells whether it took them all. */
function tryLocksStatement(locks: readonly StorageSetupLock[]): SqliteStatement {
	const taken = locks.map(
		({ inSchema, shared }) =>
			`pg_try_advisory_xact_lock${shared === true ? "_shared" : ""}(hashtextextended(${inSchema === true ? `${SCHEMA_LOCK_PREFIX} || ` : ""}?, 0))`,
	);
	return { sql: `SELECT (${taken.join(" AND ")})::int AS won`, params: locks.map(({ scope }) => scope) };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms * (0.5 + Math.random() / 2)));

/**
 * @internal Runs `once.setup`, a schema setup, so that of the processes that start it at once, on a new database say,
 * one runs it and the others wait for it without queueing for its lock (#6560). The setup's transaction tries its locks
 * without waiting: an advisory lock on PostgreSQL (`once.locks`), the database's write lock on a SQLite file. A process
 * that finds them taken holds no lock and no connection while it waits: it polls `once.done`, with growing pauses,
 * until the setup is done, and tries again whenever it is not, so a holder that set up something else, or failed, or
 * died, leaves the setup to the next try. After {@link SETUP_WAIT_MS} ({@link SQLITE_SETUP_WAIT_MS} on SQLite) it
 * waits for the lock in the transaction `once.concurrency` names, as before. Where the database tries no lock without waiting, the setup runs in that
 * transaction at once.
 */
export async function setUpStorageOnce<T>(database: SqliteDatabase, once: StorageSetupOnce<T>): Promise<T> {
	const attempt = trySetup(database, once);
	const waiting = () =>
		database.transaction((transaction) => once.setup(transaction, false), {
			retryTransientFailures: true,
			concurrency: once.concurrency,
		});
	if (attempt === undefined) return waiting();
	const deadline =
		performance.now() + (dialectOf(database).name === "postgres" ? SETUP_WAIT_MS : SQLITE_SETUP_WAIT_MS);
	for (let wait = SETUP_POLL_MS; ; wait = Math.min(wait * 2, SETUP_MAX_POLL_MS)) {
		const tried = await attempt();
		if (tried.won) return tried.value as T;
		if (performance.now() >= deadline) return waiting();
		await pause(wait);
		const done = await once.done();
		if (done !== undefined) return done;
	}
}

/** One try at `once`'s setup that does not wait for its locks, or undefined where `database` cannot try one. */
function trySetup<T>(
	database: SqliteDatabase,
	once: StorageSetupOnce<T>,
): (() => Promise<{ readonly won: boolean; readonly value?: T }>) | undefined {
	if (dialectOf(database).name === "postgres") {
		// A fenced transaction takes no lock with its start: the try is its first statement, sent with that start.
		return () => {
			const lock = tryLocksStatement(once.locks);
			return database.transaction(
				async (transaction) => {
					const row = await transaction.get<SqliteRow & { won: number | boolean | null }>(
						lock.sql,
						...lock.params,
					);
					if (row?.won !== true && Number(row?.won) !== 1) return { won: false };
					return { won: true, value: await once.setup(transaction, true) };
				},
				{
					retryTransientFailures: true,
					concurrency: { kind: "fenced", audit: fencedPath("schema-setup") },
					leading: [lock, ...(once.leading ?? [])],
				},
			);
		};
	}
	const tryMaintenance = database.tryMaintenance?.bind(database);
	if (tryMaintenance === undefined) return undefined;
	return async () => {
		let value: T | undefined;
		const won = await tryMaintenance(async (transaction) => {
			value = await once.setup(transaction, false);
		});
		return won ? { won, value } : { won };
	};
}

/** One domain's migration for {@link applyStorageMigrationsTogether}: the arguments of {@link applyStorageMigrations}. */
export interface StorageDomainMigration {
	readonly domain: string;
	readonly steps: readonly StorageMigrationStep[];
	readonly options?: StorageMigrationOptions;
}

/**
 * Migrates each of `migrations` in order, as {@link applyStorageMigrations} would, and resolves with each one's result.
 * Where the dialect records no versions (SQLite), every step runs every time, so the domains share one transaction: one
 * turn of the write lock for all of them, and a failure rolls back all of them. Elsewhere each domain migrates in a
 * transaction of its own, as `applyStorageMigrations` runs it.
 */
export async function applyStorageMigrationsTogether(
	database: SqliteDatabase,
	migrations: readonly StorageDomainMigration[],
): Promise<StorageMigrationResult[]> {
	const dialect = dialectOf(database);
	if (dialect.versionedMigrations) {
		const results: StorageMigrationResult[] = [];
		for (const { domain, steps, options } of migrations)
			results.push(await applyStorageMigrations(database, domain, steps, options));
		return results;
	}
	for (const { steps } of migrations) checkSteps(steps);
	const table = migrations[0]?.options?.table ?? DEFAULT_MIGRATION_TABLE;
	return database.transaction(
		async (transaction) => {
			const results: StorageMigrationResult[] = [];
			for (const { steps } of migrations) {
				for (const step of steps) await step.up(transaction, dialect);
				results.push({ applied: steps.map((step) => step.version), version: steps.at(-1)?.version ?? 0 });
			}
			return results;
		},
		{ retryTransientFailures: true, concurrency: { kind: "serial", domain: table } },
	);
}

/** How long one schema setup statement waits for a table lock before the setup backs off and tries again (#5218). */
export const SCHEMA_SETUP_LOCK_WAIT_MS = 1_000;
/** How many times a schema setup runs before a lock it keeps waiting for fails it. */
const SCHEMA_SETUP_ATTEMPTS = 8;
/** The first pause between attempts; each later one doubles, up to {@link SCHEMA_SETUP_MAX_BACKOFF_MS}. */
const SCHEMA_SETUP_BACKOFF_MS = 100;
const SCHEMA_SETUP_MAX_BACKOFF_MS = 2_000;

/** Whether `error`, or what caused it, is PostgreSQL's lock timeout (SQLSTATE `55P03`). */
function isLockTimeout(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
		const code = (current as { code?: unknown }).code;
		if (code === "55P03" || code === "lock-conflict") return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * Runs `setup`, DDL that takes table locks such as `CREATE OR REPLACE TRIGGER`'s SHARE ROW EXCLUSIVE, with a short
 * `lock_timeout` in a savepoint: a lock it would wait for, such as one a stalled transaction holds, fails it after
 * {@link SCHEMA_SETUP_LOCK_WAIT_MS}, and it rolls back to the savepoint, backs off and tries again. A waiting DDL
 * statement queues every later writer of its table behind it, so it never waits long (#5218).
 */
export async function withShortSchemaLockWaits(
	executor: SqliteExecutor,
	dialect: StorageDialect,
	setup: () => Promise<void>,
): Promise<void> {
	if (dialect.name !== "postgres") return setup();
	return underShortLockWaits(executor, setup);
}

async function underShortLockWaits(
	executor: SqliteExecutor,
	setup: () => Promise<void>,
	known?: SqliteRow & { wait: string | null },
	after: readonly SequencedStatement[] = [],
	last = false,
): Promise<void> {
	const previous = known ?? (await executor.get<SqliteRow & { wait: string }>(LOCK_WAIT_SQL));
	for (let attempt = 1; ; attempt++) {
		// Sent with the setup's first statement, on a connection that pipelines a transaction's statements: no round trip
		// of its own. A failure of either fails the setup.
		const saved = executor.exec(
			`SAVEPOINT atomic_schema_setup; SET LOCAL lock_timeout = ${SCHEMA_SETUP_LOCK_WAIT_MS}`,
		);
		saved.catch(() => {});
		try {
			await setup();
			await saved;
			break;
		} catch (error) {
			if (!isLockTimeout(error) || attempt >= SCHEMA_SETUP_ATTEMPTS) throw error;
			await executor.exec("ROLLBACK TO SAVEPOINT atomic_schema_setup");
			const pause = Math.min(SCHEMA_SETUP_BACKOFF_MS * 2 ** (attempt - 1), SCHEMA_SETUP_MAX_BACKOFF_MS);
			await new Promise((resolve) => setTimeout(resolve, pause * (0.5 + Math.random() / 2)));
		}
	}
	// The savepoint's release, the lock wait restored, unless nothing follows in the transaction, and `after` go out
	// together: with the commit, where they are the transaction's `last` statements and its connection allows it.
	const statements: SequencedStatement[] = [
		{ sql: "RELEASE SAVEPOINT atomic_schema_setup", params: [], script: true },
		...(last
			? []
			: [
					{
						sql: `SET LOCAL lock_timeout = '${String(previous?.wait ?? "0").replaceAll("'", "''")}'`,
						params: [],
						script: true,
					},
				]),
		...after,
	];
	if (last && finishers.transactionFinisher?.(executor)?.(statements) === true) return;
	await Promise.all(
		statements.map((statement) =>
			statement.script === true ? executor.exec(statement.sql) : executor.run(statement.sql, ...statement.params),
		),
	);
}

/** The transaction's lock wait, which a setup lowers while it runs and then restores. */
const LOCK_WAIT_SQL = "SELECT current_setting('lock_timeout') AS wait";

/** The prefix's setup lock, which every schema setup holds on PostgreSQL: see {@link ensureStorageSchema}. */
const SETUP_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked";

/** What {@link ensureStorageSchema} records a store's schema setup under. */
export interface StorageSchemaSetup {
	/** The ledger table, already prefixed: `storageMigrationTable(prefix)`. */
	readonly ledger: string;
	/** The store's name in the ledger, unique among the stores under one prefix, such as `"pool-queue"`. */
	readonly domain: string;
	/**
	 * The revision of the store's tables, indexes, triggers and columns: raise it whenever `setup` creates or alters
	 * anything new, so a schema an earlier build set up runs `setup` again. Past ones stay recorded, never lowered.
	 */
	readonly revision: number;
}

/**
 * Whether the catalog an open in progress read (`withStorageSchemaCatalog`) records `schema.revision` for the
 * store already, so {@link ensureStorageSchema} would run nothing: the store's open then skips its schema transaction
 * and its lock (#6560). On SQLite the store's schema stamp records it, and only while nothing changed the
 * schema since (`sqliteSchemaStampTable`). False outside such an open, and when the revision is not recorded.
 */
export async function storageSchemaCurrent(database: SqliteDatabase, schema: StorageSchemaSetup): Promise<boolean> {
	const dialect = dialectOf(database);
	const key = `schema:${schema.domain}`;
	if (dialect.versionedMigrations) {
		const recorded = await recordedInCatalog(database, schema.ledger, key);
		return recorded !== undefined && recorded >= schema.revision;
	}
	if (dialect.name !== "sqlite") return false;
	return ((await sqliteSchemaStampsOf(database, schema.ledger))?.get(key) ?? 0) >= schema.revision;
}

/**
 * Runs `setup`, a store's idempotent schema statements (`CREATE … IF NOT EXISTS`, guarded `ALTER TABLE … ADD COLUMN`),
 * in the caller's transaction `executor` unless the ledger already records `revision` for the store (#5218). On a
 * database with versioned migrations (PostgreSQL) a current schema runs no DDL at all, so a runtime role with only DML
 * privileges opens it; a schema that is behind runs `setup` under the store's advisory lock, then records the revision,
 * so concurrent processes set it up once. A role that may not run the DDL then fails with
 * `StorageConfigError` reason `missing-privilege` from the adapter. On SQLite, which keep no ledger, `setup`
 * runs every time it is called, as before, and then stamps the store with the schema version the transaction leaves,
 * which {@link storageSchemaCurrent} believes until the schema changes again (#6560).
 */
export async function ensureStorageSchema(
	executor: SqliteExecutor,
	dialect: StorageDialect,
	schema: StorageSchemaSetup,
	setup: () => Promise<void>,
	options: EnsureStorageSchemaOptions = {},
): Promise<void> {
	if (!dialect.versionedMigrations) {
		await setup();
		if (dialect.name === "sqlite") await recordSqliteSchemaStamps(executor, [schema]);
		return;
	}
	const { ledger, domain, revision } = schema;
	const key = `schema:${domain}`;
	const record = {
		sql: `INSERT INTO ${ledger} (domain, version, applied_at) VALUES (?, ?, ${dialect.nowMs}) ON CONFLICT DO NOTHING`,
		params: [key, revision],
	};
	if (dialect.name !== "postgres") {
		if ((await recordedVersion(executor, dialect, ledger, key)) >= revision) return;
		await setup();
		await createLedger(executor, dialect, ledger);
		await executor.run(record.sql, ...record.params);
		return;
	}
	let ledgerFound = options.locked === true && options.ledgerExists === true;
	if (options.locked !== true) {
		ledgerFound = await tableExists(executor, dialect, ledger);
		if (ledgerFound && (await recordedVersion(executor, dialect, ledger, key, true)) >= revision) return;
	}
	// Serialized per prefix, so hosts that start together on a new database set each store up once, and two stores
	// that create a table they share never race to create it. The reads go out with the lock, and each runs after it:
	// what a holder before it recorded, whether this role may use the schema, and the lock wait the setup restores.
	const [first, usage, lockWait] = postgresSetupReads(dialect, ledger, key, ledgerFound);
	const [, found, access, wait] = await Promise.all([
		options.locked === true ? undefined : executor.get(SETUP_LOCK_SQL, `${ledger}:schema`),
		executor.get<SqliteRow & { version: number | string | null }>(first.sql, ...first.params),
		executor.get<SchemaAccess>(usage.sql, ...usage.params),
		executor.get<SqliteRow & { wait: string }>(lockWait.sql, ...lockWait.params),
	]);
	const ledgerExists = ledgerFound || found !== undefined;
	const recorded = ledgerFound
		? Number(found?.version ?? 0)
		: ledgerExists
			? await recordedVersion(executor, dialect, ledger, key, true)
			: 0;
	if (recorded >= revision) return;
	refuseWithoutSchemaUsage(access);
	const { int, text } = dialect.types;
	// The ledger, created where it is missing, and the record go out with the savepoint's release.
	const createLedgerStatement = {
		sql: `CREATE TABLE IF NOT EXISTS ${ledger} (domain ${text} NOT NULL, version ${int} NOT NULL, applied_at ${int} NOT NULL, PRIMARY KEY (domain, version))${dialect.tableOptions}`,
		params: [],
		script: true,
	};
	await underShortLockWaits(
		executor,
		setup,
		wait,
		ledgerExists ? [record] : [createLedgerStatement, record],
		options.last === true,
	);
}

/** How {@link ensureStorageSchema} runs in a transaction that holds the setup's locks already. */
export interface EnsureStorageSchemaOptions {
	/**
	 * The transaction holds the setup's locks already, as a {@link setUpStorageOnce} setup does: the ledger is read only
	 * under them, and the prefix's setup lock is not taken again.
	 */
	readonly locked?: boolean;
	/** With `locked`: the ledger exists, so its version is the first read, as {@link postgresSetupReads} lists them. */
	readonly ledgerExists?: boolean;
	/** The setup is the transaction's last call: its last statements go out with the commit. */
	readonly last?: boolean;
}

/**
 * The reads a PostgreSQL setup of the ledger key `key` makes first, under its locks, in this order: the version the
 * ledger records, where it is known to exist, or else whether it does; the schema's usage; and the lock wait the setup
 * restores. A {@link setUpStorageOnce} try sends them with its start.
 */
function postgresSetupReads(
	dialect: StorageDialect,
	ledger: string,
	key: string,
	ledgerExists: boolean,
): readonly SqliteStatement[] {
	return [
		ledgerExists ? { sql: versionRead(ledger, key)[0], params: [key] } : dialect.tableExists(ledger),
		{ sql: SCHEMA_USAGE_SQL, params: [] },
		{ sql: LOCK_WAIT_SQL, params: [] },
	];
}

/**
 * The advisory locks a PostgreSQL setup recorded in `ledger` under `key` tries: the prefix's setup lock, exclusive while
 * the ledger may be missing, so one setup creates it, and shared once it exists, so the setups of other stores run
 * beside it while an earlier build's setup, which takes it exclusive, runs alone; and a lock of the key's own, so one
 * process sets each store up.
 */
function setupLocks(ledger: string, key: string, ledgerExists: boolean): StorageSetupLock[] {
	return [{ scope: `${ledger}:schema`, shared: ledgerExists }, { scope: `${ledger}:schema:${key}` }];
}

/**
 * Runs `setup`, a store's idempotent schema statements, as {@link ensureStorageSchema} does, in a transaction of its own:
 * of the processes that open a new database at once, one runs it and the others wait for the ledger to record it,
 * without its lock (`setUpStorageOnce`, #6560). Inside an open, a revision the open's catalog records runs nothing; the
 * caller checks that first (`storageSchemaCurrent`). PostgreSQL; elsewhere the setup runs in a serial transaction of the
 * ledger's domain.
 */
export async function ensureStorageSchemaOnce(
	database: SqliteDatabase,
	schema: StorageSchemaSetup,
	setup: (transaction: SqliteExecutor) => Promise<void>,
): Promise<void> {
	const dialect = dialectOf(database);
	const { ledger, domain, revision } = schema;
	const concurrency = { kind: "serial", domain: ledger } as const;
	if (dialect.name !== "postgres") {
		await database.transaction((tx) => ensureStorageSchema(tx, dialect, schema, () => setup(tx)), {
			retryTransientFailures: true,
			concurrency,
		});
		return;
	}
	const key = `schema:${domain}`;
	let ledgerExists = await ledgerInCatalog(database, ledger);
	await setUpStorageOnce(database, {
		get locks() {
			return setupLocks(ledger, key, ledgerExists);
		},
		get leading() {
			return postgresSetupReads(dialect, ledger, key, ledgerExists);
		},
		done: async () => {
			const recorded = await recordedNow(database, ledger, key, ledgerExists);
			ledgerExists ||= await ledgerInCatalog(database, ledger);
			return recorded >= revision ? true : undefined;
		},
		setup: async (tx, locked) => {
			await ensureStorageSchema(tx, dialect, schema, () => setup(tx), { locked, ledgerExists, last: true });
			return true;
		},
		concurrency,
	});
}

/** What {@link ensureTableFillfactor} sets, and records under `schema:<domain>` in the ledger. */
export interface StorageFillfactorSetup extends StorageSchemaSetup {
	/** The table, already prefixed. */
	readonly table: string;
	/** The percentage of each new page the table fills on insert, leaving the rest for updated row versions. */
	readonly fillfactor: number;
}

/**
 * The fillfactor checks this process made that found nothing for it to do, by database (`databaseIdentity`, which
 * names the role and schema too), ledger and table, and the ones under way: the table had a fillfactor, or this role
 * does not own it (#6560). Such a check is not made again. One that set the fillfactor, or found no table, is.
 */
const fillfactorChecks = new Map<string, Promise<boolean>>();

/**
 * Sets `setup.table`'s fillfactor on PostgreSQL, once per database, recorded in the ledger as `schema:<domain>`: each
 * page then keeps room for a new version of the rows on it, so updates of rows that change no indexed column stay on
 * their page as HOT updates and touch no index (#6560). It applies to the pages written from then on; `VACUUM FULL`
 * or pg_repack rewrites the existing ones with it. Nothing runs where the catalog an open read records the step.
 * Otherwise one read of the table's catalog entry decides: nothing runs where the table has a fillfactor already, or
 * where this role does not own the table, so a runtime role without DDL opens as before, and `atomic storage migrate`,
 * run as the owner, sets it. A process reads that once for each database and table, so until migrate records the step
 * only its first open pays the read. Does nothing on SQLite.
 */
export async function ensureTableFillfactor(database: SqliteDatabase, setup: StorageFillfactorSetup): Promise<void> {
	const dialect = dialectOf(database);
	if (dialect.name !== "postgres" || database.readOnly === true) return;
	const { ledger, domain, revision, table } = setup;
	if (await storageSchemaCurrent(database, { ledger, domain, revision })) return;
	const identity = database.databaseIdentity?.();
	if (identity === undefined) {
		await checkTableFillfactor(database, setup);
		return;
	}
	const key = JSON.stringify([identity, ledger, table]);
	let check = fillfactorChecks.get(key);
	if (check === undefined) {
		const made = checkTableFillfactor(database, setup);
		check = made;
		fillfactorChecks.set(key, made);
		const forget = () => {
			if (fillfactorChecks.get(key) === made) fillfactorChecks.delete(key);
		};
		made.then((settled) => {
			if (!settled) forget();
		}, forget);
	}
	await check;
}

/**
 * {@link ensureTableFillfactor}'s read of the table's catalog entry, and the change where it is due. True where it
 * found nothing this role can do: the table has a fillfactor, or this role does not own it.
 */
async function checkTableFillfactor(database: SqliteDatabase, setup: StorageFillfactorSetup): Promise<boolean> {
	const dialect = dialectOf(database);
	const { ledger, domain, revision, table, fillfactor } = setup;
	const schema = { ledger, domain, revision };
	const found = await database.get<SqliteRow & { owned: boolean | number; tuned: boolean | number }>(
		`SELECT pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS owned,
			coalesce(array_to_string(c.reloptions, ',') LIKE '%fillfactor=%', false) AS tuned
		FROM pg_catalog.pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ?`,
		dialect.identifier(table),
	);
	const yes = (value: boolean | number | undefined) => value === true || Number(value) === 1;
	if (found === undefined) return false;
	if (yes(found.tuned) || !yes(found.owned)) return true;
	// Hosts that open a new database at once set it once, and the others wait for that without the lock.
	await ensureStorageSchemaOnce(database, schema, async (tx) => {
		await tx.exec(`ALTER TABLE ${table} SET (fillfactor = ${Math.trunc(fillfactor)})`);
	});
	return false;
}
