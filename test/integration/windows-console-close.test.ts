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
import { fileExistsSync, makeTempDirectory, moduleDir, readTextSync } from "../helpers/runtime.js";
import { type ClosedConsoleRun, runUntilConsoleClosed } from "../helpers/windows-console.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const CLI_TIMEOUT_MS = 90_000;
/** How long the extension's shutdown handler works, as saving state or stopping a server does. */
const HANDLER_WORK_MS = 200;
/** A handler that works longer than any test here waits. */
const ENDLESS_HANDLER_WORK_MS = 10 * CLI_TIMEOUT_MS;
/** STATUS_CONTROL_C_EXIT: the status Windows gives a process it ends when its console is closed. */
const CONSOLE_CLOSED_EXIT_CODE = 0xc000013a;
/** How long Windows lets a process run after its console was closed before it ends the process itself. */
const WINDOWS_CONSOLE_CLOSE_TIMEOUT_MS = 5_000;
/** Atomic's own bound on its shutdown once it has proof the console closed, inside Windows' timeout. */
const CONSOLE_CLOSED_SHUTDOWN_MS = WINDOWS_CONSOLE_CLOSE_TIMEOUT_MS - 1_000;
/**
 * The exit's own work after that bound on a loaded runner: ending what Atomic started, then its exit handlers. The exit
 * is measured from Atomic's first proof of the close, the start of its shutdown phase, by its own clock. Measured from
 * the harness's close, a starved runner also counts the time until Atomic was scheduled and read its console's end,
 * which no bound of Atomic's can cover; Windows itself counts from each process's own notice, which reaches the host
 * after the engine's.
 */
const EXIT_HEADROOM_MS = 3_000;
/** Longer than a killed process takes to be gone, however loaded the machine. */
const PROCESS_GONE_MS = 5_000;

interface ShutdownRecord {
	readonly pid: number;
	readonly reason: string;
	readonly fromSignal?: boolean;
	readonly finished: boolean;
}

interface ClosedSession {
	readonly run: ClosedConsoleRun;
	readonly calls: readonly ShutdownRecord[];
	readonly records: readonly LogRecord[];
	readonly enginePid: number;
	/** How many engine processes the session started: a replacement for a lost engine would be a second. */
	readonly enginesStarted: number;
	readonly engineGone: boolean;
}

/**
 * Start an interactive session in the isolated engine, in a console of its own, with an extension whose
 * `session_shutdown` handler records itself before and after it works; close the console once the extension runs;
 * and return how Atomic ended and what the handler recorded.
 */
async function closeSession(handlerWorkMs = HANDLER_WORK_MS): Promise<ClosedSession> {
	const root = makeTempDirectory("atomic-windows-console-close-");
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
		const run = await runUntilConsoleClosed({
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
		const records = readRecords(eventLoopLog);
		const host = records.find((record) => record.type === "start" && record.role === "host");
		const engine = records.find((record) => record.type === "start" && record.role === "engine");
		assert.ok(
			host?.type === "start" && engine?.type === "start",
			`the session ran in an engine process\n${run.screen}`,
		);
		const calls = fileExistsSync(shutdown)
			? readTextSync(shutdown, "utf8")
					.split("\n")
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line) as ShutdownRecord)
			: [];
		const enginesStarted = records.filter((record) => record.type === "start" && record.role === "engine").length;
		return { run, calls, records, enginePid: engine.pid, enginesStarted, engineGone: run.readyProcessExited };
	} finally {
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

/**
 * Atomic ended itself, as its record of its shutdown phase, written as it exits, shows, within its console-close bound
 * and the exit's headroom from its first proof of the close.
 */
function assertExitedWithinBound(closed: ClosedSession): void {
	const shutdown = delayOf(closed.records, "host", "shutdown");
	// The record of the session phase is written as the shutdown begins: whether Atomic had learned of the close at all.
	const session = delayOf(closed.records, "host", "session");
	assert.ok(
		shutdown,
		`Atomic did not end itself: it exited ${closed.run.exitedAfterMs} ms after the close, ${session ? `${session.durationMs} ms into its session, after its shutdown began` : "before its shutdown began"}`,
	);
	assert.ok(
		shutdown.durationMs < CONSOLE_CLOSED_SHUTDOWN_MS + EXIT_HEADROOM_MS,
		`Atomic exited ${shutdown.durationMs} ms after it learned the console closed, ${closed.run.exitedAfterMs} ms after the close`,
	);
}

/**
 * Who ended Atomic after its console was closed: Atomic itself, within its bound, or Windows. A starved runner can keep
 * Atomic from exiting before Windows ends it; once its handlers ran, a user sees the same outcome either way.
 */
function consoleCloseEnding(closed: ClosedSession): "Atomic" | "Windows" {
	if (delayOf(closed.records, "host", "shutdown") === undefined) return "Windows";
	assertExitedWithinBound(closed);
	return "Atomic";
}

// Only Windows has a console that is closed this way; Linux and macOS are covered by the terminal tests (#6104).
describe.skipIf(process.platform !== "win32")("closing the Windows console", () => {
	test(
		"gives the engine's extensions their shutdown, then Atomic exits with STATUS_CONTROL_C_EXIT",
		async () => {
			const closed = await closeSession();

			assert.deepEqual(
				closed.calls,
				[
					{ pid: closed.enginePid, reason: "quit", fromSignal: true, finished: false },
					{ pid: closed.enginePid, reason: "quit", fromSignal: true, finished: true },
				],
				`the handler ran once, in the engine, told that the session was ended for it\n${closed.run.screen}`,
			);
			assert.equal(closed.run.exitCode, CONSOLE_CLOSED_EXIT_CODE, closed.run.screen);
			// The handler finished, so Atomic exits within its bound; on a starved runner Windows can end it first, with the
			// same status, which a user cannot tell apart.
			console.info(`After its console closed, ${consoleCloseEnding(closed)} ended Atomic.`);
			assert.equal(closed.engineGone, true, "the engine outlived Atomic");
			assert.equal(closed.enginesStarted, 1, "Atomic replaced the engine its console's close ended");
			assert.ok(delayOf(closed.records, "engine", "shutdown"), "the engine wrote its shutdown record");
		},
		CLI_TIMEOUT_MS * 2 + 10_000,
	);

	test(
		"a shutdown handler that does not end is cut short before Windows would end Atomic",
		async () => {
			const closed = await closeSession(ENDLESS_HANDLER_WORK_MS);

			assert.deepEqual(closed.calls, [{ pid: closed.enginePid, reason: "quit", fromSignal: true, finished: false }]);
			assert.equal(closed.run.exitCode, CONSOLE_CLOSED_EXIT_CODE, closed.run.screen);
			assertExitedWithinBound(closed);
			assert.equal(closed.engineGone, true, "the engine outlived Atomic");
			assert.equal(closed.enginesStarted, 1, "Atomic replaced the engine its console's close ended");
		},
		CLI_TIMEOUT_MS * 2 + 10_000,
	);
});
