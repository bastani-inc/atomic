import assert from "node:assert/strict";
import {
	createWakeDispatcher,
	type EventSource,
	isSubscriptionHandlerError,
	openEventSubscription,
	StorageError,
	StorageUnavailableError,
	type SubscriptionEvent,
} from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition, WorkflowRunContext } from "../../packages/workflows/src/shared/types.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

afterEach(closeMemoryTestBackends);

const RUN_ID = "66666666-6666-4666-8666-000000004311";

function listSource(events: readonly SubscriptionEvent[]): EventSource {
	return {
		id: "faults",
		start: async (_signal, emit) => {
			for (const event of events) emit(event);
		},
	};
}

function diskFull(): StorageUnavailableError {
	const enospc = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
	return new StorageUnavailableError({ adapter: "sqlite", location: "journal.sqlite" }, enospc, "ENOSPC");
}

function processedIds(backend: MemoryJournalBackend): string[] {
	return backend
		.listCheckpoints(RUN_ID)
		.flatMap((checkpoint) =>
			checkpoint.kind === "tool" && checkpoint.checkpointId.startsWith("workflow-subscription-event:")
				? [String((checkpoint.output as { eventId: string }).eventId)]
				: [],
		)
		.sort();
}

async function runBody(backend: MemoryJournalBackend, body: (ctx: WorkflowRunContext) => Promise<void>) {
	const definition = workflow({
		name: "subscription-faults",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").complete("anchored");
			await body(ctx as WorkflowRunContext);
			return {};
		},
	}) as WorkflowDefinition;
	return await run(
		definition,
		{},
		{
			runId: RUN_ID,
			store: createStore(),
			durableBackend: backend,
			adapters: { complete: { complete: async (text: string) => text } },
		},
	);
}

test("disk full while recording an event fails the subscription with the storage error as cause; resume redoes only that event (#4311)", async () => {
	const backend = await createMemoryTestBackend();
	const commit = backend.commitCheckpoint.bind(backend);
	let failNext = true;
	backend.commitCheckpoint = async (checkpoint: DurableCheckpoint, options) => {
		if (failNext && checkpoint.kind === "tool" && checkpoint.output !== undefined) {
			const output = checkpoint.output as { eventId?: string };
			if (output.eventId === "e2") {
				failNext = false;
				throw diskFull();
			}
		}
		await commit(checkpoint, options);
	};
	const events = Array.from({ length: 6 }, (_, index) => ({ id: `e${index}` }));
	const handled: string[] = [];
	let failure: unknown;
	const first = await runBody(backend, async (ctx) => {
		try {
			await ctx.subscribe(
				listSource(events),
				async (event) => {
					handled.push(event.id);
				},
				{ maxConcurrent: 1 },
			).done;
		} catch (error) {
			failure = error;
		}
	});
	assert.equal(first.status, "completed", first.error);
	assert.equal(isSubscriptionHandlerError(failure), true);
	assert.equal((failure as { eventId: string }).eventId, "e2");
	assert.equal((failure as Error).cause instanceof StorageError, true);
	assert.deepEqual(processedIds(backend), ["e0", "e1"]);
	assert.deepEqual(handled, ["e0", "e1", "e2"]);

	const second = await runBody(backend, async (ctx) => {
		await ctx.subscribe(
			listSource(events),
			async (event) => {
				handled.push(event.id);
			},
			{ maxConcurrent: 1 },
		).done;
	});
	assert.equal(second.status, "completed", second.error);
	assert.deepEqual(handled, ["e0", "e1", "e2", "e2", "e3", "e4", "e5"]);
	assert.deepEqual(processedIds(backend), ["e0", "e1", "e2", "e3", "e4", "e5"]);
});

test("a failed subscription record stops the subscription before any handler runs (#4311)", async () => {
	const backend = await createMemoryTestBackend();
	const commit = backend.commitCheckpoint.bind(backend);
	const storageFailure = diskFull();
	backend.commitCheckpoint = async (checkpoint: DurableCheckpoint, options) => {
		if (checkpoint.checkpointId.startsWith("workflow-subscription:")) throw storageFailure;
		await commit(checkpoint, options);
	};
	const handled: string[] = [];
	let failure: unknown;
	const result = await runBody(backend, async (ctx) => {
		try {
			await ctx.subscribe(listSource([{ id: "a" }]), async (event) => {
				handled.push(event.id);
			}).done;
		} catch (error) {
			failure = error;
		}
	});
	assert.equal(result.status, "completed", result.error);
	assert.equal(failure, storageFailure);
	assert.deepEqual(handled, []);
	assert.deepEqual(processedIds(backend), []);
});

test("slow journal writes keep every event recorded once and the concurrency cap intact (#4311)", async () => {
	const backend = await createMemoryTestBackend();
	const commit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = async (checkpoint: DurableCheckpoint, options) => {
		await new Promise((resolve) => setTimeout(resolve, 2));
		await commit(checkpoint, options);
	};
	const events = Array.from({ length: 120 }, (_, index) => ({ id: `e${index}` }));
	let active = 0;
	let peak = 0;
	const result = await runBody(backend, async (ctx) => {
		const stats = await ctx.subscribe(
			listSource([...events, ...events]),
			async () => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 1));
				active -= 1;
			},
			{ maxConcurrent: 6 },
		).done;
		assert.deepEqual([stats.handled, stats.duplicates], [120, 120]);
	});
	assert.equal(result.status, "completed", result.error);
	assert.ok(peak <= 6, `peak ${peak}`);
	assert.deepEqual(processedIds(backend), events.map((event) => event.id).sort());
});

test("rate admission follows monotonic time: wall-clock jumps neither stall nor flood it (#4311)", async () => {
	let wall = 1_700_000_000_000;
	let monotonic = 0;
	const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
	const dispatcher = createWakeDispatcher({
		now: () => wall,
		elapsed: () => monotonic,
		setTimer: (callback, ms) => {
			const timer = { at: monotonic + ms, callback, cancelled: false };
			timers.push(timer);
			return {
				cancel: () => {
					timer.cancelled = true;
				},
			};
		},
	});
	const advance = (ms: number): void => {
		monotonic += ms;
		wall += ms;
		for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
			if (timer.cancelled) continue;
			if (timer.at <= monotonic) timer.callback();
			else timers.push(timer);
		}
	};
	const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
	const started: string[] = [];
	let emit: ((event: SubscriptionEvent) => void) | undefined;
	const subscription = openEventSubscription({
		id: "skewed-rate",
		source: {
			id: "manual",
			start: (_signal, push) => {
				emit = push;
			},
		},
		dispatcher,
		admission: { maxConcurrent: 10, maxRate: { events: 2, intervalMs: 1000 } },
		handle: async (event) => {
			started.push(event.id);
		},
	});
	await settle();
	for (const id of ["a", "b", "c", "d", "e", "f"]) emit?.({ id });
	await settle();
	assert.deepEqual(started, ["a", "b"]);
	wall -= 60 * 60 * 1000;
	advance(1000);
	await settle();
	assert.deepEqual(started, ["a", "b", "c", "d"]);
	wall += 2 * 60 * 60 * 1000;
	advance(10);
	await settle();
	assert.deepEqual(started, ["a", "b", "c", "d"]);
	advance(990);
	await settle();
	assert.deepEqual(started, ["a", "b", "c", "d", "e", "f"]);
	await subscription.close();
	assert.equal(dispatcher.pending, 0);
});
