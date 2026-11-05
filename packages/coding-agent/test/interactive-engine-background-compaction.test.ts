/**
 * Interactive mode runs its session in an engine process. The /settings background compaction rows must reach the
 * engine's session, and the host must mirror the engine's background compaction state with its typed error (#4330).
 */

import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
	BackgroundCompactionPlanningError,
	serializeBackgroundCompactionError,
} from "../src/core/compaction/background-compaction-errors.ts";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.js";

let pair: EngineHostPair | undefined;

afterEach(async () => {
	await pair?.cleanup();
	pair = undefined;
});

test("background compaction settings from the host reach the engine session (#4330)", async () => {
	pair = await createEngineHostPair({});
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	const host = pair.runtime.session;
	assert.equal(host.backgroundCompactionEnabled, true);
	assert.equal(host.backgroundCompactionThresholdPercent, 75);

	host.setBackgroundCompactionEnabled(false);
	host.setBackgroundCompactionThresholdPercent(60);
	assert.equal(host.backgroundCompactionEnabled, false);
	assert.equal(host.backgroundCompactionThresholdPercent, 60);
	await pair.drain();
	assert.equal(pair.engine.session.backgroundCompactionEnabled, false);
	assert.equal(pair.engine.session.backgroundCompactionThresholdPercent, 60);
	assert.equal(pair.engine.settingsManager.getCompactionBackground(), false);
});

test("the host mirrors the engine's background compaction state and typed error (#4330)", async () => {
	pair = await createEngineHostPair({});
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	const host = pair.runtime.session;
	assert.equal(host.compaction.state, "idle");
	const error = new BackgroundCompactionPlanningError({ upToEntryId: "m7", attempt: 2 }, { cause: new Error("boom") });

	pair.engineOutput({
		type: "background_compaction",
		compaction: {
			state: "failed",
			upToEntryId: "m7",
			startedAt: "2026-11-05T00:00:00.000Z",
			error: serializeBackgroundCompactionError(error),
		},
	});

	await vi.waitFor(() => assert.equal(host.compaction.state, "failed"));
	assert.equal(host.compaction.upToEntryId, "m7");
	assert.ok(host.compaction.error instanceof BackgroundCompactionPlanningError);
	assert.equal(host.compaction.error.attempt, 2);
});
