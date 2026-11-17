import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { describe, it, vi } from "vitest";

interface PostedMessage {
	readonly message: { readonly id: number };
}

interface FakeWorker extends EventEmitter {
	readonly posted: PostedMessage[];
	terminated: boolean;
}

const workers = vi.hoisted((): FakeWorker[] => []);

vi.mock("node:worker_threads", async () => {
	const { EventEmitter } = await import("node:events");
	class Worker extends EventEmitter {
		readonly posted: PostedMessage[] = [];
		terminated = false;
		constructor() {
			super();
			workers.push(this);
		}
		postMessage(message: { readonly id: number }): void {
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
});
