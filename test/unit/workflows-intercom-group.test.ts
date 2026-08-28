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

test("resolveStageGroup preserves explicit precedence over a workflow group", () => {
	assert.equal(resolveStageGroup(undefined), undefined);
	assert.equal(resolveStageGroup({}, "workflow:root"), "workflow:root");
	assert.equal(resolveStageGroup({ group: "  reviewers " }, "workflow:root"), "reviewers");
	assert.equal(resolveStageGroup({ group: "default" }, "workflow:root"), "default");
	assert.equal(resolveStageGroup({ group: "" }, "workflow:root"), undefined);

	const a = resolveStageGroup({ group: true });
	const b = resolveStageGroup({ group: true });
	assert.match(a ?? "", /^[0-9a-f-]{36}$/);
	assert.notEqual(a, b, "each single-stage true mints its own uuid");
});

test("stageHasIntercomAccess gates on noTools / tools allowlist / excludedTools", () => {
	assert.equal(stageHasIntercomAccess(undefined), true);
	assert.equal(stageHasIntercomAccess({} as StageOptions), true);
	assert.equal(stageHasIntercomAccess({ noTools: "all" } as StageOptions), false);
	assert.equal(stageHasIntercomAccess({ noTools: "builtin" } as StageOptions), true);
	assert.equal(stageHasIntercomAccess({ tools: ["bash", "read"] } as StageOptions), false);
	assert.equal(stageHasIntercomAccess({ tools: ["bash", "intercom"] } as StageOptions), true);
	assert.equal(stageHasIntercomAccess({ excludedTools: ["intercom"] } as StageOptions), false);
});

test("workflow pending routes require both Intercom access and the route owner's exact group", () => {
	const workflowGroup = "workflow:root";
	assert.equal(stageCanUseWorkflowPendingStageRoute(undefined, workflowGroup), true);
	assert.equal(stageCanUseWorkflowPendingStageRoute({ tools: ["intercom"] } as StageOptions, workflowGroup), true);
	assert.equal(
		stageCanUseWorkflowPendingStageRoute(
			{ tools: ["intercom"], group: "  workflow:root  " } as StageOptions,
			workflowGroup,
		),
		true,
	);
	assert.equal(
		stageCanUseWorkflowPendingStageRoute(
			{ tools: ["intercom"], group: "isolated-reviewers" } as StageOptions,
			workflowGroup,
		),
		false,
	);
	assert.equal(
		stageCanUseWorkflowPendingStageRoute({ tools: ["intercom"], group: true } as StageOptions, workflowGroup),
		false,
	);
	assert.equal(
		stageCanUseWorkflowPendingStageRoute({ tools: ["intercom"], group: "" } as StageOptions, workflowGroup),
		false,
	);
	assert.equal(
		stageCanUseWorkflowPendingStageRoute({ tools: ["read"], group: workflowGroup } as StageOptions, workflowGroup),
		false,
	);
});
