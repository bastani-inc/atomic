import { dialectOf, ensureStorageSchema, type SqliteDatabase, type SqliteExecutor, storageMigrationTable } from "@bastani/atomic/storage";

/**
 * Runs `setup`, a broker store's idempotent schema statements, in a transaction of its own, unless the prefix's ledger
 * records `revision` for `store` already (#5218): on PostgreSQL a current schema runs no DDL, so a role with only DML
 * privileges opens the store. Raise `revision` whenever `setup` creates or alters anything new.
 */
export async function ensureBrokerSchema(
	database: SqliteDatabase,
	prefix: string | undefined,
	store: string,
	setup: (tx: SqliteExecutor) => Promise<unknown>,
	revision = 1,
): Promise<void> {
	const schema = { ledger: storageMigrationTable(prefix), domain: `intercom-${store}`, revision };
	await database.transaction((tx) =>
		ensureStorageSchema(tx, dialectOf(database), schema, async () => {
			await setup(tx);
		}),
	);
}
