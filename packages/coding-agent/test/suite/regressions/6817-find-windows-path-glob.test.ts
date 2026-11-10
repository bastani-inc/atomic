import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { spawn } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensureTool: vi.fn<(tool: "fd" | "rg", onStatus?: (status: ToolStatus) => void) => Promise<string | undefined>>(),
	loadNativeSearchBinding: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("child_process", async () => {
	const actual = await vi.importActual<typeof import("child_process")>("child_process");
	return { ...actual, spawn: mocks.spawn };
});

vi.mock("../../../src/core/tools/search-native.ts", () => ({
	loadNativeSearchBinding: mocks.loadNativeSearchBinding,
}));

vi.mock("../../../src/utils/tools-manager.ts", () => ({
	ensureTool: mocks.ensureTool,
}));

import { createFindToolDefinition } from "../../../src/core/tools/find.ts";
import type { ToolStatus } from "../../../src/utils/tools-manager.ts";

const mockedSpawn = vi.mocked(spawn);

interface FakeFdOptions {
	lines: readonly string[];
	keepOpenAfterLines?: boolean;
}

interface FakeFd {
	child: ReturnType<typeof spawn>;
	kill: ReturnType<typeof vi.fn>;
}

function fakeFdProcess({ lines, keepOpenAfterLines = false }: FakeFdOptions): FakeFd {
	const stdout = new Readable({ read() {} });
	const emitter = new EventEmitter();
	const finish = () => setImmediate(() => emitter.emit("close", 0));
	const kill = vi.fn(() => {
		child.killed = true;
		stdout.push(null);
		return true;
	});
	const child = Object.assign(emitter, { killed: false, kill, stderr: Readable.from([]), stdout });
	stdout.on("end", finish);
	for (const line of lines) stdout.push(`${line}\n`);
	if (!keepOpenAfterLines) stdout.push(null);
	return { child: child as unknown as ReturnType<typeof spawn>, kill };
}

