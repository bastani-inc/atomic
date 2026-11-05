import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "child_process";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_OFFLINE } from "../src/config.ts";
import { isManagedToolDownloadError, isManagedToolError } from "../src/utils/managed-tool-errors.ts";

const mocks = vi.hoisted(() => ({
	spawnSync: vi.fn<(command: string, args?: readonly string[]) => SpawnSyncReturns<Buffer>>(),
}));

// Neither fd nor ripgrep is on PATH, and find cannot fall back to the native search.
vi.mock("child_process", async () => {
	const actual = await vi.importActual<typeof import("child_process")>("child_process");
	return { ...actual, spawnSync: mocks.spawnSync };
});
vi.mock("../src/core/tools/search-native.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/tools/search-native.ts")>()),
	loadNativeSearchBinding: () => null,
}));

/** The grep and find tool calls report why their managed tool could not be downloaded (#4389). */
describe("search tools when their managed tool cannot be downloaded (#4389)", () => {
	let tempDir: string;
	let workDir: string;
	let grep: ReturnType<typeof import("../src/core/tools/grep.ts").createGrepTool>;
	let find: ReturnType<typeof import("../src/core/tools/find.ts").createFindTool>;
	const lookupFailure = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND github.com") });

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-search-download-failure-"));
		workDir = join(tempDir, "work");
		vi.stubEnv(ENV_AGENT_DIR, join(tempDir, "agent"));
		vi.stubEnv(ENV_OFFLINE, "");
		vi.stubEnv("PI_OFFLINE", "");
		mocks.spawnSync.mockReset();
		mocks.spawnSync.mockReturnValue({ error: new Error("not found") } as SpawnSyncReturns<Buffer>);
		vi.spyOn(globalThis, "fetch").mockRejectedValue(lookupFailure);
		vi.resetModules();
		mkdirSync(workDir);
		writeFileSync(join(workDir, "notes.txt"), "needle\n");
		grep = (await import("../src/core/tools/grep.ts")).createGrepTool(workDir);
		find = (await import("../src/core/tools/find.ts")).createFindTool(workDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each([
		["grep", "rg", "https://github.com/BurntSushi/ripgrep/releases/latest"],
		["find", "fd", "https://github.com/sharkdp/fd/releases/latest"],
	] as const)("%s rejects with the %s download failure, its URL and its cause", async (toolName, tool, url) => {
		const call =
			toolName === "grep"
				? grep.execute("grep-download-failure", { pattern: "needle", path: workDir, literal: true })
				: find.execute("find-download-failure", { paths: ["**/*.txt"] });

		const error = await call.catch((caught: Error) => caught);

		assert.ok(isManagedToolDownloadError(error));
		assert.deepEqual([error.fields.tool, error.fields.phase, error.fields.url], [tool, "resolve-version", url]);
		assert.equal(error.cause, lookupFailure);
	});

	it.each([
		["grep", "ripgrep (rg) is not available and could not be downloaded"],
		["find", "fd is not available and could not be downloaded"],
	] as const)("%s keeps its plain error when no download was tried", async (toolName, message) => {
		vi.stubEnv(ENV_OFFLINE, "1");
		const call =
			toolName === "grep"
				? grep.execute("grep-offline", { pattern: "needle", path: workDir, literal: true })
				: find.execute("find-offline", { paths: ["**/*.txt"] });

		const error = await call.catch((caught: Error) => caught);

		assert.ok(!isManagedToolError(error));
		assert.equal(error.message, message);
		assert.equal(vi.mocked(fetch).mock.calls.length, 0);
	});
});
