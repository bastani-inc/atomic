import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolDefinition } from "../src/core/tools/index.ts";
import { readZipEntriesFromBuffer } from "../src/core/tools/resource-selectors.ts";
import { sqlite } from "./helpers/sqlite.ts";

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content.map((item) => item.text ?? "").join("\n");

describe("resource write parity edges", () => {
	let testDir: string;
	beforeEach(() => {
		testDir = join(tmpdir(), `atomic-resource-write-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});
	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("writes plain files verbatim, including text that looks like old read headers", async () => {
		const write = createToolDefinition("write", testDir);
		const content = "[copy.txt#1A2B]\n1:hello\n";
		const writeOutput = text(
			await write.execute("plain-write", { path: "copy.txt", content }, undefined, undefined, {} as never),
		);
		expect(writeOutput).toBe("Successfully wrote to copy.txt");
		expect(readFileSync(join(testDir, "copy.txt"), "utf8")).toBe(content);
	});

	it("rejects malformed zip member bounds", () => {
		const buf = Buffer.alloc(22);
		buf.writeUInt32LE(0x06054b50, 0);
		buf.writeUInt16LE(1, 8);
		buf.writeUInt16LE(1, 10);
		buf.writeUInt32LE(46, 12);
		buf.writeUInt32LE(22, 16);
		expect(() => readZipEntriesFromBuffer(buf, "bad.zip")).toThrow(/Invalid zip entry bounds/);
	});
	it("rejects archive directory write targets", async () => {
		await expect(
			createToolDefinition("write", testDir).execute(
				"zip-dir",
				{ path: "a.zip:dir/", content: "x" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/Invalid archive member path/);
	});

	it("inserts SQLite default values for empty table-write objects", async () => {
		const sqliteMod = sqlite();
		const dbPath = join(testDir, "data.sqlite"),
			db = new sqliteMod.Database(dbPath);
		try {
			db.run("create table t (id integer primary key, name text default 'anon')");
		} finally {
			db.close();
		}
		await createToolDefinition("write", testDir).execute(
			"sqlite-default",
			{ path: "data.sqlite:t", content: "{}" },
			undefined,
			undefined,
			{} as never,
		);
		const check = new sqliteMod.Database(dbPath);
		try {
			expect(check.query("select name from t").get()?.name).toBe("anon");
		} finally {
			check.close();
		}
	});

	it("resolves a conflict, and edit then changes the result by exact text", async () => {
		const file = join(testDir, "conflict.txt");
		writeFileSync(file, "pre\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\npost\n", "utf8");
		const writeOutput = text(
			await createToolDefinition("write", testDir).execute(
				"resolve",
				{ path: "conflict://1", content: "@ours" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(writeOutput).toBe("Resolved conflict 1");
		await createToolDefinition("edit", testDir).execute(
			"edit",
			{ path: "conflict.txt", edits: [{ oldText: "post\n", newText: "post\ntail\n" }] },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(file, "utf8")).toBe("pre\nleft\npost\ntail\n");
	});

	it("reports SQLite no-op row updates and deletes", async () => {
		const sqliteMod = sqlite();
		const dbPath = join(testDir, "data.sqlite"),
			db = new sqliteMod.Database(dbPath);
		try {
			db.run("create table users (id text primary key, name text)");
		} finally {
			db.close();
		}
		let output = text(
			await createToolDefinition("write", testDir).execute(
				"sqlite-miss-update",
				{ path: "data.sqlite:users:missing", content: "{name:'Ada'}" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(output).toContain("No row updated");
		output = text(
			await createToolDefinition("write", testDir).execute(
				"sqlite-miss-delete",
				{ path: "data.sqlite:users:missing", content: "" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(output).toContain("No row deleted");
	});
});
