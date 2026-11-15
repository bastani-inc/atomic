import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import { createFindToolDefinition } from "../src/core/tools/find.js";
import { createGrepToolDefinition } from "../src/core/tools/grep.js";
import { createToolDefinition } from "../src/core/tools/index.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";

const tempDirs: string[] = [];
const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content.map((item) => item.text ?? "").join("\n");
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "atomic-local-resource-"));
	tempDirs.push(dir);
	return dir;
}

/** Creates a symbolic link, or reports false where the platform refuses to (Windows without the privilege). */
async function trySymlink(target: string, path: string, type?: "dir" | "file"): Promise<boolean> {
	try {
		await symlink(target, path, type);
		return true;
	} catch (error) {
		if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false;
		throw error;
	}
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local resource parity", () => {
	it("resolves local:// to its source file for read, search and write", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "a.txt"), "needle\n", "utf8");
		expect(
			text(
				await createReadToolDefinition(dir).execute(
					"read-local",
					{ path: "local://a.txt" },
					undefined,
					undefined,
					{} as never,
				),
			),
		).toBe("needle");
		const search = await createSearchToolDefinition(dir).execute(
			"search-local",
			{ pattern: "needle", paths: "local://a.txt" },
			undefined,
			undefined,
			{} as never,
		);
		expect(text(search)).toContain("a.txt:1: needle");
		expect(search.details?.files).toContain("a.txt");
		const write = await createToolDefinition("write", dir).execute(
			"write-local",
			{ path: "local://a.txt", content: "updated\n" },
			undefined,
			undefined,
			{} as never,
		);
		expect(text(write)).toBe(`Successfully wrote to ${join(dir, "a.txt")}`);
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("updated\n");
	});

	it("resolves local://..notes.md to the workspace file whose name starts with two dots (#4836)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "..notes.md"), "dotted\n", "utf8");
		const read = await createReadToolDefinition(dir).execute(
			"read-local-dotted",
			{ path: "local://..notes.md" },
			undefined,
			undefined,
			{} as never,
		);
		assert.equal(text(read), "dotted");
	});

	it("rejects local resource traversal outside the workspace", async () => {
		const dir = await tempDir();
		await expect(
			createReadToolDefinition(dir).execute(
				"read-local-traversal",
				{ path: "local://../secret.txt" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("escapes the workspace");
		await expect(
			createToolDefinition("write", dir).execute(
				"write-local-traversal",
				{ path: "local://../secret.txt", content: "nope" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("escapes the workspace");
	});

	it("rejects symlink and selector escapes for local resources", async () => {
		const dir = await tempDir(),
			outside = await tempDir();
		await writeFile(join(outside, "secret.txt"), "secret", "utf8");
		await symlink(join(outside, "secret.txt"), join(dir, "link.txt"));
		await expect(
			createReadToolDefinition(dir).execute(
				"read-local-symlink",
				{ path: "local://link.txt" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("escapes the workspace");
		await expect(
			createReadToolDefinition(dir).execute(
				"read-skill-escape",
				{ path: "skill://x/../../secret.txt" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("escapes the workspace");
		await expect(
			createReadToolDefinition(dir).execute(
				"read-archive-escape",
				{ path: "../outside/archive.zip:a.txt" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("escapes the workspace");
		await expect(
			createReadToolDefinition(dir).execute(
				"read-sqlite-escape",
				{ path: "../outside/data.sqlite:t" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("escapes the workspace");
	});

	it("refuses local:// reads and writes through a dangling link to a path outside the workspace (#5045)", async (ctx) => {
		const dir = await tempDir(),
			outside = await tempDir();
		if (!(await trySymlink(join(outside, "new.txt"), join(dir, "dangling"), "file"))) return ctx.skip();
		await expect(
			createReadToolDefinition(dir).execute(
				"read-local-dangling",
				{ path: "local://dangling" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("escapes the workspace");
		await expect(
			createToolDefinition("write", dir).execute(
				"write-local-dangling",
				{ path: "local://dangling", content: "nope" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("escapes the workspace");
		await expect(readFile(join(outside, "new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses local:// writes below a dangling directory link that points outside the workspace (#5045)", async (ctx) => {
		const dir = await tempDir(),
			outside = await tempDir();
		if (!(await trySymlink(join(outside, "missing-dir"), join(dir, "gone"), "dir"))) return ctx.skip();
		await expect(
			createToolDefinition("write", dir).execute(
				"write-local-dangling-dir",
				{ path: "local://gone/new.txt", content: "nope" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("escapes the workspace");
		await expect(readFile(join(outside, "missing-dir", "new.txt"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("writes local:// through a dangling link whose target lies inside the workspace (#5045)", async (ctx) => {
		const dir = await tempDir();
		await mkdir(join(dir, "sub"));
		if (!(await trySymlink(join("sub", "later.txt"), join(dir, "pending"), "file"))) return ctx.skip();
		const write = await createToolDefinition("write", dir).execute(
			"write-local-pending",
			{ path: "local://pending", content: "inside\n" },
			undefined,
			undefined,
			{} as never,
		);
		expect(text(write)).toBe(`Successfully wrote to ${join(dir, "pending")}`);
		assert.equal(await readFile(join(dir, "sub", "later.txt"), "utf8"), "inside\n");
	});

	it("still refuses local:// paths below a live directory link outside the workspace (#5045)", async (ctx) => {
		const dir = await tempDir(),
			outside = await tempDir();
		if (!(await trySymlink(outside, join(dir, "dirlink"), "dir"))) return ctx.skip();
		await expect(
			createToolDefinition("write", dir).execute(
				"write-local-dirlink",
				{ path: "local://dirlink/x.txt", content: "nope" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("escapes the workspace");
		await expect(readFile(join(outside, "x.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("emits find progress and rich details", async () => {
		const dir = await tempDir(),
			updates: string[] = [];
		let pattern = "";
		const find = createFindToolDefinition(dir, {
			operations: {
				exists: () => true,
				stat: () => ({ isFile: false, isDirectory: true }),
				glob: (globPattern) => {
					pattern = globPattern;
					return [join(dir, "a.txt")];
				},
			},
		});
		const result = await find.execute(
			"find",
			{ paths: ["."], limit: 10 },
			undefined,
			(update) => updates.push(text(update)),
			{} as never,
		);
		expect(result.details?.files).toEqual(["a.txt"]);
		expect(result.details?.fileCount).toBe(1);
		expect(pattern).toBe("**/*");
		expect(updates.some((value) => value.includes("a.txt"))).toBe(true);
	});

	it("strips leading cd into cwd for normal execution when cwd is omitted", async () => {
		const dir = await tempDir();
		let execCommand = "";
		let execCwd = "";
		const bash = createBashToolDefinition(dir, {
			operations: {
				exec: async (command, cwd) => {
					execCommand = command;
					execCwd = cwd;
					return { exitCode: 0 };
				},
			},
		});
		await bash.execute("bash-cd-strip", { command: "cd sub && pwd" }, undefined, undefined, {} as never);
		expect(execCommand).toBe("pwd");
		expect(execCwd).toBe(join(dir, "sub"));
	});

	it("returns direct grep count and filesWithMatches mode output", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "a.txt"), "needle\nneedle\n", "utf8");
		const grep = createGrepToolDefinition(dir);
		expect(
			text(
				await grep.execute(
					"grep-count",
					{ pattern: "needle", mode: "count", offset: 1 },
					undefined,
					undefined,
					{} as never,
				),
			),
		).toBe("1");
		expect(
			text(
				await grep.execute(
					"grep-files",
					{ pattern: "needle", mode: "filesWithMatches" },
					undefined,
					undefined,
					{} as never,
				),
			),
		).toBe("a.txt");
		expect(
			text(
				await grep.execute(
					"grep-file-offset",
					{ pattern: "needle", path: "a.txt", mode: "filesWithMatches", offset: 1 },
					undefined,
					undefined,
					{} as never,
				),
			),
		).toBe("No matches found");
	});

	it("matches reference schema edge constraints", async () => {
		const dir = await tempDir();
		const bash = createBashToolDefinition(dir);
		expect((bash.parameters as { properties: Record<string, unknown> }).properties.async).toBeUndefined();
		expect(JSON.stringify((bash.parameters as { properties: Record<string, unknown> }).properties.env)).toContain(
			"^[A-Za-z_][A-Za-z0-9_]*$",
		);
		const findParams = createFindToolDefinition(dir).parameters as {
			properties: { paths: { minItems?: number }; timeout: { minimum?: number; maximum?: number } };
		};
		expect(findParams.properties.paths.minItems).toBe(1);
		expect(findParams.properties.timeout.minimum).toBe(0.5);
		expect(findParams.properties.timeout.maximum).toBe(60);
		const skip =
			(createSearchToolDefinition(dir).parameters as { properties: { skip: { anyOf?: unknown[] } } }).properties.skip
				.anyOf ?? [];
		expect(JSON.stringify(skip)).toContain("null");
	});
});
