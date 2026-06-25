import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  checkSubagentDepth,
  getSubagentDepthEnv,
  MAX_SUBAGENT_NESTING_DEPTH,
  resolveWorkflowStageMaxSubagentDepth,
  subagentDepthBlockedMessage,
  WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
} from "../../packages/subagents/src/shared/types.js";

const DEPTH_ENV = "ATOMIC_SUBAGENT_DEPTH";
const MAX_DEPTH_ENV = "ATOMIC_SUBAGENT_MAX_DEPTH";

const savedEnv = new Map<string, string | undefined>();
for (const key of [DEPTH_ENV, MAX_DEPTH_ENV, WORKFLOW_STAGE_SUBAGENT_GUARD_ENV]) {
  savedEnv.set(key, process.env[key]);
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("subagent workflow-stage depth guard", () => {
  test("workflow-stage context preserves stricter limits and defaults to main-chat depth", () => {
    delete process.env[DEPTH_ENV];
    delete process.env[MAX_DEPTH_ENV];
    delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
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

  test("subagent nesting defaults to and is capped at five levels", () => {
    delete process.env[DEPTH_ENV];
    delete process.env[MAX_DEPTH_ENV];
    delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];

    const result = checkSubagentDepth();
    assert.equal(result.blocked, false);
    assert.equal(result.depth, 0);
    assert.equal(result.maxDepth, MAX_SUBAGENT_NESTING_DEPTH);

    process.env[MAX_DEPTH_ENV] = String(MAX_SUBAGENT_NESTING_DEPTH + 10);
    assert.equal(checkSubagentDepth().maxDepth, MAX_SUBAGENT_NESTING_DEPTH);

    const firstChildEnv = getSubagentDepthEnv(MAX_SUBAGENT_NESTING_DEPTH + 10, { workflowStageSubagentGuard: true });
    assert.equal(firstChildEnv[DEPTH_ENV], "1");
    assert.equal(firstChildEnv[MAX_DEPTH_ENV], String(MAX_SUBAGENT_NESTING_DEPTH));
    assert.equal(firstChildEnv[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV], "1");

    process.env[DEPTH_ENV] = firstChildEnv[DEPTH_ENV];
    process.env[MAX_DEPTH_ENV] = firstChildEnv[MAX_DEPTH_ENV];
    process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = firstChildEnv[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
    const firstChildResult = checkSubagentDepth();
    assert.equal(firstChildResult.blocked, false);
    assert.equal(firstChildResult.depth, 1);
    assert.equal(firstChildResult.maxDepth, MAX_SUBAGENT_NESTING_DEPTH);

    const secondChildEnv = getSubagentDepthEnv(MAX_SUBAGENT_NESTING_DEPTH, { workflowStageSubagentGuard: true });
    assert.equal(secondChildEnv[DEPTH_ENV], "2");
    assert.equal(secondChildEnv[MAX_DEPTH_ENV], String(MAX_SUBAGENT_NESTING_DEPTH));
  });

  test("workflow-stage child env marker produces nested workflow-stage rejection message", () => {
    delete process.env[DEPTH_ENV];
    delete process.env[MAX_DEPTH_ENV];
    delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];

    const firstChildEnv = getSubagentDepthEnv(2, { workflowStageSubagentGuard: true });
    process.env[DEPTH_ENV] = firstChildEnv[DEPTH_ENV];
    process.env[MAX_DEPTH_ENV] = firstChildEnv[MAX_DEPTH_ENV];
    process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = firstChildEnv[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
    const secondChildEnv = getSubagentDepthEnv(2, { workflowStageSubagentGuard: true });
    assert.equal(secondChildEnv[DEPTH_ENV], "2");
    assert.equal(secondChildEnv[MAX_DEPTH_ENV], "2");
    assert.equal(secondChildEnv[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV], "1");

    process.env[DEPTH_ENV] = secondChildEnv[DEPTH_ENV];
    process.env[MAX_DEPTH_ENV] = secondChildEnv[MAX_DEPTH_ENV];
    process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = secondChildEnv[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
    const result = checkSubagentDepth();
    assert.equal(result.blocked, true);
    assert.equal(result.workflowStageGuard, true);
    assert.match(
      subagentDepthBlockedMessage(result.depth, result.maxDepth, { workflowStageGuard: true }),
      /Sub-agents inside workflow stages are running at the maximum nesting depth/,
    );
  });
});
