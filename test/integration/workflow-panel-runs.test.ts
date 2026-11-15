/**
 * The agent panel's workflow rows against a real store and answer path: a run's question shows on its row until it is
 * answered or cancelled (#5224, formerly the BACKGROUND widget's pending-input preview, #2529 / #3027).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflowAnswerAction } from "../../packages/workflows/src/extension/workflow-tool-answer.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { panelRunsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
import { testRunId } from "../helpers/run-id.js";

const runIds = new Set<string>();

afterEach(() => {
	for (const runId of runIds) store.removeRun(runId);
	runIds.clear();
});

function makeRun(seed: string, name: string, stages: StageSnapshot[], startedAt = Date.now()) {
	const id = testRunId(seed);
	runIds.add(id);
	store.recordRunStart({ id, name, inputs: {}, status: "running", toolNodes: [], stages, startedAt });
	return id;
}

const stage = (id: string, status: StageSnapshot["status"], parentIds: string[] = []): StageSnapshot =>
	({ id, name: id, status, parentIds, toolEvents: [] }) as StageSnapshot;

function prompt(id: string, message: string): PendingPrompt {
	return { id, kind: "input", message, createdAt: Date.now() };
}

function row(runId: string) {
	return panelRunsFromSnapshot(store.runs()).find((run) => run.runId === runId);
}

test("a run's row names its current stage and counts its settled stages (#5224)", () => {
	const runId = makeRun("panel-progress", "ralph", [
		stage("plan", "completed"),
		stage("implement", "running", ["plan"]),
		stage("review", "pending", ["implement"]),
	]);
	const run = row(runId);
	assert.equal(run?.name, "ralph");
	assert.equal(run?.status, "running");
	assert.equal(run?.awaitingInput, false);
	assert.equal(run?.currentStage, "implement");
	assert.equal(run?.stagesDone, 1);
	assert.equal(run?.stagesTotal, 3);
	assert.ok((run?.elapsedMs ?? -1) >= 0);
});

test("a waiting question shows on the run's row until it is answered (#5224)", async () => {
	const runId = makeRun("panel-question", "answerable", [stage("ask", "running")]);
	assert.equal(store.recordStagePendingPrompt(runId, "ask", prompt("answer-prompt", "Approve the plan?")), true);
	assert.equal(row(runId)?.awaitingInput, true);
	assert.equal(row(runId)?.question, "Approve the plan?");
	assert.equal(row(runId)?.currentStage, "ask");

	const result = await workflowAnswerAction({ runId, text: "ship it" });
	assert.equal(result.status, "ok");
	assert.equal(row(runId)?.awaitingInput, false);
	assert.equal(row(runId)?.question, undefined);
});

test("a failed run's row carries a one-line reason (#5224)", () => {
	const runId = makeRun("panel-failed", "broken", [stage("build", "running")]);
	store.recordStageEnd(runId, {
		...stage("build", "failed"),
		error: "npm ERR! missing script: build\n    at run (cli.js:1:1)",
	} as StageSnapshot);
	store.recordRunEnd(runId, "failed", undefined, "stage build failed");
	const run = row(runId);
	assert.equal(run?.status, "failed");
	assert.ok(run?.endedAt !== undefined);
	assert.ok(run?.reason !== undefined && !run.reason.includes("\n"), "the reason is one line");
});
