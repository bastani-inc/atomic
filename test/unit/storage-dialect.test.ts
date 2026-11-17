import assert from "node:assert/strict";
import { join } from "node:path";
import {
	dialectOf,
	type FencedPathName,
	fencedPath,
	fencedPathAudit,
	openNodeSqliteDatabase,
	postgresDialect,
	type SqliteDatabase,
	type SqliteRow,
	type SqliteStatement,
	type StorageDialect,
	sqliteDialect,
} from "@bastani/atomic/storage";
import { afterAll, beforeAll, describe, test } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Postgres reads JSON text as `jsonb`, with each NUL and surrogate escape as U+FFFD when `jsonb` rejects the document,
 * so a document with a `\u0000` or a lone surrogate never fails a query or trigger that reads it.
 */
const jsonb = (column: string) =>
	String.raw`(CASE WHEN strpos(${column}, '\u') = 0 OR pg_input_is_valid(${column}, 'jsonb') THEN ${column} ELSE regexp_replace(${column}, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb`;

/** Each construct of spec §3.1, rendered by both dialects. SQLite's column is the SQL the stores ran before #4793. */
const renderings: readonly (readonly [string, (dialect: StorageDialect) => string, string, string])[] = [
	["int", (d) => d.types.int, "INTEGER", "BIGINT"],
	["real", (d) => d.types.real, "REAL", "DOUBLE PRECISION"],
	["text", (d) => d.types.text, "TEXT", "TEXT"],
	["blob", (d) => d.types.blob, "BLOB", "BYTEA"],
	[
		"serialKey",
		(d) => d.types.serialKey,
		"INTEGER PRIMARY KEY AUTOINCREMENT",
		"BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
	],
	["byteOrderCollation", (d) => d.byteOrderCollation, "", ' COLLATE "C"'],
	["tableOptions", (d) => d.tableOptions, " STRICT", ""],
	["withoutRowidTableOptions", (d) => d.withoutRowidTableOptions, " STRICT, WITHOUT ROWID", ""],
	[
		"nowMs",
		(d) => d.nowMs,
		"CAST(round((julianday('now') - 2440587.5) * 86400000) AS INTEGER)",
		"(floor(extract(epoch from clock_timestamp()) * 1000))::bigint",
	],
	["nowSeconds", (d) => d.nowSeconds, "unixepoch()", "(floor(extract(epoch from clock_timestamp())))::bigint"],
	[
		"changeMarkers",
		(d) => `${d.changeMarkers.columns}|${d.changeMarkers.from}`,
		"data_version, total_changes() AS changes| FROM pragma_data_version",
		"pg_current_snapshot()::text AS snapshot|",
	],
	[
		"jsonText",
		(d) => d.jsonText("descriptor", "scope"),
		"json_extract(descriptor, '$.scope')",
		`(${jsonb("descriptor")} ->> 'scope')`,
	],
	[
		"jsonText path",
		(d) => d.jsonText("r.entry_json", "restore", "to"),
		"json_extract(r.entry_json, '$.restore.to')",
		`(${jsonb("r.entry_json")} #>> '{restore,to}')`,
	],
	[
		"jsonHasType",
		(d) => d.jsonHasType("text", "payload", "kind"),
		"json_type(payload, '$.kind') = 'text'",
		`jsonb_typeof(${jsonb("payload")} -> 'kind') = 'string'`,
	],
	[
		"jsonHasType path",
		(d) => d.jsonHasType("object", "payload", "a", "b"),
		"json_type(payload, '$.a.b') = 'object'",
		`jsonb_typeof(${jsonb("payload")} #> '{a,b}') = 'object'`,
	],
	["jsonValid", (d) => d.jsonValid("body"), "json_valid(body)", "((body) IS JSON)"],
	[
		"jsonValues",
		(d) => d.jsonValues("?"),
		"json_each(?)",
		"jsonb_array_elements_text((?)::jsonb) AS json_values(value)",
	],
	["greatest", (d) => d.greatest("a", "b"), "MAX(a, b)", "GREATEST(a, b)"],
	["least", (d) => d.least("a", "b"), "MIN(a, b)", "LEAST(a, b)"],
	[
		"orderedConcat",
		(d) => d.orderedConcat("text_json", "','", "seq"),
		"group_concat(text_json, ',')",
		"string_agg(text_json, ',' ORDER BY seq)",
	],
	["lockClause update", (d) => d.lockClause("update"), "", " FOR UPDATE"],
	["lockClause share", (d) => d.lockClause("share"), "", " FOR SHARE"],
	["lockClause skip", (d) => d.lockClause("update-skip-locked"), "", " FOR UPDATE SKIP LOCKED"],
	["lockClause key share (#5102)", (d) => d.lockClause("key-share"), "", " FOR KEY SHARE"],
	["rowOrder", (d) => d.rowOrder(), "rowid", "row_order"],
	["rowOrder alias", (d) => d.rowOrder("e"), "e.rowid", "e.row_order"],
	["rowOrderColumn", (d) => d.rowOrderColumn, "", ", row_order BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE"],
	["versionedMigrations", (d) => String(d.versionedMigrations), "false", "true"],
	[
		"renderTrigger",
		(d) =>
			d.renderTrigger({
				name: "t_refs",
				table: "t",
				timing: "AFTER",
				event: "UPDATE OF body",
				when: "NEW.k = 1",
				statements: ["DELETE FROM r WHERE k = OLD.k", "INSERT INTO r (k) VALUES (NEW.k)"],
			}),
		"CREATE TRIGGER IF NOT EXISTS t_refs AFTER UPDATE OF body ON t WHEN NEW.k = 1 BEGIN DELETE FROM r WHERE k = OLD.k; INSERT INTO r (k) VALUES (NEW.k); END;",
		"CREATE OR REPLACE FUNCTION t_refs_fn() RETURNS trigger LANGUAGE plpgsql AS $trigger$ BEGIN IF (NEW.k = 1) THEN DELETE FROM r WHERE k = OLD.k; INSERT INTO r (k) VALUES (NEW.k); END IF; RETURN NULL; END $trigger$;\nCREATE OR REPLACE TRIGGER t_refs AFTER UPDATE OF body ON t FOR EACH ROW EXECUTE FUNCTION t_refs_fn();",
	],
	[
		"renderTrigger before delete",
		(d) =>
			d.renderTrigger({ name: "t_d", table: "t", timing: "BEFORE", event: "DELETE", statements: ["DELETE FROM r"] }),
		"CREATE TRIGGER IF NOT EXISTS t_d BEFORE DELETE ON t BEGIN DELETE FROM r; END;",
		"CREATE OR REPLACE FUNCTION t_d_fn() RETURNS trigger LANGUAGE plpgsql AS $trigger$ BEGIN DELETE FROM r; RETURN OLD; END $trigger$;\nCREATE OR REPLACE TRIGGER t_d BEFORE DELETE ON t FOR EACH ROW EXECUTE FUNCTION t_d_fn();",
	],
	[
		"renderTrigger before insert",
		(d) =>
			d.renderTrigger({ name: "t_i", table: "t", timing: "BEFORE", event: "INSERT", statements: ["DELETE FROM r"] }),
		"CREATE TRIGGER IF NOT EXISTS t_i BEFORE INSERT ON t BEGIN DELETE FROM r; END;",
		"CREATE OR REPLACE FUNCTION t_i_fn() RETURNS trigger LANGUAGE plpgsql AS $trigger$ BEGIN DELETE FROM r; RETURN NEW; END $trigger$;\nCREATE OR REPLACE TRIGGER t_i BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION t_i_fn();",
	],
	[
		"dropTrigger",
		(d) => d.dropTrigger("t_refs", "t"),
		"DROP TRIGGER IF EXISTS t_refs",
		"DROP TRIGGER IF EXISTS t_refs ON t",
	],
	[
		"dropTrigger and its retired function (#5327)",
		(d) => d.dropTrigger("t_refs", "t", true),
		"DROP TRIGGER IF EXISTS t_refs",
		"DROP TRIGGER IF EXISTS t_refs ON t;\nDROP FUNCTION IF EXISTS t_refs_fn()",
	],
	[
		"schemaObjects",
		(d) => {
			const { sql, params } = d.schemaObjects(["a", "b"]);
			return `${sql}|${params.join(",")}`;
		},
		"SELECT name FROM sqlite_schema WHERE name IN (?, ?)|a,b",
		"SELECT relname AS name FROM pg_catalog.pg_class WHERE relnamespace = current_schema()::regnamespace AND relname IN (?, ?) UNION ALL SELECT tgname AS name FROM pg_catalog.pg_trigger JOIN pg_catalog.pg_class ON pg_class.oid = tgrelid WHERE relnamespace = current_schema()::regnamespace AND NOT tgisinternal AND tgname IN (?, ?)|a,b,a,b",
	],
	[
		"jsonType",
		(d) => d.jsonType("p", "a", "b"),
		"json_type(p, '$.a.b')",
		`(CASE jsonb_typeof((${jsonb("p")} #> '{a,b}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((${jsonb("p")} #> '{a,b}'))::text WHEN 'number' THEN CASE WHEN ((${jsonb("p")} #> '{a,b}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((${jsonb("p")} #> '{a,b}')) END)`,
	],
	[
		"jsonEach",
		(d) => d.jsonEach({ column: "r.p" }, "s", "a", "b"),
		"json_each(r.p, '$.a.b') AS s",
		`jsonb_path_query(${jsonb("r.p")}, '$."a"."b"[*]') AS s(value)`,
	],
	[
		"jsonEach element",
		(d) => d.jsonEach({ column: "r.p", element: "s" }, "l", "chain"),
		"json_each(r.p, s.fullkey || '.chain') AS l",
		`jsonb_path_query(s.value, '$."chain"[*]') AS l(value)`,
	],
	[
		"jsonAt",
		(d) => d.jsonAt({ column: "r.p" }, "a", "b"),
		"json_extract(r.p, '$.a.b')",
		`(${jsonb("r.p")} #>> '{a,b}')`,
	],
	[
		"jsonAt element",
		(d) => d.jsonAt({ column: "r.p", element: "l" }, "patch"),
		"json_extract(r.p, l.fullkey || '.patch')",
		"(l.value ->> 'patch')",
	],
	[
		"jsonAtIsText",
		(d) => d.jsonAtIsText({ column: "r.p", element: "l" }, "patch"),
		"typeof(json_extract(r.p, l.fullkey || '.patch')) = 'text'",
		"jsonb_typeof(l.value -> 'patch') = 'string'",
	],
	["contains", (d) => d.contains("p", "'x'"), "instr(p, 'x') > 0", "strpos(p, 'x') > 0"],
	["isDistinct", (d) => d.isDistinct("a", "'b'"), "a IS NOT 'b'", "a IS DISTINCT FROM 'b'"],
	["isNotDistinct", (d) => d.isNotDistinct("worker", "?"), "worker IS ?", "worker IS NOT DISTINCT FROM ?"],
	[
		"jsonObject",
		(d) =>
			d.jsonObject([
				["seq", "seq"],
				["lastSeq", "CAST(? AS BIGINT)"],
			]),
		"json_object('seq', seq, 'lastSeq', CAST(? AS BIGINT))",
		"json_build_object('seq', seq, 'lastSeq', CAST(? AS BIGINT))",
	],
	["jsonArray", (d) => d.jsonArray(["seq", "key"]), "json_array(seq, key)", "json_build_array(seq, key)"],
	[
		"jsonGroupArray",
		(d) => d.jsonGroupArray("o.generation"),
		"json_group_array(o.generation)",
		"COALESCE(json_agg(o.generation), '[]'::json)",
	],
	[
		"jsonGroupArray ordered",
		(d) => d.jsonGroupArray("x", "seq"),
		"json_group_array(x)",
		"COALESCE(json_agg(x ORDER BY seq), '[]'::json)",
	],
	[
		"jsonIndexText",
		(d) => d.jsonIndexText("descriptor", "scope"),
		"json_extract(descriptor, '$.scope')",
		String.raw`((regexp_replace(descriptor, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g'))::jsonb ->> 'scope')`,
	],
	["foreignKeysCheck", (d) => d.foreignKeysCheck.sql, "PRAGMA foreign_keys", "SELECT 1 AS foreign_keys"],
	["abort", (d) => d.abort("it's"), "SELECT RAISE(ABORT, 'it''s')", "RAISE EXCEPTION 'it''s'"],
	["literals", (d) => `${d.literals.true}|${d.literals.false}`, "1|0", "true|false"],
	["flag", (d) => d.flag("a = 1"), "a = 1", "(a = 1)::int"],
	[
		"insertOrIgnore",
		(d) => d.insertOrIgnore("t", ["a", "b"], "SELECT 1, 2"),
		"INSERT OR IGNORE INTO t (a, b) SELECT 1, 2",
		"INSERT INTO t (a, b) SELECT 1, 2 ON CONFLICT DO NOTHING",
	],
	[
		"insertOrReplace",
		(d) => d.insertOrReplace("t", ["a", "b", "c"], ["a"], "SELECT 1, 2, 3"),
		"INSERT OR REPLACE INTO t (a, b, c) SELECT 1, 2, 3",
		"INSERT INTO t (a, b, c) SELECT 1, 2, 3 ON CONFLICT (a) DO UPDATE SET b = excluded.b, c = excluded.c",
	],
	[
		"tableExists",
		(d) => JSON.stringify(d.tableExists("team_runs")),
		JSON.stringify({
			sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
			params: ["team_runs"],
		}),
		JSON.stringify({
			sql: "SELECT c.relname AS name FROM pg_catalog.pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname = ?",
			params: ["team_runs"],
		}),
	],
	[
		"columnExists",
		(d) => JSON.stringify(d.columnExists("team_runs", "created_at")),
		JSON.stringify({
			sql: "SELECT name, dflt_value AS default_value FROM pragma_table_info(?) WHERE name = ?",
			params: ["team_runs", "created_at"],
		}),
		JSON.stringify({
			sql: "SELECT column_name AS name, column_default AS default_value FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?",
			params: ["team_runs", "created_at"],
		}),
	],
];

