import assert from "node:assert/strict";
import { sep } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	globPaths: [] as string[],
	grepPaths: [] as string[],
}));

vi.mock("../../../src/core/tools/search-native.js", () => ({
	loadNativeSearchBinding: () => ({
		glob: async (options: { path: string }) => {
			native.globPaths.push(options.path);
			return { matches: [], totalMatches: 0 };
		},
		grep: async (options: { path: string }) => {
			native.grepPaths.push(options.path);
			return { matches: [], totalMatches: 0, filesWithMatches: 0, filesSearched: 0 };
		},
	}),
}));

import { createFindToolDefinition, type FindOperations } from "../../../src/core/tools/find.js";
import { splitPathLikeGlob } from "../../../src/core/tools/glob-path-utils.js";
import { createSearchToolDefinition } from "../../../src/core/tools/search.js";

describe("globs anchored at the filesystem root (#4707)", () => {
	afterEach(() => {
		native.globPaths.length = 0;
		native.grepPaths.length = 0;
	});

	it("keeps the POSIX, drive and UNC share root as the search base (#4707)", () => {
		assert.deepEqual(splitPathLikeGlob("/**/*.ts"), { basePath: "/", glob: "**/*.ts" });
		assert.deepEqual(splitPathLikeGlob("/*.ts"), { basePath: "/", glob: "*.ts" });
		assert.deepEqual(splitPathLikeGlob("C:\\**\\*.ts"), { basePath: "C:\\", glob: "**/*.ts" });
		assert.deepEqual(splitPathLikeGlob("C:/**/*.ts"), { basePath: "C:/", glob: "**/*.ts" });
		assert.deepEqual(splitPathLikeGlob("c:\\*.ts"), { basePath: "c:\\", glob: "*.ts" });
		assert.deepEqual(splitPathLikeGlob("\\\\server\\share\\**\\*.ts"), {
			basePath: "\\\\server\\share\\",
			glob: "**/*.ts",
		});
		assert.deepEqual(splitPathLikeGlob("//server/share/*.ts"), { basePath: "//server/share/", glob: "*.ts" });
	});

	it("keeps relative and deeper absolute bases unchanged (#4707)", () => {
		assert.deepEqual(splitPathLikeGlob("**/*.ts"), { basePath: ".", glob: "**/*.ts" });
		assert.deepEqual(splitPathLikeGlob("*.ts"), { basePath: ".", glob: "**/*.ts" });
		assert.deepEqual(splitPathLikeGlob("src/**/*.ts"), { basePath: "src", glob: "**/*.ts" });
		assert.deepEqual(splitPathLikeGlob("/tmp/app/*.ts"), { basePath: "/tmp/app", glob: "*.ts" });
		assert.deepEqual(splitPathLikeGlob("C:\\work\\**\\*.ts"), { basePath: "C:/work", glob: "**/*.ts" });
		assert.deepEqual(splitPathLikeGlob("\\\\server\\share\\dir\\*.ts"), {
			basePath: "//server/share/dir",
			glob: "*.ts",
		});
	});

	it.runIf(sep === "/")("searches the POSIX root for a root-anchored find glob (#4707)", async () => {
		await createFindToolDefinition("/tmp").execute("find-root", { paths: ["/**/*.ts"] });

		assert.deepEqual(native.globPaths, ["/"]);
	});

	it.runIf(sep === "/")("searches the POSIX root for a root-anchored search glob (#4707)", async () => {
		await createSearchToolDefinition("/tmp").execute("search-root", { pattern: "needle", paths: ["/**/*.ts"] });

		assert.deepEqual(native.grepPaths, ["/"]);
	});

	it("searches the drive or UNC share root for a root-anchored Windows find glob (#4707)", async () => {
		const searched: string[] = [];
		const operations: FindOperations = {
			exists: () => true,
			stat: () => ({ isFile: false, isDirectory: true }),
			glob: (_pattern, cwd) => {
				searched.push(cwd);
				return [];
			},
		};
		const find = createFindToolDefinition("C:\\work\\app", { operations });
		for (const path of ["C:\\**\\*.ts", "C:/**/*.ts", "\\\\server\\share\\**\\*.ts"]) {
			await find.execute("find-windows-root", { paths: [path] });
		}

		assert.deepEqual(searched, ["C:\\", "C:/", "\\\\server\\share\\"]);
	});
});
