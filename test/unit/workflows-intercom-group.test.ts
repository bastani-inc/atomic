import assert from "node:assert/strict";
import { test } from "vitest";
import {
	DEFAULT_INTERCOM_GROUP,
	normalizeGroup,
	resolveStageGroup,
	stageCanUseWorkflowPendingStageRoute,
	stageHasIntercomAccess,
	workflowInvocationIntercomGroup,
} from "../../packages/workflows/src/shared/intercom-group.js";
import type { StageOptions } from "../../packages/workflows/src/shared/types.js";

test("normalizeGroup collapses empties to the default group", () => {
	assert.equal(normalizeGroup(), DEFAULT_INTERCOM_GROUP);
	assert.equal(normalizeGroup(""), DEFAULT_INTERCOM_GROUP);
	assert.equal(normalizeGroup("  x "), "x");
});

test("workflow invocation groups are stable, namespaced, and non-default", () => {
	const group = workflowInvocationIntercomGroup("root-run-id");
	assert.equal(group, "workflow:root-run-id");
	assert.equal(workflowInvocationIntercomGroup("root-run-id"), group);
	assert.notEqual(group, DEFAULT_INTERCOM_GROUP);
});

// Regression coverage for #2784.
test("resolveStageGroup namespaces explicit and automatic workflow subgroups under the invocation", () => {
	assert.equal(resolveStageGroup(undefined), undefined);
	assert.equal(resolveStageGroup({}, "workflow:root"), "workflow:root");
	assert.equal(resolveStageGroup({ group: "  reviewers " }, "workflow:root"), "workflow:root/reviewers");
	assert.equal(resolveStageGroup({ group: "default" }, "workflow:root"), "default");
	assert.equal(resolveStageGroup({ group: "workflow:root" }, "workflow:root"), "workflow:root");
	assert.equal(resolveStageGroup({ group: "" }, "workflow:root"), undefined);

	const a = resolveStageGroup({ group: true }, "workflow:root");
	const b = resolveStageGroup({ group: true }, "workflow:root");
	assert.match(a ?? "", /^workflow:root\/[0-9a-f-]{36}$/);
	assert.notEqual(a, b, "each single-stage true mints its own invocation-owned subgroup");
});

test("workflow tool restrictions never remove Intercom access", () => {
	assert.equal(stageHasIntercomAccess(undefined), true);
	assert.equal(stageHasIntercomAccess({} as StageOptions), true);
	assert.equal(stageHasIntercomAccess({ noTools: "all" } as StageOptions), true);
	assert.equal(stageHasIntercomAccess({ noTools: "builtin" } as StageOptions), true);
	assert.equal(stageHasIntercomAccess({ tools: ["bash", "read"] } as StageOptions), true);
	assert.equal(stageHasIntercomAccess({ tools: ["bash", "intercom"] } as StageOptions), true);
	assert.equal(stageHasIntercomAccess({ excludedTools: ["intercom"] } as StageOptions), true);
});

// Regression coverage for #2784.
test("workflow pending routes include invocation-owned subgroups but exclude the default escape", () => {
	const workflowGroup = "workflow:root";
	assert.equal(stageCanUseWorkflowPendingStageRoute(undefined, workflowGroup), true);
	assert.equal(stageCanUseWorkflowPendingStageRoute({ tools: ["intercom"] } as StageOptions, workflowGroup), true);
	assert.equal(
		stageCanUseWorkflowPendingStageRoute(
			{ tools: ["intercom"], group: "isolated-reviewers" } as StageOptions,
			workflowGroup,
		),
		true,
	);
	assert.equal(
		stageCanUseWorkflowPendingStageRoute({ tools: ["intercom"], group: true } as StageOptions, workflowGroup),
		true,
	);
	assert.equal(
		stageCanUseWorkflowPendingStageRoute({ tools: ["intercom"], group: "default" } as StageOptions, workflowGroup),
		false,
	);
	assert.equal(
		stageCanUseWorkflowPendingStageRoute({ tools: ["intercom"], group: "" } as StageOptions, workflowGroup),
		false,
	);
});

// Regression coverage for #2784.
test("identical authored subgroup names remain isolated across workflow invocations", () => {
	assert.equal(resolveStageGroup({ group: "reviewers" }, "workflow:root-a"), "workflow:root-a/reviewers");
	assert.equal(resolveStageGroup({ group: "reviewers" }, "workflow:root-b"), "workflow:root-b/reviewers");
	assert.notEqual(
		resolveStageGroup({ group: "reviewers" }, "workflow:root-a"),
		resolveStageGroup({ group: "reviewers" }, "workflow:root-b"),
	);
});
