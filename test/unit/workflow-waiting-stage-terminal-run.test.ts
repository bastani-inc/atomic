import { describe } from "vitest";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

type StageOutcome = "completed" | "failed";

async function runWithReleasedStage(outcome: StageOutcome) {
	const store = createStore();
	const seen = counters();
	const definition = workflow({
		name: `released-then-${outcome}`,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const stage = ctx.stage("holder");
			await stage.prompt("hold this");
			await stage.release();
			if (outcome === "failed") throw new Error("the run broke while holder was released");
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{ store, adapters: detachingAdapters(new FakeCiService(), seen, { detach: false }) },
	);
	return { store, result };
}

describe("a stage released when its run ends leaves waiting (#4309)", () => {
	for (const outcome of ["failed", "completed"] as const) {
		test(`a released ctx.stage of a ${outcome} run is no longer waiting in the result, store and status summary (#4309)`, async () => {
			const { store, result } = await runWithReleasedStage(outcome);

			assert.equal(result.status, outcome);
			const resultStage = result.stages.find((stage) => stage.name === "holder");
			assert.equal(resultStage?.status, "completed");
			assert.equal(resultStage?.wait, undefined);
			const stored = store.runs()[0]?.stages.find((stage) => stage.name === "holder");
			assert.equal(stored?.status, "completed");
			assert.equal(stored?.wait, undefined);
			const summary = summarizeRunSnapshot(store.runs()[0]!);
			assert.equal(summary.suspendedCount, 0);
			assert.deepEqual(summary.activeStages, []);
		});
	}
});
