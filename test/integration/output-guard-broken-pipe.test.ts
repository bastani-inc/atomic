import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { NODE_TS_SOURCE_ARGS } from "../helpers/node-ts-sources.js";
import {
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	readTextSync,
	removeTempDirectory,
	sleep,
} from "../helpers/runtime.js";

const OUTPUT_GUARD_MODULE = pathToFileURL(
	join(moduleDir(import.meta.url), "../../packages/coding-agent/src/core/output-guard.ts"),
).href;
/** Longer than starting Node, and a process noticing its reader is gone, takes, however loaded the machine. */
const START_MS = 30_000;
const POLL_MS = 20;

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) removeTempDirectory(root);
});

// An interactive engine whose host was killed exits once a write to its output fails. Its exit then waits for the
// system to give it another parent before it ends its extensions' commands, but only if it knows that write failed: on
// Node the stream's own error event, which nothing listens to, ends the process before a rejection would be handled.
test("a process whose output's reader is gone knows at its exit that a write to its output failed", async () => {
	const root = makeTempDirectory("atomic-output-guard-broken-pipe-");
	roots.push(root);
	const report = join(root, "report");
	const ready = join(root, "ready");
	const script = `
		import { writeFileSync } from "node:fs";
		const guard = await import(${JSON.stringify(OUTPUT_GUARD_MODULE)});
		guard.takeOverStdout();
		process.on("exit", () => writeFileSync(${JSON.stringify(report)}, String(guard.rawStdoutWriteFailed())));
		setInterval(() => guard.writeRawStdout("{}\\n"), 20);
		writeFileSync(${JSON.stringify(ready)}, "");
	`;
	const child = spawn(process.execPath, [...NODE_TS_SOURCE_ARGS, "--input-type=module", "-e", script], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	const guardTimer = setTimeout(() => child.kill("SIGKILL"), START_MS);
	try {
		const deadline = Date.now() + START_MS;
		while (!fileExistsSync(ready) && Date.now() < deadline) await sleep(POLL_MS);
		assert.ok(fileExistsSync(ready), "the process did not start");

		child.stdout.destroy();
		await exited;

		assert.equal(fileExistsSync(report) ? readTextSync(report, "utf8") : "no report", "true");
	} finally {
		clearTimeout(guardTimer);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
});
