import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.js";
import { createToolDefinition } from "../src/core/tools/index.js";
import type { InternalResourceContext } from "../src/core/tools/resource-selectors.js";
import { invalidateNativeSearchCache } from "../src/core/tools/search-native.js";
import { createWriteToolDefinition } from "../src/core/tools/write.js";
import { TestSqliteDatabase } from "./helpers/sqlite.js";

vi.mock("../src/core/tools/search-native.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/tools/search-native.js")>()),
	invalidateNativeSearchCache: vi.fn(),
}));

const tempDirs: string[] = [];

afterEach(async () => {
	vi.mocked(invalidateNativeSearchCache).mockClear();
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "write-selectors-"));
	tempDirs.push(dir);
	return dir;
}

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown };

const textOf = (result: ToolResult) => result.content.map((item) => item.text ?? "").join("\n");

async function write(dir: string, path: string, content: string, ctx: object = {}): Promise<ToolResult> {
	return createToolDefinition("write", dir).execute(
		"write",
		{ path, content },
		undefined,
		undefined,
		ctx as ExtensionToolContext,
	) as Promise<ToolResult>;
}

const CONFLICT = (ours: string, theirs: string, base?: string) =>
	`<<<<<<< ours\n${ours}\n${base === undefined ? "" : `||||||| base\n${base}\n`}=======\n${theirs}\n>>>>>>> theirs\n`;

describe("conflict:// writes", () => {
	it.each([
		["@ours", "left"],
		["@theirs", "right"],
		[" @base\n", "origin"],
		["merged\n", "merged"],
		["two\nlines", "two\nlines"],
	])("resolves %j to %j", async (content, resolved) => {
		const dir = await tempDir();
		const file = join(dir, "c.txt");
		await writeFile(file, `pre\n${CONFLICT("left", "right", "origin")}post\n`);
		const result = await write(dir, "conflict://1", content);
		assert.deepEqual(result.content, [{ type: "text", text: "Resolved conflict 1" }]);
		assert.equal(result.details, undefined);
		assert.equal(await readFile(file, "utf8"), `pre\n${resolved}\npost\n`);
		assert.ok(vi.mocked(invalidateNativeSearchCache).mock.calls.some((call) => isDeepStrictEqual(call, [file])));
	});

	it("removes the region for empty content", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "c.txt"), `pre\n${CONFLICT("left", "right")}post\n`);
		await write(dir, "conflict://1", "");
		assert.equal(await readFile(join(dir, "c.txt"), "utf8"), "pre\npost\n");
	});

	it("resolves every region with conflict://*, bottom-up so earlier regions keep their lines", async () => {
		const dir = await tempDir();
		const file = join(dir, "c.txt");
		await writeFile(file, `a\n${CONFLICT("one", "uno")}b\n${CONFLICT("two-a\ntwo-b", "dos")}c\n`);
		const result = await write(dir, "conflict://*", "@theirs");
		assert.deepEqual(result.content, [{ type: "text", text: "Resolved 2 conflicts" }]);
		assert.equal(await readFile(file, "utf8"), "a\nuno\nb\ndos\nc\n");
	});

	it("names a single region without a plural", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "c.txt"), CONFLICT("one", "uno"));
		assert.equal(textOf(await write(dir, "conflict://*", "@ours")), "Resolved 1 conflict");
	});

	it.each(["1a", "a1", "-1", "1.5"])("refuses the non-numeric id %j", async (id) => {
		const dir = await tempDir();
		await writeFile(join(dir, "c.txt"), CONFLICT("one", "uno"));
		await assert.rejects(write(dir, `conflict://${id}`, "@ours"), (error: unknown) => {
			assert.partialDeepStrictEqual({ ...(error as object) }, { code: "conflict-target-invalid" });
			return true;
		});
	});

	it("resolves a two-digit id", async () => {
		const dir = await tempDir();
		const regions = Array.from({ length: 12 }, (_, index) => CONFLICT(`o${index}`, `t${index}`)).join("");
		await writeFile(join(dir, "c.txt"), regions);
		assert.equal(textOf(await write(dir, "conflict://12", "@theirs")), "Resolved conflict 12");
		assert.ok((await readFile(join(dir, "c.txt"), "utf8")).includes("\nt11\n"));
	});
});

describe("other selector targets", () => {
	it("reports SQLite writes and their database", async () => {
		const dir = await tempDir();
		const database = join(dir, "data.sqlite");
		const db = new TestSqliteDatabase(database);
		db.run("create table users (id integer primary key, name text)");
		db.close();
		const result = await write(dir, "data.sqlite:users", "{name: 'Ada'}");
		assert.equal(result.content.length, 1);
		assert.equal(result.content[0]?.type, "text");
		assert.match(result.content[0]?.text ?? "", /^Inserted row/);
		assert.deepEqual(result.details, { meta: { sourcePath: database } });
	});

	it("reports archive writes and the archive they landed in", async () => {
		const dir = await tempDir();
		const result = await write(dir, "bundle.zip:notes.txt", "hello");
		assert.deepEqual(result.content, [{ type: "text", text: "Successfully wrote to bundle.zip:notes.txt" }]);
		assert.deepEqual(result.details, { resolvedPath: join(dir, "bundle.zip") });
	});

	it("routes internal URLs through the session router", async () => {
		const dir = await tempDir();
		const written: Array<[string, string]> = [];
		const ctx: InternalResourceContext = {
			internalRouter: {
				write: async (url: string, content: string) => {
					written.push([url, content]);
				},
			},
		};
		const result = await write(dir, "history://note", "body", ctx);
		assert.deepEqual(result.content, [{ type: "text", text: "Successfully wrote to history://note" }]);
		assert.deepEqual(result.details, {});
		assert.deepEqual(written, [["history://note", "body"]]);
	});

	it("names the selector targets in the built-in description, after pi's", () => {
		const description = createToolDefinition("write", "/").description;
		assert.equal(description.startsWith(createWriteToolDefinition("/").description), true);
		assert.ok(description.includes("conflict://<id> or conflict://*"));
		assert.ok(description.includes("local://"));
	});
});

describe("built-in local file operations", () => {
	it("drop the written file from the native search cache", async () => {
		const dir = await tempDir();
		await write(dir, "plain.txt", "one\n");
		assert.ok(
			vi
				.mocked(invalidateNativeSearchCache)
				.mock.calls.some((call) => isDeepStrictEqual(call, [join(dir, "plain.txt")])),
		);
		vi.mocked(invalidateNativeSearchCache).mockClear();
		await createToolDefinition("edit", dir).execute(
			"edit",
			{ path: "plain.txt", edits: [{ oldText: "one", newText: "two" }] },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		assert.ok(
			vi
				.mocked(invalidateNativeSearchCache)
				.mock.calls.some((call) => isDeepStrictEqual(call, [join(dir, "plain.txt")])),
		);
		assert.equal(await readFile(join(dir, "plain.txt"), "utf8"), "two\n");
	});
});
