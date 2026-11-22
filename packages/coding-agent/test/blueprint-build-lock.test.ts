import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	isGone,
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
} from "../../../test/helpers/recorded-process.js";
import { takeTakeoverMutex } from "../src/core/lock-takeover.js";
import {
	setNativeProcessCreationTimeForTesting,
	setProcessCreationTimeQueryForTesting,
} from "../src/core/process-start-token.js";
import { runBlueprintBuild } from "../src/core/resume/blueprint/build.ts";
import { buildLockPath, settleOtherBuilds, withBuildLocks } from "../src/core/resume/blueprint/build-lock.ts";
import { type ProcessExit, runLoggedProcess } from "../src/core/resume/blueprint/process.js";
import { processStartToken } from "../src/core/worktree-snapshot/pool.ts";
import { forThisHost } from "./helpers/blueprint-fixtures.ts";

// Process creation is real; execFile is only watched, to tell when a build lock lists this host's processes.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn(actual.execFile) };
});

/** How many times this host's processes were listed to find the orphans of a dead build's steps. */
const processScans = () =>
	vi
		.mocked(execFile)
		.mock.calls.filter(([, args]) => Array.isArray(args) && args.some((arg) => String(arg).includes("Win32_Process")))
		.length;

const POWERSHELL_READS_TIMEOUT_MS = 60_000;
const SLOW_QUERY_MS = 2_000;

let dir: string;
const children: ChildProcess[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-build-lock-"));
});
afterEach(() => {
	setProcessCreationTimeQueryForTesting(undefined);
	setNativeProcessCreationTimeForTesting(undefined);
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
});

const root = () => join(dir, "worktrees", "repo-0");
const lockOf = () =>
	JSON.parse(readFileSync(buildLockPath(dir, root()), "utf8")) as { pid: number; steps: { pid: number }[] };

/** A process that runs until it is stopped, in its own process group where that is how its tree is stopped. */
function sleeper(): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		detached: process.platform !== "win32",
		stdio: "ignore",
	});
	children.push(child);
	return child;
}

function exited(child: ChildProcess): Promise<void> {
	return child.exitCode !== null || child.signalCode !== null
		? Promise.resolve()
		: new Promise((resolve) => child.once("exit", () => resolve()));
}

/** A process that has ended, as a lock records it: its id, and its start where that is readable. */
async function deadProcess(): Promise<{ pid: number; start?: string }> {
	const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	const start = processStartToken(child.pid!);
	child.stdin!.end();
	await exited(child);
	return start === undefined ? { pid: child.pid! } : { pid: child.pid!, start };
}

/** How a lock names this machine: `sha12` of its host name. */
const THIS_HOST = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);

/** Settles other processes' builds of `roots` as a resume does, and lets them go at once: the warnings for the user. */
async function settle(roots: readonly string[], options?: Parameters<typeof settleOtherBuilds>[2]): Promise<string[]> {
	const settled = await settleOtherBuilds(dir, roots, options);
	await settled.release();
	return settled.warnings;
}

function writeLock(lock: object): void {
	mkdirSync(join(dir, "blueprint-builds", "locks"), { recursive: true });
	writeFileSync(buildLockPath(dir, root()), JSON.stringify({ host: THIS_HOST, ...lock }));
}

