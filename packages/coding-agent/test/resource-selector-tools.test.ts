import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import type { InternalResourceContext } from "../src/core/tools/resource-selectors.ts";
import { isDocumentPath } from "../src/core/tools/read-document-extract.ts";

function textOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
}
interface BunSqliteModule { Database: new (path: string) => { run(sql: string, ...params: string[]): void; close(): void } }
function loadBunSqlite(): BunSqliteModule | undefined {
	try { return createRequire(import.meta.url)("bun:sqlite") as BunSqliteModule; } catch { return undefined; }
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}
function patchZipMethod(file: string, entryName: string, method: number): void {
	const buf = Buffer.from(readFileSync(file));
	let eocd = -1;
	for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	let ptr = buf.readUInt32LE(eocd + 16);
	for (let n = 0; n < buf.readUInt16LE(eocd + 10); n++) {
		const nameLen = buf.readUInt16LE(ptr + 28), extraLen = buf.readUInt16LE(ptr + 30), commentLen = buf.readUInt16LE(ptr + 32), localOffset = buf.readUInt32LE(ptr + 42);
		const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString();
		if (name === entryName) { buf.writeUInt16LE(method, ptr + 10); buf.writeUInt16LE(method, localOffset + 8); break; }
		ptr += 46 + nameLen + extraLen + commentLen;
	}
	writeFileSync(file, buf);
}

