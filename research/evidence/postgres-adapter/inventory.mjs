#!/usr/bin/env node
// SQLite-specific construct inventory for the PostgreSQL storage adapter spec (#4793).
//   node research/evidence/postgres-adapter/inventory.mjs [--json results/inventory.json]
// Counts matches in shipped source (tests, vendored code and docs excluded), per store and per file. Counts are of
// occurrences in source text, comments included, as the issue counted them; `codeOnly` drops lines that are comments.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const STORES = {
	"sessions (adapter)": [
		"packages/coding-agent/src/core/storage/session/sql-session-store.ts",
		"packages/coding-agent/src/core/storage/session/legacy-session-store.ts",
	],
	"snapshot blobs and workspace leases (adapter)": [
		"packages/coding-agent/src/core/worktree-snapshot/blob-store.ts",
		"packages/coding-agent/src/core/workspace/lease.ts",
	],
	"run journal (adapter)": [
		"packages/workflows/src/durable/journal/sql-run-journal.ts",
		"packages/workflows/src/durable/journal/legacy-journal-tables.ts",
		"packages/coding-agent/src/core/storage/journal-adoption.ts",
	],
	"worker pool, shared pool and fleet (adapter)": [
		"packages/workflows/src/durable/journal/sql-pool-queue.ts",
		"packages/workflows/src/durable/journal/sql-shared-pool.ts",
		"packages/workflows/src/durable/journal/sql-pool-usage.ts",
		"packages/workflows/src/durable/journal/pool-stage-usage.ts",
		"packages/workflows/src/durable/journal/pool-mutations.ts",
		"packages/workflows/src/durable/journal/pool-checkpoint-index.ts",
		"packages/workflows/src/durable/journal/pool-remote-journal.ts",
		"packages/workflows/src/durable/journal/sql-fleet.ts",
		"packages/workflows/src/workers/pool-session-store.ts",
		"packages/workflows/src/workers/resource-admission.ts",
	],
	"Intercom multi-node routing (adapter)": [
		"packages/intercom/broker/database-wake-up-bus.ts",
		"packages/intercom/broker/sql-held-send-store.ts",
		"packages/intercom/broker/sql-known-session-store.ts",
		"packages/intercom/broker/sql-lease-store.ts",
		"packages/intercom/broker/sql-outbox-store.ts",
		"packages/intercom/broker/sql-pending-ask-store.ts",
		"packages/intercom/broker/sql-released-ask-store.ts",
		"packages/intercom/broker/sql-restoring-reservation-store.ts",
		"packages/intercom/broker/sql-sent-message-authority.ts",
	],
	"local-file only (never on an adapter)": [
		"packages/coding-agent/src/core/storage/journal-catalog.ts",
		"packages/coding-agent/src/core/storage/journal-transfer.ts",
		"packages/coding-agent/src/core/storage/node-sqlite.ts",
		"packages/coding-agent/src/core/storage/write-ahead-log.ts",
		"packages/intercom/broker/away-asks.ts",
		"packages/intercom/broker/delivered-message-cache.ts",
	],
	"facade, drivers, status and conformance": [
		"packages/coding-agent/src/core/storage/sqlite-facade.ts",
		"packages/coding-agent/src/core/storage/storage-status.ts",
		"packages/coding-agent/src/core/storage/testing.ts",
		"packages/storage-libsql/libsql.js",
	],
};

