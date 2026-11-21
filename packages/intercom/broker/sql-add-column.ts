import { dialectOf, type SqliteDatabase } from "@bastani/atomic/storage";

/**
 * Whether adding a column failed because it is already there: SQLite's "duplicate column name", Postgres's
 * `column "…" of relation "…" already exists` (SQLSTATE 42701), in the error's message or its cause.
 */
function isDuplicateColumn(error: unknown): boolean {
	const text = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
	return /duplicate column|column .* already exists/i.test(text);
}

/**
 * A statement the database refused for a privilege the role lacks: the PostgreSQL adapter's `missing-privilege`, which
 * the database facade reports as the cause of its `StorageUnavailableError`.
 */
function isMissingPrivilege(error: unknown): boolean {
	let at = error;
	for (let depth = 0; depth < 4 && typeof at === "object" && at !== null; depth++) {
		if ((at as { reason?: unknown }).reason === "missing-privilege") return true;
		at = (at as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * `addMissingColumns` for one column a store can do without: whether the column is there. A role that may not change
 * tables (a PostgreSQL runtime role with only DML privileges) leaves it out, and the store works as before it existed
 * until `atomic storage migrate`, run as the owner role, adds it. Any other failure is thrown.
 */
export async function addOptionalColumn(
	database: SqliteDatabase,
	table: string,
	column: string,
	definition: string,
	/** Run once with the column's addition, in its transaction, as an index on it. */
	withColumn?: string,
): Promise<boolean> {
	try {
		await addMissingColumns(database, table, { [column]: definition }, withColumn);
		return true;
	} catch (error) {
		if (isMissingPrivilege(error)) return false;
		throw error;
	}
}

/**
 * Adds each missing column of `columns` (name → definition after the name) to `table`, in order. A table from an older
 * broker gets the columns, and an older broker ignores them. Each column is probed and added in a serial transaction,
 * so brokers opening the store at once take turns (#5054); an older broker adding one meanwhile is not an error.
 */
export async function addMissingColumns(
	database: SqliteDatabase,
	table: string,
	columns: Readonly<Record<string, string>>,
	withColumn?: string,
): Promise<void> {
	const dialect = dialectOf(database);
	for (const [column, definition] of Object.entries(columns)) {
		const probe = dialect.columnExists(table, column);
		try {
			await database.transaction(async (tx) => {
				if ((await tx.all(probe.sql, ...probe.params)).length > 0) return;
				await tx.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
				if (withColumn !== undefined) await tx.exec(withColumn);
			});
		} catch (error) {
			if (!isDuplicateColumn(error)) throw error;
		}
	}
}
