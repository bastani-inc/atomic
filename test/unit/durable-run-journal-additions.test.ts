import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, vi } from "vitest";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

for (const storage of ["memory", "sqlite"] as const) {
	test(`${storage} takeover measures strict renewal age on the journal clock and fences the old holder`, async () => {
		const directory = makeTempDirectory("journal-expiry-");
		let now = 1_000;
		const connection = storage === "sqlite" ? new DatabaseSync(join(directory, "runs.sqlite")) : undefined;
		connection?.function("unixepoch", { varargs: true }, () => now / 1000);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1_000);
		const journal = storage === "memory" ? new MemoryRunJournal() : await openSqlRunJournal(connection!);
		try {
			await journal.createRun({ runId: "run", name: "test", cwd: "", createdAt: 0, status: "running" });
			const first = await journal.acquire("run", "first");
			assert.equal(first.status, "acquired");
			if (first.status !== "acquired") assert.fail("lease not acquired");
			const held = { status: "held", holderId: "first", epoch: first.lease.epoch };
			assert.deepEqual(await journal.takeoverExpired("run", "next", 0), held);
			now = 1_100;
			vi.setSystemTime(now);
			assert.deepEqual(await journal.takeoverExpired("run", "next", 100), held);
			await journal.renew(first.lease);
			now = 1_200;
			vi.setSystemTime(now);
			assert.deepEqual(await journal.takeoverExpired("run", "next", 100), held);
			now = 1_201;
			vi.setSystemTime(now);
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
			connection?.close();
			vi.useRealTimers();
			removeTempDirectory(directory);
		}
	});
}