describe("blueprint build locks (#4748)", () => {
	test("a build that runs nothing writes no lock and says nothing, even where no lock can be written (#5379)", async () => {
		mkdirSync(join(dir, "blueprint-builds"), { recursive: true });
		writeFileSync(join(dir, "blueprint-builds", "locks"), "");
		const told: string[] = [];
		const built = await withBuildLocks(
			dir,
			[root()],
			async () => "nothing ran",
			(message) => told.push(message),
		);
		assert.equal(built, "nothing ran");
		assert.deepEqual(told, []);
	});

	test("a build writes its lock before it starts a step's process, also one that then cannot start (#5379)", async () => {
		mkdirSync(join(dir, "blueprint-builds"), { recursive: true });
		writeFileSync(join(dir, "blueprint-builds", "locks"), "");
		const told: string[] = [];
		const log = join(dir, "step.log");
		const fd = openSync(log, "a");
		const missing = { command: join(dir, "no-such-program"), args: [], cwd: dir, env: process.env };
		const exit = await withBuildLocks(
			dir,
			[root()],
			() => runLoggedProcess(missing, { fd, path: log }, { timeoutMs: 30_000 }),
			(message) => told.push(message),
		);
		closeSync(fd);
		assert.ok(exit.spawnError, "the step's process never started");
		assert.equal(told.length, 1, "the lock was written before the process was started");
	});

	test("a trusted blueprint with only knowledge runs nothing, so it writes no lock and says nothing (#5379)", async () => {
		mkdirSync(join(root(), ".atomic"), { recursive: true });
		writeFileSync(
			join(root(), ".atomic", "blueprint.yaml"),
			forThisHost("knowledge:\n  - name: test\n    contents: npm test\n"),
		);
		mkdirSync(join(dir, "blueprint-builds"), { recursive: true });
		writeFileSync(join(dir, "blueprint-builds", "locks"), "");
		mkdirSync(join(dir, "home"), { recursive: true });
		const told: string[] = [];
		const outcome = await withBuildLocks(
			dir,
			[root()],
			() =>
				runBlueprintBuild([{ root: root(), identity: "https://example.test/repo.git" }], {
					agentDir: join(dir, "agent"),
					storeDir: dir,
					trusted: () => true,
					homeDir: join(dir, "home"),
					environment: { PATH: process.env.PATH ?? "", HOME: join(dir, "home") },
				}),
			(message) => told.push(message),
		);
		assert.equal(outcome.status, "success");
		assert.deepEqual(told, []);
	});

	test("a build whose lock cannot be written goes on, and the user is told once that a kill could go unnoticed (#5379)", async () => {
		// A file where the locks' directory belongs: no lock can be written, also as root.
		mkdirSync(join(dir, "blueprint-builds"), { recursive: true });
		writeFileSync(join(dir, "blueprint-builds", "locks"), "");
		const told: string[] = [];
		const log = join(dir, "step.log");
		const fd = openSync(log, "a");
		const quick = { command: process.execPath, args: ["-e", ""], cwd: dir, env: process.env };
		const built = await withBuildLocks(
			dir,
			[root()],
			async () => {
				await runLoggedProcess(quick, { fd, path: log }, { timeoutMs: 30_000 });
				return "built";
			},
			(message) => told.push(message),
		);
		closeSync(fd);
		assert.equal(built, "built");
		assert.equal(told.length, 1, told.join("\n"));
		assert.match(told[0]!, /build lock of .* could not be written/);
		assert.ok(told[0]!.includes(root()));
	});

	test("a build records each step process while it runs, and removes its lock once it settled", async () => {
		const log = join(dir, "step.log");
		const fd = openSync(log, "a");
		const gate = join(dir, "gate");
		const seen: { pid: number; steps: number[] }[] = [];
		await withBuildLocks(dir, [root()], async () => {
			assert.equal(existsSync(buildLockPath(dir, root())), false, "nothing is written before a step starts");
			const quick = { command: process.execPath, args: ["-e", ""], cwd: dir, env: process.env };
			await runLoggedProcess(quick, { fd, path: log }, { timeoutMs: 30_000 });
			const waiting = {
				command: process.execPath,
				args: [
					"-e",
					'const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(t)},20)',
					gate,
				],
				cwd: dir,
				env: process.env,
			};
			const run = runLoggedProcess(waiting, { fd, path: log }, { timeoutMs: 30_000 });
			await new Promise((resolve) => setTimeout(resolve, 200));
			const lock = lockOf();
			seen.push({ pid: lock.pid, steps: lock.steps.map((step) => step.pid) });
			const [step] = lock.steps as { pid: number; start?: string; at?: number }[];
			assert.equal(
				step?.start,
				processStartToken(step!.pid),
				"a step records when it started, where that is readable",
			);
			assert.equal(typeof step?.at, "number", "and when this process saw it start");
			if (process.platform !== "win32") {
				assert.equal(statSync(buildLockPath(dir, root())).mode & 0o777, 0o600, "the lock is private");
			}
			assert.equal(
				(JSON.parse(readFileSync(buildLockPath(dir, root()), "utf8")) as { host: string }).host,
				THIS_HOST,
			);
			writeFileSync(gate, "");
			await run;
		});
		closeSync(fd);
		assert.equal(seen[0]!.pid, process.pid);
		assert.equal(seen[0]!.steps.length, 1, "the step that ended is no longer listed");
		assert.equal(existsSync(buildLockPath(dir, root())), false, "the lock is removed once the build settled");
	});

	test.skipIf(processStartToken(process.pid) === undefined)(
		"the step processes of a build whose process died are stopped when proven to be its steps, and its lock removed",
		async () => {
			const orphan = sleeper();
			writeLock({ ...(await deadProcess()), steps: [{ pid: orphan.pid, start: processStartToken(orphan.pid!) }] });
			assert.deepEqual(await settle([root()]), []);
			assert.throws(() => process.kill(orphan.pid!, 0), "the step had ended when the wait returned");
			await exited(orphan);
			assert.equal(existsSync(buildLockPath(dir, root())), false);
		},
	);

	test.skipIf(process.platform !== "win32")(
		"without the native module, a dead build's step proven by its start is stopped, and a build records its own and its steps' starts (#5315)",
		async () => {
			const orphan = sleeper();
			const orphanStart = processStartToken(orphan.pid!);
			const dead = await deadProcess();
			const own = processStartToken(process.pid);
			setNativeProcessCreationTimeForTesting(null);
			writeLock({ ...dead, steps: [{ pid: orphan.pid, start: orphanStart }] });
			assert.deepEqual(await settle([root()]), []);
			await exited(orphan);

			const log = join(dir, "step.log");
			const fd = openSync(log, "a");
			const gate = join(dir, "gate");
			const recorded = () => {
				try {
					return lockOf() as { start?: string; steps: { pid: number; start?: string }[] };
				} catch {
					return undefined;
				}
			};
			await withBuildLocks(dir, [root()], async () => {
				const waiting = {
					command: process.execPath,
					args: [
						"-e",
						'const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(t)},20)',
						gate,
					],
					cwd: dir,
					env: process.env,
				};
				const run = runLoggedProcess(waiting, { fd, path: log }, { timeoutMs: POWERSHELL_READS_TIMEOUT_MS });
				try {
					const deadline = Date.now() + 30_000;
					while (
						(recorded()?.start === undefined || recorded()?.steps[0]?.start === undefined) &&
						Date.now() < deadline
					) {
						await new Promise((resolve) => setTimeout(resolve, 20));
					}
					const lock = recorded();
					const step = lock?.steps[0];
					assert.equal(lock?.start, own, "the build names this process's start");
					assert.ok(step, "the running step is still listed in the lock");
					setNativeProcessCreationTimeForTesting(undefined);
					assert.equal(step.start, processStartToken(step.pid), "and its running step's");
				} finally {
					writeFileSync(gate, "");
					await run;
				}
			});
			closeSync(fd);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(process.platform !== "win32")(
		"without the native module, a step that ended before its start was read is not listed again (#5315)",
		async () => {
			setNativeProcessCreationTimeForTesting(null);
			setProcessCreationTimeQueryForTesting({
				file: process.execPath,
				args: () => ["-e", `setTimeout(() => console.log("132000000000000000"), ${SLOW_QUERY_MS})`],
			});
			const log = join(dir, "step.log");
			const fd = openSync(log, "a");
			const gate = join(dir, "gate");
			const recorded = () => {
				try {
					return lockOf() as { steps: { pid: number; start?: string }[] };
				} catch {
					return undefined;
				}
			};
			await withBuildLocks(dir, [root()], async () => {
				const quick = { command: process.execPath, args: ["-e", ""], cwd: dir, env: process.env };
				await runLoggedProcess(quick, { fd, path: log }, { timeoutMs: 30_000 });
				const waiting = {
					command: process.execPath,
					args: [
						"-e",
						'const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(t)},20)',
						gate,
					],
					cwd: dir,
					env: process.env,
				};
				const run = runLoggedProcess(waiting, { fd, path: log }, { timeoutMs: 30_000 });
				const deadline = Date.now() + 30_000;
				while (recorded()?.steps.some((step) => step.start !== undefined) !== true && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				await new Promise((resolve) => setTimeout(resolve, SLOW_QUERY_MS));
				assert.deepEqual(
					recorded()?.steps.map((step) => step.start !== undefined),
					[true],
					"only the running step is listed, with its start",
				);
				writeFileSync(gate, "");
				await run;
			});
			closeSync(fd);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(process.platform !== "win32")(
		"without the native module, a step's start read after its build settled never writes the build's lock again (#5315)",
		async () => {
			setNativeProcessCreationTimeForTesting(null);
			setProcessCreationTimeQueryForTesting({
				file: process.execPath,
				args: () => ["-e", `setTimeout(() => console.log("132000000000000000"), ${SLOW_QUERY_MS})`],
			});
			const log = join(dir, "step.log");
			const fd = openSync(log, "a");
			const gate = join(dir, "gate");
			const lock = buildLockPath(dir, root());
			let run: Promise<ProcessExit> | undefined;
			await withBuildLocks(dir, [root()], async () => {
				const waiting = {
					command: process.execPath,
					args: [
						"-e",
						'const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(t)},20)',
						gate,
					],
					cwd: dir,
					env: process.env,
				};
				run = runLoggedProcess(waiting, { fd, path: log }, { timeoutMs: 30_000 });
				const deadline = Date.now() + 30_000;
				while (!existsSync(lock) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
				assert.equal(existsSync(lock), true, "the running step is recorded");
			});
			try {
				assert.equal(existsSync(lock), false, "the settled build removed its lock");
				await new Promise((resolve) => setTimeout(resolve, 2 * SLOW_QUERY_MS));
				assert.equal(existsSync(lock), false, "the step's start, read since, wrote nothing");
			} finally {
				writeFileSync(gate, "");
				await run;
				closeSync(fd);
			}
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test("a process that only has a recorded step's id, with no start to prove it is that step, is never stopped", async () => {
		const unrelated = sleeper();
		writeLock({ ...(await deadProcess()), steps: [{ pid: unrelated.pid }] });
		const waits: string[] = [];
		const warnings = await settle([root()], {
			waitMs: 600,
			onWait: (_root, message) => waits.push(message),
		});
		assert.equal(unrelated.exitCode, null);
		assert.equal(unrelated.signalCode, null, "the unrelated process still runs");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /may still be running \(process \d+\).*not stopped/);
		assert.equal(waits.length, 1, "the wait is shown once");
		assert.equal(existsSync(buildLockPath(dir, root())), false);
	});

	test.skipIf(processStartToken(process.pid) === undefined)(
		"a dead build whose process id a later process was given is told apart by its recorded start, and not waited for",
		async () => {
			const { start } = await deadProcess();
			const later = sleeper();
			writeLock({ pid: later.pid, start, steps: [] });
			const waits: string[] = [];
			const warnings = await settle([root()], {
				waitMs: 600,
				onWait: (_root, message) => waits.push(message),
			});
			assert.deepEqual(warnings, []);
			assert.deepEqual(waits, []);
			assert.equal(later.signalCode, null, "the later process given the id still runs");
			assert.equal(existsSync(buildLockPath(dir, root())), false);
		},
	);

	test("a process with a recorded step's id but another start is never stopped", async () => {
		const later = sleeper();
		writeLock({ ...(await deadProcess()), steps: [{ pid: later.pid, start: "000000000000" }] });
		await settle([root()], { waitMs: 600 });
		assert.equal(later.exitCode, null);
		assert.equal(later.signalCode, null, "the later process given the id still runs");
	});

	test("a holder that cannot be proven gone is waited for only up to the bound, then the build goes on with a warning", async () => {
		const holder = sleeper();
		writeLock({ pid: holder.pid, steps: [] });
		const waits: string[] = [];
		const started = Date.now();
		const warnings = await Promise.race([
			settle([root()], { waitMs: 600, onWait: (_root, message) => waits.push(message) }),
			new Promise<"wedged">((resolve) => setTimeout(() => resolve("wedged"), 10_000)),
		]);
		assert.notEqual(warnings, "wedged", "the wait is bounded");
		assert.ok(Date.now() - started >= 600);
		assert.equal((warnings as string[]).length, 1);
		assert.match(
			(warnings as string[])[0]!,
			/^Another process \(pid \d+\) still seemed to build .* after 1 s; building it anyway\.$/,
		);
		assert.equal(waits.length, 1);
		assert.match(waits[0]!, /^Waiting for another Atomic process's blueprint build of /);
		assert.equal(holder.signalCode, null, "the holder is not stopped");
	});

	test("a build another process is settling or running is waited for only up to the bound, then goes on with a warning (#5193)", async () => {
		mkdirSync(join(dir, "blueprint-builds", "locks"), { recursive: true });
		// Another process settled the worktree's earlier builds and builds it, before its first step wrote its lock.
		const other = takeTakeoverMutex(buildLockPath(dir, root()), 0);
		assert.ok(other);
		try {
			const waits: string[] = [];
			const warnings = await settle([root()], { waitMs: 600, onWait: (_root, message) => waits.push(message) });
			assert.deepEqual(warnings, [`Another process still seemed to build ${root()} after 1 s; building it anyway.`]);
			assert.deepEqual(waits, [`Waiting for another Atomic process's blueprint build of ${root()} to end`]);
		} finally {
			other.release();
		}
	});

	test.skipIf(processStartToken(process.pid) === undefined)(
		"once the wait for a holder that cannot be proven gone ends, its steps proven to be that build's are stopped first",
		async () => {
			const holder = sleeper();
			const step = sleeper();
			writeLock({ pid: holder.pid, steps: [{ pid: step.pid, start: processStartToken(step.pid!) }] });
			const warnings = await settle([root()], { waitMs: 300 });
			assert.match(warnings[0] ?? "", /building it anyway/);
			await exited(step);
			assert.equal(holder.signalCode, null, "the holder itself is not stopped");
		},
	);

	test("a build whose dead process recorded its steps without their start is reported, as they may still run", async () => {
		writeLock({ ...(await deadProcess()), steps: [{ pid: (await deadProcess()).pid }] });
		const warnings = await settle([root()], { waitMs: 300 });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /was interrupted, and processes it started could not be identified/);
		assert.equal(existsSync(buildLockPath(dir, root())), false);
	});

	test("a build whose dead process recorded the start of each step it ran leaves nothing to report", async () => {
		writeLock({ ...(await deadProcess()), steps: [{ pid: (await deadProcess()).pid, start: "000000000000" }] });
		assert.deepEqual(await settle([root()], { waitMs: 300 }), []);
	});

	test("a lock that cannot be read stops nothing and the build goes on with a warning", async () => {
		const bystander = sleeper();
		mkdirSync(join(dir, "blueprint-builds", "locks"), { recursive: true });
		writeFileSync(buildLockPath(dir, root()), `{"host":"${THIS_HOST}","pid":${bystander.pid},"steps":[{"pid":"x"`);
		const warnings = await settle([root()], { waitMs: 600 });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /could not be read; building it anyway/);
		assert.equal(bystander.signalCode, null);
		assert.equal(existsSync(buildLockPath(dir, root())), false);
	});

	test("a build of another process that still runs is waited for, until it ends", async () => {
		const host = sleeper();
		writeLock({ pid: host.pid, steps: [] });
		let settled = false;
		const waiting = settle([root()]).then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(settled, false, "the other build is waited for");
		host.kill("SIGKILL");
		await waiting;
		assert.equal(existsSync(buildLockPath(dir, root())), false);
	});

	test("waiting for another process's build stops when the resume is aborted", async () => {
		const host = sleeper();
		writeLock({ pid: host.pid, steps: [] });
		const controller = new AbortController();
		const waiting = settle([root()], { signal: controller.signal });
		controller.abort(new Error("cancelled"));
		await assert.rejects(waiting, /cancelled/);
		assert.equal(existsSync(buildLockPath(dir, root())), true, "a live build's lock is kept");
	});

	test("a lock of another machine, or of this process, is not waited for", async () => {
		mkdirSync(join(dir, "blueprint-builds", "locks"), { recursive: true });
		writeFileSync(
			buildLockPath(dir, root()),
			JSON.stringify({ host: "another-host", pid: sleeper().pid, steps: [] }),
		);
		assert.deepEqual(await settle([root()]), []);
		writeLock({ pid: process.pid, steps: [] });
		assert.deepEqual(await settle([root()]), []);
		assert.equal(existsSync(buildLockPath(dir, root())), true);
	});

	for (const [what, content] of [
		["valid JSON that is not a lock", "null"],
		["a lock without its host", JSON.stringify({ pid: 1, steps: [] })],
		["a lock whose pid is no process id", JSON.stringify({ host: THIS_HOST, pid: 1.5, steps: [] })],
		["a lock whose start is not a string", JSON.stringify({ host: THIS_HOST, pid: 1, start: 7, steps: [] })],
		["a lock whose steps are not a list", JSON.stringify({ host: THIS_HOST, pid: 1, steps: {} })],
		["a lock with a malformed step", JSON.stringify({ host: THIS_HOST, pid: 1, steps: [{ pid: "1" }] })],
	] as const) {
		test(`${what} is a lock that cannot be read, reported once even for a worktree named twice`, async () => {
			mkdirSync(join(dir, "blueprint-builds", "locks"), { recursive: true });
			writeFileSync(buildLockPath(dir, root()), content);
			const warnings = await settle([root(), root()], { waitMs: 300 });
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /could not be read/);
		});
	}

	test("a lock path that cannot be read as a file is a lock that cannot be read", async () => {
		mkdirSync(buildLockPath(dir, root()), { recursive: true });
		const warnings = await settle([root()], { waitMs: 300 });
		assert.match(warnings[0] ?? "", /could not be read/);
	});

	test("several unproven steps are named in the warning, after the wait for an earlier build is shown", async () => {
		const first = sleeper();
		const second = sleeper();
		writeLock({ ...(await deadProcess()), steps: [{ pid: first.pid }, { pid: second.pid }] });
		const waits: string[] = [];
		const warnings = await settle([root()], {
			waitMs: 300,
			onWait: (_root, message) => waits.push(message),
		});
		assert.deepEqual(waits, [`Waiting for an earlier blueprint build of ${root()} to end`]);
		assert.match(warnings[0]!, new RegExp(`\\(process ${first.pid}, ${second.pid}\\)`));
	});

	test("a build leaves a lock another process wrote meanwhile in place", async () => {
		const fd = openSync(join(dir, "step.log"), "a");
		await withBuildLocks(dir, [root()], async () => {
			await runLoggedProcess(
				{ command: process.execPath, args: ["-e", ""], cwd: dir, env: process.env },
				{ fd, path: join(dir, "step.log") },
				{ timeoutMs: 30_000 },
			);
			writeLock({ pid: 1, steps: [] });
		});
		closeSync(fd);
		assert.equal(existsSync(buildLockPath(dir, root())), true);
	});

	/**
	 * On Windows, keeps process `pid`'s id from any later process until the returned function is called, by holding a
	 * handle to the process: Windows gives an ended process's id to another process only once no handle to it is open,
	 * and Node closes its own as the process exits.
	 */
	async function keepProcessId(pid: number): Promise<() => Promise<void>> {
		const holder = spawn(
			join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$ErrorActionPreference = 'Stop'; $p = [System.Diagnostics.Process]::GetProcessById(${pid}); $null = $p.Handle; [Console]::Out.WriteLine('held'); $null = [Console]::In.ReadLine()`,
			],
			{ stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
		);
		children.push(holder);
		await new Promise<void>((resolve, reject) => {
			holder.stdout!.once("data", () => resolve());
			holder.once("exit", (code) => reject(new Error(`no handle to process ${pid} could be held (exit ${code})`)));
		});
		return async () => {
			holder.stdin!.end();
			await exited(holder);
		};
	}

	/**
	 * A step process that started a child and then ended, as Git for Windows' `bash.exe` does when its host is killed:
	 * the child keeps the ended step's id as its parent. Resolves the step as a lock records it, and the orphaned child.
	 * With `keepId`, no later process is given the step's id until `releaseId` resolves.
	 */
	async function stepThatLeftAnOrphan(keepId = false): Promise<{
		step: { pid: number; start?: string; at: number };
		orphan: RecordedProcess;
		releaseId: () => Promise<void>;
	}> {
		const at = Date.now();
		const step = spawn(
			process.execPath,
			[
				"-e",
				"const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});c.unref();console.log(c.pid);process.stdin.once('data',()=>process.exit(0))",
			],
			{ stdio: ["pipe", "pipe", "ignore"] },
		);
		// #6125: recorded while it runs, so neither the assertions nor the cleanups take a later process given its pid
		// for it.
		const orphan = await recordProcess(
			await new Promise<number>((resolve) =>
				step.stdout!.once("data", (data) => resolve(Number(String(data).trim()))),
			),
		);
		const recorded = { pid: step.pid!, start: processStartToken(step.pid!), at };
		const releaseId = keepId ? await keepProcessId(step.pid!) : async () => {};
		step.stdin!.write("\n");
		await exited(step);
		return { step: recorded, orphan, releaseId };
	}

	test.skipIf(process.platform !== "win32" || processStartToken(process.pid) === undefined)(
		"on Windows, the orphaned child of a dead build's ended step is stopped before the next build, and nothing else",
		async () => {
			const { step, orphan } = await stepThatLeftAnOrphan();
			const bystander = sleeper();
			try {
				assert.equal(await stillRuns(orphan), true, "the step's child outlived it");
				writeLock({ ...(await deadProcess()), steps: [step] });
				assert.deepEqual(await settle([root()]), []);
				assert.equal(await isGone(orphan), true, "the orphan had ended when the wait returned");
				assert.equal(bystander.exitCode, null, "a process that is no child of the step still runs");
			} finally {
				await signalRecordedProcess(orphan);
			}
		},
	);

	test.skipIf(process.platform !== "win32")(
		"on Windows, the orphaned child of a step recorded without its start is never stopped, and the build is reported",
		async () => {
			// The step's id is kept from later processes: with no start recorded, a later process given it could not be
			// told from the step, and the build would rightly be reported as one that may still run (#5274).
			const { step, orphan, releaseId } = await stepThatLeftAnOrphan(true);
			try {
				writeLock({ ...(await deadProcess()), steps: [{ pid: step.pid, at: step.at }] });
				const warnings = await settle([root()], { waitMs: 300 });
				assert.match(warnings[0] ?? "", /could not be identified/);
				assert.equal(await stillRuns(orphan), true, "an orphan of an unproven step still runs");
			} finally {
				await releaseId();
				await signalRecordedProcess(orphan);
			}
		},
	);

	test.skipIf(process.platform !== "win32")(
		"on Windows, this host's processes are listed for a dead build's orphans only when one of its steps recorded its start",
		async () => {
			const before = processScans();
			writeLock({ ...(await deadProcess()), steps: [{ pid: (await deadProcess()).pid, at: Date.now() }] });
			await settle([root()], { waitMs: 300 });
			writeLock({ ...(await deadProcess()), steps: [] });
			await settle([root()], { waitMs: 300 });
			assert.equal(processScans() - before, 0, "no step could be followed, so nothing was listed");
			const step = { pid: (await deadProcess()).pid, start: "000000000000", at: Date.now() };
			writeLock({ ...(await deadProcess()), steps: [step] });
			await settle([root()], { waitMs: 300 });
			assert.equal(processScans() - before, 1, "a step that recorded its start is followed");
		},
	);

	test.skipIf(process.platform !== "win32" || processStartToken(process.pid) === undefined)(
		"on Windows, a child started more than a second before the step was recorded is no orphan of it",
		async () => {
			const { step, orphan } = await stepThatLeftAnOrphan();
			try {
				writeLock({ ...(await deadProcess()), steps: [{ ...step, at: step.at + 60_000 }] });
				await settle([root()], { waitMs: 300 });
				assert.equal(await stillRuns(orphan), true);
			} finally {
				await signalRecordedProcess(orphan);
			}
		},
	);
});
