import assert from "node:assert/strict";
import type { Usage } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { runVerbatimCompaction } from "../../packages/coding-agent/src/core/compaction/compaction-runner.js";
import { preparation, runRequest, scriptedStream, testModel } from "./compaction-rung-support.js";

function usage(input: number, output: number, cost: number): Partial<Usage> {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

test("aggregates billed usage across planner retries", async () => {
	const model = testModel();
	const stream = scriptedStream({
		[model.id]: [
			{ errorMessage: "429 Too Many Requests", usage: usage(100, 10, 0.01) },
			{ text: "1,10\n", usage: usage(200, 20, 0.02) },
		],
	});

	const result = await runVerbatimCompaction(
		preparation(),
		model,
		runRequest({
			streamFn: stream.streamFn,
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		}),
	);

	assert.equal(stream.calls.length, 2);
	assert.deepEqual(result.usage, {
		input: 300,
		output: 30,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 330,
		cost: { input: 0.03, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
	});
});
