import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "atomic-search-pagination-"));
	tempDirs.push(dir);
	return dir;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => item.text ?? "").join("\n");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("search pagination feedback", () => {
	it("emits one continuation hint when the first page is full", async () => {
		const dir = await tempDir();
		for (let i = 0; i < 25; i++) await writeFile(join(dir, `file-${String(i).padStart(2, "0")}.txt`), "needle\n", "utf8");
		const search = createSearchToolDefinition(dir);
		const output = text(await search.execute("search-page", { pattern: "needle", paths: "." }, undefined, undefined, {} as never));
		const hints = output.match(/\[20 matching files shown\. Use skip=20 to view more\.\]/g) ?? [];
		expect(hints).toHaveLength(1);
	});

	it("surfaces the internal collection cap when skip moves beyond it", async () => {
		const dir = await tempDir();
		const filesDir = join(dir, "many");
		await mkdir(filesDir);
		await Promise.all(Array.from({ length: 2005 }, (_, i) => writeFile(join(filesDir, `file-${String(i).padStart(4, "0")}.txt`), "needle\n", "utf8")));
		const search = createSearchToolDefinition(dir);
		const result = await search.execute("search-cap", { pattern: "needle", paths: "many", skip: 2000 }, undefined, undefined, {} as never);
		const output = text(result);
		expect(output).toContain("No more results (skip=2000)");
		expect(output).toContain("Search collected the first 2000 matches before pagination");
		expect(result.details?.fileLimitReached).toBe(true);
	});

	it("counts per-file search output caps by matches instead of context lines", async () => {
		const dir = await tempDir();
		const content = Array.from({ length: 6 }, (_, index) => [`before ${index}`, `needle ${index}`, `after ${index}a`, `after ${index}b`, `after ${index}c`].join("\n")).join("\n");
		await writeFile(join(dir, "many-matches.txt"), `${content}\n`, "utf8");
		const search = createSearchToolDefinition(dir);
		const output = text(await search.execute("search-context-lines", { pattern: "needle", paths: "." }, undefined, undefined, {} as never));
		expect(output).toContain("needle 5");
	});
});
