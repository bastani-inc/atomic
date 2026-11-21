import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { recordProcess, signalRecordedProcess } from "../helpers/recorded-process.js";
import {
	bunExecutable,
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	removeTempDirectory,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
/** A real CLI process: loading Atomic on a loaded machine. */
const CLI_TIMEOUT_MS = 90_000;
const POLL_MS = 50;
/** Longer than a signal takes to reach a running process's handlers, however loaded the machine. */
const SIGNAL_HANDLED_MS = 1_000;

interface PrintRun {
	readonly exitCode: number;
	readonly finished: boolean;
	readonly output: string;
}

/**
 * Runs `atomic -p /hold` on Bun, with SIGHUP ignored when `ignoreHangup` (as `nohup` starts a command). The extension
 * command waits until it is released; meanwhile the run gets a SIGHUP.
 */
async function hangUpDuringPrintRun(ignoreHangup: boolean): Promise<PrintRun> {
	const root = makeTempDirectory("atomic-print-hangup-");
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const installed = join(root, "installed");
	const extension = join(root, "hold.ts");
	const started = join(root, "started");
	const released = join(root, "released");
	const finished = join(root, "finished");
	try {
		prepareAgentDir(agentDir, "http://127.0.0.1:9");
		prepareInstalledPackage(PACKAGE, installed);
		mkdirSync(project, { recursive: true });
		writeFileSync(
			extension,
			`import { existsSync, writeFileSync } from "node:fs";
export default (pi) => {
	pi.registerCommand("hold", {
		description: "waits until released",
		handler: async () => {
			writeFileSync(${JSON.stringify(started)}, String(process.pid));
			while (!existsSync(${JSON.stringify(released)})) await new Promise((resolve) => setTimeout(resolve, ${POLL_MS}));
			writeFileSync(${JSON.stringify(finished)}, "");
		},
	});
};`,
		);
		const cli = [bunExecutable(), join(PACKAGE, "dist/cli.js"), "-p", "--offline", "--no-mcp", "--no-session"];
		const command = ignoreHangup
			? ["/bin/sh", "-c", `trap '' HUP; exec "$0" "$@"`, ...cli, "-e", extension, "/hold"]
			: [...cli, "-e", extension, "/hold"];
		const child = spawnProcess(command, {
			cwd: project,
			env: {
				...process.env,
				HOME: root,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_PACKAGE_DIR: installed,
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_TELEMETRY: "0",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: CLI_TIMEOUT_MS,
		});
		const output = Promise.all([readStreamText(child.stdout), readStreamText(child.stderr)]).then((parts) =>
			parts.join(""),
		);
		const deadline = Date.now() + CLI_TIMEOUT_MS;
		while (!fileExistsSync(started) && child.exitCode === null && Date.now() < deadline) await sleep(POLL_MS);
		assert.ok(fileExistsSync(started), `the command started: ${await Promise.race([output, sleep(0)])}`);
		const run = await recordProcess(child.pid ?? -1);
		assert.equal(await signalRecordedProcess(run, "SIGHUP"), true, "the run got the SIGHUP");
		await sleep(SIGNAL_HANDLED_MS);
		writeFileSync(released, "");
		const exitCode = await child.exited;
		return { exitCode, finished: fileExistsSync(finished), output: await output };
	} finally {
		removeTempDirectory(root);
	}
}

// Node sets an ignored SIGHUP back to its default before Atomic runs; Bun, which the standalone binary runs on, keeps
// it ignored.
describe.skipIf(process.platform === "win32")("a print-mode run on Bun", () => {
	test(
		"started with SIGHUP ignored, as under nohup, goes on when it gets a SIGHUP",
		async () => {
			const run = await hangUpDuringPrintRun(true);
			assert.equal(run.exitCode, 0, run.output);
			assert.equal(run.finished, true, "the command ran to its end");
		},
		CLI_TIMEOUT_MS + 10_000,
	);

	test(
		"started without SIGHUP ignored still ends with status 129 on a SIGHUP",
		async () => {
			const run = await hangUpDuringPrintRun(false);
			assert.equal(run.exitCode, 129, run.output);
		},
		CLI_TIMEOUT_MS + 10_000,
	);
});
