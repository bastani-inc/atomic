import assert from "node:assert/strict";
import { join } from "node:path";
import {
	dialectOf,
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
		"CAST(unixepoch('subsec') * 1000 AS INTEGER)",
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
		"((descriptor)::jsonb ->> 'scope')",
	],
	[
		"jsonText path",
		(d) => d.jsonText("r.entry_json", "restore", "to"),
		"json_extract(r.entry_json, '$.restore.to')",
		"((r.entry_json)::jsonb #>> '{restore,to}')",
	],
	[
		"jsonHasType",
		(d) => d.jsonHasType("text", "payload", "kind"),
		"json_type(payload, '$.kind') = 'text'",
		"jsonb_typeof((payload)::jsonb -> 'kind') = 'string'",
	],
	[
		"jsonHasType path",
		(d) => d.jsonHasType("object", "payload", "a", "b"),
		"json_type(payload, '$.a.b') = 'object'",
		"jsonb_typeof((payload)::jsonb #> '{a,b}') = 'object'",
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
	["rowOrder", (d) => d.rowOrder(), "rowid", "row_order"],
	["rowOrder alias", (d) => d.rowOrder("e"), "e.rowid", "e.row_order"],
	["rowOrderColumn", (d) => d.rowOrderColumn, "", ", row_order BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE"],
	["versionedMigrations", (d) => String(d.versionedMigrations), "false", "true"],
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
		assert.throws(() => dialect.jsonText("c"), TypeError);
		assert.throws(() => dialect.jsonText("c", "a'); DROP TABLE t; --"), TypeError);
		assert.throws(() => dialect.jsonHasType("text", "c", "a.b"), TypeError);
		assert.throws(() => dialect.jsonText("c", "1a"), TypeError);
	}
	assert.equal(sqliteDialect.jsonText("c", "_a1"), "json_extract(c, '$._a1')");
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
