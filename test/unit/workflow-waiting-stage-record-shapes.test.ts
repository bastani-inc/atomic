import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { durableStageCheckpointMetadata } from "../../packages/workflows/src/durable/stage-topology.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { reconcileTerminalRunResult } from "../../packages/workflows/src/runs/foreground/executor-lifecycle.js";
import {
	deserializeStageWaitError,
	StageRehydrationError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

/** What the waiting-stage records and reports carry when an optional part is absent: nothing, not a blank. */

function stage(id: string, patch: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status: "running", parentIds: [], toolEvents: [], ...patch };
}

function runOf(stages: StageSnapshot[], patch: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "run-shapes",
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages,
		startedAt: 1,
		...patch,
	};
}

describe("typed waiting-stage failures name what they lack (#4309)", () => {
	test("results a session did not save name the session, the calls and the run as unknown when the stage did not report them (#4309)", () => {
		const error = new StageRehydrationError({ stageName: "implement" }, { code: "results-not-saved" });

		assert.equal(
			error.message,
			'Cannot rehydrate stage "implement": session unknown returned from its detached turn without saving the results of its calls (results-not-saved). ' +
				"Resume the run with /workflow resume <runId>: the stage continues its turn from the results it recorded with its wait, which stay recorded until a turn that uses them is saved.",
		);
	});

	test("a save of woken results that kept failing names the session as unknown when the stage had none yet (#4309)", () => {
		const error = new StageRehydrationError({ stageName: "implement", phase: "resume-turn", attempts: 3 });

		assert.ok(
			error.message.startsWith(
				'Cannot rehydrate stage "implement": session unknown could not save the results the stage was woken with after 3 attempts (session-unavailable).',
			),
			error.message,
		);
	});

	test("a stored rehydration failure whose code this version does not know reads back as a retryable unavailable session (#4309)", () => {
		const stored = new StageRehydrationError({ stageName: "implement" }).toJSON();

		const error = deserializeStageWaitError({ ...stored, code: "session-gone-somewhere" });

		assert.equal(error.code, "session-unavailable");
		assert.equal(error.retryable, true);
		assert.equal(error.message, stored.message);
	});
});

describe("absent waiting-stage parts are left out, not written as undefined (#4309)", () => {
	test("a stage's checkpoint carries the results it keeps only while it keeps some (#4309)", () => {
		const metadata = durableStageCheckpointMetadata(stage("plain"));
		const keeping = durableStageCheckpointMetadata(
			stage("keeping", {
				waitResults: [{ toolCallId: "c1", toolName: "wait_for_ci", content: [], isError: false }],
			}),
		);

		assert.equal(Object.hasOwn(metadata, "waitResults"), false);
		assert.deepEqual(
			keeping.waitResults?.map((result) => result.toolCallId),
			["c1"],
		);
	});

	test("a waiting stage shown without its wait lists no wait in the run's status (#4309)", () => {
		const summary = summarizeRunSnapshot(runOf([stage("bare", { status: "waiting" })]), 10);

		assert.deepEqual(summary.waitingStages, [{ stageId: "bare", name: "bare" }]);
		assert.equal(Object.hasOwn(summary.waitingStages[0]!, "wait"), false);
	});

	test("a stage that ends without a typed failure keeps no failure detail field in the store (#4309)", () => {
		const store = createStore();
		const runId = "run-shapes";
		store.recordRunStart(runOf([]));
		const started = stage("ending");
		store.recordStageStart(runId, started);
		store.recordStageEnd(runId, { ...started, status: "completed", endedAt: 2 });

		const recorded = store.run(runId)?.stages.find((candidate) => candidate.id === "ending");
		assert.equal(recorded?.status, "completed");
		assert.equal(Object.hasOwn(recorded!, "failureDetail"), false);
	});

	test("a run the store holds no terminal record of reports the stages and tool nodes of its own snapshot (#4309)", () => {
		const stages = [stage("one", { status: "completed" })];
		const snapshot = runOf(stages, {
			toolNodes: [{ id: "tool-1", name: "fetch", status: "completed" } as RunSnapshot["toolNodes"][number]],
		});

		const result = reconcileTerminalRunResult(
			"run-shapes",
			snapshot,
			createStore(),
			{ status: "completed" },
			undefined,
		);

		assert.deepEqual(result.stages, stages);
		assert.deepEqual(result.toolNodes, snapshot.toolNodes);
	});
});
