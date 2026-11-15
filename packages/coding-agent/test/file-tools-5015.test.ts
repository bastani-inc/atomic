import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.js";
import { createToolDefinition } from "../src/core/tools/index.js";
import { TestSqliteDatabase } from "./helpers/sqlite.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "file-tools-5015-"));
	tempDirs.push(dir);
	return dir;
}

type ToolResult = { content: Array<{ type: string; text?: string }> };

async function run(tool: "read" | "write", dir: string, params: object): Promise<string> {
	const result = (await createToolDefinition(tool, dir).execute(tool, params as never, undefined, undefined, {
		cwd: dir,
	} as ExtensionToolContext)) as ToolResult;
	return result.content.map((item) => item.text ?? "").join("\n");
}

const read = (dir: string, path: string) => run("read", dir, { path });
const write = (dir: string, path: string, content: string) => run("write", dir, { path, content });

const CONFLICT = "<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n";

describe("read file names that look like selectors (#5015)", () => {
	// Windows file names cannot contain ':'.
	it.skipIf(process.platform === "win32").each(["build:12", "backup:2024-01-05", "notes:0", "a:5-2"])(
		"reads %j by its full name (#5015)",
		async (name) => {
			const dir = await tempDir();
			await writeFile(join(dir, "build"), "the build file\n");
			await writeFile(join(dir, name), `contents of ${name}\n`);
			assert.match(await read(dir, name), new RegExp(`contents of ${name}`));
		},
	);

	it("still applies a line selector when no file has the full name (#5015)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "build"), "one\ntwo\nthree\n");
		const text = await read(dir, "build:2");
		assert.match(text, /two/);
		assert.doesNotMatch(text, /one/);
	});
});

describe("conflict:// writes keep bytes and line endings (#5015)", () => {
	it("keeps non-UTF-8 bytes outside the resolved region (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "x.txt");
		const latin1 = Buffer.from("caf\xe9\n", "latin1");
		await writeFile(file, Buffer.concat([latin1, Buffer.from(CONFLICT), latin1]));
		assert.equal(await write(dir, "conflict://1", "@ours"), "Resolved conflict 1");
		assert.deepEqual(await readFile(file), Buffer.concat([latin1, Buffer.from("A\n"), latin1]));
	});

	it("refuses a region that is not UTF-8 and leaves the file unchanged (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "x.txt");
		const bytes = Buffer.from("<<<<<<< ours\ncaf\xe9\n=======\nB\n>>>>>>> theirs\n", "latin1");
		await writeFile(file, bytes);
		await assert.rejects(write(dir, "conflict://1", "@theirs"), { code: "conflict-not-utf8" });
		assert.deepEqual(await readFile(file), bytes);
	});

	it("writes custom content with the file's CRLF line endings (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "x.txt");
		await writeFile(file, `top\n${CONFLICT}bottom\n`.replace(/\n/g, "\r\n"));
		await write(dir, "conflict://1", "X\nY\n");
		assert.equal(await readFile(file, "utf8"), "top\r\nX\r\nY\r\nbottom\r\n");
	});

	it("uses the region's own line ending in a mixed file (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "x.txt");
		await writeFile(file, `top\r\n${CONFLICT}bottom\r\n`);
		await write(dir, "conflict://1", "X\r\nY");
		assert.equal(await readFile(file, "utf8"), "top\r\nX\nY\nbottom\r\n");
	});

	it("keeps a CRLF file without a final newline unterminated (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "x.txt");
		await writeFile(file, `top\r\n${CONFLICT.replace(/\n/g, "\r\n").replace(/\r\n$/, "")}`);
		await write(dir, "conflict://1", "X\nY");
		assert.equal(await readFile(file, "utf8"), "top\r\nX\r\nY");
	});
});

describe("conflict:// re-validates registered regions (#5015)", () => {
	it("refuses a region whose separator moved since it was read (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "x.txt");
		await writeFile(file, "<<<<<<< ours\nA1\nA2\n=======\nB\n>>>>>>> theirs\n");
		await read(dir, "x.txt:conflicts");
		const changed = "<<<<<<< ours\nA1\n=======\nB1\nB2\n>>>>>>> theirs\n";
		await writeFile(file, changed);
		await assert.rejects(write(dir, "conflict://1", "@ours"), { code: "conflict-stale" });
		await assert.rejects(read(dir, "conflict://1"), /changed since it was read/);
		assert.equal(await readFile(file, "utf8"), changed);
	});

	it("refuses a region whose marker labels changed since it was read (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "x.txt");
		await writeFile(file, CONFLICT);
		await read(dir, "x.txt:conflicts");
		await writeFile(file, CONFLICT.replace("<<<<<<< ours", "<<<<<<< HEAD"));
		await assert.rejects(write(dir, "conflict://1", "@ours"), { code: "conflict-stale" });
	});

	it("resolves a region after reading it again (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "x.txt");
		await writeFile(file, CONFLICT);
		await read(dir, "x.txt:conflicts");
		await writeFile(file, CONFLICT.replace("B", "C"));
		await read(dir, "x.txt:conflicts");
		await write(dir, "conflict://1", "@theirs");
		assert.equal(await readFile(file, "utf8"), "C\n");
	});

	it("renumbers the remaining regions after one is resolved (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "x.txt");
		await writeFile(file, `${CONFLICT}mid\n${CONFLICT.replace("B", "C")}`);
		await read(dir, "x.txt:conflicts");
		await write(dir, "conflict://1", "@ours");
		await write(dir, "conflict://1", "@theirs");
		assert.equal(await readFile(file, "utf8"), "A\nmid\nC\n");
	});
});

