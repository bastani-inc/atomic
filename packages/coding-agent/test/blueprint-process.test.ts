import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import {
	existsSync,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	copiesOutputToLog,
	LOG_TAIL_BYTES,
	type LoggedProcess,
	type LoggedProcessOptions,
	logTail,
	openStepLog,
	type ProcessExit,
	runLoggedProcess,
	startsProcessGroup,
} from "../src/core/resume/blueprint/process.ts";
import { getShellConfig } from "../src/utils/shell.ts";

const STEADY_TIMEOUT_MS = 60_000;
const PROCESS_START_WAIT_MS = 20_000;

let sandbox: string;
let logCount = 0;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "blueprint-process-")));
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(sandbox, { recursive: true, force: true });
});

const path = (...segments: string[]) => join(sandbox, ...segments);

function nodeProcess(script: string, overrides: Partial<LoggedProcess> = {}): LoggedProcess {
	return { command: process.execPath, args: ["-e", script], cwd: sandbox, env: { ...process.env }, ...overrides };
}

async function execute(
	run: LoggedProcess,
	options: LoggedProcessOptions = { timeoutMs: STEADY_TIMEOUT_MS },
): Promise<{ exit: ProcessExit; output: string }> {
	const log = await openStepLog(path(`step-${++logCount}.log`));
	try {
		const exit = await runLoggedProcess(run, log, options);
		return { exit, output: readFileSync(log.path, "utf8") };
	} finally {
		await log.close();
	}
}

