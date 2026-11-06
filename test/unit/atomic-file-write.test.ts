import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import {
	ATOMIC_WRITE_MAX_ATTEMPTS,
	AtomicWriteError,
	type AtomicWriteOptions,
	isAtomicWriteError,
	writeFileAtomically,
} from "../helpers/atomic-file-write.js";
import {
	fileExistsSync,
	makeDirectorySync,
	makeTempDirectory,
	readDirectorySync,
	readTextSync,
	removeTempDirectory,
	writeTextSync,
} from "../helpers/runtime.js";

const TARGET = join("fixture", "shared-pool-hosts-0", "host-stats-C.json");
const BACKOFF_MS = [10, 20, 40, 80, 160, 320, 640];

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: rename -> '${TARGET}'`), { code, syscall: "rename" });
}

interface Recorder {
	readonly writes: { readonly path: string; readonly contents: string }[];
	readonly renames: { readonly from: string; readonly to: string }[];
	readonly removals: string[];
	readonly sleeps: number[];
	readonly options: Required<AtomicWriteOptions>;
}

function recorder(
	platform: NodeJS.Platform,
	renameFailures: readonly unknown[],
	failures: { readonly write?: unknown; readonly remove?: unknown } = {},
): Recorder {
	const writes: { path: string; contents: string }[] = [];
	const renames: { from: string; to: string }[] = [];
	const removals: string[] = [];
	const sleeps: number[] = [];
	return {
		writes,
		renames,
		removals,
		sleeps,
		options: {
			platform,
			writeFile: async (path, contents) => {
				writes.push({ path, contents });
				if (failures.write !== undefined) throw failures.write;
			},
			rename: async (from, to) => {
				const failure = renameFailures[renames.length];
				renames.push({ from, to });
				if (failure !== undefined) throw failure;
			},
			remove: async (path) => {
				removals.push(path);
				if (failures.remove !== undefined) throw failures.remove;
			},
			sleep: async (milliseconds) => {
				sleeps.push(milliseconds);
			},
		},
	};
}

async function rejection(write: Promise<void>): Promise<AtomicWriteError> {
	try {
		await write;
	} catch (error) {
		assert.ok(error instanceof AtomicWriteError, `expected an AtomicWriteError, got ${String(error)}`);
		return error;
	}
	assert.fail("the write was expected to fail");
}

const directories: string[] = [];
function directory(): string {
	const path = makeTempDirectory("atomic-file-write-");
	directories.push(path);
	return path;
}

afterEach(() => {
	for (const path of directories.splice(0)) removeTempDirectory(path);
});

test("a reader sees the previous complete file while the next one is half written, then the new one (#4511)", async () => {
	const root = directory();
	const target = join(root, "host-stats-C.json");
	await writeFileAtomically(target, JSON.stringify({ busy: 0 }));
	let readMidWrite: unknown;
	await writeFileAtomically(target, JSON.stringify({ busy: 1, git: "unavailable" }), {
		writeFile: async (path, contents) => {
			const half = Math.floor(contents.length / 2);
			await writeFile(path, contents.slice(0, half));
			readMidWrite = JSON.parse(await readFile(target, "utf8"));
			await appendFile(path, contents.slice(half));
		},
	});
	assert.deepEqual(readMidWrite, { busy: 0 });
	assert.deepEqual(JSON.parse(readTextSync(target, "utf8")), { busy: 1, git: "unavailable" });
	assert.deepEqual(readDirectorySync(root), ["host-stats-C.json"], "no temporary file is left beside it");
});

test("the contents go to a fresh temporary file beside the target, never to the target itself (#4511)", async () => {
	const run = recorder("linux", []);
	await writeFileAtomically(TARGET, '{"busy":0}', run.options);
	await writeFileAtomically(TARGET, '{"busy":1}', run.options);
	assert.deepEqual(
		run.writes.map(({ contents }) => contents),
		['{"busy":0}', '{"busy":1}'],
	);
	const [first, second] = run.writes.map(({ path }) => path);
	assert.notEqual(first, second, "every write has its own temporary file");
	for (const path of [first, second]) {
		assert.notEqual(path, TARGET);
		assert.equal(dirname(path), dirname(TARGET), "a rename within one directory never crosses a device");
		assert.match(basename(path), new RegExp(`^\\.host-stats-C\\.json\\.${process.pid}\\.[0-9a-f-]{36}\\.tmp$`, "u"));
	}
	assert.deepEqual(run.renames, [
		{ from: first, to: TARGET },
		{ from: second, to: TARGET },
	]);
	assert.deepEqual(run.removals, [], "a renamed temporary file is gone already");
	assert.deepEqual(run.sleeps, []);
});

test("on Windows, EPERM and EBUSY are retried after a doubling backoff until the rename succeeds (#4511)", async () => {
	const run = recorder("win32", [errno("EPERM"), errno("EBUSY"), errno("EPERM")]);
	await writeFileAtomically(TARGET, "{}", run.options);
	assert.equal(run.renames.length, 4);
	assert.ok(run.renames.every(({ from, to }) => from === run.writes[0]?.path && to === TARGET));
	assert.deepEqual(run.sleeps, [10, 20, 40]);
	assert.equal(run.writes.length, 1, "the temporary file is written once and renamed again");
	assert.deepEqual(run.removals, []);
});

test("a Windows lock that outlives every attempt is a retryable rename-exhausted AtomicWriteError (#4511)", async () => {
	const failures = Array.from({ length: ATOMIC_WRITE_MAX_ATTEMPTS }, () => errno("EBUSY"));
	const run = recorder("win32", failures);
	const error = await rejection(writeFileAtomically(TARGET, "{}", run.options));
	assert.equal(error.name, "AtomicWriteError");
	assert.equal(error.code, "rename-exhausted");
	assert.equal(error.path, TARGET);
	assert.equal(error.attempts, 8);
	assert.equal(error.errno, "EBUSY");
	assert.equal(error.retryable, true);
	assert.equal(error.cause, failures[7]);
	assert.equal(error.cleanupCause, undefined);
	assert.match(error.hint, /held the file open past every retry/u);
	assert.equal(run.renames.length, 8, "the bound is exactly ATOMIC_WRITE_MAX_ATTEMPTS renames");
	assert.deepEqual(run.sleeps, BACKOFF_MS, "no pause follows the last attempt");
	assert.deepEqual(run.removals, [run.writes[0]?.path], "the temporary file is removed");
});

test("the attempt before the bound still recovers (#4511)", async () => {
	const run = recorder(
		"win32",
		Array.from({ length: ATOMIC_WRITE_MAX_ATTEMPTS - 1 }, () => errno("EPERM")),
	);
	await writeFileAtomically(TARGET, "{}", run.options);
	assert.equal(run.renames.length, 8);
	assert.deepEqual(run.sleeps, BACKOFF_MS);
	assert.deepEqual(run.removals, []);
});

for (const platform of ["linux", "darwin"] as const) {
	test(`on ${platform}, EPERM is not a lock: rename-refused after one attempt, without a pause (#4511)`, async () => {
		const failure = errno("EPERM");
		const run = recorder(platform, [failure]);
		const error = await rejection(writeFileAtomically(TARGET, "{}", run.options));
		assert.equal(error.code, "rename-refused");
		assert.equal(error.attempts, 1);
		assert.equal(error.errno, "EPERM");
		assert.equal(error.retryable, false);
		assert.equal(error.cause, failure);
		assert.equal(run.renames.length, 1);
		assert.deepEqual(run.sleeps, []);
		assert.deepEqual(run.removals, [run.writes[0]?.path]);
	});
}

