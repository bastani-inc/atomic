import type { SqliteRow } from "@bastani/atomic/storage";
import type { SqlPoolStorage } from "./internal.js";

/** The tables, indexes and triggers `statements` create with `CREATE … IF NOT EXISTS`, by name. */
function createdObjects(statements: readonly string[]): string[] {
	return statements.flatMap((sql) =>
		[...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/gi)].map(
			(match) => match[1]!,
		),
	);
}

/**
 * Whether a pool store's idempotent SQLite setup would change nothing, read without the write lock (#4768): every
 * table, index and trigger `statements` create exists, and so does every column in `columns`, as `[table, column]`.
 * Always false on a database that sends no batches, such as a local node:sqlite journal, which holds its write lock
 * for no network round trip and sets up under it, and on one with versioned migrations, whose setup checks its ledger
 * under its lock. A store whose setup would change nothing opens without a write transaction: on a libSQL server many
 * hosts share, each such transaction held the server's one write lock for a round trip per statement, while every
 * other host's writes waited.
 */
export async function poolSchemaPresent(
	storage: SqlPoolStorage,
	statements: readonly string[],
	columns: readonly (readonly [table: string, column: string])[] = [],
): Promise<boolean> {
	const { dialect } = storage;
	if (storage.batch === undefined || dialect.versionedMigrations) return false;
	const names = createdObjects(statements);
	return storage.read(async (read) => {
		const objects = dialect.schemaObjects(names);
		const found = new Set(
			(await read.all<SqliteRow & { name: string }>(objects.sql, ...objects.params)).map((row) => row.name),
		);
		if (!names.every((name) => found.has(name))) return false;
		for (const [table, column] of columns) {
			const probe = dialect.columnExists(table, column);
			if ((await read.get(probe.sql, ...probe.params)) === undefined) return false;
		}
		return true;
	});
}
