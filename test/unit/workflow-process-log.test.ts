import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test, vi } from "vitest";
import { appendProcessLog, logFailureOf, removeProcessLog } from "../../packages/workflows/src/workers/process-log.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

// Removing a log's directory can be refused in ways a test cannot arrange on every platform.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, rmdir: vi.fn(actual.rmdir) };
});

afterEach(() => {
	vi.mocked(rmdir).mockClear();
});

const POSIX = process.platform !== "win32";
/** How long a loaded runner may take to settle a log stream's open, write or close. */
const LOG_SETTLE_TIMEOUT_MS = 10_000;

test("a log failure is named by its error code, or its error's name when it has none (#4327)", () => {
	assert.equal(logFailureOf(Object.assign(new Error("denied"), { code: "EACCES" })), "EACCES");
	assert.equal(logFailureOf(Object.assign(new Error("odd"), { code: 13 })), "Error");
	assert.equal(logFailureOf(new TypeError("no code")), "TypeError");
});

test("a process's stderr is appended to its log, beside what the log already held, until the log is closed (#4327)", async () => {
	const directory = makeTempDirectory("process-log-");
	try {
		const path = join(directory, "logs", "worker.log");
		mkdirSync(join(directory, "logs"));
		writeFileSync(path, "earlier\n");
		const stderr = new PassThrough();
		const failures: string[] = [];
		const log = appendProcessLog(stderr, path, (failure) => failures.push(failure));
		stderr.write("now\n");
		await vi.waitFor(() => assert.equal(readFileSync(path, "utf8"), "earlier\nnow\n"), {
			timeout: LOG_SETTLE_TIMEOUT_MS,
		});
		await log.close();
		stderr.write("after the log closed\n");
		assert.equal(stderr.readableFlowing, true, "stderr is drained once the log is closed");
		await log.close();
		assert.equal(readFileSync(path, "utf8"), "earlier\nnow\n");
		assert.deepEqual(failures, []);
	} finally {
		removeTempDirectory(directory);
	}
});

test("a log whose directory cannot be made is reported once and its process's stderr drained (#4327)", async () => {
	const directory = makeTempDirectory("process-log-");
	try {
		writeFileSync(join(directory, "logs"), "a file where the log directory belongs");
		const stderr = new PassThrough();
		const failures: string[] = [];
		const log = appendProcessLog(stderr, join(directory, "logs", "worker.log"), (failure) => failures.push(failure));
		assert.equal(failures.length, 1);
		assert.match(failures[0] ?? "", POSIX ? /^(ENOTDIR|EEXIST)$/ : /^E[A-Z]+$/);
		assert.equal(stderr.readableFlowing, true, "stderr is drained instead of blocking its process");
		stderr.emit("error", Object.assign(new Error("pipe broke"), { code: "EPIPE" }));
		assert.equal(failures.length, 1, "a log fails once");
		await log.close();
	} finally {
		removeTempDirectory(directory);
	}
});

// Windows lets a directory be opened for appending without an error.
test.skipIf(!POSIX)("a log that fails to open is reported with its code (#4327)", async () => {
	const directory = makeTempDirectory("process-log-");
	try {
		mkdirSync(join(directory, "worker.log"));
		const opening = new PassThrough();
		const failures: string[] = [];
		const log = appendProcessLog(opening, join(directory, "worker.log"), (failure) => failures.push(failure));
		await vi.waitFor(() => assert.deepEqual(failures, ["EISDIR"]), { timeout: LOG_SETTLE_TIMEOUT_MS });
		assert.equal(opening.readableFlowing, true);
		await log.close();
	} finally {
		removeTempDirectory(directory);
	}
});

test("a stderr that fails is reported with its code and drained (#4327)", async () => {
	const directory = makeTempDirectory("process-log-");
	try {
		const broken = new PassThrough();
		const failures: string[] = [];
		const log = appendProcessLog(broken, join(directory, "broken.log"), (failure) => failures.push(failure));
		broken.emit("error", Object.assign(new Error("pipe broke"), { code: "EPIPE" }));
		assert.deepEqual(failures, ["EPIPE"]);
		assert.equal(broken.readableFlowing, true);
		await log.close();
	} finally {
		removeTempDirectory(directory);
	}
});

