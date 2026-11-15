import assert from "node:assert/strict";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

const echoStdin = [process.execPath, "-e", "process.stdin.pipe(process.stdout)"];

test("spawnSyncCollect treats a stdio mode as a mode, not as text for the child's stdin", () => {
	for (const stdin of ["ignore", "pipe"] as const) {
		const result = spawnSyncCollect(echoStdin, { stdin });
		assert.equal(result.exitCode, 0, stdin);
		assert.equal(result.stdout.toString(), "", stdin);
	}
	assert.equal(spawnSyncCollect(echoStdin, { stdin: "ignored text" }).stdout.toString(), "ignored text");
});
