import assert from "node:assert/strict";
import { test } from "vitest";
import { directChildTopologyError } from "../../packages/workflows/src/durable/stage-topology-validation.js";
import {
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableStageCheckpoint,
	type DurableStageLifecycleStatus,
	type DurableStageRunTopology,
} from "../../packages/workflows/src/durable/types.js";

const SCOPE = "root:child";
const RUN: DurableStageRunTopology = { runId: "child", runName: "child", parentRunId: "root", rootRunId: "root" };

/** A prompt node's durable record: `text` stands for the prompt's descriptor, part of its replay key. */
function prompt(stageId: string, text: string, status: DurableStageLifecycleStatus): DurableStageCheckpoint {
	return {
		kind: "stage",
		workflowId: "root",
		checkpointId: `${SCOPE}:${stageId}:${status}`,
		name: "input",
		replayKey: `${SCOPE}:prompt:input:${text}`,
		completedAt: 0,
		topology: {
			version: DURABLE_STAGE_TOPOLOGY_VERSION,
			stageId,
			parentIds: [],
			sourceOrder: 0,
			occurrenceKey: stageId,
			status,
			run: RUN,
		},
	};
}

function stage(stageId: string, name: string, status: DurableStageLifecycleStatus): DurableStageCheckpoint {
	return {
		kind: "stage",
		workflowId: "root",
		checkpointId: `${SCOPE}:${stageId}:${status}`,
		name,
		replayKey: `${SCOPE}:stage:${name}`,
		completedAt: 0,
		topology: { version: DURABLE_STAGE_TOPOLOGY_VERSION, stageId, parentIds: [], sourceOrder: 0, status, run: RUN },
	};
}

test("#4022: a replacement attempt's different prompt at the same position supersedes the unanswered one", () => {
	const dead = prompt("first", "which-branch", "awaiting_input");
	assert.equal(
		directChildTopologyError([dead, prompt("second", "which-tag", "awaiting_input")], SCOPE, RUN),
		undefined,
	);
	assert.equal(
		directChildTopologyError(
			[dead, prompt("second", "which-tag", "awaiting_input"), prompt("second", "which-tag", "completed")],
			SCOPE,
			RUN,
		),
		undefined,
	);
});

test("#4022: two answered steps at one position are still refused as a different path", () => {
	assert.equal(
		directChildTopologyError(
			[prompt("first", "which-branch", "completed"), prompt("second", "which-tag", "completed")],
			SCOPE,
			RUN,
		),
		"direct child source orders are not unique",
	);
	assert.equal(
		directChildTopologyError([stage("a", "plan", "running"), stage("b", "build", "running")], SCOPE, RUN),
		"direct child source orders are not unique",
	);
});

test("#4022: an unanswered prompt whose position a different agent stage took is a source-order conflict, not superseded", () => {
	// The replacement ran an ordinary stage where the replaced attempt asked: a different path, refused.
	assert.equal(
		directChildTopologyError(
			[prompt("first", "which-branch", "awaiting_input"), stage("b", "build", "completed")],
			SCOPE,
			RUN,
		),
		"direct child source orders are not unique",
	);
	assert.equal(
		directChildTopologyError(
			[prompt("first", "which-branch", "awaiting_input"), stage("b", "build", "running")],
			SCOPE,
			RUN,
		),
		"direct child source orders are not unique",
	);
	// A stage the replaced attempt left unfinished where the replacement asks a prompt is refused too.
	assert.equal(
		directChildTopologyError(
			[stage("a", "plan", "running"), prompt("second", "which-tag", "awaiting_input")],
			SCOPE,
			RUN,
		),
		"direct child source orders are not unique",
	);
});
