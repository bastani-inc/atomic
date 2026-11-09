/**
 * Stages suspended with their session released read as suspended, and say what they wait on, on every surface (#4309, #4589).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { summarizeStage } from "../../packages/workflows/src/extension/workflow-stage-results.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import type { StageWaitSnapshot } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { progressStrip } from "../../packages/workflows/src/tui/chat-surface.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderHeader } from "../../packages/workflows/src/tui/header.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import { statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import { renderSwitcher } from "../../packages/workflows/src/tui/switcher.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const plain = (lines: string | readonly string[]) =>
	(typeof lines === "string" ? lines : lines.join("\n")).replace(ANSI_RE, "");
const theme = deriveGraphTheme({});
const NOW = Date.now();

const TOOL_WAIT: StageWaitSnapshot = {
	kind: "tool",
	since: NOW - 5_000,
	toolCalls: [{ toolCallId: "call-1", toolName: "wait_ci" }],
	promptsCompleted: 0,
};
const RELEASE_WAIT: StageWaitSnapshot = { kind: "release", since: NOW - 5_000, promptsCompleted: 1 };
const IDLE_WAIT: StageWaitSnapshot = { kind: "idle", since: NOW - 5_000, promptsCompleted: 1 };
const PROMPT_WAIT: StageWaitSnapshot = { kind: "prompt", since: NOW - 5_000, promptsCompleted: 1 };

function stage(
	name: string,
	status: StageSnapshot["status"],
	wait?: StageWaitSnapshot,
	patch: Partial<StageSnapshot> = {},
): StageSnapshot {
	return {
		id: `id-${name}`,
		name,
		status,
		parentIds: [],
		toolEvents: [],
		startedAt: NOW - 10_000,
		...(wait === undefined ? {} : { wait }),
		...patch,
	};
}

function run(stages: StageSnapshot[], patch: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "run-1",
		name: "waiting-demo",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages,
		startedAt: NOW - 20_000,
		...patch,
	};
}

function statusText(snapshot: RunSnapshot): string {
	return renderWorkflowToolContent(
		{ action: "status", filter: "all", runs: [summarizeRunSnapshot(snapshot, NOW)], snapshots: [snapshot] },
		{ action: "status" },
	);
}

test("the stages summary carries the wait of a suspended stage, as JSON and in the text (#4309, #4589)", () => {
	const stages = [
		stage("ci", "suspended", TOOL_WAIT),
		stage("held", "suspended", RELEASE_WAIT),
		stage("parked", "suspended", IDLE_WAIT),
		stage("asked", "awaiting_input", PROMPT_WAIT),
		stage("busy", "running"),
	];
	const summaries = stages.map(summarizeStage);
	assert.deepEqual(summaries[0]?.wait, TOOL_WAIT);
	assert.equal(summaries[4]?.wait, undefined);

	const json = JSON.parse(
		renderWorkflowToolContent(
			{ action: "stages", runId: "run-1", filter: "all", stages: summaries },
			{ action: "stages", format: "json" },
		),
	) as { stages: { name: string; wait?: StageWaitSnapshot }[] };
	assert.deepEqual(json.stages[0]?.wait, { ...TOOL_WAIT });
	assert.equal(json.stages[0]?.wait?.toolCalls?.[0]?.toolName, "wait_ci");
	assert.equal(json.stages[4]?.wait, undefined);

	const text = renderWorkflowToolContent(
		{ action: "stages", runId: "run-1", filter: "all", stages: summaries },
		{ action: "stages" },
	);
	assert.match(text, /\[1\] ci \(id-ci\) suspended \(tool: wait_ci\)\n/);
	assert.match(text, /\[2\] held \(id-held\) suspended \(between turns\)\n/);
	assert.match(text, /\[3\] parked \(id-parked\) suspended \(between turns\)\n/);
	assert.match(text, /\[4\] asked \(id-asked\) awaiting_input \(released\)\n/);
	assert.match(text, /\[5\] busy \(id-busy\) running$/);
});

test("the status summary lists the suspended stages with what each waits on (#4309, #4589)", () => {
	const summary = summarizeRunSnapshot(
		run([stage("ci", "suspended", TOOL_WAIT), stage("held", "suspended", RELEASE_WAIT), stage("busy", "running")]),
		NOW,
	);
	assert.equal(summary.suspendedCount, 2);
	assert.deepEqual(
		summary.suspendedStages.map((waiting) => [waiting.stageId, waiting.name, waiting.wait?.kind]),
		[
			["id-ci", "ci", "tool"],
			["id-held", "held", "release"],
		],
	);
});

test("the status text names the suspended stages of a run whose stages all wait (#4309, #4589)", () => {
	const text = statusText(run([stage("ci", "suspended", TOOL_WAIT), stage("held", "suspended", RELEASE_WAIT)]));
	assert.match(text, /suspended \(2\): ci \(tool: wait_ci\), held \(between turns\)/);

	const mixed = statusText(run([stage("ci", "suspended", TOOL_WAIT), stage("busy", "running")]));
	assert.match(mixed, /stage: busy · suspended \(1\): ci \(tool: wait_ci\)/);

	assert.doesNotMatch(statusText(run([stage("busy", "running")])), /suspended \(/);
});

test("a suspended stage shows the suspended glyph, not the pending one, in node cards, status rows and the strip (#4309, #4589)", () => {
	assert.equal(statusIcon("suspended"), "◷");
	assert.notEqual(statusIcon("suspended"), statusIcon("pending"));

	const waiting = stage("ci", "suspended", TOOL_WAIT);
	assert.match(plain(renderNodeCard(waiting, { theme, width: 26 })), /◷ suspended/);
	assert.match(plain(renderNodeCard(stage("later", "pending"), { theme, width: 26 })), /○ pending/);

	const detail = plain(
		renderRunDetail(
			{
				runId: "run-1",
				name: "waiting-demo",
				status: "running",
				mode: "single",
				startedAt: NOW - 20_000,
				inputs: {},
				stages: [waiting, stage("later", "pending")],
				tools: [],
			},
			{ theme, now: NOW, width: 100 },
		),
	);
	assert.match(detail, /◷ ci\s+suspended/);
	assert.match(detail, /○ later\s+pending/);

	assert.match(
		plain(renderSwitcher([waiting], { query: "", selectedIndex: -1 }, { theme, width: 60 })),
		/◷ ci\s+suspended/,
	);
	assert.equal(
		plain(progressStrip([{ status: "suspended" }, { status: "pending" }, { status: "running" }], 40)),
		"[◷][○][●]",
	);
	assert.equal(plain(progressStrip([{ status: "suspended" }], 40, theme)), "[◷]");
	assert.match(plain(renderHeader(run([waiting]), { theme, width: 100 })), /◷ 1/);
});
