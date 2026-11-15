import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { extract as tarExtract } from "tar-stream";
import { afterEach, describe, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.js";
import { createToolDefinition } from "../src/core/tools/index.js";
import { TestSqliteDatabase } from "./helpers/sqlite.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "resource-writes-4906-"));
	tempDirs.push(dir);
	return dir;
}

type ToolResult = { content: Array<{ type: string; text?: string }> };

const textOf = (result: ToolResult) => result.content.map((item) => item.text ?? "").join("\n");

async function run(tool: "read" | "write" | "search", dir: string, params: object): Promise<ToolResult> {
	return createToolDefinition(tool, dir).execute(
		tool,
		params as never,
		undefined,
		undefined,
		{} as ExtensionToolContext,
	) as Promise<ToolResult>;
}

const write = (dir: string, path: string, content: string) => run("write", dir, { path, content });
const read = async (dir: string, path: string) => textOf(await run("read", dir, { path }));
const search = async (dir: string, pattern: string, paths: string) =>
	textOf(await run("search", dir, { pattern, paths }));

describe("conflict:// markers are exact marker lines (#4906)", () => {
	it("keeps a markdown heading underline on theirs when resolved with @theirs (#4906)", async () => {
		const dir = await tempDir();
		const file = join(dir, "README.md");
		const theirs = "Title\n==========\nbody\n=======x\nmore";
		await writeFile(file, `pre\n<<<<<<< HEAD\nours\n=======\n${theirs}\n>>>>>>> branch\npost\n`);
		await write(dir, "conflict://1", "@theirs");
		assert.equal(await readFile(file, "utf8"), `pre\n${theirs}\npost\n`);
	});

	it("keeps a >>>>>>>-prefixed content line inside a side (#4906)", async () => {
		const dir = await tempDir();
		const file = join(dir, "mail.txt");
		const theirs = "reply\n>>>>>>>> quoted mail\n>>>>>>>also quoted\nsigned";
		await writeFile(file, `<<<<<<< ours\nmine\n=======\n${theirs}\n>>>>>>> theirs\ntail\n`);
		await write(dir, "conflict://1", "@theirs");
		assert.equal(await readFile(file, "utf8"), `${theirs}\ntail\n`);
	});

	it("reads diff3 sides split only at exact markers in Git's order (#4906)", async () => {
		const dir = await tempDir();
		await writeFile(
			join(dir, "c.txt"),
			"<<<<<<< ours\no\n|||||||| not base\n||||||| base\nb\n=======\nt\n<<<<<<<< late\n>>>>>>> theirs\n",
		);
		assert.equal(await read(dir, "conflict://1/ours"), "o\n|||||||| not base");
		assert.equal(await read(dir, "conflict://1/base"), "b");
		assert.equal(await read(dir, "conflict://1/theirs"), "t\n<<<<<<<< late");
	});

	it.each([
		["a second separator", "<<<<<<< ours\no\n=======\nt1\n=======\nt2\n>>>>>>> theirs\n"],
		["a base after the separator", "<<<<<<< ours\no\n=======\nt\n||||||| base\nb\n>>>>>>> theirs\n"],
		["a second base", "<<<<<<< ours\no\n||||||| a\nb\n||||||| c\nd\n=======\nt\n>>>>>>> theirs\n"],
		["an end before the separator", "<<<<<<< ours\no\n>>>>>>> theirs\nt\n=======\nu\n>>>>>>> theirs\n"],
	])("leaves a block with %s alone rather than guessing (#4906)", async (_case, ambiguous) => {
		const dir = await tempDir();
		const file = join(dir, "c.txt");
		await writeFile(file, `${ambiguous}<<<<<<< ours\nkeep\n=======\ndrop\n>>>>>>> theirs\n`);
		await write(dir, "conflict://*", "@ours");
		assert.equal(await readFile(file, "utf8"), `${ambiguous}keep\n`);
	});
});

