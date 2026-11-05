import { afterEach, describe, vi } from "vitest";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

/** Long enough that the stage's own prompt finishes well inside it, even on a loaded machine. */
const IDLE_THRESHOLD_MS = 100;

describe("a stage the run's idle scan could not release (#4309)", () => {
	afterEach(() => vi.restoreAllMocks());

	test("the run warns once with the run, the stage and the failure, and goes on to completion (#4309)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const failure = new Error("session would not close");
		const definition = workflow({
			name: "idle-release-fails",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("held");
				await stage.prompt("plan");
				await new Promise((resolve) => setTimeout(resolve, IDLE_THRESHOLD_MS * 4));
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				releaseWhenWaiting: { afterMs: IDLE_THRESHOLD_MS },
				adapters: detachingAdapters(new FakeCiService(), counters(), {
					detach: false,
					beforeDispose: async () => {
						throw failure;
					},
				}),
			},
		);

		assert.equal(result.status, "completed", result.error);
		const stageId = result.stages[0]?.id;
		assert.ok(stageId !== undefined);
		const idleWarnings = warn.mock.calls.filter((call) => String(call[0]).includes("could not release idle stage"));
		assert.deepEqual(idleWarnings, [
			[`atomic-workflows: run ${result.runId} could not release idle stage ${stageId}`, failure],
		]);
	});
});
