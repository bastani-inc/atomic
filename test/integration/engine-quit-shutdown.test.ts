import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import {
	delayOf,
	type LogRecord,
	prepareAgentDir,
	prepareInstalledPackage,
	readRecords,
} from "../helpers/event-loop-guard-fixture.js";
import { type PtyExit, type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
	waitUntilGone,
} from "../helpers/recorded-process.js";
import { fileExistsSync, makeTempDirectory, moduleDir, readTextSync, sleep } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const CLI_TIMEOUT_MS = 90_000;
const RECORD_POLL_MS = 50;
/** How long the extension's shutdown handler works, as saving state or stopping a server does. */
const HANDLER_WORK_MS = 200;
/** A handler that works longer than any test here waits. */
const ENDLESS_HANDLER_WORK_MS = 10 * CLI_TIMEOUT_MS;
/** Longer than a killed process takes to be gone, however loaded the machine. */
const GROUP_CHILD_GONE_MS = 5_000;
/** The interactive engine's shutdown grace period, which a repeated signal does not wait for. */
const ENGINE_SHUTDOWN_GRACE_MS = 5_000;
/**
 * How long a session whose handler never finishes may take to end: the grace period, with room for a loaded machine.
 * Far shorter than the minute a session's close waits for a handler without that bound.
 */
const BOUNDED_SHUTDOWN_MS = 6 * ENGINE_SHUTDOWN_GRACE_MS;
/**
 * The quit's own work after the grace period on a loaded runner: ending what the session started, then the exit. The
 * quit is measured from the start of the host's shutdown phase, by its own clock, so a runner too starved to read the
 * typed `/quit` for a while does not count against it.
 */
const QUIT_EXIT_HEADROOM_MS = 3 * ENGINE_SHUTDOWN_GRACE_MS;
/**
 * Evidence that a run was starved: the host's event loop held for this long at once. A starved engine can take longer
 * than its grace period to exit after its handlers finished, and the host then ends it, as it should, before it writes
 * the record it writes as it exits.
 */
const STARVED_HOST_BLOCK_MS = 2_000;

/** How long a Windows test's processes run when nothing ends them: bounded, well past any test. */
const WINDOWS_FIXTURE_SECONDS = 120;

/**
 * The extension every session here loads. Its source never changes: it reads what to do, and the files to record
 * into, from `fixture.json` beside it.
 */
const SHUTDOWN_EXTENSION = `import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixture.json"), "utf8"));
export default (pi) => {
	pi.on("session_start", () => {
		if (fixture.groupChild) {
			// A process the extension starts in the engine's process group, neither detached nor stopped at shutdown.
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			child.unref();
			writeFileSync(fixture.files.groupChild, String(child.pid));
		}
		if (fixture.execGrandchild) {
			const command = 'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(process.argv[1] + ".root", String(process.pid)); require("node:fs").writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 1000);';
			const run = () => void pi.exec(process.execPath, ["-e", command, fixture.files.execChild], fixture.execTimeoutMs === undefined ? {} : { timeout: fixture.execTimeoutMs });
			// A command with a timeout starts once the test watches for it, so the timeout cannot pass before its pid is read.
			if (fixture.execTimeoutMs === undefined) run();
			else {
				const go = setInterval(() => {
					if (!existsSync(fixture.files.execGo)) return;
					clearInterval(go);
					run();
				}, fixture.pollMs);
			}
		}
		if (fixture.execLeftoverTree) {
			// PowerShell starts a program that Node did not start, in no job of Node's, and then the command ends.
			const file = fixture.files.execChild.replace(/'/g, "''");
			const script = "$p = Start-Process -WindowStyle Hidden ping -ArgumentList '-n','" + fixture.fixtureSeconds + "','127.0.0.1' -PassThru; Set-Content -NoNewline -Path '" + file + "' -Value $p.Id";
			void pi.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]).then(() => writeFileSync(fixture.files.execChild + ".done", ""));
		}
		if (fixture.execLeftover) {
			const command = 'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref(); require("node:fs").writeFileSync(process.argv[1], String(child.pid));';
			void pi.exec(process.execPath, ["-e", command, fixture.files.execChild]);
		}
		writeFileSync(fixture.files.started, String(process.pid));
	});
	pi.on("session_shutdown", async (event) => {
		const call = { pid: process.pid, reason: event.reason, fromSignal: event.fromSignal };
		appendFileSync(fixture.files.shutdown, JSON.stringify({ ...call, finished: false }) + "\\n");
		if (fixture.waitForRelease) {
			while (!existsSync(fixture.files.released)) await new Promise((resolve) => setTimeout(resolve, fixture.pollMs));
		} else await new Promise((resolve) => setTimeout(resolve, fixture.handlerWorkMs));
		appendFileSync(fixture.files.shutdown, JSON.stringify({ ...call, finished: true }) + "\\n");
	});
};`;

