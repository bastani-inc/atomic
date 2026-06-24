import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createHashlineSnapshotStore } from "../src/core/tools/hashline.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

interface SqliteQuery { get(): Record<string, string | number | null> | undefined }
interface SqliteDb { run(sql: string): void; query(sql: string): SqliteQuery; close(): void }
interface BunSqliteModule { Database: new (path: string) => SqliteDb }
const text = (result: { content: Array<{ type: string; text?: string }> }): string => result.content.map((item) => item.text ?? "").join("\n");
function sqlite(): BunSqliteModule | undefined { try { return createRequire(import.meta.url)("bun:sqlite") as BunSqliteModule; } catch { return undefined; } }

describe("resource write parity edges", () => {
	let testDir: string;
	beforeEach(() => { testDir = join(tmpdir(), `atomic-resource-write-${Date.now()}-${Math.random().toString(16).slice(2)}`); mkdirSync(testDir, { recursive: true }); });
	afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

	it("returns compact write headers and stripped hashline notes", async () => {
		const store = createHashlineSnapshotStore();
		const write = createWriteToolDefinition(testDir, { hashlineStore: store });
		const writeOutput = text(await write.execute("plain-write", { path: "plain.txt", content: "hello\n" }, undefined, undefined, {} as never));
		expect(writeOutput).toMatch(/^\[plain\.txt#[0-9A-F]{4}\]\nSuccessfully wrote 6 bytes/);
		expect(writeOutput).not.toContain("1:hello");
		const readOutput = text(await createReadToolDefinition(testDir, { hashlineStore: store }).execute("read-plain", { path: "plain.txt" }, undefined, undefined, {} as never));
		const copied = text(await write.execute("copy-write", { path: "copy.txt", content: readOutput }, undefined, undefined, {} as never));
		expect(copied).toContain("Note: stripped copied hashline headers");
		expect(readFileSync(join(testDir, "copy.txt"), "utf8")).toBe("hello\n");
	});

	it("rejects archive directory write targets", async () => {
		await expect(createWriteToolDefinition(testDir).execute("zip-dir", { path: "a.zip:dir/", content: "x" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid archive member path/);
	});

	it("inserts SQLite default values for empty table-write objects", async () => {
		const sqliteMod = sqlite(); if (!sqliteMod) return;
		const dbPath = join(testDir, "data.sqlite"), db = new sqliteMod.Database(dbPath);
		try { db.run("create table t (id integer primary key, name text default 'anon')"); } finally { db.close(); }
		await createWriteToolDefinition(testDir).execute("sqlite-default", { path: "data.sqlite:t", content: "{}" }, undefined, undefined, {} as never);
		const check = new sqliteMod.Database(dbPath);
		try { expect(check.query("select name from t").get()?.name).toBe("anon"); } finally { check.close(); }
	});

	it("returns conflict resolution snapshot headers usable by edit", async () => {
		const store = createHashlineSnapshotStore(), file = join(testDir, "conflict.txt");
		writeFileSync(file, "pre\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\npost\n", "utf8");
		const writeOutput = text(await createWriteToolDefinition(testDir, { hashlineStore: store }).execute("resolve", { path: "conflict://1", content: "@ours" }, undefined, undefined, {} as never));
		const tag = writeOutput.match(/\[conflict\.txt#([0-9A-F]{4})\]/)?.[1];
		expect(tag).toBeTruthy();
		await createEditToolDefinition(testDir, { hashlineStore: store }).execute("edit", { input: `[conflict.txt#${tag}]\ninsert tail:\n+tail` }, undefined, undefined, {} as never);
		expect(readFileSync(file, "utf8")).toBe("pre\nleft\npost\ntail\n");
	});

	it("reports SQLite no-op row updates and deletes", async () => {
		const sqliteMod = sqlite(); if (!sqliteMod) return;
		const dbPath = join(testDir, "data.sqlite"), db = new sqliteMod.Database(dbPath);
		try { db.run("create table users (id text primary key, name text)"); } finally { db.close(); }
		let output = text(await createWriteToolDefinition(testDir).execute("sqlite-miss-update", { path: "data.sqlite:users:missing", content: "{name:'Ada'}" }, undefined, undefined, {} as never));
		expect(output).toContain("No row updated");
		output = text(await createWriteToolDefinition(testDir).execute("sqlite-miss-delete", { path: "data.sqlite:users:missing", content: "" }, undefined, undefined, {} as never));
		expect(output).toContain("No row deleted");
	});
});
