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

function zipWithDataDescriptor(): Buffer {
	const name = Buffer.from("old.txt"), data = Buffer.from("old"), descriptor = Buffer.alloc(16);
	descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(data.length, 8); descriptor.writeUInt32LE(data.length, 12);
	const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0008, 6); local.writeUInt16LE(name.length, 26);
	const localRecord = Buffer.concat([local, name, data, descriptor]);
	const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0008, 8); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
	const centralRecord = Buffer.concat([central, name]);
	const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(centralRecord.length, 12); eocd.writeUInt32LE(localRecord.length, 16);
	return Buffer.concat([localRecord, centralRecord, eocd]);
}

describe("resource selector hardening", () => {
	it("rejects raw SQLite pragma table-valued functions and quoted sqlite internals", async () => {
		const mod = sqlite(); if (!mod) return;
		const dir = await tempDir(); const dbPath = join(dir, "data.sqlite"); const db = new mod.Database(dbPath);
		try { db.run("create table t (id integer primary key)"); } finally { db.close(); }
		const read = createReadToolDefinition(dir);
		await expect(read.execute("raw-pragma-tvfc", { path: "data.sqlite?q=select * from pragma_table_info('t')" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid raw SQLite query/);
		await expect(read.execute("raw-sqlite-splice", { path: "data.sqlite?q=select \"sqlite\"\"_master\" from t" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid raw SQLite query/);
	});

	it("rejects SQLite where filters that contain subqueries or internal functions", async () => {
		const mod = sqlite(); if (!mod) return;
		const dir = await tempDir(); const dbPath = join(dir, "data.sqlite"); const db = new mod.Database(dbPath);
		try { db.run("create table t (id integer primary key, name text)"); } finally { db.close(); }
		const read = createReadToolDefinition(dir);
		await expect(read.execute("where-subselect", { path: "data.sqlite:t?where=exists(select%201)" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid SQLite where filter/);
		await expect(read.execute("where-load-extension", { path: "data.sqlite:t?where=load_extension('x')" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid SQLite where filter/);
		await expect(read.execute("where-sqlite-internal", { path: "data.sqlite:t?where=sqlite_master%3D1" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid SQLite where filter/);
	});

	it("rejects malformed zip central directory offsets during selective writes", async () => {
		const dir = await tempDir(); const archivePath = join(dir, "bad.zip");
		const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(1000, 16);
		await writeFile(archivePath, eocd);
		await expect(createWriteToolDefinition(dir).execute("bad-zip-write", { path: "bad.zip:new.txt", content: "new" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid zip (archive|entry bounds)/);
	});

	it("rejects selective zip writes that would drop data descriptors", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "descriptor.zip"), zipWithDataDescriptor());
		await expect(createWriteToolDefinition(dir).execute("descriptor-zip-write", { path: "descriptor.zip:new.txt", content: "new" }, undefined, undefined, {} as never)).rejects.toThrow(/Unsupported zip data descriptor/);
	});
});
