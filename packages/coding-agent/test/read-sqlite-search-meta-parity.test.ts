import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

interface SqliteQuery { all(...params: Array<string | number>): Record<string, string | number | null>[]; run(...params: Array<string | number>): void }
interface SqliteDb { run(sql: string, ...params: Array<string | number>): void; query(sql: string): SqliteQuery; close(): void }
interface BunSqliteModule { Database: new (path: string) => SqliteDb }
function sqlite(): BunSqliteModule | undefined { try { return createRequire(import.meta.url)("bun:sqlite") as BunSqliteModule; } catch { return undefined; } }
const text = (result: { content: Array<{ type: string; text?: string }> }): string => result.content.map((item) => item.text ?? "").join("\n");
const tempDirs: string[] = [];
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "atomic-read-sqlite-parity-")); tempDirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("sqlite and metadata parity", () => {
	it("uses query default limit 20 and caps to 500", async () => {
		const mod = sqlite(); if (!mod) return;
		const dir = await tempDir(); const dbPath = join(dir, "data.sqlite"); const db = new mod.Database(dbPath);
		try { db.run("create table t (id integer primary key, body text)"); for (let i = 1; i <= 600; i++) db.run("insert into t values (?, ?)", i, `row${i}`); } finally { db.close(); }
		const read = createReadToolDefinition(dir);
		const defaulted = text(await read.execute("default-limit", { path: "data.sqlite:t?order=id" }, undefined, undefined, {} as never));
		expect((defaulted.match(/"id":/g) ?? []).length).toBe(20);
		const capped = text(await read.execute("capped-limit", { path: "data.sqlite:t?limit=1000&order=id" }, undefined, undefined, {} as never));
		expect((capped.match(/"id":/g) ?? []).length).toBe(500);
	});

	it("lists tables with row counts", async () => {
		const mod = sqlite(); if (!mod) return;
		const dir = await tempDir(); const dbPath = join(dir, "data.sqlite"); const db = new mod.Database(dbPath);
		try { db.run("create table alpha (id integer primary key)"); db.run("create table beta (id integer primary key)"); } finally { db.close(); }
		const listing = text(await createReadToolDefinition(dir).execute("list-tables", { path: "data.sqlite" }, undefined, undefined, {} as never));
		expect(listing).toContain("alpha");
		expect(listing).toContain("beta");
	});

	it("caps raw q rows and exposes read metadata", async () => {
		const mod = sqlite(); if (!mod) return;
		const dir = await tempDir(); const dbPath = join(dir, "data.sqlite"); const db = new mod.Database(dbPath);
		try { db.run("create table t (id integer primary key)"); for (let i = 1; i <= 1500; i++) db.run("insert into t values (?)", i); } finally { db.close(); }
		const raw = text(await createReadToolDefinition(dir).execute("raw-q", { path: "data.sqlite?q=select * from t" }, undefined, undefined, {} as never));
		expect((raw.match(/"id":/g) ?? []).length).toBeLessThanOrEqual(1000);
		await expect(createReadToolDefinition(dir).execute("raw-attach", { path: "data.sqlite?q=ATTACH DATABASE 'x' AS x" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid raw SQLite query/);
		await expect(createReadToolDefinition(dir).execute("raw-master", { path: "data.sqlite?q=select * from sqlite_master" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid raw SQLite query/);
		// Double-quoted identifiers must be scanned for the sqlite_ prefix too
		// (the validator previously skipped content inside quotes).
		await expect(createReadToolDefinition(dir).execute("raw-quoted-master", { path: "data.sqlite?q=select * from \"sqlite_master\"" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid raw SQLite query/);
		await expect(createReadToolDefinition(dir).execute("raw-quoted-attach", { path: "data.sqlite?q=select * from \"ATTACH\"" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid raw SQLite query/);
	});

	it("validates SQLite where clauses and write columns like oh-my-pi", async () => {
		const mod = sqlite(); if (!mod) return;
		const dir = await tempDir(); const dbPath = join(dir, "data.sqlite"); const db = new mod.Database(dbPath);
		try { db.run("create table users (id integer primary key, name text)"); db.run("insert into users values (1, 'Ada')"); } finally { db.close(); }
		const read = createReadToolDefinition(dir);
		expect(text(await read.execute("where-quoted", { path: "data.sqlite:users?where=name%3D'LIMIT'" }, undefined, undefined, {} as never))).not.toContain("Invalid SQLite where");
		await expect(read.execute("where-intersect", { path: "data.sqlite:users?where=1%3D1%20INTERSECT%20SELECT%201" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid SQLite where/);
		await expect(createWriteToolDefinition(dir).execute("unknown-column", { path: "data.sqlite:users:1", content: "{missing:'nope'}" }, undefined, undefined, {} as never)).rejects.toThrow(/no column named/);
	});

	it("propagates read/search/find meta details", async () => {
		const mod = sqlite(); if (!mod) return;
		const dir = await tempDir(); const dbPath = join(dir, "data.sqlite"); const db = new mod.Database(dbPath);
		try { db.run("create table t (id integer primary key, body text)"); db.run("insert into t values (1, 'needle')"); } finally { db.close(); }
		const sqliteRead = await createReadToolDefinition(dir).execute("read-sqlite-meta", { path: "data.sqlite:t" }, undefined, undefined, {} as never);
		expect(sqliteRead.details?.meta?.source).toContain("data.sqlite");
		const search = await createSearchToolDefinition(dir).execute("search-meta", { pattern: "needle", paths: [] }, undefined, undefined, {} as never);
		expect(search.details?.meta?.source).toBeTruthy();
		const find = await createFindToolDefinition(dir).execute("find-meta", { paths: ["."] }, undefined, undefined, {} as never);
		expect(find.details?.meta?.limits?.resultLimit).toBeGreaterThan(0);
	});
});
