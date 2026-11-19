import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { makeTempDirectory, moduleDir, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/event-loop-profile-lifetime.mjs");
const PRELOAD = join(ROOT, "test/fixtures/event-loop-profile-lifetime-preload.cjs");
/** Observe three five-second profile windows while temporary scripts are repeatedly collected. */
const OBSERVE_MS = 16_000;
const PROFILE_LIFETIME_CHILD_TIMEOUT_MS = OBSERVE_MS + 10_000;

test("long-running diagnostics release completed profiles instead of retaining a script catalog (#5544)", () => {
	const root = makeTempDirectory("event-loop-profile-lifetime-");
	try {
		const result = spawnSyncCollect(
			[process.execPath, "--expose-gc", "--require", PRELOAD, FIXTURE, String(OBSERVE_MS)],
			{
				cwd: ROOT,
				timeout: PROFILE_LIFETIME_CHILD_TIMEOUT_MS,
				env: {
					...process.env,
					ATOMIC_CODING_AGENT_DIR: join(root, "agent"),
					ATOMIC_EVENT_LOOP_BLOCK_MS: "2000",
					ATOMIC_EVENT_LOOP_BLOCK_STACKS: undefined,
					ATOMIC_EVENT_LOOP_BLOCK_LOG: join(root, "blocks.jsonl"),
				},
			},
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const report = JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!) as {
			readonly scripts: number;
			readonly completed: number;
			readonly retained: number;
			readonly debuggerCommands: number;
		};
		assert.ok(report.scripts > 100, "the process loaded and collected temporary scripts");
		assert.ok(
			report.completed >= 2,
			`profiles rotate instead of growing for the whole run: ${JSON.stringify(report)}`,
		);
		assert.equal(report.retained, 0, `completed profile objects are collectable: ${JSON.stringify(report)}`);
		assert.equal(report.debuggerCommands, 0, "sampling never enables or controls the debugger");
	} finally {
		removeTempDirectory(root);
	}
});
