import assert from "node:assert/strict";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { readFleetRateUsage, SqlRateBuckets } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";

const clock = vi.hoisted(() => ({ now: 1_800_000_000_000 }));
vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class WaitingClockDatabase extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			super(...args);
			this.function("unixepoch", { varargs: true }, () => clock.now / 1_000);
			this.function("julianday", { varargs: true }, () => clock.now / 86_400_000 + 2_440_587.5);
		}
	}
	return { ...actual, DatabaseSync: WaitingClockDatabase };
});

test("inactive waiting reporters are compacted without losing totals or accepting their late duplicate reports (#4768)", async () => {
	clock.now = 1_800_000_000_000;
	const database = await openNodeSqliteDatabase(":memory:");
	const journal = await SqlRunJournal.open(database);
	try {
		const store = await SqlRateBuckets.open(journal);
		await store.acquire("p", 0, { intervalMs: 1_000, burst: 1 });
		const retiredReporters = 300;
		const epochs = new Map<string, number>();
		for (let index = 0; index < retiredReporters; index++) {
			const epoch = await store.registerWaiting("p", `retired-${index}`);
			epochs.set(`retired-${index}`, epoch);
			await store.reportWaiting([{ reporter: `retired-${index}`, scope: "p", waitingMs: 100, epoch }]);
		}
		assert.equal((await readFleetRateUsage(journal))[0]?.waitingMs, retiredReporters * 100);
		clock.now += 2 * 60 * 60_000;
		const liveEpoch = await store.registerWaiting("p", "live");
		await store.reportWaiting([{ reporter: "live", scope: "p", waitingMs: 50, epoch: liveEpoch }]);
		await store.reportWaiting([{ reporter: "live", scope: "p", waitingMs: 50, epoch: liveEpoch }]);
		const retained = await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM wf_runs_rate_waiting");
		assert.equal(Number(retained?.count), 1, "old reporter lifetimes do not accumulate behind the aggregate read");
		assert.equal((await readFleetRateUsage(journal))[0]?.waitingMs, retiredReporters * 100 + 50);
		await store.reportWaiting([
			{ reporter: "retired-0", scope: "p", waitingMs: 100, epoch: epochs.get("retired-0")! },
		]);
		assert.equal(
			(await readFleetRateUsage(journal))[0]?.waitingMs,
			retiredReporters * 100 + 50,
			"a delayed duplicate cannot recreate a compacted reporter",
		);
		const lateEpoch = await store.registerWaiting("p", "retired-0");
		assert.notEqual(lateEpoch, epochs.get("retired-0"));
		await store.reportWaiting([
			{ reporter: "retired-0", scope: "p", waitingMs: 100, epoch: epochs.get("retired-0")! },
		]);
		assert.equal(
			(await readFleetRateUsage(journal))[0]?.waitingMs,
			retiredReporters * 100 + 50,
			"a late registration cannot make an earlier update valid again",
		);
		clock.now += 2 * 60 * 60_000;
		const nextEpoch = await store.registerWaiting("p", "next");
		await store.reportWaiting([{ reporter: "next", scope: "p", waitingMs: 10, epoch: nextEpoch }]);
		assert.equal(
			Number((await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM wf_runs_rate_waiting"))?.count),
			1,
		);
		assert.equal((await readFleetRateUsage(journal))[0]?.waitingMs, retiredReporters * 100 + 60);
	} finally {
		await journal.close();
		await database.close();
	}
});
