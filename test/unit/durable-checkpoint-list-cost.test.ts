import assert from "node:assert/strict";
import { test } from "vitest";
import { createJournalProjection } from "../../packages/workflows/src/durable/backend.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";

function checkpoint(id: string, completedAt: number): DurableToolCheckpoint {
	return { kind: "tool", workflowId: "run", checkpointId: id, name: id, argsHash: id, output: id, completedAt };
}

test("unchanged checkpoint reads do no repeated sorting work and invalidate after index changes (#5234)", () => {
	const projection = createJournalProjection();
	projection.registerWorkflow({ workflowId: "run", name: "cost", inputs: {}, status: "running", createdAt: 1 });
	const earlier = checkpoint("earlier", 1);
	const later = checkpoint("later", 3);
	projection.recordCheckpoint(later);
	projection.recordCheckpoint(earlier);
	let timestampReads = 0;
	for (const value of [earlier, later]) {
		const stored = projection.getStoredCheckpoint(value)!;
		const completedAt = stored.completedAt;
		Object.defineProperty(stored, "completedAt", {
			configurable: true,
			get: () => {
				timestampReads++;
				return completedAt;
			},
		});
	}
	const initial = projection.listCheckpoints("run");
	assert.deepEqual(
		initial.map((value) => value.checkpointId),
		["earlier", "later"],
	);
	timestampReads = 0;
	for (let read = 0; read < 50; read++) projection.listCheckpoints("run");
	assert.equal(timestampReads, 0, "status and heartbeat reads must reuse the sorted checkpoint projection");
	projection.recordCheckpoint(checkpoint("middle", 2));
	assert.deepEqual(
		projection.listCheckpoints("run").map((value) => value.checkpointId),
		["earlier", "middle", "later"],
	);
	assert.deepEqual(
		initial.map((value) => value.checkpointId),
		["earlier", "later"],
	);
	projection.forgetCheckpoints("run", ["tool:middle"]);
	assert.deepEqual(
		projection.listCheckpoints("run").map((value) => value.checkpointId),
		["earlier", "later"],
	);
	projection.releaseCheckpoints("run");
	assert.deepEqual(projection.listCheckpoints("run"), []);
	projection.restoreCheckpoint(later);
	assert.deepEqual(
		projection.listCheckpoints("run").map((value) => value.checkpointId),
		["later"],
	);
});
