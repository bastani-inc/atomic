import { afterEach, vi } from "vitest";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, createStageControlRegistry, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

/** The stages' `releaseWhenWaiting` threshold. */
const AFTER_MS = 50;
/** Fake time let pass once the run returned: many thresholds, and longer than the idle scan's recheck of a busy stage. */
const AFTER_RUN_MS = 3_000;

afterEach(() => {
	vi.useRealTimers();
});

test("a run that a quit suspended stops its idle scan: a stage the workflow held is not released after the run returned (#4309)", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	const seen = counters();
	const registry = createStageControlRegistry();
	const store = createStore();
	const events: StageLifecycleEvent[] = [];
	const held = Promise.withResolvers<void>();
	const definition = workflow({
		name: "quit-while-holding",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("alpha").prompt("plan");
			held.resolve();
			// The workflow holds the stage, idle, until the quit suspends the run.
			await new Promise<void>(() => {});
			return {};
		},
	});

	const execution = run(
		definition,
		{},
		{
			store,
			stageControlRegistry: registry,
			durableBackend: await createMemoryTestBackend(),
			releaseWhenWaiting: { afterMs: AFTER_MS },
			adapters: detachingAdapters(new FakeCiService(), seen, { detach: false }),
			onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => events.push(event),
		},
	);
	await held.promise;
	const quit = await quitRun(store.runs()[0]!.id, { store, stageControlRegistry: registry });
	assert.equal(quit.ok, true);
	assert.equal((await execution).status, "paused");

	await vi.advanceTimersByTimeAsync(AFTER_RUN_MS);

	assert.equal(seen.disposed, 0, "the stage's session was released after the run returned");
	assert.deepEqual(
		events.filter((event) => event.type === "stage_waiting"),
		[],
	);
	await registry.clear();
});
