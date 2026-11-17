import assert from "node:assert/strict";
import { test } from "vitest";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

test("exited holders use the configured Bun executable without a PATH entry (#5331)", () => {
	const executable = bunExecutable();
	const moduleUrl = new URL("../helpers/exited-process.ts", import.meta.url).href;
	const result = spawnSyncCollect(
		[
			executable,
			"--eval",
			`const { exitedProcess } = await import(${JSON.stringify(moduleUrl)});
			process.stdout.write(JSON.stringify(exitedProcess()));`,
		],
		{ env: { ATOMIC_BUN_EXECUTABLE: executable, PATH: "" } },
	);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	const holder = JSON.parse(result.stdout.toString()) as { pid: number };
	assert.ok(Number.isInteger(holder.pid) && holder.pid > 0);
});
