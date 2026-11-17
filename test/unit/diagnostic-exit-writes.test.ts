import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

function run(mode: string): Record<string, string>[] {
	const directory = makeTempDirectory("atomic-diagnostic-exit-");
	const file = join(directory, "atomic-debug.log");
	try {
		const result = spawnSyncCollect(
			[process.execPath, "--import", "jiti/register", "test/fixtures/diagnostic-exit-writes.ts", mode, file],
			{
				env: { ...process.env, ATOMIC_DEBUG: "1", ATOMIC_CODING_AGENT_DIR: directory },
				timeout: 15_000,
			},
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		return readFileSync(file, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, string>);
	} finally {
		removeTempDirectory(directory);
	}
}

test("debug exit flush writes each landed or queued record exactly once (#5377)", () => {
	assert.deepEqual(
		run("debug").map(({ event }) => event),
		["first", "second", "third"],
	);
	assert.deepEqual(run("debug-landed"), [{ step: "same" }, { step: "same" }, { step: "last" }]);
});

test("the synchronous debug API finishes its append before returning (#5377)", () => {
	assert.deepEqual(run("debug-sync"), [{ step: "first" }, { step: "second" }]);
	assert.deepEqual(
		run("debug-mixed"),
		["ready", ...Array.from({ length: 128 }, (_, index) => String(index)), "sync"].map((step) => ({ step })),
	);
});

test("lifecycle exit flush writes each landed or queued mark exactly once (#5377)", () => {
	assert.deepEqual(
		run("lifecycle").map(({ label }) => label),
		["process-start", "process-entry", "engine-ready"],
	);
});

test("monitor exit writes the in-flight start before phase records exactly once (#5377)", () => {
	assert.deepEqual(
		run("monitor").map(({ type, phase }) => phase ?? type),
		["start", "startup", "session", "shutdown"],
	);
});
