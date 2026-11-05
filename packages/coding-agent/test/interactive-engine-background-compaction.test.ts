/**
 * Interactive mode runs its session in an engine process. The /settings background compaction rows must reach the
 * engine's session, and the host must mirror the engine's background compaction state with its typed error (#4330).
 */

import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	BackgroundCompactionPlanningError,
	serializeBackgroundCompactionError,
} from "../src/core/compaction/background-compaction-errors.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.js";
import { createHarness } from "./suite/harness.ts";

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

test("the host adopts the engine's background compaction settings and state when it synchronizes (#4330)", async () => {
	pair = await createEngineHostPair({});
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	const host = pair.runtime.session;
	const diagnostics: string[] = [];
	pair.runtime.onDiagnostic((diagnostic) => diagnostics.push(diagnostic.message));
	pair.failCommand("set_background_compaction", "engine refused");
	pair.failCommand("set_background_compaction_threshold", "engine refused");
	host.setBackgroundCompactionEnabled(false);
	host.setBackgroundCompactionThresholdPercent(50);
	await pair.drain();
	assert.equal(pair.engine.session.backgroundCompactionEnabled, true);
	await vi.waitFor(() => assert.equal(diagnostics.length, 2));
	assert.deepEqual(diagnostics.sort(), [
		"Interactive engine set background compaction failed: engine refused",
		"Interactive engine set background compaction threshold failed: engine refused",
	]);
	const failure = new BackgroundCompactionPlanningError({ upToEntryId: "m3", attempt: 1 });
	(pair.engine.session as unknown as { _backgroundCompaction: { failure: object } })._backgroundCompaction.failure = {
		error: failure,
		upToEntryId: "m3",
		startedAt: "2026-11-05T00:00:00.000Z",
	};

	await pair.runtime.initializeFromEngine();

	assert.equal(host.backgroundCompactionEnabled, true, "the engine's setting wins");
	assert.equal(host.backgroundCompactionThresholdPercent, 75);
	assert.equal(host.compaction.state, "failed");
	assert.ok(host.compaction.error instanceof BackgroundCompactionPlanningError);
	assert.equal(host.compaction.upToEntryId, "m3");
});

test("background compaction settings apply before optional resources finish loading (#4330)", async () => {
	const harness = await createHarness();
	const runtime = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	const waitForResources = vi.fn(() => new Promise<void>(() => {}));
	const handle = createRpcCommandHandler({
		runtimeHost: runtime,
		getSession: () => harness.session,
		rebindSession: async () => {},
		output: vi.fn(),
		waitForResources,
	});
	try {
		assert.deepEqual(await handle({ id: "off", type: "set_background_compaction", enabled: false }), {
			id: "off",
			type: "response",
			command: "set_background_compaction",
			success: true,
		});
		await handle({ id: "threshold", type: "set_background_compaction_threshold", percent: 60 });
		assert.equal(waitForResources.mock.calls.length, 0);
		assert.equal(harness.session.backgroundCompactionEnabled, false);
		assert.equal(harness.session.backgroundCompactionThresholdPercent, 60);
	} finally {
		harness.cleanup();
	}
});
