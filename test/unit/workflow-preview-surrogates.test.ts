import assert from "node:assert/strict";
import { test } from "vitest";
import {
	installWorkflowHilAnswerNotifications,
	type WorkflowHilAnswerNoticeDetails,
} from "../../packages/workflows/src/extension/hil-answer-notifications.js";
import { workflowSummaryInput } from "../../packages/workflows/src/extension/workflow-summary.js";
import { truncateTaskOutput } from "../../packages/workflows/src/runs/foreground/executor-task-prompts.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const EMOJI = "😀";

function stage(name: string, result: string): StageSnapshot {
	return { id: name, name, status: "completed", parentIds: [], toolEvents: [], result };
}

function run(inputs: RunSnapshot["inputs"], stages: StageSnapshot[], name = "build"): RunSnapshot {
	const store = createStore();
	store.recordRunStart({
		id: "summary-run",
		name,
		inputs,
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	return { ...store.runs()[0]!, stages };
}

function summaryParts(text: string): { readonly head: string; readonly objective: string; readonly stages: string } {
	const objectiveAt = text.indexOf("\nObjective/inputs:\n");
	const stagesAt = text.indexOf("\nLatest stages and outputs:\n");
	return {
		head: text.slice(0, objectiveAt),
		objective: text.slice(objectiveAt + 19, stagesAt),
		stages: text.slice(stagesAt + 28),
	};
}

test("a workflow summary's inputs and stage outputs are cut without splitting an emoji (#5097)", () => {
	const text = workflowSummaryInput(
		run(
			{
				objective: `${"o".repeat(1_999)}${EMOJI}tail`,
				[`${"k".repeat(99)}${EMOJI}`]: 7,
				structured: { a: 1 },
				missing: null,
			},
			[stage(`${"n".repeat(99)}${EMOJI}`, `${EMOJI}${"r".repeat(1_499)}`), stage("lint", "clean")],
			`${"w".repeat(199)}${EMOJI}`,
		),
	);
	const parts = summaryParts(text);
	assert.equal(parts.head, `Workflow: ${"w".repeat(199)}\nRun: summary-run\nStatus: running`);
	assert.equal(
		parts.objective,
		[
			`objective: ${"o".repeat(1_999)}`,
			`${"k".repeat(99)}: 7`,
			"structured: [structured input]",
			"missing: null",
		].join("\n"),
	);
	assert.equal(parts.stages, `${"n".repeat(99)}: completed\n${"r".repeat(1_499)}\nlint: completed\nclean`);
});

test("a workflow summary keeps the latest 40 stages and cuts its bounded sections without splitting an emoji (#5097)", () => {
	const objective = summaryParts(
		workflowSummaryInput(run({ objective: "a".repeat(1_990), b: `${"b".repeat(1_994)}${EMOJI}rest` }, [])),
	).objective;
	assert.equal(objective, `objective: ${"a".repeat(1_990)}\nb: ${"b".repeat(1_994)}`);

	const stages = Array.from({ length: 41 }, (_, index) => stage(`s${index}`, "r".repeat(10)));
	const latest = summaryParts(workflowSummaryInput(run({}, stages))).stages;
	assert.ok(!latest.includes("s0: completed"));
	assert.ok(latest.startsWith("s1: completed"));

	const longStages = Array.from({ length: 8 }, (_, index) => stage(`s${index}`, "r".repeat(1_500)));
	// Joined, the stages are 12,119 characters; the last 11,000 start at the second half of the emoji in s0.
	longStages[0] = stage("s0", `${"r".repeat(1_104)}${EMOJI}${"r".repeat(394)}`);
	const tail = summaryParts(workflowSummaryInput(run({}, longStages))).stages;
	assert.equal(
		tail,
		`${"r".repeat(394)}\n${longStages
			.slice(1)
			.map((entry) => `${entry.name}: completed\n${entry.result}`)
			.join("\n")}`,
	);
});

test("workflow task output cut to a byte budget never keeps half of an emoji (#5097)", () => {
	assert.equal(
		truncateTaskOutput("ab😀cd", { bytes: 5, lines: 100 }),
		"ab\n\n[workflow output truncated; limits: 5 bytes, 100 lines]",
	);
	assert.equal(truncateTaskOutput("ab😀cd", { bytes: 8, lines: 100 }), "ab😀cd");
});

test("a workflow human-in-the-loop answer notice cuts the prompt before a split emoji (#5097)", () => {
	const store = createStore();
	const sent: { details?: WorkflowHilAnswerNoticeDetails }[] = [];
	const unsubscribe = installWorkflowHilAnswerNotifications({
		store,
		stageUiBroker: new StageUiBroker(store),
		sendMessage(message) {
			sent.push(message as { details?: WorkflowHilAnswerNoticeDetails });
		},
	});
	store.recordRunStart({
		id: "run-1",
		name: "release",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	store.recordStageStart("run-1", { id: "stage-1", name: "review", status: "running", parentIds: [], toolEvents: [] });
	const message = `${"q".repeat(998)}${EMOJI}${"q".repeat(10)}`;
	store.recordStagePendingPrompt("run-1", "stage-1", { id: "prompt-1", kind: "input", message, createdAt: 10 });
	store.resolveStagePendingPrompt("run-1", "stage-1", "prompt-1", "yes");
	store.recordNotice({ id: "tick", level: "info", message: "force notify", createdAt: 20 });
	unsubscribe();

	assert.equal(sent[0]?.details?.promptMessage, `${"q".repeat(998)}…`);
});
