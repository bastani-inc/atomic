import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, vi } from "vitest";
import {
	JournalDurableBackend,
	JournalOwnershipError,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { type RunJournal, StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import {
	FOREIGN_LIVE_WORKFLOW_WINDOW_MS,
	isForeignLiveWorkflow,
	isLiveRunningWorkflow,
} from "../../packages/workflows/src/durable/resume-eligibility.js";
import { assertLeaseStateUnchanged } from "../helpers/journal-lease-state.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

function asyncJournal(journal: RunJournal): RunJournal {
	return {
		createRun: (header) => journal.createRun(header),
		getRun: (runId) => journal.getRun(runId),
		leaseState: (runId) => journal.leaseState(runId),
		takeoverExpired: (runId, holderId, staleAfterMs) => journal.takeoverExpired(runId, holderId, staleAfterMs),
		listRuns: (filter) => journal.listRuns(filter),
		acquire: (runId, holderId) => journal.acquire(runId, holderId),
		takeover: (runId, holderId, expectedHolder) => journal.takeover(runId, holderId, expectedHolder),
		renew: (lease) => journal.renew(lease),
		release: (lease) => journal.release(lease),
		append: (lease, event, options) => journal.append(lease, event, options),
		read: (runId, fromSeq) => journal.read(runId, fromSeq),
		readKey: (runId, key) => journal.readKey(runId, key),
		deleteOwnedRun: (lease) => journal.deleteOwnedRun(lease),
		deleteRun: (runId) => journal.deleteRun(runId),
		close: () => journal.close(),
	};
}

for (const storage of ["memory", "sqlite"] as const) {
	for (const access of ["sync", "async"] as const) {
		test(`${storage} ${access} ownership inspection and takeover agree at expiry equality (#3681)`, async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(1_000);
			const directory = makeTempDirectory("journal-expiry-boundary-");
			const connection = storage === "sqlite" ? new DatabaseSync(join(directory, "runs.sqlite")) : undefined;
			connection?.function("unixepoch", { varargs: true }, () => Date.now() / 1000);
			const journal = storage === "memory" ? new MemoryRunJournal() : await openSqlRunJournal(connection!);
			const contract = access === "sync" ? journal : asyncJournal(journal);
			const backends: JournalDurableBackend[] = [];
			try {
				const writer = await JournalDurableBackend.open(contract, { ownsJournal: false });
				backends.push(writer);
				await writer.registerWorkflow({
					workflowId: "run",
					name: "expiry",
					inputs: {},
					createdAt: 1_000,
					status: "running",
				});
				await writer.close();
				const crashed = await journal.acquire("run", "crashed-owner");
				assert.equal(crashed.status, "acquired");
				if (crashed.status !== "acquired") assert.fail("crashed owner did not acquire its lease");
				const initial = await journal.leaseState("run");
				assert.ok(initial);
				const reader = await JournalDurableBackend.open(contract, { ownsJournal: false });
				backends.push(reader);

				vi.setSystemTime(initial.renewedAt + FOREIGN_LIVE_WORKFLOW_WINDOW_MS);
				await assert.rejects(async () => {
					await reader.setWorkflowStatus("run", "paused");
				}, JournalOwnershipError);
				assertLeaseStateUnchanged(await journal.leaseState("run"), initial);
				assert.equal(await reader.workflowOwnership("run"), "foreign");

				vi.setSystemTime(initial.renewedAt + FOREIGN_LIVE_WORKFLOW_WINDOW_MS + 1);
				assert.equal(await reader.workflowOwnership("run"), "available");
				assertLeaseStateUnchanged(await journal.leaseState("run"), initial, "inspection must not change the lease");
				await reader.setWorkflowStatus("run", "paused");
				assert.equal(await reader.workflowOwnership("run"), "local");
				assert.deepEqual(await journal.leaseState("run"), {
					runId: "run",
					holderId: reader.holderId,
					epoch: initial.epoch + 1,
					renewedAt: initial.renewedAt + FOREIGN_LIVE_WORKFLOW_WINDOW_MS + 1,
					ageMs: 0,
				});
				assert.equal(reader.getWorkflow("run")?.status, "paused");
				await assert.rejects(journal.renew(crashed.lease), StaleLeaseError);
			} finally {
				for (const backend of backends) await backend.close();
				await journal.close();
				connection?.close();
				removeTempDirectory(directory);
				vi.useRealTimers();
			}
		});
	}
}

test("running workflow liveness uses strict expiry at equality (#3681)", () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const candidate = { status: "running", updatedAt: 1_000, ownerExecutorId: "foreign" } as const;
	try {
		vi.setSystemTime(candidate.updatedAt + FOREIGN_LIVE_WORKFLOW_WINDOW_MS);
		assert.equal(isLiveRunningWorkflow(candidate), true);
		assert.equal(isForeignLiveWorkflow(candidate, "local"), true);
		vi.setSystemTime(candidate.updatedAt + FOREIGN_LIVE_WORKFLOW_WINDOW_MS + 1);
		assert.equal(isLiveRunningWorkflow(candidate), false);
		assert.equal(isForeignLiveWorkflow(candidate, "local"), false);
	} finally {
		vi.useRealTimers();
	}
});
