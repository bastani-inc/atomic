import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
	waitUntilGone,
} from "../helpers/recorded-process.js";
import {
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	readTextSync,
	removeTempDirectory,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

const EXEC_MODULE = pathToFileURL(
	join(moduleDir(import.meta.url), "../../packages/coding-agent/dist/core/exec.js"),
).href;
/** Longer than starting Node and its commands takes, however loaded the machine. */
const START_MS = 30_000;
const POLL_MS = 20;
/** Longer than a killed process takes to be gone, however loaded the machine. */
const GONE_MS = 5_000;

const roots: string[] = [];
const processes: RecordedProcess[] = [];

afterEach(async () => {
	for (const recorded of processes.splice(0)) await signalRecordedProcess(recorded);
	for (const root of roots.splice(0)) removeTempDirectory(root);
});

async function recordedFrom(file: string): Promise<RecordedProcess> {
	const deadline = Date.now() + START_MS;
	while (!(fileExistsSync(file) && readTextSync(file, "utf8") !== "") && Date.now() < deadline) await sleep(POLL_MS);
	const recorded = await recordProcess(Number(readTextSync(file, "utf8")));
	processes.push(recorded);
	return recorded;
}

/** A command that records its pid in `file` and runs until it is ended. */
function command(file: string): string {
	return `require("node:fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000);`;
}

// Where Atomic starts its commands through its native module, the kernel ends such a command with the process that
// started it. Windows ends it with that process too; on macOS it keeps running.
describe.runIf(process.platform === "linux")("a process running extensions' pi.exec commands is killed", () => {
	test("a command its session's quit would stop ends with it, and a command a shutdown handler started does not", async () => {
		const root = makeTempDirectory("atomic-exec-ends-with-process-");
		roots.push(root);
		const stopped = join(root, "stopped.pid");
		const kept = join(root, "kept.pid");
		const script = `import(${JSON.stringify(EXEC_MODULE)}).then(({ execCommand }) => {
	void execCommand(process.execPath, ["-e", ${JSON.stringify(command(stopped))}], process.cwd(), undefined, () => () => {});
	void execCommand(process.execPath, ["-e", ${JSON.stringify(command(kept))}], process.cwd());
	setInterval(() => {}, 1000);
});`;
		const host = spawnProcess([process.execPath, "-e", script], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "inherit",
		});
		const hostProcess = await recordProcess(host.pid!);
		processes.push(hostProcess);
		const stoppedCommand = await recordedFrom(stopped);
		const keptCommand = await recordedFrom(kept);

		await signalRecordedProcess(hostProcess, "SIGKILL");

		assert.equal(await waitUntilGone(stoppedCommand, GONE_MS), true, "the command outlived the killed process");
		assert.equal(await stillRuns(keptCommand), true, "a command no quit stops ended with the process");
	});
});
