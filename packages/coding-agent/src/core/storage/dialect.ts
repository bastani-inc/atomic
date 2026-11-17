import type { SqliteStatement } from "./database.js";

/** The database engines a store's SQL is written for. */
export type StorageDialectName = "sqlite" | "postgres";

/**
 * A row lock a `fenced` transaction takes on the rows it reads: see `StorageDialect.lockClause`. `key-share` excludes
 * only deleting the row or locking it `update`, not an update of its other columns.
 */
export type StorageLockKind = "update" | "share" | "update-skip-locked" | "key-share";

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
	/**
	 * Like `serialKey`, without its promise never to reuse the key of a deleted last row: SQLite's `INTEGER PRIMARY KEY`.
	 */
	readonly rowKey: string;
}

/**
 * The SQL constructs that differ between the engines a store runs on. Stores write one SQL text and ask the dialect
 * for these pieces; they never branch on `name`. Every member renders SQL text, never values: parameters stay `?`,
 * and the Postgres driver numbers them.
 */
export interface StorageDialect {
	readonly name: StorageDialectName;
	readonly types: StorageDialectTypes;
	/**
	 * Appended after a text column's type so it compares and sorts in UTF-8 byte order, whatever the database's
	 * collation: `""` on SQLite, whose default `BINARY` collation already does; `' COLLATE "C"'` on Postgres.
	 */
	readonly byteOrderCollation: string;
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
	textByteLength(expression: string): string;
	/**
	 * A table expression for `FROM`: the elements of the JSON array in `source`, a bound parameter (`?`) or a column whose
	 * JSON text the store wrote, as one column named `value`. On Postgres the values are text. Use it once per query and
	 * do not alias it.
	 */
	jsonValues(source: string): string;
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
	/**
	 * The longest identifier the database keeps whole, in bytes: 63 on Postgres, which truncates longer ones; undefined
	 * on SQLite, which has no limit. A store that adds its own words to a prefixed name keeps them short where it is set.
	 */
	readonly maxIdentifierBytes: number | undefined;
	/**
	 * The name the database knows `name` by. Every name fits on SQLite. On Postgres a name longer than
	 * `maxIdentifierBytes` becomes its head and a hash of the whole name, so it is never truncated or merged with
	 * another; every shorter name is itself. The dialect's catalog probes and trigger statements use it, so they agree.
	 */
	identifier(name: string): string;
	/** A query that returns one row when `table` exists in the current database (or schema). */
	tableExists(table: string): SqliteStatement;
	/**
	 * An aggregate: the values of `expression` joined by `separator` (SQL text), in `orderBy` order. SQLite's
	 * `group_concat` takes the order of its input, so callers also feed it rows already ordered by `orderBy`.
	 */
	orderedConcat(expression: string, separator: string, orderBy: string): string;
	/** A query that returns one row `{ name, default_value }` when `table` has `column`. */
	columnExists(table: string, column: string): SqliteStatement;
	/**
	 * The statements, `;`-terminated, that create `trigger` unless it exists (SQLite) or create or replace it
	 * (Postgres: a plpgsql function `<name>_fn` and a `FOR EACH ROW` trigger that runs it). Run them with `exec`.
	 */
	renderTrigger(trigger: StorageTrigger): string;
	/** Drops the trigger `name` on `table`, optionally removing its PostgreSQL function when it is retired. */
	dropTrigger(name: string, table: string, dropFunction?: boolean): string;
	/**
	 * A query that returns a row `{ name }` for each of `names` that is a table, index or trigger in the database, named
	 * as in `names`.
	 */
	schemaObjects(names: readonly string[]): SqliteStatement;
	/**
	 * The type of the JSON value at `path` in `column`, as SQLite's `json_type` names it (`'null'`, `'true'`, `'false'`,
	 * `'integer'`, `'real'`, `'text'`, `'array'`, `'object'`); SQL `NULL` when absent.
	 */
	jsonType(column: string, ...path: readonly string[]): string;
	/**
	 * A table expression for `FROM`, named `alias`: one row per element of the JSON array at `path` in `source`. A
	 * later `source` of `{ column, element: alias }` reads inside each element. SQLite also iterates an object's values.
	 */
	jsonEach(source: StorageJsonSource, alias: string, ...path: readonly string[]): string;
	/** The JSON value at `path` in `source`, as SQLite's `json_extract` returns it; text on Postgres. */
	jsonAt(source: StorageJsonSource, ...path: readonly string[]): string;
	/** A predicate: the JSON value at `path` in `source` is a string. */
	jsonAtIsText(source: StorageJsonSource, ...path: readonly string[]): string;
	/** A predicate: `needle` occurs in the text `haystack`. */
	contains(haystack: string, needle: string): string;
	/** A predicate: `a` and `b` differ, a `NULL` differing from every value but `NULL`. */
	isDistinct(a: string, b: string): string;
	/** A predicate: `a` and `b` are equal, or both `NULL`: SQLite's `a IS b`. */
	isNotDistinct(a: string, b: string): string;
	/**
	 * A JSON object of `entries` (each a key, an identifier, and a SQL value), as text when selected. A text value is
	 * a JSON string, a value from `jsonObject`, `jsonArray` or `jsonGroupArray` is nested as JSON. Postgres must know
	 * each value's type: cast a bound parameter, as `CAST(? AS ${types.int})`.
	 */
	jsonObject(entries: readonly (readonly [key: string, value: string])[]): string;
	/** A JSON array of `values`, typed as for `jsonObject`. */
	jsonArray(values: readonly string[]): string;
	/**
	 * An aggregate: a JSON array of `expression` over the group's rows, in `orderBy` order when given; `[]` for no
	 * rows. SQLite's `json_group_array` takes the order of its input, so callers also feed it rows already ordered.
	 */
	jsonGroupArray(expression: string, orderBy?: string): string;
	/**
	 * Like `jsonText`, in a form an index expression may use: Postgres indexes only immutable expressions, which
	 * `jsonText`'s read is not. Reads the same text for every key whose value has no NUL or surrogate escape.
	 */
	jsonIndexText(column: string, ...path: readonly string[]): string;
	/** A query that returns `{ foreign_keys: 1 }` when the connection enforces foreign keys, as Postgres always does. */
	readonly foreignKeysCheck: SqliteStatement;
	/** A trigger statement (`StorageTrigger.statements`) that aborts the statement that fired it with `message`. */
	abort(message: string): string;
	/** Boolean literals that conditions compare and combine: `1` and `0` on SQLite, `true` and `false` on Postgres. */
	readonly literals: { readonly true: string; readonly false: string };
	/** The predicate `predicate` as an integer, 1 or 0, for an integer column. */
	flag(predicate: string): string;
	/** Inserts the rows of `select` into `table`'s `columns`, skipping each row that violates a unique constraint. */
	insertOrIgnore(table: string, columns: readonly string[], select: string): string;
	/**
	 * Inserts the rows of `select` into `table`'s `columns`, each replacing the row with its `key` (the primary key).
	 * `table` must have no other unique constraint, and no row of `select` may repeat a key.
	 */
	insertOrReplace(table: string, columns: readonly string[], key: readonly string[], select: string): string;
}

