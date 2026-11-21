import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	waitUntilGone,
} from "../../../test/helpers/recorded-process.js";
import { execCommand, hasQuitStoppableCommands, killQuitStoppableCommandsNow } from "../src/core/exec.ts";
import { hostIsGone } from "../src/modes/interactive-engine/engine-host-loss.ts";

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
	const directory = mkdtempSync(join(tmpdir(), "atomic-exec-host-loss-"));
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
 * A program that starts a process of its own running the program its second argument holds, with its first argument,
 * a file, as that program's argument, in a session of its own when its third argument is `detached`. It then exits
 * once the file exists when its fourth argument is `exit`, and otherwise runs until it is ended.
 */
const STARTS_A_PROCESS =
	'const [file, program, session, keep] = process.argv.slice(1); require("node:child_process").spawn(process.execPath, ["-e", program, file], { stdio: "ignore", detached: session === "detached" }).unref(); if (keep === "exit") { const wait = setInterval(() => { if (require("node:fs").existsSync(file)) { clearInterval(wait); process.exit(0); } }, 10); } else setInterval(() => {}, 1000);';

/**
 * A command that starts a process of its own, which records its pid in `file`; the command runs until it is ended,
 * or with `exitAfterStart` exits once that process runs, and with `detached` starts it in a session of its own.
 */
function commandStartingAProcess(
	file: string,
	options: { exitAfterStart?: boolean; detached?: boolean; deaf?: boolean } = {},
): string[] {
	return [
		"-e",
		STARTS_A_PROCESS,
		file,
		options.deaf ? RECORDS_ITS_PID_DEAF : RECORDS_ITS_PID,
		options.detached ? "detached" : "attached",
		options.exitAfterStart ? "exit" : "run",
	];
}

/** A quit stop as a session gives a command an extension runs outside its `session_shutdown` handlers. */
const quitStop = () => () => {};

// On Windows the processes a command started end with the process that started it.
describe.skipIf(process.platform === "win32")("ending the commands at once when the engine's host is gone", () => {
	test("ends a running command and the processes it started, also one that ignores SIGTERM", async () => {
		const file = pidFile();
		const running = execCommand(
			process.execPath,
			commandStartingAProcess(file, { deaf: true }),
			process.cwd(),
			undefined,
			quitStop,
		);
		const started = await recordedFrom(file);
		assert.equal(hasQuitStoppableCommands(), true);

		killQuitStoppableCommandsNow();
		const result = await running;

		assert.equal(result.code, 137, "the command itself got SIGKILL");
		assert.equal(await waitUntilGone(started, GONE_MS), true, "the process the command started outlived it");
		assert.equal(hasQuitStoppableCommands(), false);
	});

	test("leaves a command a session_shutdown handler started, which no quit stops, running", async () => {
		const file = pidFile();
		const controller = new AbortController();
		const running = execCommand(process.execPath, commandStartingAProcess(file), process.cwd(), {
			signal: controller.signal,
		});
		const started = await recordedFrom(file);

		killQuitStoppableCommandsNow();

		assert.equal(await waitUntilGone(started, KILL_SEEN_MS), false, "a command no quit stops was ended");
		controller.abort();
		assert.equal((await running).killed, true, "the command ran until the test stopped it");
	});

	test("leaves what a command that ended on its own started running", async () => {
		const file = pidFile();
		const result = await execCommand(
			process.execPath,
			commandStartingAProcess(file, { exitAfterStart: true }),
			process.cwd(),
			undefined,
			quitStop,
		);
		const started = await recordedFrom(file);
		assert.equal(result.code, 0);
		assert.equal(hasQuitStoppableCommands(), false, "a command that ended is no longer one to end");

		killQuitStoppableCommandsNow();

		assert.equal(
			await waitUntilGone(started, KILL_SEEN_MS),
			false,
			"the process a finished command left running was ended",
		);
	});

	test("leaves a program a running command started detached running", async () => {
		const file = pidFile();
		const running = execCommand(
			process.execPath,
			commandStartingAProcess(file, { detached: true }),
			process.cwd(),
			undefined,
			quitStop,
		);
		const detached = await recordedFrom(file);

		killQuitStoppableCommandsNow();
		await running;

		assert.equal(
			await waitUntilGone(detached, KILL_SEEN_MS),
			false,
			"a program the command started detached was ended",
		);
	});
});

describe("whether the engine's host is gone", () => {
	/** A parent that is `hostPid` for the first `checks` reads, then another process. */
	function parentChangingAfter(hostPid: number, checks: number): () => number {
		let read = 0;
		return () => (read++ < checks ? hostPid : 1);
	}
	/** A clock that moves only as far as the waits paused, with the pauses it saw. */
	function pausedClock(): { now: () => number; pause: (ms: number) => void; pauses: number[] } {
		let time = 1_000;
		const pauses: number[] = [];
		return {
			now: () => time,
			pause: (ms) => {
				pauses.push(ms);
				time += ms;
			},
			pauses,
		};
	}

	test("once the engine's parent is no longer the host, unless the host announced its quit", () => {
		const { now, pause } = pausedClock();
		assert.equal(
			hostIsGone(4242, false, false, () => 4242, pause, now),
			false,
			"the host is still the engine's parent",
		);
		assert.equal(
			hostIsGone(4242, false, false, () => 1, pause, now),
			true,
			"the engine was given to another parent",
		);
		assert.equal(
			hostIsGone(4242, true, false, () => 1, pause, now),
			false,
			"a host that announced its quit is not gone",
		);
	});

	test("not, and without waiting, while the host is still the engine's parent and the channel to it is open", () => {
		const clock = pausedClock();
		assert.equal(
			hostIsGone(4242, false, false, () => 4242, clock.pause, clock.now),
			false,
		);
		assert.deepEqual(clock.pauses, [], "an engine whose host lives and still reads it waited at its exit");
	});

	test("once the channel to the host closed and the engine is given another parent soon after, as while a killed host exits", () => {
		// The system closes a killed host's pipes before it gives the host's children another parent, and the engine can
		// get to its exit in between.
		const { now, pause } = pausedClock();
		assert.equal(hostIsGone(4242, false, true, parentChangingAfter(4242, 3), pause, now), true);
	});

	test("not when the channel to the host closed but the host stays the engine's parent, within a bounded wait", () => {
		const clock = pausedClock();
		const gone = hostIsGone(4242, false, true, () => 4242, clock.pause, clock.now, 100);
		assert.equal(gone, false, "a host that lives is not gone");
		assert.equal(
			clock.pauses.reduce((total, ms) => total + ms, 0),
			100,
			"the wait ends once 100 ms have passed",
		);
		const quit = pausedClock();
		assert.equal(
			hostIsGone(4242, true, true, parentChangingAfter(4242, 3), quit.pause, quit.now),
			false,
			"the host quit",
		);
		assert.deepEqual(quit.pauses, [], "a host that quit is not waited for");
	});

	test("a wait that took longer than asked, as under load, still reads the parent once more at its end", () => {
		let time = 0;
		let reads = 0;
		// One pause overshoots the whole bound; the parent changed meanwhile.
		const gone = hostIsGone(
			4242,
			false,
			true,
			() => (reads++ < 2 ? 4242 : 1),
			() => {
				time += 5_000;
			},
			() => time,
			1_000,
		);
		assert.equal(gone, true);
	});
});
