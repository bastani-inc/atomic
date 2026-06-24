import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

function textOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
}

describe("find/search edge parity", () => {
	let testDir: string;
	beforeEach(() => { testDir = join(tmpdir(), `atomic-search-edge-${Date.now()}-${Math.random().toString(16).slice(2)}`); mkdirSync(testDir, { recursive: true }); });
	afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

	it("preserves delimiter-containing glob roots for find and search", async () => {
		mkdirSync(join(testDir, "foo")); mkdirSync(join(testDir, "bar")); mkdirSync(join(testDir, "foo,bar"));
		writeFileSync(join(testDir, "foo", "wrong.txt"), "needle wrong\n"); writeFileSync(join(testDir, "bar", "wrong.txt"), "needle wrong\n"); writeFileSync(join(testDir, "foo,bar", "right.txt"), "needle right\n");
		const found = textOutput(await createFindToolDefinition(testDir).execute("find-comma-glob", { paths: ["foo,bar/*.txt"] }));
		expect(found).toContain("right.txt"); expect(found).not.toContain("wrong.txt");
		const searched = textOutput(await createSearchToolDefinition(testDir).execute("search-comma-glob", { pattern: "needle", paths: "foo,bar/*.txt" }));
		expect(searched).toContain("needle right"); expect(searched).not.toContain("needle wrong");
	});

	it("does not report glob find truncation for exactly limit matches", async () => {
		writeFileSync(join(testDir, "only.txt"), "");
		const result = await createFindToolDefinition(testDir).execute("find-exact-glob-limit", { paths: ["*.txt"], limit: 1 });
		expect(textOutput(result)).toContain("only.txt"); expect(textOutput(result)).not.toContain("limit reached"); expect(result.details?.resultLimitReached).toBeUndefined();
	});

	it("reports find truncation when matches exceed the limit", async () => {
		writeFileSync(join(testDir, "a.txt"), "");
		writeFileSync(join(testDir, "b.txt"), "");
		const result = await createFindToolDefinition(testDir).execute("find-over-limit", { paths: ["*.txt"], limit: 1 });
		expect(textOutput(result)).toContain("1 results limit reached");
		expect(result.details?.resultLimitReached).toBe(1);
	});

	it("reports truncation when exact files fill the page before later targets", async () => {
		mkdirSync(join(testDir, "sub"));
		writeFileSync(join(testDir, "a.txt"), "");
		writeFileSync(join(testDir, "sub", "b.txt"), "");
		const result = await createFindToolDefinition(testDir).execute("find-exact-plus-dir-limit", { paths: ["a.txt", "sub"], limit: 1 });
		expect(textOutput(result)).toContain("1 results limit reached");
		expect(result.details?.resultLimitReached).toBe(1);
	});


	it("custom find reports only real later matches after the page fills", async () => {
		let emptyProbe = false;
		const noLater = await createFindToolDefinition("/remote/project", { operations: {
			exists: () => true,
			stat: (p) => ({ isFile: p.endsWith("a.txt"), isDirectory: !p.endsWith("a.txt") }),
			glob: (_pattern, cwd) => { if (cwd.endsWith("empty")) emptyProbe = true; return []; },
		} }).execute("custom-find-no-false-trunc", { paths: ["a.txt", "empty"], limit: 1 });
		expect(emptyProbe).toBe(true); expect(textOutput(noLater)).not.toContain("limit reached"); expect(noLater.details?.resultLimitReached).toBeUndefined();
		const truncated = await createFindToolDefinition("/remote/project", { operations: { exists: () => true, stat: (p) => ({ isFile: p.endsWith("a.txt"), isDirectory: !p.endsWith("a.txt") }), glob: (_pattern, cwd) => cwd.endsWith("d2") ? ["b.txt"] : [] } }).execute("custom-find-real-trunc", { paths: ["a.txt", "d2"], limit: 1 });
		expect(textOutput(truncated)).toContain("1 results limit reached"); expect(truncated.details?.resultLimitReached).toBe(1);
	});

	it("splits delimiter-joined ranged archive searches", async () => {
		await createWriteToolDefinition(testDir).execute("zip-range-a", { path: "rangearch.zip:a.txt", content: "needle a\n" }, undefined, undefined, {} as never);
		await createWriteToolDefinition(testDir).execute("zip-range-b", { path: "rangearch.zip:b.txt", content: "needle b\n" }, undefined, undefined, {} as never);
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-ranged-archives", { pattern: "needle", paths: "rangearch.zip:a.txt:1-1 rangearch.zip:b.txt:1-1" }));
		expect(output).toContain("needle a"); expect(output).toContain("needle b");
	});

	it("keeps verbose-regex comments in native-unavailable ranged search", () => {
		const script = `import { mkdtempSync, writeFileSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; const modPath = process.cwd().endsWith("packages/coding-agent") ? "./src/core/tools/search.ts" : "./packages/coding-agent/src/core/tools/search.ts"; const { createSearchToolDefinition } = await import(modPath); const dir = mkdtempSync(join(tmpdir(), "atomic-no-native-search-")); try { writeFileSync(join(dir, "f.txt"), "foobar\\n"); const result = await createSearchToolDefinition(dir).execute("no-native-ranged-x", { pattern: "(?x)foo # comment\\n bar", paths: "f.txt:1-1" }); const text = result.content.map((item) => item.text ?? "").join("\\n"); if (!text.includes("foobar")) throw new Error(text); } finally { rmSync(dir, { recursive: true, force: true }); }`;
		const result = spawnSync("bun", ["-e", script], { cwd: process.cwd(), env: { ...process.env, NAPI_RS_FORCE_WASI: "error" }, encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("does not warn on exact native grep limit matches", async () => {
		writeFileSync(join(testDir, "grep-exact.txt"), "needle\nneedle\nneedle\n");
		const exact = await createGrepToolDefinition(testDir).execute("grep-exact-limit", { pattern: "needle", path: "grep-exact.txt", limit: 3 });
		expect(textOutput(exact)).not.toContain("matches limit reached"); expect(exact.details?.matchLimitReached).toBeUndefined();
		writeFileSync(join(testDir, "grep-more.txt"), "needle\nneedle\nneedle\nneedle\n");
		const over = await createGrepToolDefinition(testDir).execute("grep-over-limit", { pattern: "needle", path: "grep-more.txt", limit: 3 });
		expect(textOutput(over)).toContain("3 matches limit reached"); expect(over.details?.matchLimitReached).toBe(3);
	});
	it("deduplicates overlapping native find scopes before limiting", async () => {
		mkdirSync(join(testDir, "src"));
		writeFileSync(join(testDir, "src", "a.txt"), "");
		await new Promise((resolve) => setTimeout(resolve, 5));
		writeFileSync(join(testDir, "src", "b.txt"), "");
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-overlap", { paths: ["src", "src/*.txt"], limit: 2 }));
		expect(output).toContain("a.txt"); expect(output).toContain("b.txt"); expect(output).not.toContain("limit reached");
	});

	it("deduplicates overlapping search scope lines", async () => {
		mkdirSync(join(testDir, "src")); writeFileSync(join(testDir, "src", "a.txt"), "needle\n");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-overlap", { pattern: "needle", paths: ["src", "src/*.txt"] }));
		expect((output.match(/\*1:needle/g) ?? []).length).toBe(1);
	});
	it("rejects invalid ranged search selectors", async () => {
		writeFileSync(join(testDir, "a.txt"), "needle\n");
		await expect(createSearchToolDefinition(testDir).execute("search-invalid-range", { pattern: "needle", paths: "a.txt:0" })).rejects.toThrow(/Invalid line-range selector/);
	});
	it("honors configured asymmetric search context", async () => {
		writeFileSync(join(testDir, "ctx.txt"), "before\nneedle\nafter\n");
		const output = textOutput(await createSearchToolDefinition(testDir, { contextBefore: 0, contextAfter: 0 }).execute("search-context", { pattern: "needle", paths: "ctx.txt" }));
		expect(output).toContain("*2:needle"); expect(output).not.toContain("before"); expect(output).not.toContain("after");
	});



	it("skips missing explicit targets after a full search page", async () => {
		const paths: string[] = [];
		for (let index = 1; index <= 20; index++) { const name = `full-${String(index).padStart(2, "0")}.txt`; paths.push(name); writeFileSync(join(testDir, name), "needle\n"); }
		paths.push("missing.txt");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-full-missing", { pattern: "needle", paths }));
		expect(output).toContain("full-20.txt"); expect(output).not.toContain("Path not found"); expect(output).toContain("Skipped missing paths");
	});
});
