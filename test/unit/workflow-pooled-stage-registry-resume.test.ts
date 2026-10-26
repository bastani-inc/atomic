/**
 * Resuming a pooled stage through an SDK caller's registry keeps the resume message (#3996).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { RegisteredPooledStageHandle } from "../../packages/workflows/src/workers/pooled-stage-registry.js";
import { testRunId } from "../helpers/run-id.js";

test("resuming a paused pooled stage through its registered handle forwards the resume message (#3996)", async () => {
	const store = createStore();
	const runId = testRunId("pooled-registry-resume");
	const stage = {
		id: "agent",
		name: "agent",
		status: "paused" as const,
		parentIds: [],
		toolEvents: [],
		sessionId: "session",
		workerExecution: { worker: "worker-1", generation: 1, renewedAt: 1, expiresAt: 2 },
	};
	store.recordRunStart({
		id: runId,
		name: "pooled-child",
		inputs: {},
		status: "paused",
		toolNodes: [],
		startedAt: 1,
		stages: [stage],
	});
	const resumed: (string | undefined)[] = [];
	const live: StageControlHandle = {
		runId,
		stageId: "agent",
		stageName: "agent",
		status: "paused",
		sessionId: "session",
		sessionFile: undefined,
		isStreaming: false,
		messages: [],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {},
		async resume(message) {
			resumed.push(message);
			return message === undefined ? undefined : "prompt";
		},
		subscribe: () => () => {},
	};
	const registry = createStageControlRegistry();
	registry.register(
		new RegisteredPooledStageHandle(
			runId,
			stage,
			{ kind: "local-worker", workId: "work", generation: 1 },
			async () => ({
				handle: live,
				release() {},
			}),
		),
	);
	const result = await resumeRun(runId, {
		store,
		stageControlRegistry: registry,
		stageId: "agent",
		message: "carry on with the tests",
	});
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(resumed, ["carry on with the tests"]);
});