/**
 * The text of `file`, or "" while it is missing or its writer still holds it open: Windows refuses to open a file for
 * reading with EBUSY while PowerShell's Set-Content writes it.
 */
function writtenText(file: string): string {
	try {
		return readTextSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "EBUSY") return "";
		throw error;
	}
}

interface ShutdownRecord {
	readonly pid: number;
	readonly reason: string;
	readonly fromSignal?: boolean;
	readonly finished: boolean;
}

interface SessionEnd {
	readonly program: PtyProgram;
	readonly hostPid: number;
	/** The process the session runs in: the engine, or the host itself in the in-process host. */
	readonly sessionPid: number;
	/** With `execGrandchild`, the running `pi.exec` command and the process it started. */
	readonly execRoot?: RecordedProcess;
	readonly execChild?: RecordedProcess;
	/** Whether the shutdown handler has started. */
	handlerStarted(): boolean;
	/** Lets a handler started with `waitForRelease` finish. */
	release(): void;
}

interface EndedSession {
	readonly exit: PtyExit;
	readonly screen: string;
	readonly calls: readonly ShutdownRecord[];
	readonly records: readonly LogRecord[];
	/** The process the session ran in: the engine, or the host itself in the in-process host. */
	readonly enginePid: number;
	/** When the session's process exited, on the `performance.now()` clock. */
	readonly exitedAt: number;
	/** The process the extension started in the engine's process group, when asked to, recorded while it ran. */
	readonly groupChild: RecordedProcess | undefined;
	/** The process the extension's `pi.exec` command started, when asked to, recorded while it ran. */
	readonly execChild: RecordedProcess | undefined;
	/** The extension's running `pi.exec` command itself, with `execGrandchild`, recorded while it ran. */
	readonly execRoot: RecordedProcess | undefined;
}

interface SessionOptions {
	readonly groupChild?: boolean;
	/** The extension runs a `pi.exec` command that starts a process of its own and then runs until it is ended. */
	readonly execGrandchild?: boolean;
	/** The `timeout` the extension gives that `pi.exec` command. */
	readonly execTimeoutMs?: number;
	/** The extension runs a `pi.exec` command that starts a process of its own, which it leaves running, and exits. */
	readonly execLeftover?: boolean;
	/** As `execLeftover`, on Windows: the command is PowerShell, and the process it leaves running a ping. */
	readonly execLeftoverTree?: boolean;
	/** Run the session in the host process, as for a project left untrusted. */
	readonly inProcess?: boolean;
	/** The handler works until the test calls `release()` rather than for a time. */
	readonly waitForRelease?: boolean;
}

/**
 * Start an interactive session in the isolated engine (or with `inProcess`, in the host) with an extension whose
 * `session_shutdown` handler records itself before and after it works, wait until the extension runs, end the session
 * with `end`, and return what the handler recorded.
 */
