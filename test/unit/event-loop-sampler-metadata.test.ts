import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { makeTempDirectory, moduleDir, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/event-loop-sampler-metadata.ts");
const PRELOAD = join(ROOT, "test/fixtures/event-loop-sampler-metadata-preload.cjs");
const SCRIPT_COUNT = 500;
const SCRIPT_EVENT_DELAY_MS = 4;
const APPLICATION_BLOCK_MS = 200;
const BLOCK_THRESHOLD_MS = APPLICATION_BLOCK_MS / 2;
const WORKER_METADATA_MS = SCRIPT_COUNT * SCRIPT_EVENT_DELAY_MS;
/** Separate the bounded application work from a main thread held for the worker's entire metadata delivery. */
const MAIN_THREAD_DELAY_BOUND_MS = APPLICATION_BLOCK_MS + WORKER_METADATA_MS / 2;
const TURN_GAP_MS = 1_000;
const OBSERVE_MS = WORKER_METADATA_MS + TURN_GAP_MS / 2;
/** A real diagnostic child, its worker startup, three application pulses and the final observation window. */
const DIAGNOSTIC_CHILD_TIMEOUT_MS = 20_000;

test("the block diagnostic does not pause the main thread while debugger script metadata arrives (#5544)", () => {
	const directory = makeTempDirectory("event-loop-sampler-metadata-");
	try {
		const result = spawnSyncCollect(
			[
				process.execPath,
				"--require",
				PRELOAD,
				"--import",
				"jiti/register",
				FIXTURE,
				String(SCRIPT_COUNT),
				String(APPLICATION_BLOCK_MS),
				String(TURN_GAP_MS),
				String(OBSERVE_MS),
			],
			{
				cwd: ROOT,
				env: {
					...process.env,
					ATOMIC_CODING_AGENT_DIR: join(directory, "agent"),
					ATOMIC_EVENT_LOOP_BLOCK_MS: String(BLOCK_THRESHOLD_MS),
					ATOMIC_EVENT_LOOP_BLOCK_LOG: join(directory, "blocks.jsonl"),
					ATOMIC_TEST_SCRIPT_EVENT_DELAY_MS: String(SCRIPT_EVENT_DELAY_MS),
				},
				timeout: DIAGNOSTIC_CHILD_TIMEOUT_MS,
			},
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const report = JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!) as {
			readonly started: boolean;
			readonly maxDelayMs: number;
		};
		assert.equal(report.started, true);
		assert.ok(
			report.maxDelayMs < MAIN_THREAD_DELAY_BOUND_MS,
			`debugger metadata held the main thread for ${report.maxDelayMs.toFixed(1)} ms; bound ${MAIN_THREAD_DELAY_BOUND_MS} ms`,
		);
	} finally {
		removeTempDirectory(directory);
	}
});