async function waitFor(done: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + PROCESS_START_WAIT_MS;
	while (!done()) {
		assert.ok(Date.now() < deadline, `${what} never happened`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

describe("running a logged process (#4588)", () => {
	test("both output streams are appended to the log and the exit status is reported (#4588)", async () => {
		const before = Date.now();
		const { exit, output } = await execute(nodeProcess('console.log("out"); console.error("err"); process.exit(3)'));
		const after = Date.now();
		assert.equal(output, "out\nerr\n");
		assert.equal(exit.exitStatus, 3);
		assert.equal(exit.signal, null);
		assert.equal(exit.timedOut, false);
		assert.equal(exit.spawnError, undefined);
		assert.ok(exit.elapsedMs >= 0 && exit.elapsedMs <= after - before, `elapsed ${exit.elapsedMs} ms`);
	});

	test("the process gets exactly the given working directory and environment (#4588)", async () => {
		process.env.BLUEPRINT_PROCESS_LEAK = "leaked";
		try {
			mkdirSync(path("work"));
			const run = nodeProcess(
				"console.log(JSON.stringify([process.cwd(), process.env.GIVEN, process.env.BLUEPRINT_PROCESS_LEAK]))",
				{
					cwd: path("work"),
					env: { ...process.env, GIVEN: "kept", BLUEPRINT_PROCESS_LEAK: undefined },
				},
			);
			const { output } = await execute(run);
			assert.deepEqual(JSON.parse(output), [path("work"), "kept", null]);
		} finally {
			delete process.env.BLUEPRINT_PROCESS_LEAK;
		}
	});

	test("the text given as stdin reaches the process and is closed, and without any the process sees end of input (#4588)", async () => {
		const echo =
			'let data = ""; process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => console.log("got:" + data));';
		const given = await execute(nodeProcess(echo, { stdin: "hello\nworld" }));
		assert.equal(given.output, "got:hello\nworld\n");
		assert.equal(given.exit.exitStatus, 0);
		const none = await execute(nodeProcess(echo));
		assert.equal(none.output, "got:\n");
		assert.equal(none.exit.timedOut, false);
		assert.equal(none.exit.exitStatus, 0);
	});

	test("a process that outlives its timeout is stopped and reported as timed out (#4588)", async () => {
		const { exit } = await execute(nodeProcess("setInterval(() => {}, 1000)"), { timeoutMs: 300 });
		assert.equal(exit.timedOut, true);
		assert.equal(exit.spawnError, undefined);
		assert.ok(exit.elapsedMs >= 200, `elapsed ${exit.elapsedMs} ms`);
		assert.equal(exit.exitStatus === 0, false);
	});

	test("a command that cannot be started resolves with the spawn error instead of rejecting (#4588)", async () => {
		const { exit } = await execute(nodeProcess("", { command: path("missing-command") }));
		assert.equal((exit.spawnError as NodeJS.ErrnoException).code, "ENOENT");
		assert.equal(exit.exitStatus, null);
		assert.equal(exit.signal, null);
		assert.equal(exit.timedOut, false);
		assert.ok(exit.elapsedMs >= 0);
	});

	test("an already aborted signal rejects with its reason before anything starts (#4588)", async () => {
		const reason = new Error("cancelled early");
		const run = nodeProcess(`require("node:fs").writeFileSync(${JSON.stringify(path("started"))}, "")`);
		await assert.rejects(
			execute(run, { timeoutMs: STEADY_TIMEOUT_MS, signal: AbortSignal.abort(reason) }),
			(error: unknown) => error === reason,
		);
		assert.equal(existsSync(path("started")), false);
	});

	test("aborting while the process runs stops it and everything it started, and rejects with the reason (#4588)", async () => {
		const grandchild = "setInterval(() => {}, 1000)";
		const script = [
			'const { spawn } = require("node:child_process");',
			'const fs = require("node:fs");',
			`const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });`,
			`fs.writeFileSync(${JSON.stringify(path("grandchild.pid"))}, String(child.pid));`,
			"setInterval(() => {}, 1000);",
		].join("\n");
		const controller = new AbortController();
		const reason = new Error("resume cancelled");
		const pending = execute(nodeProcess(script), { timeoutMs: STEADY_TIMEOUT_MS, signal: controller.signal });
		await waitFor(
			() => existsSync(path("grandchild.pid")) && readFileSync(path("grandchild.pid"), "utf8") !== "",
			"the grandchild starting",
		);
		const grandchildPid = Number(readFileSync(path("grandchild.pid"), "utf8"));
		try {
			controller.abort(reason);
			await assert.rejects(pending, (error: unknown) => error === reason);
			await waitFor(() => !isAlive(grandchildPid), "the grandchild stopping");
		} finally {
			if (isAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
		}
	});

	test("an abort that arrives before the command's spawn error rejects instead of reporting the failure (#4588)", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled at once");
		const log = await openStepLog(path("step.log"));
		try {
			const pending = runLoggedProcess(nodeProcess("", { command: path("missing-command") }), log, {
				timeoutMs: STEADY_TIMEOUT_MS,
				signal: controller.signal,
			});
			controller.abort(reason);
			await assert.rejects(pending, (error: unknown) => error === reason);
		} finally {
			await log.close();
		}
	});

	test("the timeout timer and abort listener are released when the process exits (#4588)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const controller = new AbortController();
		const { exit } = await execute(nodeProcess("process.exit(0)"), {
			timeoutMs: 3 * 60 * 60_000,
			signal: controller.signal,
		});
		assert.equal(exit.exitStatus, 0);
		assert.equal(vi.getTimerCount(), 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});

	test("the timeout timer and abort listener are released as soon as the command is known not to start (#4588)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const controller = new AbortController();
		const log = await openStepLog(path("step.log"));
		try {
			const before = Date.now();
			const exit = await runLoggedProcess(nodeProcess("", { command: path("missing-command") }), log, {
				timeoutMs: 3 * 60 * 60_000,
				signal: controller.signal,
			});
			const after = Date.now();
			assert.ok(exit.spawnError !== undefined);
			assert.ok(exit.elapsedMs >= 0 && exit.elapsedMs <= after - before, `elapsed ${exit.elapsedMs} ms`);
			assert.equal(vi.getTimerCount(), 0);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		} finally {
			await log.close();
		}
	});

	test("the output of the shell a blueprint step runs in reaches the log, for echo to stdout and to stderr alike (#4588)", async () => {
		const { shell, args, commandTransport } = getShellConfig();
		const script = 'echo "to stdout"; echo "to stderr" >&2';
		const { exit, output } = await execute({
			command: shell,
			args: commandTransport === "stdin" ? args : [...args, script],
			cwd: sandbox,
			env: { ...process.env },
			...(commandTransport === "stdin" ? { stdin: script } : {}),
		});
		assert.equal(exit.exitStatus, 0, output);
		assert.deepEqual(output.split("\n").sort(), ["", "to stderr", "to stdout"]);
	});

	test("output copied into the log keeps both streams and the exit status, whatever platform runs it (#4588)", async () => {
		const real = process.platform;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			const { exit, output } = await execute(
				nodeProcess('process.stdout.write("out\\n", () => { console.error("err"); process.exitCode = 3; })'),
			);
			assert.equal(output, "out\nerr\n");
			assert.equal(exit.exitStatus, 3);
			assert.equal(exit.spawnError, undefined);
			assert.equal(exit.timedOut, false);
			const missing = await execute(nodeProcess("", { command: path("missing-command") }));
			assert.equal((missing.exit.spawnError as NodeJS.ErrnoException).code, "ENOENT");
			assert.equal(missing.exit.exitStatus, null);
		} finally {
			Object.defineProperty(process, "platform", { value: real });
		}
	});

	test("output that cannot be copied into the log rejects naming the log instead of being lost (#4588)", async () => {
		const real = process.platform;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			await assert.rejects(
				runLoggedProcess(
					nodeProcess('console.log("lost")'),
					{ fd: 999_999, path: path("unwritable.log") },
					{
						timeoutMs: STEADY_TIMEOUT_MS,
					},
				),
				(error: unknown) =>
					error instanceof Error &&
					error.message.includes(path("unwritable.log")) &&
					(error.cause as NodeJS.ErrnoException).code === "EBADF",
			);
		} finally {
			Object.defineProperty(process, "platform", { value: real });
		}
	});

	test("only Windows has the output of a process copied into the log instead of written to it by the process (#4588)", () => {
		assert.equal(copiesOutputToLog("win32"), true);
		for (const platform of ["linux", "darwin", "freebsd"] as const) assert.equal(copiesOutputToLog(platform), false);
	});

	test("only platforms other than Windows start the process as the leader of its own group (#4588)", () => {
		assert.equal(startsProcessGroup("win32"), false);
		for (const platform of ["linux", "darwin", "freebsd"] as const) assert.equal(startsProcessGroup(platform), true);
	});
});

