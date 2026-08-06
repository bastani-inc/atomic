import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	checkSubagentDepth,
	MAX_SUBAGENT_NESTING_DEPTH,
	resolveWorkflowStageMaxSubagentDepth,
	subagentDepthBlockedMessage,
} from "../../packages/subagents/src/shared/types.js";

const childPolicy = {
	managementActions: "full" as const,
	fanoutAuthorized: true,
	inheritProjectContext: false,
	inheritSkills: false,
};

function contextAtDepth(depth: number, maxSubagentDepth?: number) {
	return {
		subagentPolicy: {
			...childPolicy,
			depth,
			...(maxSubagentDepth === undefined ? {} : { maxSubagentDepth }),
		},
	};
}

describe("subagent workflow-stage depth guard", () => {
	test("workflow-stage context preserves stricter limits and defaults to main-chat depth", () => {
		const workflowCtx = {
			orchestrationContext: {
				kind: "workflow-stage" as const,
				workflowRunId: "run-1",
				workflowStageId: "stage-1",
				workflowStageName: "Stage",
				constraints: { disableWorkflowTool: true as const, maxSubagentDepth: MAX_SUBAGENT_NESTING_DEPTH },
			},
		};
		const stricterWorkflowCtx = {
			orchestrationContext: {
				kind: "workflow-stage" as const,
				workflowRunId: "run-1",
				workflowStageId: "stage-1",
				workflowStageName: "Stage",
				constraints: { disableWorkflowTool: true as const, maxSubagentDepth: 0 },
			},
		};

		assert.equal(resolveWorkflowStageMaxSubagentDepth(workflowCtx, undefined), MAX_SUBAGENT_NESTING_DEPTH);
		assert.equal(resolveWorkflowStageMaxSubagentDepth(stricterWorkflowCtx, undefined), 1);
		assert.equal(resolveWorkflowStageMaxSubagentDepth(workflowCtx, 0), 0);
		assert.equal(resolveWorkflowStageMaxSubagentDepth({}, undefined), MAX_SUBAGENT_NESTING_DEPTH);
	});

	test("the live admitted policy depth blocks at the documented five-level limit", () => {
		const topLevel = checkSubagentDepth({});
		assert.equal(topLevel.blocked, false);
		assert.equal(topLevel.depth, 0);
		assert.equal(topLevel.maxDepth, MAX_SUBAGENT_NESTING_DEPTH);

		const oneBelow = checkSubagentDepth(contextAtDepth(MAX_SUBAGENT_NESTING_DEPTH - 1));
		assert.equal(oneBelow.blocked, false);
		assert.equal(oneBelow.depth, MAX_SUBAGENT_NESTING_DEPTH - 1);

		const atLimit = checkSubagentDepth(contextAtDepth(MAX_SUBAGENT_NESTING_DEPTH));
		assert.equal(atLimit.blocked, true);
		assert.equal(atLimit.depth, MAX_SUBAGENT_NESTING_DEPTH);
		assert.equal(atLimit.maxDepth, MAX_SUBAGENT_NESTING_DEPTH);
	});

	test("a configured lower limit still applies to admitted depth", () => {
		const result = checkSubagentDepth(contextAtDepth(2), 2);

		assert.equal(result.blocked, true);
		assert.equal(result.depth, 2);
		assert.equal(result.maxDepth, 2);
	});

	test("the nesting ceiling clamps a configured limit that exceeds it", () => {
		assert.equal(checkSubagentDepth({}, MAX_SUBAGENT_NESTING_DEPTH + 10).maxDepth, MAX_SUBAGENT_NESTING_DEPTH);
		assert.equal(
			checkSubagentDepth(contextAtDepth(0, MAX_SUBAGENT_NESTING_DEPTH + 10)).maxDepth,
			MAX_SUBAGENT_NESTING_DEPTH,
		);
	});

	test("an inherited policy maximum tightens the limit and blocks below the global ceiling", () => {
		const result = checkSubagentDepth(contextAtDepth(1, 1));

		assert.equal(result.maxDepth, 1);
		assert.equal(result.depth, 1);
		assert.equal(result.blocked, true);
	});

	test("the stricter of the local and inherited maximums wins in either direction", () => {
		assert.equal(checkSubagentDepth(contextAtDepth(0, 3), 2).maxDepth, 2);
		assert.equal(checkSubagentDepth(contextAtDepth(0, 2), 3).maxDepth, 2);
		assert.equal(checkSubagentDepth(contextAtDepth(0), 3).maxDepth, 3);
	});

	test("workflow-stage rejection uses the workflow-specific message", () => {
		const result = checkSubagentDepth(contextAtDepth(2), 2);

		assert.equal(result.blocked, true);
		assert.match(
			subagentDepthBlockedMessage(result.depth, result.maxDepth, { workflowStageGuard: true }),
			/Sub-agents inside workflow stages are running at the maximum nesting depth/,
		);
	});
});
