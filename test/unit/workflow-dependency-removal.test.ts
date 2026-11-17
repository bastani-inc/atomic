import assert from "node:assert/strict";
import { test } from "vitest";
import { BUNDLED_EXTENSION_SLASH_COMMANDS } from "../../packages/coding-agent/src/core/slash-commands.js";
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
	assert.equal(
		BUNDLED_EXTENSION_SLASH_COMMANDS.some((command) => command.name === "workflow"),
		false,
	);
});
