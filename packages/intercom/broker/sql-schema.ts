import * as storage from "@bastani/atomic/storage";
import { dialectOf, ensureStorageSchema, type SqliteDatabase, type SqliteExecutor, storageMigrationTable } from "@bastani/atomic/storage";

/**
 * `storageSchemaCurrent`, `schemaCatalogOf` and `withStorageSchemaCatalog` of the storage API, which an Atomic
 * installation older than #6560 lacks: a named import would fail to link there, so they are taken from the module
 * namespace, and without them every open checks its schema in a transaction, as before.
 */
const catalogApi: Partial<
	Pick<
		typeof storage,
		"storageSchemaCurrent" | "schemaCatalogOf" | "withStorageSchemaCatalog" | "restampStorageSchemaAtOpenEnd"
	>
> = storage;

/**
 * What every transaction of the broker's state asks of the database besides its locks: run again, after a short
 * randomized wait, when a lock wait that outlasted the database's lock timeout, a deadlock or a serialization failure
 * ended it before it wrote anything, rather than failing the send, renewal, claim or delivery it makes. A busy shared
 * database ends one now and then even when nothing is wrong. Each callback only uses its transaction handle, so running
 * it again repeats nothing else; a database that cannot tell what a failure applied ignores it.
 */
export const RETRY_UNAPPLIED = { retryTransientFailures: true } as const;

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
 * the catalog (`withStorageSchemaCatalog`), a revision it found recorded skips the transaction too (#6560). On SQLite the
 * store's stamp records it. A setup that runs stamps nothing: later setups of the same open would leave its
 * stamp behind, and stamping costs a new database's first open statements and a transaction. The next open finds the
 * store in the catalog instead; there a setup whose objects the catalog holds is checked again, and a counter it seeds
 * seeded, in the one transaction the open's end stamps every such store in, so later opens of a current schema take no
 * write lock and answer every store from its stamp.
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
	const found = await foundInCatalog(database, setup);
	if (found?.present === true) {
		const options = { verify: found.verify, deferred: found.seeds };
		if (catalogApi.restampStorageSchemaAtOpenEnd?.(database, schema, setup, options) === true) return;
		if (!found.seeds) return;
	}
	const dialect = dialectOf(database);
	// Idempotent, and run again when a busy database ended it before it wrote anything, as brokers opening together on a
	// new database wait for each other's setup.
	await database.transaction(async (tx) => {
		if (!dialect.versionedMigrations) {
			await setup(tx);
			return;
		}
		await ensureStorageSchema(tx, dialect, schema, async () => {
			await setup(tx);
		});
	}, RETRY_UNAPPLIED);
	// Stamped where the end of the open takes a transaction for other stores anyway, as after a repair or an upgrade.
	if (!dialect.versionedMigrations)
		catalogApi.restampStorageSchemaAtOpenEnd?.(database, schema, setup, { verify: found?.verify, alongside: true });
}

/**
 * Whether the ledger, or the catalog an open in progress read, records `revision` of `store`'s setup, without a
 * transaction; false where the storage API cannot tell.
 */
export async function brokerSchemaCurrent(
	database: SqliteDatabase,
	prefix: string | undefined,
	store: string,
	revision = 1,
): Promise<boolean> {
	const schema = { ledger: storageMigrationTable(prefix), domain: `intercom-${store}`, revision };
	return (await catalogApi.storageSchemaCurrent?.(database, schema)) === true;
}

/**
 * Asks the open of `database` in progress to stamp `store`'s `setup` at its end, on SQLite, where the open
 * found the store current in the catalog, `verify` says, rather than by its stamp, which a schema change since left
 * behind: the next open then answers from the stamp (#6560). Does nothing where the stamp is current, elsewhere, and
 * outside an open.
 */
export async function stampBrokerSchemaAtOpenEnd(
	database: SqliteDatabase,
	prefix: string | undefined,
	store: string,
	setup: (tx: SqliteExecutor) => Promise<unknown>,
	verify: (catalog: storage.StorageSchemaCatalog) => boolean,
	revision = 1,
): Promise<void> {
	const schema = { ledger: storageMigrationTable(prefix), domain: `intercom-${store}`, revision };
	if (await catalogApi.storageSchemaCurrent?.(database, schema)) return;
	catalogApi.restampStorageSchemaAtOpenEnd?.(database, schema, setup, { verify });
}

