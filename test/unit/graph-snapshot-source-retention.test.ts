import assert from "node:assert/strict";
import { test } from "vitest";
import { GraphStoreSnapshotBuilder } from "../../packages/workflows/src/shared/graph-store-snapshot.ts";
import type { StoreSnapshot } from "../../packages/workflows/src/shared/store-types.ts";
import { collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.ts";

test("a bounded graph snapshot does not retain its builder or omitted source inputs (#5224)", async () => {
	const tracked = trackCollection();
	const held: StoreSnapshot = await (async () => {
		const builder = new GraphStoreSnapshotBuilder();
		const inputs = { payload: { text: "source-only".repeat(25_000) } };
		tracked.track(builder);
		tracked.track(inputs);
		return builder.build(
			[
				{
					id: "retained-snapshot",
					name: "release",
					inputs,
					status: "completed",
					startedAt: 1,
					endedAt: 2,
					stages: [],
					toolNodes: [],
				},
			],
			[],
			1,
		);
	})();
	await collectEverythingTracked(tracked);
	assert.deepEqual(held.runs[0]?.inputs, {});
	assert.equal(held.runs[0]?.name, "release");
	assert.deepEqual(tracked.uncollected(), [], "retaining the bounded snapshot must not retain its source state");
});
