/**
 * Every reason a workflow root can report crosses the engine protocol (#4309), including a stage that waits.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type {
	WorkflowActivityFrame,
	WorkflowActivityReason,
	WorkflowRootActivity,
} from "../src/core/extensions/workflow-events.js";
import type { InteractiveEngineMessage } from "../src/modes/interactive-engine/protocol.js";

const REASONS: Record<WorkflowActivityReason, true> = {
	executing: true,
	automatic_continuation: true,
	retrying: true,
	stopping: true,
	waiting: true,
	awaiting_input: true,
	manual_intervention: true,
	paused: true,
	quiescent: true,
};

test("a workflow root reports any reason the protocol declares, so a waiting stage reaches the host (#4309)", async () => {
	// Loaded here: the protocol's tables are built when the module loads, so they belong to this test.
	const { parseInteractiveEngineMessage, serializeInteractiveEngineMessage } = await import(
		"../src/modes/interactive-engine/protocol.js"
	);
	for (const reason of Object.keys(REASONS) as WorkflowActivityReason[]) {
		const root: Omit<WorkflowRootActivity, "graph"> = {
			rootRunId: "run",
			ownerSessionId: "owner",
			state: "idle",
			reason,
			activeExecutionCount: 0,
			actionableBlockCount: 0,
			needsAttention: false,
		};
		const frame: WorkflowActivityFrame = {
			kind: "changed",
			cursor: { epoch: "epoch", revision: 1 },
			root: root as WorkflowRootActivity,
		};
		const message: InteractiveEngineMessage = { type: "engine_workflow_activity", frame };

		assert.deepEqual(parseInteractiveEngineMessage(serializeInteractiveEngineMessage(message)), message, reason);
	}
});
