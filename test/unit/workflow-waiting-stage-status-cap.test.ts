/**
 * The status text of a run with many waiting stages stays one bounded line (#4309).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const NOW = Date.now();
const NAMED_STAGES = 10;

function waitingStage(index: number): StageSnapshot {
	return {
		id: `id-${index}`,
		name: `agent-${index}`,
		status: "suspended",
		parentIds: [],
		toolEvents: [],
		startedAt: NOW - 10_000,
		wait: { kind: "release", since: NOW - 5_000, promptsCompleted: 1 },
	};
}

function statusText(stageCount: number): string {
	const snapshot: RunSnapshot = {
		id: "run-1",
		name: "waiting-demo",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: Array.from({ length: stageCount }, (_, index) => waitingStage(index)),
		startedAt: NOW - 20_000,
	};
	return renderWorkflowToolContent(
		{ action: "status", filter: "all", runs: [summarizeRunSnapshot(snapshot, NOW)], snapshots: [snapshot] },
		{ action: "status" },
	);
}

test("500 suspended stages produce a bounded status line that names 10 and counts all (#4309, #4589)", () => {
	const text = statusText(500);
	const line = text.split("\n").find((candidate) => candidate.includes("suspended ("));
	assert.ok(line !== undefined, text);
	assert.match(line, /suspended \(500\): /);
	assert.equal(line.match(/agent-\d+/g)?.length, NAMED_STAGES);
	assert.match(line, /agent-9 \(between turns\), …, \+490 more/);
	assert.ok(line.length < 500, `status line is ${line.length} characters`);
});

test("a run with exactly 10 suspended stages names them all and omits the overflow marker (#4309, #4589)", () => {
	const text = statusText(NAMED_STAGES);
	assert.match(text, /suspended \(10\): agent-0 \(between turns\)/);
	assert.equal(text.match(/agent-\d+/g)?.length, NAMED_STAGES);
	assert.doesNotMatch(text, /more/);
});