for (const [label, thrown, expectedErrno] of [
	["EACCES", errno("EACCES"), "EACCES"],
	["EXDEV", errno("EXDEV"), "EXDEV"],
	["an Error without a code", new Error("disk vanished"), undefined],
	["a non-string code", Object.assign(new Error("odd"), { code: 5 }), undefined],
	["a thrown string", "EPERM", undefined],
	["null", null, undefined],
] as const) {
	test(`on Windows, ${label} is not a lock: rename-refused after one attempt, without a pause (#4511)`, async () => {
		const run = recorder("win32", [thrown]);
		const error = await rejection(writeFileAtomically(TARGET, "{}", run.options));
		assert.ok(isAtomicWriteError(error));
		assert.equal(error.code, "rename-refused");
		assert.equal(error.attempts, 1);
		assert.equal(error.errno, expectedErrno);
		assert.equal(error.retryable, false);
		assert.equal(error.cause, thrown);
		assert.match(error.hint, /not a transient Windows lock/u);
		assert.equal(run.renames.length, 1);
		assert.deepEqual(run.sleeps, []);
		assert.deepEqual(run.removals, [run.writes[0]?.path]);
	});
}

test("a lock that turns into another failure is refused at that attempt (#4511)", async () => {
	const run = recorder("win32", [errno("EBUSY"), errno("EXDEV")]);
	const error = await rejection(writeFileAtomically(TARGET, "{}", run.options));
	assert.equal(error.code, "rename-refused");
	assert.equal(error.attempts, 2);
	assert.equal(error.errno, "EXDEV");
	assert.deepEqual(run.sleeps, [10]);
});

