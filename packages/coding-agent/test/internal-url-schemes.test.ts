import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";
import {
	createArtifactRouter,
	registerArtifactDir,
	unregisterArtifactDir,
} from "../src/core/tools/artifact-protocol.ts";
import { ArtifactManager, resetArtifactManagerCache } from "../src/core/tools/artifacts.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createHistoryRouter } from "../src/core/tools/history-protocol.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import {
	composeInternalRouters,
	INTERNAL_URL_SCHEMES,
	type InternalResourceContext,
	isInternalUrl,
} from "../src/core/tools/resource-selectors.ts";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const REMOVED_SCHEMES = ["omp", "agent", "issue", "memory", "pr", "rule", "mcp", "vault"] as const;

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

describe("internal URL schemes (#4252)", () => {
	let cwd: string;
	let artifactsDir: string;
	let ctx: InternalResourceContext;
	beforeEach(() => {
		resetArtifactManagerCache();
		cwd = mkdtempSync(join(tmpdir(), "atomic-schemes-"));
		artifactsDir = join(cwd, ".artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		registerArtifactDir(artifactsDir);
		ctx = {
			internalResourceRouter: composeInternalRouters(
				createArtifactRouter(() => [artifactsDir]),
				createHistoryRouter({ cwd, sessionStore: () => new MemorySessionStore(), workflows: () => undefined }),
			),
		};
	});
	afterEach(() => {
		unregisterArtifactDir(artifactsDir);
		rmSync(cwd, { recursive: true, force: true });
	});

	const read = (path: string) =>
		createReadToolDefinition(cwd).execute("read", { path }, undefined, undefined, { ...ctx, cwd } as never);
	const search = (pattern: string, paths: string) =>
		createSearchToolDefinition(cwd).execute("search", { pattern, paths }, undefined, undefined, {
			...ctx,
			cwd,
		} as never);
	const write = (path: string, content: string) =>
		createWriteToolDefinition(cwd).execute("write", { path, content }, undefined, undefined, {
			...ctx,
			cwd,
		} as never);
	const find = (path: string) =>
		createFindToolDefinition(cwd).execute("find", { paths: [path] }, undefined, undefined, { ...ctx, cwd } as never);

	it("allows exactly the schemes this package resolves", () => {
		expect([...INTERNAL_URL_SCHEMES].sort()).toEqual(["artifact", "conflict", "history", "local", "skill"]);
		for (const scheme of INTERNAL_URL_SCHEMES) expect(isInternalUrl(`${scheme}://x`)).toBe(true);
		for (const scheme of REMOVED_SCHEMES) expect(isInternalUrl(`${scheme}://x`)).toBe(false);
	});

	it.each(REMOVED_SCHEMES)(
		"%s:// is not supported by read, search or write, even when a router would answer",
		async (scheme) => {
			const url = `${scheme}://x`;
			ctx = {
				internalResourceRouter: composeInternalRouters({
					read: () => "would resolve",
					resolve: () => join(cwd, "x"),
				}),
			};
			await expect(read(url)).rejects.toThrow(/not supported/);
			await expect(search("resolve", url)).rejects.toThrow(/not supported/);
			await expect(write(url, "x")).rejects.toThrow(/not supported/);
		},
	);

	it("resolves skill:// for read with a line range, search and find", async () => {
		mkdirSync(join(cwd, ".agents/skills/demo"), { recursive: true });
		writeFileSync(join(cwd, ".agents/skills/demo/SKILL.md"), "one\ntwo needle\nthree\nfour\nfive\n");
		expect(text(await read("skill://demo:2-2"))).toContain("two needle");
		expect(text(await search("needle", "skill://demo"))).toContain("skill://demo:2:");
		expect(text(await find("skill://demo/*.md"))).toContain("SKILL.md");
	});

	it("refuses to write skill:// even when the skill exists", async () => {
		mkdirSync(join(cwd, ".agents/skills/demo"), { recursive: true });
		writeFileSync(join(cwd, ".agents/skills/demo/SKILL.md"), "keep me\n");
		await expect(write("skill://demo", "overwritten")).rejects.toThrow(/skill:\/\/ resources are read-only/);
		expect(readFileSync(join(cwd, ".agents/skills/demo/SKILL.md"), "utf8")).toBe("keep me\n");
	});

	it("resolves local:// for read, search, find and write", async () => {
		await write("local://notes/a.txt", "first\nsecond needle\nthird\n");
		expect(readFileSync(join(cwd, "notes/a.txt"), "utf8")).toContain("second needle");
		expect(text(await read("local://notes/a.txt:2-2"))).toContain("second needle");
		expect(text(await search("needle", "local://notes/a.txt"))).toContain("second needle");
		expect(text(await find("local://notes/*.txt"))).toContain("a.txt");
	});

	it("resolves artifact:// for read, search and find, and refuses to write it", async () => {
		const id = new ArtifactManager(artifactsDir).save("alpha\nbeta needle\ngamma\n", "read");
		expect(text(await read(`artifact://${id}:2-2`))).toContain("beta needle");
		expect(text(await search("needle", `artifact://${id}`))).toContain("beta needle");
		expect(text(await find(`artifact://${id}`))).toContain(`${id}.`);
		await expect(write(`artifact://${id}`, "x")).rejects.toThrow(/read-only/);
	});

	it("resolves conflict:// for read, search and write", async () => {
		const file = join(cwd, "merge.txt");
		writeFileSync(file, "top\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> branch\nbottom\n");
		expect(text(await read("conflict://*"))).toContain("# conflict://1 merge.txt:2-6");
		expect(text(await read("conflict://1"))).toContain("theirs line");
		expect(text(await read("conflict://1/ours"))).toBe("ours line");
		expect(text(await read("conflict://1/theirs"))).toBe("theirs line");
		expect(text(await search("theirs", "conflict://*"))).toContain("conflict://*:");
		await expect(find("conflict://*")).rejects.toThrow(/find cannot list conflict:\/\/ URLs/);
		await expect(read("conflict://1/other")).rejects.toThrow(/Unknown conflict side/);
		await expect(read("conflict://9")).rejects.toThrow(/Conflict id not found/);
		await write("conflict://1", "@theirs\n");
		expect(readFileSync(file, "utf8")).toBe("top\ntheirs line\nbottom\n");
		await expect(read("conflict://*")).rejects.toThrow(/No conflict markers/);
	});

	it("resolves history:// for read and search, and refuses to write or find it", async () => {
		expect(text(await read("history://"))).toContain("history://sessions");
		expect(text(await search("sessions", "history://"))).toBe("No matches found");
		await expect(write("history://sessions", "x")).rejects.toThrow(/read-only/);
		await expect(find("history://sessions")).rejects.toThrow(/find cannot list history:\/\/ URLs/);
	});
});
