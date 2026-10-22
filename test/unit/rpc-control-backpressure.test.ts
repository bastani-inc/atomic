import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

test("queue controls bypass flooded stdout without dropping or reordering prompt output (#3865)", () => {
	const result = spawnSyncCollect([
		bunExecutable(),
		join(moduleDir(import.meta.url), "fixtures/rpc-control-backpressure.ts"),
	]);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	const report = JSON.parse(result.stdout.toString()) as {
		handledBeforeDrain: string[];
		handled: string[];
		preservedFrames: boolean;
		output: string[];
	};
	const controls = [
		"pause_queued_messages",
		"resume_queued_messages",
		"clear_queue",
		"abort",
		"abort_bash",
		"abort_compaction",
		"abort_retry",
		"cancel_login_provider",
	];
	assert.deepEqual(report.handledBeforeDrain, controls, "controls must run before the output backlog drains");
	assert.deepEqual(
		report.handled,
		[...controls, "prompt", "bash"],
		"ordinary and concurrent work must retain their admission barrier",
	);
	assert.equal(report.preservedFrames, true, "all pre-existing output must retain its original order");
	const output = report.output.map((line) => JSON.parse(line) as { type: string; requestId?: string; id?: string });
	assert.equal(output.filter((frame) => frame.type === "response").length, controls.length + 2);
	for (const id of ["prompt", "bash", ...controls]) {
		const admission = output.findIndex((frame) => frame.type === "engine_request_accepted" && frame.requestId === id);
		const response = output.findIndex((frame) => frame.type === "response" && frame.id === id);
		assert.ok(admission >= 0 && response > admission, `${id} must retain ordered admission and response frames`);
	}
});
