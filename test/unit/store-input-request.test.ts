/**
 * Tests for the store's StageInputRequest API:
 *  - recordStageInputRequest sets a serializable descriptor + notifies
 *  - duplicate id is idempotent; new id replaces
 *  - clearStageInputRequest removes the descriptor
 *  - terminal run/stage guards
 *  - recordStageEnd clears any lingering descriptor
 *
 * These back `workflow send` answering of brokered in-stage prompts
 * (ask_user_question / readiness gate); regressions break headless answering.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageInputRequest } from "../../packages/workflows/src/shared/store-types.js";

function setup() {
	const store = createStore();
	store.recordRunStart({
		id: "run-1",
		name: "wf",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: Date.now(),
	});
	store.recordStageStart("run-1", {
		id: "stage-1",
		name: "ask",
		status: "running",
		parentIds: [],
		toolEvents: [],
	});
	return store;
}

function makeRequest(id: string): StageInputRequest {
	return {
		id,
		kind: "ask_user_question",
		createdAt: 100,
		questions: [{ question: "Color?", options: [{ label: "Red" }, { label: "Blue" }] }],
	};
}

describe("store StageInputRequest", () => {
	test("records and clears a descriptor with version bumps", () => {
		const store = setup();
		const before = store.snapshot().version;

		assert.equal(store.recordStageInputRequest("run-1", "stage-1", makeRequest("p1")), true);
		assert.equal(store.runs()[0]?.stages[0]?.inputRequest?.id, "p1");
		assert.ok(store.snapshot().version > before);

		// Descriptor is a clone — mutating the snapshot does not corrupt the store.
		assert.deepEqual(
			store.runs()[0]?.stages[0]?.inputRequest?.questions[0]?.options.map((o) => o.label),
			["Red", "Blue"],
		);

		assert.equal(store.clearStageInputRequest("run-1", "stage-1"), true);
		assert.equal(store.runs()[0]?.stages[0]?.inputRequest, undefined);
		// Clearing again is a no-op.
		assert.equal(store.clearStageInputRequest("run-1", "stage-1"), false);
	});

	test("same id is idempotent; a different id replaces", () => {
		const store = setup();
		assert.equal(store.recordStageInputRequest("run-1", "stage-1", makeRequest("p1")), true);
		assert.equal(store.recordStageInputRequest("run-1", "stage-1", makeRequest("p1")), false);
		assert.equal(store.recordStageInputRequest("run-1", "stage-1", makeRequest("p2")), true);
		assert.equal(store.runs()[0]?.stages[0]?.inputRequest?.id, "p2");
	});

	test("rejects unknown run/stage", () => {
		const store = setup();
		assert.equal(store.recordStageInputRequest("nope", "stage-1", makeRequest("p1")), false);
		assert.equal(store.recordStageInputRequest("run-1", "nope", makeRequest("p1")), false);
		assert.equal(store.clearStageInputRequest("run-1", "nope"), false);
	});

	test("recordStageEnd clears a lingering descriptor", () => {
		const store = setup();
		store.recordStageInputRequest("run-1", "stage-1", makeRequest("p1"));
		store.recordStageEnd("run-1", {
			id: "stage-1",
			name: "ask",
			status: "completed",
			parentIds: [],
			toolEvents: [],
			endedAt: Date.now(),
		});
		assert.equal(store.runs()[0]?.stages[0]?.inputRequest, undefined);
		// Terminal stage refuses new descriptors.
		assert.equal(store.recordStageInputRequest("run-1", "stage-1", makeRequest("p2")), false);
	});
});
