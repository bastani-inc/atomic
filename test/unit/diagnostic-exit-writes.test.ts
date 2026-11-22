import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

/**
 * Structural: each run starts a Node process that compiles the fixture, and the modules it loads, through jiti. On a
 * loaded Windows runner that took longer than 15 s.
 */
const RUN_TIMEOUT_MS = 60_000;
/** A test's budget for its runs, one after another. */
const runsBudget = (runs: number) => runs * RUN_TIMEOUT_MS + 10_000;

function run(mode: string): Record<string, string>[] {
	const directory = makeTempDirectory("atomic-diagnostic-exit-");
	const file = join(directory, "atomic-debug.log");
	try {
		const result = spawnSyncCollect(
			[process.execPath, "--import", "jiti/register", "test/fixtures/diagnostic-exit-writes.ts", mode, file],
			{
				env: { ...process.env, ATOMIC_DEBUG: "1", ATOMIC_CODING_AGENT_DIR: directory },
				timeout: RUN_TIMEOUT_MS,
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

test(
	"debug exit flush writes each landed or queued record exactly once (#5377)",
	() => {
		assert.deepEqual(
			run("debug").map(({ event }) => event),
			["hold", "first", "second", "third"],
		);
		assert.deepEqual(run("debug-landed"), [{ step: "same" }, { step: "same" }, { step: "last" }]);
	},
	runsBudget(2),
);

test(
	"the synchronous debug API finishes its append before returning (#5377)",
	() => {
		assert.deepEqual(run("debug-sync"), [{ step: "first" }, { step: "second" }]);
		assert.deepEqual(
			run("debug-mixed"),
			["ready", ...Array.from({ length: 128 }, (_, index) => String(index)), "sync"].map((step) => ({ step })),
		);
	},
	runsBudget(2),
);

test(
	"lifecycle exit flush writes each landed or queued mark exactly once (#5377)",
	() => {
		assert.deepEqual(
			run("lifecycle").map(({ label }) => label),
			["process-start", "process-entry", "engine-ready"],
		);
	},
	runsBudget(1),
);

test(
	"monitor exit writes the in-flight start before phase records exactly once (#5377)",
	() => {
		assert.deepEqual(
			run("monitor").map(({ type, phase }) => phase ?? type),
			["start", "startup", "session", "shutdown"],
		);
	},
	runsBudget(1),
);
