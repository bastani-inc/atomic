import { afterEach, describe, vi } from "vitest";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

/** Each state of one stage the store is told of, as `status/wait`. */
function observeStage(store: Store, stageName: string): string[] {
	const told: string[] = [];
	const original = store.recordStageStart.bind(store);
	store.recordStageStart = (runId: string, stage: StageSnapshot) => {
		if (stage.name === stageName) told.push(`${stage.status}/${stage.wait?.kind ?? "-"}`);
		original(runId, stage);
	};
	return told;
}

describe("what the run settles when the workflow finishes around waiting stages (#4309)", () => {
	afterEach(() => vi.restoreAllMocks());

	test("a stage paused while it waits released between turns stays paused when the workflow finishes (#4309)", async () => {
		const registry = createStageControlRegistry();
		const store = createStore();
		const definition = workflow({
			name: "paused-released",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const alpha = ctx.stage("alpha");
				await alpha.prompt("plan");
				await alpha.release();
				const run = store.runs()[0]!;
				await registry.get(run.id, run.stages[0]!.id)!.pause();
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				stageControlRegistry: registry,
				adapters: detachingAdapters(new FakeCiService(), counters(), { detach: false }),
			},
		);
		await registry.clear();

		assert.deepEqual(
			result.stages.map((stage) => [stage.name, stage.status]),
			[["alpha", "paused"]],
			result.error,
		);
	});

	test("a stage paused while it gives its session up for a tool wait shows paused, and runs again once resumed and woken (#4309)", async () => {
		const service = new FakeCiService();
		const registry = createStageControlRegistry();
		const store = createStore();
		const disposing = Promise.withResolvers<void>();
		const disposeGate = Promise.withResolvers<void>();
		let disposals = 0;
		const seen: { atWait?: string; afterWake?: string } = {};
		const told = observeStage(store, "implement");
		const definition = workflow({
			name: "paused-into-tool-wait",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const task = ctx.task("implement", { prompt: "watch ci" });
				await disposing.promise;
				const run = store.runs()[0]!;
				const handle = registry.get(run.id, run.stages[0]!.id)!;
				await handle.pause();
				disposeGate.resolve();
				const stage = (): StageSnapshot => store.runs()[0]!.stages[0]!;
				while (stage().wait === undefined) await new Promise((resolve) => setImmediate(resolve));
				seen.atWait = stage().status;
				await handle.resume();
				const resumedAt = told.length;
				service.finishAll();
				await task;
				seen.afterWake = told.slice(resumedAt).find((state) => state.endsWith("/-"));
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				stageControlRegistry: registry,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, counters(), {
					beforeDispose: () => {
						disposals += 1;
						if (disposals !== 1) return Promise.resolve();
						disposing.resolve();
						return disposeGate.promise;
					},
				}),
			},
		);
		await registry.clear();

		assert.equal(result.status, "completed", result.error);
		// Woken, the stage is shown running again, not paused as it was when its wait began.
		assert.deepEqual(seen, { atWait: "paused", afterWake: "running/-" });
	});

	test("a stage still waiting on its tool when the workflow returns is not shown settled as if released between turns (#4309)", async () => {
		const service = new FakeCiService();
		const store = createStore();
		const told = observeStage(store, "implement");
		let atReturn = -1;
		const definition = workflow({
			name: "tool-wait-at-return",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const waiting = Promise.withResolvers<void>();
				void ctx.task("implement", { prompt: "watch ci" }).catch(() => {});
				const unsubscribe = store.subscribe(() => {
					if (store.runs()[0]?.stages[0]?.status === "waiting") waiting.resolve();
				});
				await waiting.promise;
				unsubscribe();
				atReturn = told.length;
				return {};
			},
		});

		await run(
			definition,
			{},
			{
				store,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, counters()),
				onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
					void event;
				},
			},
		);
		service.finishAll();

		assert.ok(atReturn > 0);
		assert.equal(told.slice(atReturn).includes("completed/-"), false, told.slice(atReturn).join(" | "));
	});
});