test("a temporary file that cannot be written is write-failed, and the target is never renamed over (#4511)", async () => {
	const failure = errno("ENOSPC");
	const run = recorder("win32", [], { write: failure });
	const error = await rejection(writeFileAtomically(TARGET, "{}", run.options));
	assert.equal(error.code, "write-failed");
	assert.equal(error.attempts, 0);
	assert.equal(error.errno, "ENOSPC");
	assert.equal(error.retryable, false);
	assert.equal(error.cause, failure);
	assert.match(error.hint, /free space and permissions/u);
	assert.deepEqual(run.renames, []);
	assert.deepEqual(run.removals, [run.writes[0]?.path], "a partly written temporary file is removed");
});

test("a failed removal of the temporary file is kept as cleanupCause, never in place of the failure (#4511)", async () => {
	const failure = errno("EXDEV");
	const removal = errno("EBUSY");
	const run = recorder("win32", [failure], { remove: removal });
	const error = await rejection(writeFileAtomically(TARGET, "{}", run.options));
	assert.equal(error.code, "rename-refused");
	assert.equal(error.cause, failure);
	assert.equal(error.cleanupCause, removal);
	assert.equal(run.removals.length, 1);
});

test("the default platform is the running one (#4511)", async () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform);
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	try {
		const run = recorder("linux", [errno("EBUSY")]);
		const { writeFile, rename, remove, sleep } = run.options;
		await writeFileAtomically(TARGET, "{}", { writeFile, rename, remove, sleep });
		assert.equal(run.renames.length, 2, "a lock is retried where the running platform is Windows");
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
});

test("with the default pause, a rename blocked by a lock is attempted again (#4511)", async () => {
	const run = recorder("win32", [errno("EBUSY")]);
	const { platform, writeFile, rename, remove } = run.options;
	await writeFileAtomically(TARGET, "{}", { platform, writeFile, rename, remove });
	assert.equal(run.renames.length, 2);
});

test("the default file operations replace a real file, and a failed write leaves no temporary file (#4511)", async () => {
	const root = directory();
	const target = join(root, "host-stats-B.json");
	writeTextSync(target, '{"hostId":"B","maxWorkers":1}');
	await writeFileAtomically(target, '{"hostId":"B","maxWorkers":2}');
	assert.equal(readTextSync(target, "utf8"), '{"hostId":"B","maxWorkers":2}');
	assert.deepEqual(readDirectorySync(root), ["host-stats-B.json"]);

	const missing = join(root, "missing", "host-stats-B.json");
	const error = await rejection(writeFileAtomically(missing, "{}"));
	assert.equal(error.code, "write-failed");
	assert.equal(error.errno, "ENOENT");
	assert.equal(error.cleanupCause, undefined, "removing a temporary file that was never created is not a failure");
	assert.equal(fileExistsSync(join(root, "missing")), false);

	const occupied = join(root, "occupied");
	makeDirectorySync(join(occupied, "entry"), { recursive: true });
	const refused = await rejection(writeFileAtomically(occupied, "{}", { platform: "linux" }));
	assert.equal(refused.code, "rename-refused");
	assert.equal(refused.cleanupCause, undefined);
	assert.deepEqual(readDirectorySync(root).sort(), ["host-stats-B.json", "occupied"], "the temporary file is removed");
});

test("the error message names the path, code, attempts, last error and next step (#4511)", () => {
	const error = new AtomicWriteError(
		{ code: "rename-exhausted", path: TARGET, attempts: 8, errno: "EPERM" },
		{ cause: errno("EPERM") },
	);
	assert.equal(
		error.message,
		`Atomic write failed: ${TARGET} (rename-exhausted) after 8 rename attempts, last error EPERM. A process or scanner held the file open past every retry; write it again later, or find the holder (for example with handle.exe).`,
	);
	const refused = new AtomicWriteError(
		{ code: "write-failed", path: TARGET, attempts: 0, errno: undefined },
		{ cause: "gone" },
	);
	assert.match(refused.message, /\(write-failed\) after 0 rename attempts, last error without a code\./u);
});

test("isAtomicWriteError matches an AtomicWriteError by name and code after it crossed a boundary (#4511)", () => {
	assert.equal(isAtomicWriteError({ name: "AtomicWriteError", code: "write-failed" }), true);
	assert.equal(isAtomicWriteError({ name: "AtomicWriteError", code: "rename-exhausted" }), true);
	assert.equal(isAtomicWriteError({ name: "AtomicWriteError", code: "rename-refused" }), true);
	assert.equal(isAtomicWriteError({ name: "AtomicWriteError", code: "rename-failed" }), false);
	assert.equal(isAtomicWriteError({ name: "Error", code: "rename-refused" }), false);
	assert.equal(isAtomicWriteError(errno("EPERM")), false);
	assert.equal(isAtomicWriteError(null), false);
	assert.equal(isAtomicWriteError("AtomicWriteError"), false);
	assert.equal(isAtomicWriteError(undefined), false);
});