describe("issue #6817: Windows find path globs", () => {
	let tempDir: string;
	let searchPath: string;
	let platform: NodeJS.Platform;
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-6817-"));
		searchPath = join(tempDir, "src");
		mkdirSync(searchPath, { recursive: true });
		platform = "win32";
		mocks.ensureTool.mockResolvedValue("fd");
		mocks.loadNativeSearchBinding.mockReturnValue(null);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		mocks.ensureTool.mockReset();
		mocks.loadNativeSearchBinding.mockReset();
		mockedSpawn.mockReset();
	});

	async function runFind(
		paths: string[],
		fd: FakeFd[],
		extra: { limit?: number } = {},
	): Promise<{ text: string; resultLimitReached: number | undefined; timedOut: boolean | undefined }> {
		for (const child of fd) mockedSpawn.mockImplementationOnce(() => child.child);
		Object.defineProperty(process, "platform", { configurable: true, value: platform });
		const result = await createFindToolDefinition(tempDir).execute(
			"find-windows-path-glob",
			{ paths, ...extra },
			undefined,
			undefined,
			undefined as never,
		);
		const first = result.content[0];
		return {
			text: first?.type === "text" ? first.text : "",
			resultLimitReached: result.details?.resultLimitReached,
			timedOut: result.details?.timedOut,
		};
	}

	function spawnedArgs(call = 0): string[] {
		return mockedSpawn.mock.calls[call]?.[1] as string[];
	}

	function foundFiles(text: string): string[] {
		const stack: string[] = [];
		return text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.flatMap((line) => {
				const header = line.match(/^(#+)\s+(.+\/)$/);
				if (header) {
					stack.length = header[1]!.length - 1;
					stack[header[1]!.length - 1] = header[2]!;
					return [];
				}
				if (line.startsWith("[")) return [];
				return `${stack.join("")}${line}`;
			});
	}

	it("lists every entry without fd's glob, full-path or result-limit options for Windows path patterns", async () => {
		await runFind([join(searchPath, "**/lib/*.spec.ts")], [fakeFdProcess({ lines: [] })]);

		const args = spawnedArgs();
		assert.deepEqual(
			mocks.ensureTool.mock.calls.map(([tool]) => tool),
			["fd"],
		);
		assert.deepEqual(args, [
			"--color=never",
			"--no-require-git",
			"--hidden",
			"--exclude",
			"node_modules",
			"--",
			"",
			searchPath,
		]);
	});

	it("keeps the visibility and ignore options when listing Windows path patterns", async () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		mockedSpawn.mockImplementationOnce(() => fakeFdProcess({ lines: [] }).child);
		await createFindToolDefinition(tempDir).execute(
			"find-windows-path-glob",
			{ paths: [join(searchPath, "**/lib/*.spec.ts")], hidden: false, gitignore: false },
			undefined,
			undefined,
			undefined as never,
		);

		assert.deepEqual(spawnedArgs(), [
			"--color=never",
			"--no-require-git",
			"--no-ignore",
			"--exclude",
			"node_modules",
			"--",
			"",
			searchPath,
		]);
	});

	it("filters fd's listing with the path pattern, including Windows separators and CRLF", async () => {
		const { text } = await runFind(
			[join(searchPath, "**/lib/*.spec.ts")],
			[
				fakeFdProcess({
					lines: [
						`${searchPath}\\lib\\a.spec.ts\r`,
						`${searchPath}/lib/b.spec.ts`,
						`${searchPath}/lib/sub/c.spec.ts`,
						`${searchPath}/lib/d.test.ts`,
						`${searchPath}/other/e.spec.ts`,
						"",
					],
				}),
			],
		);

		const found = foundFiles(text);
		expect(found).toHaveLength(2);
		expect(found.filter((file) => file.endsWith("a.spec.ts"))).toHaveLength(1);
		expect(found.filter((file) => file.endsWith("b.spec.ts"))).toEqual(["lib/b.spec.ts"]);
	});

	it("matches dotfiles like fd's glob", async () => {
		const { text } = await runFind(
			[join(searchPath, "**/lib/*.ts")],
			[fakeFdProcess({ lines: [`${searchPath}/.hidden/lib/a.ts`, `${searchPath}/lib/.b.ts`] })],
		);

		expect(foundFiles(text).sort()).toEqual([".hidden/lib/a.ts", "lib/.b.ts"]);
	});

	it("matches an all-lowercase pattern case-insensitively and a mixed-case pattern exactly", async () => {
		const lower = await runFind(
			[join(searchPath, "**/lib/*.ts")],
			[fakeFdProcess({ lines: [`${searchPath}/LIB/A.TS`, `${searchPath}/lib/b.ts`] })],
		);
		const mixed = await runFind(
			[join(searchPath, "**/Lib/*.ts")],
			[fakeFdProcess({ lines: [`${searchPath}/Lib/a.ts`, `${searchPath}/lib/b.ts`, `${searchPath}/LIB/c.ts`] })],
		);

		expect(foundFiles(lower.text).sort()).toEqual(["LIB/A.TS", "lib/b.ts"]);
		expect(foundFiles(mixed.text)).toEqual(["Lib/a.ts"]);
	});

	it("treats extglob syntax literally like fd's glob", async () => {
		const { text } = await runFind(
			[join(searchPath, "**/lib/+(a|b).ts")],
			[
				fakeFdProcess({
					lines: [`${searchPath}/lib/a.ts`, `${searchPath}/lib/b.ts`, `${searchPath}/lib/+(a|b).ts`],
				}),
			],
		);

		expect(foundFiles(text)).toEqual(["lib/+(a|b).ts"]);
	});

	it("does not match the directory named by a trailing /** pattern", async () => {
		const { text } = await runFind(
			[join(searchPath, "**/lib*/**")],
			[
				fakeFdProcess({
					lines: [
						`${searchPath}/lib`,
						`${searchPath}/lib/a.ts`,
						`${searchPath}/lib/sub/b.ts`,
						`${searchPath}/other/c.ts`,
					],
				}),
			],
		);

		expect(foundFiles(text).sort()).toEqual(["lib/a.ts", "lib/sub/b.ts"]);
	});

	it("stops fd once one more match than the limit was found and ignores non-matching entries", async () => {
		const fd = fakeFdProcess({
			lines: [
				`${searchPath}/skip/a.txt`,
				`${searchPath}/lib/a.ts`,
				`${searchPath}/skip/b.txt`,
				`${searchPath}/lib/b.ts`,
				`${searchPath}/lib/c.ts`,
			],
			keepOpenAfterLines: true,
		});

		const { text, resultLimitReached, timedOut } = await runFind([join(searchPath, "**/lib/*.ts")], [fd], {
			limit: 1,
		});

		expect(fd.kill).toHaveBeenCalledTimes(1);
		expect(timedOut).toBeFalsy();
		expect(resultLimitReached).toBe(1);
		expect(foundFiles(text)).toEqual(["lib/a.ts"]);
	});

	it("does not stop fd or report the limit when exactly limit entries match", async () => {
		const fd = fakeFdProcess({ lines: [`${searchPath}/skip/a.txt`, `${searchPath}/lib/a.ts`] });

		const { text, resultLimitReached, timedOut } = await runFind([join(searchPath, "**/lib/*.ts")], [fd], {
			limit: 1,
		});

		expect(fd.kill).not.toHaveBeenCalled();
		expect(timedOut).toBeFalsy();
		expect(resultLimitReached).toBeUndefined();
		expect(foundFiles(text)).toEqual(["lib/a.ts"]);
	});

	it("stops the fd of a later target as soon as it finds any match after the limit was filled", async () => {
		const second = join(tempDir, "tests");
		mkdirSync(second, { recursive: true });
		const first = fakeFdProcess({ lines: [`${searchPath}/lib/a.ts`] });
		const later = fakeFdProcess({ lines: [`${second}/lib/z.ts`], keepOpenAfterLines: true });

		const { text, resultLimitReached, timedOut } = await runFind(
			[join(searchPath, "**/lib/*.ts"), join(second, "**/lib/*.ts")],
			[first, later],
			{ limit: 1 },
		);

		expect(later.kill).toHaveBeenCalledTimes(1);
		expect(timedOut).toBeFalsy();
		expect(resultLimitReached).toBe(1);
		expect(foundFiles(text)).toEqual(["src/lib/a.ts"]);
	});

	it("keeps fd's own glob matching for basename patterns on Windows", async () => {
		const { text } = await runFind(
			[join(searchPath, "*.spec.ts")],
			[fakeFdProcess({ lines: [`${searchPath}/a.spec.ts`, `${searchPath}/b.ts`] })],
		);

		assert.deepEqual(spawnedArgs(), [
			"--color=never",
			"--no-require-git",
			"--hidden",
			"--exclude",
			"node_modules",
			"--glob",
			"--max-results",
			"201",
			"--",
			"*.spec.ts",
			searchPath,
		]);
		expect(foundFiles(text).sort()).toEqual(["a.spec.ts", "b.ts"]);
	});

	it("leaves path-pattern matching to fd outside Windows", async () => {
		platform = "linux";
		const { text } = await runFind(
			[join(searchPath, "*/lib/*.ts")],
			[fakeFdProcess({ lines: [`${searchPath}/x/lib/a.ts`, `${searchPath}/other/b.ts`] })],
		);

		assert.deepEqual(spawnedArgs(), [
			"--color=never",
			"--no-require-git",
			"--hidden",
			"--exclude",
			"node_modules",
			"--glob",
			"--max-results",
			"201",
			"--full-path",
			"--",
			"**/*/lib/*.ts",
			searchPath,
		]);
		expect(foundFiles(text).sort()).toEqual(["other/b.ts", "x/lib/a.ts"]);
	});

	it("prefixes relative path patterns with **/ before matching on Windows", async () => {
		const { text } = await runFind(
			[join(searchPath, "*/lib/*.ts")],
			[fakeFdProcess({ lines: [`${searchPath}/x/lib/a.ts`, `${searchPath}/x/lib/sub/b.ts`] })],
		);

		expect(foundFiles(text)).toEqual(["x/lib/a.ts"]);
	});

	it("keeps a ** segment in the middle of a path pattern matching zero or more directories", async () => {
		const { text } = await runFind(
			[join(searchPath, "**/lib/**/a.ts")],
			[fakeFdProcess({ lines: [`${searchPath}/lib/a.ts`, `${searchPath}/lib/x/a.ts`, `${searchPath}/lib/x/b.ts`] })],
		);

		expect(foundFiles(text).sort()).toEqual(["lib/a.ts", "lib/x/a.ts"]);
	});

	it("does not exclude node_modules when the pattern names it, even for Windows path patterns", async () => {
		await runFind([join(searchPath, "**/node_modules/*.ts")], [fakeFdProcess({ lines: [] })]);

		assert.deepEqual(spawnedArgs(), ["--color=never", "--no-require-git", "--hidden", "--", "", searchPath]);
	});

	it("does not prefix a leading **/ pattern a second time outside Windows", async () => {
		platform = "linux";
		await runFind([join(searchPath, "**/lib/*.ts")], [fakeFdProcess({ lines: [] })]);

		assert.equal(spawnedArgs().at(-2), "**/lib/*.ts");
	});
});
