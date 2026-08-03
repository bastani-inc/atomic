import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

describe("SessionManager physical append failures", () => {
	test("rolls back partial single and batch writes before reopen and retry", () => {
		const preload = join(moduleDir(import.meta.url), "../fixtures/session-manager-partial-append-preload.ts");
		const probe = join(moduleDir(import.meta.url), "../fixtures/session-manager-partial-append-probe.ts");
		const child = spawnSyncCollect({
			cmd: [bunExecutable(), "--preload", preload, probe],
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = child.stderr.toString();
		assert.equal(child.exitCode, 0, stderr);
		assert.deepEqual(JSON.parse(child.stdout.toString()) as object, { later: "ok", batch: "ok" });
	});
});
