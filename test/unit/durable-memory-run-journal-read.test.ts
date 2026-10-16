import assert from "node:assert/strict";
import { test } from "vitest";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { JournalEntry } from "../../packages/workflows/src/durable/journal/types.js";

test("memory journal full reads visit only a linear number of stored entries", async () => {
	for (const count of [4_096, 16_384]) {
		const journal = new MemoryRunJournal();
		try {
			await journal.createRun({ runId: "run", name: "test", cwd: "", createdAt: 0, status: "running" });
			const outcome = await journal.acquire("run", "holder");
			assert.equal(outcome.status, "acquired");
			if (outcome.status !== "acquired") assert.fail("lease not acquired");
			for (let index = 0; index < count; index++)
				await journal.append(outcome.lease, { type: "RunFinished", payload: index });

			const runs = Reflect.get(journal, "runs") as Map<string, { entries: JournalEntry[] }>;
			const run = runs.get("run");
			assert.ok(run);
			let visits = 0;
			run.entries = new Proxy(run.entries, {
				get(target, property, receiver) {
					if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) visits++;
					return Reflect.get(target, property, receiver);
				},
			});

			let received = 0;
			for await (const entry of journal.read("run")) {
				assert.equal(entry.seq, ++received);
				assert.equal(entry.event.payload, received - 1);
			}
			assert.equal(received, count);
			assert.ok(visits <= 2 * count, `${count} entries required ${visits} stored-entry visits`);
		} finally {
			await journal.close();
		}
	}
});

test("memory journal reads preserve inclusive numeric thresholds across page boundaries", async () => {
	const journal = new MemoryRunJournal();
	try {
		await journal.createRun({ runId: "run", name: "test", cwd: "", createdAt: 0, status: "running" });
		const outcome = await journal.acquire("run", "holder");
		assert.equal(outcome.status, "acquired");
		if (outcome.status !== "acquired") assert.fail("lease not acquired");
		const sequences = Array.from({ length: 513 }, (_, index) => index + 1);
		for (const seq of sequences) await journal.append(outcome.lease, { type: "RunFinished", payload: seq });
		for (const fromSeq of [
			undefined,
			Number.NEGATIVE_INFINITY,
			-Number.MAX_VALUE,
			-1,
			-0.5,
			-0,
			0,
			Number.MIN_VALUE,
			0.5,
			1,
			1.1,
			255.5,
			256,
			256.5,
			257,
			512.5,
			513,
			513.5,
			514,
			Number.MAX_SAFE_INTEGER,
			Number.MAX_VALUE,
			Number.POSITIVE_INFINITY,
			Number.NaN,
		]) {
			const actual: number[] = [];
			for await (const entry of journal.read("run", fromSeq)) actual.push(entry.seq);
			const threshold = fromSeq === undefined ? 1 : fromSeq;
			assert.deepEqual(
				actual,
				sequences.filter((seq) => seq >= threshold),
				`fromSeq=${String(fromSeq)}`,
			);
		}
	} finally {
		await journal.close();
	}
});