describe("conflict:// marker edge cases (#4906)", () => {
	it("recognises CRLF marker lines and labels on every marker (#4906)", async () => {
		const dir = await tempDir();
		const file = join(dir, "c.txt");
		await writeFile(file, "<<<<<<<\r\no\r\n||||||| base\r\nb\r\n======= mid\r\nt\r\n>>>>>>>\r\nend\r\n");
		assert.equal(await read(dir, "conflict://1/base"), "b\r");
		await write(dir, "conflict://1", "@theirs");
		assert.equal(await readFile(file, "utf8"), "t\r\nend\r\n");
	});

	it.each([
		["eight", "<<<<<<<< x"],
		["a label without a space", "<<<<<<<x"],
		["a tab", "<<<<<<<\tx"],
	])("does not start a region at a start marker with %s (#4906)", async (_case, start) => {
		const dir = await tempDir();
		const file = join(dir, "c.txt");
		const text = `${start}\no\n=======\nt\n>>>>>>> theirs\n`;
		await writeFile(file, `${text}<<<<<<< a\nkeep\n=======\ndrop\n>>>>>>> b\n`);
		await write(dir, "conflict://*", "@ours");
		assert.equal(await readFile(file, "utf8"), `${text}keep\n`);
	});

	it("leaves a region holding another start marker and resolves the inner region (#4906)", async () => {
		const dir = await tempDir();
		const file = join(dir, "c.txt");
		await writeFile(file, "<<<<<<< outer\nx\n<<<<<<< inner\no\n=======\nt\n>>>>>>> inner\n");
		await write(dir, "conflict://*", "@theirs");
		assert.equal(await readFile(file, "utf8"), "<<<<<<< outer\nx\nt\n");
	});
});

function sqliteFixture(dir: string, ddl: string, rows: Array<[string, number, string]>): string {
	const database = join(dir, "data.sqlite");
	const db = new TestSqliteDatabase(database);
	db.run(ddl);
	for (const row of rows) db.run("insert into members values (?, ?, ?)", ...row);
	db.close();
	return database;
}

function sqliteRows(database: string): unknown[] {
	const db = new TestSqliteDatabase(database);
	try {
		return db
			.query("select tenant, id, name from members order by tenant, id")
			.all()
			.map((row) => ({ ...row }));
	} finally {
		db.close();
	}
}

const MEMBERS: Array<[string, number, string]> = [
	["acme", 1, "Ada"],
	["acme", 2, "Grace"],
	["acme", 3, "Linus"],
	["globex", 1, "Ken"],
];

