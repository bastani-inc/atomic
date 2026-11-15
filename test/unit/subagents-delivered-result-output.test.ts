import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { createSubagentControl } from "../../packages/subagents/src/runs/inprocess/runner.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const stats = {
	sessionFile: undefined,
	sessionId: "child-session",
	userMessages: 1,
	assistantMessages: 1,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 2,
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	cost: 0,
};

test("a run's control hands a child's output to its caller and keeps only what status reads (#5186)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-delivered-output-"));
	roots.push(root);
	const control = createSubagentControl({ path: "run-5186", depth: 0 }, join(root, "sessions"));
	const output = `final answer ${"x".repeat(64 * 1024)}`;
	const artifactsDir = join(root, "artifacts");

	const delivered = await control.deliverChildResult({
		path: "run-5186/child",
		status: "ok",
		stats,
		envelope: output,
		model: "provider/model",
		sessionFile: join(root, "child.jsonl"),
		timestamp: 1,
		artifactsDir,
	});

	assert.equal(delivered, output, "the caller receives the child's output");
	const kept = control.getDeliveredResult("run-5186/child");
	assert.ok(kept, "status still reads the delivered result");
	assert.equal("envelope" in kept, false, "the control keeps no copy of the output");
	assert.equal(kept.model, "provider/model");
	assert.equal(kept.sessionFile, join(root, "child.jsonl"));
	assert.equal(
		readFileSync(join(artifactsDir, "run-5186_child_output.md"), "utf8"),
		output,
		"the output is saved with the run's artifacts",
	);
	assert.equal(
		await control.deliverChildResult({
			path: "run-5186/child",
			status: "ok",
			stats,
			envelope: "again",
			timestamp: 2,
		}),
		undefined,
		"a result is delivered once",
	);
});