/**
 * What `setup` creates on a SQLite database, where it only runs `CREATE TABLE` and `CREATE INDEX` statements
 * with `IF NOT EXISTS` and seeds rows with `INSERT … ON CONFLICT … DO NOTHING`: `present`, whether the catalog an open
 * in progress read found each object, as a table or an index as the statement names it; `verify`, the same check
 * against another catalog; and `seeds`, whether it seeds rows, which still have to be written. SQLite records no
 * versions, so such a setup ran at every open in a write transaction of its own, which took the database's write lock
 * and, on a server, three round trips (#6560); statements on an existing object of that kind do nothing. The setup runs
 * against a handle that only collects the SQL it would run. Undefined for any other call or statement, outside such an
 * open, and on PostgreSQL, whose ledger decides.
 */
async function foundInCatalog(
	database: SqliteDatabase,
	setup: (tx: SqliteExecutor) => Promise<unknown>,
): Promise<
	| {
			readonly verify: (catalog: storage.StorageSchemaCatalog) => boolean;
			readonly seeds: boolean;
			readonly present: boolean;
	  }
	| undefined
> {
	if (dialectOf(database).versionedMigrations) return undefined;
	const catalog = await openCatalogOf(database);
	if (catalog?.sqliteObjectType === undefined) return undefined;
	const scripts: string[] = [];
	let other = false;
	const refuse = () => {
		other = true;
		return Promise.reject(new Error("not a schema statement"));
	};
	const collecting: SqliteExecutor = {
		exec: (sql) => {
			scripts.push(sql);
			return Promise.resolve();
		},
		run: refuse,
		get: refuse,
		all: refuse,
	};
	try {
		await setup(collecting);
	} catch {
		return undefined;
	}
	if (other) return undefined;
	const created: { readonly name: string; readonly type: string }[] = [];
	let seeds = false;
	for (const script of scripts) {
		const statements = splitStatements(script);
		if (statements === undefined) return undefined;
		for (const statement of statements) {
			const create = CREATE_IF_NOT_EXISTS.exec(statement);
			if (create !== null) created.push({ name: create[3] ?? create[4]!, type: create[2]!.toLowerCase() });
			else if (SEED.test(statement)) seeds = true;
			else return undefined;
		}
	}
	const verify = (found: storage.StorageSchemaCatalog) =>
		created.every(({ name, type }) => found.sqliteObjectType?.(name) === type);
	return { verify, seeds, present: verify(catalog) };
}

/** `INSERT INTO … ON CONFLICT … DO NOTHING`: rows a setup seeds once, which writing again leaves as they are. */
const SEED = /^INSERT\s+INTO\s[\s\S]*\sON\s+CONFLICT\b[\s\S]*\sDO\s+NOTHING$/i;

/** `CREATE [UNIQUE] TABLE|INDEX IF NOT EXISTS <name>`, the name plain or double-quoted and never schema-qualified. */
const CREATE_IF_NOT_EXISTS =
	/^CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))(?![A-Za-z0-9_$."])/i;

/**
 * The statements of `script`, each trimmed, split at the semicolons outside quotes, brackets, parentheses and comments;
 * undefined when a quote or comment does not end, or a statement starts with a comment.
 */
function splitStatements(script: string): string[] | undefined {
	const statements: string[] = [];
	let start = 0;
	let depth = 0;
	for (let at = 0; at < script.length; at++) {
		const char = script[at]!;
		const close = char === "'" || char === '"' || char === "`" ? char : char === "[" ? "]" : undefined;
		if (close !== undefined) {
			const end = script.indexOf(close, at + 1);
			if (end < 0) return undefined;
			at = end;
		} else if (char === "-" && script[at + 1] === "-") {
			const end = script.indexOf("\n", at);
			at = end < 0 ? script.length : end;
		} else if (char === "/" && script[at + 1] === "*") {
			const end = script.indexOf("*/", at + 2);
			if (end < 0) return undefined;
			at = end + 1;
		} else if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (char === ";" && depth === 0) {
			statements.push(script.slice(start, at));
			start = at + 1;
		}
	}
	statements.push(script.slice(start));
	const trimmed = statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
	return trimmed.some((statement) => statement.startsWith("--") || statement.startsWith("/*")) ? undefined : trimmed;
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