/** A row trigger: `timing` `event` on `table`, it runs `statements` in order for each row where `when` holds. */
export interface StorageTrigger {
	readonly name: string;
	readonly table: string;
	readonly timing: "BEFORE" | "AFTER";
	/** `INSERT`, `DELETE`, `UPDATE`, or `UPDATE OF <column>`. */
	readonly event: string;
	/** A condition on the row, as `NEW` and `OLD`. */
	readonly when?: string;
	/** Statements that refer to the row as `NEW` and `OLD`. */
	readonly statements: readonly string[];
}

/** JSON text a query reads: the column `column`, or, with `element`, an element `jsonEach` named so yields from it. */
export interface StorageJsonSource {
	readonly column: string;
	readonly element?: string;
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

/** `json_extract`'s path inside `source`: from the document's root, or from the element `jsonEach` yields. */
function sqliteSourcePath(source: StorageJsonSource, path: readonly string[]): string {
	const keys = `.${jsonPath(path).join(".")}`;
	return source.element === undefined ? `'$${keys}'` : `${source.element}.fullkey || '${keys}'`;
}

const sqliteJsonAt = (source: StorageJsonSource, ...path: readonly string[]) =>
	`json_extract(${source.column}, ${sqliteSourcePath(source, path)})`;

/** A SQL string literal of `text`, which store code writes (never user input). */
const sqlString = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** `json_object`'s arguments: each key, an identifier, as a string literal, then its value. */
const jsonEntries = (entries: readonly (readonly [string, string])[]) =>
	entries.map(([key, value]) => `${sqlString(jsonPath([key])[0]!)}, ${value}`).join(", ");

const columnList = (columns: readonly string[]) => `(${columns.join(", ")})`;

const namedPlaceholders = (names: readonly string[]) => names.map(() => "?").join(", ");

/** SQLite and libSQL: renders exactly the SQL the stores have always run, so schemas and statements stay unchanged. */
export const sqliteDialect: StorageDialect = Object.freeze({
	name: "sqlite",
	textByteLength: (expression: string) => `length(CAST(${expression} AS BLOB))`,
	types: Object.freeze({
		int: "INTEGER",
		real: "REAL",
		text: "TEXT",
		blob: "BLOB",
		serialKey: "INTEGER PRIMARY KEY AUTOINCREMENT",
		rowKey: "INTEGER PRIMARY KEY",
	}),
	byteOrderCollation: "",
	tableOptions: " STRICT",
	withoutRowidTableOptions: " STRICT, WITHOUT ROWID",
	nowMs: "CAST(round((julianday('now') - 2440587.5) * 86400000) AS INTEGER)",
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
	jsonValues: (source: string) => `json_each(${source})`,
	greatest: (a: string, b: string) => `MAX(${a}, ${b})`,
	least: (a: string, b: string) => `MIN(${a}, ${b})`,
	lockClause: (_kind: StorageLockKind) => "",
	rowOrder: (alias?: string) => qualified("rowid", alias),
	rowOrderColumn: "",
	maxIdentifierBytes: undefined,
	identifier: (name: string) => name,
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
	renderTrigger: ({ name, table, timing, event, when, statements }: StorageTrigger) =>
		`CREATE TRIGGER IF NOT EXISTS ${name} ${timing} ${event} ON ${table}${when === undefined ? "" : ` WHEN ${when}`} BEGIN ${statements.join("; ")}; END;`,
	dropTrigger: (name: string, _table: string) => `DROP TRIGGER IF EXISTS ${name}`,
	schemaObjects: (names: readonly string[]) => ({
		sql: `SELECT name FROM sqlite_schema WHERE name IN (${namedPlaceholders(names)})`,
		params: [...names],
	}),
	jsonType: (column: string, ...path: readonly string[]) => `json_type(${column}, ${sqlitePath(path)})`,
	jsonEach: (source: StorageJsonSource, alias: string, ...path: readonly string[]) =>
		`json_each(${source.column}, ${sqliteSourcePath(source, path)}) AS ${alias}`,
	jsonAt: sqliteJsonAt,
	jsonAtIsText: (source: StorageJsonSource, ...path: readonly string[]) =>
		`typeof(${sqliteJsonAt(source, ...path)}) = 'text'`,
	contains: (haystack: string, needle: string) => `instr(${haystack}, ${needle}) > 0`,
	isDistinct: (a: string, b: string) => `${a} IS NOT ${b}`,
	isNotDistinct: (a: string, b: string) => `${a} IS ${b}`,
	jsonObject: (entries: readonly (readonly [string, string])[]) => `json_object(${jsonEntries(entries)})`,
	jsonArray: (values: readonly string[]) => `json_array(${values.join(", ")})`,
	jsonGroupArray: (expression: string, _orderBy?: string) => `json_group_array(${expression})`,
	jsonIndexText: (column: string, ...path: readonly string[]) => `json_extract(${column}, ${sqlitePath(path)})`,
	foreignKeysCheck: Object.freeze({ sql: "PRAGMA foreign_keys", params: [] }),
	abort: (message: string) => `SELECT RAISE(ABORT, ${sqlString(message)})`,
	literals: Object.freeze({ true: "1", false: "0" }),
	flag: (predicate: string) => predicate,
	insertOrIgnore: (table: string, columns: readonly string[], select: string) =>
		`INSERT OR IGNORE INTO ${table} ${columnList(columns)} ${select}`,
	insertOrReplace: (table: string, columns: readonly string[], _key: readonly string[], select: string) =>
		`INSERT OR REPLACE INTO ${table} ${columnList(columns)} ${select}`,
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
	"key-share": " FOR KEY SHARE",
};

/**
 * A `\u0000` or UTF-16 surrogate escape in JSON text, after an even number of backslashes, so not the text `\u…` after
 * an escaped `\`.
 */
const POSTGRES_UNREPRESENTABLE_ESCAPE = String.raw`'(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})'`;

/**
 * The JSON text in `column` as `jsonb`. SQLite reads any well-formed JSON, but Postgres's `jsonb` (and its `json`
 * operators) reject a whole document with a `\u0000` escape or a lone surrogate escape anywhere in it, even outside
 * the value read. Such a document reads with each NUL and surrogate escape as U+FFFD, so a write whose JSON carries
 * one never fails on a query or trigger that reads it, and every other value reads as on SQLite. A document without
 * an escape, or that `jsonb` accepts, reads unchanged.
 */
function postgresJsonb(column: string): string {
	return String.raw`(CASE WHEN strpos(${column}, '\u') = 0 OR pg_input_is_valid(${column}, 'jsonb') THEN ${column} ELSE regexp_replace(${column}, ${POSTGRES_UNREPRESENTABLE_ESCAPE}, '\1\\ufffd', 'g') END)::jsonb`;
}

/** The value at `path` in the `jsonb` expression `document`: as text with `text`, else as `jsonb`. */
function postgresJson(document: string, path: readonly string[], text: boolean): string {
	const keys = jsonPath(path);
	const operator = text ? ">>" : ">";
	return keys.length === 1
		? `(${document} -${operator} '${keys[0]}')`
		: `(${document} #${operator} '{${keys.join(",")}}')`;
}

/** The `jsonb` document `source` names: its column's JSON text, or the `value` of the element `jsonEach` yields. */
const postgresDocument = (source: StorageJsonSource) =>
	source.element === undefined ? postgresJsonb(source.column) : `${source.element}.value`;

/** Postgres truncates longer identifiers, so two long names could become one. Names are ASCII. */
const POSTGRES_IDENTIFIER_BYTES = 63;
/**
 * Hex digits of the hash that ends a shortened Postgres identifier: the whole 64 bits. Names that share their head
 * differ only in it, and 32 bits of FNV-1a made two such names under a valid prefix one (#5219).
 */
const POSTGRES_IDENTIFIER_HASH_DIGITS = 16;
/** Hex digits of the 32-bit hash earlier builds ended a shortened identifier with, which an upgrade drops (#5219). */
const LEGACY_POSTGRES_IDENTIFIER_HASH_DIGITS = 8;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = (1n << 64n) - 1n;

/**
 * 64-bit FNV-1a of `name`'s characters: computed in plain JavaScript so storage modules stay free of runtime-specific
 * imports. Names are ASCII, written in store code.
 */
function fnv1a64(name: string): bigint {
	let hash = FNV_OFFSET;
	for (let index = 0; index < name.length; index++) hash = ((hash ^ BigInt(name.charCodeAt(index))) * FNV_PRIME) & U64;
	return hash;
}

function postgresIdentifier(name: string): string {
	if (name.length <= POSTGRES_IDENTIFIER_BYTES) return name;
	const hash = fnv1a64(name).toString(16).padStart(POSTGRES_IDENTIFIER_HASH_DIGITS, "0");
	return `${name.slice(0, POSTGRES_IDENTIFIER_BYTES - POSTGRES_IDENTIFIER_HASH_DIGITS - 1)}_${hash}`;
}

/**
 * The name an earlier build gave `name` when it did not fit (its first 54 characters and the 64-bit hash folded to 32
 * bits), or undefined when it fits. Two names could get the same one, so a trigger installed under it may be missing
 * (#5219): installing a trigger drops it, so no trigger an earlier build installed stays beside its replacement.
 */
function legacyPostgresIdentifier(name: string): string | undefined {
	if (name.length <= POSTGRES_IDENTIFIER_BYTES) return undefined;
	const hash = fnv1a64(name);
	const folded = ((hash ^ (hash >> 32n)) & 0xffffffffn)
		.toString(16)
		.padStart(LEGACY_POSTGRES_IDENTIFIER_HASH_DIGITS, "0");
	return `${name.slice(0, POSTGRES_IDENTIFIER_BYTES - LEGACY_POSTGRES_IDENTIFIER_HASH_DIGITS - 1)}_${folded}`;
}

/** Drops the trigger an earlier build installed as `name` on `table` under its shortened name, if it had one (#5219). */
function dropLegacyTrigger(name: string, table: string): string {
	const legacy = legacyPostgresIdentifier(name);
	return legacy === undefined ? "" : `;\nDROP TRIGGER IF EXISTS ${legacy} ON ${table}`;
}

function postgresSchemaObjects(names: readonly string[]): SqliteStatement {
	const physical = names.map(postgresIdentifier);
	if (physical.every((name, index) => name === names[index]))
		return {
			sql: `SELECT relname AS name FROM pg_catalog.pg_class WHERE relnamespace = current_schema()::regnamespace AND relname IN (${namedPlaceholders(names)}) UNION ALL SELECT tgname AS name FROM pg_catalog.pg_trigger JOIN pg_catalog.pg_class ON pg_class.oid = tgrelid WHERE relnamespace = current_schema()::regnamespace AND NOT tgisinternal AND tgname IN (${namedPlaceholders(names)})`,
			params: [...names, ...names],
		};
	// A shortened name is found by the name Postgres knows, and reported by the one asked for.
	return {
		sql: `SELECT v.name FROM (VALUES ${names.map(() => "(?, ?)").join(", ")}) AS v(name, physical) WHERE v.physical IN (SELECT relname::text FROM pg_catalog.pg_class WHERE relnamespace = current_schema()::regnamespace) OR v.physical IN (SELECT tgname::text FROM pg_catalog.pg_trigger JOIN pg_catalog.pg_class ON pg_class.oid = tgrelid WHERE relnamespace = current_schema()::regnamespace AND NOT tgisinternal)`,
		params: names.flatMap((name, index) => [name, physical[index]!]),
	};
}

function postgresTrigger({ name, table, timing, event, when, statements }: StorageTrigger): string {
	const fn = postgresIdentifier(`${name}_fn`);
	const body = statements.map((statement) => `${statement};`).join(" ");
	const row = timing === "AFTER" ? "NULL" : event === "DELETE" ? "OLD" : "NEW";
	// The function an earlier build named otherwise (#5219), once no trigger runs it; one another trigger of that build
	// still runs is dropped when that trigger is installed again.
	const legacyFn = legacyPostgresIdentifier(`${name}_fn`);
	const dropLegacyFn =
		legacyFn === undefined
			? ""
			: `\nDO $legacy$ BEGIN DROP FUNCTION IF EXISTS ${legacyFn}(); EXCEPTION WHEN dependent_objects_still_exist THEN NULL; END $legacy$;`;
	return `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $trigger$ BEGIN ${when === undefined ? body : `IF (${when}) THEN ${body} END IF;`} RETURN ${row}; END $trigger$${dropLegacyTrigger(name, table)};
CREATE OR REPLACE TRIGGER ${postgresIdentifier(name)} ${timing} ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}();${dropLegacyFn}`;
}

/** `value`'s type as SQLite's `json_type` names it, for a `jsonb` expression. */
function postgresSqliteJsonType(value: string): string {
	return `(CASE jsonb_typeof(${value}) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (${value})::text WHEN 'number' THEN CASE WHEN (${value})::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(${value}) END)`;
}

/**
 * PostgreSQL (14 and later; `jsonValid` and every JSON read need 16, for `IS JSON` and `pg_input_is_valid`). Tables
 * a store orders by `rowOrder()` carry an explicit identity column, `row_order` (not `seq`, which several tables
 * already use for their own sequence numbers).
 */
export const postgresDialect: StorageDialect = Object.freeze({
	name: "postgres",
	textByteLength: (expression: string) => `octet_length(${expression})`,
	types: Object.freeze({
		int: "BIGINT",
		real: "DOUBLE PRECISION",
		text: "TEXT",
		blob: "BYTEA",
		serialKey: "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
		rowKey: "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
	}),
	byteOrderCollation: ' COLLATE "C"',
	tableOptions: "",
	withoutRowidTableOptions: "",
	nowMs: "(floor(extract(epoch from clock_timestamp()) * 1000))::bigint",
	nowSeconds: "(floor(extract(epoch from clock_timestamp())))::bigint",
	changeMarkers: Object.freeze({ columns: "pg_current_snapshot()::text AS snapshot", from: "" }),
	versionedMigrations: true,
	jsonText: (column: string, ...path: readonly string[]) => postgresJson(postgresJsonb(column), path, true),
	jsonHasType: (type: StorageJsonType, column: string, ...path: readonly string[]) =>
		`jsonb_typeof${postgresJson(postgresJsonb(column), path, false)} = '${POSTGRES_JSON_TYPES[type]}'`,
	jsonValid: (column: string) => `((${column}) IS JSON)`,
	jsonValues: (source: string) => `jsonb_array_elements_text((${source})::jsonb) AS json_values(value)`,
	greatest: (a: string, b: string) => `GREATEST(${a}, ${b})`,
	least: (a: string, b: string) => `LEAST(${a}, ${b})`,
	lockClause: (kind: StorageLockKind) => POSTGRES_LOCKS[kind],
	rowOrder: (alias?: string) => qualified("row_order", alias),
	rowOrderColumn: ", row_order BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE",
	maxIdentifierBytes: POSTGRES_IDENTIFIER_BYTES,
	identifier: postgresIdentifier,
	tableExists: (table: string) => ({
		// The catalog, not information_schema, which hides a table the role has no privilege on: a role missing a grant
		// must not take an existing table for one to create (#5218).
		sql: "SELECT c.relname AS name FROM pg_catalog.pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname = ?",
		params: [postgresIdentifier(table)],
	}),
	orderedConcat: (expression: string, separator: string, orderBy: string) =>
		`string_agg(${expression}, ${separator} ORDER BY ${orderBy})`,
	columnExists: (table: string, column: string) => ({
		sql: "SELECT column_name AS name, column_default AS default_value FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?",
		params: [postgresIdentifier(table), column],
	}),
	renderTrigger: postgresTrigger,
	dropTrigger: (name: string, table: string, dropFunction = false) =>
		`DROP TRIGGER IF EXISTS ${postgresIdentifier(name)} ON ${table}${dropLegacyTrigger(name, table)}${dropFunction ? `;\nDROP FUNCTION IF EXISTS ${postgresIdentifier(`${name}_fn`)}()` : ""}`,
	schemaObjects: postgresSchemaObjects,
	jsonType: (column: string, ...path: readonly string[]) =>
		postgresSqliteJsonType(postgresJson(postgresJsonb(column), path, false)),
	jsonEach: (source: StorageJsonSource, alias: string, ...path: readonly string[]) =>
		`jsonb_path_query(${postgresDocument(source)}, '$.${jsonPath(path)
			.map((key) => `"${key}"`)
			.join(".")}[*]') AS ${alias}(value)`,
	jsonAt: (source: StorageJsonSource, ...path: readonly string[]) =>
		postgresJson(postgresDocument(source), path, true),
	jsonAtIsText: (source: StorageJsonSource, ...path: readonly string[]) =>
		`jsonb_typeof${postgresJson(postgresDocument(source), path, false)} = 'string'`,
	contains: (haystack: string, needle: string) => `strpos(${haystack}, ${needle}) > 0`,
	isDistinct: (a: string, b: string) => `${a} IS DISTINCT FROM ${b}`,
	isNotDistinct: (a: string, b: string) => `${a} IS NOT DISTINCT FROM ${b}`,
	jsonObject: (entries: readonly (readonly [string, string])[]) => `json_build_object(${jsonEntries(entries)})`,
	jsonArray: (values: readonly string[]) => `json_build_array(${values.join(", ")})`,
	jsonGroupArray: (expression: string, orderBy?: string) =>
		`COALESCE(json_agg(${expression}${orderBy === undefined ? "" : ` ORDER BY ${orderBy}`}), '[]'::json)`,
	jsonIndexText: (column: string, ...path: readonly string[]) =>
		postgresJson(
			`(regexp_replace(${column}, ${POSTGRES_UNREPRESENTABLE_ESCAPE}, '\\1\\\\ufffd', 'g'))::jsonb`,
			path,
			true,
		),
	foreignKeysCheck: Object.freeze({ sql: "SELECT 1 AS foreign_keys", params: [] }),
	abort: (message: string) => `RAISE EXCEPTION ${sqlString(message)}`,
	literals: Object.freeze({ true: "true", false: "false" }),
	flag: (predicate: string) => `(${predicate})::int`,
	insertOrIgnore: (table: string, columns: readonly string[], select: string) =>
		`INSERT INTO ${table} ${columnList(columns)} ${select} ON CONFLICT DO NOTHING`,
	insertOrReplace: (table: string, columns: readonly string[], key: readonly string[], select: string) =>
		`INSERT INTO ${table} ${columnList(columns)} ${select} ON CONFLICT ${columnList(key)} DO UPDATE SET ${columns
			.filter((column) => !key.includes(column))
			.map((column) => `${column} = excluded.${column}`)
			.join(", ")}`,
});

/** The dialect a database speaks: its own, or SQLite's for a database that names none (every adapter before #4793). */
export function dialectOf(database: { readonly dialect?: StorageDialect }): StorageDialect {
	return database.dialect ?? sqliteDialect;
}
