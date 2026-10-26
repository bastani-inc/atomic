import assert from "node:assert/strict";
import { test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { JournalEntry, RunSummary } from "../../packages/workflows/src/durable/journal/types.js";

/** Each read holds the thread for READ_COST_MS, as a synchronous SQLite statement does. */
const READ_COST_MS = 1;
const RUNS = 60;

function hold(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until) {}
}

class SynchronousCostJournal extends MemoryRunJournal {
	override async getRun(runId: string): Promise<RunSummary | undefined> {
		hold(READ_COST_MS);
		return super.getRun(runId);
	}
	override async *read(runId: string, fromSeq?: number): AsyncIterable<JournalEntry> {
		hold(READ_COST_MS);
		yield* super.read(runId, fromSeq);
	}
}

test("a fan-out's journal work lets the event loop turn instead of running in one long task", async () => {
	const backend = await JournalDurableBackend.open(new SynchronousCostJournal(), { ownsJournal: true });
	try {
		let settled = 0;
		let settledWhenLoopTurned: number | undefined;
		setImmediate(() => {
			settledWhenLoopTurned = settled;
		});
		await Promise.all(
			Array.from({ length: RUNS }, (_, index) =>
				backend.catchUpWorkflow(`fan-out-${index}`).then(() => {
					settled++;
				}),
			),
		);
		assert.equal(settled, RUNS);
		assert.ok(
			settledWhenLoopTurned !== undefined && settledWhenLoopTurned < RUNS,
			`all ${RUNS} journal operations (at least ${RUNS * READ_COST_MS} ms) ran before the event loop could turn`,
		);
	} finally {
		await backend.close();
	}
});
