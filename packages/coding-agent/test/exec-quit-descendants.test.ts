import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
	waitUntilGone,
} from "../../../test/helpers/recorded-process.js";
import { type ExecResult, execCommand } from "../src/core/exec.ts";
import { signalIfSame } from "../src/core/process-descendants.js";

/** Longer than a killed process takes to be gone, however loaded the machine. */
const GONE_MS = 5_000;
const POLL_MS = 20;
/** Longer than a SIGKILLed process takes to be gone; a process still there after it was not signalled. */
const KILL_SEEN_MS = 1_000;

const directories: string[] = [];
const processes: RecordedProcess[] = [];

afterEach(async () => {
	for (const recorded of processes.splice(0)) await signalRecordedProcess(recorded);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function pidFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-exec-quit-"));
	directories.push(directory);
	return join(directory, "child.pid");
}

async function recordedFrom(file: string): Promise<RecordedProcess> {
	const deadline = Date.now() + GONE_MS * 4;
	while (!(existsSync(file) && readFileSync(file, "utf8") !== "") && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	const recorded = await recordProcess(Number(readFileSync(file, "utf8")));
	processes.push(recorded);
	return recorded;
}

/** A program that records its pid in the file its first argument names, then runs until it is ended. */
const RECORDS_ITS_PID =
	'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
/** {@link RECORDS_ITS_PID}, ignoring SIGTERM. */
const RECORDS_ITS_PID_DEAF =
	'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
/**
 * Programs that start a process of their own running the program their second argument holds, with their first
 * argument, a file, as its argument: one that then runs until it is ended, one that exits once the file exists, and one
 * that starts the process detached and then runs until it is ended.
 */
const STARTS_A_PROCESS =
	'require("node:child_process").spawn(process.execPath, ["-e", process.argv[2], process.argv[1]], { stdio: "ignore" }).unref(); setInterval(() => {}, 1000);';
const STARTS_A_PROCESS_THEN_EXITS =
	'require("node:child_process").spawn(process.execPath, ["-e", process.argv[2], process.argv[1]], { stdio: "ignore" }).unref(); const wait = setInterval(() => { if (require("node:fs").existsSync(process.argv[1])) { clearInterval(wait); process.exit(0); } }, 10);';
const STARTS_A_DETACHED_PROCESS =
	'require("node:child_process").spawn(process.execPath, ["-e", process.argv[2], process.argv[1]], { detached: true, stdio: "ignore" }).unref(); setInterval(() => {}, 1000);';

/** A command that starts a process of its own, which records its pid in `file`; both run until they are ended. */
function commandStartingAProcess(file: string, options: { deaf?: boolean; exitAfterStart?: boolean } = {}): string[] {
	return [
		"-e",
		options.exitAfterStart ? STARTS_A_PROCESS_THEN_EXITS : STARTS_A_PROCESS,
		file,
		options.deaf ? RECORDS_ITS_PID_DEAF : RECORDS_ITS_PID,
	];
}

// On Windows the processes a command started end with the process that started the command.
describe.skipIf(process.platform === "win32")("a command its session's quit ends", () => {
	for (const deaf of [false, true]) {
		test(`ends with the processes it started${deaf ? ", also one that ignores SIGTERM" : ""}`, async () => {
			const file = pidFile();
			let stop: (() => void) | undefined;
			const running = execCommand(
				process.execPath,
				commandStartingAProcess(file, { deaf }),
				process.cwd(),
				undefined,
				(registered) => {
					stop = registered;
					return () => {};
				},
			);
			const started = await recordedFrom(file);

			stop?.();
			const result: ExecResult = await running;

			assert.equal(result.killed, true);
			assert.equal(result.code, 143, "the command itself gets SIGTERM first");
			assert.equal(await waitUntilGone(started, GONE_MS), true, "the process the command started outlived the quit");
		});
	}
});

// On Windows a process a command started without detaching it ends with the command.
test.skipIf(process.platform === "win32")(
	"a command that ends on its own leaves the processes it started running",
	async () => {
		const file = pidFile();
		const result = await execCommand(
			process.execPath,
			commandStartingAProcess(file, { exitAfterStart: true }),
			process.cwd(),
			undefined,
			() => () => {},
		);
		const started = await recordedFrom(file);

		assert.equal(result.code, 0);
		assert.equal(await stillRuns(started), true);
	},
);

/** A process that is not this one's child, so that it is gone, not left unreaped, once it ends. */
async function startUnrelatedProcess(): Promise<RecordedProcess> {
	const starter = `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); child.unref(); process.stdout.write(String(child.pid));`;
	const result = await execCommand(process.execPath, ["-e", starter], process.cwd());
	const recorded = await recordProcess(Number(result.stdout));
	processes.push(recorded);
	return recorded;
}

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"a process recorded at another start than the one its pid names now is never signalled",
	async () => {
		const other = await startUnrelatedProcess();

		// As a pid the quit read for a process that has ended since, and that a later process was given.
		await signalIfSame([{ pid: other.pid, started: "a start of an earlier process" }], "SIGKILL");

		assert.equal(
			await waitUntilGone(other, KILL_SEEN_MS),
			false,
			"a process that is not the recorded one was signalled",
		);
	},
);

// The quit ends what a signal to the command's process group would reach, as the engine's group kill did.
test.skipIf(process.platform === "win32")(
	"a command its session's quit ends leaves a program it started detached running",
	async () => {
		const file = pidFile();
		let stop: (() => void) | undefined;
		const args = ["-e", STARTS_A_DETACHED_PROCESS, file, RECORDS_ITS_PID];
		const running = execCommand(process.execPath, args, process.cwd(), undefined, (registered) => {
			stop = registered;
			return () => {};
		});
		const detached = await recordedFrom(file);

		stop?.();
		await running;

		assert.equal(
			await waitUntilGone(detached, KILL_SEEN_MS),
			false,
			"the quit ended a program the command started detached",
		);
	},
);
