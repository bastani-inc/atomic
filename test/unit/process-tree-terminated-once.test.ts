import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

/**
 * Every process tree a caller contains is recorded on its own: what was done to it, in order. Terminating the job ends
 * every process in it on Windows; `endsOnTerminate` says whether this fake does that too, by killing the contained root.
 * `available` false stands for a tree Windows could not put in a job, which leaves only the kill by pid.
 */
const containment = vi.hoisted(() => ({
	enabled: false,
	available: true,
	endsOnTerminate: true,
	trees: [] as { pid: number; events: string[] }[],
}));

vi.mock("../../packages/coding-agent/src/core/process-tree-containment.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../packages/coding-agent/src/core/process-tree-containment.ts")>();
	return {
		...actual,
		containProcessTree: (pid: number) => {
			if (!containment.enabled) return actual.containProcessTree(pid);
			if (!containment.available) return undefined;
			const tree = { pid, events: ["contain"] };
			containment.trees.push(tree);
			return {
				terminate: () => {
					tree.events.push("terminate");
					if (containment.endsOnTerminate) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {}
					}
					return true;
				},
				activeProcesses: () => 0,
				release: () => {
					tree.events.push("release");
					return true;
				},
				close: () => {
					tree.events.push("close");
				},
			};
		},
	};
});

import { resolveConfigValueUncachedAsync } from "../../packages/coding-agent/src/core/resolve-config-value.js";
import {
	openStepLog,
	runLoggedProcess,
	stepProcessWatcher,
} from "../../packages/coding-agent/src/core/resume/blueprint/process.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	type WorktreeSetup,
} from "../../packages/subagents/src/runs/shared/worktree.js";
import { type RecordedProcess, recordProcess, signalRecordedProcess } from "../helpers/recorded-process.js";

const PROCESS_START_WAIT_MS = 20_000;

afterEach(() => {
	vi.useRealTimers();
	containment.enabled = false;
	containment.available = true;
	containment.endsOnTerminate = true;
	containment.trees = [];
});

function terminatedTrees(): { pid: number; events: string[] }[] {
	return containment.trees.filter((tree) => tree.events.includes("terminate"));
}

async function waitForTermination(): Promise<{ pid: number; events: string[] }> {
	const deadline = Date.now() + PROCESS_START_WAIT_MS;
	while (terminatedTrees().length === 0) {
		assert.ok(Date.now() < deadline, "no process tree was terminated");
		await realSleep(10);
	}
	return terminatedTrees()[0]!;
}

/** #6125: the process the fake job was asked to end, recorded while it runs (the fake ends nothing). */
async function terminatedProcess(): Promise<RecordedProcess> {
	return recordProcess((await waitForTermination()).pid);
}

// The command goes through the configured POSIX shell, which `exec` replaces, so the contained root is the command.
test.skipIf(process.platform === "win32")(
	"a config value command stopped for its output size has its process tree terminated once, also when its exit follows (#5601)",
	async () => {
		containment.enabled = true;
		const value = await resolveConfigValueUncachedAsync(
			`!exec node -e 'process.stdout.write("x".repeat(1100000)); setTimeout(() => {}, 30000)'`,
		);
		assert.equal(value, undefined);
		assert.deepEqual(
			terminatedTrees().map((tree) => tree.events),
			[["contain", "terminate", "close"]],
		);
	},
);

