import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

/**
 * `test/setup-packaged-local-worker.ts` points every integration test's local worker and pool coordinator at the
 * shipped bundle. Were it to stop matching the entry the pool forks (a moved file, a Windows path spelled differently),
 * every pool test would silently go back to transpiling the workflow sources through jiti in each process and time out
 * its workers again under load.
 */
const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const sourceEntry = resolve(repoRoot, "packages/workflows/src/workers/local-worker-entry.mjs");
const packagedEntry = resolve(repoRoot, "packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs");

test("integration tests fork the shipped local worker bundle where the pool names the source entry", async () => {
	const child = fork(sourceEntry, [JSON.stringify({ role: "pool-coordinator" })], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		execArgv: [],
	});
	try {
		assert.equal(resolve(child.spawnargs[1] ?? ""), packagedEntry);
	} finally {
		child.kill("SIGKILL");
		if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
	}
});
