import assert from "node:assert/strict";
import { test } from "vitest";
import type { RunSnapshot } from "../../packages/workflows/src/authoring.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

test("a current public snapshot with an explicit empty tool collection starts a run", () => {
	const snapshot = {
		id: "public-empty",
		name: "current",
		status: "running",
		inputs: {},
		stages: [],
		toolNodes: [],
		startedAt: 1,
	} satisfies RunSnapshot & { inputs: Record<string, never> };
	const store = createStore();
	store.recordRunStart(snapshot);
	assert.deepEqual(store.snapshot().runs[0]?.toolNodes, []);
});
