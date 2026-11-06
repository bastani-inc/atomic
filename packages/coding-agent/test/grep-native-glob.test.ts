import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, it, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import type { NativeGrepOptions, NativeGrepResult } from "../src/core/tools/search-native.js";

useTemporaryAgentDir();

const native = vi.hoisted(() => ({ calls: [] as NativeGrepOptions[], matchPath: "migrations/main/a.js" }));

vi.mock("../src/core/tools/search-native.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/tools/search-native.js")>()),
	loadNativeSearchBinding: () => ({
		glob: async () => ({ matches: [], totalMatches: 0 }),
		grep: async (options: NativeGrepOptions): Promise<NativeGrepResult> => {
			native.calls.push(options);
			return {
				matches: [{ path: native.matchPath, lineNumber: 1, line: "hello" }],
				totalMatches: 1,
				filesWithMatches: 1,
				filesSearched: 1,
				limitReached: false,
			};
		},
	}),
}));

const { createGrepTool } = await import("../src/core/tools/grep.js");

describe("native grep globs relative to path (pi #11807)", () => {
	const searchRoot = mkdtempSync(join(tmpdir(), "atomic-native-grep-glob-"));
	const grep = createGrepTool(searchRoot);

	afterAll(() => {
		rmSync(searchRoot, { recursive: true, force: true });
	});

	beforeEach(() => {
		native.calls.length = 0;
		native.matchPath = "migrations/main/a.js";
	});

	const globs: ReadonlyArray<readonly [string | undefined, string | undefined]> = [
		["./migrations/main/*.js", "migrations/main/*.js"],
		["././migrations/main/*.js", "migrations/main/*.js"],
		["!./dist/**", "!dist/**"],
		["migrations/main/*.js", "migrations/main/*.js"],
		[undefined, undefined],
	];
	for (const [glob, expected] of globs) {
		it(`passes the glob ${String(glob)} to the native search as ${String(expected)}`, async () => {
			await grep.execute("native-glob", glob === undefined ? { pattern: "hello" } : { pattern: "hello", glob });

			assert.equal(native.calls.length, 1);
			assert.equal(native.calls[0].glob, expected);
			assert.equal(native.calls[0].path, searchRoot);
		});
	}

	it("prints the native search's relative paths unchanged", async () => {
		const result = await grep.execute("native-glob", { pattern: "hello", glob: "migrations/main/*.js" });

		assert.deepEqual(result.content, [{ type: "text", text: "migrations/main/a.js:1: hello" }]);
	});

	for (const matchPath of ["nested/migrations/main/b.js", "nested\\migrations\\main\\b.js"]) {
		it(`prints the native search's relative path ${matchPath} with forward slashes`, async () => {
			native.matchPath = matchPath;
			const result = await grep.execute("native-glob", { pattern: "hello", glob: "**/b.js" });

			assert.deepEqual(result.content, [{ type: "text", text: "nested/migrations/main/b.js:1: hello" }]);
		});
	}

	it("tells the model the glob is relative to path", () => {
		const description = grep.parameters.properties.glob.description ?? "";

		assert.match(description, /relative to path/);
		assert.match(description, /without '\/' matches file names at any depth/);
	});
});
