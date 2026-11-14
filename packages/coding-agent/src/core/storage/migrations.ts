import type { SqliteDatabase, SqliteExecutor, SqliteRow } from "./database.js";
import { dialectOf, type StorageDialect } from "./dialect.js";
import { StorageConfigError, StorageSchemaVersionError } from "./errors.js";

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

async function applyVersioned(
	transaction: SqliteExecutor,
	dialect: StorageDialect,
	table: string,
	domain: string,
	steps: readonly StorageMigrationStep[],
): Promise<StorageMigrationResult> {
	const { int, text } = dialect.types;
	await transaction.exec(
		`CREATE TABLE IF NOT EXISTS ${table} (domain ${text} NOT NULL, version ${int} NOT NULL, applied_at ${int} NOT NULL, PRIMARY KEY (domain, version))${dialect.tableOptions}`,
	);
	const row = await transaction.get<SqliteRow & { version: number | null }>(
		`SELECT MAX(version) AS version FROM ${table} WHERE domain = ?`,
		domain,
	);
	const current = row?.version ?? 0;
	const supported = steps.at(-1)?.version ?? 0;
	if (current > supported) throw new StorageSchemaVersionError(domain, current, supported);
	const applied: number[] = [];
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
			if (dialect.versionedMigrations) return applyVersioned(transaction, dialect, table, domain, steps);
			for (const step of steps) await step.up(transaction, dialect);
			return { applied: steps.map((step) => step.version), version: steps.at(-1)?.version ?? 0 };
		},
		{ retryTransientFailures: true, concurrency: { kind: "serial", domain: table } },
	);
}
