import assert from "node:assert/strict";
import { test } from "vitest";
import {
	JournalDurableBackend,
	JournalExecutionRetiredError,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { JournalEntry } from "../../packages/workflows/src/durable/journal/types.js";

/** Each operation's journal read holds the thread this long, as a synchronous SQLite statement does. */
const OPERATION_COST_MS = 2;
const OPERATIONS = 128;
/** The journal's turn budget (JOURNAL_TURN_BUDGET_MS in journal-backend.ts). */
const TURN_BUDGET_MS = 8;
/** Scheduling noise of a loaded test host; far below the 124 operations a missed check runs together. */
const HOST_SLACK_MS = 30;

function hold(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until) {}
}

class SynchronousCostJournal extends MemoryRunJournal {
	reads = 0;
	override async *read(runId: string, fromSeq?: number): AsyncIterable<JournalEntry> {
		this.reads++;
		hold(OPERATION_COST_MS);
		yield* super.read(runId, fromSeq);
	}
}

test("a fan-out's journal work spreads over event-loop turns, checking the budget before every operation", async () => {
	const journal = new SynchronousCostJournal();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: true });
	try {
		journal.reads = 0;
		// An immediate that re-arms itself runs once per event-loop turn; the gap between two runs
		// is how long that turn kept the thread.
		const turns: number[] = [];
		let ticking = true;
		const tick = () => {
			turns.push(performance.now());
			if (ticking) setImmediate(tick);
		};
		setImmediate(tick);
		const completed: number[] = [];
		await Promise.all(
			Array.from({ length: OPERATIONS }, (_, index) =>
				backend.catchUpWorkflow(`fan-out-${index}`).then(() => {
					completed.push(index);
				}),
			),
		);
		ticking = false;
		turns.push(performance.now());

		assert.equal(journal.reads, OPERATIONS, "every operation reads its run once");
		assert.deepEqual(
			completed,
			Array.from({ length: OPERATIONS }, (_, index) => index),
			"operations complete in the order they were queued",
		);
		const longestTurnMs = Math.max(...turns.slice(1).map((at, index) => at - turns[index]!));
		assert.ok(
			longestTurnMs < TURN_BUDGET_MS + OPERATION_COST_MS + HOST_SLACK_MS,
			`one event-loop turn ran ${Math.round(longestTurnMs)} ms of ${OPERATIONS} operations of ${OPERATION_COST_MS} ms; the budget is ${TURN_BUDGET_MS} ms plus one operation`,
		);
		assert.ok(
			turns.length >= (OPERATIONS * OPERATION_COST_MS) / (TURN_BUDGET_MS + OPERATION_COST_MS),
			`the fan-out progressed over only ${turns.length} event-loop turns`,
		);
	} finally {
		await backend.close();
	}
});

const CHILDREN_PER_ROOT = 64;

function registration(workflowId: string) {
	return { workflowId, name: "child", inputs: {}, createdAt: 1, status: "running" as const };
}

test("a fan-out's queued journal work keeps its own root's execution when another root retires mid-queue", async () => {
	const journal = new SynchronousCostJournal();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: true });
	try {
		const queuedB = Promise.withResolvers<readonly Promise<void>[]>();
		let lateWriteOfRetiredRoot: Promise<void> | undefined;
		const rootA = backend.withWorkflowLease("root-a", async () => {
			const retire = backend.captureWorkflowRetirement("root-a");
			// Root A starts the fan-out, so the queue drains from root A's async context.
			const writes = Array.from({ length: CHILDREN_PER_ROOT }, (_, index) =>
				backend.commitWorkflowRegistration(registration(`a-${index}`)),
			);
			// Root B queues its children behind root A's while they are still waiting.
			await queuedB.promise;
			await retire();
			lateWriteOfRetiredRoot = backend.commitWorkflowRegistration(registration("a-late"));
			await Promise.allSettled(writes);
		});
		const rootB = backend.withWorkflowLease("root-b", async () => {
			const writes = Array.from({ length: CHILDREN_PER_ROOT }, (_, index) =>
				backend.commitWorkflowRegistration(registration(`b-${index}`)),
			);
			queuedB.resolve(writes);
			return await Promise.allSettled(writes);
		});
		const [, outcomes] = await Promise.all([rootA, rootB]);

		const refused = outcomes.filter((outcome) => outcome.status === "rejected");
		assert.deepEqual(
			refused.map((outcome) => String(outcome.reason)),
			[],
			"root B's child registrations are refused for root A's retirement",
		);
		for (let index = 0; index < CHILDREN_PER_ROOT; index++)
			assert.ok((await journal.getRun(`b-${index}`)) !== undefined, `root B's child b-${index} is not journaled`);
		assert.ok(lateWriteOfRetiredRoot !== undefined);
		await assert.rejects(lateWriteOfRetiredRoot, JournalExecutionRetiredError);
		assert.equal(await journal.getRun("a-late"), undefined);
	} finally {
		await backend.close();
	}
});
