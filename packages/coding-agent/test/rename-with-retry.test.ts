import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { type RenameFileSystem, renameWithRetry } from "../src/core/rename-retry.ts";

function failure(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: rename`), { code });
}

/**
 * A file system whose rename fails with `code` the first `failures` times; `directories` are the paths that are
 * directories, and `existing` the paths that exist besides them.
 */
function refusing(
	failures: number,
	code = "EPERM",
	paths: { readonly directories?: readonly string[]; readonly existing?: readonly string[] } = {},
): RenameFileSystem & { readonly attempts: string[][] } {
	const attempts: string[][] = [];
	return {
		attempts,
		rename: async (from, to) => {
			attempts.push([from, to]);
			if (attempts.length <= failures) throw failure(code);
		},
		stat: async (path) => {
			const directory = paths.directories?.includes(path) ?? false;
			if (!directory && !(paths.existing?.includes(path) ?? false)) throw failure("ENOENT");
			return { isDirectory: () => directory };
		},
	};
}

describe("renameWithRetry", () => {
	test("on Windows, a rename another program refuses for a moment is tried again until it succeeds", async () => {
		for (const code of ["EPERM", "EACCES", "EBUSY"]) {
			const fs = refusing(5, code, { existing: ["from"] });
			await renameWithRetry("from", "to", { platform: "win32", fs });
			assert.equal(fs.attempts.length, 6, code);
		}
	});

	test("a directory is tried again too, while nothing is where it goes", async () => {
		const fs = refusing(3, "EPERM", { directories: ["from"] });
		await renameWithRetry("from", "to", { platform: "win32", fs });
		assert.equal(fs.attempts.length, 4);
	});

	test("a directory refused while one is where it goes is not tried again: Windows never moves one onto another", async () => {
		const fs = refusing(Number.POSITIVE_INFINITY, "EPERM", { directories: ["from", "to"] });
		await assert.rejects(renameWithRetry("from", "to", { platform: "win32", fs }), { code: "EPERM" });
		assert.equal(fs.attempts.length, 1);
	});

	test("a missing source or a move across devices fails at once", async () => {
		for (const code of ["ENOENT", "EXDEV"]) {
			const fs = refusing(Number.POSITIVE_INFINITY, code);
			await assert.rejects(renameWithRetry("from", "to", { platform: "win32", fs }), { code });
			assert.equal(fs.attempts.length, 1, code);
		}
	});

	test("on other platforms it is one plain rename", async () => {
		const fs = refusing(Number.POSITIVE_INFINITY, "EPERM", { existing: ["from"] });
		await assert.rejects(renameWithRetry("from", "to", { platform: "linux", fs }), { code: "EPERM" });
		assert.equal(fs.attempts.length, 1);
	});

	test("a refusal that outlasts the budget fails with the rename's error", async () => {
		const fs = refusing(Number.POSITIVE_INFINITY, "EBUSY", { existing: ["from"] });
		const started = Date.now();
		await assert.rejects(renameWithRetry("from", "to", { platform: "win32", fs, budgetMs: 1_000 }), {
			code: "EBUSY",
		});
		assert.ok(fs.attempts.length > 1, "it was tried again within the budget");
		assert.ok(Date.now() - started < 5_000, "and not past it");
	});

	test("aborting stops the retries with the signal's reason", async () => {
		const fs = refusing(Number.POSITIVE_INFINITY, "EPERM", { existing: ["from"] });
		const controller = new AbortController();
		const renaming = renameWithRetry("from", "to", { platform: "win32", fs, signal: controller.signal });
		setTimeout(() => controller.abort(new Error("cancelled")), 50);
		await assert.rejects(renaming, /cancelled/);
		const attempts = fs.attempts.length;
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(fs.attempts.length, attempts, "nothing is tried after the abort");
	});
});
