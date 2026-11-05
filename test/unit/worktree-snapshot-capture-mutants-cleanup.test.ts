import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, test, vi } from "vitest";

const failing = vi.hoisted(() => ({ removals: [] as string[], failRemovalOf: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: async (path: string, options?: object) => {
			failing.removals.push(String(path));
			if (failing.failRemovalOf !== undefined && String(path).includes(failing.failRemovalOf)) {
				throw Object.assign(new Error(`cannot remove ${path}`), { code: "EBUSY" });
			}
			return actual.rm(path, options);
		},
	};
});

import { withScratchDirectory } from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";

beforeEach(() => {
	failing.removals.length = 0;
	failing.failRemovalOf = "atomic-snapshot-";
});
afterEach(() => {
	failing.failRemovalOf = undefined;
	// The failed cleanups left both directories behind.
	for (const directory of failing.removals) rmSync(directory, { recursive: true, force: true });
});

test("an error that crosses two scratch directories whose cleanup both failed stays the primary error, carrying the last cleanup failure", async () => {
	const primary = new Error("the inner action failed");
	let outerDirectory = "";
	let innerDirectory = "";
	await assert.rejects(
		withScratchDirectory(async (outer) => {
			outerDirectory = outer;
			await withScratchDirectory(async (inner) => {
				innerDirectory = inner;
				throw primary;
			});
		}),
		(error: unknown) => {
			assert.equal(error, primary);
			const cleanup = (error as { cleanupCause?: Error }).cleanupCause;
			assert.equal(cleanup?.message, `cannot remove ${outerDirectory}`);
			return true;
		},
	);
	assert.notEqual(outerDirectory, innerDirectory);
	assert.deepEqual(failing.removals, [innerDirectory, outerDirectory]);
});