test("a process without stderr has nothing to log (#4327)", async () => {
	const directory = makeTempDirectory("process-log-");
	try {
		const path = join(directory, "logs", "worker.log");
		for (const stderr of [null, undefined]) {
			const log = appendProcessLog(stderr, path, () => assert.fail("nothing failed"));
			await log.close();
		}
		assert.equal(existsSync(join(directory, "logs")), false);
	} finally {
		removeTempDirectory(directory);
	}
});

test("removing a log removes its directory when nothing else is left, and tolerates what is already gone (#4327)", async () => {
	const directory = makeTempDirectory("process-log-");
	try {
		const logs = join(directory, "logs");
		mkdirSync(logs);
		writeFileSync(join(logs, "coordinator.log"), "x");
		writeFileSync(join(logs, "worker.log"), "kept");
		await removeProcessLog(join(logs, "coordinator.log"));
		assert.equal(existsSync(join(logs, "coordinator.log")), false);
		assert.equal(existsSync(join(logs, "worker.log")), true, "a directory with other logs stays");
		await removeProcessLog(join(logs, "worker.log"));
		assert.equal(existsSync(logs), false, "the emptied directory goes");
		await removeProcessLog(join(logs, "worker.log"));
	} finally {
		removeTempDirectory(directory);
	}
});

test.skipIf(!POSIX)("a log directory that cannot be removed as a directory is not swallowed (#4327)", async () => {
	const directory = makeTempDirectory("process-log-");
	try {
		mkdirSync(join(directory, "real"));
		symlinkSync(join(directory, "real"), join(directory, "linked"));
		await assert.rejects(removeProcessLog(join(directory, "linked", "worker.log")), (error: unknown) => {
			assert.equal((error as { code?: unknown }).code, "ENOTDIR");
			return true;
		});
	} finally {
		removeTempDirectory(directory);
	}
});

/** The paths this process holds open, as Linux lists them. */
function openPaths(): string[] {
	return readdirSync("/proc/self/fd").flatMap((fd) => {
		try {
			return [readlinkSync(join("/proc/self/fd", fd))];
		} catch {
			return [];
		}
	});
}

test.skipIf(process.platform !== "linux")("closing a log closes its file before it resolves (#4327)", async () => {
	const directory = makeTempDirectory("process-log-");
	try {
		const path = join(directory, "worker.log");
		const stderr = new PassThrough();
		const log = appendProcessLog(stderr, path, () => {});
		stderr.write("written\n");
		await vi.waitFor(() => assert.equal(readFileSync(path, "utf8"), "written\n"), { timeout: LOG_SETTLE_TIMEOUT_MS });
		assert.ok(openPaths().includes(path), "the log is open while its process runs");
		await log.close();
		assert.equal(openPaths().includes(path), false, "and closed once close resolves");
	} finally {
		removeTempDirectory(directory);
	}
});

test("a log directory another platform refuses to remove because it is not empty is left in place (#4327)", async () => {
	const directory = makeTempDirectory("process-log-");
	try {
		const logs = join(directory, "logs");
		mkdirSync(logs);
		writeFileSync(join(logs, "worker.log"), "x");
		writeFileSync(join(logs, "other.log"), "kept");
		vi.mocked(rmdir).mockRejectedValueOnce(Object.assign(new Error("directory not empty"), { code: "EEXIST" }));
		await removeProcessLog(join(logs, "worker.log"));
		assert.equal(existsSync(join(logs, "other.log")), true);
		assert.equal(vi.mocked(rmdir).mock.calls.length, 1);
		vi.mocked(rmdir).mockRejectedValueOnce(Object.assign(new Error("odd"), { code: "EBUSY" }));
		await assert.rejects(removeProcessLog(join(logs, "other.log")), (error: unknown) => {
			assert.equal((error as { code?: unknown }).code, "EBUSY");
			return true;
		});
	} finally {
		removeTempDirectory(directory);
	}
});
