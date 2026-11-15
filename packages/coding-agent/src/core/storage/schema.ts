import type { SqliteExecutor, SqliteRow, SqliteValue } from "./database.js";
import { StorageSchemaVersionError } from "./errors.js";

export function assertStorageSchemaVersion(domain: string, found: SqliteValue, supported: number): void {
	if (found !== supported) throw new StorageSchemaVersionError(domain, found, supported);
}

/**
 * Reads a domain's meta rows with `statement` on `executor`, inside the caller's transaction, and throws
 * `StorageSchemaVersionError` when one holds another version than `supported`. A store checks its version only when it
 * opens; calling this at the start of each transaction makes a process that opened the database before a newer build
 * upgraded it refuse it from then on instead of misreading what the newer build wrote (#5065).
 */
export async function assertStoredSchemaVersion(
	executor: SqliteExecutor,
	statement: { readonly sql: string; readonly params?: readonly SqliteValue[] },
	domain: string,
	supported: number,
	column = "schema_version",
): Promise<void> {
	const rows = await executor.all<SqliteRow>(statement.sql, ...(statement.params ?? []));
	for (const row of rows) assertStorageSchemaVersion(domain, row[column]!, supported);
}
