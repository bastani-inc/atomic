import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { delayOf, prepareAgentDir, prepareInstalledPackage, readRecords } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { fileExistsSync, makeTempDirectory, moduleDir, readTextSync, sleep } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const CLI_TIMEOUT_MS = 90_000;
const RECORD_POLL_MS = 50;

interface ShutdownRecord {
	readonly pid: number;
	readonly reason: string;
	readonly fromSignal?: boolean;
}

test(
	"quitting runs the engine's extension shutdown and writes its shutdown record (#6075)",
	async () => {
		const root = makeTempDirectory("atomic-engine-quit-shutdown-");
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		const installed = join(root, "installed");
		const extension = join(root, "shutdown.ts");
		const started = join(root, "started");
		const shutdown = join(root, "shutdown.json");
		const eventLoopLog = join(root, "event-loop.jsonl");
		let program: PtyProgram | undefined;
		try {
			prepareAgentDir(agentDir, "http://127.0.0.1:9");
			prepareInstalledPackage(PACKAGE, installed);
			mkdirSync(project, { recursive: true });
			writeFileSync(
				extension,
				`import { writeFileSync } from "node:fs";
export default (pi) => {
	pi.on("session_start", () => writeFileSync(${JSON.stringify(started)}, String(process.pid)));
	pi.on("session_shutdown", async (event) => {
		// Shutdown work that takes a moment, as saving state or stopping a server does.
		await new Promise((resolve) => setTimeout(resolve, 200));
		writeFileSync(${JSON.stringify(shutdown)}, JSON.stringify({ pid: process.pid, reason: event.reason, fromSignal: event.fromSignal }));
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

			program.write("/quit\r");
			const exit = await program.exited;

			assert.equal(exit.timedOut, false, program.screen());
			assert.equal(exit.exitCode, 0, program.screen());
			const records = readRecords(eventLoopLog);
			const engine = records.find((record) => record.type === "start" && record.role === "engine");
			assert.ok(engine?.type === "start", "the session ran in an engine process");
			assert.ok(fileExistsSync(shutdown), "the engine ran the extension's session_shutdown handler");
			const record = JSON.parse(readTextSync(shutdown, "utf8")) as ShutdownRecord;
			assert.deepEqual(record, { pid: engine.pid, reason: "quit" });
			assert.ok(delayOf(records, "engine", "shutdown"), "the engine wrote its shutdown record");
		} finally {
			program?.kill();
			await program?.exited;
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	CLI_TIMEOUT_MS + 10_000,
);
