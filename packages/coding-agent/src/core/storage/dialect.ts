import type { SqliteStatement } from "./database.js";

/** The database engines a store's SQL is written for. */
export type StorageDialectName = "sqlite" | "postgres";

/** A row lock a `fenced` transaction takes on the rows it reads: see `StorageDialect.lockClause`. */
export type StorageLockKind = "update" | "share" | "update-skip-locked";

/** A JSON type, named as SQLite's `json_type` names it: see `StorageDialect.jsonHasType`. */
export type StorageJsonType = "null" | "text" | "object" | "array";

/** Column types, in each engine's spelling. */
export interface StorageDialectTypes {
	/** A 64-bit integer: `INTEGER` on SQLite, `BIGINT` on Postgres, whose `INTEGER` is 32-bit. */
	readonly int: string;
	readonly real: string;
	readonly text: string;
	readonly blob: string;
	/** A primary key the database assigns, in increasing order: the whole column definition after its name. */
	readonly serialKey: string;
}

/**
 * The SQL constructs that differ between the engines a store runs on. Stores write one SQL text and ask the dialect
 * for these pieces; they never branch on `name`. Every member renders SQL text, never values: parameters stay `?`,
 * and the Postgres driver numbers them.
 */
export interface StorageDialect {
	readonly name: StorageDialectName;
	readonly types: StorageDialectTypes;
	/** Appended after a `CREATE TABLE`'s closing parenthesis: `" STRICT"` on SQLite, `""` on Postgres. */
	readonly tableOptions: string;
	/** Like `tableOptions`, for a table keyed only by its primary key: `" STRICT, WITHOUT ROWID"` on SQLite. */
	readonly withoutRowidTableOptions: string;
	/** An expression: integer milliseconds since the epoch on the database's clock, at the time it is evaluated. */
	readonly nowMs: string;
	/** An expression: whole seconds since the epoch on the database's clock, rounded down. */
	readonly nowSeconds: string;
	/**
	 * Select-list items whose values change whenever any connection commits a write to the database, and the `FROM`
	 * clause they need (with a leading space; `""` when none). A change token built from them may change without a
	 * write, never the reverse: `SELECT ${columns}, (SELECT count(*) FROM t) AS rows${from}`.
	 */
	readonly changeMarkers: { readonly columns: string; readonly from: string };
	/** Whether `applyStorageMigrations` records applied versions in a ledger table (else steps are idempotent). */
	readonly versionedMigrations: boolean;
	/** The text at `path` (object keys) inside the JSON text in `column`; SQL `NULL` when absent. */
	jsonText(column: string, ...path: readonly string[]): string;
	/** A predicate: the JSON value at `path` inside `column` has `type`. */
	jsonHasType(type: StorageJsonType, column: string, ...path: readonly string[]): string;
	/** A predicate: `column` holds well-formed JSON text. */
	jsonValid(column: string): string;
	/**
	 * A table expression for `FROM`: the elements of the JSON array bound to `parameter`, as one column named `value`.
	 * On Postgres the values are text. Use it once per query and do not alias it.
	 */
	jsonValues(parameter: "?"): string;
	/** The larger of two values: scalar `MAX(a, b)` on SQLite, `GREATEST(a, b)` on Postgres. */
	greatest(a: string, b: string): string;
	/** The smaller of two values: scalar `MIN(a, b)` on SQLite, `LEAST(a, b)` on Postgres. */
	least(a: string, b: string): string;
	/** Appended to a `SELECT` in a `fenced` transaction: `""` on SQLite, whose transactions already serialize. */
	lockClause(kind: StorageLockKind): string;
	/**
	 * The column that orders a table's rows by insertion: `rowid` on SQLite, the identity column `row_order` on
	 * Postgres, which a table declares with `rowOrderColumn`.
	 */
	rowOrder(alias?: string): string;
	/**
	 * Appended to the column list of a `CREATE TABLE` whose rows a store orders by `rowOrder()`: `""` on SQLite, where
	 * `rowid` is implicit; `", row_order BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE"` on Postgres.
	 */
	readonly rowOrderColumn: string;
	/** A query that returns one row when `table` exists in the current database (or schema). */
	tableExists(table: string): SqliteStatement;
	/**
	 * An aggregate: the values of `expression` joined by `separator` (SQL text), in `orderBy` order. SQLite's
	 * `group_concat` takes the order of its input, so callers also feed it rows already ordered by `orderBy`.
	 */
	orderedConcat(expression: string, separator: string, orderBy: string): string;
	/** A query that returns one row `{ name, default_value }` when `table` has `column`. */
	columnExists(table: string, column: string): SqliteStatement;
}

const JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Path keys are identifiers written in store code; anything else is a programming error, never user input. */
function jsonPath(path: readonly string[]): readonly string[] {
	if (path.length === 0) throw new TypeError("A JSON path needs at least one key");
	for (const key of path) if (!JSON_KEY.test(key)) throw new TypeError(`Invalid JSON path key: ${key}`);
	return path;
}

function sqlitePath(path: readonly string[]): string {
	return `'$.${jsonPath(path).join(".")}'`;
}

function qualified(column: string, alias: string | undefined): string {
	return alias === undefined ? column : `${alias}.${column}`;
}

