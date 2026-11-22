import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "vitest";
import {
	RENAME_RETRY_BACKOFF_MAX_MS,
	RENAME_RETRY_BACKOFF_START_MS,
	RENAME_RETRY_DIRECTORY_MS,
	RENAME_RETRY_SYNC_MODULE_PATH,
	renameSyncWithRetry,
	renameWithRetry,
} from "../helpers/rename-retry.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: rename`), { code });
}

test("renameSyncWithRetry retries transient Windows EPERM/EACCES/EBUSY with growing backoff up to cap", () => {
	const errors = [...Array.from({ length: 11 }, (_, index) => errno(["EPERM", "EACCES", "EBUSY"][index % 3]!))];
	let clock = 0;
	const sleeps: number[] = [];
	const attempts = renameSyncWithRetry("C:\\from", "C:\\to", {
		platform: "win32",
		rename: () => {
			const next = errors.shift();
			if (next) throw next;
		},
		stat: (path) => {
			if (path === "C:\\from") return { isDirectory: () => true };
			throw errno("ENOENT");
		},
		now: () => clock,
		sleep: (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
	});
	assert.equal(attempts, 12);
	assert.deepEqual(sleeps, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 100]);
	assert.equal(sleeps[0], RENAME_RETRY_BACKOFF_START_MS);
	assert.equal(sleeps.at(-1), RENAME_RETRY_BACKOFF_MAX_MS);
});

test("renameSyncWithRetry stops once budgetMs would be exceeded, fails immediately off Windows or on non-transient/occupied errors", () => {
	let clock = 0;
	let attempts = 0;
	const last = errno("EPERM");
	assert.throws(
		() =>
			renameSyncWithRetry("C:\\from", "C:\\to", {
				platform: "win32",
				budgetMs: 60,
				rename: () => {
					attempts++;
					throw last;
				},
				stat: (path) => {
					if (path === "C:\\from") return { isDirectory: () => true };
					throw errno("ENOENT");
				},
				now: () => clock,
				sleep: (ms) => {
					clock += ms;
				},
			}),
		(error) => error === last,
	);
	assert.equal(attempts, 4); // sleeps 10 + 20 + 30 = 60, next backoff 40 would exceed 60

	for (const platform of ["linux", "darwin"] as const) {
		let calls = 0;
		assert.throws(
			() =>
				renameSyncWithRetry("/from", "/to", {
					platform,
					rename: () => {
						calls++;
						throw errno("EPERM");
					},
				}),
			{ code: "EPERM" },
		);
		assert.equal(calls, 1, platform);
	}

	let occupiedCalls = 0;
	assert.throws(
		() =>
			renameSyncWithRetry("C:\\from", "C:\\to", {
				platform: "win32",
				rename: () => {
					occupiedCalls++;
					throw errno("EPERM");
				},
				stat: () => ({ isDirectory: () => true }),
			}),
		{ code: "EPERM" },
	);
	assert.equal(occupiedCalls, 1, "does not retry moving a directory onto an existing directory");

	let nonTransientCalls = 0;
	assert.throws(
		() =>
			renameSyncWithRetry("C:\\from", "C:\\to", {
				platform: "win32",
				rename: () => {
					nonTransientCalls++;
					throw errno("ENOENT");
				},
			}),
		{ code: "ENOENT" },
	);
	assert.equal(nonTransientCalls, 1);
});

test("renameWithRetry retries transient Windows errors with growing backoff and respects AbortSignal", async () => {
	const errors = [errno("EPERM"), errno("EBUSY"), errno("EACCES")];
	let clock = 0;
	const sleeps: number[] = [];
	await renameWithRetry("C:\\from", "C:\\to", {
		platform: "win32",
		fs: {
			rename: async () => {
				const next = errors.shift();
				if (next) throw next;
			},
			stat: async (path) => {
				if (path === "C:\\from") return { isDirectory: () => true };
				throw errno("ENOENT");
			},
		},
		now: () => clock,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
	});
	assert.deepEqual(sleeps, [10, 20, 30]);

	const controller = new AbortController();
	const reason = new Error("stop");
	controller.abort(reason);
	await assert.rejects(
		() =>
			renameWithRetry("C:\\from", "C:\\to", {
				platform: "win32",
				signal: controller.signal,
				fs: {
					rename: async () => {
						throw new Error("should not run after abort");
					},
					stat: async () => ({ isDirectory: () => true }),
				},
			}),
		(error) => error === reason,
	);
});

test("CommonJS module at RENAME_RETRY_SYNC_MODULE_PATH moves real directories and exports the 60 s directory budget", async () => {
	const cjs = createRequire(import.meta.url)(RENAME_RETRY_SYNC_MODULE_PATH) as {
		RENAME_RETRY_DIRECTORY_MS: number;
		renameSyncWithRetry: typeof renameSyncWithRetry;
	};
	assert.equal(cjs.RENAME_RETRY_DIRECTORY_MS, RENAME_RETRY_DIRECTORY_MS);
	assert.equal(RENAME_RETRY_DIRECTORY_MS, 60_000);

	const root = makeTempDirectory("rename-retry-helper-");
	try {
		const dirA = join(root, "dir-a");
		const dirB = join(root, "dir-b");
		const dirC = join(root, "dir-c");
		mkdirSync(join(dirA, "nested"), { recursive: true });
		writeFileSync(join(dirA, "nested", "file.txt"), "hello\n");

		assert.equal(cjs.renameSyncWithRetry(dirA, dirB), 1);
		assert.equal(existsSync(dirA), false);
		assert.equal(existsSync(join(dirB, "nested", "file.txt")), true);

		await renameWithRetry(dirB, dirC);
		assert.equal(existsSync(dirB), false);
		assert.equal(existsSync(join(dirC, "nested", "file.txt")), true);
	} finally {
		removeTempDirectory(root);
	}
});
