import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

interface SqliteDb { run(sql: string): void; close(): void }
interface BunSqliteModule { Database: new (path: string) => SqliteDb }
function sqlite(): BunSqliteModule | undefined { try { return createRequire(import.meta.url)("bun:sqlite") as BunSqliteModule; } catch { return undefined; } }

const tempDirs: string[] = [];
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "atomic-resource-hardening-")); tempDirs.push(dir); return dir; }

afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("resource selector hardening", () => {
	it("rejects raw SQLite pragma table-valued functions and quoted sqlite internals", async () => {
		const mod = sqlite(); if (!mod) return;
		const dir = await tempDir(); const dbPath = join(dir, "data.sqlite"); const db = new mod.Database(dbPath);
		try { db.run("create table t (id integer primary key)"); } finally { db.close(); }
		const read = createReadToolDefinition(dir);
		await expect(read.execute("raw-pragma-tvfc", { path: "data.sqlite?q=select * from pragma_table_info('t')" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid raw SQLite query/);
		await expect(read.execute("raw-sqlite-splice", { path: "data.sqlite?q=select \"sqlite\"\"_master\" from t" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid raw SQLite query/);
	});

	it("rejects malformed zip central directory offsets during selective writes", async () => {
		const dir = await tempDir(); const archivePath = join(dir, "bad.zip");
		const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(1000, 16);
		await writeFile(archivePath, eocd);
		await expect(createWriteToolDefinition(dir).execute("bad-zip-write", { path: "bad.zip:new.txt", content: "new" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid zip (archive|entry bounds)/);
	});
});
