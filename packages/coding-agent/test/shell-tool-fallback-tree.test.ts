import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	waitUntilGone,
} from "../../../test/helpers/recorded-process.js";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { createLocalPowerShellOperations } from "../src/core/tools/powershell.ts";
import { ShellTimeoutError } from "../src/core/tools/shell-errors.ts";

/** Longer than a killed process takes to be gone, however loaded the machine. */
const GONE_MS = 5_000;
const POLL_MS = 20;
/** Longer than a killed process takes to be gone; a process still there after it was not ended. */
const KILL_SEEN_MS = 1_000;
/** How long a test's program runs when nothing ends it: bounded, well past any test. */
const FIXTURE_MS = 120_000;
/**
 * The tool's timeout: longer than Git Bash takes to start the background program and exit, however loaded the machine,
 * and shorter than the five seconds the tool keeps reading output that a background program still writes after the
 * shell exited.
 */
const TIMEOUT_SECONDS = 3;

const directories: string[] = [];
const processes: RecordedProcess[] = [];

afterEach(async () => {
	for (const recorded of processes.splice(0)) await signalRecordedProcess(recorded);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
	const created = mkdtempSync(join(tmpdir(), "atomic-shell-fallback-tree-"));
	directories.push(created);
	return created;
}

async function recordedFrom(file: string): Promise<RecordedProcess> {
	const deadline = Date.now() + GONE_MS * 4;
	while (!(existsSync(file) && readFileSync(file, "utf8") !== "") && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	const recorded = await recordProcess(Number(readFileSync(file, "utf8")));
	processes.push(recorded);
	return recorded;
}

/** A path as Git Bash takes it in a single-quoted word. */
function bashWord(path: string): string {
	return `'${path.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

/**
 * A Git Bash command that starts a Node.js program in the background and then `then`s. The program records its own
 * process ID in a file, writes to its output every 100 ms when `writes`, and ends by itself after `FIXTURE_MS`.
 */
function backgroundProgram(
	then: string,
	options: { writes: boolean; quiet?: boolean },
): { command: string; pidFile: string } {
	const dir = directory();
	const program = join(dir, "program.js");
	const pidFile = join(dir, "program.pid");
	writeFileSync(
		program,
		`require("node:fs").writeFileSync(process.argv[2], String(process.pid));
${options.writes ? 'const tick = setInterval(() => process.stdout.write("."), 100);' : ""}
setTimeout(() => process.exit(0), ${FIXTURE_MS});
`,
	);
	const redirect = options.quiet ? " > /dev/null 2>&1" : "";
	return {
		command: `${bashWord(process.execPath)} ${bashWord(program)} ${bashWord(pidFile)}${redirect} & ${then}`,
		pidFile,
	};
}

// A shell the bash or PowerShell tool runs without a task owner (as an SDK's own createBashTool does) runs in a job of
// its own on Windows, as one a task owner runs does.
describe.runIf(process.platform === "win32")("on Windows, the bash and PowerShell tools without a task owner", () => {
	test("a timeout after the shell exited ends a background program still writing to its output", async () => {
		const { command, pidFile } = backgroundProgram("exit 0", { writes: true });
		const running = createLocalBashOperations().exec(command, process.cwd(), {
			onData: () => {},
			timeout: TIMEOUT_SECONDS,
		});
		const settled = running.then(
			() => undefined,
			(error: Error) => error,
		);
		const program = await recordedFrom(pidFile);

		const error = await Promise.race([
			settled,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), TIMEOUT_SECONDS * 1000 + GONE_MS)),
		]);

		assert.equal(await waitUntilGone(program, GONE_MS), true, "the background program outlived the timeout");
		assert.ok(error instanceof ShellTimeoutError, `the call ended with ${String(error)}`);
		assert.notEqual(error.shellExit, undefined, "the shell was still running at the timeout");
	});

	test("an abort ends a program Git Bash started in the background", async () => {
		const { command, pidFile } = backgroundProgram("wait", { writes: false });
		const controller = new AbortController();
		const running = createLocalBashOperations().exec(command, process.cwd(), {
			onData: () => {},
			signal: controller.signal,
		});
		const program = await recordedFrom(pidFile);

		controller.abort();

		await assert.rejects(running, /aborted/);
		assert.equal(await waitUntilGone(program, GONE_MS), true, "the background program outlived the abort");
	});

	test("what a finished command left running keeps running, as before", async () => {
		const { command, pidFile } = backgroundProgram("exit 0", { writes: false, quiet: true });

		const result = await createLocalBashOperations().exec(command, process.cwd(), { onData: () => {} });
		const program = await recordedFrom(pidFile);

		assert.equal(result.exitCode, 0);
		assert.equal(await waitUntilGone(program, KILL_SEEN_MS), false, "the program the command left running was ended");
	});

	test("an abort ends a program PowerShell's Start-Process started", async () => {
		const pidFile = join(directory(), "ping.pid");
		const controller = new AbortController();
		const running = createLocalPowerShellOperations().exec(
			`$p = Start-Process -WindowStyle Hidden ping -ArgumentList '-n','${FIXTURE_MS / 1000}','127.0.0.1' -PassThru; Set-Content -NoNewline -Path '${pidFile.replace(/'/g, "''")}' -Value $p.Id; Start-Sleep ${FIXTURE_MS / 1000}`,
			process.cwd(),
			{ onData: () => {}, signal: controller.signal },
		);
		const ping = await recordedFrom(pidFile);

		controller.abort();

		await assert.rejects(running, /aborted/);
		assert.equal(await waitUntilGone(ping, GONE_MS), true, "the program PowerShell started outlived the abort");
	});
});
