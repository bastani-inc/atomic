import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, vi } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { type RunJournal, StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { assertLeaseStateUnchanged } from "../helpers/journal-lease-state.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

// Expose only the required asynchronous contract, never the built-in fast path.
function asyncJournal(journal: RunJournal): RunJournal {
	return {
		async createRun(header) {
			return await journal.createRun(header);
		},
		async getRun(runId) {
			return await journal.getRun(runId);
		},
		async listRuns(filter) {
			return await journal.listRuns(filter);
		},
		async acquire(runId, holderId) {
			return await journal.acquire(runId, holderId);
		},
		async takeover(runId, holderId, expectedHolder) {
			return await journal.takeover(runId, holderId, expectedHolder);
		},
		async takeoverExpired(runId, holderId, staleAfterMs) {
			return await journal.takeoverExpired(runId, holderId, staleAfterMs);
		},
		async leaseState(runId) {
			return await journal.leaseState(runId);
		},
		async renew(lease) {
			await journal.renew(lease);
		},
		async release(lease) {
			await journal.release(lease);
		},
		async append(lease, event, options) {
			return await journal.append(lease, event, options);
		},
		read: (runId, fromSeq) => journal.read(runId, fromSeq),
		async readKey(runId, key) {
			return await journal.readKey(runId, key);
		},
		async deleteOwnedRun(lease) {
			await journal.deleteOwnedRun(lease);
		},
		async deleteRun(runId) {
			await journal.deleteRun(runId);
		},
		async close() {
			await journal.close();
		},
	};
}

for (const operation of ["inspection", "recovery"] as const) {
	test(`async-only SQLite ${operation} handles a crashed owner (#3674)`, async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1_000);
		const directory = makeTempDirectory("async-sqlite-recovery-");
		const connection = new DatabaseSync(join(directory, "journal.sqlite"));
		connection.function("unixepoch", { varargs: true }, () => Date.now() / 1000);
		const sqlite = await openSqlRunJournal(connection);
		const journal = asyncJournal(sqlite);
		const writer = await JournalDurableBackend.open(journal, { ownsJournal: false });
		let reader: Awaited<ReturnType<typeof JournalDurableBackend.open>> | undefined;
		try {
			await writer.registerWorkflow({
				workflowId: "run",
				name: "recovery",
				inputs: {},
				createdAt: 1_000,
				status: "running",
			});
			await writer.close();
			const crashed = await sqlite.acquire("run", "crashed-owner");
			assert.equal(crashed.status, "acquired");
			if (crashed.status !== "acquired") return assert.fail("crashed owner did not acquire its lease");
			const initial = await sqlite.leaseState("run");
			assert.ok(initial);
			reader = await JournalDurableBackend.open(journal, { ownsJournal: false });
			assert.equal(await reader.workflowOwnership("run"), "foreign");
			assertLeaseStateUnchanged(await sqlite.leaseState("run"), initial);
			vi.setSystemTime(1_000 + FOREIGN_LIVE_WORKFLOW_WINDOW_MS + 1);
			if (operation === "inspection") {
				assert.equal(await reader.workflowOwnership("run"), "available");
				const expired = await sqlite.leaseState("run");
				assertLeaseStateUnchanged(expired, initial, "inspection must not renew, acquire, or release");
				assert.ok(expired && expired.ageMs > initial.ageMs);
				assert.equal(reader.getWorkflow("run")?.status, "running");
			} else {
				await reader.setWorkflowStatus("run", "paused");
				const recovered = await sqlite.leaseState("run");
				assert.equal(recovered?.epoch, crashed.lease.epoch + 1);
				assert.equal(recovered?.holderId, reader.holderId);
				assert.equal(await reader.workflowOwnership("run"), "local");
				await assert.rejects(sqlite.renew(crashed.lease), StaleLeaseError);
				await assert.rejects(
					sqlite.append(crashed.lease, { type: "StatusChanged", payload: { status: "failed" } }),
					StaleLeaseError,
				);
				assert.equal((await sqlite.listRuns()).find((run) => run.runId === "run")?.status, "paused");
				assert.equal(reader.getWorkflow("run")?.status, "paused");
			}
		} finally {
			await reader?.close();
			await writer.close();
			await sqlite.close();
			connection.close();
			removeTempDirectory(directory);
			vi.useRealTimers();
		}
	});
}
