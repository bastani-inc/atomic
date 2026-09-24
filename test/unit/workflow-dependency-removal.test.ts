import assert from "node:assert/strict";
import { test } from "vitest";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowArgumentCompletions } from "../../packages/workflows/src/extension/workflow-command-completions.js";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";
import * as workflows from "../../packages/workflows/src/index.js";

test("workflow dependency management is absent from public interfaces", () => {
	assert.equal("workflowDependency" in workflows, false);
	const actions = WorkflowParametersSchema.properties.action.anyOf.map((variant) => variant.const);
	assert.equal(
		actions.some((action: string) => action === "dependency"),
		false,
	);
	assert.equal("operation" in WorkflowParametersSchema.properties, false);
	const completions = workflowArgumentCompletions("dep", createExtensionRuntime());
	assert.ok(!completions?.some((item) => item.label === "dependency"));
});
