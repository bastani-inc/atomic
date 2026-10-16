import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

for (const storage of ["memory", "sqlite"] as const) {
	test(`${storage} takeover measures strict renewal age on the journal clock and fences the old holder`, async () => {
		const directory = makeTempDirectory("journal-expiry-");
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1_000);
		const journal =
			storage === "memory" ? new MemoryRunJournal() : new SqliteRunJournal(join(directory, "runs.sqlite"));
		try {
			await journal.createRun({ runId: "run", name: "test", cwd: "", createdAt: 0, status: "running" });
			const first = await journal.acquire("run", "first");
			assert.equal(first.status, "acquired");
			if (first.status !== "acquired") assert.fail("lease not acquired");
			const held = { status: "held", holderId: "first", epoch: first.lease.epoch };
			assert.deepEqual(await journal.takeoverExpired("run", "next", 0), held);
			vi.setSystemTime(1_100);
			assert.deepEqual(await journal.takeoverExpired("run", "next", 100), held);
			await journal.renew(first.lease);
			vi.setSystemTime(1_200);
			assert.deepEqual(await journal.takeoverExpired("run", "next", 100), held);
			vi.setSystemTime(1_201);
			const taken = await journal.takeoverExpired("run", "next", 100);
			assert.equal(taken.status, "acquired");
			if (taken.status !== "acquired") assert.fail("expired lease not acquired");
			assert.equal(taken.lease.epoch, first.lease.epoch + 1);
			assert.deepEqual(await journal.leaseState("run"), { ...taken.lease, renewedAt: 1_201 });
			await assert.rejects(journal.renew(first.lease), (error: Error) => {
				assert.ok(error instanceof StaleLeaseError);
				assert.equal(error.runId, "run");
				assert.equal(error.heldEpoch, first.lease.epoch);
				assert.equal(error.currentEpoch, taken.lease.epoch);
				return true;
			});
		} finally {
			await journal.close();
			vi.useRealTimers();
			removeTempDirectory(directory);
		}
	});
}
