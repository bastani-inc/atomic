import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveToolResumeFrontier } from "../../packages/workflows/src/durable/tool-resume-frontier.js";
import * as lifecycle from "../../packages/workflows/src/runs/foreground/executor-lifecycle.js";
import { buildModelCandidates } from "../../packages/workflows/src/runs/shared/model-fallback-candidates.js";
import * as sdk from "../../packages/workflows/src/sdk-surface.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import * as targets from "../../packages/workflows/src/shared/workflow-stage-target.js";
import { parseTerminalMouseInput } from "../../packages/workflows/src/tui/mouse-input.js";
import { MemoryJournalBackend as InMemoryDurableBackend } from "../helpers/workflow-journal.js";

const rootId = "00000000-0000-4000-8000-000000000001";

test("keeps current stage targets and SGR mouse input without removed readers", () => {
	assert.deepEqual(targets.parseWorkflowStageTarget(`workflow:${rootId}/review`), {
		rootRunId: rootId,
		segments: ["review"],
		kind: "path",
	});
	assert.equal(targets.parseWorkflowStageTarget(`${rootId}:review`), undefined);
	assert.equal("parseLegacyWorkflowStageTarget" in targets, false);
	assert.equal("legacyWorkflowStageTargetMigrationHint" in targets, false);
	assert.equal(parseTerminalMouseInput("\x1b[M !!"), null);
	assert.deepEqual(parseTerminalMouseInput("\x1b[<0;2;3M"), {
		protocol: "sgr",
		action: "press",
		buttonCode: 0,
		col: 1,
		row: 2,
	});
});

test("exports only current workflow and lifecycle entry points", () => {
	assert.equal(typeof sdk.workflow, "function");
	assert.equal("runWorkflow" in sdk, false);
	assert.equal(typeof lifecycle.assertWorkflowCreatedExecution, "function");
	assert.equal("assertWorkflowCreatedStage" in lifecycle, false);
});

test("model candidates use authored reasoning suffixes, not separate old reasoning arrays", () => {
	const request = { fallbackModels: ["provider/model"], fallbackThinkingLevels: ["high"] };
	assert.equal(buildModelCandidates(request)[0]?.reasoningLevel, undefined);
	assert.equal(buildModelCandidates({ fallbackModels: ["provider/model:high"] })[0]?.reasoningLevel, "high");
});

test("tool resume requires the persisted failed tool identity, not matching error text", () => {
	const error = "atomic-workflows: ctx.tool effect aborted by node abort";
	const source: RunSnapshot = {
		id: rootId,
		name: "frontier",
		inputs: {},
		status: "blocked",
		startedAt: 1,
		stages: [],
		toolNodes: [
			{
				kind: "tool",
				id: "tool:hash",
				name: "effect",
				argsHash: "hash",
				ordinal: 1,
				parentIds: [],
				status: "failed",
				error,
				attachable: false,
			},
		],
		error,
	};
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: rootId, name: "frontier", inputs: {}, createdAt: 1, status: "blocked" });
	backend.recordCheckpoint({
		kind: "tool",
		workflowId: rootId,
		checkpointId: "failure",
		name: "effect",
		argsHash: "hash",
		output: null,
		throwingFailureError: error,
		completedAt: 1,
		topology: {
			version: 1,
			nodeId: "tool:hash",
			ordinal: 1,
			order: 0,
			parentIds: [],
			run: { runId: rootId, runName: "frontier" },
		},
	});
	assert.equal(resolveToolResumeFrontier(source, backend).ok, false);
	assert.equal(resolveToolResumeFrontier({ ...source, failedToolNodeId: "tool:hash" }, backend).ok, true);
});