/** SQLite and libSQL: renders exactly the SQL the stores have always run, so schemas and statements stay unchanged. */
export const sqliteDialect: StorageDialect = Object.freeze({
	name: "sqlite",
	types: Object.freeze({
		int: "INTEGER",
		real: "REAL",
		text: "TEXT",
		blob: "BLOB",
		serialKey: "INTEGER PRIMARY KEY AUTOINCREMENT",
	}),
	tableOptions: " STRICT",
	withoutRowidTableOptions: " STRICT, WITHOUT ROWID",
	nowMs: "CAST(unixepoch('subsec') * 1000 AS INTEGER)",
	nowSeconds: "unixepoch()",
	changeMarkers: Object.freeze({
		columns: "data_version, total_changes() AS changes",
		from: " FROM pragma_data_version",
	}),
	versionedMigrations: false,
	jsonText: (column: string, ...path: readonly string[]) => `json_extract(${column}, ${sqlitePath(path)})`,
	jsonHasType: (type: StorageJsonType, column: string, ...path: readonly string[]) =>
		`json_type(${column}, ${sqlitePath(path)}) = '${type}'`,
	jsonValid: (column: string) => `json_valid(${column})`,
	jsonValues: (parameter: "?") => `json_each(${parameter})`,
	greatest: (a: string, b: string) => `MAX(${a}, ${b})`,
	least: (a: string, b: string) => `MIN(${a}, ${b})`,
	lockClause: (_kind: StorageLockKind) => "",
	rowOrder: (alias?: string) => qualified("rowid", alias),
	rowOrderColumn: "",
	tableExists: (table: string) => ({
		sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		params: [table],
	}),
	orderedConcat: (expression: string, separator: string, _orderBy: string) =>
		`group_concat(${expression}, ${separator})`,
	columnExists: (table: string, column: string) => ({
		sql: "SELECT name, dflt_value AS default_value FROM pragma_table_info(?) WHERE name = ?",
		params: [table, column],
	}),
});

const POSTGRES_JSON_TYPES: Readonly<Record<StorageJsonType, string>> = {
	null: "null",
	text: "string",
	object: "object",
	array: "array",
};

const POSTGRES_LOCKS: Readonly<Record<StorageLockKind, string>> = {
	update: " FOR UPDATE",
	share: " FOR SHARE",
	"update-skip-locked": " FOR UPDATE SKIP LOCKED",
};

function postgresJson(column: string, path: readonly string[], text: boolean): string {
	const keys = jsonPath(path);
	const operator = text ? ">>" : ">";
	return keys.length === 1
		? `((${column})::jsonb -${operator} '${keys[0]}')`
		: `((${column})::jsonb #${operator} '{${keys.join(",")}}')`;
}

/**
 * PostgreSQL (14 and later; `jsonValid` needs 16). Tables a store orders by `rowOrder()` carry an explicit identity
 * column, `row_order` (not `seq`, which several tables already use for their own sequence numbers).
 */
export const postgresDialect: StorageDialect = Object.freeze({
	name: "postgres",
	types: Object.freeze({
		int: "BIGINT",
		real: "DOUBLE PRECISION",
		text: "TEXT",
		blob: "BYTEA",
		serialKey: "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
	}),
	tableOptions: "",
	withoutRowidTableOptions: "",
	nowMs: "(floor(extract(epoch from clock_timestamp()) * 1000))::bigint",
	nowSeconds: "(floor(extract(epoch from clock_timestamp())))::bigint",
	changeMarkers: Object.freeze({ columns: "pg_current_snapshot()::text AS snapshot", from: "" }),
	versionedMigrations: true,
	jsonText: (column: string, ...path: readonly string[]) => postgresJson(column, path, true),
	jsonHasType: (type: StorageJsonType, column: string, ...path: readonly string[]) =>
		`jsonb_typeof${postgresJson(column, path, false)} = '${POSTGRES_JSON_TYPES[type]}'`,
	jsonValid: (column: string) => `((${column}) IS JSON)`,
	jsonValues: (parameter: "?") => `jsonb_array_elements_text((${parameter})::jsonb) AS json_values(value)`,
	greatest: (a: string, b: string) => `GREATEST(${a}, ${b})`,
	least: (a: string, b: string) => `LEAST(${a}, ${b})`,
	lockClause: (kind: StorageLockKind) => POSTGRES_LOCKS[kind],
	rowOrder: (alias?: string) => qualified("row_order", alias),
	rowOrderColumn: ", row_order BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE",
	tableExists: (table: string) => ({
		sql: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?",
		params: [table],
	}),
	orderedConcat: (expression: string, separator: string, orderBy: string) =>
		`string_agg(${expression}, ${separator} ORDER BY ${orderBy})`,
	columnExists: (table: string, column: string) => ({
		sql: "SELECT column_name AS name, column_default AS default_value FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?",
		params: [table, column],
	}),
});

/** The dialect a database speaks: its own, or SQLite's for a database that names none (every adapter before #4793). */
export function dialectOf(database: { readonly dialect?: StorageDialect }): StorageDialect {
	return database.dialect ?? sqliteDialect;
}