describe("SQLite row selectors use the complete primary key (#4906)", () => {
	for (const withoutRowid of [false, true]) {
		const ddl = `create table members (tenant text, id integer, name text, primary key (tenant, id))${withoutRowid ? " without rowid" : ""}`;
		const label = withoutRowid ? "WITHOUT ROWID" : "rowid";

		it(`updates and deletes exactly one row of a composite-key ${label} table (#4906)`, async () => {
			const dir = await tempDir();
			const database = sqliteFixture(dir, ddl, MEMBERS);
			assert.equal(
				textOf(await write(dir, 'data.sqlite:members:["acme",2]', "{name: 'Hopper'}")),
				`Updated row '["acme",2]' in members`,
			);
			assert.deepEqual(JSON.parse(await read(dir, 'data.sqlite:members:["acme",2]')), {
				tenant: "acme",
				id: 2,
				name: "Hopper",
			});
			await write(dir, 'data.sqlite:members:["acme",3]', "");
			assert.deepEqual(sqliteRows(database), [
				{ tenant: "acme", id: 1, name: "Ada" },
				{ tenant: "acme", id: 2, name: "Hopper" },
				{ tenant: "globex", id: 1, name: "Ken" },
			]);
		});

		it(`refuses a partial key on a composite-key ${label} table and changes nothing (#4906)`, async () => {
			const dir = await tempDir();
			const database = sqliteFixture(dir, ddl, MEMBERS);
			for (const selector of ["acme", '["acme"]', '["acme",1,2]', "[1"]) {
				await assert.rejects(write(dir, `data.sqlite:members:${selector}`, "{name: 'X'}"), /primary key/);
				await assert.rejects(write(dir, `data.sqlite:members:${selector}`, ""), /primary key/);
				await assert.rejects(read(dir, `data.sqlite:members:${selector}`), /primary key/);
			}
			assert.deepEqual(
				sqliteRows(database),
				MEMBERS.map(([tenant, id, name]) => ({ tenant, id, name })),
			);
		});
	}

	it("addresses composite keys in primary-key order, not column order (#4906)", async () => {
		const dir = await tempDir();
		const database = sqliteFixture(
			dir,
			"create table members (tenant text, id integer, name text, primary key (id, tenant))",
			MEMBERS,
		);
		assert.equal(
			textOf(await write(dir, 'data.sqlite:members:[1,"globex"]', "{name: 'Thompson'}")),
			`Updated row '[1,"globex"]' in members`,
		);
		assert.equal(
			textOf(await write(dir, 'data.sqlite:members:[1,"initech"]', "{name: 'Nobody'}")),
			`No row updated for '[1,"initech"]' in members`,
		);
		assert.equal(
			textOf(await write(dir, 'data.sqlite:members:[1,"initech"]', "")),
			`No row deleted for '[1,"initech"]' in members`,
		);
		assert.equal(
			textOf(await write(dir, 'data.sqlite:members:[2,"acme"]', "")),
			`Deleted row '[2,"acme"]' in members`,
		);
		assert.deepEqual(sqliteRows(database), [
			{ tenant: "acme", id: 1, name: "Ada" },
			{ tenant: "acme", id: 3, name: "Linus" },
			{ tenant: "globex", id: 1, name: "Thompson" },
		]);
	});

	it("names composite-key rows in search results by their key array (#4906)", async () => {
		const dir = await tempDir();
		sqliteFixture(
			dir,
			"create table members (tenant text, id integer, name text, primary key (id, tenant))",
			MEMBERS,
		);
		const found = await search(dir, "Grace|Ken", "data.sqlite:members");
		assert.ok(found.includes('data.sqlite:members:[2,"acme"]:'), found);
		assert.ok(found.includes('data.sqlite:members:[1,"globex"]:'), found);
		assert.ok(!found.includes("Ada"), found);
		const one = await search(dir, "a", 'data.sqlite:members:[1,"acme"]');
		assert.ok(one.includes('data.sqlite:members:[1,"acme"]:'), one);
		assert.ok(!one.includes("Grace"), one);
	});

	it("explains how to select a composite-key row and validates the key values (#4906)", async () => {
		const dir = await tempDir();
		sqliteFixture(
			dir,
			"create table members (tenant text, id integer, name text, primary key (tenant, id))",
			MEMBERS,
		);
		await assert.rejects(
			write(dir, "data.sqlite:members:acme", ""),
			new Error(
				"SQLite table 'members' has a composite primary key (tenant, id); select a row with a JSON array of all 2 key values in that order",
			),
		);
		await assert.rejects(
			write(dir, 'data.sqlite:members:["acme",[1]]', ""),
			new Error("SQLite column 'id' only accepts JSON scalar values or null"),
		);
	});

	it("still maps an inserted id onto a single differently named key, but not onto a composite key (#4906)", async () => {
		const dir = await tempDir();
		const database = join(dir, "data.sqlite");
		const db = new TestSqliteDatabase(database);
		db.run("create table tags (slug text primary key, label text)");
		db.run("create table pairs (a integer, b integer, id integer, primary key (a, b))");
		db.close();
		await write(dir, "data.sqlite:tags", "{id: 'x', label: 'X'}");
		await write(dir, "data.sqlite:pairs", "{a: 1, b: 2, id: 9}");
		const after = new TestSqliteDatabase(database);
		try {
			assert.deepEqual({ ...after.query("select slug, label from tags").all()[0] }, { slug: "x", label: "X" });
			assert.deepEqual({ ...after.query("select a, b, id from pairs").all()[0] }, { a: 1, b: 2, id: 9 });
		} finally {
			after.close();
		}
	});

	it("refuses an update or delete that would change more than one row (#4906)", async () => {
		const dir = await tempDir();
		const database = join(dir, "data.sqlite");
		const db = new TestSqliteDatabase(database);
		db.run("create table notes (rowid text, body text)");
		db.run("insert into notes values ('dup', 'a'), ('dup', 'b')");
		db.close();
		await assert.rejects(
			write(dir, "data.sqlite:notes:dup", "{body: 'x'}"),
			new Error(
				"SQLite row selector 'dup' matches 2 rows in notes; refusing to change more than one row. Select the row by its complete primary key.",
			),
		);
		await assert.rejects(write(dir, "data.sqlite:notes:dup", ""), /2 rows/);
		const after = new TestSqliteDatabase(database);
		try {
			assert.deepEqual(
				after
					.query("select rowid, body from notes order by body")
					.all()
					.map((row) => ({ ...row })),
				[
					{ rowid: "dup", body: "a" },
					{ rowid: "dup", body: "b" },
				],
			);
		} finally {
			after.close();
		}
	});
});

