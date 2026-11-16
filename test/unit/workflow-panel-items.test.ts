/**
 * Workflow runs as agent-panel rows: ported from the retired BACKGROUND widget's rendering tests (#5224), which now
 * apply to the panel's run rows.
 */
import assert from "node:assert/strict";
import { visibleWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import {
	type AgentPanelStyle,
	formatPanelElapsed,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";

const plain: AgentPanelStyle = {
	dim: (t) => t,
	text: (t) => t,
	muted: (t) => t,
	border: (t) => t,
	bold: (t) => t,
	accent: (t) => t,
	success: (t) => t,
	error: (t) => t,
	warning: (t) => t,
};

const stage = (id: string, status: StageSnapshot["status"], extra: Partial<StageSnapshot> = {}): StageSnapshot => ({
	id,
	name: id,
	status,
	parentIds: [],
	toolEvents: [],
	...extra,
});

function run(
	id: string,
	status: RunSnapshot["status"],
	stages: StageSnapshot[] = [],
	extra: Partial<RunSnapshot> = {},
) {
	return { id, name: id, inputs: {}, status, toolNodes: [], stages, startedAt: 1_000, ...extra } as RunSnapshot;
}

test("elapsed time reads seconds, minutes, then hours and minutes, and never goes negative (#5224)", () => {
	assert.equal(formatPanelElapsed(-5_000), "0s");
	assert.equal(formatPanelElapsed(59_000), "59s");
	assert.equal(formatPanelElapsed(60_000), "1m");
	assert.equal(formatPanelElapsed(3_600_000), "1h 0m");
	assert.equal(formatPanelElapsed(3_660_000), "1h 1m");
});

test("run states map to panel states: running, paused for blocked and quit, done, failed, stopped (#5224)", () => {
	const items = panelItemsFromSnapshot(
		[
			run("live", "running", [stage("a", "running")]),
			run("blocked", "blocked", [stage("a", "blocked")]),
			run(
				"quit",
				"paused",
				[stage("a", "paused", { pendingPrompt: { id: "p", kind: "confirm", message: "Go?", createdAt: 1 } })],
				{
					exitReason: "quit",
					quitAt: 2_000,
					resumable: true,
				},
			),
			run("done", "completed", [stage("a", "completed")], { endedAt: 61_000 }),
			run("failed", "failed", [stage("a", "failed", { error: "boom\nstack" })], { endedAt: 5_000 }),
			run("cancelled", "cancelled", [], { endedAt: 5_000 }),
		],
		100_000,
	);
	const state = Object.fromEntries(items.map((item) => [item.name, item.state]));
	assert.deepEqual(state, {
		live: "running",
		blocked: "paused",
		quit: "paused",
		done: "done",
		failed: "failed",
		cancelled: "stopped",
	});
	const byName = (name: string) => items.find((item) => item.name === name)!;
	assert.equal(byName("quit").question, undefined, "a quit run waits for resume, not for an answer");
	assert.equal(byName("done").elapsedMs, 60_000, "a finished run's time stops at its end");
	assert.equal(byName("failed").reason, "boom", "a failure reason is one line");
	assert.equal(byName("live").task, "stage a");
});

test("every top-level run gets a row, however many run at once, and nested runs none (#5224)", () => {
	const runs = Array.from({ length: 7 }, (_, index) => run(`root-${index}`, "running"));
	runs.push(run("child", "running", [], { parentRunId: "root-0", rootRunId: "root-0" }));
	assert.deepEqual(
		panelItemsFromSnapshot(runs).map((item) => item.name),
		runs.slice(0, 7).map((item) => item.name),
	);
});

test("stage progress counts settled stages of the run (#5224)", () => {
	const [item] = panelItemsFromSnapshot([
		run("progress", "running", [
			stage("a", "completed"),
			stage("b", "skipped"),
			stage("c", "running"),
			stage("d", "pending"),
		]),
	]);
	assert.deepEqual(item?.progress, { done: 2, total: 4 });
});

test("run rows stay well formed at the requested width with hostile, wide and surrogate text (#5224)", () => {
	const rows = panelItemsFromSnapshot([
		run("\ud83d bad surrogate", "running", [stage("名前の長いステージ\u202e\u0000", "running")]),
		run("zero\u200b\u0301width", "running"),
	]);
	for (const width of [30, 40, 56, 80, 160]) {
		for (const line of renderAgentPanelRows(rows, width, plain)) {
			assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
			const text = line.replace(/\x1b\[[0-9;]*m/g, "");
			assert.doesNotMatch(text, /[\x00-\x1f\x7f\u202e\u200b]/);
			assert.equal(text, text.toWellFormed(), "no unpaired surrogates");
		}
	}
});
