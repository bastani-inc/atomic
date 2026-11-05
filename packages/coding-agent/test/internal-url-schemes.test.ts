import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import {
	createArtifactRouter,
	registerArtifactDir,
	unregisterArtifactDir,
} from "../src/core/tools/artifact-protocol.js";
import { ArtifactManager, resetArtifactManagerCache } from "../src/core/tools/artifacts.js";
import { createFindToolDefinition } from "../src/core/tools/find.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import { createToolDefinition } from "../src/core/tools/index.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import {
	composeInternalRouters,
	INTERNAL_URL_SCHEMES,
	type InternalResourceContext,
	isInternalUrl,
} from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";

function assertIncludes(text: string, part: string): void {
	assert.ok(text.includes(part), `expected ${JSON.stringify(part)} in:\n${text}`);
}

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
		createToolDefinition("write", cwd).execute("write", { path, content }, undefined, undefined, {
			...ctx,
			cwd,
		} as never);
	const find = (path: string) =>
		createFindToolDefinition(cwd).execute("find", { paths: [path] }, undefined, undefined, { ...ctx, cwd } as never);

	it("allows exactly the schemes this package resolves", () => {
		assert.deepEqual([...INTERNAL_URL_SCHEMES].sort(), ["artifact", "conflict", "history", "local", "skill"]);
		for (const scheme of INTERNAL_URL_SCHEMES) assert.ok(isInternalUrl(`${scheme}://x`));
		for (const scheme of REMOVED_SCHEMES) assert.equal(isInternalUrl(`${scheme}://x`), false);
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
			await assert.rejects(read(url), /not supported/);
			await assert.rejects(search("resolve", url), /not supported/);
			await assert.rejects(write(url, "x"), /not supported/);
		},
	);

	it("resolves skill:// for read with a line range, search and find", async () => {
		mkdirSync(join(cwd, ".agents/skills/demo"), { recursive: true });
		writeFileSync(join(cwd, ".agents/skills/demo/SKILL.md"), "one\ntwo needle\nthree\nfour\nfive\n");
		assertIncludes(text(await read("skill://demo:2-2")), "two needle");
		assertIncludes(text(await search("needle", "skill://demo")), "skill://demo:2:");
		assertIncludes(text(await find("skill://demo/*.md")), "SKILL.md");
	});

	it("refuses to write skill:// even when the skill exists", async () => {
		mkdirSync(join(cwd, ".agents/skills/demo"), { recursive: true });
		writeFileSync(join(cwd, ".agents/skills/demo/SKILL.md"), "keep me\n");
		await assert.rejects(write("skill://demo", "overwritten"), /skill:\/\/ resources are read-only/);
		assert.equal(readFileSync(join(cwd, ".agents/skills/demo/SKILL.md"), "utf8"), "keep me\n");
	});

	it("resolves local:// for read, search, find and write", async () => {
		await write("local://notes/a.txt", "first\nsecond needle\nthird\n");
		assertIncludes(readFileSync(join(cwd, "notes/a.txt"), "utf8"), "second needle");
		assertIncludes(text(await read("local://notes/a.txt:2-2")), "second needle");
		assertIncludes(text(await search("needle", "local://notes/a.txt")), "second needle");
		assertIncludes(text(await find("local://notes/*.txt")), "a.txt");
	});

	it("resolves artifact:// for read, search and find, and refuses to write it", async () => {
		const id = new ArtifactManager(artifactsDir).save("alpha\nbeta needle\ngamma\n", "read");
		assertIncludes(text(await read(`artifact://${id}:2-2`)), "beta needle");
		assertIncludes(text(await search("needle", `artifact://${id}`)), "beta needle");
		assertIncludes(text(await find(`artifact://${id}`)), `${id}.`);
		await assert.rejects(write(`artifact://${id}`, "x"), /read-only/);
	});

	it("resolves conflict:// for read, search and write", async () => {
		const file = join(cwd, "merge.txt");
		writeFileSync(file, "top\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> branch\nbottom\n");
		assertIncludes(text(await read("conflict://*")), "# conflict://1 merge.txt:2-6");
		assertIncludes(text(await read("conflict://1")), "theirs line");
		assert.equal(text(await read("conflict://1/ours")), "ours line");
		assert.equal(text(await read("conflict://1/theirs")), "theirs line");
		assertIncludes(text(await search("theirs", "conflict://*")), "conflict://*:");
		await assert.rejects(find("conflict://*"), /find cannot list conflict:\/\/ URLs/);
		await assert.rejects(read("conflict://1/other"), /Unknown conflict side/);
		await assert.rejects(read("conflict://9"), /Conflict id not found/);
		await write("conflict://1", "@theirs\n");
		assert.equal(readFileSync(file, "utf8"), "top\ntheirs line\nbottom\n");
		await assert.rejects(read("conflict://*"), /No conflict markers/);
	});

	it("resolves history:// for read and search, and refuses to write or find it", async () => {
		assertIncludes(text(await read("history://")), "history://sessions");
		assert.equal(text(await search("sessions", "history://sessions")), "No matches found");
		assertIncludes(
			text(await search("sessions", "history://")),
			"workflow runs not searched: Workflow history is unavailable",
		);
		await assert.rejects(write("history://sessions", "x"), /read-only/);
		await assert.rejects(find("history://sessions"), /find cannot list history:\/\/ URLs/);
	});
});
