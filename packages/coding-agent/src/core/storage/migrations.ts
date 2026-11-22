import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteStatement } from "./database.js";
import { dialectOf, type StorageDialect } from "./dialect.js";
import { StorageConfigError, StorageSchemaVersionError } from "./errors.js";
import { MAX_SEQUENCE_REQUEST_STATEMENTS, type SequencedStatement, sequenceRunner } from "./statement-sequence.js";

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
		`Role "${access.role}" has no USAGE on schema ${access.schema}, so it can neither find Atomic's tables there nor create them. Grant it as the schema's owner: GRANT USAGE ON SCHEMA ${access.schema} TO "${access.role}"; and, for a runtime role, the table grants in "Set up the database" in docs/storage.md`,
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

/**
 * A write of a {@link schemaBatch}: SQL text of one or more statements without parameters, run as `exec` runs it, or
 * one statement with its parameters, run as `run` runs it. `false` and `undefined` stand for a write left out.
 */
export type SchemaWrite = string | SqliteStatement | false | undefined;

/**
 * Runs `writes` in order, then `reads`, each read one call of `executor`, and resolves with what the reads return. The
 * statements, and what each read sees, are those of running each after the one before: the first statement that fails
 * ends the batch with its failure, before anything after it is written. Where `executor` runs its calls in the order
 * they are made, a transaction of a SQLite file connection on a thread of its own (`sequenceRunner`), the writes go to
 * the thread as one request and the reads behind it without waiting for its answer, so a batch waits for the thread
 * once rather than once per statement: on a loaded machine that wait, not the statement, is what a schema setup costs.
 * A read sent behind a write that then failed changes nothing; its answer is not used. Reads alone on a database (not
 * a transaction) are made together too. Any other executor runs each statement in turn, as before.
 */
export async function schemaBatch<const Reads extends readonly (() => Promise<unknown>)[]>(
	executor: SqliteExecutor,
	writes: readonly SchemaWrite[],
	reads: Reads,
): Promise<{ -readonly [K in keyof Reads]: Awaited<ReturnType<Reads[K]>> }> {
	type Values = { -readonly [K in keyof Reads]: Awaited<ReturnType<Reads[K]>> };
	const statements = writes.filter(
		(write): write is string | SqliteStatement => write !== false && write !== undefined,
	);
	const runSequence = sequenceRunner(executor);
	// A database queues each call in the order it is made, so reads alone go together there too, as the open's probes do.
	const together =
		statements.length === 0
			? runSequence !== undefined || "transaction" in executor
			: runSequence !== undefined && statements.length <= MAX_SEQUENCE_REQUEST_STATEMENTS;
	if (!together) {
		for (const write of statements) {
			if (typeof write === "string") await executor.exec(write);
			else await executor.run(write.sql, ...write.params);
		}
		const values: unknown[] = [];
		for (const read of reads) values.push(await read());
		return values as Values;
	}
	const sequenced = statements.map(
		(write): SequencedStatement => (typeof write === "string" ? { sql: write, params: [], script: true } : write),
	);
	const outcomes = await Promise.allSettled([
		sequenced.length === 0 || runSequence === undefined ? Promise.resolve(0) : runSequence({ statements: sequenced }),
		...reads.map((read) => read()),
	]);
	// The first failure in the order the statements run, as when each waited for the one before.
	const failed = outcomes.find((outcome) => outcome.status === "rejected");
	if (failed !== undefined) throw failed.reason;
	return outcomes.slice(1).map((outcome) => (outcome as PromiseFulfilledResult<unknown>).value) as Values;
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
 * Runs `setup`, a store's idempotent schema statements (`CREATE … IF NOT EXISTS`, guarded `ALTER TABLE … ADD COLUMN`),
 * in the caller's transaction `executor` unless the ledger already records `revision` for the store (#5218). On a
 * database with versioned migrations (PostgreSQL) a current schema runs no DDL at all, so a runtime role with only DML
 * privileges opens it; a schema that is behind runs `setup` under the store's advisory lock, then records the revision,
 * so concurrent processes set it up once. A role that may not run the DDL then fails with
 * `StorageConfigError` reason `missing-privilege` from the adapter. On SQLite, which records no ledger, `setup` runs
 * every time, as before.
 */
export async function ensureStorageSchema(
	executor: SqliteExecutor,
	dialect: StorageDialect,
	schema: StorageSchemaSetup,
	setup: () => Promise<void>,
): Promise<void> {
	if (!dialect.versionedMigrations) {
		await setup();
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
