import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import * as startTokens from "../src/core/process-start-token.ts";
import { buildLockPath, settleOtherBuilds, withBuildLocks } from "../src/core/resume/blueprint/build-lock.ts";
import { stepProcessWatcher } from "../src/core/resume/blueprint/process.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		renameSync: vi.fn(actual.renameSync),
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: vi.fn(actual.readFile),
	};
});

vi.mock("../src/core/process-start-token.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/process-start-token.ts")>();
	return {
		...actual,
		processStartToken: vi.fn(actual.processStartToken),
		processStartTokenAsync: vi.fn(actual.processStartTokenAsync),
	};
});

interface RecordedStep {
	readonly pid: number;
	readonly start?: string;
	readonly at?: number;
}

const PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;
const THIS_HOST = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
const windowsToken = (created: string) => createHash("sha256").update(`windows\n${created}`).digest("hex").slice(0, 12);

function sleeper(): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		detached: process.platform !== "win32",
		stdio: "ignore",
	});
	children.push(child);
	return child;
}

async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	return child.pid!;
}

function writeLock(lock: object): void {
	mkdirSync(join(dir, "blueprint-builds", "locks"), { recursive: true });
	writeFileSync(buildLockPath(dir, root()), JSON.stringify({ host: THIS_HOST, ...lock }));
}

let dir: string;
const children: ChildProcess[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-build-lock-start-"));
	vi.mocked(startTokens.processStartToken).mockClear();
	vi.mocked(startTokens.processStartTokenAsync).mockClear();
});
afterEach(() => {
	startTokens.setProcessCreationTimeQueryForTesting(undefined);
	startTokens.setNativeProcessCreationTimeForTesting(undefined);
	Object.defineProperty(process, "platform", PLATFORM);
	vi.unstubAllEnvs();
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
});

const root = () => join(dir, "worktrees", "repo-0");
const stepsOf = (): RecordedStep[] =>
	(JSON.parse(readFileSync(buildLockPath(dir, root()), "utf8")) as { steps: RecordedStep[] }).steps;

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 500 && !condition(); attempt++)
		await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(condition());
}

function watcher(): (pid: number, running: boolean) => void {
	const watch = stepProcessWatcher.getStore();
	assert.ok(watch);
	return watch;
}