describe("step logs (#4588)", () => {
	test("a log is created with its directories, appended to and closed on request (#4588)", async () => {
		const logPath = path("deep", "er", "step.log");
		const first = await openStepLog(logPath);
		assert.equal(first.path, logPath);
		await first.close();
		assert.throws(() => fstatSync(first.fd), { code: "EBADF" });
		writeFileSync(logPath, "kept\n");
		const second = await openStepLog(logPath);
		try {
			await runLoggedProcess(nodeProcess('console.log("added")'), second, { timeoutMs: STEADY_TIMEOUT_MS });
		} finally {
			await second.close();
		}
		assert.equal(readFileSync(logPath, "utf8"), "kept\nadded\n");
		if (process.platform !== "win32") assert.equal(statSync(logPath).mode & 0o777, 0o600);
	});

	test("the tail of a log is its last bytes, at most 4096 by default (#4588)", async () => {
		assert.equal(LOG_TAIL_BYTES, 4096);
		const content = `${"a".repeat(2000)}${"b".repeat(3000)}`;
		writeFileSync(path("long.log"), content);
		assert.equal(await logTail(path("long.log")), content.slice(content.length - 4096));
		assert.equal(await logTail(path("long.log"), 10), "b".repeat(10));
		writeFileSync(path("short.log"), "short\n");
		assert.equal(await logTail(path("short.log")), "short\n");
		assert.equal(await logTail(path("short.log"), 3), "rt\n");
	});

	test("the tail of a log that does not exist or cannot be read is empty, because the failure it belongs to is reported anyway (#4588)", async () => {
		assert.equal(await logTail(path("missing.log")), "");
		mkdirSync(path("directory"));
		assert.equal(await logTail(path("directory")), "");
	});
});
