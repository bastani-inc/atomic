import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { buildLockPath, settleOtherBuilds, withBuildLocks } from "../src/core/resume/blueprint/build-lock.ts";
import { runLoggedProcess } from "../src/core/resume/blueprint/process.ts";
import { processStartToken } from "../src/core/worktree-snapshot/pool.ts";

let dir: string;
const children: ChildProcess[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-build-lock-"));
});
afterEach(() => {
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

/** The id of a process that has ended. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await exited(child);
	return child.pid!;
}

/** How a lock names this machine: `sha12` of its host name. */
const THIS_HOST = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);

function writeLock(lock: object): void {
	mkdirSync(join(dir, "blueprint-builds", "locks"), { recursive: true });
	writeFileSync(buildLockPath(dir, root()), JSON.stringify({ host: THIS_HOST, ...lock }));
}

describe("blueprint build locks (#4748)", () => {
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
					`const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(t)},20)`,
				],
				cwd: dir,
				env: process.env,
			};
			const run = runLoggedProcess(waiting, { fd, path: log }, { timeoutMs: 30_000 });
			await new Promise((resolve) => setTimeout(resolve, 200));
			const lock = lockOf();
			seen.push({ pid: lock.pid, steps: lock.steps.map((step) => step.pid) });
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
			writeLock({ pid: await deadPid(), steps: [{ pid: orphan.pid, start: processStartToken(orphan.pid!) }] });
			assert.deepEqual(await settleOtherBuilds(dir, [root()]), []);
			await exited(orphan);
			assert.equal(existsSync(buildLockPath(dir, root())), false);
		},
	);

	test("a process that only has a recorded step's id, with no start to prove it is that step, is never stopped", async () => {
		const unrelated = sleeper();
		writeLock({ pid: await deadPid(), steps: [{ pid: unrelated.pid }] });
		const waits: string[] = [];
		const warnings = await settleOtherBuilds(dir, [root()], {
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

	test("a process with a recorded step's id but another start is never stopped", async () => {
		const later = sleeper();
		writeLock({ pid: await deadPid(), steps: [{ pid: later.pid, start: "000000000000" }] });
		await settleOtherBuilds(dir, [root()], { waitMs: 600 });
		assert.equal(later.exitCode, null);
		assert.equal(later.signalCode, null, "the later process given the id still runs");
	});

	test("a holder that cannot be proven gone is waited for only up to the bound, then the build goes on with a warning", async () => {
		const holder = sleeper();
		writeLock({ pid: holder.pid, steps: [] });
		const waits: string[] = [];
		const started = Date.now();
		const warnings = await Promise.race([
			settleOtherBuilds(dir, [root()], { waitMs: 600, onWait: (_root, message) => waits.push(message) }),
			new Promise<"wedged">((resolve) => setTimeout(() => resolve("wedged"), 10_000)),
		]);
		assert.notEqual(warnings, "wedged", "the wait is bounded");
		assert.ok(Date.now() - started >= 600);
		assert.equal((warnings as string[]).length, 1);
		assert.match((warnings as string[])[0]!, /still seemed to build .* building it anyway/);
		assert.equal(waits.length, 1);
		assert.match(waits[0]!, /^Waiting for another Atomic process's blueprint build of /);
		assert.equal(holder.signalCode, null, "the holder is not stopped");
	});

	test.skipIf(processStartToken(process.pid) === undefined)(
		"once the wait for a holder that cannot be proven gone ends, its steps proven to be that build's are stopped first",
		async () => {
			const holder = sleeper();
			const step = sleeper();
			writeLock({ pid: holder.pid, steps: [{ pid: step.pid, start: processStartToken(step.pid!) }] });
			const warnings = await settleOtherBuilds(dir, [root()], { waitMs: 300 });
			assert.match(warnings[0] ?? "", /building it anyway/);
			await exited(step);
			assert.equal(holder.signalCode, null, "the holder itself is not stopped");
		},
	);

	test("a build whose dead process recorded its steps without their start is reported, as they may still run", async () => {
		writeLock({ pid: await deadPid(), steps: [{ pid: await deadPid() }] });
		const warnings = await settleOtherBuilds(dir, [root()], { waitMs: 300 });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /was interrupted, and processes it started could not be identified/);
		assert.equal(existsSync(buildLockPath(dir, root())), false);
	});

	test("a build whose dead process recorded the start of each step it ran leaves nothing to report", async () => {
		writeLock({ pid: await deadPid(), steps: [{ pid: await deadPid(), start: "000000000000" }] });
		assert.deepEqual(await settleOtherBuilds(dir, [root()], { waitMs: 300 }), []);
	});

	test("a lock that cannot be read stops nothing and the build goes on with a warning", async () => {
		const bystander = sleeper();
		mkdirSync(join(dir, "blueprint-builds", "locks"), { recursive: true });
		writeFileSync(buildLockPath(dir, root()), `{"host":"${THIS_HOST}","pid":${bystander.pid},"steps":[{"pid":"x"`);
		const warnings = await settleOtherBuilds(dir, [root()], { waitMs: 600 });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /could not be read; building it anyway/);
		assert.equal(bystander.signalCode, null);
		assert.equal(existsSync(buildLockPath(dir, root())), false);
	});

	test("a build of another process that still runs is waited for, until it ends", async () => {
		const host = sleeper();
		writeLock({ pid: host.pid, steps: [] });
		let settled = false;
		const waiting = settleOtherBuilds(dir, [root()]).then(() => {
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
		const waiting = settleOtherBuilds(dir, [root()], { signal: controller.signal });
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
		await settleOtherBuilds(dir, [root()]);
		writeLock({ pid: process.pid, steps: [] });
		await settleOtherBuilds(dir, [root()]);
		assert.equal(existsSync(buildLockPath(dir, root())), true);
	});
});
