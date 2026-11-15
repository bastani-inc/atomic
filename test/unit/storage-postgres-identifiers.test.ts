import assert from "node:assert/strict";
import { test } from "vitest";
import { postgresDialect } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { physicalIdentifiers } from "../../packages/storage-postgres/postgres.js";

/**
 * How the PostgreSQL adapter sends names longer than Postgres keeps whole (#4793): each unquoted identifier past 63
 * bytes in SQL becomes `postgresDialect.identifier` of it; values, quoted identifiers and comments never change.
 */

const L = `t_${"a".repeat(62)}_tbl`;
const H = postgresDialect.identifier(L);
const M = `m_${"b".repeat(62)}_idx`;
const HM = postgresDialect.identifier(M);

const cases: readonly (readonly [string, string, string])[] = [
	["a statement without a long word", "SELECT 1 FROM t WHERE a = ?", "SELECT 1 FROM t WHERE a = ?"],
	["a name of exactly 63 bytes", `SELECT 1 FROM ${"x".repeat(63)}`, `SELECT 1 FROM ${"x".repeat(63)}`],
	[
		"a name of 64 bytes",
		`SELECT 1 FROM ${"x".repeat(64)}`,
		`SELECT 1 FROM ${postgresDialect.identifier("x".repeat(64))}`,
	],
	[
		"every long name, wherever it is",
		`CREATE INDEX ${M} ON ${L}(a);SELECT ${L}.a FROM ${L}`,
		`CREATE INDEX ${HM} ON ${H}(a);SELECT ${H}.a FROM ${H}`,
	],
	["a name at the very start and end", `${L} ${L}`, `${H} ${H}`],
	["a name after a parameter", `SELECT ?, ${L}`, `SELECT ?, ${H}`],
	["a name after a cast", `SELECT a::${L}`, `SELECT a::${H}`],
	[
		"a word that continues a shorter one is not split",
		`SELECT a${L}`,
		`SELECT ${postgresDialect.identifier(`a${L}`)}`,
	],
	["a word with a dollar is not a generated name", `SELECT x$${L} FROM ${L}`, `SELECT x$${L} FROM ${H}`],
	["a word starting with a digit is a number", `SELECT 1${L} FROM ${L}`, `SELECT 1${L} FROM ${H}`],
	["a word with a non-ASCII character", `SELECT é${L} FROM ${L}`, `SELECT é${L} FROM ${H}`],
	["a string literal", `SELECT '${L}' FROM ${L}`, `SELECT '${L}' FROM ${H}`],
	["a doubled quote inside a string", `SELECT 'it''s ${L}' FROM ${L}`, `SELECT 'it''s ${L}' FROM ${H}`],
	["a backslash in a standard string ends nothing", `SELECT 'a\\' FROM ${L}`, `SELECT 'a\\' FROM ${H}`],
	["an escape string's backslash quote", `SELECT E'q\\' ${L}' FROM ${L}`, `SELECT E'q\\' ${L}' FROM ${H}`],
	["a lowercase escape string", `SELECT e'q\\' ${L}' FROM ${L}`, `SELECT e'q\\' ${L}' FROM ${H}`],
	[
		"a word ending in e before a quote is not an escape string",
		`SELECT x FROM t WHERE ae'\\' = ${L}`,
		`SELECT x FROM t WHERE ae'\\' = ${H}`,
	],
	["an unterminated string", `SELECT ${L}, '${L}`, `SELECT ${H}, '${L}`],
	["a quoted identifier", `SELECT "${L}" FROM ${L}`, `SELECT "${L}" FROM ${H}`],
	["an unterminated quoted identifier", `SELECT ${L} "${L}`, `SELECT ${H} "${L}`],
	["a line comment", `SELECT 1 -- ${L} '\nFROM ${L}`, `SELECT 1 -- ${L} '\nFROM ${H}`],
	["a line comment at the end", `SELECT ${L} -- ${L}`, `SELECT ${H} -- ${L}`],
	["a minus is not a comment", `SELECT a - ${L}`, `SELECT a - ${H}`],
	["a block comment", `SELECT /* ${L} */ 1 FROM ${L}`, `SELECT /* ${L} */ 1 FROM ${H}`],
	["a nested block comment", `SELECT /* a /* b */ ${L} ' */ 1 FROM ${L}`, `SELECT /* a /* b */ ${L} ' */ 1 FROM ${H}`],
	["an unterminated block comment", `SELECT ${L} /* ${L}`, `SELECT ${H} /* ${L}`],
	["a slash is not a comment", `SELECT a / ${L}`, `SELECT a / ${H}`],
	["a dollar-quoted value", `SELECT $$${L}$$ FROM ${L}`, `SELECT $$${L}$$ FROM ${H}`],
	["a tagged dollar-quoted value", `SELECT $q$ $$ ${L} $$ $q$, ${L}`, `SELECT $q$ $$ ${L} $$ $q$, ${H}`],
	["an unterminated dollar quote", `SELECT ${L}, $$${L}`, `SELECT ${H}, $$${L}`],
	["a numbered parameter is not a dollar quote", `SELECT $1, ${L}`, `SELECT $1, ${H}`],
	[
		"a function body",
		`CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $trigger$ BEGIN DELETE FROM ${L} WHERE k = '${L}'; RETURN NULL; END $trigger$;\nCREATE OR REPLACE TRIGGER ${M} AFTER INSERT ON ${L} FOR EACH ROW EXECUTE FUNCTION f();`,
		`CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $trigger$ BEGIN DELETE FROM ${H} WHERE k = '${L}'; RETURN NULL; END $trigger$;\nCREATE OR REPLACE TRIGGER ${HM} AFTER INSERT ON ${H} FOR EACH ROW EXECUTE FUNCTION f();`,
	],
	[
		"a function created without replace, with a value nested in its body",
		`create function f() returns int language sql as $f$ SELECT length($x$${L}$x$) FROM ${L} $f$`,
		`create function f() returns int language sql as $f$ SELECT length($x$${L}$x$) FROM ${H} $f$`,
	],
	[
		"a procedure with a comment in its header",
		`CREATE PROCEDURE p() /* a /* b */ c */ -- x\n LANGUAGE plpgsql AS $$ BEGIN DELETE FROM ${L}; END $$`,
		`CREATE PROCEDURE p() /* a /* b */ c */ -- x\n LANGUAGE plpgsql AS $$ BEGIN DELETE FROM ${H}; END $$`,
	],
	["a DO block", `DO $$ BEGIN DELETE FROM ${L}; END $$`, `DO $$ BEGIN DELETE FROM ${H}; END $$`],
	[
		"a DO block with a language",
		`do language plpgsql $$ BEGIN DELETE FROM ${L}; END $$`,
		`do language plpgsql $$ BEGIN DELETE FROM ${H}; END $$`,
	],
	["a DO block's unterminated body", `DO $$ DELETE FROM ${L}`, `DO $$ DELETE FROM ${H}`],
	["a value in a later statement", `DO $$ BEGIN END $$; SELECT $$${L}$$`, `DO $$ BEGIN END $$; SELECT $$${L}$$`],
	["a semicolon in a string does not end the statement", `SELECT ';' || $$${L}$$`, `SELECT ';' || $$${L}$$`],
	["a value whose statement mentions AS", `SELECT 1 AS $$${L}$$`, `SELECT 1 AS $$${L}$$`],
	[
		"a value in an insert of a function's text",
		`INSERT INTO t VALUES ('CREATE FUNCTION f() AS', $$${L}$$)`,
		`INSERT INTO t VALUES ('CREATE FUNCTION f() AS', $$${L}$$)`,
	],
	[
		"a function body after AS and a comment",
		`CREATE FUNCTION f() AS /* c */ $$${L}$$`,
		`CREATE FUNCTION f() AS /* c */ $$${H}$$`,
	],
	[
		"a function body that is not the AS clause",
		`CREATE FUNCTION f(a text DEFAULT $$${L}$$) AS $$${L}$$`,
		`CREATE FUNCTION f(a text DEFAULT $$${L}$$) AS $$${H}$$`,
	],
	["a word ending in DO is not DO", `UNDO $$${L}$$`, `UNDO $$${L}$$`],
];

for (const [name, sql, expected] of cases)
	test(`${name} (#4793)`, () => {
		assert.equal(physicalIdentifiers(sql), expected);
		assert.equal(physicalIdentifiers(expected), expected, "mapping again changes nothing");
	});
