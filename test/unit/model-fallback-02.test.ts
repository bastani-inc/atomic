// @ts-nocheck

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	buildModelCandidateIds,
	buildModelCandidates,
	buildModelCandidatesFromCatalog,
	isRetryableModelFailure,
	normalizeModelFailureSignal,
	splitReasoningSuffix,
	validateWorkflowModels,
	WorkflowModelValidationError,
} from "../../packages/workflows/src/runs/shared/model-fallback.js";
import type { WorkflowModelInfo } from "../../packages/workflows/src/shared/types.js";

const models: readonly WorkflowModelInfo[] = [
	{
		provider: "anthropic",
		id: "claude-sonnet-4",
		fullId: "anthropic/claude-sonnet-4",
	},
	{
		provider: "github-copilot",
		id: "claude-sonnet-4",
		fullId: "github-copilot/claude-sonnet-4",
	},
	{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
];

test("workflow model suffix parsing accepts max thinking", () => {
	const baseModel = "openai/gpt-5.6-sol";
	assert.deepEqual(splitReasoningSuffix(`${baseModel}:max`), {
		baseModel,
		level: "max",
	});
});
