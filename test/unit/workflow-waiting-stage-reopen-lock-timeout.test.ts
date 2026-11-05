import type { StorageDescriptor } from "@bastani/atomic/storage";
import { StorageWriteLockTimeoutError } from "@bastani/atomic/storage";
import { describe } from "vitest";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

const SHARED_STORE: StorageDescriptor = { adapter: "sqlite", location: "/shared/sessions.db" };
/** The lock wait the writer gave up after, as a SQLite store configured with the default would report it. */
const LOCK_WAIT_MS = 5_000;

/** Another process held the store's write lock for the whole lock wait, as a stopped writer does. */
function writeLockTimeout(): StorageWriteLockTimeoutError {
	return new StorageWriteLockTimeoutError(SHARED_STORE, {
		timeoutMs: LOCK_WAIT_MS,
		elapsedMs: LOCK_WAIT_MS,
		phase: "acquiring",
		holderPid: 4242,
	});
}

describe("a waiting stage whose store times out on its write lock when it is woken (#4309)", () => {
	test("tries the reopening again, as for a store briefly unreachable, and completes the turn without running the tool again (#4309)", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const events: StageLifecycleEvent["type"][] = [];
		const base = detachingAdapters(service, seen);
		const lockTimeouts: StorageWriteLockTimeoutError[] = [];
		// The stage's first session opens; the first reopening after its wait meets a held write lock, the next does not.
		const adapters: StageAdapters = {
			...base,
			agentSession: {
				async create(options, meta) {
					if (seen.created === 1 && lockTimeouts.length === 0) {
						const failure = writeLockTimeout();
						lockTimeouts.push(failure);
						throw failure;
					}
					return base.agentSession!.create(options, meta);
				},
			},
		};
		const definition = workflow({
			name: "reopen-after-lock-timeout",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("implement", { prompt: "watch ci" });
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				releaseWhenWaiting: { afterMs: 0 },
				adapters,
				onStageLifecycleEvent: (_runId, event) => {
					events.push(event.type);
					if (event.type === "stage_waiting") service.finishAll();
				},
			},
		);

		assert.equal(result.status, "completed", result.error);
		const stage = result.stages.find((candidate) => candidate.name === "implement");
		assert.equal(stage?.status, "completed");
		assert.equal(stage?.failureDetail, undefined);
		// One refused reopening, one that succeeded: the turn continued once from the result, the tool ran once.
		assert.equal(lockTimeouts.length, 1);
		assert.equal(seen.created, 2);
		assert.equal(service.dispatches, 1);
		assert.equal(seen.continued.get("implement"), 1);
		assert.equal(seen.userPrompts.get("implement"), 1);
		assert.deepEqual(events, ["stage_waiting", "stage_rehydrated"]);
	});
});
