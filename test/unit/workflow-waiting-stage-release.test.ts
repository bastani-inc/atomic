import { getEventListeners } from "node:events";
import { describe } from "vitest";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService, TOOL } from "./waiting-stage-helpers.js";

/**
 * Structural cost, not a slow test: 2,000 real stages each run a session through release and wake, which takes a few
 * seconds on an idle machine and several times that under the parallel suite.
 */
const RELEASE_AT_SCALE_TIMEOUT_MS = 120_000;

/**
 * Run-wide resources (the wake dispatcher's one abort listener, the run's own timers) do not grow with the number of
 * waiting stages. One per stage would put thousands here.
 */
const RUN_WIDE_RESOURCE_BOUND = 16;

/** Handles that would keep the process busy on an idle stage's behalf: timers, sockets, child processes. */
function activeHandleCount(): number {
	return process.getActiveResourcesInfo().filter((kind) => kind !== "PromiseResolve" && kind !== "FSReqCallback")
		.length;
}

async function settle(): Promise<void> {
	for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
}

describe("waiting stages release their session (#4309)", () => {
	const STAGES = 2_000;
	const CONCURRENCY = 8;

	test(
		`${STAGES} stages waiting on a long tool hold no session, slot, timer or listener, and later stages are admitted`,
		async () => {
			const service = new FakeCiService();
			const seen = counters();
			const events: StageLifecycleEvent[] = [];
			const allWaiting = Promise.withResolvers<void>();
			let idle: { handles: number; listeners: number; live: number } | undefined;
			let peakLiveBeforeWake = 0;
			const baselineHandles = activeHandleCount();
			const store = createStore();
			const definition = workflow({
				name: "waiting-stage-release",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const tasks = Array.from({ length: STAGES }, (_, index) =>
						ctx.task(`stage-${index}`, { prompt: `watch ci ${index}` }),
					);
					await allWaiting.promise;
					await settle();
					peakLiveBeforeWake = seen.peakLive;
					idle = {
						handles: activeHandleCount() - baselineHandles,
						listeners: seen.runSignal === undefined ? 0 : getEventListeners(seen.runSignal, "abort").length,
						live: seen.created - seen.disposed,
					};
					service.finishAll();
					await Promise.all(tasks);
					return {};
				},
			});

			const result = await run(
				definition,
				{},
				{
					store,
					adapters: detachingAdapters(service, seen),
					config: { defaultConcurrency: CONCURRENCY } as never,
					releaseWhenWaiting: { afterMs: 0 },
					onStageLifecycleEvent: (_runId, event) => {
						events.push(event);
						if (events.filter((candidate) => candidate.type === "stage_waiting").length === STAGES)
							allWaiting.resolve();
					},
				},
			);

			assert.equal(result.status, "completed", result.error);
			assert.ok(idle !== undefined);
			// Every stage started and reached its wait although only CONCURRENCY slots exist: waiting stages gave theirs back.
			assert.equal(service.dispatches, STAGES);
			assert.deepEqual(idle, { handles: idle.handles, listeners: idle.listeners, live: 0 });
			assert.ok(
				idle.handles <= RUN_WIDE_RESOURCE_BOUND,
				`${idle.handles} handles stayed active for ${STAGES} idle stages`,
			);
			assert.ok(
				idle.listeners <= RUN_WIDE_RESOURCE_BOUND,
				`${idle.listeners} abort listeners stayed on the run for ${STAGES} idle stages`,
			);
			// Until the results arrive, sessions only exist for stages holding one of the CONCURRENCY slots.
			assert.ok(peakLiveBeforeWake <= CONCURRENCY, `${peakLiveBeforeWake} sessions were live at once`);
			// Each stage was prompted once and continued its turn once, from a reopened session.
			assert.deepEqual(new Set(seen.userPrompts.values()), new Set([1]));
			assert.equal(seen.userPrompts.size, STAGES);
			assert.deepEqual(new Set(seen.continued.values()), new Set([1]));
			assert.equal(seen.created, 2 * STAGES);
			assert.equal(seen.disposed, 2 * STAGES);
			assert.equal(events.filter((event) => event.type === "stage_waiting").length, STAGES);
			assert.equal(events.filter((event) => event.type === "stage_rehydrated").length, STAGES);
			const waitingEvent = events.find((event) => event.type === "stage_waiting");
			assert.deepEqual(waitingEvent?.type === "stage_waiting" ? waitingEvent.wait.toolCalls : undefined, [
				{ toolCallId: `call-${waitingEvent?.stageName}`, toolName: TOOL },
			]);
			assert.ok(store.runs()[0]!.stages.every((stage) => stage.status === "completed" && stage.wait === undefined));
		},
		RELEASE_AT_SCALE_TIMEOUT_MS,
	);
});
