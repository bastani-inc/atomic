import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { FOLDER_MOVE_MAX_ATTEMPTS, moveFolderSync } from "../helpers/folder-move.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

function refused(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: operation not permitted, rename 'C:\\from' -> 'C:\\to'`), {
		code,
		syscall: "rename",
	});
}

/** A rename that is refused with `failures`, in order, and then succeeds. */
function renames(failures: readonly NodeJS.ErrnoException[]) {
	const attempts: string[] = [];
	const sleeps: number[] = [];
	return {
		attempts,
		sleeps,
		options: {
			rename: (from: string, to: string) => {
				const failure = failures[attempts.length];
				attempts.push(`${from} -> ${to}`);
				if (failure !== undefined) throw failure;
			},
			sleep: (milliseconds: number) => {
				sleeps.push(milliseconds);
			},
		},
	};
}

test("a folder another process holds open for a moment on Windows is moved once it lets go", () => {
	const recorded = renames([refused("EPERM"), refused("EACCES"), refused("EBUSY")]);

	const attempts = moveFolderSync("C:\\from", "C:\\to", { platform: "win32", ...recorded.options });

	assert.equal(attempts, 4);
	assert.equal(recorded.attempts.length, 4);
	assert.deepEqual(recorded.sleeps, [50, 100, 150]);
});

test("a folder held open on Windows past every attempt fails with the last refusal", () => {
	const failures = Array.from({ length: FOLDER_MOVE_MAX_ATTEMPTS }, () => refused("EPERM"));
	const recorded = renames(failures);

	assert.throws(
		() => moveFolderSync("C:\\from", "C:\\to", { platform: "win32", ...recorded.options }),
		(error) => error === failures.at(-1),
	);
	assert.equal(recorded.attempts.length, FOLDER_MOVE_MAX_ATTEMPTS);
});

test("a refusal that is not a hold, or one outside Windows, fails at once", () => {
	for (const [platform, failure] of [
		["win32", refused("ENOENT")],
		["linux", refused("EPERM")],
		["darwin", refused("EBUSY")],
	] as const) {
		const recorded = renames([failure]);
		assert.throws(() => moveFolderSync("/from", "/to", { platform, ...recorded.options }), failure);
		assert.equal(recorded.attempts.length, 1, platform);
		assert.deepEqual(recorded.sleeps, [], platform);
	}
});

test("a folder is moved with its contents", () => {
	const root = makeTempDirectory("folder-move-");
	try {
		const from = join(root, "from");
		mkdirSync(join(from, "nested"), { recursive: true });
		writeFileSync(join(from, "nested", "file.txt"), "kept");

		assert.equal(moveFolderSync(from, join(root, "to")), 1);

		assert.equal(existsSync(from), false);
		assert.equal(existsSync(join(root, "to", "nested", "file.txt")), true);
	} finally {
		removeTempDirectory(root);
	}
});
