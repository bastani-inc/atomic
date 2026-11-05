import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createToolDefinition } from "../src/core/tools/index.ts";
import type { InternalResourceContext } from "../src/core/tools/resource-selectors.ts";
import { invalidateNativeSearchCache } from "../src/core/tools/search-native.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { TestSqliteDatabase } from "./helpers/sqlite.ts";

vi.mock("../src/core/tools/search-native.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/tools/search-native.ts")>()),
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
		expect(result.content).toEqual([{ type: "text", text: "Resolved conflict 1" }]);
		expect(result.details).toBeUndefined();
		expect(await readFile(file, "utf8")).toBe(`pre\n${resolved}\npost\n`);
		expect(invalidateNativeSearchCache).toHaveBeenCalledWith(file);
	});

	it("removes the region for empty content", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "c.txt"), `pre\n${CONFLICT("left", "right")}post\n`);
		await write(dir, "conflict://1", "");
		expect(await readFile(join(dir, "c.txt"), "utf8")).toBe("pre\npost\n");
	});

	it("resolves every region with conflict://*, bottom-up so earlier regions keep their lines", async () => {
		const dir = await tempDir();
		const file = join(dir, "c.txt");
		await writeFile(file, `a\n${CONFLICT("one", "uno")}b\n${CONFLICT("two-a\ntwo-b", "dos")}c\n`);
		const result = await write(dir, "conflict://*", "@theirs");
		expect(result.content).toEqual([{ type: "text", text: "Resolved 2 conflicts" }]);
		expect(await readFile(file, "utf8")).toBe("a\nuno\nb\ndos\nc\n");
	});

	it("names a single region without a plural", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "c.txt"), CONFLICT("one", "uno"));
		expect(textOf(await write(dir, "conflict://*", "@ours"))).toBe("Resolved 1 conflict");
	});

	it.each(["1a", "a1", "-1", "1.5"])("refuses the non-numeric id %j", async (id) => {
		const dir = await tempDir();
		await writeFile(join(dir, "c.txt"), CONFLICT("one", "uno"));
		await expect(write(dir, `conflict://${id}`, "@ours")).rejects.toMatchObject({ code: "conflict-target-invalid" });
	});

	it("resolves a two-digit id", async () => {
		const dir = await tempDir();
		const regions = Array.from({ length: 12 }, (_, index) => CONFLICT(`o${index}`, `t${index}`)).join("");
		await writeFile(join(dir, "c.txt"), regions);
		expect(textOf(await write(dir, "conflict://12", "@theirs"))).toBe("Resolved conflict 12");
		expect(await readFile(join(dir, "c.txt"), "utf8")).toContain("\nt11\n");
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
		expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/^Inserted row/) }]);
		expect(result.details).toEqual({ meta: { sourcePath: database } });
	});

	it("reports archive writes and the archive they landed in", async () => {
		const dir = await tempDir();
		const result = await write(dir, "bundle.zip:notes.txt", "hello");
		expect(result.content).toEqual([{ type: "text", text: "Successfully wrote to bundle.zip:notes.txt" }]);
		expect(result.details).toEqual({ resolvedPath: join(dir, "bundle.zip") });
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
		expect(result.content).toEqual([{ type: "text", text: "Successfully wrote to history://note" }]);
		expect(result.details).toEqual({});
		expect(written).toEqual([["history://note", "body"]]);
	});

	it("names the selector targets in the built-in description, after pi's", () => {
		const description = createToolDefinition("write", "/").description;
		expect(description.startsWith(createWriteToolDefinition("/").description)).toBe(true);
		expect(description).toContain("conflict://<id> or conflict://*");
		expect(description).toContain("local://");
	});
});

describe("built-in local file operations", () => {
	it("drop the written file from the native search cache", async () => {
		const dir = await tempDir();
		await write(dir, "plain.txt", "one\n");
		expect(invalidateNativeSearchCache).toHaveBeenCalledWith(join(dir, "plain.txt"));
		vi.mocked(invalidateNativeSearchCache).mockClear();
		await createToolDefinition("edit", dir).execute(
			"edit",
			{ path: "plain.txt", edits: [{ oldText: "one", newText: "two" }] },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		expect(invalidateNativeSearchCache).toHaveBeenCalledWith(join(dir, "plain.txt"));
		expect(await readFile(join(dir, "plain.txt"), "utf8")).toBe("two\n");
	});
});
