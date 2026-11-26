import * as storage from "@bastani/atomic/storage";
import { dialectOf, ensureStorageSchema, type SqliteDatabase, type SqliteExecutor, storageMigrationTable } from "@bastani/atomic/storage";

/**
 * `storageSchemaCurrent`, `schemaCatalogOf` and `withStorageSchemaCatalog` of the storage API, which an Atomic
 * installation older than #6560 lacks: a named import would fail to link there, so they are taken from the module
 * namespace, and without them every open checks its schema in a transaction, as before.
 */
const catalogApi: Partial<
	Pick<typeof storage, "storageSchemaCurrent" | "schemaCatalogOf" | "withStorageSchemaCatalog">
> = storage;

/**
 * Runs `open`, a broker store's open on `database`, with one read of the prefix's schema catalog, which its schema
 * checks answer from: a store whose schema is current opens with no schema transaction and no lock, whether the broker
 * opens it with the others (`openIntercomBrokerState`, whose read it shares), on its own, or later, as the ended-child
 * queue of a new home (#6560). `views` are other handles on the same connection whose checks answer from the read.
 */
export async function withBrokerSchemaCatalog<T>(
	database: SqliteDatabase,
	prefix: string | undefined,
	open: () => Promise<T>,
	views: readonly SqliteDatabase[] = [],
): Promise<T> {
	const withCatalog = catalogApi.withStorageSchemaCatalog;
	return withCatalog === undefined ? open() : withCatalog(database, storageMigrationTable(prefix), open, views);
}

/**
 * Runs `setup`, a broker store's idempotent schema statements, in a transaction of its own, unless the prefix's ledger
 * records `revision` for `store` already (#5218): on PostgreSQL a current schema runs no DDL, so a role with only DML
 * privileges opens the store. Raise `revision` whenever `setup` creates or alters anything new. Inside an open that read
 * the catalog (`withStorageSchemaCatalog`), a revision it found recorded skips the transaction too (#6560).
 */
export async function ensureBrokerSchema(
	database: SqliteDatabase,
	prefix: string | undefined,
	store: string,
	setup: (tx: SqliteExecutor) => Promise<unknown>,
	revision = 1,
): Promise<void> {
	const schema = { ledger: storageMigrationTable(prefix), domain: `intercom-${store}`, revision };
	if (await catalogApi.storageSchemaCurrent?.(database, schema)) return;
	await database.transaction((tx) =>
		ensureStorageSchema(tx, dialectOf(database), schema, async () => {
			await setup(tx);
		}),
	);
}

/**
 * Whether the catalog an open in progress read found `table` with every one of `columns`, so adding them would change
 * nothing (#6560). False outside such an open.
 */
export async function catalogHasColumns(
	database: SqliteDatabase,
	table: string,
	columns: readonly string[],
): Promise<boolean> {
	const catalog = await openCatalogOf(database);
	return catalog !== undefined && columns.every((column) => catalog.hasColumn(table, column));
}

/**
 * The schema catalog an open of `database` in progress read (`withStorageSchemaCatalog`), undefined outside one. Its
 * answers describe the schema when the open began.
 */
export async function openCatalogOf(database: SqliteDatabase): Promise<storage.StorageSchemaCatalog | undefined> {
	return catalogApi.schemaCatalogOf?.(database);
}
