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
import { execCommand } from "../src/core/exec.ts";

/** Longer than a killed process takes to be gone, however loaded the machine. */
const GONE_MS = 5_000;
const POLL_MS = 20;
/** Longer than a SIGKILLed process takes to be gone; a process still there after it was not signalled. */
const KILL_SEEN_MS = 1_000;
/** The command's timeout: longer than starting it and the process it starts takes, however loaded the machine. */
const COMMAND_TIMEOUT_MS = 8_000;
/** How long a process that ignores SIGTERM has before SIGKILL, as `pi.exec` documents. */
const FORCE_KILL_DELAY_MS = 5_000;

const directories: string[] = [];
const processes: RecordedProcess[] = [];

afterEach(async () => {
	for (const recorded of processes.splice(0)) await signalRecordedProcess(recorded);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function pidFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-exec-abort-"));
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
 * A command that starts a process of its own in the background, as `sleep 1000 &` does, which records its pid in
 * `file`; both run until they are ended. `detached` starts it in a session of its own, `deaf` has it ignore SIGTERM.
 */
function commandStartingAProcess(file: string, options: { detached?: boolean; deaf?: boolean } = {}): string[] {
	const child = `${options.deaf ? 'process.on("SIGTERM", () => {});' : ""}require("node:fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000);`;
	const root = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore", detached: ${options.detached === true} }).unref(); setInterval(() => {}, 1000);`;
	return ["-e", root];
}

describe("a pi.exec command ended by Atomic ends with the processes it started", () => {
	for (const how of ["abort", "timeout"] as const) {
		test(`on ${how === "abort" ? "an abort" : "its timeout"}`, async () => {
			const file = pidFile();
			const controller = new AbortController();
			const running = execCommand(
				process.execPath,
				commandStartingAProcess(file),
				process.cwd(),
				how === "abort" ? { signal: controller.signal } : { timeout: COMMAND_TIMEOUT_MS },
			);
			const started = await recordedFrom(file);

			if (how === "abort") controller.abort();
			const result = await running;

			assert.equal(result.killed, true);
			assert.equal(result.code, 143, "the command itself reports SIGTERM");
			assert.equal(await waitUntilGone(started, GONE_MS), true, "the process the command started outlived it");
		});
	}

	test("also when the output limit ends it", async () => {
		const file = pidFile();
		const [flag, root] = commandStartingAProcess(file);
		const running = execCommand(
			process.execPath,
			[flag!, `${root} setTimeout(() => process.stdout.write("x".repeat(4096)), 300);`],
			process.cwd(),
			{ maxBuffer: 1024 },
		);
		const started = await recordedFrom(file);

		const result = await running;

		assert.equal(result.truncated, true);
		assert.equal(await waitUntilGone(started, GONE_MS), true, "the process the command started outlived it");
	});

	// On Windows the command's process tree ends at once.
	test.skipIf(process.platform === "win32")(
		"a process that ignores SIGTERM gets SIGKILL after five seconds, also once the command itself exited",
		async () => {
			const file = pidFile();
			const controller = new AbortController();
			const running = execCommand(process.execPath, commandStartingAProcess(file, { deaf: true }), process.cwd(), {
				signal: controller.signal,
			});
			const started = await recordedFrom(file);

			controller.abort();
			await running;

			assert.equal(await waitUntilGone(started, FORCE_KILL_DELAY_MS + GONE_MS), true);
		},
	);

	// A tree kill on Windows follows parent links, which a detached process keeps.
	test.skipIf(process.platform === "win32")(
		"leaves a program the command started in a session of its own running",
		async () => {
			const file = pidFile();
			const controller = new AbortController();
			const running = execCommand(
				process.execPath,
				commandStartingAProcess(file, { detached: true }),
				process.cwd(),
				{ signal: controller.signal },
			);
			const detached = await recordedFrom(file);

			controller.abort();
			await running;

			assert.equal(await waitUntilGone(detached, KILL_SEEN_MS), false, "a program that detached itself was ended");
		},
	);
});
