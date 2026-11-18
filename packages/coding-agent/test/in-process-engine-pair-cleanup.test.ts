import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type CollectionCount,
	collectEverythingTracked,
	trackCollection,
} from "../../../test/helpers/collect-garbage.js";
import { createEngineHostPair } from "./helpers/in-process-engine-pair.ts";

async function runPairAndCleanUp(tracked: CollectionCount): Promise<void> {
	const pair = await createEngineHostPair({});
	tracked.track(pair.runtime);
	tracked.track(pair.engine.session);
	tracked.track(pair.hostHarness.session);
	await pair.cleanup();
}

test("cleaning up an in-process engine and host pair lets its host runtime and both sessions be collected", async () => {
	const tracked = trackCollection();
	for (let index = 0; index < 2; index++) await runPairAndCleanUp(tracked);

	await collectEverythingTracked(tracked, 100);

	assert.deepEqual(tracked.uncollected(), [], "a cleaned-up pair must not stay reachable from process-wide state");
});
