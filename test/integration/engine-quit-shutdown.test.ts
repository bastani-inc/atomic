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
import { fileExistsSync, makeTempDirectory, moduleDir, readTextSync, sleep } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const CLI_TIMEOUT_MS = 90_000;
const RECORD_POLL_MS = 50;
/** How long the extension's shutdown handler works, as saving state or stopping a server does. */
const HANDLER_WORK_MS = 200;
/** A handler that works longer than any test here waits. */
const ENDLESS_HANDLER_WORK_MS = 10 * CLI_TIMEOUT_MS;
/** The interactive engine's shutdown grace period, which a repeated signal does not wait for. */
const ENGINE_SHUTDOWN_GRACE_MS = 5_000;

interface ShutdownRecord {
	readonly pid: number;
	readonly reason: string;
	readonly fromSignal?: boolean;
	readonly finished: boolean;
}

interface SessionEnd {
	readonly program: PtyProgram;
	readonly hostPid: number;
	/** Whether the engine's shutdown handler has started. */
	handlerStarted(): boolean;
}

interface EndedSession {
	readonly exit: PtyExit;
	readonly screen: string;
	readonly calls: readonly ShutdownRecord[];
	readonly records: readonly LogRecord[];
	readonly enginePid: number;
	/** When the session's process exited, on the `performance.now()` clock. */
	readonly exitedAt: number;
}

/**
 * Start an interactive session in the isolated engine with an extension whose `session_shutdown` handler records
 * itself before and after it works, wait until the extension runs in the engine, end the session with `end`, and
 * return what the handler recorded.
 */
async function endSession(
	end: (session: SessionEnd) => void | Promise<void>,
	handlerWorkMs = HANDLER_WORK_MS,
): Promise<EndedSession> {
	const root = makeTempDirectory("atomic-engine-quit-shutdown-");
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const installed = join(root, "installed");
	const extension = join(root, "shutdown.ts");
	const started = join(root, "started");
	const shutdown = join(root, "shutdown.jsonl");
	const eventLoopLog = join(root, "event-loop.jsonl");
	let program: PtyProgram | undefined;
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
		program = startPtyProgram({
			executable: process.execPath,
			args: [join(PACKAGE, "dist/cli.js"), "--offline", "--no-mcp", "--no-session", "-e", extension],
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
		assert.ok(host?.type === "start" && engine?.type === "start", "the session ran in an engine process");

		await end({ program, hostPid: host.pid, handlerStarted: () => fileExistsSync(shutdown) });
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
			enginePid: engine.pid,
			exitedAt,
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
		assert.ok(delayOf(ended.records, "engine", "shutdown"), "the engine wrote its shutdown record");
	},
	CLI_TIMEOUT_MS + 10_000,
);

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
