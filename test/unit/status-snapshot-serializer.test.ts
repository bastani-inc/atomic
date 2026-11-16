import assert from "node:assert/strict";
import { test } from "vitest";
import { StatusSnapshotSerializer } from "../../packages/workflows/src/extension/status-snapshot-serializer.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeRun, makeStage } from "./overlay-graph-helpers.js";

test("status serialization retains per-run chunks instead of assembling the whole file (#5234)", async () => {
	const store = createStore();
	for (let index = 0; index < 40; index++) {
		store.recordRunStart({
			...makeRun([{ ...makeStage("stage"), result: "payload".repeat(10_000) }]),
			id: `run-${index}`,
		});
	}
	const snapshot = store.inspectionSnapshot!();
	const serializer = new StatusSnapshotSerializer();
	try {
		const chunks = await serializer.serialize(snapshot);
		assert.ok(Array.isArray(chunks), "the writer receives independently writable chunks");
		assert.ok(
			chunks.every((chunk) => chunk.length < 100_000),
			"no chunk combines multiple runs' payloads",
		);
		assert.equal(chunks.join(""), JSON.stringify(snapshot, null, 2));
	} finally {
		serializer.close();
	}
});
