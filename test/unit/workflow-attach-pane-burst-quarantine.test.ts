/**
 * The attach pane coalesces bursts of store publications (#3996). A prompt published inside a
 * burst counts its Enter quarantine from when it was published, not from when the pane handled it,
 * so Enter after the quarantine opens it even if no frame ran in between.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";

test("Enter after the quarantine opens a prompt published inside a coalesced burst (#3996)", () => {
	const store = createStore();
	let now = 0;
	const pane = new WorkflowAttachPane({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		onClose: () => {},
		now: () => now,
	});
	try {
		// The first publication of the task is handled at once; the next ones are deferred.
		store.recordRunStart({
			id: "run-1",
			name: "test-wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		store.recordStageStart("run-1", { id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] });
		store.recordStagePendingPrompt("run-1", "ask", { id: "p1", kind: "input", message: "Branch?", createdAt: 1 });
		// The user reads the prompt for longer than the quarantine; no frame ran in between.
		now += 201;
		pane.handleInput("\r");
		assert.equal(pane._mode, "stage-chat", "Enter opened the prompt's stage");
	} finally {
		pane.dispose();
	}
});