test("a blueprint step stopped by its timeout and then aborted has its process tree terminated once (#5601)", async () => {
	containment.enabled = true;
	// The fake job ends nothing here, so the abort still finds the step running after the timeout terminated it.
	containment.endsOnTerminate = false;
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "process-tree-once-step-")));
	const log = await openStepLog(join(directory, "step.log"));
	let root: RecordedProcess | undefined;
	try {
		const controller = new AbortController();
		const reason = new Error("resume cancelled");
		const pending = runLoggedProcess(
			{ command: process.execPath, args: ["-e", "setTimeout(() => {}, 60_000)"], cwd: directory, env: process.env },
			log,
			{ timeoutMs: 100, signal: controller.signal },
		);
		root = await terminatedProcess();
		controller.abort(reason);
		await signalRecordedProcess(root);
		await assert.rejects(pending, (error: unknown) => error === reason);
		assert.deepEqual(
			terminatedTrees().map((tree) => tree.events),
			[["contain", "terminate", "close"]],
		);
	} finally {
		if (root !== undefined) await signalRecordedProcess(root);
		await log.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

// A setup hook runs as an executable script with a shebang, which Windows cannot spawn.
test.skipIf(process.platform === "win32")(
	"a worktree setup hook stopped for its output size and then reached by its timeout has its process tree terminated once (#5601)",
	async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "process-tree-once-hook-")));
		const repo = join(root, "repo");
		mkdirSync(repo);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		git("init", "-b", "main");
		git("config", "user.name", "Atomic Test");
		git("config", "user.email", "atomic@example.com");
		writeFileSync(join(repo, "tracked.txt"), "tracked\n");
		git("add", ".");
		git("commit", "--no-gpg-sign", "-m", "initial");
		const hook = join(root, "loud-hook.sh");
		// One byte past the hook output limit, then a wait that outlives the test's own control of the timeout.
		writeFileSync(hook, "#!/bin/sh\nhead -c 67108865 /dev/zero\nexec sleep 60\n");
		chmodSync(hook, 0o755);
		let setup: WorktreeSetup | undefined;
		let hookProcess: RecordedProcess | undefined;
		containment.enabled = true;
		// The fake job ends nothing here, so the hook still runs when its timeout comes.
		containment.endsOnTerminate = false;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const creating = createWorktrees(repo, "hook/overflow", 1, {
				setupHook: { hookPath: hook, timeoutMs: 30_000 },
			});
			creating.then(
				(created) => {
					setup = created;
				},
				() => {},
			);
			hookProcess = await terminatedProcess();
			await vi.advanceTimersByTimeAsync(30_000);
			vi.useRealTimers();
			await signalRecordedProcess(hookProcess);
			await assert.rejects(creating, /ENOBUFS/);
			assert.deepEqual(
				terminatedTrees().map((tree) => tree.events),
				[["contain", "terminate", "close"]],
			);
		} finally {
			vi.useRealTimers();
			if (hookProcess !== undefined) await signalRecordedProcess(hookProcess);
			if (setup) await cleanupWorktrees(setup);
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform !== "win32")(
	"aborting a missing blueprint command does not warn about surviving descendants (#5664)",
	async () => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "process-tree-missing-step-")));
		const log = await openStepLog(join(directory, "step.log"));
		const warning = vi.spyOn(process, "emitWarning");
		try {
			const controller = new AbortController();
			const reason = new Error("resume cancelled");
			const pids: number[] = [];
			const pending = stepProcessWatcher.run(
				(pid) => pids.push(pid),
				() =>
					runLoggedProcess(
						{ command: join(directory, "missing.exe"), args: [], cwd: directory, env: process.env },
						log,
						{ timeoutMs: PROCESS_START_WAIT_MS, signal: controller.signal },
					),
			);
			// Node delivers the spawn error before this tick, but its promise handler has not settled the step yet.
			process.nextTick(() => controller.abort(reason));
			await assert.rejects(pending, (error: unknown) => error === reason);
			assert.deepEqual(pids, []);
			const descendantsWarnings = warning.mock.calls.filter(([message]) =>
				/descendants may still be running/i.test(String(message)),
			);
			assert.deepEqual(descendantsWarnings, []);
		} finally {
			warning.mockRestore();
			await log.close();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

// Only Windows copies a step's output through pipes, which a process the step started can hold after the step's command
// exits; once that exit is reported, the command's pid may name another process.
test.skipIf(process.platform !== "win32")(
	"a blueprint step aborted after its command exited, while a process it started still writes its output, warns that descendants may still be running without killing by the command's pid (#5601, #5664)",
	async () => {
		containment.enabled = true;
		containment.available = false;
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "process-tree-once-exited-step-")));
		const log = await openStepLog(join(directory, "step.log"));
		const warning = vi.spyOn(process, "emitWarning");
		const writer = [
			"process.stdout.on('error', () => {});",
			"setInterval(() => { if (!require('node:fs').existsSync(process.argv[1])) process.exit(0); process.stdout.write('x'); }, 20);",
			"setTimeout(() => process.exit(0), 30_000);",
		].join("\n");
		const command = [
			`const writer = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(writer)}, process.cwd()], { cwd: require("node:os").tmpdir(), stdio: "inherit", detached: true, windowsHide: true });`,
			'require("node:fs").writeFileSync("writer.pid", String(writer.pid)); writer.unref();',
			// The writer is writing before the command exits, so the step's output stays open past that exit.
			"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);",
		].join("\n");
		try {
			const controller = new AbortController();
			const reason = new Error("resume cancelled");
			const pending = runLoggedProcess(
				{ command: process.execPath, args: ["-e", command], cwd: directory, env: process.env },
				log,
				{ timeoutMs: 60_000, signal: controller.signal },
			);
			const started = () =>
				vi.mocked(spawn).mock.results[vi.mocked(spawn).mock.calls.findIndex(([, args]) => args?.[1] === command)]
					?.value as ChildProcess | undefined;
			const deadline = Date.now() + PROCESS_START_WAIT_MS;
			while (started() === undefined && Date.now() < deadline) await realSleep(10);
			const child = started();
			assert.ok(child?.pid, "the step's command was spawned");
			const commandPid = String(child.pid);
			if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
			const writerPid = Number(readFileSync(join(directory, "writer.pid"), "utf8"));
			process.kill(writerPid, 0);
			controller.abort(reason);
			await assert.rejects(pending, (error: unknown) => error === reason);
			const killsByPid = vi
				.mocked(spawn)
				.mock.calls.filter(([file, args]) => /taskkill/i.test(String(file)) && (args ?? []).includes(commandPid));
			assert.deepEqual(killsByPid, []);
			assert.equal(
				warning.mock.calls.filter(([message]) => /descendants may still be running/i.test(String(message))).length,
				1,
			);
		} finally {
			warning.mockRestore();
			// Removing the directory tells the detached fixture to exit, without ever signalling a recycled PID.
			await log.close();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
