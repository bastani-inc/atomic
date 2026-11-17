import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolDefinition } from "../src/core/tools/index.ts";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";
import { sqlite } from "./helpers/sqlite.js";

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
		for (let i = 0; i < 25; i++)
			await writeFile(join(dir, `file-${String(i).padStart(2, "0")}.txt`), "needle\n", "utf8");
		const search = createSearchToolDefinition(dir);
		const output = text(
			await search.execute("search-page", { pattern: "needle", paths: "." }, undefined, undefined, {} as never),
		);
		const hints = output.match(/\[20 matching files shown\. Use skip=20 to view more\.\]/g) ?? [];
		expect(hints).toHaveLength(1);
	});

	it("surfaces the internal collection cap when skip moves beyond it", async () => {
		const dir = await tempDir();
		const filesDir = join(dir, "many");
		await mkdir(filesDir);
		await Promise.all(
			Array.from({ length: 2005 }, (_, i) =>
				writeFile(join(filesDir, `file-${String(i).padStart(4, "0")}.txt`), "needle\n", "utf8"),
			),
		);
		const search = createSearchToolDefinition(dir);
		const result = await search.execute(
			"search-cap",
			{ pattern: "needle", paths: "many", skip: 2000 },
			undefined,
			undefined,
			{} as never,
		);
		const output = text(result);
		expect(output).toContain("No more results (skip=2000)");
		expect(output).toContain("Search collected the first 2000 matches before pagination");
		expect(result.details?.fileLimitReached).toBe(true);
	});

	it("counts per-file search output caps by matches instead of context lines", async () => {
		const dir = await tempDir();
		const content = Array.from({ length: 6 }, (_, index) =>
			[`before ${index}`, `needle ${index}`, `after ${index}a`, `after ${index}b`, `after ${index}c`].join("\n"),
		).join("\n");
		await writeFile(join(dir, "many-matches.txt"), `${content}\n`, "utf8");
		const search = createSearchToolDefinition(dir);
		const output = text(
			await search.execute(
				"search-context-lines",
				{ pattern: "needle", paths: "." },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(output).toContain("needle 5");
	});

	it("explains that skip is ignored for single-file search", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "one.txt"), "needle\n", "utf8");
		const search = createSearchToolDefinition(dir);
		const output = text(
			await search.execute(
				"single-skip",
				{ pattern: "needle", paths: "one.txt", skip: 20 },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(output).toContain("skip is ignored for single-file search");
	});

	it("does not count colon-bearing context rows toward the per-group match cap (#5250)", async () => {
		const dir = await tempDir();
		const content = Array.from({ length: 6 }, (_, index) =>
			[`before ${index}`, `needle ${index}`, `after ${index}a`, `after ${index}b`, `after ${index}c`].join("\n"),
		).join("\n");
		await createToolDefinition("write", dir).execute(
			"write-archive-member",
			{ path: "bundle.zip:a: b.txt", content: `${content}\n` },
			undefined,
			undefined,
			{} as never,
		);
		const search = createSearchToolDefinition(dir);
		const output = text(
			await search.execute(
				"search-archive-context-lines",
				{ pattern: "needle", paths: "bundle.zip:" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(output.split("\n")).toHaveLength(30);
		expect(output).toContain("needle 5");
	});

	it("keeps scheme-prefixed context rows with colons in their own search group (#5250)", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, ".agents", "skills", "first"), { recursive: true });
		await mkdir(join(dir, ".agents", "skills", "second"), { recursive: true });
		await writeFile(
			join(dir, ".agents", "skills", "first", "SKILL.md"),
			"needle 1\ncontext: detail\nneedle 2\n",
			"utf8",
		);
		await writeFile(join(dir, ".agents", "skills", "second", "SKILL.md"), "needle 3\n", "utf8");
		const search = createSearchToolDefinition(dir);
		const firstPage = text(
			await search.execute(
				"search-skill-url-order",
				{ pattern: "needle", paths: "skill://first/SKILL.md" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(firstPage.split("\n")).toEqual([
			"skill://first/SKILL.md:1: needle 1",
			"skill://first/SKILL.md-2- context: detail",
			"skill://first/SKILL.md:3: needle 2",
		]);
		const secondPage = text(
			await search.execute(
				"search-skill-url-skip",
				{ pattern: "needle", paths: ["skill://first/SKILL.md", "skill://second/SKILL.md"], skip: 1 },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(secondPage).toBe("skill://second/SKILL.md:1: needle 3");
	});

	it("counts SQLite text primary-key match rows toward the per-group match cap (#5250)", async () => {
		const mod = sqlite();
		const dir = await tempDir();
		const db = new mod.Database(join(dir, "rows.sqlite"));
		try {
			db.run("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT)");
			db.run("BEGIN");
			for (let index = 0; index < 30; index++)
				db.run("INSERT INTO records VALUES (?, ?)", `item-${index}`, "needle");
			db.run("COMMIT");
		} finally {
			db.close();
		}
		const search = createSearchToolDefinition(dir);
		const output = text(
			await search.execute(
				"search-sqlite-text-pk-cap",
				{ pattern: "needle", paths: "rows.sqlite:records" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(output.split("\n")).toHaveLength(20);
		expect(output).toContain("rows.sqlite:records:item-0:");
		expect(output).toContain("rows.sqlite:records:item-19:");
		expect(output).not.toContain("rows.sqlite:records:item-20:");
	});
});
