import type { SqliteExecutor, SqliteValue } from "./database.js";
import { StorageSchemaVersionError } from "./errors.js";

export function assertStorageSchemaVersion(domain: string, found: SqliteValue, supported: number): void {
	if (found !== supported) throw new StorageSchemaVersionError(domain, found, supported);
}

/**
 * Reads a store's schema version with `statement`, through `executor` (so inside the caller's transaction when it is one),
 * and throws `StorageSchemaVersionError` unless it is `supported`. A process that opened a store keeps it open while a
 * later build upgrades it; calling this first in each transaction makes that process refuse the upgraded store instead
 * of misreading what the later build writes (#4965, #5065). `column` is the column `statement` selects the version as.
 */
export async function assertStoredSchemaVersion(
	executor: SqliteExecutor,
	statement: { readonly sql: string; readonly params?: readonly SqliteValue[] },
	domain: string,
	supported: number,
	column = "schema_version",
): Promise<void> {
	const row = await executor.get(statement.sql, ...(statement.params ?? []));
	assertStorageSchemaVersion(domain, row?.[column] ?? null, supported);
}