/** Construct → [regex, Postgres equivalent]. */
export const CONSTRUCTS = {
	rowid: [/\b_?rowid_?\b/gi, "explicit `seq BIGINT GENERATED ALWAYS AS IDENTITY` column; order and page by it"],
	"json_extract / ->>": [/\bjson_extract\s*\(|->>/g, "`(col::jsonb ->> 'field')`, or a generated/real column for indexed fields"],
	json_each: [/\bjson_each\s*\(/g, "`= ANY($n::text[])` / `unnest($n::text[])`, or `jsonb_array_elements_text($n::jsonb)`"],
	"other json_*() / json()": [/\bjson(_(object|array|group_array|group_object|type|valid|patch|set|insert|remove|quote))?\s*\(/g, "`jsonb_build_object`, `jsonb_agg`, `jsonb_typeof`, `jsonb_set`, `col::jsonb`"],
	"INSERT OR IGNORE": [/\bINSERT\s+OR\s+IGNORE\b/gi, "`INSERT … ON CONFLICT DO NOTHING`"],
	"INSERT OR REPLACE / REPLACE INTO": [/\bINSERT\s+OR\s+REPLACE\b|\bREPLACE\s+INTO\b/gi, "`INSERT … ON CONFLICT (key) DO UPDATE SET …` (REPLACE deletes then inserts, firing cascades; the upsert does not)"],
	"ON CONFLICT upsert": [/\bON\s+CONFLICT\b/gi, "same syntax; Postgres requires a conflict target for DO UPDATE and a unique index (not a partial expression) to match it"],
	"BEGIN IMMEDIATE / EXCLUSIVE": [/\bBEGIN\s+(IMMEDIATE|EXCLUSIVE)\b/gi, "`BEGIN` (READ COMMITTED) plus `SELECT … FOR UPDATE` on the fence row; SKIP LOCKED for the queue"],
	AUTOINCREMENT: [/\bAUTOINCREMENT\b/gi, "`BIGINT GENERATED ALWAYS AS IDENTITY` (never reuses; gaps on rollback, as AUTOINCREMENT)"],
	"INTEGER PRIMARY KEY (rowid alias)": [/\bINTEGER\s+PRIMARY\s+KEY\b/gi, "`BIGINT PRIMARY KEY` (+ IDENTITY when the code relies on implicit assignment)"],
	PRAGMA: [/\bPRAGMA\b|\bpragma_\w+\s*\(/gi, "none for foreign_keys/journal_mode/busy_timeout (always on / n/a / `lock_timeout`); `information_schema.columns` for `pragma_table_info`"],
	"sqlite_master / sqlite_schema": [/\bsqlite_(master|schema|sequence)\b/gi, "`information_schema.tables` / `to_regclass()`"],
	"STRICT / WITHOUT ROWID tables": [/\)\s*(STRICT|WITHOUT\s+ROWID)\b/gi, "drop the clause; Postgres types are strict already"],
	RETURNING: [/\bRETURNING\b/g, "same syntax (SQLite ≥ 3.35); Postgres also allows it in CTEs"],
	"SAVEPOINT / RELEASE": [/\bSAVEPOINT\b|\bRELEASE\s+\w/g, "same syntax"],
	"changes() / last_insert_rowid()": [/\bchanges\s*\(\s*\)|\blast_insert_rowid\s*\(/gi, "`WITH ins AS (INSERT … RETURNING 1) … EXISTS (SELECT 1 FROM ins)`, or `RETURNING id`"],
	"unixepoch / julianday clock": [/\bunixepoch\s*\(|\bjulianday\s*\(|\bstrftime\s*\(/gi, "`(extract(epoch from clock_timestamp()) * 1000)::bigint` (the dialect's `now()`)"],
	"scalar MAX(a, b) / MIN(a, b)": [/\b(MAX|MIN)\s*\([^()]*,[^()]*\)/g, "`GREATEST(a, b)` / `LEAST(a, b)`"],
	"IFNULL / IIF / instr / group_concat": [/\b(IFNULL|IIF|instr|group_concat)\s*\(/gi, "`COALESCE`, `CASE`, `strpos`, `string_agg`"],
	"boolean as integer (comparison in arithmetic)": [/[+-]\s*\(\s*[\w.]+\s*(!=|<>|=|<|>)\s*[\w.]+\s*\)/g, "`(a <> b)::int`"],
	"? placeholders (statements)": [/`[^`]*\?[^`]*`/g, "`$1 … $n`: translated mechanically by the driver, never by the stores"],
	"INTEGER columns (int64 in SQLite)": [/\bINTEGER\b/g, "`BIGINT`: Postgres INTEGER is 32-bit and overflows on epoch milliseconds"],
	"BLOB columns": [/\bBLOB\b/g, "`BYTEA`"],
	"SQLITE_BUSY / busy handling": [/SQLITE_BUSY|busy_timeout|busyTimeout/g, "SQLSTATE 40001/40P01 (retry), 55P03 `lock_not_available` under `lock_timeout`"],
	"LIKE / GLOB": [/\b(NOT\s+)?(LIKE|GLOB)\s+[?'`$]/g, "SQLite LIKE is ASCII case-insensitive, Postgres LIKE is case-sensitive: use `ILIKE` or exact match; GLOB → `LIKE` with escaped wildcards"],
};

const commentLine = /^\s*(\/\/|\*|\/\*)/;
const result = { stores: {}, totals: {} };
for (const [store, files] of Object.entries(STORES)) {
	result.stores[store] = {};
	for (const file of files) {
		const text = readFileSync(join(root, file), "utf8");
		const code = text.split("\n").filter((line) => !commentLine.test(line)).join("\n");
		const counts = {};
		for (const [name, [pattern]] of Object.entries(CONSTRUCTS)) {
			const all = text.match(pattern)?.length ?? 0;
			const codeOnly = code.match(pattern)?.length ?? 0;
			if (all > 0) counts[name] = { all, codeOnly };
			result.totals[name] ??= { all: 0, codeOnly: 0, files: 0, adapterFiles: 0 };
			result.totals[name].all += all;
			result.totals[name].codeOnly += codeOnly;
			if (all > 0) result.totals[name].files++;
			if (all > 0 && store.includes("(adapter)")) result.totals[name].adapterFiles++;
		}
		result.stores[store][file] = counts;
	}
}

const lines = ["| Construct | All | Code only | Files (adapter stores) | Postgres equivalent |", "| --- | --- | --- | --- | --- |"];
for (const [name, [, equivalent]] of Object.entries(CONSTRUCTS)) {
	const t = result.totals[name];
	lines.push(`| ${name} | ${t.all} | ${t.codeOnly} | ${t.files} (${t.adapterFiles}) | ${equivalent} |`);
}
lines.push("", "| Store | File | Constructs (code-only count) |", "| --- | --- | --- |");
for (const [store, files] of Object.entries(result.stores))
	for (const [file, counts] of Object.entries(files))
		lines.push(`| ${store} | \`${file.replace(/^packages\//, "")}\` | ${Object.entries(counts).map(([n, c]) => `${n} ${c.codeOnly}`).join("; ") || "—"} |`);
process.stdout.write(`${lines.join("\n")}\n`);
const jsonIndex = process.argv.indexOf("--json");
if (jsonIndex > 0) {
	const out = process.argv[jsonIndex + 1];
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}
