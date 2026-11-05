import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "search-plain-"));
	tempDirs.push(dir);
	return dir;
}

async function search(cwd: string, paths: string | string[], pattern = "needle") {
	const result = await createSearchToolDefinition(cwd, { contextBefore: 0, contextAfter: 0 }).execute("search", {
		pattern,
		paths,
	});
	return { text: result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n"), result };
}

describe("search rows name files relative to the working directory (#4328)", () => {
	it("in a directory search below the working directory", async () => {
		const cwd = await tempDir();
		await mkdir(join(cwd, "sub", "deep"), { recursive: true });
		await writeFile(join(cwd, "sub", "deep", "a.txt"), "needle\n");
		expect((await search(cwd, "sub")).text).toBe("sub/deep/a.txt:1: needle");
	});

	it("in a single-file search below the working directory", async () => {
		const cwd = await tempDir();
		await mkdir(join(cwd, "sub"));
		await writeFile(join(cwd, "sub", "a.txt"), "x\nneedle\n");
		expect((await search(cwd, "sub/a.txt")).text).toBe("sub/a.txt:2: needle");
	});

	it("with absolute paths for files outside the working directory", async () => {
		const cwd = await tempDir();
		const outside = await tempDir();
		await writeFile(join(outside, "a.txt"), "needle\n");
		expect((await search(cwd, outside)).text).toBe(`${join(outside, "a.txt")}:1: needle`);
	});

	it("for every target of a multi-target search", async () => {
		const cwd = await tempDir();
		await mkdir(join(cwd, "one"));
		await mkdir(join(cwd, "two"));
		await writeFile(join(cwd, "one", "a.txt"), "needle\n");
		await writeFile(join(cwd, "two", "a.txt"), "needle\n");
		const { text } = await search(cwd, ["one", "two"]);
		expect(text).toContain("one/a.txt:1: needle");
		expect(text).toContain("two/a.txt:1: needle");
	});
});

describe("overlapping search scopes", () => {
	it("show each row once and keep distinct matches and context of the same file", async () => {
		const cwd = await tempDir();
		await mkdir(join(cwd, "src"));
		const lines = Array.from({ length: 14 }, (_, index) =>
			index === 0 || index === 11 ? "needle" : `line ${index}`,
		);
		await writeFile(join(cwd, "src", "data.txt"), `${lines.join("\n")}\n`);
		const result = await createSearchToolDefinition(cwd).execute("overlap", {
			pattern: "needle",
			paths: ["src", "src/*.txt"],
		});
		const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		expect(text.match(/src\/data\.txt:1: needle/g)).toHaveLength(1);
		expect(text.match(/src\/data\.txt:12: needle/g)).toHaveLength(1);
		expect(text.match(/src\/data\.txt-13- line 12/g)).toHaveLength(1);
		expect(text.match(/src\/data\.txt-11- line 10/g)).toHaveLength(1);
		expect(result.details?.matchCount).toBe(2);
		expect(result.details?.fileMatches).toEqual({ "src/data.txt": 2 });
	});
});