const BLOCK = 512;

function tarHeader(fields: { name: string; type: string; size: number; mode?: number; linkname?: string }): Buffer {
	const header = Buffer.alloc(BLOCK);
	header.write(fields.name, 0, 100);
	header.write(`${(fields.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
	header.write("0001750\0", 108);
	header.write("0001750\0", 116);
	header.write(`${fields.size.toString(8).padStart(11, "0")}\0`, 124);
	header.write(`${(1_600_000_000).toString(8).padStart(11, "0")}\0`, 136);
	header.write(fields.type, 156);
	header.write(fields.linkname ?? "", 157, 100);
	header.write("ustar\0", 257);
	header.write("00", 263);
	header.write("dev", 265);
	header.write("dev", 297);
	header.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return header;
}

function padded(data: Buffer): Buffer {
	return Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);
}

function tarMember(fields: { name: string; type?: string; mode?: number; linkname?: string }, data = ""): Buffer {
	const body = Buffer.from(data);
	return Buffer.concat([tarHeader({ type: "0", ...fields, size: body.length }), padded(body)]);
}

function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	let length = body.length;
	while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
	return `${length}${body}`;
}

const LONG_GNU = `gnu/${"g".repeat(120)}/long-name.txt`;
const LONG_PAX = `pax/${"p".repeat(150)}/long-name.txt`;

async function listTar(bytes: Buffer): Promise<Array<Record<string, unknown>>> {
	const entries: Array<Record<string, unknown>> = [];
	const extractor = tarExtract();
	Readable.from([bytes]).pipe(extractor);
	for await (const entry of extractor) {
		const chunks: Buffer[] = [];
		for await (const chunk of entry) chunks.push(chunk as Buffer);
		const { name, type, mode, linkname } = entry.header;
		entries.push({ name, type, mode, linkname, data: Buffer.concat(chunks).toString() });
	}
	return entries;
}

describe("tar member writes keep every other member intact (#4906)", () => {
	it("keeps GNU long names, PAX headers, symlinks, hard links and modes byte-for-byte (#4906)", async () => {
		const dir = await tempDir();
		const pax = paxRecord("path", LONG_PAX) + paxRecord("mtime", "1600000000.25");
		const before = [
			Buffer.concat([
				tarMember({ name: "././@LongLink", type: "L" }, `${LONG_GNU}\0`),
				tarMember({ name: LONG_GNU.slice(0, 100) }, "gnu body\n"),
			]),
			Buffer.concat([
				tarMember({ name: "PaxHeader/long-name.txt", type: "x" }, pax),
				tarMember({ name: "long-name.txt" }, "pax body\n"),
			]),
		];
		const target = tarMember({ name: "notes.txt", mode: 0o600 }, "old notes\n");
		const after = [
			tarMember({ name: "link", type: "2", mode: 0o777, linkname: "notes.txt" }),
			tarMember({ name: "hard", type: "1", linkname: "run.sh" }),
			tarMember({ name: "run.sh", mode: 0o755 }, "#!/bin/sh\necho hi\n"),
		];
		const archive = join(dir, "bundle.tar");
		const prefix = Buffer.concat(before);
		const suffix = Buffer.concat([...after, Buffer.alloc(BLOCK * 2)]);
		await writeFile(archive, Buffer.concat([prefix, target, suffix]));

		await write(dir, "bundle.tar:notes.txt", "new notes\n");

		const written = await readFile(archive);
		assert.deepEqual(written.subarray(0, prefix.length), prefix);
		assert.deepEqual(written.subarray(written.length - suffix.length), suffix);
		const listing = await listTar(written);
		assert.deepEqual(
			listing.map(({ name, type, mode, linkname, data }) => ({ name, type, mode, linkname, data })),
			[
				{ name: LONG_GNU, type: "file", mode: 0o644, linkname: null, data: "gnu body\n" },
				{ name: LONG_PAX, type: "file", mode: 0o644, linkname: null, data: "pax body\n" },
				{ name: "notes.txt", type: "file", mode: 0o600, linkname: null, data: "new notes\n" },
				{ name: "link", type: "symlink", mode: 0o777, linkname: "notes.txt", data: "" },
				{ name: "hard", type: "link", mode: 0o644, linkname: "run.sh", data: "" },
				{ name: "run.sh", type: "file", mode: 0o755, linkname: null, data: "#!/bin/sh\necho hi\n" },
			],
		);
		assert.equal(await read(dir, `bundle.tar:${LONG_GNU}`), "gnu body\n");
		assert.equal(await read(dir, `bundle.tar:${LONG_PAX}`), "pax body\n");
	});

	it("writes a member with a long path under its full name (#4906)", async () => {
		const dir = await tempDir();
		const archive = join(dir, "bundle.tgz");
		const longPath = `deep/${"d".repeat(160)}/${"n".repeat(110)}.txt`;
		await write(dir, "bundle.tgz:short.txt", "short\n");
		await write(dir, `bundle.tgz:${longPath}`, "long\n");
		await write(dir, "bundle.tgz:short.txt", "shorter\n");
		const { gunzipSync } = await import("node:zlib");
		const listing = await listTar(gunzipSync(await readFile(archive)));
		assert.deepEqual(
			listing.map(({ name, data }) => ({ name, data })),
			[
				{ name: "short.txt", data: "shorter\n" },
				{ name: longPath, data: "long\n" },
			],
		);
		assert.equal(await read(dir, `bundle.tgz:${longPath}`), "long\n");
	});

	it("refuses to overwrite a symlink member and leaves the archive unchanged (#4906)", async () => {
		const dir = await tempDir();
		const archive = join(dir, "bundle.tar");
		const original = Buffer.concat([
			tarMember({ name: "real.txt" }, "real\n"),
			tarMember({ name: "link", type: "2", linkname: "real.txt" }),
			Buffer.alloc(BLOCK * 2),
		]);
		await writeFile(archive, original);
		await assert.rejects(write(dir, "bundle.tar:link", "data"), /symbolic link/);
		assert.deepEqual(await readFile(archive), original);
	});

	it("refuses an archive whose header checksum is wrong (#4906)", async () => {
		const dir = await tempDir();
		const archive = join(dir, "bundle.tar");
		const original = Buffer.concat([tarMember({ name: "a.txt" }, "a\n"), Buffer.alloc(BLOCK * 2)]);
		original[0] = "b".charCodeAt(0);
		await writeFile(archive, original);
		await assert.rejects(write(dir, "bundle.tar:c.txt", "c"), /checksum/);
		assert.deepEqual(await readFile(archive), original);
	});
});
