import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { type PoolWork, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	type CoordinatorEvent,
	POOL_SUMMARY_INTERVAL_MS,
} from "../../packages/workflows/src/workers/coordinator-protocol.js";
import type { FakeWorker } from "../helpers/fake-pool-worker.js";
import { coordinatorFixture, SOURCE } from "../helpers/pool-coordinator.js";

const forked = vi.hoisted((): FakeWorker[] => []);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { FakeWorker } = await import("../helpers/fake-pool-worker.js");
	return {
		...actual,
		fork(_modulePath: string, args: readonly string[], options: ForkOptions) {
			const worker = new FakeWorker(6_000_000 + forked.length, args, options);
			forked.push(worker);
			return worker;
		},
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	forked.length = 0;
});

/** Summaries the coordinator would have sent while the answer was held, had it not held the work's activity. */
const HELD_SUMMARIES = 4;

function childRun(id: string): RunSnapshot {
	return { id, name: id, inputs: {}, status: "running", startedAt: 0, stages: [], toolNodes: [] };
}

function names(event: CoordinatorEvent, workId: string): boolean {
	return event.kind === "activity" && event.entries.some((entry) => entry.work.id === workId);
}

test("a child's activity reaches the root only after the answer to its enqueue, which names the work to the root (#5376)", async () => {
	const f = await coordinatorFixture(forked, { workers: 1, publish: true, start: false });
	const answer = Promise.withResolvers<void>();
	try {
		const starting = f.command({ kind: "start", sources: [SOURCE], cwd: f.directory, publish: true });
		while (forked.length < 1) await delay(5);
		const [worker] = forked as [FakeWorker];
		await worker.request({ kind: "ready" });
		await starting;
		// The enqueue's answer waits for the child's recorded result, which this read holds back; the work is queued
		// already, so the worker claims it and publishes the child's activity meanwhile.
		const read = SqlPoolQueue.prototype.result;
		vi.spyOn(SqlPoolQueue.prototype, "result").mockImplementation(async function (this: SqlPoolQueue, ...args) {
			await answer.promise;
			return read.apply(this, args);
		});
		const enqueued = f.command({ kind: "enqueue", descriptor: f.descriptor, boundary: f.boundary }) as Promise<{
			readonly work: PoolWork;
		}>;
		const claimed = (await worker.request({ kind: "claim" })).value as PoolWork;
		assert.equal(claimed.childRunId, f.descriptor.childRunId, "the worker holds the child being enqueued");
		await worker.request({ kind: "activity", runs: [childRun(f.descriptor.childRunId)] });
		await delay(HELD_SUMMARIES * POOL_SUMMARY_INTERVAL_MS);
		assert.equal(
			f.events.some((event) => names(event, claimed.id)),
			false,
			"the root, which has no answer naming the work yet, is not sent its activity",
		);
		answer.resolve();
		const { work } = await enqueued;
		assert.equal(work.id, claimed.id);
		await f.next((event): event is CoordinatorEvent => names(event, claimed.id));
		const answered = f.events.findIndex(
			(event) => event.kind === "reply" && (event.value as { work?: PoolWork } | undefined)?.work?.id === claimed.id,
		);
		const activity = f.events.findIndex((event) => names(event, claimed.id));
		assert.ok(answered >= 0 && answered < activity, "the activity follows the answer that names its work");
	} finally {
		// The coordinator closes only once the enqueue it is answering has its result.
		answer.resolve();
		await f.close();
	}
});