describe("blueprint build lock step starts (#4748)", () => {
	test("records a step at once without reading its start synchronously, then adds the start once read", async () => {
		const step = sleeper();
		const expected = await startTokens.processStartTokenAsync(step.pid!);
		vi.mocked(startTokens.processStartTokenAsync).mockClear();
		await withBuildLocks(dir, [root()], async () => {
			watcher()(step.pid!, true);
			const [recorded] = stepsOf();
			assert.equal(recorded?.pid, step.pid, "the step is on disk before control returns to what spawned it");
			assert.equal(typeof recorded?.at, "number");
			assert.equal(vi.mocked(startTokens.processStartToken).mock.calls.length, 0);
			if (expected !== undefined) {
				await until(() => stepsOf()[0]?.start !== undefined);
				assert.equal(stepsOf()[0]?.start, expected);
			}
			watcher()(step.pid!, false);
		});
		assert.equal(existsSync(buildLockPath(dir, root())), false);
	});

	test("a step that ended before its start was read is not written back", async () => {
		const step = sleeper();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const actual = vi.mocked(startTokens.processStartTokenAsync).getMockImplementation()!;
		await withBuildLocks(dir, [root()], async () => {
			vi.mocked(startTokens.processStartTokenAsync).mockImplementationOnce(async (pid) => {
				await held;
				return actual(pid);
			});
			watcher()(step.pid!, true);
			watcher()(step.pid!, false);
			assert.deepEqual(stepsOf(), []);
			release();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(stepsOf(), [], "the ended step stays ended");
		});
	});

	test("a start read for an earlier step of a reused id does not overwrite the later step", async () => {
		const step = sleeper();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await withBuildLocks(dir, [root()], async () => {
			vi.mocked(startTokens.processStartTokenAsync)
				.mockImplementationOnce(async () => {
					await held;
					return "earlier-step";
				})
				.mockImplementationOnce(async () => "later-step");
			watcher()(step.pid!, true);
			watcher()(step.pid!, false);
			watcher()(step.pid!, true);
			await until(() => stepsOf()[0]?.start === "later-step");
			release();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(
				stepsOf().map((recorded) => recorded.start),
				["later-step"],
			);
			watcher()(step.pid!, false);
		});
	});

	test("without the native module, a new step reusing a cached pid reads a fresh start instead of stale negative or positive cache (#5315)", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		if (PLATFORM.value !== "win32") vi.stubEnv("SystemRoot", tmpdir());
		const step = sleeper();
		let stepCreated: string | undefined;
		startTokens.setNativeProcessCreationTimeForTesting(null);
		startTokens.setProcessCreationTimeQueryForTesting({
			file: process.execPath,
			args: (pid) => {
				if (pid === process.pid) return ["-e", 'console.log("132000000000000001")'];
				return stepCreated === undefined ? ["-e", ""] : ["-e", `console.log("${stepCreated}")`];
			},
		});
		// Prime a stale negative cache entry for step.pid (as settling a dead pid does).
		assert.equal(await startTokens.processStartTokenAsync(step.pid!), undefined);

		stepCreated = "132000000000000010";
		await withBuildLocks(dir, [root()], async () => {
			watcher()(step.pid!, true);
			await until(() => stepsOf()[0]?.start !== undefined);
			assert.equal(
				stepsOf()[0]?.start,
				windowsToken("132000000000000010"),
				"bypasses stale negative cache for the newly started step",
			);
			watcher()(step.pid!, false);

			// Now fallbackReads holds a positive entry for step.pid from the ended step: a new step reusing that pid
			// must record its own fresh start rather than the ended step's cached start.
			stepCreated = "132000000000000020";
			watcher()(step.pid!, true);
			await until(() => stepsOf()[0]?.start !== undefined);
			assert.equal(
				stepsOf()[0]?.start,
				windowsToken("132000000000000020"),
				"bypasses stale positive cache for a later step reusing the same pid",
			);
			watcher()(step.pid!, false);
		});
	});

	test("on Windows, a transient start-read failure for a running step or build holder is retried, and cancelled when the build settles (#5315)", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		if (PLATFORM.value !== "win32") vi.stubEnv("SystemRoot", tmpdir());
		const step = sleeper();
		let ownCalls = 0;
		let stepCalls = 0;
		startTokens.setNativeProcessCreationTimeForTesting(null);
		startTokens.setProcessCreationTimeQueryForTesting({
			file: process.execPath,
			args: (pid) => {
				if (pid === process.pid) {
					ownCalls++;
					return ownCalls === 1 ? ["-e", "process.exitCode = 1"] : ["-e", 'console.log("132000000000000031")'];
				}
				stepCalls++;
				return stepCalls === 1 ? ["-e", "process.exitCode = 1"] : ["-e", 'console.log("132000000000000032")'];
			},
		});
		const lockFile = buildLockPath(dir, root());
		await withBuildLocks(dir, [root()], async () => {
			watcher()(step.pid!, true);
			await until(() => {
				const lock = JSON.parse(readFileSync(lockFile, "utf8")) as { start?: string; steps: RecordedStep[] };
				return lock.start !== undefined && lock.steps[0]?.start !== undefined;
			});
			const lock = JSON.parse(readFileSync(lockFile, "utf8")) as { start?: string; steps: RecordedStep[] };
			assert.equal(
				lock.start,
				windowsToken("132000000000000031"),
				"holder start backfilled after transient failure",
			);
			assert.equal(
				lock.steps[0]?.start,
				windowsToken("132000000000000032"),
				"step start recorded after transient failure",
			);
			watcher()(step.pid!, false);
		});
		assert.equal(existsSync(lockFile), false, "lock removed once settled");

		// A build that runs nothing never writes a lock even when holder retry completes; and a settled build cancels pending retries.
		let settledRetryCalls = 0;
		startTokens.setProcessCreationTimeQueryForTesting({
			file: process.execPath,
			args: () => {
				settledRetryCalls++;
				return settledRetryCalls === 1
					? ["-e", "process.exitCode = 1"]
					: ["-e", 'console.log("132000000000000033")'];
			},
		});
		await withBuildLocks(dir, [root()], async () => {
			watcher()(step.pid!, true);
			// Wait for the first failing attempt so a retry timer is armed, then settle immediately.
			await until(() => settledRetryCalls >= 2);
		});
		assert.equal(existsSync(lockFile), false);
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.equal(existsSync(lockFile), false, "cancelled retry never writes lock after build settled");
	});

	test("settling a dead build skips start queries for dead or startless pids and ends the stop wait as soon as the step exits (#5315)", async () => {
		const goneHolder = await deadPid();
		const goneStep = await deadPid();
		vi.mocked(startTokens.processStartTokenAsync).mockClear();
		writeLock({ pid: goneHolder, start: "aaaaaaaaaaaa", steps: [{ pid: goneStep, start: "bbbbbbbbbbbb" }] });
		const settledGone = await settleOtherBuilds(dir, [root()], { waitMs: 300 });
		await settledGone.release();
		assert.deepEqual(settledGone.warnings, []);
		assert.deepEqual(
			vi
				.mocked(startTokens.processStartTokenAsync)
				.mock.calls.filter(([pid]) => pid === goneHolder || pid === goneStep),
			[],
			"dead pids are ruled gone by liveness without querying start tokens",
		);

		// A live step that exited right after stopping must not spin for 50 polls even when a stale cached start token
		// would still return its old start.
		const orphan = sleeper();
		const orphanStart = (await startTokens.processStartTokenAsync(orphan.pid!)) ?? "cccccccccccc";
		const orphanExited = new Promise<void>((resolve) => orphan.once("exit", () => resolve()));
		let pollsAfterExit = 0;
		let exited = false;
		void orphanExited.then(() => {
			exited = true;
		});
		const actual = vi.mocked(startTokens.processStartTokenAsync).getMockImplementation()!;
		vi.mocked(startTokens.processStartTokenAsync).mockImplementation(async (pid, options) => {
			if (pid === orphan.pid) {
				if (exited) pollsAfterExit++;
				return orphanStart;
			}
			return actual(pid, options);
		});
		try {
			writeLock({ pid: goneHolder, start: "aaaaaaaaaaaa", steps: [{ pid: orphan.pid, start: orphanStart }] });
			const started = performance.now();
			const settled = await settleOtherBuilds(dir, [root()], { waitMs: 600 });
			await settled.release();
			await orphanExited;
			assert.deepEqual(settled.warnings, []);
			assert.equal(pollsAfterExit, 0, "no start-token query runs for a step that already exited");
			assert.ok(performance.now() - started < 3_000, "stopProven does not spin for the full 5 s cache TTL");
		} finally {
			vi.mocked(startTokens.processStartTokenAsync).mockImplementation(actual);
		}
	});

	test("without the native module, settling a dead build verifies fresh before stopping so a cached pid reused by an unrelated process is never stopped (#5315)", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		if (PLATFORM.value !== "win32") vi.stubEnv("SystemRoot", tmpdir());
		const goneHolder = await deadPid();
		const unrelated = sleeper();
		let currentCreated = "132000000000000050";
		startTokens.setNativeProcessCreationTimeForTesting(null);
		startTokens.setProcessCreationTimeQueryForTesting({
			file: process.execPath,
			args: () => ["-e", `console.log("${currentCreated}")`],
		});
		// Prime the fallback cache with the dead step's creation time.
		const oldStart = await startTokens.processStartTokenAsync(unrelated.pid!);
		assert.equal(oldStart, windowsToken("132000000000000050"));
		// Now the PID belongs to a newer unrelated process while the 5 s cache entry is still warm.
		currentCreated = "132000000000000060";
		writeLock({ pid: goneHolder, start: "aaaaaaaaaaaa", steps: [{ pid: unrelated.pid, start: oldStart }] });
		const started = performance.now();
		const settled = await settleOtherBuilds(dir, [root()], { waitMs: 600 });
		await settled.release();
		assert.deepEqual(settled.warnings, []);
		assert.equal(unrelated.exitCode, null, "unrelated process reusing cached pid is never stopped");
		assert.equal(unrelated.signalCode, null);
		assert.ok(performance.now() - started < 3_000, "does not enter stopProven wait for a reused pid");
	});

	test("on Windows, a transient EPERM while renaming the build lock retries and still persists the step start (#5315)", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		if (PLATFORM.value !== "win32") vi.stubEnv("SystemRoot", tmpdir());
		const step = sleeper();
		startTokens.setNativeProcessCreationTimeForTesting(null);
		startTokens.setProcessCreationTimeQueryForTesting({
			file: process.execPath,
			args: (pid) => ["-e", `console.log("${pid === process.pid ? "132000000000000081" : "132000000000000082"}")`],
		});
		const actualRename = vi.mocked(renameSync).getMockImplementation()!;
		let lockRenames = 0;
		const lockFile = buildLockPath(dir, root());
		vi.mocked(renameSync).mockImplementation((from, to) => {
			if (String(to) === lockFile && ++lockRenames === 2) {
				throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
			}
			return actualRename(from, to);
		});
		const told: string[] = [];
		try {
			await withBuildLocks(
				dir,
				[root()],
				async () => {
					watcher()(step.pid!, true);
					await until(() => stepsOf()[0]?.start !== undefined);
					assert.equal(stepsOf()[0]?.start, windowsToken("132000000000000082"));
					watcher()(step.pid!, false);
				},
				(message) => told.push(message),
			);
			assert.deepEqual(told, [], "transient Windows rename refusal did not drop the lock update or warn");
		} finally {
			vi.mocked(renameSync).mockImplementation(actualRename);
		}
	});

	test("on Windows, a transient EBUSY while reading a build lock retries and preserves the live lock, while persistent EBUSY settles as corrupt within the bound (#5315)", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		if (PLATFORM.value !== "win32") vi.stubEnv("SystemRoot", tmpdir());
		const holder = sleeper();
		startTokens.setNativeProcessCreationTimeForTesting(null);
		startTokens.setProcessCreationTimeQueryForTesting({
			file: process.execPath,
			args: () => ["-e", 'console.log("132000000000000091")'],
		});
		const lockFile = buildLockPath(dir, root());
		writeLock({ pid: holder.pid, start: windowsToken("132000000000000091"), steps: [] });
		const actualRead = vi.mocked(readFile).getMockImplementation()!;
		let transientCalls = 0;
		vi.mocked(readFile).mockImplementation(((path, options) => {
			if (String(path) === lockFile && ++transientCalls <= 2) {
				return Promise.reject(Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }));
			}
			return actualRead(path, options as never);
		}) as typeof readFile);
		try {
			const settled = await settleOtherBuilds(dir, [root()], { waitMs: 150 });
			await settled.release();
			assert.equal(settled.warnings.length, 1);
			assert.match(
				settled.warnings[0]!,
				/^Another process \(pid \d+\) still seemed to build /,
				"transient EBUSY recovered the live lock instead of reporting it corrupt",
			);
			assert.equal(existsSync(lockFile), true, "the live build's lock was not removed on transient EBUSY");
			assert.ok(transientCalls >= 3, "retried past the transient EBUSY reads");

			// Persistent EBUSY on Windows stops retrying at the bound and reports corrupt.
			let persistentCalls = 0;
			vi.mocked(readFile).mockImplementation(((path, options) => {
				if (String(path) === lockFile) {
					persistentCalls++;
					return Promise.reject(Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }));
				}
				return actualRead(path, options as never);
			}) as typeof readFile);
			const started = performance.now();
			const stuck = await settleOtherBuilds(dir, [root()], { waitMs: 300 });
			await stuck.release();
			assert.equal(stuck.warnings.length, 1);
			assert.match(stuck.warnings[0]!, /could not be read; building it anyway/);
			assert.equal(persistentCalls, 25, "bounded to 25 attempts on persistent Windows EBUSY");
			assert.ok(performance.now() - started < 3_000, "bounded retry finishes promptly");

			// Truly corrupt JSON and non-transient EISDIR on Windows do not retry at all.
			writeFileSync(lockFile, "{broken");
			let badJsonCalls = 0;
			vi.mocked(readFile).mockImplementation(((path, options) => {
				if (String(path) === lockFile) badJsonCalls++;
				return actualRead(path, options as never);
			}) as typeof readFile);
			const corrupt = await settleOtherBuilds(dir, [root()], { waitMs: 300 });
			await corrupt.release();
			assert.match(corrupt.warnings[0] ?? "", /could not be read/);
			assert.equal(badJsonCalls, 1, "truly corrupt JSON returns corrupt on the first read");

			mkdirSync(lockFile, { recursive: true });
			let eisdirCalls = 0;
			vi.mocked(readFile).mockImplementation(((path, options) => {
				if (String(path) === lockFile) {
					eisdirCalls++;
					return Promise.reject(
						Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" }),
					);
				}
				return actualRead(path, options as never);
			}) as typeof readFile);
			const dirLock = await settleOtherBuilds(dir, [root()], { waitMs: 300 });
			await dirLock.release();
			assert.match(dirLock.warnings[0] ?? "", /could not be read/);
			assert.equal(eisdirCalls, 1, "non-transient EISDIR returns corrupt on the first read");
			rmSync(lockFile, { recursive: true, force: true });

			// Aborting during Windows read retry rejects immediately and preserves the lock file.
			writeLock({ pid: holder.pid, start: windowsToken("132000000000000091"), steps: [] });
			const controller = new AbortController();
			let abortCalls = 0;
			vi.mocked(readFile).mockImplementation(((path, options) => {
				if (String(path) === lockFile) {
					if (++abortCalls === 1) controller.abort(new Error("aborted-read"));
					return Promise.reject(Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }));
				}
				return actualRead(path, options as never);
			}) as typeof readFile);
			await assert.rejects(settleOtherBuilds(dir, [root()], { signal: controller.signal }), /aborted-read/);
			assert.equal(abortCalls, 1);
			assert.equal(existsSync(lockFile), true, "aborted read retry leaves the lock file intact");
		} finally {
			vi.mocked(readFile).mockImplementation(actualRead);
		}
	});

	test("on POSIX, an unreadable lock returns corrupt immediately with no retry delay (#5315)", async () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		const lockFile = buildLockPath(dir, root());
		writeLock({ pid: process.pid + 1, steps: [] });
		const actualRead = vi.mocked(readFile).getMockImplementation()!;
		let posixCalls = 0;
		vi.mocked(readFile).mockImplementation(((path, options) => {
			if (String(path) === lockFile) {
				posixCalls++;
				return Promise.reject(Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }));
			}
			return actualRead(path, options as never);
		}) as typeof readFile);
		try {
			const settled = await settleOtherBuilds(dir, [root()], { waitMs: 300 });
			await settled.release();
			assert.match(settled.warnings[0] ?? "", /could not be read; building it anyway/);
			assert.equal(posixCalls, 1, "POSIX does not retry readFile on EBUSY");
		} finally {
			vi.mocked(readFile).mockImplementation(actualRead);
		}
	});
});