describe("storage dialects render each SQLite-specific construct (#4793)", () => {
	for (const [construct, render, sqlite, postgres] of renderings) {
		test(`${construct} (#4793)`, () => {
			assert.equal(render(sqliteDialect), sqlite);
			assert.equal(render(postgresDialect), postgres);
		});
	}
});

test("JSON paths accept only identifier keys and at least one (#4793)", () => {
	for (const dialect of [sqliteDialect, postgresDialect]) {
		assert.throws(() => dialect.jsonText("c"), { name: "TypeError", message: "A JSON path needs at least one key" });
		assert.throws(() => dialect.jsonText("c", "a'); DROP TABLE t; --"), {
			name: "TypeError",
			message: "Invalid JSON path key: a'); DROP TABLE t; --",
		});
		assert.throws(() => dialect.jsonHasType("text", "c", "a.b"), TypeError);
		assert.throws(() => dialect.jsonText("c", "1a"), TypeError);
	}
	assert.equal(sqliteDialect.jsonText("c", "_a1"), "json_extract(c, '$._a1')");
});

test("a Postgres name longer than an identifier ends in a hash of the whole name, never truncated (#4793)", () => {
	const trigger = { table: "t", timing: "AFTER", event: "INSERT", statements: ["DELETE FROM r"] } as const;
	// Every name that fits renders as it always has.
	assert.equal(postgresDialect.identifier("n".repeat(63)), "n".repeat(63));
	assert.match(postgresDialect.renderTrigger({ ...trigger, name: "n".repeat(60) }), /FUNCTION n{60}_fn\(\)/);
	assert.match(postgresDialect.renderTrigger({ ...trigger, name: "n".repeat(60) }), /TRIGGER n{60} AFTER/);
	const long = `${"n".repeat(60)}_insert`;
	const shortened = postgresDialect.identifier(long);
	assert.equal(shortened.length, 63);
	assert.match(shortened, /^n{46}_[0-9a-f]{16}$/);
	assert.notEqual(
		shortened,
		postgresDialect.identifier(`${"n".repeat(60)}_update`),
		"names that share a head stay apart",
	);
	const rendered = postgresDialect.renderTrigger({ ...trigger, name: long });
	assert.ok(rendered.includes(`TRIGGER ${shortened} AFTER`));
	assert.ok(rendered.includes(`FUNCTION ${postgresDialect.identifier(`${long}_fn`)}()`));
	assert.match(
		postgresDialect.dropTrigger(long, "t"),
		new RegExp(`^DROP TRIGGER IF EXISTS ${shortened} ON t;\nDROP TRIGGER IF EXISTS n{54}_[0-9a-f]{8} ON t$`),
	);
	assert.deepEqual(postgresDialect.tableExists(long).params, [shortened]);
	assert.deepEqual(postgresDialect.columnExists(long, "c").params, [shortened, "c"]);
	const probe = postgresDialect.schemaObjects(["a", long]);
	assert.deepEqual(probe.params, ["a", "a", long, shortened]);
	assert.match(probe.sql, /^SELECT v\.name FROM \(VALUES \(\?, \?\), \(\?, \?\)\) AS v\(name, physical\)/);
	// SQLite keeps every name whole.
	assert.equal(sqliteDialect.identifier(long), long);
	assert.match(sqliteDialect.renderTrigger({ ...trigger, name: long }), new RegExp(`${long} AFTER`));
	assert.equal(sqliteDialect.maxIdentifierBytes, undefined);
	assert.equal(postgresDialect.maxIdentifierBytes, 63);
});

