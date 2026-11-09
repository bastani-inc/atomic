import { afterEach, beforeEach, describe, vi } from "vitest";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { STAGE_WAIT_RETRY_ATTEMPTS } from "../../packages/workflows/src/shared/stage-wait.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

/** Which of a stage's wait records failed, as the store was told of the stage each time, in order. */
function observeRecordFailures(store: Store, stageName: string): string[] {
	const told: string[] = [];
	const original = store.recordStageStart.bind(store);
	store.recordStageStart = (runId: string, stage: StageSnapshot) => {
		if (stage.name === stageName)
			told.push(`${stage.status}/${stage.wait?.kind ?? "-"}/${stage.waitRecordFailure?.fields.phase ?? "-"}`);
		original(runId, stage);
	};
	return told;
}

/** Drive `running` to its end in fake time, half a second at a time. */
async function finish<T>(running: Promise<T>): Promise<T> {
	let finished = false;
	void running.finally(() => {
		finished = true;
	});
	while (!finished) await vi.advanceTimersByTimeAsync(500);
	return running;
}

describe("a waiting stage's wait records that cannot be written (#4309)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z").getTime());
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("the store is shown the failed record of a wait's start while the stage still waits (#4309)", async () => {
		const backend = await createMemoryTestBackend();
		const commit = backend.commitCheckpoint.bind(backend);
		const journal = { down: false };
		vi.spyOn(backend, "commitCheckpoint").mockImplementation(async (checkpoint, options) => {
			if (journal.down && checkpoint.kind === "stage") throw new Error("journal unreachable");
			return commit(checkpoint, options);
		});
		const store = createStore();
		const told = observeRecordFailures(store, "implement");
		const definition = workflow({
			name: "wait-start-record-down",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				await stage.prompt("plan");
				journal.down = true;
				await stage.release();
				journal.down = false;
				await stage.rehydrate();
				return {};
			},
		});

		const result = await finish(
			run(
				definition,
				{},
				{
					store,
					durableBackend: backend,
					adapters: detachingAdapters(new FakeCiService(), counters(), { detach: false }),
				},
			),
		);

		assert.equal(result.status, "completed", result.error);
		assert.ok(told.includes("suspended/release/wait-start"), told.join(" | "));
	});

	test("the results a woken stage could not record are named as such, before anything else it records (#4309)", async () => {
		const backend = await createMemoryTestBackend();
		const commit = backend.commitCheckpoint.bind(backend);
		vi.spyOn(backend, "commitCheckpoint").mockImplementation(async (checkpoint, options) => {
			if (checkpoint.kind === "stage" && checkpoint.waitResults !== undefined)
				throw new Error("journal unreachable");
			return commit(checkpoint, options);
		});
		const service = new FakeCiService();
		const store = createStore();
		const told = observeRecordFailures(store, "implement");
		const definition = workflow({
			name: "wait-results-record-down",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("implement", { prompt: "watch ci" });
				return {};
			},
		});

		const result = await finish(
			run(
				definition,
				{},
				{
					store,
					durableBackend: backend,
					releaseWhenWaiting: { afterMs: 0 },
					adapters: detachingAdapters(service, counters()),
					onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
						if (event.type === "stage_waiting") service.finishAll();
					},
				},
			),
		);

		assert.equal(result.status, "completed", result.error);
		const failed = told.filter((state) => !state.endsWith("/-"));
		assert.ok(failed.length > 0, told.join(" | "));
		assert.ok(failed[0]!.endsWith("/wait-results"), told.join(" | "));
	});

	test("a run aborted while the last attempt to record a wait fails ends with its reason, not a degraded record (#4309)", async () => {
		const backend = await createMemoryTestBackend();
		const commit = backend.commitCheckpoint.bind(backend);
		const controller = new AbortController();
		const journal = { down: false, failures: 0 };
		vi.spyOn(backend, "commitCheckpoint").mockImplementation(async (checkpoint, options) => {
			if (journal.down && checkpoint.kind === "stage") {
				journal.failures += 1;
				if (journal.failures === STAGE_WAIT_RETRY_ATTEMPTS) controller.abort(new Error("run killed"));
				throw new Error("journal unreachable");
			}
			return commit(checkpoint, options);
		});
		const store = createStore();
		const told = observeRecordFailures(store, "implement");
		const definition = workflow({
			name: "wait-record-abort-last",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				await stage.prompt("plan");
				journal.down = true;
				await stage.release();
				return {};
			},
		});

		const result = await finish(
			run(
				definition,
				{},
				{
					store,
					durableBackend: backend,
					signal: controller.signal,
					adapters: detachingAdapters(new FakeCiService(), counters(), { detach: false }),
				},
			),
		);

		assert.equal(result.status, "killed");
		assert.equal(journal.failures, STAGE_WAIT_RETRY_ATTEMPTS);
		assert.deepEqual(
			told.filter((state) => !state.endsWith("/-")),
			[],
		);
	});
});
