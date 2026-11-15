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
 * Adds each missing column of `columns` (name → definition after the name) to `table`, in order. A table from an older
 * broker gets the columns, and an older broker ignores them; another broker adding one meanwhile is not an error.
 */
export async function addMissingColumns(
	database: SqliteDatabase,
	table: string,
	columns: Readonly<Record<string, string>>,
): Promise<void> {
	const dialect = dialectOf(database);
	for (const [column, definition] of Object.entries(columns)) {
		const probe = dialect.columnExists(table, column);
		if ((await database.all(probe.sql, ...probe.params)).length > 0) continue;
		try {
			await database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
		} catch (error) {
			if (!isDuplicateColumn(error)) throw error;
		}
	}
}
