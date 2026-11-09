import { beforeEach, describe, test } from "vitest";
import {
	createStageReplayKeyGenerator,
	durableWaitingStages,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert } from "./executor-shared.js";

const WORKFLOW_ID = "wf-waiting-listing";

let backend: Awaited<ReturnType<typeof createMemoryTestBackend>>;

beforeEach(async () => {
	backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: WORKFLOW_ID,
		name: "waiting-listing",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
});

describe("the waiting stages a run's records list (#4309)", () => {
	test("a stage the run itself recorded as its own is listed with its stage id (#4309)", async () => {
		const stage: StageSnapshot = {
			id: "stage-own",
			name: "own",
			replayKey: "stage:own:1",
			status: "suspended",
			parentIds: [],
			toolEvents: [],
			startedAt: 1_000,
			sessionId: "session-own",
			wait: { kind: "release", since: 3_000, promptsCompleted: 1 },
		};
		await recordStageSessionCheckpoint(
			{
				workflowId: WORKFLOW_ID,
				backend,
				nextCheckpointId: createCheckpointIdGenerator(),
				nextReplayKey: createStageReplayKeyGenerator(WORKFLOW_ID),
				now: () => 3_000,
				runTopology: { runId: WORKFLOW_ID, runName: "waiting-listing", rootRunId: WORKFLOW_ID },
			},
			stage,
			{ force: true },
		);

		assert.deepEqual(
			durableWaitingStages(backend, WORKFLOW_ID).map((listed) => [listed.stageName, listed.stageId]),
			[["own", "stage-own"]],
		);
	});
});
