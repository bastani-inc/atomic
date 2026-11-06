import { afterEach, describe, vi } from "vitest";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { assert, createStore, mockSession, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

/** The stage's `releaseWhenWaiting` threshold in these runs. */
const AFTER_MS = 50;
/** How long the stage's own prompt runs: several thresholds, so the run's scan finds the stage busy meanwhile. */
const PROMPT_MS = 4 * AFTER_MS;
/** The run's scan looks at a stage it found busy again this much later; a release this late was not due to the call. */
const BUSY_RECHECK_MS = 1_000;
/** Fake time is advanced in steps this long, so each scan runs close to when it is due. */
const STEP_MS = 10;
/** Structural cost: the run is driven through its prompt and the scan in fake time, a step per loop. */
const FAKE_TIME_RUN_TIMEOUT_MS = 60_000;

/** Adapters whose prompts (of the stages `slow` names, or all) take `PROMPT_MS` of (fake) time to finish their turn. */
function slowPrompts(base: StageAdapters, slow: (stageName: string) => boolean = () => true): StageAdapters {
	const agentSession = base.agentSession!;
	return {
		...base,
		agentSession: {
			async create(options, meta) {
				const session = (await agentSession.create(options, meta)) as StageSessionRuntime;
				if (!slow(meta?.stageName ?? "")) return session;
				const prompt = session.prompt.bind(session);
				session.prompt = async (text, promptOptions) => {
					await new Promise((resolve) => setTimeout(resolve, PROMPT_MS));
					await prompt(text, promptOptions);
				};
				return session;
			},
		},
	};
}

/** Advance fake time in steps until `settled` holds or `limitMs` of fake time passed. */
async function advanceUntil(settled: () => boolean, limitMs: number): Promise<void> {
	for (let elapsed = 0; elapsed < limitMs && !settled(); elapsed += STEP_MS)
		await vi.advanceTimersByTimeAsync(STEP_MS);
}

describe("the run's idle scan watches a stage from the end of its call (#4309)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test(
		"a stage whose call outlasted its threshold is released one threshold after the call ended (#4309)",
		async () => {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
			const service = new FakeCiService();
			let promptEndedAt: number | undefined;
			let releasedAt: number | undefined;
			const released = Promise.withResolvers<void>();
			const definition = workflow({
				name: "idle-after-call",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("alpha").prompt("plan");
					promptEndedAt = Date.now();
					await released.promise;
					return {};
				},
			});

			const running = run(
				definition,
				{},
				{
					store: createStore(),
					adapters: slowPrompts(detachingAdapters(service, counters(), { detach: false })),
					releaseWhenWaiting: { afterMs: AFTER_MS },
					onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
						if (event.type !== "stage_waiting") return;
						releasedAt = Date.now();
						released.resolve();
					},
				},
			);
			let finished = false;
			void running.finally(() => {
				finished = true;
			});
			await advanceUntil(() => finished, PROMPT_MS + 2 * BUSY_RECHECK_MS);
			const result = await running;

			assert.equal(result.status, "completed", result.error);
			assert.ok(promptEndedAt !== undefined && releasedAt !== undefined);
			const after = releasedAt - promptEndedAt;
			assert.ok(after >= AFTER_MS && after <= AFTER_MS + 2 * STEP_MS, `released ${after} ms after its call ended`);
		},
		FAKE_TIME_RUN_TIMEOUT_MS,
	);

	test(
		"a completed stage whose next call waits for an admission slot is not released while the call waits (#4309)",
		async () => {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
			const service = new FakeCiService();
			const events: StageLifecycleEvent[] = [];
			let releasedWhileQueued: string[] | undefined;
			const definition = workflow({
				name: "idle-queued-call",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const alpha = ctx.stage("alpha");
					await alpha.prompt("plan");
					// beta takes the run's one slot for several thresholds; alpha's next call queues behind it.
					const beta = ctx.stage("beta").prompt("build");
					await new Promise((resolve) => setTimeout(resolve, STEP_MS));
					const follow = alpha.sendUserMessage("report");
					await beta;
					releasedWhileQueued = events.map((event) => `${event.type}:${event.stageName}`);
					await follow;
					return {};
				},
			});

			const running = run(
				definition,
				{},
				{
					store: createStore(),
					config: { defaultConcurrency: 1 } as never,
					adapters: slowPrompts(
						detachingAdapters(service, counters(), { detach: false }),
						(stageName) => stageName === "beta",
					),
					releaseWhenWaiting: { afterMs: AFTER_MS },
					onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => events.push(event),
				},
			);
			let finished = false;
			void running.finally(() => {
				finished = true;
			});
			await advanceUntil(() => finished, PROMPT_MS + 2 * BUSY_RECHECK_MS);
			const result = await running;

			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(releasedWhileQueued, [], "alpha was released while its call waited for a slot");
		},
		FAKE_TIME_RUN_TIMEOUT_MS,
	);

	test(
		"a finished task's stage that cannot be released is not polled while the run goes on (#4309)",
		async () => {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
			let reads = 0;
			let readsAfterTask: number | undefined;
			const quiet = Promise.withResolvers<void>();
			const definition = workflow({
				name: "finished-task-not-polled",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.task("check", { prompt: "go" });
					const before = reads;
					await quiet.promise;
					readsAfterTask = reads - before;
					return {};
				},
			});
			// A session with no store behind it: the run can never release it, so it stays resident.
			const adapters: StageAdapters = {
				agentSession: {
					create: async () => {
						const session = { ...mockSession(), setToolDetachment() {} };
						Object.defineProperty(session, "isStreaming", {
							get: () => {
								reads += 1;
								return false;
							},
						});
						return session;
					},
				},
			};

			const running = run(
				definition,
				{},
				{ store: createStore(), adapters, releaseWhenWaiting: { afterMs: AFTER_MS } },
			);
			await advanceUntil(() => false, 20 * AFTER_MS);
			quiet.resolve();
			const result = await running;

			assert.equal(result.status, "completed", result.error);
			assert.equal(readsAfterTask, 0, "the run kept looking at a finished task's session");
		},
		FAKE_TIME_RUN_TIMEOUT_MS,
	);

	test(
		"a stage waiting released on its tool keeps the run's idle scan off while it waits (#4309)",
		async () => {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
			const service = new FakeCiService();
			const waiting = Promise.withResolvers<void>();
			let armedWhileWaiting: number | undefined;
			const definition = workflow({
				name: "no-scan-while-waiting",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const task = ctx.task("implement", { prompt: "watch ci" });
					await waiting.promise;
					const timers = vi.spyOn(globalThis, "setTimeout");
					await vi.advanceTimersByTimeAsync(5 * BUSY_RECHECK_MS);
					armedWhileWaiting = timers.mock.calls.length;
					timers.mockRestore();
					service.finishAll();
					await task;
					return {};
				},
			});

			const result = await run(
				definition,
				{},
				{
					store: createStore(),
					adapters: detachingAdapters(service, counters()),
					releaseWhenWaiting: { afterMs: AFTER_MS },
					onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
						if (event.type === "stage_waiting") waiting.resolve();
					},
				},
			);

			assert.equal(result.status, "completed", result.error);
			assert.equal(armedWhileWaiting, 0, "a timer was armed for a stage that only waits");
		},
		FAKE_TIME_RUN_TIMEOUT_MS,
	);

	test(
		"a stage someone watches through its handle is not released however long the workflow holds it (#4309)",
		async () => {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
			const service = new FakeCiService();
			const registry = createStageControlRegistry();
			const store = createStore();
			const events: StageLifecycleEvent[] = [];
			let releasedWhileWatched: number | undefined;
			const holding = Promise.withResolvers<void>();
			const definition = workflow({
				name: "idle-watched",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("alpha").prompt("plan");
					const runId = store.runs()[0]!.id;
					const stageId = store.runs()[0]!.stages[0]!.id;
					const unsubscribe = registry.get(runId, stageId)!.subscribe(() => {});
					await holding.promise;
					releasedWhileWatched = events.length;
					unsubscribe();
					return {};
				},
			});

			const running = run(
				definition,
				{},
				{
					store,
					stageControlRegistry: registry,
					adapters: detachingAdapters(service, counters(), { detach: false }),
					releaseWhenWaiting: { afterMs: AFTER_MS },
					onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => events.push(event),
				},
			);
			await advanceUntil(() => false, 3 * BUSY_RECHECK_MS);
			holding.resolve();
			let finished = false;
			void running.finally(() => {
				finished = true;
			});
			await advanceUntil(() => finished, BUSY_RECHECK_MS);
			const result = await running;
			await registry.clear();

			assert.equal(result.status, "completed", result.error);
			assert.equal(releasedWhileWatched, 0, "the stage was released while its handle had a subscriber");
		},
		FAKE_TIME_RUN_TIMEOUT_MS,
	);
});