test("fencedPath mints the audited name itself (#4793)", () => {
	// The registry is empty until a path is audited, so no name type-checks yet; the cast stands in for one.
	const name = "pool.commit" as FencedPathName;
	assert.equal(fencedPath(name), "pool.commit");
	assert.equal(fencedPathAudit(name), undefined);
});

test("dialectOf names SQLite for a database without a dialect (#4793)", () => {
	assert.equal(dialectOf({}), sqliteDialect);
	assert.equal(dialectOf({ dialect: postgresDialect }), postgresDialect);
	assert.equal(sqliteDialect.name, "sqlite");
	assert.equal(postgresDialect.name, "postgres");
	assert.ok(Object.isFrozen(sqliteDialect) && Object.isFrozen(sqliteDialect.types));
});

describe("the SQLite dialect runs on SQLite (#4793)", () => {
	let directory: string;
	let database: SqliteDatabase;
	const d = sqliteDialect;
	beforeAll(async () => {
		directory = makeTempDirectory("storage-dialect-");
		database = await openNodeSqliteDatabase(join(directory, "dialect.sqlite"));
		await database.exec(
			`CREATE TABLE items (id ${d.types.serialKey}, body ${d.types.text} NOT NULL, size ${d.types.int}, score ${d.types.real}, data ${d.types.blob})${d.tableOptions};` +
				`CREATE TABLE keyed (k ${d.types.text} PRIMARY KEY)${d.withoutRowidTableOptions}`,
		);
		for (const body of ['{"a":{"b":"x"},"n":1}', '{"a":{"b":"y"},"n":2}', "not json"])
			await database.run("INSERT INTO items (body, size) VALUES (?, ?)", body, body.length);
	});
	afterAll(async () => {
		await database.close();
		removeTempDirectory(directory);
	});

	test("JSON, ordering, scalar and aggregate constructs (#4793)", async () => {
		const rows = await database.all<SqliteRow & { b: string; n: number }>(
			`SELECT ${d.jsonText("body", "a", "b")} AS b, ${d.greatest("size", "5")} AS n FROM items WHERE ${d.jsonValid("body")} AND ${d.jsonHasType("object", "body", "a")} ORDER BY ${d.rowOrder("items")}${d.lockClause("update")}`,
		);
		assert.deepEqual(rows, [
			{ b: "x", n: 21 },
			{ b: "y", n: 21 },
		]);
		const picked = await database.all(
			`SELECT id FROM items WHERE id IN (SELECT value FROM ${d.jsonValues("?")}) ORDER BY id`,
			"[1, 3]",
		);
		assert.deepEqual(picked, [{ id: 1 }, { id: 3 }]);
		const joined = await database.get(
			`SELECT ${d.orderedConcat("id", "','", "id")} AS ids, ${d.least("1", "2")} AS low FROM (SELECT id FROM items ORDER BY id DESC)`,
		);
		assert.deepEqual(joined, { ids: "3,2,1", low: 1 });
	});

	test("clocks agree with the host clock (#4793)", async () => {
		const before = Date.now();
		const row = await database.get<SqliteRow & { ms: number; s: number }>(
			`SELECT ${d.nowMs} AS ms, ${d.nowSeconds} AS s`,
		);
		assert.ok(row && Number.isInteger(row.ms) && row.ms >= before - 1000 && row.ms <= Date.now() + 1000);
		assert.equal(row.s, Math.floor(row.ms / 1000));
	});

	test("catalog probes find tables and columns, with defaults (#4793)", async () => {
		const probe = async (statement: SqliteStatement) => database.get(statement.sql, ...statement.params);
		assert.deepEqual(await probe(d.tableExists("items")), { name: "items" });
		assert.equal(await probe(d.tableExists("missing")), undefined);
		await database.exec("ALTER TABLE keyed ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
		assert.deepEqual(await probe(d.columnExists("keyed", "created_at")), { name: "created_at", default_value: "0" });
		assert.deepEqual(await probe(d.columnExists("items", "body")), { name: "body", default_value: null });
		assert.equal(await probe(d.columnExists("items", "missing")), undefined);
		const markers = await database.get(`SELECT ${d.changeMarkers.columns}${d.changeMarkers.from}`);
		assert.deepEqual(Object.keys(markers ?? {}), ["data_version", "changes"]);
	});
});
