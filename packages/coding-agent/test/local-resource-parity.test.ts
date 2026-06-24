import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createHashlineSnapshotStore } from "../src/core/tools/hashline.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];
const text = (result: { content: Array<{ type: string; text?: string }> }): string => result.content.map((item) => item.text ?? "").join("\n");
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "atomic-local-resource-")); tempDirs.push(dir); return dir; }

afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("local resource parity", () => {
	it("uses source file labels and hashline snapshots for local:// read/search/write", async () => {
		const dir = await tempDir(), store = createHashlineSnapshotStore();
		await writeFile(join(dir, "a.txt"), "needle\n", "utf8");
		expect(text(await createReadToolDefinition(dir, { hashlineStore: store }).execute("read-local", { path: "local://a.txt" }, undefined, undefined, {} as never))).toContain("[a.txt#");
		const search = await createSearchToolDefinition(dir, { hashlineStore: store }).execute("search-local", { pattern: "needle", paths: "local://a.txt" }, undefined, undefined, {} as never);
		expect(text(search)).toContain("[a.txt#");
		expect(search.details?.files).toContain("a.txt");
		const write = await createWriteToolDefinition(dir, { hashlineStore: store }).execute("write-local", { path: "local://a.txt", content: "updated\n" }, undefined, undefined, {} as never);
		expect(text(write)).toContain("[a.txt#");
		expect(write.details?.resolvedPath).toBe(join(dir, "a.txt"));
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("updated\n");
	});

	it("rejects local resource traversal outside the workspace", async () => {
		const dir = await tempDir();
		await expect(createReadToolDefinition(dir).execute("read-local-traversal", { path: "local://../secret.txt" }, undefined, undefined, {} as never)).rejects.toThrow("escapes the workspace");
		await expect(createWriteToolDefinition(dir).execute("write-local-traversal", { path: "local://../secret.txt", content: "nope" }, undefined, undefined, {} as never)).rejects.toThrow("escapes the workspace");
	});

	it("reports write executable and resource metadata", async () => {
		const dir = await tempDir();
		const script = await createWriteToolDefinition(dir).execute("write-script", { path: "run.sh", content: "#!/bin/sh\necho ok\n" }, undefined, undefined, {} as never);
		expect(script.details?.madeExecutable).toBe(true);
		expect(script.details?.resolvedPath).toBe(join(dir, "run.sh"));
	});

	it("emits find progress and rich details", async () => {
		const dir = await tempDir(), updates: string[] = [];
		let pattern = "";
		const find = createFindToolDefinition(dir, { operations: { exists: () => true, stat: () => ({ isFile: false, isDirectory: true }), glob: (globPattern) => { pattern = globPattern; return [join(dir, "a.txt")]; } } });
		const result = await find.execute("find", { paths: ["."], limit: 10 }, undefined, (update) => updates.push(text(update)), {} as never);
		expect(result.details?.files).toEqual(["a.txt"]);
		expect(result.details?.fileCount).toBe(1);
		expect(pattern).toBe("**/*");
		expect(updates.some((value) => value.includes("a.txt"))).toBe(true);
	});

	it("uses oh-my-pi bash async detail shape", async () => {
		const dir = await tempDir();
		const bash = createBashToolDefinition(dir, { asyncEnabled: true, operations: { exec: async () => ({ exitCode: 0 }) } });
		const result = await bash.execute("bash-async", { command: "true", async: true }, undefined, undefined, {} as never);
		expect(result.details?.async).toMatchObject({ type: "bash", state: "running" });
		expect(result.details?.timeoutSeconds).toBe(300);
	});

	it("strips leading cd into cwd for normal execution when cwd is omitted", async () => {
		const dir = await tempDir();
		let execCommand = ""; let execCwd = "";
		const bash = createBashToolDefinition(dir, { operations: { exec: async (command, cwd) => { execCommand = command; execCwd = cwd; return { exitCode: 0 }; } } });
		await bash.execute("bash-cd-strip", { command: "cd sub && pwd" }, undefined, undefined, {} as never);
		expect(execCommand).toBe("pwd");
		expect(execCwd).toBe(join(dir, "sub"));
	});

	it("returns direct grep count and filesWithMatches mode output", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "a.txt"), "needle\nneedle\n", "utf8");
		const grep = createGrepToolDefinition(dir);
		expect(text(await grep.execute("grep-count", { pattern: "needle", mode: "count", offset: 1 }, undefined, undefined, {} as never))).toBe("1");
		expect(text(await grep.execute("grep-files", { pattern: "needle", mode: "filesWithMatches" }, undefined, undefined, {} as never))).toBe("a.txt");
		expect(text(await grep.execute("grep-file-offset", { pattern: "needle", path: "a.txt", mode: "filesWithMatches", offset: 1 }, undefined, undefined, {} as never))).toBe("No matches found");
	});

	it("matches reference schema edge constraints", async () => {
		const dir = await tempDir();
		const bash = createBashToolDefinition(dir);
		expect((bash.parameters as { properties: Record<string, unknown> }).properties.async).toBeUndefined();
		expect(JSON.stringify((bash.parameters as { properties: Record<string, unknown> }).properties.env)).toContain("^[A-Za-z_][A-Za-z0-9_]*$");
		expect((createBashToolDefinition(dir, { asyncEnabled: true }).parameters as { properties: Record<string, unknown> }).properties.async).toBeTruthy();
		const findParams = createFindToolDefinition(dir).parameters as { properties: { paths: { minItems?: number }; timeout: { minimum?: number; maximum?: number } } };
		expect(findParams.properties.paths.minItems).toBe(1);
		expect(findParams.properties.timeout.minimum).toBe(0.5);
		expect(findParams.properties.timeout.maximum).toBe(60);
		const skip = ((createSearchToolDefinition(dir).parameters as { properties: { skip: { anyOf?: unknown[] } } }).properties.skip.anyOf ?? []);
		expect(JSON.stringify(skip)).toContain("null");
	});
});
