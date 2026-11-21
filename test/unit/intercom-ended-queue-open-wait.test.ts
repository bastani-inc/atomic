import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	DurableEndedQueue,
	type DurableEndedQueueHost,
	ENDED_QUEUE_OPEN_WAIT_MS,
	ENDED_QUEUE_TOTAL_WAIT_MS,
} from "../../packages/intercom/broker/durable-ended-queue.js";
import { EndedChildWakeBudget } from "../../packages/intercom/broker/ended-child-wakes.js";
import {
	type EndedChildQueueStore,
	openLocalEndedChildQueueStore,
} from "../../packages/intercom/broker/sql-ended-child-queue-store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * #6126: a broker decides at its first registration whether its local store keeps the queue of messages for subagents
 * that ended, waiting a bounded time for the store to open. Loading the store's code comes first, and on a busy machine
 * it stops the broker for longer than that wait.
 */

/** How long loading the store's code stops the broker here: longer than the open wait, within the total wait. */
const CODE_LOAD_STALL_MS = ENDED_QUEUE_OPEN_WAIT_MS + 500;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function queueWith(host: Pick<DurableEndedQueueHost, "openStore" | "storeCodeLoaded">) {
	const outcome = { retired: false, logs: [] as string[] };
	const queue = new DurableEndedQueue({
		...host,
		routingStarted: () => undefined,
		retireStore: () => {
			outcome.retired = true;
		},
		budget: new EndedChildWakeBudget(),
		delivered: () => "unknown",
		log: (text) => outcome.logs.push(text),
	});
	cleanups.push(() => queue.close());
	return { queue, outcome };
}

test("a broker uses its local store when loading the store's code stops it for longer than the open wait (#6126)", async () => {
	const directory = makeTempDirectory("ended-queue-open-wait-");
	cleanups.push(() => removeTempDirectory(directory));
	// The code loads on a later turn, as the first registration's open starts it, and stops the whole broker meanwhile.
	const codeLoaded = new Promise<void>((resolve) => {
		setImmediate(() => {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CODE_LOAD_STALL_MS);
			resolve();
		});
	});
	let store: EndedChildQueueStore | undefined;
	const { queue, outcome } = queueWith({
		storeCodeLoaded: () => codeLoaded,
		openStore: async () => {
			await codeLoaded;
			store = await openLocalEndedChildQueueStore(join(directory, "ended-child-queue.sqlite"), "broker-after");
			return store;
		},
	});

	await queue.decide(() => {});

	assert.equal(queue.durable, true, outcome.logs.join("\n"));
	assert.equal(queue.storeId, store?.id);
	assert.equal(outcome.retired, false, "what the earlier broker kept is not given up");
});

test("a broker whose local store's code never loads keeps the queue in memory within the total wait (#6126)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	cleanups.push(() => {
		vi.useRealTimers();
	});
	const never = new Promise<never>(() => {});
	const { queue, outcome } = queueWith({
		storeCodeLoaded: () => never,
		openStore: async () => never,
	});
	let decided = false;
	void queue
		.decide(() => {})
		.then(() => {
			decided = true;
		});

	await vi.advanceTimersByTimeAsync(ENDED_QUEUE_TOTAL_WAIT_MS - 1);
	assert.equal(decided, false, "the first registration waits for the store's code within the total wait");
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(decided, true, "and no longer");
	assert.equal(queue.durable, false);
	assert.equal(outcome.retired, true);
});
