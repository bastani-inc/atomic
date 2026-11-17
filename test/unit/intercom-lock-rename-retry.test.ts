import assert from "node:assert/strict";
import fsModule from "node:fs";
import fsPromisesModule from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { renameWithRetry, renameWithRetryAsync } from "../../packages/intercom/broker/rename-retry.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const tempDir = makeTempDirectory("ic5220-rename-");
afterAll(() => removeTempDirectory(tempDir));

function withRename<T>(rename: typeof fsModule.renameSync, run: () => T): T {
	const original = fsModule.renameSync;
	fsModule.renameSync = rename;
	syncBuiltinESMExports();
	try {
		return run();
	} finally {
		fsModule.renameSync = original;
		syncBuiltinESMExports();
	}
}

for (const code of ["EACCES", "EPERM", "EBUSY"]) {
	test(`a transient Windows ${code} does not prevent a lock rename (#5220)`, () => {
		let attempts = 0;
		withRename(
			() => {
				if (++attempts === 1) throw Object.assign(new Error("scan in progress"), { code });
			},
			() => renameWithRetry(join(tempDir, "from"), join(tempDir, "to"), { platform: "win32" }),
		);
		assert.equal(attempts, 2);
	});
}

test("non-Windows and non-transient lock rename failures are not retried (#5220)", () => {
	for (const [platform, code] of [
		["linux", "EBUSY"],
		["win32", "ENOENT"],
	] as const) {
		let attempts = 0;
		const failure = Object.assign(new Error("rename failed"), { code });
		withRename(
			() => {
				attempts++;
				throw failure;
			},
			() =>
				assert.throws(
					() => renameWithRetry("from", "to", { platform }),
					(error) => error === failure,
				),
		);
		assert.equal(attempts, 1);
	}
});

test("lock rename retries stop when their time budget is spent (#5220)", () => {
	let attempts = 0;
	const failure = Object.assign(new Error("scan in progress"), { code: "EBUSY" });
	withRename(
		() => {
			attempts++;
			throw failure;
		},
		() =>
			assert.throws(
				() => renameWithRetry("from", "to", { platform: "win32", budgetMs: 0 }),
				(error) => error === failure,
			),
	);
	assert.equal(attempts, 1);
});

test("an abort stops a transient lock rename without another attempt (#5220)", () => {
	let attempts = 0;
	const controller = new AbortController();
	const reason = new Error("cancelled lock rename");
	withRename(
		() => {
			attempts++;
			controller.abort(reason);
			throw Object.assign(new Error("scan in progress"), { code: "EBUSY" });
		},
		() =>
			assert.throws(
				() => renameWithRetry("from", "to", { platform: "win32", signal: controller.signal }),
				(error) => error === reason,
			),
	);
	assert.equal(attempts, 1);
});

test("an occupied generation directory is not retried (#5220)", () => {
	const from = join(tempDir, "occupied-from");
	const to = join(tempDir, "occupied-to");
	fsModule.mkdirSync(from);
	fsModule.mkdirSync(to);
	let attempts = 0;
	const failure = Object.assign(new Error("directory exists"), { code: "EPERM" });
	withRename(
		() => {
			attempts++;
			throw failure;
		},
		() =>
			assert.throws(
				() => renameWithRetry(from, to, { platform: "win32" }),
				(error) => error === failure,
			),
	);
	assert.equal(attempts, 1);
});

test("a Windows rename that keeps failing is not retried longer when the clock steps back (#5220)", () => {
	const from = join(tempDir, "clock-step-from");
	fsModule.writeFileSync(from, "x");
	const realNow = Date.now.bind(Date);
	let nowCalls = 0;
	let renames = 0;
	let code: string | undefined;
	Date.now = () => realNow() - (++nowCalls > 1 ? 3_000 : 0);
	try {
		withRename(
			(source, target) => {
				renames++;
				throw Object.assign(new Error(`EPERM: operation not permitted, rename '${source}' -> '${target}'`), {
					code: "EPERM",
				});
			},
			() => {
				try {
					renameWithRetry(from, `${from}.moved`, { platform: "win32" });
				} catch (error) {
					code = (error as NodeJS.ErrnoException).code;
				}
			},
		);
	} finally {
		Date.now = realNow;
	}
	assert.equal(code, "EPERM");
	assert.ok(renames <= 26, `${renames} renames`);
});

test("async renameWithRetryAsync retries transient Windows errors and respects abort signals (#5220)", async () => {
	const original = fsPromisesModule.rename;
	let attempts = 0;
	fsPromisesModule.rename = (async () => {
		if (++attempts === 1) throw Object.assign(new Error("scan in progress"), { code: "EBUSY" });
	}) as typeof fsPromisesModule.rename;
	syncBuiltinESMExports();
	try {
		await renameWithRetryAsync(join(tempDir, "async-from"), join(tempDir, "async-to"), { platform: "win32" });
		assert.equal(attempts, 2);

		const controller = new AbortController();
		const reason = new Error("cancelled async lock rename");
		let abortAttempts = 0;
		fsPromisesModule.rename = (async () => {
			abortAttempts++;
			controller.abort(reason);
			throw Object.assign(new Error("scan in progress"), { code: "EBUSY" });
		}) as typeof fsPromisesModule.rename;
		syncBuiltinESMExports();
		await assert.rejects(
			() =>
				renameWithRetryAsync(join(tempDir, "async-from"), join(tempDir, "async-to"), {
					platform: "win32",
					signal: controller.signal,
				}),
			(error) => error === reason,
		);
		assert.equal(abortAttempts, 1);
	} finally {
		fsPromisesModule.rename = original;
		syncBuiltinESMExports();
	}
});