describe("conflict://* covers every conflict under the working directory (#5015)", () => {
	it("resolves files that were never read with :conflicts (#5015)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "a.txt"), CONFLICT);
		await writeFile(join(dir, "b.txt"), CONFLICT);
		await read(dir, "a.txt:conflicts");
		assert.match(await read(dir, "conflict://*"), /b\.txt/);
		assert.equal(await write(dir, "conflict://*", "@ours"), "Resolved 2 conflicts");
		assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "A\n");
		assert.equal(await readFile(join(dir, "b.txt"), "utf8"), "A\n");
	});

	it("keeps the ids of every file read with :conflicts (#5015)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "a.txt"), CONFLICT);
		await writeFile(join(dir, "b.txt"), CONFLICT.replace("B", "C"));
		await read(dir, "b.txt:conflicts");
		await read(dir, "a.txt:conflicts");
		await write(dir, "conflict://1", "@theirs");
		assert.equal(await readFile(join(dir, "b.txt"), "utf8"), "C\n");
		assert.equal(await readFile(join(dir, "a.txt"), "utf8"), CONFLICT);
	});

	it("skips gitignored files like search (#5015)", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, "build"));
		await writeFile(join(dir, ".gitignore"), "build/\n*.log\n");
		await writeFile(join(dir, "build", "out.txt"), CONFLICT);
		await writeFile(join(dir, "run.log"), CONFLICT);
		await writeFile(join(dir, "src.txt"), CONFLICT);
		assert.equal(await write(dir, "conflict://*", "@ours"), "Resolved 1 conflict");
		assert.equal(await readFile(join(dir, "build", "out.txt"), "utf8"), CONFLICT);
		assert.equal(await readFile(join(dir, "run.log"), "utf8"), CONFLICT);
		assert.equal(await readFile(join(dir, "src.txt"), "utf8"), "A\n");
	});
});

describe("SQLite selectors (#5015)", () => {
	function database(dir: string, sql: string): string {
		const path = join(dir, "t.db");
		const db = new TestSqliteDatabase(path);
		for (const statement of sql.split(";").filter((part) => part.trim())) db.run(statement);
		db.close();
		return path;
	}
	function rows(path: string, table: string): Array<Record<string, unknown>> {
		const db = new TestSqliteDatabase(path);
		try {
			return db
				.query(`select * from ${table}`)
				.all()
				.map((row) => ({ ...row }));
		} finally {
			db.close();
		}
	}

	it.each([["port: 0x1F"], ["score: +5"], ["list [a,]"], ["it's 'quoted', {x: 1,}"]])(
		"keeps loose-JSON string contents %j verbatim (#5015)",
		async (note) => {
			const dir = await tempDir();
			const path = database(dir, "create table t (id integer primary key, note text)");
			await write(dir, "t.db:t", `{note: ${JSON.stringify(note)}, }`);
			assert.deepEqual(rows(path, "t"), [{ id: 1, note }]);
		},
	);

	it("still accepts the loose-JSON forms outside strings (#5015)", async () => {
		const dir = await tempDir();
		const path = database(dir, "create table t (id integer primary key, a, b, c text)");
		await write(dir, "t.db:t", "{id: 9, a: +5, b: 0x1F, c: 'it\\'s \"x\"', /* note */ }");
		assert.deepEqual(rows(path, "t"), [{ id: 9, a: 5, b: 31, c: `it's "x"` }]);
	});

	it("matches an untyped primary key by its number for reads, updates and deletes (#5015)", async () => {
		const dir = await tempDir();
		const path = database(
			dir,
			"create table untyped (k primary key, v text); insert into untyped values (1, 'a'); insert into untyped values (2, 'b')",
		);
		assert.match(await read(dir, "t.db:untyped:2"), /"b"|\bb\b/);
		await write(dir, "t.db:untyped:2", '{"v":"Z"}');
		assert.deepEqual(rows(path, "untyped"), [
			{ k: 1, v: "a" },
			{ k: 2, v: "Z" },
		]);
		await write(dir, "t.db:untyped:1", "");
		assert.deepEqual(rows(path, "untyped"), [{ k: 2, v: "Z" }]);
	});

	it.each([
		["ev", "2024-01-05", "first"],
		["ev", "3-1", "second"],
		["r", "1.5", "real"],
	])("reads row %s:%s, which looks like a line selector (#5015)", async (table, id, value) => {
		const dir = await tempDir();
		database(
			dir,
			"create table ev (day text primary key, v text); insert into ev values ('2024-01-05', 'first'); insert into ev values ('3-1', 'second'); create table r (k real primary key, v text); insert into r values (1.5, 'real')",
		);
		assert.match(await read(dir, `t.db:${table}:${id}`), new RegExp(value));
	});
});
