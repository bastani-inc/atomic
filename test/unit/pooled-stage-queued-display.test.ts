/**
 * A stage on a local worker reads as queued, with what it is doing, until its session has started;
 * then it reads as running (#3996). Display only: its stored status stays `running`.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { summarizeStage } from "../../packages/workflows/src/extension/workflow-stage-results.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import type { StageStartupSnapshot } from "../../packages/workflows/src/shared/stage-startup.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderHeader } from "../../packages/workflows/src/tui/header.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import { renderSwitcher } from "../../packages/workflows/src/tui/switcher.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const plain = (lines: string | readonly string[]) =>
	(typeof lines === "string" ? lines : lines.join("\n")).replace(ANSI_RE, "");
const theme = deriveGraphTheme({});
// The graph node and tool text read the clock themselves.
const NOW = Date.now();

function startup(step: StageStartupSnapshot["phase"], state: StageStartupSnapshot["state"]): StageStartupSnapshot {
	return {
		phase: step,
		startedAt: NOW - 32_000,
		phaseStartedAt: NOW - 5_000,
		state,
		ownershipPending: state === "active",
	};
}

/** A stage of a child on a local worker, at one point of its session's startup. */
function workerStage(starting?: StageStartupSnapshot): StageSnapshot {
	return {
		id: "s1",
		name: "review",
		status: "running",
		parentIds: [],
		toolEvents: [],
		startedAt: NOW - 32_000,
		workerExecution: { worker: "worker-1", generation: 1, renewedAt: NOW, expiresAt: NOW + 30_000 },
		...(starting === undefined ? {} : { startup: starting }),
	};
}

function run(stage: StageSnapshot): RunSnapshot {
	return {
		id: "child",
		name: "child-wf",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [stage],
		startedAt: NOW - 40_000,
	};
}

/** Every place a stage's state shows: graph node, graph header, stage list, status card and workflow tool text. */
function surfaces(stage: StageSnapshot) {
	return {
		node: plain(renderNodeCard(stage, { theme, width: 26 })),
		header: plain(renderHeader(run(stage), { theme, width: 100 })),
		list: plain(renderSwitcher([stage], { query: "", selectedIndex: -1 }, { theme, width: 60 })),
		status: plain(
			renderRunDetail(
				{
					runId: "child",
					name: "child-wf",
					status: "running",
					mode: "single",
					startedAt: NOW - 40_000,
					inputs: {},
					stages: [stage],
					tools: [],
				},
				{ theme, now: NOW, width: 100 },
			),
		),
		tool: renderWorkflowToolContent(
			{ action: "stages", runId: "child", filter: "all", stages: [summarizeStage(stage)] },
			{ action: "stages" },
		),
	};
}

test("a stage on a local worker reads as queued while its session starts, then running once it has started (#3996)", () => {
	const creating = surfaces(workerStage(startup("sdk-creation", "active")));
	assert.match(creating.node, /○ queued/);
	assert.match(creating.node, /creating session \d+s/);
	assert.doesNotMatch(creating.node, /running/);
	assert.match(creating.header, /○ 1/);
	assert.doesNotMatch(creating.header, /● 1/);
	assert.match(creating.list, /○ review\s+queued/);
	assert.match(creating.status, /○ review\s+queued\s+creating session/);
	assert.match(creating.tool, /\[1\] review \(s1\) queued \(starting on its local worker: creating session 32s\)/);

	const loading = surfaces(workerStage(startup("resource-preparation", "active")));
	assert.match(loading.node, /○ queued/);
	assert.match(loading.node, /loading resources \d+s/);

	for (const started of [
		workerStage(startup("first-dispatch", "dispatched")),
		workerStage(startup("ready", "active")),
	]) {
		const shown = surfaces(started);
		assert.match(shown.node, /● running/);
		assert.match(shown.header, /● 1/);
		assert.match(shown.list, /● review\s+running/);
		assert.match(shown.status, /● review\s+running/);
		assert.match(shown.tool, /\[1\] review \(s1\) running\n/);
		assert.doesNotMatch(shown.tool, /queued/);
	}
	assert.equal(workerStage(startup("sdk-creation", "active")).status, "running", "the stored status is unchanged");
});

test("only stages on local workers read as queued while starting; an in-process stage keeps reading as running (#3996)", () => {
	const { workerExecution: _worker, ...inProcess } = workerStage(startup("sdk-creation", "active"));
	const shown = surfaces(inProcess);
	assert.match(shown.node, /● running/);
	assert.match(shown.list, /● review\s+running/);
});
