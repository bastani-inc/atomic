import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage, readRecords } from "../helpers/event-loop-guard-fixture.js";
import { fileExistsSync, makeTempDirectory, moduleDir, readTextSync } from "../helpers/runtime.js";
import { type EndedSessionRun, runUntilSessionEnded } from "../helpers/windows-session-end.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const CLI_TIMEOUT_MS = 90_000;
/** How long the extension's shutdown handler works, as saving state or stopping a server does. */
const HANDLER_WORK_MS = 200;
/** A handler that works longer than any test here waits. */
const ENDLESS_HANDLER_WORK_MS = 10 * CLI_TIMEOUT_MS;
/** STATUS_CONTROL_C_EXIT: the status Windows gives a console program it ends at the end of the session. */
const SESSION_ENDED_EXIT_CODE = 0xc000013a;
/** How long Windows waits for a program at the end of the session before it says the program keeps it waiting. */
const WINDOWS_SESSION_END_WAIT_MS = 5_000;
/** WS_EX_APPWINDOW: a window with it gets a taskbar button even when it is not visible. */
const WS_EX_APPWINDOW = 0x40000;
/** Longer than a killed process takes to be gone, however loaded the machine. */
const PROCESS_GONE_MS = 5_000;

interface ShutdownRecord {
	readonly pid: number;
	readonly reason: string;
	readonly fromSignal?: boolean;
	readonly finished: boolean;
}

interface EndedSession {
	readonly run: EndedSessionRun;
	readonly calls: readonly ShutdownRecord[];
	readonly enginePid: number;
}

/**
 * Start an interactive session in the isolated engine, in a console of its own, with an extension whose
 * `session_shutdown` handler records itself before and after it works; end the Windows session for it once the
 * extension runs and Atomic has its window; and return how Atomic ended and what the handler recorded.
 */
async function endSession(handlerWorkMs = HANDLER_WORK_MS): Promise<EndedSession> {
	const root = makeTempDirectory("atomic-windows-session-end-");
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const installed = join(root, "installed");
	const extension = join(root, "shutdown.ts");
	const started = join(root, "started");
	const shutdown = join(root, "shutdown.jsonl");
	const eventLoopLog = join(root, "event-loop.jsonl");
	try {
		prepareAgentDir(agentDir, "http://127.0.0.1:9");
		prepareInstalledPackage(PACKAGE, installed);
		mkdirSync(project, { recursive: true });
		writeFileSync(
			extension,
			`import { appendFileSync, writeFileSync } from "node:fs";
export default (pi) => {
	pi.on("session_start", () => writeFileSync(${JSON.stringify(started)}, String(process.pid)));
	pi.on("session_shutdown", async (event) => {
		const call = { pid: process.pid, reason: event.reason, fromSignal: event.fromSignal };
		appendFileSync(${JSON.stringify(shutdown)}, JSON.stringify({ ...call, finished: false }) + "\\n");
		await new Promise((resolve) => setTimeout(resolve, ${handlerWorkMs}));
		appendFileSync(${JSON.stringify(shutdown)}, JSON.stringify({ ...call, finished: true }) + "\\n");
	});
};`,
		);
		const quote = (value: string) => `"${value}"`;
		const run = await runUntilSessionEnded({
			commandLine: [
				process.execPath,
				join(PACKAGE, "dist/cli.js"),
				"--offline",
				"--no-mcp",
				"--no-session",
				"-e",
				extension,
			]
				.map((part) => (part.startsWith("-") ? part : quote(part)))
				.join(" "),
			cwd: project,
			env: {
				...process.env,
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
			// The extension writes the engine's pid there once it runs in the engine.
			readyFile: started,
			readyText: "❯",
			timeoutMs: CLI_TIMEOUT_MS,
			readyProcessExitMs: PROCESS_GONE_MS,
			directory: root,
		});
		const engine = readRecords(eventLoopLog).find((record) => record.type === "start" && record.role === "engine");
		assert.ok(engine?.type === "start", `the session ran in an engine process\n${run.screen}`);
		const calls = fileExistsSync(shutdown)
			? readTextSync(shutdown, "utf8")
					.split("\n")
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line) as ShutdownRecord)
			: [];
		return { run, calls, enginePid: engine.pid };
	} finally {
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

// Only Windows ends a user's session by asking its top-level windows; Linux and macOS send SIGHUP or SIGTERM, which
// the signal tests cover.
describe.skipIf(process.platform !== "win32")("the end of the Windows session", () => {
	test(
		"gives the engine's extensions their shutdown, then Atomic exits with STATUS_CONTROL_C_EXIT before Windows stops waiting",
		async () => {
			const ended = await endSession();

			assert.deepEqual(
				ended.run.window,
				{ ...ended.run.window, visible: false, topLevel: true },
				"a hidden top-level window hears the end of the session",
			);
			assert.equal(ended.run.window.extendedStyle & WS_EX_APPWINDOW, 0, "the window has no taskbar button");
			assert.equal(ended.run.queryAnswer, 1, "Atomic lets the session end");
			assert.equal(ended.run.ranAfterCancel, true, "a cancelled sign-out leaves Atomic running");
			assert.deepEqual(
				ended.calls,
				[
					{ pid: ended.enginePid, reason: "quit", fromSignal: true, finished: false },
					{ pid: ended.enginePid, reason: "quit", fromSignal: true, finished: true },
				],
				`the handler ran once, in the engine, after the session ended\n${ended.run.screen}`,
			);
			assert.equal(ended.run.exitCode, SESSION_ENDED_EXIT_CODE, ended.run.screen);
			assert.ok(
				ended.run.exitedAfterMs !== undefined && ended.run.exitedAfterMs < WINDOWS_SESSION_END_WAIT_MS,
				`Atomic exited ${ended.run.exitedAfterMs} ms after the session ended`,
			);
			assert.ok(
				ended.run.heldMs < WINDOWS_SESSION_END_WAIT_MS,
				`the window kept Windows waiting ${ended.run.heldMs} ms`,
			);
			assert.equal(ended.run.readyProcessExited, true, "the engine outlived Atomic");
		},
		CLI_TIMEOUT_MS * 2 + 10_000,
	);

	test(
		"a shutdown handler that does not end is cut short before Windows stops waiting",
		async () => {
			const ended = await endSession(ENDLESS_HANDLER_WORK_MS);

			assert.deepEqual(ended.calls, [{ pid: ended.enginePid, reason: "quit", fromSignal: true, finished: false }]);
			assert.equal(ended.run.exitCode, SESSION_ENDED_EXIT_CODE, ended.run.screen);
			assert.ok(
				ended.run.exitedAfterMs !== undefined && ended.run.exitedAfterMs < WINDOWS_SESSION_END_WAIT_MS,
				`Atomic exited ${ended.run.exitedAfterMs} ms after the session ended`,
			);
			assert.ok(
				ended.run.heldMs < WINDOWS_SESSION_END_WAIT_MS,
				`the window kept Windows waiting ${ended.run.heldMs} ms`,
			);
			assert.equal(ended.run.readyProcessExited, true, "the engine outlived Atomic");
		},
		CLI_TIMEOUT_MS * 2 + 10_000,
	);
});
