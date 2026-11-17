import assert from "node:assert/strict";
import { test } from "vitest";
import { completeToken, runIdItems } from "../../packages/workflows/src/extension/workflow-command-completions.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";

test("/workflows runIdItems and completeToken complete only top-level session run IDs (#5224)", () => {
	const store = createStore();
	const id = testRunId("completion-stage-slot");
	const childId = testRunId("completion-child-slot");
	store.recordRunStart({
		id,
		name: "demo",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	store.recordRunStart({
		id: childId,
		parentRunId: id,
		name: "child-demo",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 2,
	});

	const items = runIdItems(store);
	assert.deepEqual(items, [
		{
			value: `${id} `,
			label: id,
			description: "demo — running",
		},
	]);
	assert.deepEqual(
		completeToken(id.slice(0, 8), items)?.map((item) => item.value),
		[`${id} `],
	);
	assert.equal(completeToken(id, items), null);
	assert.equal(completeToken("unknown-prefix", items), null);
});
