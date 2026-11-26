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
	if (await createsNothingNew(database, setup)) return;
	await database.transaction((tx) =>
		ensureStorageSchema(tx, dialectOf(database), schema, async () => {
			await setup(tx);
		}),
	);
}

/**
 * Whether `setup` would change nothing on a SQLite or libSQL database: where it only runs `CREATE TABLE` and
 * `CREATE INDEX` statements with `IF NOT EXISTS`, and the catalog an open in progress read found each object, as a
 * table or an index as the statement names it. SQLite records no versions, so such a setup ran at every open in a
 * write transaction of its own, which took the database's write lock and, on a server, three round trips (#6560).
 * Statements on an existing object of that kind do nothing, so skipping them is the same. The setup runs against a
 * handle that only collects the SQL it would run; any other call, or a statement of another form, and it runs as
 * before. False outside such an open, and on PostgreSQL, whose ledger decides.
 */
async function createsNothingNew(
	database: SqliteDatabase,
	setup: (tx: SqliteExecutor) => Promise<unknown>,
): Promise<boolean> {
	if (dialectOf(database).versionedMigrations) return false;
	const typeOf = (await openCatalogOf(database))?.sqliteObjectType;
	if (typeOf === undefined) return false;
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
		return false;
	}
	if (other) return false;
	for (const script of scripts) {
		const statements = splitStatements(script);
		if (statements === undefined) return false;
		for (const statement of statements) {
			const created = CREATE_IF_NOT_EXISTS.exec(statement);
			if (created === null) return false;
			const name = created[3] ?? created[4]!;
			if (typeOf(name) !== created[2]!.toLowerCase()) return false;
		}
	}
	return true;
}

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
