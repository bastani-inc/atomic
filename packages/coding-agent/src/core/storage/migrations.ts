import type { SqliteDatabase, SqliteExecutor, SqliteRow } from "./database.js";
import { dialectOf, type StorageDialect } from "./dialect.js";
import { StorageConfigError, StorageSchemaVersionError } from "./errors.js";
import { recordSqliteSchemaStamps, schemaCatalogOf, sqliteSchemaStampsOf } from "./schema-catalog.js";

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
	const access = await executor.get<SqliteRow & { schema: string; role: string; present: number; usage: number }>(
		`SELECT s.name AS schema, current_user AS role, (n.oid IS NOT NULL)::int AS present,
			coalesce(has_schema_privilege(n.oid, 'USAGE'), false)::int AS usage
		FROM (SELECT trim(both '"' from split_part(current_setting('search_path'), ',', 1)) AS name) s
		LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = s.name`,
	);
	if (access === undefined || Number(access.present) === 0 || Number(access.usage) === 1) return;
	throw new StorageConfigError(
		"sdk",
		"privileges",
		"missing-privilege",
		`Role "${access.role}" has no USAGE on schema ${access.schema}, so it can neither find Atomic's tables there nor create them. Grant it as the schema's owner: GRANT USAGE ON SCHEMA ${access.schema} TO "${access.role}"; and, for a runtime role, the table grants in "Set up the database" in docs/storage/postgres.md`,
	);
}

/** Creates the ledger `table` unless it exists, so a current schema runs no DDL (#5218). */
async function createLedger(executor: SqliteExecutor, dialect: StorageDialect, table: string): Promise<void> {
	if (await tableExists(executor, dialect, table)) return;
	await assertSchemaUsage(executor, dialect);
	// Two stores that set up their schemas at once never race to create the ledger they share.
	if (dialect.name === "postgres") {
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
): Promise<number> {
	if (!(await tableExists(executor, dialect, table))) return 0;
	const row = await executor.get<SqliteRow & { version: number | null }>(
		`SELECT MAX(version) AS version FROM ${table} WHERE domain = ?`,
		domain,
	);
	return Number(row?.version ?? 0);
}

async function applyVersioned(
	transaction: SqliteExecutor,
	dialect: StorageDialect,
	table: string,
	domain: string,
	steps: readonly StorageMigrationStep[],
	acceptNewer = false,
): Promise<StorageMigrationResult> {
	const current = await recordedVersion(transaction, dialect, table, domain);
	const supported = steps.at(-1)?.version ?? 0;
	if (current > supported) {
		if (acceptNewer) return { applied: [], version: current };
		throw new StorageSchemaVersionError(domain, current, supported);
	}
	const applied: number[] = [];
	// Probed first: a current schema, whose ledger exists, runs no DDL (#5218).
	await createLedger(transaction, dialect, table);
	for (const step of steps) {
		if (step.version <= current) continue;
		await step.up(transaction, dialect);
		await transaction.run(`INSERT INTO ${table} VALUES (?, ?, ${dialect.nowMs})`, domain, step.version);
		applied.push(step.version);
	}
	return { applied, version: Math.max(current, supported) };
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

async function underShortLockWaits(executor: SqliteExecutor, setup: () => Promise<void>): Promise<void> {
	const previous = await executor.get<SqliteRow & { wait: string }>("SELECT current_setting('lock_timeout') AS wait");
	for (let attempt = 1; ; attempt++) {
		await executor.exec("SAVEPOINT atomic_schema_setup");
		await executor.exec(`SET LOCAL lock_timeout = ${SCHEMA_SETUP_LOCK_WAIT_MS}`);
		try {
			await setup();
			await executor.exec("RELEASE SAVEPOINT atomic_schema_setup");
			break;
		} catch (error) {
			if (!isLockTimeout(error) || attempt >= SCHEMA_SETUP_ATTEMPTS) throw error;
			await executor.exec("ROLLBACK TO SAVEPOINT atomic_schema_setup");
			const pause = Math.min(SCHEMA_SETUP_BACKOFF_MS * 2 ** (attempt - 1), SCHEMA_SETUP_MAX_BACKOFF_MS);
			await new Promise((resolve) => setTimeout(resolve, pause * (0.5 + Math.random() / 2)));
		}
	}
	await executor.exec(`SET LOCAL lock_timeout = '${String(previous?.wait ?? "0").replaceAll("'", "''")}'`);
}

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
): Promise<void> {
	if (!dialect.versionedMigrations) {
		await setup();
		if (dialect.name === "sqlite") await recordSqliteSchemaStamps(executor, [schema]);
		return;
	}
	const { ledger, domain, revision } = schema;
	const key = `schema:${domain}`;
	if ((await recordedVersion(executor, dialect, ledger, key)) >= revision) return;
	if (dialect.name === "postgres") {
		// Serialized per prefix, so hosts that start together on a new database set each store up once, and two stores
		// that create a table they share never race to create it.
		await executor.get("SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked", `${ledger}:schema`);
		if ((await recordedVersion(executor, dialect, ledger, key)) >= revision) return;
		await assertSchemaUsage(executor, dialect);
		await underShortLockWaits(executor, setup);
	} else await setup();
	await createLedger(executor, dialect, ledger);
	await executor.run(
		`INSERT INTO ${ledger} (domain, version, applied_at) VALUES (?, ?, ${dialect.nowMs}) ON CONFLICT DO NOTHING`,
		key,
		revision,
	);
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
	await database.transaction(
		(tx) =>
			ensureStorageSchema(tx, dialect, schema, async () => {
				await tx.exec(`ALTER TABLE ${table} SET (fillfactor = ${Math.trunc(fillfactor)})`);
			}),
		{ retryTransientFailures: true, concurrency: { kind: "serial", domain: ledger } },
	);
	return false;
}
