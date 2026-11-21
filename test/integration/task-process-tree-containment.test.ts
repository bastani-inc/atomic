import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { CommandIntent, OperationId, Result } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { type TaskLease, TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { isGone, type RecordedProcess, recordProcess, signalRecordedProcess } from "../helpers/recorded-process.js";
import { fileExists, readText, sleep } from "../helpers/runtime.js";

const posix = process.platform !== "win32";
const python = posix && spawnSync("python3", ["-c", ""]).status === 0;
/** Whether commands run in a cgroup of their own: on Linux, where this process's cgroup is writable by its user. */
const delegatedCgroup = (() => {
	if (process.platform !== "linux" || process.env.ATOMIC_TASK_CGROUP === "0") return false;
	try {
		const own = readFileSync("/proc/self/cgroup", "utf8").match(/^0::(.*)$/mu)?.[1];
		if (!own) return false;
		const base = join("/sys/fs/cgroup", own);
		accessSync(join(base, "cgroup.procs"), constants.W_OK);
		return readFileSync(join(base, "cgroup.subtree_control"), "utf8").trim() === "";
	} catch {
		return false;
	}
})();
function groupAlive(group: number) {
	try {
		process.kill(-group, 0);
		return true;
	} catch {
		return false;
	}
}

function value<T, E>(result: Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? "accepted" : JSON.stringify(result.error));
	return result.value;
}
function setup() {
	const supervisor = new TaskSupervisor();
	const scope = { kind: "session" as const, sessionId: crypto.randomUUID() };
	const host = supervisor.bindHostSession({
		scope,
		authorizeLaunch() {},
		createRunner() {
			throw new Error("Command must not dispatch an agent");
		},
	});
	return { supervisor, owner: value(supervisor.openTaskOwner(host, scope)) };
}
async function pidFrom(path: string, deadlineMs = 10_000): Promise<number> {
	const deadline = Date.now() + deadlineMs;
	while (!(await fileExists(path)) || (await readText(path)).trim() === "") {
		assert.ok(Date.now() < deadline, `no PID written to ${path}`);
		await sleep(10);
	}
	return Number((await readText(path)).trim());
}
/** Polls the task's cleanup until it settles to a final state, and returns it. */
async function finalCleanup(supervisor: TaskSupervisor, task: TaskLease): Promise<string> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const receipt = value(await supervisor.cancelTask(task, "user"));
		if (receipt.cleanup.kind === "reaped" || receipt.cleanup.kind === "failed") return receipt.cleanup.kind;
		assert.ok(Date.now() < deadline, `cleanup still ${receipt.cleanup.kind}`);
		await sleep(10);
	}
}

// Descendants that move to their own process group without starting a new session: GNU timeout calls setpgid, and so
// does job control (`set -m`). Each writes the PID of the descendant that left the command's process group.
const shapes = {
	"timeout wrapper": (pidFile: string) =>
		`timeout 300 sh -c 'echo $$ > "$1"; exec sleep 300' sh '${pidFile}' >/dev/null 2>&1`,
	"set -m job": (pidFile: string) =>
		`bash -c 'set -m; sleep 300 >/dev/null 2>&1 & echo $! > "$1"; wait' bash '${pidFile}'`,
} as const;
const ends = ["cancel", "execution-timeout", "owner-close"] as const;
const cases = Object.keys(shapes).flatMap((shape) => ends.map((end) => ({ shape: shape as keyof typeof shapes, end })));

