import assert from "node:assert/strict";
import { test } from "vitest";
import type { PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { attemptSuperseded } from "../../packages/workflows/src/workers/pool-coordinator.js";

const item = (id: string, generation: number, state: PoolWork["state"]) => ({ id, generation, state }) as PoolWork;
const attempt = { id: "work", generation: 4 };

test("an attempt the queue still holds at its generation is its owner's, leased or ready again (#4822)", () => {
	assert.equal(attemptSuperseded([item("other", 9, "completed"), item("work", 4, "leased")], attempt), false);
	assert.equal(attemptSuperseded([item("work", 4, "ready")], attempt), false);
	assert.equal(attemptSuperseded([item("work", 4, "failed")], attempt), false);
});

test("an attempt is superseded once its item is gone, at another generation, or completed (#4822)", () => {
	assert.equal(attemptSuperseded([], attempt), true, "gone");
	assert.equal(attemptSuperseded([item("other", 4, "leased")], attempt), true, "only another item is held");
	assert.equal(attemptSuperseded([item("work", 5, "leased")], attempt), true, "another generation");
	assert.equal(attemptSuperseded([item("work", 4, "completed")], attempt), true, "completed");
});
