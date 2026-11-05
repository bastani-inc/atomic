import { afterEach, beforeEach, describe, vi } from "vitest";
import { STAGE_WAIT_RETRY_ATTEMPTS } from "../../packages/workflows/src/shared/stage-wait.js";
import type { SerializedStageWaitError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import {
	deserializeStageWaitError,
	isStageWaitRecordError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

const T0 = new Date("2026-03-01T00:00:00.000Z").getTime();

/** The two waits between three attempts, with the jitter of `Math.random() === 0.5`: 500 ms and 2 s. */
const BACKOFFS_MS = [500, 2_000];

function stageNamed(stages: readonly StageSnapshot[] | undefined, name: string): StageSnapshot | undefined {
	return stages?.find((stage) => stage.name === name);
}

describe("a waiting stage whose durable wait record cannot be written (#4309)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(T0);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("reports the stage's session, the attempts and the time they took, and leaves the stage running on (#4309)", async () => {
		const backend = await createMemoryTestBackend();
		const commit = backend.commitCheckpoint.bind(backend);
		const journal = { down: false };
		vi.spyOn(backend, "commitCheckpoint").mockImplementation(async (checkpoint, options) => {
			if (journal.down && checkpoint.kind === "stage") throw new Error("journal unreachable");
			return commit(checkpoint, options);
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const store = createStore();
		let duringWait: SerializedStageWaitError | undefined;
		const definition = workflow({
			name: "wait-record-down",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				await stage.prompt("plan");
				journal.down = true;
				await stage.release();
				duringWait = stageNamed(store.runs()[0]?.stages, "implement")?.waitRecordFailure;
				journal.down = false;
				await stage.rehydrate();
				return {};
			},
		});

		const running = run(
			definition,
			{},
			{
				store,
				durableBackend: backend,
				adapters: detachingAdapters(new FakeCiService(), counters(), { detach: false }),
			},
		);
		let finished = false;
		void running.finally(() => {
			finished = true;
		});
		while (!finished) await vi.advanceTimersByTimeAsync(500);
		const result = await running;

		assert.equal(result.status, "completed", result.error);
		assert.ok(duringWait !== undefined);
		const stage = stageNamed(result.stages, "implement");
		assert.equal(stage?.status, "completed");
		const failure = deserializeStageWaitError(duringWait);
		assert.ok(isStageWaitRecordError(failure));
		assert.equal(failure.fields.phase, "wait-start");
		assert.equal(failure.fields.attempts, STAGE_WAIT_RETRY_ATTEMPTS);
		assert.equal(failure.fields.sessionId, stage?.sessionId);
		assert.ok(typeof failure.fields.sessionId === "string");
		assert.equal(
			failure.fields.elapsedMs,
			BACKOFFS_MS.reduce((total, delay) => total + delay, 0),
		);
	});

	test("aborting the run while the stage waits to write its record again ends the wait with the run's reason (#4309)", async () => {
		const backend = await createMemoryTestBackend();
		const commit = backend.commitCheckpoint.bind(backend);
		const journal = { down: false };
		vi.spyOn(backend, "commitCheckpoint").mockImplementation(async (checkpoint, options) => {
			if (journal.down && checkpoint.kind === "stage") throw new Error("journal unreachable");
			return commit(checkpoint, options);
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const controller = new AbortController();
		const reason = new Error("run killed");
		const released = Promise.withResolvers<void>();
		const definition = workflow({
			name: "wait-record-abort",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				await stage.prompt("plan");
				journal.down = true;
				released.resolve();
				await stage.release();
				return {};
			},
		});

		const running = run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				signal: controller.signal,
				adapters: detachingAdapters(new FakeCiService(), counters(), { detach: false }),
			},
		);
		await released.promise;
		await vi.advanceTimersByTimeAsync(100);
		controller.abort(reason);
		await vi.advanceTimersByTimeAsync(0);
		const settled = await running;

		// Aborted while it waited to try again: the run ends killed at once, not after the two backoffs it had left.
		assert.equal(settled.status, "killed");
	});
});
