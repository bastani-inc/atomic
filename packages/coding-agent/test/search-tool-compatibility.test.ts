import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	allToolNames,
	createAllToolDefinitions,
	createCodingToolDefinitions,
	createFindToolDefinition,
	createSearchTool,
	createSearchToolDefinition,
	createToolDefinition,
	defaultToolNames,
} from "../src/core/tools/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function textOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
}

function matchLineCount(output: string): number {
	return output.split("\n").filter((line) => /^.+:\d+: /.test(line) && !/^.+-\d+- /.test(line)).length;
}

describe("search builtin compatibility", () => {
	let testDir: string;

	beforeEach(() => {
		initTheme("dark");
		testDir = join(tmpdir(), `atomic-search-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("registers search and exposes find/search to normal coding sessions", () => {
		expect(allToolNames.has("search")).toBe(true);
		expect(defaultToolNames).toContain("find");
		expect(defaultToolNames).toContain("search");

		const codingNames = createCodingToolDefinitions(testDir).map((tool) => tool.name);
		expect(codingNames).toEqual(["read", "bash", "edit", "write", "find", "search"]);

		expect(createToolDefinition("search", testDir).name).toBe("search");
		expect(createAllToolDefinitions(testDir).search.name).toBe("search");
	});

	it("executes search as a content-search wrapper with path and ignore-case aliases", async () => {
		const file = join(testDir, "example.txt");
		writeFileSync(file, "Alpha\nneedle\nOMEGA\n");

		const tool = createSearchTool(testDir);
		const result = await tool.execute("search-compat", {
			pattern: "NEEDLE",
			paths: testDir,
			i: true,
			literal: true,
		});

		expect(textOutput(result)).toContain("example.txt:2: needle");
	});

	it("renders search calls with a search header instead of inheriting grep", () => {
		const definition = createSearchToolDefinition(testDir);
		const rendered = definition.renderCall?.(
			{ pattern: "needle", path: "." },
			theme,
			{ lastComponent: undefined } as never,
		);

		const output = stripAnsi(rendered?.render(80).join("\n") ?? "");
		expect(output).toContain("search /needle/ in .");
		expect(output).not.toContain("grep /needle/ in .");
	});

	it("exposes search.skip for file-page pagination", () => {
		const parameters = createSearchToolDefinition(testDir).parameters as { properties?: Record<string, unknown> };
		expect(parameters.properties).toHaveProperty("skip");
	});

	it("applies multi-path search limits globally", async () => {
		const first = join(testDir, "first");
		const second = join(testDir, "second");
		mkdirSync(first, { recursive: true });
		mkdirSync(second, { recursive: true });
		writeFileSync(join(first, "a.txt"), "needle one\n");
		writeFileSync(join(second, "b.txt"), "needle two\nneedle three\n");

		const result = await createSearchTool(testDir).execute("search-limit", {
			pattern: "needle",
			paths: [first, second],
			literal: true,
			limit: 2,
		});
		const output = textOutput(result);

		expect(matchLineCount(output)).toBe(2);
		expect(output).toContain("a.txt:1: needle one");
		expect(output).toContain("b.txt:1: needle two");
		expect(output).not.toContain("needle three");
	});

	it("counts only match lines when carrying search limits across context output", async () => {
		const first = join(testDir, "context-first");
		const second = join(testDir, "context-second");
		mkdirSync(first, { recursive: true });
		mkdirSync(second, { recursive: true });
		writeFileSync(join(first, "a.txt"), "prefix:123: context\nneedle one\nsuffix:456: context\n");
		writeFileSync(join(second, "b.txt"), "needle two\n");

		const result = await createSearchTool(testDir).execute("search-context-limit", {
			pattern: "needle",
			paths: [first, second],
			literal: true,
			context: 1,
			limit: 2,
		});
		const output = textOutput(result);

		expect(matchLineCount(output)).toBe(2);
		expect(output).toContain("a.txt:2: needle one");
		expect(output).toContain("b.txt:1: needle two");
	});

	it("treats glob entries in search.paths as scoped file filters", async () => {
		writeFileSync(join(testDir, "match.ts"), "needle ts\n");
		writeFileSync(join(testDir, "skip.js"), "needle js\n");

		const result = await createSearchTool(testDir).execute("search-path-glob", {
			pattern: "needle",
			paths: ["*.ts"],
			literal: true,
		});
		const output = textOutput(result);

		expect(output).toContain("match.ts:1: needle ts");
		expect(output).not.toContain("skip.js");
	});

	it("uses search.skip to page by matching files", async () => {
		writeFileSync(join(testDir, "a.txt"), "needle first\n");
		writeFileSync(join(testDir, "b.txt"), "needle second\n");

		const result = await createSearchTool(testDir).execute("search-skip", {
			pattern: "needle",
			path: testDir,
			literal: true,
			skip: 1,
		});
		const output = textOutput(result);

		expect(output).not.toContain("a.txt:1: needle first");
		expect(output).toContain("b.txt:1: needle second");
	});

	it("honors search.gitignore=false", async () => {
		mkdirSync(join(testDir, ".git"), { recursive: true });
		writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(testDir, "ignored.txt"), "needle ignored\n");

		const defaultResult = await createSearchTool(testDir).execute("search-gitignore-default", {
			pattern: "needle",
			path: testDir,
			literal: true,
		});
		expect(textOutput(defaultResult)).toBe("No matches found");

		const noIgnoreResult = await createSearchTool(testDir).execute("search-gitignore-false", {
			pattern: "needle",
			path: testDir,
			literal: true,
			gitignore: false,
		});
		expect(textOutput(noIgnoreResult)).toContain("ignored.txt:1: needle ignored");
	});

	it("applies a final combined output cap across multiple search paths", async () => {
		const first = join(testDir, "large-first");
		const second = join(testDir, "large-second");
		mkdirSync(first, { recursive: true });
		mkdirSync(second, { recursive: true });
		const longLine = `needle ${"x".repeat(600)}`;
		for (let index = 0; index < 60; index++) {
			writeFileSync(join(first, `${index}.txt`), `${longLine} first ${index}\n`);
			writeFileSync(join(second, `${index}.txt`), `${longLine} second ${index}\n`);
		}

		const result = await createSearchTool(testDir).execute("search-combined-cap", {
			pattern: "needle",
			paths: [first, second],
			literal: true,
			limit: 120,
		});

		expect(result.details?.truncation?.truncated).toBe(true);
		expect(textOutput(result)).toContain("combined output limit reached");
	});

	it("applies the default search limit globally across multiple paths", async () => {
		const first = join(testDir, "default-limit-first");
		const second = join(testDir, "default-limit-second");
		mkdirSync(first, { recursive: true });
		mkdirSync(second, { recursive: true });
		writeFileSync(join(first, "a.txt"), Array.from({ length: 60 }, (_, i) => `needle first ${i}`).join("\n"));
		writeFileSync(join(second, "b.txt"), Array.from({ length: 60 }, (_, i) => `needle second ${i}`).join("\n"));

		const result = await createSearchTool(testDir).execute("search-default-limit", {
			pattern: "needle",
			paths: [first, second],
			literal: true,
		});
		const output = textOutput(result);

		expect(matchLineCount(output)).toBe(100);
		expect(output).toContain("a.txt:60: needle first 59");
		expect(output).toContain("b.txt:40: needle second 39");
		expect(output).not.toContain("needle second 40");
	});

	it("treats glob entries in find.paths as file patterns", async () => {
		writeFileSync(join(testDir, "match.ts"), "");
		writeFileSync(join(testDir, "skip.js"), "");
		const definition = createFindToolDefinition(testDir);

		const result = await definition.execute(
			"find-path-glob",
			{ paths: ["*.ts"] },
			undefined,
			undefined,
			{} as never,
		);
		const output = textOutput(result);

		expect(output).toContain("match.ts");
		expect(output).not.toContain("skip.js");
	});

	it("returns a partial result when find.timeout expires", async () => {
		const definition = createFindToolDefinition(testDir, {
			operations: {
				exists: () => true,
				glob: async () => {
					await new Promise((resolve) => setTimeout(resolve, 700));
					return [join(testDir, "late.ts")];
				},
			},
		});

		const result = await definition.execute(
			"find-timeout",
			{ paths: ["*.ts"], timeout: 0.5 },
			undefined,
			undefined,
			{} as never,
		);

		expect(textOutput(result)).toContain("find timed out after 0.5s");
		expect(result.details?.timedOut).toBe(true);
	});

	it("honors find.hidden=false and find.gitignore=false for local fd searches", async () => {
		writeFileSync(join(testDir, "visible.ts"), "");
		writeFileSync(join(testDir, ".hidden.ts"), "");
		writeFileSync(join(testDir, ".gitignore"), "ignored.ts\n");
		writeFileSync(join(testDir, "ignored.ts"), "");
		const definition = createFindToolDefinition(testDir);

		const visibleOnly = await definition.execute(
			"find-hidden-false",
			{ pattern: "*.ts", path: testDir, hidden: false },
			undefined,
			undefined,
			{} as never,
		);
		expect(textOutput(visibleOnly)).toContain("visible.ts");
		expect(textOutput(visibleOnly)).not.toContain(".hidden.ts");

		const noIgnore = await definition.execute(
			"find-gitignore-false",
			{ pattern: "ignored.ts", path: testDir, gitignore: false },
			undefined,
			undefined,
			{} as never,
		);
		expect(textOutput(noIgnore)).toContain("ignored.ts");
	});

	it("treats find.paths as a real multi-directory list for custom operations", async () => {
		const first = join(testDir, "find-first");
		const second = join(testDir, "find-second");
		const calls: string[] = [];
		const definition = createFindToolDefinition(testDir, {
			operations: {
				exists: () => true,
				glob: (_pattern, cwd) => {
					calls.push(cwd);
					return [join(cwd, `${calls.length}.ts`)];
				},
			},
		});

		const result = await definition.execute(
			"find-paths",
			{ pattern: "*.ts", paths: [first, second] },
			undefined,
			undefined,
			{} as never,
		);

		expect(calls).toEqual([first, second]);
		expect(textOutput(result)).toContain("find-first/1.ts");
		expect(textOutput(result)).toContain("find-second/2.ts");
	});

	it("renders omitted find patterns as the execution default", () => {
		const definition = createFindToolDefinition(testDir);
		const rendered = definition.renderCall?.(
			{ path: "." },
			theme,
			{ lastComponent: undefined } as never,
		);

		const output = stripAnsi(rendered?.render(80).join("\n") ?? "");
		expect(output).toContain("find ** in .");
	});

	it("uses a default/max find limit of 200 for custom operations", async () => {
		const calls: Array<{ limit: number }> = [];
		const definition = createFindToolDefinition(testDir, {
			operations: {
				exists: () => true,
				glob: (_pattern, cwd, options) => {
					calls.push({ limit: options.limit });
					return Array.from({ length: options.limit }, (_, index) => join(cwd, `${index}.ts`));
				},
			},
		});

		const defaultLimit = await definition.execute(
			"find-default-limit",
			{ path: testDir },
			undefined,
			undefined,
			{} as never,
		);
		const clampedLimit = await definition.execute(
			"find-clamped-limit",
			{ path: testDir, limit: 999 },
			undefined,
			undefined,
			{} as never,
		);

		expect(calls).toEqual([{ limit: 200 }, { limit: 200 }]);
		expect(defaultLimit.details?.resultLimitReached).toBe(200);
		expect(clampedLimit.details?.resultLimitReached).toBe(200);
		expect(textOutput(defaultLimit).split("\n").filter((line) => line.endsWith(".ts"))).toHaveLength(200);
		expect(textOutput(clampedLimit).split("\n").filter((line) => line.endsWith(".ts"))).toHaveLength(200);
	});

	it("allows find.paths without a legacy pattern", async () => {
		const first = join(testDir, "find-default-first");
		const second = join(testDir, "find-default-second");
		const calls: Array<{ pattern: string; cwd: string }> = [];
		const definition = createFindToolDefinition(testDir, {
			operations: {
				exists: () => true,
				glob: (pattern, cwd) => {
					calls.push({ pattern, cwd });
					return [join(cwd, `${calls.length}.ts`)];
				},
			},
		});

		const result = await definition.execute(
			"find-paths-default-pattern",
			{ paths: [first, second] },
			undefined,
			undefined,
			{} as never,
		);

		expect(calls).toEqual([
			{ pattern: "**", cwd: first },
			{ pattern: "**", cwd: second },
		]);
		expect(textOutput(result)).toContain("find-default-first/1.ts");
		expect(textOutput(result)).toContain("find-default-second/2.ts");
	});
});
