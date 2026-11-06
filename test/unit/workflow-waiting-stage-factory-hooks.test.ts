import { getEventListeners } from "node:events";
import { afterEach, describe, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import { deliverStageWake, registerStageWakeKind } from "../../packages/workflows/src/sdk-surface.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { type Counters, counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

declare module "@bastani/atomic/workflows" {
	interface StageWakeKinds {
		/** Registered without a handler by the test that sends it to an ended stage. */
		"test-factory-ping": { readonly note: string };
	}
}

/** Fails instead of hanging the suite when `promise` does not settle in time. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Far longer than a run of two quick prompts takes, even on a loaded machine; a stage that kept the slot never ends. */
const SLOT_DEADLOCK_BOUND_MS = 10_000;

/**
 * How the stage factory's wait hooks act on the run around a stage's wait: its abort listeners, its admission slot,
 * and what the store is told when the workflow finishes.
 */

async function until(predicate: () => boolean): Promise<void> {
	for (let round = 0; round < 2_000 && !predicate(); round++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(predicate(), "condition never held");
}

function stageNamed(store: Store, name: string): StageSnapshot | undefined {
	return store.runs()[0]?.stages.find((candidate) => candidate.name === name);
}

/** The same adapters, with every session they create passed to `wrap`, with its stage's name, before the stage sees it. */
function wrapSessions(
	base: StageAdapters,
	wrap: (session: StageSessionRuntime, stageName: string, created: number) => void,
	failCreation?: (stageName: string, created: number) => Error | undefined,
): StageAdapters {
	const agentSession = base.agentSession!;
	const created = new Map<string, number>();
	return {
		...base,
		agentSession: {
			async create(options, meta) {
				const stageName = meta?.stageName ?? "stage";
				const number = (created.get(stageName) ?? 0) + 1;
				created.set(stageName, number);
				const failure = failCreation?.(stageName, number);
				if (failure !== undefined) throw failure;
				const session = (await agentSession.create(options, meta)) as StageSessionRuntime;
				wrap(session, stageName, number);
				return session;
			},
		},
	};
}

/** Well inside the shortest backoff before a second attempt to reopen (500 ms less its 20% jitter). */
const BACKOFF_PROBE_MS = 100;

function runAbortListeners(seen: Counters): number {
	return seen.runSignal === undefined ? -1 : getEventListeners(seen.runSignal, "abort").length;
}

function storeUnavailable(): StorageUnavailableError {
	return new StorageUnavailableError(
		{ adapter: "libsql", location: "the shared session store" },
		Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
	);
}

/** Each state of one stage the store is told of, as `status/wait/startup state`. */
function observeStage(store: Store, stageName: string): string[] {
	const told: string[] = [];
	const original = store.recordStageStart.bind(store);
	store.recordStageStart = (runId: string, stage: StageSnapshot) => {
		if (stage.name === stageName)
			told.push(`${stage.status}/${stage.wait?.kind ?? "-"}/${stage.startup?.state ?? "-"}`);
		original(runId, stage);
	};
	return told;
}

describe("the stage factory's wait hooks (#4309)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("a stage holds no abort listener on the run while it waits, and has them all back while its woken turn continues (#4309)", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const listeners: { prompting?: number; waiting?: number; continuing?: number; after?: number } = {};
		const adapters = wrapSessions(detachingAdapters(service, seen), (session) => {
			const prompt = session.prompt.bind(session);
			session.prompt = async (text, options) => {
				listeners.prompting ??= runAbortListeners(seen);
				await prompt(text, options);
			};
			const resume = session.resumeDetachedTurn!.bind(session);
			session.resumeDetachedTurn = async (results) => {
				listeners.continuing ??= runAbortListeners(seen);
				return resume(results);
			};
		});
		const definition = workflow({
			name: "abort-listeners-across-wait",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("implement", { prompt: "watch ci" });
				await new Promise((resolve) => setImmediate(resolve));
				listeners.after = runAbortListeners(seen);
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				adapters,
				releaseWhenWaiting: { afterMs: 0 },
				onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
					if (event.type !== "stage_waiting") return;
					listeners.waiting = runAbortListeners(seen);
					service.finishAll();
				},
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.ok(listeners.prompting !== undefined && listeners.after !== undefined);
		assert.ok(listeners.prompting > listeners.after);
		// While it waits the stage keeps none of its listeners on the run, as after it ended; its woken turn has them all.
		assert.equal(listeners.waiting, listeners.after);
		assert.equal(listeners.continuing, listeners.prompting);
	});

	test("a stage whose reopening the store refused gives its slot back while it waits to try again (#4309)", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const service = new FakeCiService();
		const seen = counters();
		const store = createStore();
		const log: string[] = [];
		const refused = Promise.withResolvers<void>();
		const adapters = wrapSessions(
			detachingAdapters(service, seen),
			(session, stageName) => {
				if (stageName === "review")
					session.prompt = async (text: string) => {
						log.push(`prompt:review:${text}`);
					};
				const resume = session.resumeDetachedTurn!.bind(session);
				session.resumeDetachedTurn = async (results) => {
					log.push(`continue:${stageName}`);
					return resume(results);
				};
			},
			(stageName, created) => {
				if (stageName !== "implement" || created !== 2) return undefined;
				log.push("reopen refused:implement");
				refused.resolve();
				return storeUnavailable();
			},
		);
		const definition = workflow({
			name: "slot-across-refused-reopen",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const implement = ctx.task("implement", { prompt: "watch ci" });
				await until(() => stageNamed(store, "implement")?.status === "waiting");
				service.finishAll();
				await refused.promise;
				const review = ctx.task("review", { prompt: "look" });
				await Promise.all([implement, review]);
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				adapters,
				config: { defaultConcurrency: 1 } as never,
				releaseWhenWaiting: { afterMs: 0 },
			},
		);

		assert.equal(result.status, "completed", result.error);
		// The one slot went to the other stage during the backoff, before the refused stage reopened and continued.
		assert.deepEqual(log, ["reopen refused:implement", "prompt:review:look", "continue:implement"]);
	});

	test("a stage waiting to try a refused reopening again holds no abort listener on the run (#4309)", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const service = new FakeCiService();
		const seen = counters();
		const listeners: { waiting?: number; backingOff?: number } = {};
		const adapters = wrapSessions(
			detachingAdapters(service, seen),
			() => {},
			(_stageName, created) => {
				if (created !== 2) return undefined;
				// Well inside the backoff before the next attempt, whatever its jitter.
				setTimeout(() => {
					listeners.backingOff = runAbortListeners(seen);
				}, BACKOFF_PROBE_MS);
				return storeUnavailable();
			},
		);
		const definition = workflow({
			name: "listeners-across-refused-reopen",
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
				adapters,
				releaseWhenWaiting: { afterMs: 0 },
				onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
					if (event.type !== "stage_waiting") return;
					listeners.waiting = runAbortListeners(seen);
					service.finishAll();
				},
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.ok(listeners.waiting !== undefined);
		assert.equal(listeners.backingOff, listeners.waiting);
	});

	test("a stage reopened between turns after it completed keeps no durability heartbeat (#4309)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const service = new FakeCiService();
		let checkpoints = 0;
		let checkpointsAfterReopen = -1;
		const definition = workflow({
			name: "reopened-completed-no-heartbeat",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("alpha");
				await stage.prompt("plan");
				await stage.release();
				await stage.rehydrate();
				const before = checkpoints;
				await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS * 3);
				checkpointsAfterReopen = checkpoints - before;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				adapters: detachingAdapters(service, counters(), { detach: false }),
				onStageSession: () => {
					checkpoints += 1;
				},
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(checkpointsAfterReopen, 0, "a completed stage is checkpointed on no interval once reopened");
	});

	test("a stage reopened between turns takes no admission slot, so the run's one slot still serves the next stage (#4309)", async () => {
		const service = new FakeCiService();
		const definition = workflow({
			name: "reopen-takes-no-slot",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const alpha = ctx.stage("alpha");
				await alpha.prompt("plan");
				await alpha.release();
				await alpha.rehydrate();
				await within(ctx.stage("beta").prompt("build"), SLOT_DEADLOCK_BOUND_MS, "the next stage's prompt");
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				config: { defaultConcurrency: 1 } as never,
				adapters: detachingAdapters(service, counters(), { detach: false }),
			},
		);

		assert.equal(result.status, "completed", result.error);
	});

	test("a stage released before its first prompt shows itself pending again when the workflow finishes (#4309)", async () => {
		const service = new FakeCiService();
		const registry = createStageControlRegistry();
		const store = createStore();
		const definition = workflow({
			name: "released-pending",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const alpha = ctx.stage("alpha");
				const run = store.runs()[0]!;
				await registry.get(run.id, run.stages[0]!.id)!.ensureAttached();
				await alpha.release();
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				stageControlRegistry: registry,
				adapters: detachingAdapters(service, counters(), { detach: false }),
			},
		);
		await registry.clear();

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			result.stages.map((stage) => [stage.name, stage.status, stage.wait]),
			[["alpha", "pending", undefined]],
		);
	});

	test("a stage whose reopening the store refused keeps showing the wait it entered, with its count of finished calls (#4309)", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const service = new FakeCiService();
		const store = createStore();
		let duringBackoff: StageSnapshot["wait"] | undefined;
		const adapters = wrapSessions(
			detachingAdapters(service, counters(), { detach: false }),
			() => {},
			(_stageName, created) => {
				if (created !== 2) return undefined;
				setTimeout(() => {
					duringBackoff = stageNamed(store, "alpha")?.wait;
				}, BACKOFF_PROBE_MS);
				return storeUnavailable();
			},
		);
		const definition = workflow({
			name: "refused-reopen-wait",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const alpha = ctx.stage("alpha");
				await alpha.prompt("plan");
				await alpha.release();
				await alpha.rehydrate();
				return {};
			},
		});

		const result = await run(definition, {}, { store, adapters });

		assert.equal(result.status, "completed", result.error);
		assert.equal(duringBackoff?.kind, "release");
		assert.equal(duringBackoff?.promptsCompleted, 1);
	});

	test("a stage that ended closes its mailbox: a message sent to it afterwards finds no open stage (#4309)", async () => {
		const unregister = registerStageWakeKind("test-factory-ping");
		const store = createStore();
		const deliveries: string[] = [];
		const definition = workflow({
			name: "ended-mailbox",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("check", { prompt: "go" });
				const run = store.runs()[0]!;
				await until(() => {
					const delivery = deliverStageWake(run.id, run.stages[0]!.id, {
						kind: "test-factory-ping",
						note: "late",
					});
					deliveries.push(delivery.status);
					return delivery.status === "stage-not-open";
				});
				return {};
			},
		});
		try {
			const result = await run(
				definition,
				{},
				{ store, adapters: detachingAdapters(new FakeCiService(), counters(), { detach: false }) },
			);

			assert.equal(result.status, "completed", result.error);
			assert.equal(deliveries.at(-1), "stage-not-open");
		} finally {
			unregister();
		}
	});

	test("a stage reopened between turns is not settled again when the workflow finishes (#4309)", async () => {
		const service = new FakeCiService();
		const store = createStore();
		const told = observeStage(store, "alpha");
		let atReturn = -1;
		const definition = workflow({
			name: "reopened-not-settled",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("alpha");
				await stage.prompt("plan");
				await stage.release();
				await stage.rehydrate();
				atReturn = told.length;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{ store, adapters: detachingAdapters(service, counters(), { detach: false }) },
		);

		assert.equal(result.status, "completed", result.error);
		assert.ok(told.includes("waiting/release/dispatched"), told.join(" | "));
		// Only the end of the reopened session's startup reaches the store once the workflow returned; the stage is not
		// settled again as if it were still released.
		assert.deepEqual(told.slice(atReturn), ["completed/-/cancelled"]);
	});
});