test.runIf(posix).each(cases)(
	"a descendant in its own process group ends on $end of a $shape command, and cleanup is reaped only once it is gone (#5057)",
	async ({ shape, end }) => {
		const directory = await mkdtemp(join(tmpdir(), "task-tree-5057-"));
		const pidFile = join(directory, "pid");
		const { supervisor, owner } = setup();
		// #6125: recorded while it runs, so neither the assertions nor the cleanup take a later process given its pid
		// for it.
		let descendant: RecordedProcess | undefined;
		try {
			const intent: CommandIntent = {
				kind: "command",
				command: shapes[shape](pidFile),
				terminal: { kind: "pipe" },
				...(end === "execution-timeout" ? { executionTimeoutMs: 1500 } : {}),
			};
			const task = value(await supervisor.startCommandTask(owner, intent, "tree" as OperationId));
			descendant = await recordProcess(await pidFrom(pidFile));
			assert.equal(await isGone(descendant), false);
			let cleanup: string;
			if (end === "owner-close") {
				cleanup = value(await supervisor.closeTaskOwner(owner, "session-close")).tasks[0].cleanup.kind;
			} else {
				if (end === "execution-timeout") {
					const settled = value(await supervisor.waitForTask(task, 20_000));
					assert.ok(
						settled.kind === "settled" &&
							settled.result.kind === "cancelled" &&
							settled.result.cause === "execution-timeout",
						JSON.stringify(settled),
					);
				}
				cleanup = await finalCleanup(supervisor, task);
			}
			assert.equal(cleanup, "reaped");
			assert.equal(await isGone(descendant), true, "cleanup reported reaped while the descendant lives");
		} finally {
			if (descendant !== undefined) await signalRecordedProcess(descendant);
			await supervisor.closeTaskOwner(owner, "session-close");
			await rm(directory, { recursive: true, force: true });
		}
	},
	40_000,
);

test.runIf(posix)(
	"a timeout-wrapped descendant of a PTY command ends on its execution timeout (#5057)",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "task-tree-pty-5057-"));
		const pidFile = join(directory, "pid");
		const { supervisor, owner } = setup();
		// #6125: recorded while it runs, so neither the assertion nor the cleanup takes a later process for it.
		let descendant: RecordedProcess | undefined;
		try {
			const task = value(
				await supervisor.startCommandTask(
					owner,
					{
						kind: "command",
						command: `timeout 300 sh -c 'echo $$ > "$1"; exec sleep 300' sh '${pidFile}'`,
						terminal: { kind: "pty", columns: 80, rows: 24 },
						executionTimeoutMs: 1500,
					},
					"pty-tree" as OperationId,
				),
			);
			descendant = await recordProcess(await pidFrom(pidFile));
			const settled = value(await supervisor.waitForTask(task, 20_000));
			assert.equal(settled.kind, "settled");
			assert.equal(await finalCleanup(supervisor, task), "reaped");
			assert.equal(await isGone(descendant), true, "cleanup reported reaped while the descendant lives");
		} finally {
			if (descendant !== undefined) await signalRecordedProcess(descendant);
			await supervisor.closeTaskOwner(owner, "session-close");
			await rm(directory, { recursive: true, force: true });
		}
	},
	40_000,
);

const hostDeaths = (["pipe", "pty"] as const).flatMap((terminal) =>
	(["sigkill", "throw", "exit", "guardian-first"] as const).map((how) => ({ terminal, how })),
);
/** The guardian a host started to end its shells when it dies: its child running the guardian script. */
function guardianOf(host: number): number[] {
	return execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u))
		.filter((match) => match !== null && Number(match[2]) === host && match[3].includes("trap ''"))
		.map((match) => Number(match?.[1]));
}
test.runIf(posix).each(hostDeaths)(
	"a $terminal shell and its descendants end within their execution timeout when the host dies by $how (#5057)",
	async ({ terminal, how }) => {
		const directory = await mkdtemp(join(tmpdir(), "task-host-death-5057-"));
		const host = spawn(process.execPath, [resolve("test/fixtures/task-host-death.mjs"), directory, how, terminal], {
			stdio: "ignore",
		});
		const exited = new Promise<void>((done) => host.once("exit", () => done()));
		// #6125: recorded while they run, so neither the assertion nor the cleanup takes a later process for one of them.
		const processes: RecordedProcess[] = [];
		const running = async () => {
			const left: number[] = [];
			for (const recorded of processes) if (!(await isGone(recorded))) left.push(recorded.pid);
			return left;
		};
		try {
			const ready = await pidFrom(join(directory, "ready"), 15_000);
			processes.push(
				await recordProcess(await pidFrom(join(directory, "shell"))),
				await recordProcess(await pidFrom(join(directory, "inner"))),
			);
			if (how === "guardian-first") {
				// A command that kills every `sh` it can, as `pkill sh` would, takes the guardian down first.
				const [guardian] = guardianOf(host.pid ?? 0);
				assert.ok(guardian, "no guardian found");
				process.kill(guardian, "SIGKILL");
				// Well inside the 2 s execution timeout, which would otherwise end the shell while the host still lives.
				const deadline = Date.now() + 500;
				while (!guardianOf(host.pid ?? 0).some((pid) => pid !== guardian) && Date.now() < deadline) await sleep(10);
				assert.ok(
					guardianOf(host.pid ?? 0).some((pid) => pid !== guardian),
					"the host did not replace its guardian",
				);
			}
			if (how === "sigkill" || how === "guardian-first") host.kill("SIGKILL");
			await exited;
			// The command was started with a 2 s execution timeout before `ready`; allow a second for the kernel.
			const deadline = ready + 3000;
			while ((await running()).length > 0 && Date.now() < deadline) await sleep(20);
			assert.deepEqual(await running(), [], "processes outlived the host and their execution timeout");
		} finally {
			host.kill("SIGKILL");
			for (const recorded of processes) await signalRecordedProcess(recorded);
			await rm(directory, { recursive: true, force: true });
		}
	},
	30_000,
);