async function endSession(
	end: (session: SessionEnd) => void | Promise<void>,
	handlerWorkMs = HANDLER_WORK_MS,
	options: SessionOptions = {},
): Promise<EndedSession> {
	const root = makeTempDirectory("atomic-engine-quit-shutdown-");
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const installed = join(root, "installed");
	const extension = join(root, "shutdown.ts");
	const started = join(root, "started");
	const shutdown = join(root, "shutdown.jsonl");
	const eventLoopLog = join(root, "event-loop.jsonl");
	const groupChild = join(root, "group-child");
	const execChild = join(root, "exec-child");
	const execGo = join(root, "exec-go");
	const released = join(root, "released");
	let program: PtyProgram | undefined;
	let groupChildProcess: RecordedProcess | undefined;
	let execChildProcess: RecordedProcess | undefined;
	let execRootProcess: RecordedProcess | undefined;
	try {
		prepareAgentDir(agentDir, "http://127.0.0.1:9");
		prepareInstalledPackage(PACKAGE, installed);
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(root, "fixture.json"),
			JSON.stringify({
				groupChild: options.groupChild === true,
				execGrandchild: options.execGrandchild === true,
				execTimeoutMs: options.execTimeoutMs,
				execLeftover: options.execLeftover === true,
				execLeftoverTree: options.execLeftoverTree === true,
				fixtureSeconds: WINDOWS_FIXTURE_SECONDS,
				waitForRelease: options.waitForRelease === true,
				pollMs: RECORD_POLL_MS,
				handlerWorkMs,
				files: { started, shutdown, groupChild, execChild, execGo, released },
			}),
		);
		writeFileSync(extension, SHUTDOWN_EXTENSION);
		program = startPtyProgram({
			executable: process.execPath,
			args: [
				join(PACKAGE, "dist/cli.js"),
				"--offline",
				"--no-mcp",
				// A session with storage of its own, in a project left untrusted, runs in the host process.
				...(options.inProcess === true ? ["--no-approve"] : ["--no-session"]),
				"-e",
				extension,
			],
			cwd: project,
			env: {
				...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
				HOME: root,
				USERPROFILE: root,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_PACKAGE_DIR: installed,
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_TELEMETRY: "0",
				ATOMIC_EVENT_LOOP_BLOCK_MS: "1000",
				ATOMIC_EVENT_LOOP_BLOCK_STACKS: "0",
				ATOMIC_EVENT_LOOP_BLOCK_LOG: eventLoopLog,
				TERM: "xterm-256color",
			},
			timeoutMs: CLI_TIMEOUT_MS,
			cols: 120,
			rows: 40,
		});
		await program.waitForScreen((screen) => screen.includes("❯"), CLI_TIMEOUT_MS, "the prompt");
		const deadline = Date.now() + CLI_TIMEOUT_MS;
		while (!fileExistsSync(started) && Date.now() < deadline) await sleep(RECORD_POLL_MS);
		assert.ok(fileExistsSync(started), "the extension started in the engine");
		const startRecords = readRecords(eventLoopLog);
		const host = startRecords.find((record) => record.type === "start" && record.role === "host");
		const engine = startRecords.find((record) => record.type === "start" && record.role === "engine");
		assert.ok(host?.type === "start", "the host started");
		if (options.inProcess === true) assert.equal(engine, undefined, "the session ran in the host process");
		else assert.ok(engine?.type === "start", "the session ran in an engine process");
		const sessionPid = engine?.type === "start" ? engine.pid : host.pid;

		if (options.groupChild) {
			// The engine, and so its process group, is running: the pid names the extension's process.
			groupChildProcess = await recordProcess(Number(readTextSync(groupChild, "utf8")));
			assert.ok(await stillRuns(groupChildProcess), "the extension started its process");
		}
		if (options.execGrandchild || options.execLeftover || options.execLeftoverTree) {
			if (options.execTimeoutMs !== undefined) writeFileSync(execGo, "");
			let written = writtenText(execChild);
			while (written === "" && Date.now() < deadline) {
				await sleep(RECORD_POLL_MS);
				written = writtenText(execChild);
			}
			// The command, and so the process it started, is running: the pid names that process.
			execChildProcess = await recordProcess(Number(written));
			assert.ok(await stillRuns(execChildProcess), "the command started its process");
			if (options.execLeftoverTree) {
				while (!fileExistsSync(`${execChild}.done`) && Date.now() < deadline) await sleep(RECORD_POLL_MS);
				assert.ok(fileExistsSync(`${execChild}.done`), "the command finished");
			}
			if (options.execGrandchild) {
				execRootProcess = await recordProcess(Number(readTextSync(`${execChild}.root`, "utf8")));
				assert.ok(await stillRuns(execRootProcess), "the command runs");
			}
		}
		await end({
			program,
			...(execRootProcess ? { execRoot: execRootProcess } : {}),
			...(execChildProcess ? { execChild: execChildProcess } : {}),
			hostPid: host.pid,
			sessionPid,
			handlerStarted: () => fileExistsSync(shutdown),
			release: () => writeFileSync(released, ""),
		});
		const exit = await program.exited;
		const exitedAt = performance.now();

		const calls = fileExistsSync(shutdown)
			? readTextSync(shutdown, "utf8")
					.split("\n")
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line) as ShutdownRecord)
			: [];
		return {
			exit,
			screen: program.screen(),
			calls,
			records: readRecords(eventLoopLog),
			enginePid: sessionPid,
			exitedAt,
			groupChild: groupChildProcess,
			execChild: execChildProcess,
			execRoot: execRootProcess,
		};
	} finally {
		program?.kill();
		await program?.exited;
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

test(
	"quitting runs the engine's extension shutdown and writes its shutdown record (#6075)",
	async () => {
		const ended = await endSession(({ program }) => program.write("/quit\r"));

		assert.equal(ended.exit.timedOut, false, ended.screen);
		assert.equal(ended.exit.exitCode, 0, ended.screen);
		assert.deepEqual(
			ended.calls,
			[
				{ pid: ended.enginePid, reason: "quit", finished: false },
				{ pid: ended.enginePid, reason: "quit", finished: true },
			],
			"the handler ran once, in the engine",
		);
		console.info(`After quitting, ${engineEnding(ended)}.`);
	},
	CLI_TIMEOUT_MS + 10_000,
);

/**
 * How the engine ended after its handlers finished: it exited itself and wrote its shutdown record, or, only on a
 * starved run, the host ended it after its grace period. Anything else fails.
 */
function engineEnding(ended: EndedSession): string {
	if (delayOf(ended.records, "engine", "shutdown")) return "the engine exited itself and wrote its shutdown record";
	const longestHostBlock = Math.max(
		0,
		...ended.records.flatMap((record) =>
			record.type === "block" && record.role === "host" ? [record.durationMs] : [],
		),
	);
	const hostShutdown = delayOf(ended.records, "host", "shutdown");
	assert.ok(
		longestHostBlock >= STARVED_HOST_BLOCK_MS && (hostShutdown?.durationMs ?? 0) >= ENGINE_SHUTDOWN_GRACE_MS,
		`the engine wrote no shutdown record on a run that was not starved (longest host block ${longestHostBlock} ms, host shutdown ${hostShutdown?.durationMs} ms)`,
	);
	return `the host ended the starved engine after its grace period (longest host block ${longestHostBlock} ms, host shutdown ${hostShutdown?.durationMs} ms)`;
}

// Windows delivers neither signal to a process: closing its console ends it at once.
describe.skipIf(process.platform === "win32")("a host signal", () => {
	for (const signal of ["SIGTERM", "SIGHUP"] as const) {
		test(
			`${signal} gives the engine's extensions their shutdown before Atomic exits (#6104)`,
			async () => {
				const ended = await endSession(({ hostPid }) => {
					process.kill(hostPid, signal);
				});

				assert.equal(ended.exit.timedOut, false, ended.screen);
				assert.deepEqual(
					ended.calls,
					[
						{ pid: ended.enginePid, reason: "quit", fromSignal: true, finished: false },
						{ pid: ended.enginePid, reason: "quit", fromSignal: true, finished: true },
					],
					"the handler ran once, in the engine, told that a signal ended the session",
				);
				assert.ok(delayOf(ended.records, "engine", "shutdown"), "the engine wrote its shutdown record");
			},
			CLI_TIMEOUT_MS + 10_000,
		);
	}

	test(
		"a process an extension started in the engine's process group ends with the engine after a signal (#6104)",
		async () => {
			const ended = await endSession(
				({ hostPid }) => {
					process.kill(hostPid, "SIGTERM");
				},
				HANDLER_WORK_MS,
				{ groupChild: true },
			);

			const child = ended.groupChild;
			assert.ok(child !== undefined);
			try {
				assert.equal(ended.exit.timedOut, false, ended.screen);
				assert.equal(ended.calls.length, 2, "the engine ran its extension's shutdown");
				assert.equal(
					await waitUntilGone(child, GROUP_CHILD_GONE_MS),
					true,
					"the extension's process outlived the engine",
				);
			} finally {
				await signalRecordedProcess(child);
			}
		},
		CLI_TIMEOUT_MS + 10_000,
	);

	test(
		"a second signal ends the engine at once (#6104)",
		async () => {
			let secondSignalAt = 0;
			const ended = await endSession(async ({ hostPid, handlerStarted }) => {
				process.kill(hostPid, "SIGTERM");
				const deadline = Date.now() + CLI_TIMEOUT_MS;
				while (!handlerStarted() && Date.now() < deadline) await sleep(RECORD_POLL_MS);
				assert.ok(handlerStarted(), "the first signal started the engine's shutdown handler");
				secondSignalAt = performance.now();
				process.kill(hostPid, "SIGTERM");
			}, ENDLESS_HANDLER_WORK_MS);

			assert.equal(ended.exit.timedOut, false, ended.screen);
			assert.deepEqual(ended.calls, [{ pid: ended.enginePid, reason: "quit", fromSignal: true, finished: false }]);
			const exitMs = ended.exitedAt - secondSignalAt;
			assert.ok(exitMs < ENGINE_SHUTDOWN_GRACE_MS, `exiting took ${Math.round(exitMs)} ms after the second signal`);
		},
		CLI_TIMEOUT_MS + 10_000,
	);
});

/** Ends `program`'s session with `/quit` once its prompt shows, and returns when the quit was sent. */
function quitAt(program: PtyProgram): number {
	program.write("/quit\r");
	return performance.now();
}

async function untilHandlerStarted(session: SessionEnd): Promise<void> {
	const deadline = Date.now() + CLI_TIMEOUT_MS;
	while (!session.handlerStarted() && Date.now() < deadline) await sleep(RECORD_POLL_MS);
	assert.ok(session.handlerStarted(), "the session's shutdown handler started");
}

describe("the in-process host", () => {
	test(
		"quitting ends within the shutdown grace period when a session_shutdown handler never finishes",
		async () => {
			let quitSentAt = 0;
			const ended = await endSession(
				({ program }) => {
					quitSentAt = quitAt(program);
				},
				ENDLESS_HANDLER_WORK_MS,
				{ inProcess: true },
			);

			assert.equal(ended.exit.timedOut, false, ended.screen);
			assert.equal(ended.exit.exitCode, 0, ended.screen);
			assert.deepEqual(ended.calls, [{ pid: ended.enginePid, reason: "quit", finished: false }]);
			const hostShutdown = delayOf(ended.records, "host", "shutdown");
			assert.ok(hostShutdown, "the host wrote its shutdown record");
			assert.ok(
				hostShutdown.durationMs < ENGINE_SHUTDOWN_GRACE_MS + QUIT_EXIT_HEADROOM_MS,
				`quitting took ${hostShutdown.durationMs} ms from the start of the host's shutdown, ${Math.round(ended.exitedAt - quitSentAt)} ms from the typed /quit`,
			);
		},
		CLI_TIMEOUT_MS + 10_000,
	);
});

describe.skipIf(process.platform === "win32")("the in-process host, on a signal", () => {
	test(
		"SIGTERM ends Atomic within the shutdown grace period when a session_shutdown handler never finishes",
		async () => {
			let signalledAt = 0;
			const ended = await endSession(
				({ hostPid }) => {
					signalledAt = performance.now();
					process.kill(hostPid, "SIGTERM");
				},
				ENDLESS_HANDLER_WORK_MS,
				{ inProcess: true },
			);

			assert.equal(ended.exit.timedOut, false, ended.screen);
			assert.deepEqual(ended.calls, [{ pid: ended.enginePid, reason: "quit", fromSignal: true, finished: false }]);
			const exitMs = ended.exitedAt - signalledAt;
			assert.ok(exitMs < BOUNDED_SHUTDOWN_MS, `exiting took ${Math.round(exitMs)} ms after the signal`);
		},
		CLI_TIMEOUT_MS + 10_000,
	);

	test(
		"a second SIGTERM ends Atomic at once",
		async () => {
			let secondSignalAt = 0;
			const ended = await endSession(
				async (session) => {
					process.kill(session.hostPid, "SIGTERM");
					await untilHandlerStarted(session);
					secondSignalAt = performance.now();
					process.kill(session.hostPid, "SIGTERM");
				},
				ENDLESS_HANDLER_WORK_MS,
				{ inProcess: true },
			);

			assert.equal(ended.exit.timedOut, false, ended.screen);
			assert.deepEqual(ended.calls, [{ pid: ended.enginePid, reason: "quit", fromSignal: true, finished: false }]);
			const exitMs = ended.exitedAt - secondSignalAt;
			assert.ok(exitMs < ENGINE_SHUTDOWN_GRACE_MS, `exiting took ${Math.round(exitMs)} ms after the second signal`);
		},
		CLI_TIMEOUT_MS + 10_000,
	);
});

describe.skipIf(process.platform === "win32")("a SIGHUP after a quit stopped the screen", () => {
	for (const inProcess of [false, true]) {
		test(
			`lets the quit finish its shutdown${inProcess ? " in the in-process host" : ""}`,
			async () => {
				const ended = await endSession(
					async (session) => {
						quitAt(session.program);
						// The handler runs once the screen has stopped and the session's dispose began.
						await untilHandlerStarted(session);
						process.kill(session.hostPid, "SIGHUP");
						// The signal is handled before the handler is let go: the host is still running it.
						await sleep(RECORD_POLL_MS * 10);
						session.release();
					},
					HANDLER_WORK_MS,
					{ inProcess, waitForRelease: true },
				);

				assert.equal(ended.exit.timedOut, false, ended.screen);
				assert.deepEqual(
					ended.calls,
					[
						{ pid: ended.enginePid, reason: "quit", finished: false },
						{ pid: ended.enginePid, reason: "quit", finished: true },
					],
					"the quit's shutdown handler ran to its end",
				);
				assert.equal(ended.exit.exitCode, 0, ended.screen);
			},
			CLI_TIMEOUT_MS + 10_000,
		);
	}
});

test(
	"a process that an extension's running pi.exec command started ends when you quit, and the extension's other processes keep running",
	async () => {
		const ended = await endSession(({ program }) => program.write("/quit\r"), HANDLER_WORK_MS, {
			execGrandchild: true,
			groupChild: true,
		});

		const { execChild, groupChild } = ended;
		assert.ok(execChild !== undefined && groupChild !== undefined);
		try {
			assert.equal(ended.exit.timedOut, false, ended.screen);
			assert.equal(ended.calls.length, 2, "the engine ran its extension's shutdown");
			assert.equal(
				await waitUntilGone(execChild, GROUP_CHILD_GONE_MS),
				true,
				"the process the command started outlived the quit",
			);
			// As before: on Windows every process the engine started without detaching it ends with the engine.
			if (process.platform === "win32")
				assert.equal(
					await waitUntilGone(groupChild, GROUP_CHILD_GONE_MS),
					true,
					"the engine's process outlived it",
				);
			else assert.equal(await stillRuns(groupChild), true, "the quit ended a process the command did not start");
		} finally {
			await signalRecordedProcess(execChild);
			await signalRecordedProcess(groupChild);
		}
	},
	CLI_TIMEOUT_MS + 10_000,
);

for (const inProcess of [false, true]) {
	test(
		`an extension's running pi.exec command ends with the process it started when the host is killed${inProcess ? ", in the host process" : ""}`,
		async () => {
			const ended = await endSession(
				async ({ hostPid }) => {
					await signalRecordedProcess(await recordProcess(hostPid), "SIGKILL");
				},
				HANDLER_WORK_MS,
				{ execGrandchild: true, inProcess },
			);

			const { execChild, execRoot } = ended;
			assert.ok(execChild !== undefined && execRoot !== undefined);
			try {
				assert.equal(ended.exit.timedOut, false, ended.screen);
				assert.equal(await waitUntilGone(execRoot, GROUP_CHILD_GONE_MS), true, "the command outlived its host");
				assert.equal(
					await waitUntilGone(execChild, GROUP_CHILD_GONE_MS),
					true,
					"the process the command started outlived its host",
				);
			} finally {
				await signalRecordedProcess(execChild);
				await signalRecordedProcess(execRoot);
			}
		},
		CLI_TIMEOUT_MS + 10_000,
	);
}

/** The timeout the extension gives its command: longer than starting it and its process takes on a loaded machine. */
const EXEC_TIMEOUT_MS = 8_000;

for (const inProcess of [false, true]) {
	test(
		`an extension's pi.exec command that times out ends with the process it started${inProcess ? ", in the host process" : ""}`,
		async () => {
			let endedBeforeQuit: { root: boolean; child: boolean } | undefined;
			const ended = await endSession(
				async ({ program, execRoot, execChild }) => {
					assert.ok(execRoot !== undefined && execChild !== undefined);
					endedBeforeQuit = {
						root: await waitUntilGone(execRoot, EXEC_TIMEOUT_MS + GROUP_CHILD_GONE_MS),
						child: await waitUntilGone(execChild, GROUP_CHILD_GONE_MS),
					};
					program.write("/quit\r");
				},
				HANDLER_WORK_MS,
				{ execGrandchild: true, execTimeoutMs: EXEC_TIMEOUT_MS, inProcess },
			);
			try {
				assert.equal(ended.exit.timedOut, false, ended.screen);
				assert.deepEqual(
					endedBeforeQuit,
					{ root: true, child: true },
					"the timeout left the command's process running",
				);
			} finally {
				if (ended.execChild) await signalRecordedProcess(ended.execChild);
				if (ended.execRoot) await signalRecordedProcess(ended.execRoot);
			}
		},
		CLI_TIMEOUT_MS + EXEC_TIMEOUT_MS + 2 * GROUP_CHILD_GONE_MS + 10_000,
	);
}

describe.skipIf(process.platform === "win32")(
	"a process a pi.exec command left running when it ended on its own",
	() => {
		test(
			"ends with the engine when the host is signalled",
			async () => {
				const ended = await endSession(
					({ hostPid }) => {
						process.kill(hostPid, "SIGTERM");
					},
					HANDLER_WORK_MS,
					{ execLeftover: true },
				);

				const child = ended.execChild;
				assert.ok(child !== undefined);
				try {
					assert.equal(ended.exit.timedOut, false, ended.screen);
					assert.equal(await waitUntilGone(child, GROUP_CHILD_GONE_MS), true, "the process outlived the engine");
				} finally {
					await signalRecordedProcess(child);
				}
			},
			CLI_TIMEOUT_MS + 10_000,
		);

		test(
			"keeps running after you quit",
			async () => {
				const ended = await endSession(({ program }) => program.write("/quit\r"), HANDLER_WORK_MS, {
					execLeftover: true,
				});

				const child = ended.execChild;
				assert.ok(child !== undefined);
				try {
					assert.equal(ended.exit.exitCode, 0, ended.screen);
					assert.equal(await stillRuns(child), true, "the quit ended the process");
				} finally {
					await signalRecordedProcess(child);
				}
			},
			CLI_TIMEOUT_MS + 10_000,
		);
	},
);

// Node.js starts the command in a job of its own that ends with the process running it, and what the command starts
// leaves that job: a program a finished command left running outlives Atomic, as on Linux and macOS after you quit.
for (const how of ["quit", "kill"] as const) {
	test.runIf(process.platform === "win32")(
		`on Windows, a program a finished pi.exec command left running keeps running after ${how === "quit" ? "you quit" : "the host is killed"}`,
		async () => {
			let keptRunning: boolean | undefined;
			await endSession(
				async ({ program, hostPid, sessionPid, execChild }) => {
					assert.ok(execChild !== undefined);
					try {
						const host = await recordProcess(hostPid);
						const session = await recordProcess(sessionPid);
						if (how === "quit") program.write("/quit\r");
						else await signalRecordedProcess(host, "SIGKILL");
						assert.equal(await waitUntilGone(host, CLI_TIMEOUT_MS), true, "the host kept running");
						assert.equal(await waitUntilGone(session, CLI_TIMEOUT_MS), true, "the session kept running");
						keptRunning = !(await waitUntilGone(execChild, GROUP_CHILD_GONE_MS));
					} finally {
						// Ended before the session's terminal is waited for.
						await signalRecordedProcess(execChild);
					}
				},
				HANDLER_WORK_MS,
				{ execLeftoverTree: true },
			);

			assert.equal(keptRunning, true, "the program the command left running ended with Atomic");
		},
		CLI_TIMEOUT_MS * 2 + 10_000,
	);
}
