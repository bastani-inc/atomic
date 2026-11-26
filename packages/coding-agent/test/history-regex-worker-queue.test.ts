import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { describe, it, vi } from "vitest";

interface PostedMessage {
	readonly message: { readonly id: number };
}

interface FakeWorker extends EventEmitter {
	readonly posted: PostedMessage[];
	terminated: boolean;
	failNextPost?: Error;
}

const workers = vi.hoisted((): FakeWorker[] => []);
/** Longer than a task with no time limit runs on the shared worker before it gets that worker to itself. */
const HAND_OFF_WAIT_MS = 400;

vi.mock("node:worker_threads", async () => {
	const { EventEmitter } = await import("node:events");
	class Worker extends EventEmitter {
		readonly posted: PostedMessage[] = [];
		terminated = false;
		failNextPost?: Error;
		constructor() {
			super();
			workers.push(this);
		}
		postMessage(message: { readonly id: number }): void {
			if (this.failNextPost) {
				const error = this.failNextPost;
				this.failNextPost = undefined;
				throw error;
			}
			this.posted.push({ message });
		}
		terminate(): Promise<number> {
			this.terminated = true;
			return Promise.resolve(1);
		}
		unref(): void {}
	}
	return { Worker, default: { Worker } };
});

describe("history regex worker (#5250)", () => {
	it("ignores an error raised by a worker it already replaced (#5250)", async () => {
		const { matchLinesInWorker } = await import("../src/core/tools/history-regex-worker.js");
		const controller = new AbortController();
		const cancelled = matchLinesInWorker(["a"], "a", "", false, false, 10_000, controller.signal);
		const queued = matchLinesInWorker(["b"], "b", "", false, false, 10_000);
		let queuedOutcome: "pending" | "resolved" | "rejected" = "pending";
		queued.then(
			() => {
				queuedOutcome = "resolved";
			},
			() => {
				queuedOutcome = "rejected";
			},
		);
		const replaced = workers[0]!;
		controller.abort(new Error("cancelled"));
		await assert.rejects(cancelled, /cancelled/);
		assert.equal(replaced.terminated, true);
		const replacement = workers[1]!;
		assert.equal(replacement.posted.length, 1);

		replaced.emit("error", new Error("late failure of the replaced worker"));
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(replacement.terminated, false);
		assert.equal(queuedOutcome, "pending");
		replacement.emit("message", { id: replacement.posted[0]!.message.id, matchedIndices: [0] });
		assert.deepEqual((await queued).matchedIndices, [0]);
	});

	it("clears activeTask when postMessage throws so the next request dispatches immediately (#5250)", async () => {
		const { matchLinesInWorker } = await import("../src/core/tools/history-regex-worker.js");
		const worker = workers.at(-1)!;
		worker.failNextPost = new Error("postMessage transfer failed");
		await assert.rejects(matchLinesInWorker(["a"], "a", "", false, false, 10_000), /postMessage transfer failed/);

		const postedBefore = worker.posted.length;
		const next = matchLinesInWorker(["b"], "b", "", false, false, 10_000);
		assert.equal(worker.posted.length, postedBefore + 1);
		worker.emit("message", { id: worker.posted.at(-1)!.message.id, matchedIndices: [0] });
		assert.deepEqual((await next).matchedIndices, [0]);
	});

	it("a long task with no time limit keeps its worker and its result while the next task gets a new worker", async () => {
		const { matchLinesInWorker } = await import("../src/core/tools/history-regex-worker.js");
		const shared = workers.at(-1)!;
		const long = matchLinesInWorker(["a"], "a", "", false, false, Number.POSITIVE_INFINITY);
		const queued = matchLinesInWorker(["b"], "b", "", false, false, 10_000);
		const longId = shared.posted.at(-1)!.message.id;
		const before = workers.length;

		await new Promise((resolve) => setTimeout(resolve, HAND_OFF_WAIT_MS));
		assert.equal(workers.length, before + 1, "the queued task started on a new worker");
		const next = workers.at(-1)!;
		next.emit("message", { id: next.posted[0]!.message.id, matchedIndices: [0] });
		assert.deepEqual((await queued).matchedIndices, [0]);

		assert.equal(shared.terminated, false, "the long task still runs");
		shared.emit("message", { id: longId, matchedIndices: [0] });
		assert.deepEqual((await long).matchedIndices, [0]);
		assert.equal(shared.terminated, true, "its worker ends with it");
		assert.equal(next.terminated, false);
	});

	it("stopping a long task with no time limit ends the worker it was handed", async () => {
		const { matchLinesInWorker } = await import("../src/core/tools/history-regex-worker.js");
		const controller = new AbortController();
		const long = matchLinesInWorker(["a"], "a", "", false, false, Number.POSITIVE_INFINITY, controller.signal);
		const own = workers.at(-1)!;
		await new Promise((resolve) => setTimeout(resolve, HAND_OFF_WAIT_MS));
		const next = matchLinesInWorker(["b"], "b", "", false, false, 10_000);
		const fresh = workers.at(-1)!;
		assert.notEqual(fresh, own, "the next task did not wait behind the long one");

		controller.abort(new Error("stopped"));
		await assert.rejects(long, /stopped/);
		assert.equal(own.terminated, true);
		assert.equal(fresh.terminated, false);
		fresh.emit("message", { id: fresh.posted.at(-1)!.message.id, matchedIndices: [0] });
		assert.deepEqual((await next).matchedIndices, [0]);
	});
});
