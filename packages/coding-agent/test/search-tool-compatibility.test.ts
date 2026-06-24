import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

function textOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
}

describe("find and search builtins", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `atomic-find-search-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("exposes the search schema documented by the tool reference", () => {
		const properties = (createSearchToolDefinition(testDir).parameters as { properties?: Record<string, unknown> }).properties ?? {};
		expect(Object.keys(properties).sort()).toEqual(["case", "gitignore", "i", "paths", "pattern", "skip"]);
	});

	it("custom find operations can return exact remote file paths", async () => {
		const remote = "/remote/project/file.ts";
		const output = textOutput(await createFindToolDefinition("/remote/project", { operations: { exists: (path) => path === remote, glob: () => [] } }).execute("find-custom-exact", { paths: [remote] }));
		expect(output).toContain("file.ts");
	});

	it("preserves exact find paths containing spaces and commas", async () => {
		writeFileSync(join(testDir, "a"), "");
		writeFileSync(join(testDir, "b.txt"), "");
		writeFileSync(join(testDir, "a b.txt"), "");
		mkdirSync(join(testDir, "foo"));
		mkdirSync(join(testDir, "bar"));
		mkdirSync(join(testDir, "foo,bar"));
		writeFileSync(join(testDir, "foo,bar", "right.txt"), "");
		const spaced = textOutput(await createFindToolDefinition(testDir).execute("find-space", { paths: ["a b.txt"] }));
		expect(spaced).toContain("a b.txt");
		expect(spaced).not.toContain("b.txt\n");
		const comma = textOutput(await createFindToolDefinition(testDir).execute("find-comma", { paths: ["foo,bar"] }));
		expect(comma).toContain("right.txt");
		expect(comma).not.toContain("No files found");
	});

	it("does not fabricate exact absolute paths that only share the cwd prefix", async () => {
		const cwd = join(testDir, "foo");
		const outside = join(testDir, "foobar", "a.txt");
		mkdirSync(join(testDir, "foobar"), { recursive: true });
		writeFileSync(outside, "");
		const output = textOutput(await createFindToolDefinition(cwd).execute("find-prefix-outside", { paths: [outside] }));
		expect(output).toContain("../foobar/");
		expect(output).toContain("a.txt");
		expect(output).not.toContain("# ar/");
	});

	it("custom find operations filter hidden results when hidden is false", async () => {
		const calls: Array<{ hidden: boolean }> = [];
		const output = textOutput(await createFindToolDefinition(testDir, { operations: {
			exists: () => true,
			glob: (_pattern, _cwd, options) => { calls.push({ hidden: options.hidden }); return [".secret.ts", "visible.ts", "dir/.nested.ts"]; },
		} }).execute("custom-hidden-false", { paths: ["**/*.ts"], hidden: false }));
		expect(calls).toEqual([{ hidden: false }]);
		expect(output).toContain("visible.ts");
		expect(output).not.toContain(".secret.ts");
		expect(output).not.toContain(".nested.ts");
	});


	it("custom find operations render prefix-colliding absolute backend matches relatively", async () => {
		const cwd = join(testDir, "foo");
		const outside = join(testDir, "foobar", "a.txt");
		const output = textOutput(await createFindToolDefinition(cwd, { operations: { exists: () => true, glob: () => [outside] } }).execute("find-prefix-backend", { paths: ["**/*.txt"] }));
		expect(output).toContain("../foobar/");
		expect(output).toContain("a.txt");
		expect(output).not.toContain("# ar/");
	});

	it("custom find operations without stat can return exact extensionless files", async () => {
		const dockerfile = "/remote/project/Dockerfile";
		const output = textOutput(await createFindToolDefinition("/remote/project", { operations: { exists: (p) => p === dockerfile, glob: () => [] } }).execute("find-dockerfile", { paths: ["Dockerfile"] }));
		expect(output).toContain("Dockerfile");
	});

	it("custom find operations use backend stat over host filesystem and extension heuristics", async () => {
		const hostFile = join(testDir, "src");
		writeFileSync(hostFile, "host file");
		const calls: string[] = [];
		const find = createFindToolDefinition(testDir, { operations: {
			exists: (p) => p === hostFile || p === join(testDir, "Makefile"),
			stat: (p) => p === hostFile ? { isFile: false, isDirectory: true } : { isFile: true, isDirectory: false },
			glob: (_pattern, cwd) => { calls.push(cwd); return cwd === hostFile ? ["remote.ts"] : []; },
		} });
		expect(textOutput(await find.execute("custom-host-collision", { paths: ["src"] }))).toContain("remote.ts");
		expect(calls).toContain(hostFile);
		expect(textOutput(await find.execute("custom-extensionless-file", { paths: ["Makefile"] }))).toContain("Makefile");
	});

	it("custom find operations search directories and honor gitignore false", async () => {
		const calls: Array<{ pattern: string; ignore: string[] }> = [];
		const find = createFindToolDefinition("/remote/project", { operations: {
			exists: (p) => p === "/remote/project/src" || p === "/remote/project",
			glob: (pattern, _cwd, options) => { calls.push({ pattern, ignore: options.ignore }); return pattern === "**/*" ? ["a.ts"] : ["node_modules/pkg/index.js"]; },
		} });
		expect(textOutput(await find.execute("custom-dir", { paths: ["src"] }))).toContain("a.ts");
		expect(textOutput(await find.execute("custom-nm", { paths: ["**/*.js"], gitignore: false }))).toContain("index.js");
		expect(calls.at(-1)?.ignore).not.toContain("**/node_modules/**");
	});

	it("normalizes copied quoted find and search paths", async () => {
		writeFileSync(join(testDir, "a.txt"), "needle\n");
		expect(textOutput(await createFindToolDefinition(testDir).execute("find-quoted", { paths: [" \"a.txt\" "] }))).toContain("a.txt");
		expect(textOutput(await createSearchToolDefinition(testDir).execute("search-quoted", { pattern: "needle", paths: " \"a.txt\" " }))).toContain("needle");
		expect(textOutput(await createSearchToolDefinition(testDir).execute("search-empty", { pattern: "needle", paths: "" }))).toContain("needle");
	});

	it("find resolves local internal URLs before filesystem normalization", async () => {
		mkdirSync(join(testDir, "docs"), { recursive: true });
		writeFileSync(join(testDir, "docs", "a.txt"), "");
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-local-url", { paths: ["local://docs"] }));
		expect(output).toContain("a.txt");
	});

	it("find awaits async internal URL resolvers", async () => {
		mkdirSync(join(testDir, "docs"), { recursive: true });
		writeFileSync(join(testDir, "docs", "async.txt"), "");
		const ctx = { internalRouter: { resolve: async () => join(testDir, "docs") } };
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-async-url", { paths: ["artifact://docs"] }, undefined, undefined, ctx as never));
		expect(output).toContain("async.txt");
	});

	it("find falls through async internal resolvers that decline", async () => {
		mkdirSync(join(testDir, "docs"), { recursive: true });
		writeFileSync(join(testDir, "docs", "fallback.md"), "");
		const ctx = { internalRouter: { resolve: async () => undefined }, resolveInternalUrl: async () => join(testDir, "docs") };
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-async-fallback", { paths: ["artifact://docs/*.md"] }, undefined, undefined, ctx as never));
		expect(output).toContain("fallback.md");
	});

	it("custom find operations enforce returned result limits", async () => {
		const results = Array.from({ length: 10 }, (_, index) => `file-${index}.txt`);
		const output = textOutput(await createFindToolDefinition(testDir, { operations: { exists: () => true, glob: () => results } }).execute("find-custom-limit", { paths: ["."], limit: 3 }));
		expect((output.match(/file-/g) ?? []).length).toBe(3);
	});

	it("does not fabricate exact custom directory hits when glob returns no children", async () => {
		const output = textOutput(await createFindToolDefinition("/remote/project", { operations: {
			exists: (path) => path === "/remote/project/emptydir",
			stat: (path) => path === "/remote/project/emptydir" ? { isFile: false, isDirectory: true } : undefined,
			glob: () => [],
		} }).execute("find-empty-custom-dir", { paths: ["emptydir"] }));
		expect(output).toBe("No files found matching pattern");
	});

	it("does not report exact find hits as limit-truncated", async () => {
		writeFileSync(join(testDir, "README.md"), "");
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-exact-limit", { paths: ["README.md"], limit: 1 }));
		expect(output).toContain("README.md");
		expect(output).not.toContain("limit reached");
	});

	it("search treats empty arrays as workspace and splits delimiter-joined globs", async () => {
		mkdirSync(join(testDir, "a"), { recursive: true });
		mkdirSync(join(testDir, "b"), { recursive: true });
		writeFileSync(join(testDir, "a", "x.txt"), "needle a\n");
		writeFileSync(join(testDir, "b", "y.txt"), "needle b\n");
		expect(textOutput(await createSearchToolDefinition(testDir).execute("search-empty-array", { pattern: "needle", paths: [] }))).toContain("needle a");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-split-globs", { pattern: "needle", paths: "a/*.txt b/*.txt" }));
		expect(output).toContain("needle a");
		expect(output).toContain("needle b");
	});

	it("find splits delimiter-joined glob paths before accepting an existing base", async () => {
		mkdirSync(join(testDir, "dir"), { recursive: true });
		writeFileSync(join(testDir, "dir", "a.ts"), "");
		writeFileSync(join(testDir, "dir", "b.js"), "");
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-split-globs", { paths: ["dir/*.ts,dir/*.js"] }));
		expect(output).toContain("a.ts");
		expect(output).toContain("b.js");
	});

	it("native grep invokes callbacks for explicit file searches", async () => {
		let native: { grep: (options: Record<string, unknown>, cb: (error: Error | null, match: { line?: string }) => void) => Promise<{ totalMatches?: number; total_matches?: number }> };
		try { native = createRequire(import.meta.url)("@bastani/atomic-natives") as typeof native; } catch { return; }
		writeFileSync(join(testDir, "native.txt"), "needle\n");
		const callbacks: string[] = [];
		const result = await native.grep({ pattern: "needle", path: join(testDir, "native.txt"), maxCount: 10 }, (_error, match) => { if (match.line) callbacks.push(match.line); });
		expect(result.totalMatches ?? result.total_matches).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(callbacks).toEqual(["needle"]);
	});


	it("searches regex content through paths and case-insensitive mode", async () => {
		writeFileSync(join(testDir, "a.txt"), "before\nNeedle one\nafter\n");
		writeFileSync(join(testDir, "b.txt"), "nothing\n");

		const output = textOutput(await createSearchToolDefinition(testDir).execute("search", {
			pattern: "needle",
			paths: ["*.txt"],
			i: true,
		}));

		expect(output).toMatch(/\[a\.txt#[0-9A-F]{4}\]/);
		expect(output).toContain("*2:Needle one");
		expect(output).not.toContain("b.txt");
	});

	it("keeps native grep single-file output relative to the requested file", async () => {
		writeFileSync(join(testDir, "sample.txt"), "hello\n");
		const output = textOutput(await createGrepToolDefinition(testDir).execute("grep", {
			pattern: "hello",
			path: "sample.txt",
		}));
		expect(output).toContain("sample.txt:1: hello");
		expect(output).not.toContain(testDir);
	});

	it("honors glob filters for direct-file native grep", async () => {
		writeFileSync(join(testDir, "foo.py"), "needle\n");
		const output = textOutput(await createGrepToolDefinition(testDir).execute("grep-glob-mismatch", {
			pattern: "needle",
			path: "foo.py",
			glob: "*.ts",
		}));
		expect(output).toBe("No matches found");
	});

	it("honors path-qualified glob filters for direct-file native grep", async () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(join(testDir, "src", "a.ts"), "needle\n");
		const output = textOutput(await createGrepToolDefinition(testDir).execute("grep-path-glob", {
			pattern: "needle",
			path: "src/a.ts",
			glob: "src/*.ts",
		}));
		expect(output).toContain("a.ts:1: needle");
	});

	it("invalidates native find/search caches after write", async () => {
		writeFileSync(join(testDir, "a.txt"), "needle\n");
		await createSearchToolDefinition(testDir).execute("prime-search", { pattern: "needle", paths: "." });
		await createFindToolDefinition(testDir).execute("prime-find", { paths: ["*.txt"] });
		await createWriteToolDefinition(testDir).execute("write-new", { path: "b.txt", content: "needle\n" });

		const searchOutput = textOutput(await createSearchToolDefinition(testDir).execute("search-new", { pattern: "needle", paths: "." }));
		const findOutput = textOutput(await createFindToolDefinition(testDir).execute("find-new", { paths: ["*.txt"] }));
		expect(searchOutput).toContain("b.txt");
		expect(findOutput).toContain("b.txt");
	});

	it("does not reuse native search cache across external bash-style mutations", async () => {
		writeFileSync(join(testDir, "a.txt"), "old\n");
		await createSearchToolDefinition(testDir).execute("prime-search", { pattern: "old", paths: "." });
		writeFileSync(join(testDir, "b.txt"), "needle\n");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-after-external-write", { pattern: "needle", paths: "." }));
		expect(output).toContain("b.txt");
	});

	it("keeps direct grep fresh across external bash-style mutations", async () => {
		writeFileSync(join(testDir, "a.txt"), "old\n");
		await createGrepToolDefinition(testDir).execute("prime-grep", { pattern: "old", path: "." });
		writeFileSync(join(testDir, "b.txt"), "needle\n");
		const output = textOutput(await createGrepToolDefinition(testDir).execute("grep-after-external-write", { pattern: "needle", path: "." }));
		expect(output).toContain("b.txt");
	});

	it("returns no matches instead of blank output after line-range filtering", async () => {
		writeFileSync(join(testDir, "range-miss.txt"), "one\ntwo\nthree\nneedle\ncontext\n");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-range-miss", { pattern: "needle", paths: "range-miss.txt:5-5" }));
		expect(output).toBe("No matches found");
	});

	it("honors gitignore false for search under node_modules", async () => {
		mkdirSync(join(testDir, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(testDir, "node_modules", "pkg", "index.js"), "needle\n");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-node-modules", { pattern: "needle", paths: ".", gitignore: false }));
		expect(output).toContain("node_modules/pkg/index.js");
	});

	it("does not reuse native find cache across external bash-style mutations", async () => {
		writeFileSync(join(testDir, "a.txt"), "");
		await createFindToolDefinition(testDir).execute("prime-find", { paths: ["*.txt"] });
		writeFileSync(join(testDir, "b.txt"), "");
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-after-external-write", { paths: ["*.txt"] }));
		expect(output).toContain("b.txt");
	});

	it("searches multiline regex patterns containing escaped newlines", async () => {
		writeFileSync(join(testDir, "multi.txt"), "foo\nbar\n");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-multiline", { pattern: "foo\\nbar", paths: "multi.txt" }));
		expect(output).toContain("foo");
	});

	it("supports line-range selectors and ignores skip for single-file search", async () => {
		writeFileSync(join(testDir, "range.txt"), "needle one\nnope\nneedle three\n");

		const ranged = textOutput(await createSearchToolDefinition(testDir).execute("range", {
			pattern: "needle",
			paths: "range.txt:3-3",
		}));
		expect(ranged).toContain("*3:needle three");
		expect(ranged).not.toContain("needle one");

		const skippedSingleFile = textOutput(await createSearchToolDefinition(testDir).execute("single-skip", {
			pattern: "needle",
			paths: "range.txt",
			skip: 1,
		}));
		expect(skippedSingleFile).toContain("*1:needle one");
	});

	it("renders configured context around search line-range matches", async () => {
		writeFileSync(join(testDir, "scoped.txt"), "pre\nneedle\npost\nmore\n");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("range-context-around-match", { pattern: "needle", paths: "scoped.txt:2-2" }));
		expect(output).toContain(" 1:pre");
		expect(output).toContain("*2:needle");
		expect(output).toContain(" 3:post");
		expect(output).toContain(" 4:more");
	});

	it("finds ranged matches beyond the internal raw grep cap", async () => {
		const lines = Array.from({ length: 100_002 }, () => "needle");
		writeFileSync(join(testDir, "many.txt"), `${lines.join("\n")}\n`);
		const output = textOutput(await createSearchToolDefinition(testDir).execute("range-after-cap", { pattern: "needle", paths: "many.txt:100002" }));
		expect(output).toContain("*100002:needle");
		expect(output).not.toContain("No matches found");
	});

	it("does not count out-of-range context lines as search hits", async () => {
		writeFileSync(join(testDir, "range-context.txt"), "alpha\nneedle\nomega\noutside\n");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("range-context", { pattern: "needle", paths: "range-context.txt:1-3" }));
		expect(output).toContain(" 1:alpha");
		expect(output).toContain("*2:needle");
		expect(output).toContain(" 3:omega");
		expect(output).toContain(" 4:outside");
		expect(output).not.toContain("*4:outside");
	});

	it("uses backend regex semantics for direct ranged file searches", async () => {
		writeFileSync(join(testDir, "inline-case.txt"), "Needle\n");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("range-inline-case", { pattern: "(?i)needle", paths: "inline-case.txt:1-1" }));
		expect(output).toContain("*1:Needle");
	});


	it("uses search.skip to page by matching files", async () => {
		writeFileSync(join(testDir, "a.txt"), "needle first\n");
		writeFileSync(join(testDir, "b.txt"), "needle second\n");
		writeFileSync(join(testDir, "c.txt"), "needle third\n");

		const output = textOutput(await createSearchToolDefinition(testDir).execute("skip", {
			pattern: "needle",
			paths: [testDir],
			skip: 1,
		}));

		expect((output.match(/\.txt#/g) ?? []).length).toBe(2);
		expect(output).toContain("needle");
	});

	it("surfaces pagination when the first search page is full", async () => {
		for (let index = 1; index <= 21; index++) writeFileSync(join(testDir, `f${String(index).padStart(2, "0")}.txt`), "needle\n");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-full-page", { pattern: "needle", paths: "*.txt" }));
		expect(output).toContain("Use skip=20");
		expect(output).not.toContain("f21.txt");
	});

	it("surfaces pagination when explicit target lists fill the page", async () => {
		const paths: string[] = [];
		for (let index = 1; index <= 21; index++) {
			const name = `explicit-${String(index).padStart(2, "0")}.txt`;
			paths.push(name);
			writeFileSync(join(testDir, name), "needle\n");
		}
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-explicit-full-page", { pattern: "needle", paths }));
		expect(output).toContain("Use skip=20");
		expect(output).not.toContain("explicit-21.txt");
	});

	it("paginates ranged explicit target lists", async () => {
		const paths: string[] = [];
		for (let index = 1; index <= 21; index++) {
			const name = `ranged-${String(index).padStart(2, "0")}.txt`;
			paths.push(`${name}:1-1`);
			writeFileSync(join(testDir, name), "needle\n");
		}
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-ranged-full-page", { pattern: "needle", paths }));
		expect(output).toContain("Use skip=20");
		expect(output).not.toContain("ranged-21.txt");
		const next = textOutput(await createSearchToolDefinition(testDir).execute("search-ranged-next-page", { pattern: "needle", paths, skip: 20 }));
		expect(next).toContain("ranged-21.txt");
	});

	it("does not advertise a search page when later explicit targets do not match", async () => {
		const paths: string[] = [];
		for (let index = 1; index <= 20; index++) {
			const name = `page-${String(index).padStart(2, "0")}.txt`;
			paths.push(name);
			writeFileSync(join(testDir, name), "needle\n");
		}
		paths.push("page-nomatch.txt");
		writeFileSync(join(testDir, "page-nomatch.txt"), "none\n");
		const output = textOutput(await createSearchToolDefinition(testDir).execute("search-no-false-page", { pattern: "needle", paths }));
		expect(output).not.toContain("Use skip=20");
	});

	it("keeps advertising later search pages after skip", async () => {
		const paths: string[] = [];
		for (let index = 1; index <= 45; index++) {
			const name = `multi-${String(index).padStart(2, "0")}.txt`;
			paths.push(name);
			writeFileSync(join(testDir, name), "needle\n");
		}
		const second = textOutput(await createSearchToolDefinition(testDir).execute("search-second-page", { pattern: "needle", paths, skip: 20 }));
		expect(second).toContain("Use skip=40");
		expect(second).not.toContain("multi-45.txt");
		const third = textOutput(await createSearchToolDefinition(testDir).execute("search-third-page", { pattern: "needle", paths, skip: 40 }));
		expect(third).toContain("multi-45.txt");
		expect(third).not.toContain("Use skip=60");
	});

	it("exposes the find schema documented by the tool reference", () => {
		const properties = (createFindToolDefinition(testDir).parameters as { properties?: Record<string, unknown> }).properties ?? {};
		expect(Object.keys(properties).sort()).toEqual(["gitignore", "hidden", "limit", "paths", "timeout"]);
	});

	it("finds filesystem paths by glob", async () => {
		writeFileSync(join(testDir, "match.ts"), "");
		writeFileSync(join(testDir, "skip.js"), "");

		const output = textOutput(await createFindToolDefinition(testDir).execute("find", {
			paths: ["*.ts"],
		}));

		expect(output).toContain("match.ts");
		expect(output).not.toContain("skip.js");
	});

	it("keeps scoped find globs non-recursive", async () => {
		mkdirSync(join(testDir, "dir", "sub"), { recursive: true });
		writeFileSync(join(testDir, "dir", "direct.txt"), "");
		writeFileSync(join(testDir, "dir", "sub", "nested.txt"), "");
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-scoped", { paths: ["dir/*"] }));
		expect(output).toContain("direct.txt");
		expect(output).not.toContain("nested.txt");
	});

	it("preserves trailing slash for native directory matches", async () => {
		mkdirSync(join(testDir, "src", "tests"), { recursive: true });
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-dir-match", { paths: ["**/tests"] }));
		expect(output).toContain("tests/");
	});

	it("honors gitignore false for find under node_modules", async () => {
		mkdirSync(join(testDir, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(testDir, "node_modules", "pkg", "index.js"), "");
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-node-modules", { paths: ["**/*.js"], gitignore: false }));
		expect(output).toContain("node_modules/pkg/");
		expect(output).toContain("index.js");
	});

	it("does not prune explicitly requested node_modules find globs", async () => {
		mkdirSync(join(testDir, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(testDir, "node_modules", "pkg", "index.js"), "");
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-explicit-node-modules", { paths: ["**/node_modules/**/*.js"] }));
		expect(output).toContain("node_modules/pkg/");
		expect(output).toContain("index.js");
	});


	it("returns newest find matches first when applying limits", async () => {

		mkdirSync(join(testDir, "dir"), { recursive: true });
		const oldPath = join(testDir, "dir", "a-old.txt");
		const newPath = join(testDir, "dir", "z-new.txt");
		writeFileSync(oldPath, "");
		writeFileSync(newPath, "");
		utimesSync(oldPath, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
		utimesSync(newPath, new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"));
		const output = textOutput(await createFindToolDefinition(testDir).execute("find-newest", { paths: ["dir/*.txt"], limit: 1 }));
		expect(output).toContain("z-new.txt");
		expect(output).not.toContain("a-old.txt");
	});

	it("rejects empty find.paths and root scopes", async () => {
		await expect(createFindToolDefinition(testDir).execute("find-empty", { paths: [] }, undefined, undefined, {} as never)).rejects.toThrow(/find\.paths/);
		await expect(createFindToolDefinition(testDir).execute("find-root", { paths: ["/"] }, undefined, undefined, {} as never)).rejects.toThrow(/filesystem root/);
	});
});
