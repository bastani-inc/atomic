import { afterEach, describe, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

/** Each state of one stage the store is told of, as `status/wait`, plus `/results` while it holds woken results. */
function stateOf(stage: StageSnapshot): string {
	return `${stage.status}/${stage.wait?.kind ?? "-"}${stage.waitResults === undefined ? "" : "/results"}${stage.startup === undefined ? "" : `/startup:${stage.startup.state}:${stage.startup.phase ?? ""}`}`;
}

function observeStage(store: Store, stageName: string): string[] {
	const told: string[] = [];
	const original = store.recordStageStart.bind(store);
	store.recordStageStart = (runId: string, stage: StageSnapshot) => {
		if (stage.name === stageName) told.push(stateOf(stage));
		original(runId, stage);
	};
	return told;
}

/** Adapters whose `n`th session creation is held until `gate` opens, after announcing it was reached. */
function gatedAt(
	base: StageAdapters,
	failures: ReadonlyMap<number, Error>,
	gated: { readonly number: number; readonly reached: PromiseWithResolvers<void>; readonly gate: Promise<void> },
): StageAdapters {
	let created = 0;
	const create = base.agentSession!.create.bind(base.agentSession);
	return {
		...base,
		agentSession: {
			async create(options, meta) {
				created += 1;
				const failure = failures.get(created);
				if (failure !== undefined) throw failure;
				if (created === gated.number) {
					gated.reached.resolve();
					await gated.gate;
				}
				return create(options, meta);
			},
		},
	};
}

describe("the store is told each time a stage's wait begins, changes or ends (#4309)", () => {
	afterEach(() => vi.restoreAllMocks());

	test("a stage released between turns is shown waiting at once, shown running again as it starts to reopen, and shown as it was when its run ends released (#4309)", async () => {
		const service = new FakeCiService();
		const store = createStore();
		const told = observeStage(store, "alpha");
		const reached = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const windows: { released?: string[]; reopening?: string[]; releasedAgain?: string[] } = {};
		let beforeEnd = 0;
		const definition = workflow({
			name: "notifications",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("alpha");
				await stage.prompt("plan");
				const afterPrompt = told.length;
				await stage.release();
				windows.released = told.slice(afterPrompt);
				const beforeReopen = told.length;
				const reopening = stage.rehydrate();
				await reached.promise;
				windows.reopening = told.slice(beforeReopen);
				gate.resolve();
				await reopening;
				const beforeRelease = told.length;
				await stage.release();
				windows.releasedAgain = told.slice(beforeRelease);
				beforeEnd = told.length;
				return {};
			},
		});
		const base = detachingAdapters(service, counters(), { detach: false });
		const result = await run(
			definition,
			{},
			{ store, adapters: gatedAt(base, new Map(), { number: 2, reached, gate: gate.promise }) },
		);

		assert.equal(result.status, "completed", result.error);
		// Releasing tells the store once, with the wait shown.
		assert.deepEqual(windows.released, [`waiting/release/startup:dispatched:first-dispatch`]);
		assert.deepEqual(windows.releasedAgain, [`waiting/release/startup:active:ready`]);
		// Reopening tells it first that the stage no longer waits and is back to how it was, before the new session starts.
		assert.equal(windows.reopening?.[0], "completed/-/startup:dispatched:first-dispatch");
		assert.ok(windows.reopening?.slice(1).every((state) => state.startsWith("completed/-/startup:active:")));
		// The run ended with the stage still released: the store is told it is no longer waiting.
		assert.ok(told.at(-1)?.startsWith("completed/-/"), told.at(-1));
		assert.ok(told.length - beforeEnd >= 1);
		assert.equal(
			told.slice(beforeEnd).every((state) => state.startsWith("completed/-/")),
			true,
		);
		assert.equal(told.slice(beforeEnd).length, 2);
	});

	test("a stage woken from a tool wait is shown running with the results it was woken with, waiting again when a reopening fails, and running again on the next attempt (#4309)", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const service = new FakeCiService();
		const store = createStore();
		const told = observeStage(store, "implement");
		const reached = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const definition = workflow({
			name: "notifications-tool",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("implement", { prompt: "watch ci" });
				return {};
			},
		});
		const failure = new StorageUnavailableError(
			{ adapter: "libsql", location: "the shared session store" },
			Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
		);
		let waitingAt = -1;
		const running = run(
			definition,
			{},
			{
				store,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: gatedAt(detachingAdapters(service, counters()), new Map([[2, failure]]), {
					number: 3,
					reached,
					gate: gate.promise,
				}),
				onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
					if (event.type !== "stage_waiting") return;
					waitingAt = told.length - 1;
					service.finishAll();
				},
			},
		);
		await reached.promise;
		const sinceWaiting = told.slice(waitingAt);
		gate.resolve();
		const result = await running;

		assert.equal(result.status, "completed", result.error);
		// The wait begins with the stage waiting on its tool; the results it was woken with are recorded before it runs.
		assert.equal(sinceWaiting[0], "waiting/tool/startup:dispatched:first-dispatch");
		assert.equal(sinceWaiting[1], "running/-/results/startup:dispatched:first-dispatch");
		// The refused attempt shows the stage waiting again, keeping the results, and the next attempt running again.
		const refused = sinceWaiting.indexOf("waiting/tool/results/startup:failed:resource-preparation");
		assert.ok(refused > 1, sinceWaiting.join(" | "));
		assert.equal(sinceWaiting[refused - 1], "running/-/results/startup:failed:resource-preparation");
		assert.equal(sinceWaiting[refused + 1], "running/-/results/startup:failed:resource-preparation");
		// Once the turn continued, the results are in the transcript and the record no longer holds them.
		assert.ok(told.at(-1)?.startsWith("running/-/startup:"), told.at(-1));
	});
});