const hoppers = [
	{ name: "slow hopper", period: "0.01" },
	{ name: "fast hopper", period: "0.0005" },
];
test.runIf(python).each(hoppers)(
	"a $name that keeps forking a replacement in its own process group ends on cancel, and cleanup is reaped only once it is gone (#5057)",
	async ({ period }) => {
		const directory = await mkdtemp(join(tmpdir(), "task-hopper-5057-"));
		const { supervisor, owner } = setup();
		let group = 0;
		try {
			const task = value(
				await supervisor.startCommandTask(
					owner,
					{
						kind: "command",
						command: `python3 '${resolve("test/fixtures/task-hopper.py")}' '${directory}/hop' ${period} >/dev/null 2>&1 & sleep 300`,
						terminal: { kind: "pipe" },
					},
					"hopper" as OperationId,
				),
			);
			group = await pidFrom(join(directory, "hop.pgid"));
			assert.ok(groupAlive(group));
			const cleanup = await finalCleanup(supervisor, task);
			if (cleanup === "reaped")
				assert.equal(groupAlive(group), false, "cleanup reported reaped while the hopper lives");
			assert.equal(groupAlive(group), false, `the hopper outlived cleanup (${cleanup})`);
		} finally {
			if (group && groupAlive(group)) process.kill(-group, "SIGKILL");
			await supervisor.closeTaskOwner(owner, "session-close");
			await rm(directory, { recursive: true, force: true });
		}
	},
	40_000,
);

// Without a delegated cgroup the guardian finds members by scanning processes, which a hopper can outrun; see
// "Limits" in background-tasks.md.
test.runIf(python && delegatedCgroup)(
	"a hopper that keeps forking a replacement ends when the host dies by SIGKILL (#5057)",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "task-hopper-host-5057-"));
		const host = spawn(
			process.execPath,
			[resolve("test/fixtures/task-host-death.mjs"), directory, "sigkill", "pipe", "hopper"],
			{ stdio: "ignore" },
		);
		const exited = new Promise<void>((done) => host.once("exit", () => done()));
		let group = 0;
		try {
			await pidFrom(join(directory, "ready"), 15_000);
			group = await pidFrom(join(directory, "inner"));
			host.kill("SIGKILL");
			await exited;
			const deadline = Date.now() + 3000;
			while (groupAlive(group) && Date.now() < deadline) await sleep(20);
			assert.equal(groupAlive(group), false, "the hopper outlived the host");
		} finally {
			host.kill("SIGKILL");
			if (group && groupAlive(group)) process.kill(-group, "SIGKILL");
			await rm(directory, { recursive: true, force: true });
		}
	},
	30_000,
);
