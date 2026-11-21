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

/**
 * A command that starts a process of its own, which records its pid in `file`; the command runs until it is ended,
 * or with `exitAfterStart` exits once that process runs, and with `detached` starts it in a session of its own.
 */
function commandStartingAProcess(
	file: string,
	options: { exitAfterStart?: boolean; detached?: boolean; deaf?: boolean } = {},
): string[] {
	const child = `${options.deaf ? 'process.on("SIGTERM", () => {});' : ""}require("node:fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000);`;
	const keep = options.exitAfterStart
		? `const wait = setInterval(() => { if (require("node:fs").existsSync(${JSON.stringify(file)})) { clearInterval(wait); process.exit(0); } }, 10);`
		: "setInterval(() => {}, 1000);";
	const root = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore", detached: ${options.detached === true} }).unref(); ${keep}`;
	return ["-e", root];
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
	test("once the engine's parent is no longer the host, unless the host announced its quit", () => {
		assert.equal(hostIsGone(4242, 4242, false, false), false, "the host is still the engine's parent");
		assert.equal(hostIsGone(4242, 1, false, false), true, "the engine was given to another parent");
		assert.equal(hostIsGone(4242, 1, true, false), false, "a host that announced its quit is not gone");
	});

	test("once the channel to the host closed while the host is still the engine's parent, as while a killed host exits", () => {
		// The system closes a killed host's pipes before it gives the host's children another parent, and the engine
		// can exit in between.
		assert.equal(hostIsGone(4242, 4242, false, true), true, "the host's channel closed without a quit");
		assert.equal(hostIsGone(4242, 4242, true, true), false, "a host that announced its quit and closed the channel");
	});
});