describe("resource selector tools", () => {
	let testDir: string;
	let previousPrivateUrlAllowance: string | undefined;
	beforeEach(() => {
		previousPrivateUrlAllowance = process.env.ATOMIC_ALLOW_PRIVATE_URL_READS;
		process.env.ATOMIC_ALLOW_PRIVATE_URL_READS = "1";
		testDir = join(tmpdir(), `atomic-resource-selector-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});
	afterEach(() => { if (previousPrivateUrlAllowance === undefined) delete process.env.ATOMIC_ALLOW_PRIVATE_URL_READS; else process.env.ATOMIC_ALLOW_PRIVATE_URL_READS = previousPrivateUrlAllowance; rmSync(testDir, { recursive: true, force: true }); });
	it("reads writes and searches zip archive members", async () => {
		const write = createWriteToolDefinition(testDir);
		await write.execute("zip-write", { path: "bundle.zip:src/a.txt", content: "alpha\nneedle\nabc\n" }, undefined, undefined, {} as never);
		const readOutput = textOutput(await createReadToolDefinition(testDir).execute("zip-read", { path: "bundle.zip:src/a.txt" }, undefined, undefined, {} as never));
		expect(readOutput).toContain("needle");
		const searchOutput = textOutput(await createSearchToolDefinition(testDir).execute("zip-search", { pattern: "needle", paths: "bundle.zip:src/a.txt" }, undefined, undefined, {} as never));
		expect(searchOutput).toContain("bundle.zip:src/a.txt:2: needle");
		expect(searchOutput).toContain("bundle.zip:src/a.txt-1- alpha");
		expect(searchOutput).toContain("bundle.zip:src/a.txt-3- abc");
		const regexOutput = textOutput(await createSearchToolDefinition(testDir).execute("zip-regex", { pattern: "a.c", paths: "bundle.zip:src/a.txt" }, undefined, undefined, {} as never));
		expect(regexOutput).toContain("bundle.zip:src/a.txt:3: abc");
	});

	it("keeps archive regex semantics and splits delimiter-joined archive search paths", async () => {
		const write = createWriteToolDefinition(testDir);
		await write.execute("zip-case-write", { path: "case.zip:a.txt", content: "Needle\n" }, undefined, undefined, {} as never);
		await write.execute("zip-delim-a", { path: "d.zip:a.txt", content: "needle a\n" }, undefined, undefined, {} as never);
		await write.execute("zip-delim-b", { path: "d.zip:b.txt", content: "needle b\n" }, undefined, undefined, {} as never);
		const inline = textOutput(await createSearchToolDefinition(testDir).execute("zip-inline-case", { pattern: "(?i)needle", paths: "case.zip:a.txt" }, undefined, undefined, {} as never));
		expect(inline).toContain("Needle");
		const split = textOutput(await createSearchToolDefinition(testDir).execute("zip-delim-search", { pattern: "needle", paths: "d.zip:a.txt d.zip:b.txt" }, undefined, undefined, {} as never));
		expect(split).toContain("needle a");
		expect(split).toContain("needle b");
	});

	it("honors verbose regex comments for archive and internal resource searches", async () => {
		await createWriteToolDefinition(testDir).execute("zip-verbose-comment", { path: "verbose.zip:a.txt", content: "foobar\n" }, undefined, undefined, {} as never);
		const pattern = "(?x)foo # comment\n bar";
		const archiveOutput = textOutput(await createSearchToolDefinition(testDir).execute("zip-verbose-comment-search", { pattern, paths: "verbose.zip:a.txt" }, undefined, undefined, {} as never));
		expect(archiveOutput).toContain("foobar");
		const ctx: InternalResourceContext = { internalRouter: { read: () => "foobar\n" } };
		const internalOutput = textOutput(await createSearchToolDefinition(testDir).execute("internal-verbose-comment-search", { pattern, paths: "memory://note" }, undefined, undefined, ctx));
		expect(internalOutput).toContain("foobar");
	});

	it("preserves archive members with delimiters and ripgrep inline flags", async () => {
		const write = createWriteToolDefinition(testDir);
		await write.execute("zip-space-member", { path: "space.zip:a b.txt", content: "needle spaced\n" }, undefined, undefined, {} as never);
		writeFileSync(join(testDir, "b.txt"), "needle wrong\n");
		const spaced = textOutput(await createSearchToolDefinition(testDir).execute("zip-space-search", { pattern: "needle", paths: "space.zip:a b.txt" }, undefined, undefined, {} as never));
		expect(spaced).toContain("needle spaced");
		expect(spaced).not.toContain("needle wrong");
		await write.execute("zip-multiline", { path: "m.zip:a.txt", content: "foo\nbar\n" }, undefined, undefined, {} as never);
		const multiline = textOutput(await createSearchToolDefinition(testDir).execute("zip-inline-m", { pattern: "(?m)^bar", paths: "m.zip:a.txt" }, undefined, undefined, {} as never));
		await write.execute("zip-extended", { path: "x.zip:a.txt", content: "needle\n" }, undefined, undefined, {} as never);
		const extended = textOutput(await createSearchToolDefinition(testDir).execute("zip-inline-x", { pattern: "(?x)n e e d l e", paths: "x.zip:a.txt" }, undefined, undefined, {} as never));
		expect(extended).toContain("needle");
		expect(multiline).toContain("bar");
	});

	it("does not steal archive member names that look like read suffixes", async () => {
		await createWriteToolDefinition(testDir).execute("zip-raw-member", { path: "z.zip:raw", content: "hello\nthere\n" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("read-zip-raw-member", { path: "z.zip:raw" }, undefined, undefined, {} as never))).toBe("hello\nthere\n");
		expect(textOutput(await createReadToolDefinition(testDir).execute("read-zip-raw-member-line", { path: "z.zip:raw:1" }, undefined, undefined, {} as never))).toContain("hello");
		const rawRange = textOutput(await createReadToolDefinition(testDir).execute("read-zip-raw-range", { path: "z.zip:raw:2-2:raw" }, undefined, undefined, {} as never));
		expect(rawRange).toBe("there");
		await createWriteToolDefinition(testDir).execute("zip-normal-member", { path: "z.zip:a.txt", content: "one\ntwo\n" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("read-zip-normal-raw", { path: "z.zip:a.txt:raw" }, undefined, undefined, {} as never))).toBe("one\ntwo\n");
	});

	it("honors raw and conflict suffixes for extensionless archive members", async () => {
		const write = createWriteToolDefinition(testDir);
		await write.execute("zip-readme", { path: "extless.zip:README", content: "hello\n" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("read-readme-raw", { path: "extless.zip:README:raw" }, undefined, undefined, {} as never))).toBe("hello\n");
		await write.execute("zip-conflict-readme", { path: "extless.zip:CONFLICT", content: "before\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\nafter\n" }, undefined, undefined, {} as never);
		const output = textOutput(await createReadToolDefinition(testDir).execute("read-extless-conflict", { path: "extless.zip:CONFLICT:conflicts" }, undefined, undefined, {} as never));
		expect(output).toContain("<<<<<<< ours");
		expect(output).toContain("right");
		expect(output).not.toContain("before");
		expect(output).not.toContain("after");
	});

	it("honors archive read suffixes for colon members and before ranges", async () => {
		const write = createWriteToolDefinition(testDir);
		await write.execute("zip-colon-member", { path: "colon.zip:dir:file.txt", content: "needle\n" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("read-colon-raw", { path: "colon.zip:dir:file.txt:raw" }, undefined, undefined, {} as never))).toBe("needle\n");
		await write.execute("zip-literal-colon-raw", { path: "colon.zip:dir:file.txt:raw", content: "literal\n" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("read-literal-colon-raw", { path: "colon.zip:dir:file.txt:raw" }, undefined, undefined, {} as never))).toBe("literal\n");
		await write.execute("zip-range-conflict", { path: "combo.zip:file", content: "pre\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\npost\n" }, undefined, undefined, {} as never);
		const output = textOutput(await createReadToolDefinition(testDir).execute("read-conflict-before-range", { path: "combo.zip:file:conflicts:1-5" }, undefined, undefined, {} as never));
		expect(output).toContain("<<<<<<< ours");
		expect(output).toContain(">>>>>>> theirs");
		expect(output).not.toContain("pre");
	});

	it("filters conflict-only reads for archive members", async () => {
		await createWriteToolDefinition(testDir).execute("zip-conflict-member", { path: "conflict.zip:file.txt", content: "before\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\nafter\n" }, undefined, undefined, {} as never);
		const output = textOutput(await createReadToolDefinition(testDir).execute("read-zip-conflicts", { path: "conflict.zip:file.txt:conflicts" }, undefined, undefined, {} as never));
		expect(output).toContain("<<<<<<< ours");
		expect(output).toContain("left");
		expect(output).toContain("right");
		expect(output).toContain(">>>>>>> theirs");
		expect(output).not.toContain("before");
		expect(output).not.toContain("after");
	});

	it("reads and searches archive members named like line selectors", async () => {
		const write = createWriteToolDefinition(testDir);
		await write.execute("zip-number-member", { path: "num.zip:1", content: "needle\ninside\n" }, undefined, undefined, {} as never);
		await write.execute("zip-l-number-member", { path: "num.zip:L1", content: "letter\n" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("read-zip-number-member", { path: "num.zip:1" }, undefined, undefined, {} as never))).toContain("needle");
		expect(textOutput(await createReadToolDefinition(testDir).execute("read-zip-l-number-member", { path: "num.zip:L1" }, undefined, undefined, {} as never))).toContain("letter");
		expect(textOutput(await createSearchToolDefinition(testDir).execute("search-zip-number-member", { pattern: "needle", paths: "num.zip:1" }, undefined, undefined, {} as never))).toContain("needle");
	});

	it("does not strip suffix-looking archive member path segments", async () => {
		await createWriteToolDefinition(testDir).execute("zip-raw-segment", { path: "seg.zip:raw:notes.txt", content: "right\n" }, undefined, undefined, {} as never);
		await createWriteToolDefinition(testDir).execute("zip-plain-notes", { path: "seg.zip:notes.txt", content: "wrong\n" }, undefined, undefined, {} as never);
		const output = textOutput(await createReadToolDefinition(testDir).execute("read-raw-segment", { path: "seg.zip:raw:notes.txt" }, undefined, undefined, {} as never));
		expect(output).toContain("right");
		expect(output).not.toContain("wrong");
		await createWriteToolDefinition(testDir).execute("zip-conflicts-segment", { path: "seg.zip:conflicts:notes.txt", content: "conflict name\n" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("read-conflicts-segment", { path: "seg.zip:conflicts:notes.txt" }, undefined, undefined, {} as never))).toContain("conflict name");
	});


	it("truncates oversized URL reads through the fetch pipeline", async () => {
		const server = createServer((_req, res) => { res.setHeader("content-type", "text/plain"); res.end("x".repeat(60_000)); });
		const port = await listen(server);
		try {
			const result = await createReadToolDefinition(testDir).execute("url-oversized", { path: `http://127.0.0.1:${port}/large.txt` }, undefined, undefined, {} as never);
			// oh-my-pi's URL pipeline truncates (and persists an artifact when a session dir exists) rather than hard-blocking.
			expect(textOutput(result)).toContain("Showing first");
			expect(result.details?.meta?.source).toContain("large.txt");
		} finally { await new Promise((resolve) => server.close(resolve)); }
	});

	it("surfaces pagination for archive search pages", async () => {
		const write = createWriteToolDefinition(testDir);
		for (let index = 1; index <= 21; index++) await write.execute("zip-page-write", { path: `page.zip:f${String(index).padStart(2, "0")}.txt`, content: "needle\n" }, undefined, undefined, {} as never);
		const output = textOutput(await createSearchToolDefinition(testDir).execute("zip-page-search", { pattern: "needle", paths: "page.zip:" }, undefined, undefined, {} as never));
		expect(output).toContain("Use skip=20");
		expect(output).not.toContain("f21.txt");
		const next = textOutput(await createSearchToolDefinition(testDir).execute("zip-page-search-skip", { pattern: "needle", paths: "page.zip:", skip: 20 }, undefined, undefined, {} as never));
		expect(next).toContain("f21.txt");
	});

	it("resolves archive paths when probing later search pages", async () => {
		for (let index = 1; index <= 20; index++) writeFileSync(join(testDir, `first-${String(index).padStart(2, "0")}.txt`), "needle\n");
		await createWriteToolDefinition(testDir).execute("later-zip-write", { path: "later.zip:a.txt", content: "needle later\n" }, undefined, undefined, {} as never);
		const paths = [...Array.from({ length: 20 }, (_, index) => `first-${String(index + 1).padStart(2, "0")}.txt`), "later.zip:"];
		const output = textOutput(await createSearchToolDefinition(testDir).execute("later-zip-probe", { pattern: "needle", paths }, undefined, undefined, {} as never));
		expect(output).toContain("Use skip=20");
		expect(output).not.toContain("ENOENT");
	});

	it("does not return resource search context when selected range has no match", async () => {
		await createWriteToolDefinition(testDir).execute("zip-range-write", { path: "range.zip:a.txt", content: "alpha\nneedle\nomega\n" }, undefined, undefined, {} as never);
		const output = textOutput(await createSearchToolDefinition(testDir).execute("zip-range-miss", { pattern: "needle", paths: "range.zip:a.txt:1-1" }, undefined, undefined, {} as never));
		expect(output).toBe("No matches found");
	});

	it("writes selected zip members without inflating unrelated entries", async () => {
		const write = createWriteToolDefinition(testDir);
		await write.execute("zip-write-small", { path: "mixed.zip:small.txt", content: "old\n" }, undefined, undefined, {} as never);
		await write.execute("zip-write-bad", { path: "mixed.zip:bad.bin", content: "bad\n" }, undefined, undefined, {} as never);
		patchZipMethod(join(testDir, "mixed.zip"), "bad.bin", 99);
		await write.execute("zip-rewrite-small", { path: "mixed.zip:small.txt", content: "new\n" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("zip-reread-small", { path: "mixed.zip:small.txt" }, undefined, undefined, {} as never))).toContain("new");
	});

	it("blocks oversized archive member reads like file reads", async () => {
		await createWriteToolDefinition(testDir).execute("zip-write-big", { path: "big.zip:big.txt", content: `sentinel\n${"x".repeat(50_001)}` }, undefined, undefined, {} as never);
		const output = textOutput(await createReadToolDefinition(testDir).execute("zip-read-big", { path: "big.zip:big.txt" }, undefined, undefined, {} as never));
		expect(output).toContain("File read blocked");
		expect(output).not.toContain("sentinel\n");
	});

	it("blocks multibyte archive member reads by byte size", async () => {
		await createWriteToolDefinition(testDir).execute("zip-write-emoji", { path: "emoji.zip:big.txt", content: "🙂".repeat(20_000) }, undefined, undefined, {} as never);
		const output = textOutput(await createReadToolDefinition(testDir).execute("zip-read-emoji", { path: "emoji.zip:big.txt" }, undefined, undefined, {} as never));
		expect(output).toContain("File read blocked");
		expect(output).not.toContain("🙂🙂🙂");
	});
	it("pages search results across archive and filesystem targets", async () => {
		await createWriteToolDefinition(testDir).execute("zip-write-skip", { path: "bundle.zip:a.txt", content: "needle zip\n" }, undefined, undefined, {} as never);
		writeFileSync(join(testDir, "b.txt"), "needle file\n");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-skip-resource", { pattern: "needle", paths: ["bundle.zip:a.txt", "b.txt"], skip: 1 }, undefined, undefined, {} as never));
		expect(output).toContain("b.txt");
		expect(output).toContain("needle file");
		expect(output).not.toContain("bundle.zip");
	});

	it("limits first-page archive search results", async () => {
		const write = createWriteToolDefinition(testDir);
		for (let index = 1; index <= 21; index++) {
			await write.execute(`zip-write-page-${index}`, { path: `many.zip:${String(index).padStart(2, "0")}.txt`, content: `needle ${index}\n` }, undefined, undefined, {} as never);
		}
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-resource-page-limit", { pattern: "needle", paths: "many.zip:" }, undefined, undefined, {} as never));
		expect(output).toContain("20.txt");
		expect(output).not.toContain("21.txt");
	});

	it("searches multiline regex patterns in archive and internal resources", async () => {
		await createWriteToolDefinition(testDir).execute("zip-write-multiline", { path: "multi.zip:a.txt", content: "foo\nbar\n" }, undefined, undefined, {} as never);
		const archiveOutput = textOutput(await createSearchToolDefinition(testDir).execute("search-archive-multiline", { pattern: "foo\\nbar", paths: "multi.zip:a.txt" }, undefined, undefined, {} as never));
		expect(archiveOutput).toContain("foo");
		expect(archiveOutput).toContain("bar");
		const ctx: InternalResourceContext = { internalRouter: { read: () => "foo\nbar\n" } };
		const internalOutput = textOutput(await createSearchToolDefinition(testDir).execute("search-internal-multiline", { pattern: "foo\\nbar", paths: "memory://multi" }, undefined, undefined, ctx as never));
		expect(internalOutput).toContain("foo");
		expect(internalOutput).toContain("bar");
	});

	it("reads writes and searches tar archive members without host python", async () => {
		const originalPath = process.env.PATH;
		process.env.PATH = "";
		try {
			const write = createWriteToolDefinition(testDir);
			await write.execute("tar-write", { path: "bundle.tar:src/a.txt", content: "alpha\nneedle\n" }, undefined, undefined, {} as never);
			const readOutput = textOutput(await createReadToolDefinition(testDir).execute("tar-read", { path: "bundle.tar:src/a.txt" }, undefined, undefined, {} as never));
			expect(readOutput).toContain("needle");
			const searchOutput = textOutput(await createSearchToolDefinition(testDir).execute("tar-search", { pattern: "needle", paths: "bundle.tar:src/a.txt" }, undefined, undefined, {} as never));
			expect(searchOutput).toContain("bundle.tar:src/a.txt:2: needle");
		} finally {
			process.env.PATH = originalPath;
		}
	});
	it("routes legacy Office binaries through markit like oh-my-pi", async () => {
		expect(isDocumentPath("proposal.doc")).toBe(true);
		expect(isDocumentPath("deck.ppt")).toBe(true);
		expect(isDocumentPath("sheet.xls")).toBe(true);
		for (const [file, ext] of [["proposal.doc", ".doc"], ["deck.ppt", ".ppt"], ["sheet.xls", ".xls"]] as const) {
			writeFileSync(join(testDir, file), `legacy ${ext}`);
			const output = textOutput(await createReadToolDefinition(testDir).execute(`legacy-${ext}`, { path: file }, undefined, undefined, {} as never));
			expect(output).toContain(`[Cannot read ${ext} file: Unsupported format: ${ext}]`);
		}
	});

	it("treats existing non-SQLite .db files as plain files", async () => {
		writeFileSync(join(testDir, "notes.db"), "one\ntwo\n");
		expect(textOutput(await createReadToolDefinition(testDir).execute("plain-db-read", { path: "notes.db" }, undefined, undefined, {} as never))).toContain("one");
		expect(textOutput(await createReadToolDefinition(testDir).execute("plain-db-read-line", { path: "notes.db:2-2" }, undefined, undefined, {} as never))).toContain("two");
		const sqlite = loadBunSqlite();
		if (sqlite) {
			const rawDb = new sqlite.Database(join(testDir, "tokens.sqlite"));
			rawDb.run("create table raw (id integer primary key, name text)");
			rawDb.run("create table conflicts (id integer primary key, name text)");
			rawDb.run("insert into raw values (1, 'Raw Table')");
			rawDb.run("insert into conflicts values (1, 'Conflict Table')");
			rawDb.close();
			expect(textOutput(await createReadToolDefinition(testDir).execute("sqlite-raw-table", { path: "tokens.sqlite:raw" }, undefined, undefined, {} as never))).toContain("Raw Table");
			expect(textOutput(await createReadToolDefinition(testDir).execute("sqlite-conflicts-table", { path: "tokens.sqlite:conflicts" }, undefined, undefined, {} as never))).toContain("Conflict Table");
		}
		expect(textOutput(await createSearchToolDefinition(testDir).execute("plain-db-search-line", { pattern: "two", paths: "notes.db:2-2" }, undefined, undefined, {} as never))).toContain("two");
		await createWriteToolDefinition(testDir).execute("plain-db-write", { path: "notes.db", content: "plain\n" }, undefined, undefined, {} as never);
		expect(readFileSync(join(testDir, "notes.db"), "utf8")).toBe("plain\n");
	});

	it("creates missing bare .db paths as plain files", async () => {
		await createWriteToolDefinition(testDir).execute("plain-db-create", { path: "new-notes.db", content: "hello\n" }, undefined, undefined, {} as never);
		expect(readFileSync(join(testDir, "new-notes.db"), "utf8")).toBe("hello\n");
	});

	it("smoke-tests SQLite selector edge cases under Bun runtime", () => {
		const script = `
			import { mkdtempSync, rmSync } from "node:fs";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			import { Database } from "bun:sqlite";
			const modRoot = process.cwd().endsWith("packages/coding-agent") ? "./src/core/tools" : "./packages/coding-agent/src/core/tools";
			const { createReadToolDefinition } = await import(modRoot + "/read.ts");
			const { createSearchToolDefinition } = await import(modRoot + "/search.ts");
			const dir = mkdtempSync(join(tmpdir(), "atomic-sqlite-smoke-"));
			try {
				const db = new Database(join(dir, "data.sqlite"));
				db.run("create table users (uuid text primary key, name text)");
				db.run("create table items (id integer primary key, body text)");
				db.run("insert into users values ('42', 'Ada')");
				db.run("insert into users values ('abc', 'Ada Text')");
				for (let i = 1; i <= 1001; i++) db.run("insert into items values (?, ?)", i, i === 1001 ? "needle-target" : "other");
				db.close();
				const other = new Database(join(dir, "other.sqlite"));
				other.run("create table users (uuid text primary key, name text)");
				other.run("insert into users values ('abc', 'Ada Text')");
				other.close();
				const space = new Database(join(dir, "space.sqlite"));
				space.run("create table users (uuid text primary key, name text)");
				space.run("insert into users values ('abc def', 'Ada Space')");
				space.close();
				const space2 = new Database(join(dir, "space2.sqlite"));
				space2.run("create table users (uuid text primary key, name text)");
				space2.run("insert into users values ('ghi jkl', 'Ada Space')");
				space2.close();
				const text = (r) => r.content.map((item) => item.text ?? "").join("\\n");
				const read = createReadToolDefinition(dir), search = createSearchToolDefinition(dir);
				const listing = text(await read.execute("listing", { path: "data.sqlite:1" }));
				if (!listing.includes("users")) throw new Error("missing listing line selector");
				const rawRow = text(await read.execute("row-raw", { path: "data.sqlite:users:42:raw" }));
				if (!rawRow.includes("Ada") || rawRow.includes("Schema:")) throw new Error("row raw selector widened");
				const oob = text(await read.execute("oob", { path: "data.sqlite:99-99" }));
				if (!oob.includes("Requested line 99")) throw new Error("missing oob message");
				const rangeSearch = text(await search.execute("range", { pattern: "items", paths: "data.sqlite:1-1" }));
				if (!rangeSearch.includes("items") || rangeSearch.includes("[data.sqlite#")) throw new Error("bad sqlite range search");
				const textKey = text(await search.execute("text-key", { pattern: "Ada", paths: "data.sqlite:users" }));
				if (!textKey.includes("data.sqlite:users:abc:")) throw new Error("missing text key search");
				const multiTextKey = text(await search.execute("multi-text-key", { pattern: "Ada Text", paths: ["data.sqlite:users", "other.sqlite:users"] }));
				if (!multiTextKey.includes("data.sqlite:users:abc:") || !multiTextKey.includes("other.sqlite:users:abc:")) throw new Error("missing multi text key search");
				const pagedVirtual = text(await search.execute("paged-virtual", { pattern: "users", paths: ["data.sqlite", "other.sqlite"], skip: 1 }));
				if (pagedVirtual.includes("[other.sqlite#") || !pagedVirtual.includes("other.sqlite:tables:1:")) throw new Error("bad paged virtual output");
				const pagedSpace = text(await search.execute("paged-space-key", { pattern: "Ada Space", paths: ["space.sqlite:users", "space2.sqlite:users"], skip: 1 }));
				if (!pagedSpace.includes("space2.sqlite:users:ghi jkl:")) throw new Error("missing paged whitespace primary key search");
				const numericRow = text(await search.execute("numeric-row", { pattern: "needle-target", paths: "data.sqlite:items:1001" }));
				if (!numericRow.includes("needle-target")) throw new Error("missing numeric row search");
			} finally { rmSync(dir, { recursive: true, force: true }); }
		`;
		const result = spawnSync("bun", ["-e", script], { cwd: process.cwd(), encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	(loadBunSqlite() ? it : it.skip)("reads writes and searches SQLite selectors", async () => {
		writeFileSync(join(testDir, ".keep"), "");
		const dbPath = join(testDir, "data.sqlite");
		const Database = loadBunSqlite()!.Database;
		const db = new Database(dbPath);
		db.run("create table users (uuid text primary key, name text)");
		db.run("create table numbers (id integer primary key, flags integer, score integer)");
		db.run("insert into users values ('42', 'Alan')");
		db.run("insert into users values ('abc', 'Ada Text')");
		db.close();
		await createWriteToolDefinition(testDir).execute("sqlite-write", { path: "data.sqlite:users:42", content: "{name: 'Ada',}" }, undefined, undefined, {} as never);
		await createWriteToolDefinition(testDir).execute("sqlite-insert", { path: "data.sqlite:users", content: "{id: '7', name: 'Grace'}" }, undefined, undefined, {} as never);
		await createWriteToolDefinition(testDir).execute("sqlite-json5-numbers", { path: "data.sqlite:numbers", content: "{flags: 0x10, score: +1}" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("sqlite-json5-numbers-read", { path: "data.sqlite:numbers:1" }, undefined, undefined, {} as never))).toContain('"flags":16');
		await createWriteToolDefinition(testDir).execute("sqlite-hex-string", { path: "data.sqlite:users:42", content: "{name: '0x10'}" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("sqlite-hex-string-read", { path: "data.sqlite:users:42" }, undefined, undefined, {} as never))).toContain("0x10");
		await createWriteToolDefinition(testDir).execute("sqlite-hex-number", { path: "data.sqlite:users:42", content: "{name: 0x10}" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("sqlite-hex-number-read", { path: "data.sqlite:users:42" }, undefined, undefined, {} as never))).toContain("16");
		const bigDb = new Database(join(testDir, "big.sqlite"));
		bigDb.run("create table blobs (body text)");
		bigDb.run("insert into blobs values (?)", "x".repeat(60_000));
		bigDb.close();
		expect(textOutput(await createReadToolDefinition(testDir).execute("sqlite-big-read", { path: "big.sqlite:blobs" }, undefined, undefined, {} as never))).toContain("File read blocked");
		await createWriteToolDefinition(testDir).execute("sqlite-json5-comments", { path: "data.sqlite:users:42", content: "{name: 'Ada', // user\n}" }, undefined, undefined, {} as never);
		const rawTable = textOutput(await createReadToolDefinition(testDir).execute("sqlite-raw-table", { path: "data.sqlite:users:raw" }, undefined, undefined, {} as never));
		expect(rawTable).toContain("Ada");
		const rangedListing = textOutput(await createReadToolDefinition(testDir).execute("sqlite-range-listing", { path: "data.sqlite:1-1" }, undefined, undefined, {} as never));
		expect(rangedListing).toContain("users");
		const rangedOob = textOutput(await createReadToolDefinition(testDir).execute("sqlite-range-oob", { path: "data.sqlite:99-99" }, undefined, undefined, {} as never));
		expect(rangedOob).toContain("Requested line 99 is beyond end of resource");
		const readOutput = textOutput(await createReadToolDefinition(testDir).execute("sqlite-read", { path: "data.sqlite:users:42" }, undefined, undefined, {} as never));
		expect(readOutput).toContain("Ada");
		const readRawRow = textOutput(await createReadToolDefinition(testDir).execute("sqlite-read-raw-row", { path: "data.sqlite:users:42:raw" }, undefined, undefined, {} as never));
		expect(readRawRow).toContain("Ada");
		expect(readRawRow).not.toContain("Schema:");
		const searchOutput = textOutput(await createSearchToolDefinition(testDir).execute("sqlite-search", { pattern: "Ada", paths: "data.sqlite:users" }, undefined, undefined, {} as never));
		expect(searchOutput).toContain("Ada");
		const regexOutput = textOutput(await createSearchToolDefinition(testDir).execute("sqlite-regex", { pattern: "A.a", paths: "data.sqlite:users" }, undefined, undefined, {} as never));
		expect(regexOutput).toContain("Ada");
		const insensitiveOutput = textOutput(await createSearchToolDefinition(testDir).execute("sqlite-insensitive", { pattern: "ada", paths: "data.sqlite:users", i: true }, undefined, undefined, {} as never));
		expect(insensitiveOutput).toContain("Ada");
		const inlineSqlite = textOutput(await createSearchToolDefinition(testDir).execute("sqlite-inline-i", { pattern: "(?i)ada", paths: "data.sqlite:users" }, undefined, undefined, {} as never));
		expect(inlineSqlite).toContain("Ada");
		const listingSearch = textOutput(await createSearchToolDefinition(testDir).execute("sqlite-listing-range-search", { pattern: "users", paths: "data.sqlite:2-2" }, undefined, undefined, {} as never));
		expect(listingSearch).toContain("users");
		expect(listingSearch).not.toContain("[");
		const rowSearch = textOutput(await createSearchToolDefinition(testDir).execute("sqlite-row-search", { pattern: "Ada", paths: "data.sqlite:users:42" }, undefined, undefined, {} as never));
		expect(rowSearch).toContain("Ada");
		expect(searchOutput).toContain("data.sqlite:users:42:");
		const textKeySearch = textOutput(await createSearchToolDefinition(testDir).execute("sqlite-text-key-search", { pattern: "Ada Text", paths: "data.sqlite:users" }, undefined, undefined, {} as never));
		expect(textKeySearch).toContain("data.sqlite:users:abc:");
		const implicitDb = new Database(join(testDir, "implicit.sqlite"));
		implicitDb.run("create table notes (body text)");
		implicitDb.run("insert into notes values ('gone')");
		implicitDb.run("insert into notes values ('needle row')");
		implicitDb.run("delete from notes where rowid = 1");
		implicitDb.close();
		const implicitSearch = textOutput(await createSearchToolDefinition(testDir).execute("sqlite-implicit-rowid-search", { pattern: "needle", paths: "implicit.sqlite:notes" }, undefined, undefined, {} as never));
		expect(implicitSearch).toContain("implicit.sqlite:notes:2:");
		expect(textOutput(await createReadToolDefinition(testDir).execute("sqlite-implicit-rowid-read", { path: "implicit.sqlite:notes:2" }, undefined, undefined, {} as never))).toContain("needle row");
		const paged = textOutput(await createReadToolDefinition(testDir).execute("sqlite-page", { path: "data.sqlite:users?limit=1&offset=2&order=name:asc" }, undefined, undefined, {} as never));
		expect(paged).toContain("Grace");
		expect(paged).not.toContain("Ada");
		const filtered = textOutput(await createReadToolDefinition(testDir).execute("sqlite-filter", { path: "data.sqlite:users?where=name%3D'Ada'" }, undefined, undefined, {} as never));
		expect(filtered).toContain("Ada");
		expect(filtered).not.toContain("Grace");
		await expect(createReadToolDefinition(testDir).execute("sqlite-bad-filter", { path: "data.sqlite:users?where=1%3D1%20LIMIT%201000000%20--&limit=1" }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid SQLite where/);
		const manyDb = new Database(join(testDir, "many.sqlite"));
		manyDb.run("create table rows (id integer primary key, name text)");
		for (let index = 1; index <= 10; index++) manyDb.run(`insert into rows values (${index}, 'row ${index}')`);
		manyDb.close();
		const sample = textOutput(await createReadToolDefinition(testDir).execute("sqlite-sample", { path: "many.sqlite:rows" }, undefined, undefined, {} as never));
		expect(sample).toContain("row 5");
		expect(sample).not.toContain("row 6");
		expect(textOutput(await createReadToolDefinition(testDir).execute("sqlite-read-insert", { path: "data.sqlite:users:7" }, undefined, undefined, {} as never))).toContain("Grace");
		await createWriteToolDefinition(testDir).execute("sqlite-delete", { path: "data.sqlite:users:7", content: "" }, undefined, undefined, {} as never);
		expect(textOutput(await createReadToolDefinition(testDir).execute("sqlite-read-deleted", { path: "data.sqlite:users:7" }, undefined, undefined, {} as never))).toBe("");
		await expect(createWriteToolDefinition(testDir).execute("sqlite-missing", { path: "missing.sqlite:users:1", content: JSON.stringify({ name: "Nope" }) }, undefined, undefined, {} as never)).rejects.toThrow(/SQLite database/);
		await expect(createWriteToolDefinition(testDir).execute("sqlite-empty-table", { path: "data.sqlite:users", content: "" }, undefined, undefined, {} as never)).rejects.toThrow(/empty content/);
		await expect(createWriteToolDefinition(testDir).execute("sqlite-array", { path: "data.sqlite:users", content: "[]" }, undefined, undefined, {} as never)).rejects.toThrow(/JSON object/);
		await expect(createWriteToolDefinition(testDir).execute("sqlite-unknown-query-write", { path: "data.sqlite:users?foo=bar", content: "{name:'Ada'}" }, undefined, undefined, {} as never)).rejects.toThrow(/query parameters/);
		await createWriteToolDefinition(testDir).execute("sqlite-long", { path: "data.sqlite:users:42", content: `{name:'${"x".repeat(2200)}needle'}` }, undefined, undefined, {} as never);
		const longSearch = textOutput(await createSearchToolDefinition(testDir).execute("sqlite-long-search", { pattern: "needle", paths: "data.sqlite:users:42" }, undefined, undefined, {} as never));
		expect(longSearch.length).toBeLessThan(2400);
		expect(longSearch).toContain("[truncated]");
	});
	it("reads searches and writes internal artifact resources through the session router", async () => {
		const resources = new Map<string, string>();
		const ctx: InternalResourceContext = { internalRouter: { read: (url) => resources.get(url) ?? "", write: (url, content) => { resources.set(url, content); } } };
		await createWriteToolDefinition(testDir).execute("artifact-write", { path: "artifact://notes/a.txt", content: "needle\n" }, undefined, undefined, ctx as never);
		await expect(createWriteToolDefinition(testDir).execute("conflict-scope-write", { path: "conflict://abc/ours", content: "resolved\n" }, undefined, undefined, {} as never)).rejects.toThrow(/read-only/);
		expect(textOutput(await createReadToolDefinition(testDir).execute("artifact-read", { path: "artifact://notes/a.txt" }, undefined, undefined, ctx as never))).toContain("needle");
		expect(textOutput(await createSearchToolDefinition(testDir).execute("artifact-search", { paths: "artifact://notes/a.txt", pattern: "n.edle" }, undefined, undefined, ctx as never))).toContain("needle");
	});
	it("splices conflict id and bulk writes without clobbering surrounding content", async () => {
		writeFileSync(join(testDir, "one.txt"), "before\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\nafter\n");
		await createWriteToolDefinition(testDir).execute("conflict-one", { path: "conflict://1", content: "@theirs\n" }, undefined, undefined, {} as never);
		expect(readFileSync(join(testDir, "one.txt"), "utf8")).toBe("before\nright\nafter\n");
		writeFileSync(join(testDir, "z.txt"), "Z\n<<<<<<< ours\nzo\n=======\nzt\n>>>>>>> theirs\nZ2\n");
		writeFileSync(join(testDir, "a-read.txt"), "A\n<<<<<<< ours\nao\n=======\nat\n>>>>>>> theirs\nA2\n");
		await createReadToolDefinition(testDir).execute("read-a-conflict", { path: "a-read.txt:conflicts" }, undefined, undefined, {} as never);
		await createWriteToolDefinition(testDir).execute("conflict-registered", { path: "conflict://1", content: "@theirs\n" }, undefined, undefined, {} as never);
		expect(readFileSync(join(testDir, "a-read.txt"), "utf8")).toBe("A\nat\nA2\n");
		expect(readFileSync(join(testDir, "z.txt"), "utf8")).toContain("<<<<<<< ours");
		writeFileSync(join(testDir, "a.txt"), "A\n<<<<<<< ours\no\n=======\nt\n>>>>>>> theirs\nZ\n");
		writeFileSync(join(testDir, "b.txt"), "B\n<<<<<<< ours\no2\n=======\nt2\n>>>>>>> theirs\nY\n");
		await createWriteToolDefinition(testDir).execute("conflict-all", { path: "conflict://*", content: "resolved\n" }, undefined, undefined, {} as never);
		expect(readFileSync(join(testDir, "a.txt"), "utf8")).toBe("A\nresolved\nZ\n");
		expect(readFileSync(join(testDir, "b.txt"), "utf8")).toBe("B\nresolved\nY\n");
	});

	it("rejects generated plain-file overwrites", async () => {
		writeFileSync(join(testDir, "gen.ts"), "// @generated\nold\n");
		await expect(createWriteToolDefinition(testDir).execute("generated-write", { path: "gen.ts", content: "new\n" }, undefined, undefined, {} as never)).rejects.toThrow(/generated file/);
	});

	it("truncates resource-backed search lines", async () => {
		const ctx: InternalResourceContext = { internalRouter: { read: () => `${"x".repeat(2200)}needle` } };
		const output = textOutput(await createSearchToolDefinition(testDir).execute("resource-long-line", { paths: "memory://note", pattern: "needle" }, undefined, undefined, ctx as never));
		expect(output.length).toBeLessThan(2100);
		expect(output).toContain("[truncated]");
	});

	it("applies line selectors to internal resource URLs", async () => {
		const resources = new Map<string, string>([["memory://note", "one\ntwo\nthree"]]);
		const ctx: InternalResourceContext = { internalRouter: { read: (url) => resources.get(url) ?? "" } };
		const output = textOutput(await createReadToolDefinition(testDir).execute("memory-read", { path: "memory://note:2-2" }, undefined, undefined, ctx as never));
		expect(output).toBe("one\ntwo\nthree");
	});

	it("converts notebooks to editable cells", async () => {
		writeFileSync(join(testDir, "big.ipynb"), JSON.stringify({ cells: [{ cell_type: "code", source: ["x".repeat(60_000)] }] }));
		expect(textOutput(await createReadToolDefinition(testDir).execute("ipynb-big", { path: "big.ipynb" }, undefined, undefined, {} as never))).toContain("File read blocked");
		writeFileSync(join(testDir, "notebook.ipynb"), JSON.stringify({ cells: [{ cell_type: "markdown", source: ["# Title\n"] }, { cell_type: "code", source: ["print('hi')\n"] }] }));
		const output = textOutput(await createReadToolDefinition(testDir).execute("ipynb-read", { path: "notebook.ipynb" }, undefined, undefined, {} as never));
		expect(output).toContain("# %% [markdown] cell:0");
		expect(output).toContain("# %% [code] cell:1");
		const outOfRange = textOutput(await createReadToolDefinition(testDir).execute("ipynb-oob", { path: "notebook.ipynb:99" }, undefined, undefined, {} as never));
		expect(outOfRange).toContain("Requested line 99 is beyond end of file");
	});

});
