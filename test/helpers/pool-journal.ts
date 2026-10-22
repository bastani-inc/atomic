import type { PoolWorkDescriptor } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";

export function poolWorkFixture(
	boundaryId = "boundary",
	childRunId = `child-${boundaryId}`,
	scope = `workflow:${boundaryId}:0`,
) {
	const work: PoolWorkDescriptor = {
		boundaryId,
		childRunId,
		scope,
		definition: "fixture/child",
		digest: "sha256:child",
		inputs: { value: 1 },
		execution: {},
	};
	const boundary: DurableStageCheckpoint = {
		kind: "stage",
		workflowId: "root",
		checkpointId: `boundary-start:${work.scope}`,
		name: "child",
		replayKey: work.scope,
		startedAt: 0,
		completedAt: 0,
		topology: {
			version: 1,
			stageId: boundaryId,
			parentIds: [],
			sourceOrder: 0,
			status: "running",
			run: { runId: "root", runName: "root" },
			boundary: {
				version: 1,
				event: "start",
				status: "running",
				replayScope: work.scope,
				alias: "child",
				workflow: "child",
				invocationFingerprint: "fingerprint",
				child: {
					runId: work.childRunId,
					runName: "child",
					parentRunId: "root",
					parentStageId: boundaryId,
					rootRunId: "root",
				},
			},
		},
	};
	return { work, boundary };
}
