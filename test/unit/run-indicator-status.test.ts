import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	resolveRunIndicatorStatuses,
	runIndicatorStatus,
} from "../../packages/workflows/src/shared/run-indicator-status.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function makeRun(id: string, status: RunSnapshot["status"], stages: StageSnapshot[] = []): RunSnapshot {
	return {
		id,
		name: id,
		inputs: {},
		status,
		stages,
		startedAt: 1,
	};
}

function awaitingStage(id = "ask"): StageSnapshot {
	return {
		id,
		name: id,
		status: "awaiting_input",
		parentIds: [],
		toolEvents: [],
		pendingPrompt: {
			id: `${id}-prompt`,
			kind: "confirm",
			message: "Continue?",
			createdAt: 1,
		},
	};
}

describe("runIndicatorStatus", () => {
	test("returns awaiting_input for a live run-level or stage prompt", () => {
		const runPrompt = makeRun("run-prompt", "running");
		runPrompt.pendingPrompt = { id: "run-prompt-id", kind: "confirm", message: "Continue?", createdAt: 1 };
		assert.equal(runIndicatorStatus(runPrompt), "awaiting_input");
		assert.equal(runIndicatorStatus(makeRun("stage-prompt", "running", [awaitingStage()])), "awaiting_input");
	});

	test("walks parentRunId ancestry and attributes a hidden descendant to its visible ancestor", () => {
		const root = makeRun("root", "running");
		const parent = { ...makeRun("parent", "running"), parentRunId: root.id };
		const child = { ...makeRun("child", "running", [awaitingStage()]), parentRunId: parent.id };
		const unrelated = makeRun("unrelated", "running");
		const allRuns = [root, parent, child, unrelated];

		assert.equal(runIndicatorStatus(root, allRuns), "awaiting_input");
		assert.equal(runIndicatorStatus(parent, allRuns), "awaiting_input");
		assert.equal(runIndicatorStatus(unrelated, allRuns), "running");
		assert.equal(runIndicatorStatus(makeRun("clean", "running"), allRuns), "running");
	});

	test("accepts an explicit rootRunId and does not infer unrelated runs", () => {
		const root = makeRun("root", "running");
		const child = { ...makeRun("child", "running", [awaitingStage()]), rootRunId: root.id, parentRunId: "missing" };
		const unrelated = makeRun("unrelated", "running");
		assert.equal(runIndicatorStatus(root, [root, child, unrelated]), "awaiting_input");
		assert.equal(runIndicatorStatus(unrelated, [root, child, unrelated]), "running");
	});

	test("reverts immediately when a prompt is answered or cancelled", () => {
		const answered = makeRun("answered", "running", [awaitingStage()]);
		assert.equal(runIndicatorStatus(answered), "awaiting_input");
		answered.stages[0]!.status = "running";
		answered.stages[0]!.pendingPrompt = undefined;
		assert.equal(runIndicatorStatus(answered), "running");

		const cancelled = makeRun("cancelled", "running");
		cancelled.pendingPrompt = { id: "cancel-prompt", kind: "input", message: "Continue?", createdAt: 1 };
		assert.equal(runIndicatorStatus(cancelled), "awaiting_input");
		cancelled.pendingPrompt = undefined;
		assert.equal(runIndicatorStatus(cancelled), "running");
	});

	test("terminal and blocked statuses beat stale pending prompts", () => {
		for (const status of ["completed", "failed", "killed", "cancelled", "skipped", "blocked"] as const) {
			const run = makeRun(status, status, [awaitingStage()]);
			run.pendingPrompt = { id: `${status}-prompt`, kind: "confirm", message: "Continue?", createdAt: 1 };
			assert.equal(runIndicatorStatus(run), status);
		}
	});
});

describe("resolveRunIndicatorStatuses", () => {
	test("resolves each listed run against the complete collection into serializable data", () => {
		const root = makeRun("root", "running");
		const child = { ...makeRun("child", "running", [awaitingStage()]), parentRunId: root.id };
		const unrelated = makeRun("unrelated", "running");
		const statuses = resolveRunIndicatorStatuses([root, unrelated], [root, child, unrelated]);
		assert.deepEqual(statuses, { root: "awaiting_input", unrelated: "running" });
		// The record must survive a JSON round-trip: it is persisted with the
		// /workflow status chat payload and consumed after a session restore.
		assert.deepEqual(JSON.parse(JSON.stringify(statuses)), statuses);
	});

	test("keeps terminal precedence and covers only the listed runs", () => {
		const done = makeRun("done", "completed", [awaitingStage()]);
		const hidden = makeRun("hidden", "running", [awaitingStage()]);
		const statuses = resolveRunIndicatorStatuses([done], [done, hidden]);
		assert.deepEqual(statuses, { done: "completed" });
	});
});
