import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.js";
import { createToolDefinition } from "../src/core/tools/index.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
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

	it.skipIf(process.platform === "win32")(
		"lists a directory named like a selector by its full name (#5015)",
		async () => {
			const dir = await tempDir();
			await mkdir(join(dir, "logs:2"));
			await writeFile(join(dir, "logs:2", "inside.txt"), "x\n");
			assert.match(await read(dir, "logs:2"), /inside\.txt/);
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps selector parsing for custom operations without stat (#5015)",
		async () => {
			const dir = await tempDir();
			await writeFile(join(dir, "notes:2"), "local file\n");
			const reads: string[] = [];
			const tool = createReadToolDefinition(dir, {
				operations: {
					access: async () => {},
					readFile: async (path) => {
						reads.push(path);
						return Buffer.from("one\ntwo\nthree\n");
					},
				},
			});
			const result = (await tool.execute("read", { path: "notes:2" })) as ToolResult;
			assert.deepEqual(reads, [join(dir, "notes")]);
			assert.match(result.content[0]?.text ?? "", /two/);
		},
	);

	it("still refuses an invalid line selector when no file has the full name (#5015)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "build"), "one\n");
		await assert.rejects(read(dir, "build:5-2"));
	});

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
		await assert.rejects(
			write(dir, "conflict://1", "@theirs"),
			(error: Error & { code?: string; fields?: object }) => {
				assert.equal(error.code, "conflict-not-utf8");
				assert.deepEqual(error.fields, { path: "conflict://1" });
				assert.match(error.message, /^Conflict in .*x\.txt is not valid UTF-8 text/);
				assert.ok(error.cause instanceof TypeError);
				return true;
			},
		);
		assert.deepEqual(await readFile(file), bytes);
	});

	it("resolves a region on the file's first line after an empty line (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "x.txt");
		await writeFile(file, `\n${CONFLICT}`);
		await write(dir, "conflict://1", "@theirs");
		assert.equal(await readFile(file, "utf8"), "\nB\n");
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
		await assert.rejects(write(dir, "conflict://1", "@ours"), {
			code: "conflict-stale",
			fields: { path: "conflict://1", conflictId: "1" },
			message: "Conflict 1 changed since it was read. No file was changed.",
		});
		await assert.rejects(read(dir, "conflict://1"), /^Error: Conflict 1 changed since it was read/);
		assert.equal(await readFile(file, "utf8"), changed);
		assert.equal(await read(dir, "conflict://*"), "# conflict://2 x.txt:1-6\n## ours\nA1\n## theirs\nB1\nB2");
		assert.equal(await write(dir, "conflict://*", "@theirs"), "Resolved 1 conflict");
		assert.equal(await readFile(file, "utf8"), "B1\nB2\n");
	});

	it("gives a region that moved down a new id (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "x.txt");
		await writeFile(file, CONFLICT);
		await read(dir, "x.txt:conflicts");
		await writeFile(file, `top\n${CONFLICT}`);
		assert.equal(await read(dir, "conflict://*"), "# conflict://2 x.txt:2-6\n## ours\nA\n## theirs\nB");
		await write(dir, "conflict://2", "@ours");
		assert.equal(await readFile(file, "utf8"), "top\nA\n");
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

	it("lists at most 100 regions across files (#5015)", async () => {
		const dir = await tempDir();
		for (let index = 0; index < 101; index++)
			await writeFile(join(dir, `f${String(index).padStart(3, "0")}.txt`), CONFLICT);
		assert.equal(await write(dir, "conflict://*", "@ours"), "Resolved 100 conflicts");
		assert.match(await read(dir, "conflict://*"), /^# conflict:\/\/1 f\d{3}\.txt:1-5\n## ours\nA\n## theirs\nB$/);
	});

	it("skips .git and node_modules, and walks other directories (#5015)", async () => {
		const dir = await tempDir();
		for (const sub of [".git", "node_modules", join("src", "deep")]) {
			await mkdir(join(dir, sub), { recursive: true });
			await writeFile(join(dir, sub, "c.txt"), CONFLICT);
		}
		assert.equal(await write(dir, "conflict://*", "@ours"), "Resolved 1 conflict");
		assert.equal(await readFile(join(dir, "src", "deep", "c.txt"), "utf8"), "A\n");
		assert.equal(await readFile(join(dir, ".git", "c.txt"), "utf8"), CONFLICT);
		assert.equal(await readFile(join(dir, "node_modules", "c.txt"), "utf8"), CONFLICT);
	});

	it("applies nested .gitignore files relative to their directory (#5015)", async () => {
		const dir = await tempDir();
		const files = [
			"top.gen",
			"keep.log",
			join("pkg", "lib", "a.gen"),
			join("pkg", "lib", "keep.gen"),
			join("pkg", "only.txt"),
			join("pkg", "lib", "only.txt"),
			join("pkg", "dir", "skip.txt"),
			join("pkg", "other", "dir", "skip.txt"),
			join("pkg", "lib", "inner", "x.tmp"),
			join("pkg", "out", "keep.txt"),
			join("pkg", "#note"),
			join("pkg", "note#"),
		];
		for (const file of files) {
			await mkdir(join(dir, file, ".."), { recursive: true });
			await writeFile(join(dir, file), CONFLICT);
		}
		await writeFile(join(dir, ".gitignore"), "*.log\r\n!keep.log\r\n");
		await writeFile(
			join(dir, "pkg", ".gitignore"),
			"# note\n\n  *.gen  \n!keep.gen\n/only.txt\ndir/skip.txt\nout/\n!out/keep.txt\nnote#\n",
		);
		await writeFile(join(dir, "pkg", "lib", ".ignore"), "inner/*.tmp\n");
		await write(dir, "conflict://*", "@ours");
		const resolved = [];
		for (const file of files) if ((await readFile(join(dir, file), "utf8")) === "A\n") resolved.push(file);
		assert.deepEqual(resolved, [
			"top.gen",
			"keep.log",
			join("pkg", "lib", "keep.gen"),
			join("pkg", "lib", "only.txt"),
			join("pkg", "other", "dir", "skip.txt"),
			join("pkg", "#note"),
		]);
	});

	it("resolves the live regions with conflict://* when a read region changed (#5015)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "a.txt"), CONFLICT);
		await writeFile(join(dir, "b.txt"), CONFLICT);
		await read(dir, "a.txt:conflicts");
		await writeFile(join(dir, "a.txt"), "resolved by hand\n");
		assert.equal(await write(dir, "conflict://*", "@theirs"), "Resolved 1 conflict");
		assert.equal(await readFile(join(dir, "b.txt"), "utf8"), "B\n");
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

describe("conflict:// reads (#5015)", () => {
	it("lists every region with its id, place and sides (#5015)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "a.txt"), `top\n<<<<<<< ours\nA\n||||||| base\nO\n=======\nB\n>>>>>>> theirs\n`);
		assert.equal(await read(dir, "conflict://*"), "# conflict://1 a.txt:2-8\n## ours\nA\n## theirs\nB\n## base\nO");
		assert.equal(await read(dir, "conflict://1"), "# conflict://1 a.txt:2-8\n## ours\nA\n## theirs\nB\n## base\nO");
		assert.equal(await read(dir, "conflict://1/ours"), "A");
		assert.equal(await read(dir, "conflict://1/theirs"), "B");
		assert.equal(await read(dir, "conflict://1/base"), "O");
	});

	it.each([
		["conflict://1/left", /^Error: Unknown conflict side: left; use ours, theirs or base\.$/],
		["conflict://1/ours/x", /^Error: Unknown conflict side: ours; use ours, theirs or base\.$/],
		["conflict://*/ours", /^Error: conflict:\/\/\* does not take a side\.$/],
		["conflict://x1", /^Error: Conflict reads must target conflict:\/\/<id> or conflict:\/\/\*\.$/],
		["conflict://1x", /^Error: Conflict reads must target conflict:\/\/<id> or conflict:\/\/\*\.$/],
		["conflict://2", /^Error: Conflict id not found: 2$/],
	])("refuses %s (#5015)", async (path, message) => {
		const dir = await tempDir();
		await writeFile(join(dir, "a.txt"), CONFLICT);
		await assert.rejects(read(dir, path), (error: Error) => {
			assert.match(String(error), message);
			return true;
		});
	});

	it("refuses an invalid write target before looking for conflicts (#5015)", async () => {
		const dir = await tempDir();
		await assert.rejects(write(dir, "conflict://1x", "@ours"), { code: "conflict-target-invalid" });
	});

	it("resolves a two-digit id (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, Array.from({ length: 12 }, (_, index) => CONFLICT.replace("B", `B${index + 1}`)).join(""));
		assert.match(await read(dir, "conflict://12/theirs"), /^B12$/);
		await write(dir, "conflict://12", "@theirs");
		assert.match(await readFile(file, "utf8"), /\nB12\n$/);
	});

	it("keeps a re-read file's ids where they were (#5015)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "a.txt"), CONFLICT.replace("A", "a"));
		await writeFile(join(dir, "b.txt"), CONFLICT.replace("A", "b1"));
		await read(dir, "b.txt:conflicts");
		await read(dir, "a.txt:conflicts");
		await writeFile(join(dir, "b.txt"), CONFLICT.replace("A", "b1") + CONFLICT.replace("A", "b2"));
		await read(dir, "b.txt:conflicts");
		assert.equal(await read(dir, "conflict://1/ours"), "b1");
		assert.equal(await read(dir, "conflict://2/ours"), "b2");
		assert.equal(await read(dir, "conflict://3/ours"), "a");
	});

	it("lists at most 100 regions, and resolves a read file's later regions (#5015)", async () => {
		const dir = await tempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, CONFLICT.repeat(101));
		assert.equal(await write(dir, "conflict://*", "@ours"), "Resolved 100 conflicts");
		assert.equal(await readFile(file, "utf8"), `${"A\n".repeat(100)}${CONFLICT}`);
		await writeFile(file, CONFLICT.repeat(100) + CONFLICT.replace("B", "last"));
		await read(dir, "a.txt:conflicts");
		await write(dir, "conflict://101", "@theirs");
		assert.equal(await readFile(file, "utf8"), `${CONFLICT.repeat(100)}last\n`);
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
		const path = database(dir, "create table t (id integer primary key, a, b, c text, d text, e, f)");
		await write(
			dir,
			"t.db:t",
			'{id: 19, a: +12, b: -0x1F, c: \'it\\\'s "x"\\n\', d: "q\\"r", e: 1.5e+3, f: null, /* note */ }',
		);
		assert.deepEqual(rows(path, "t"), [{ id: 19, a: 12, b: -31, c: `it's "x"\n`, d: 'q"r', e: 1500, f: null }]);
	});

	it.each([
		["{a: 'open", /JSON/],
		["{a: [1,]}", /^Error: SQLite column 'a' only accepts JSON scalar values or null$/],
	])("refuses loose JSON %j (#5015)", async (content, message) => {
		const dir = await tempDir();
		database(dir, "create table t (id integer primary key, a)");
		await assert.rejects(write(dir, "t.db:t", content), (error: Error) => {
			assert.match(String(error), message);
			return true;
		});
	});

	it.each([
		["create table u (k blob primary key, v text); insert into u values (2, 'hit')", "2"],
		["create table u (v text, k primary key); insert into u values ('hit', 2)", "2"],
		["create table u (k text primary key, v text); insert into u values ('1.50', 'hit')", "1.50"],
		["create table u (k primary key, v text); insert into u values ('Infinity', 'hit')", "Infinity"],
		["create table u (k primary key, v text); insert into u values ('007', 'hit')", "007"],
		["create table u (k real primary key, v text); insert into u values (2.5, 'hit')", "2.5"],
	])("selects the row of %s by %j (#5015)", async (sql, id) => {
		const dir = await tempDir();
		database(dir, sql);
		assert.match(await read(dir, `t.db:u:${id}`), /hit/);
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
