import assert from "node:assert/strict";
import {
	JournalDurableBackend,
	JournalOwnershipError,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import {
	type JournalEntry,
	type RunJournal,
	StaleLeaseError,
} from "../../packages/workflows/src/durable/journal/types.js";

const memory = new MemoryRunJournal();
let injectTakeover = false;
const expectedEntries: JournalEntry[] = [];
const journal: RunJournal = {
	createRun: (header) => memory.createRun(header),
	getRun: (runId) => memory.getRun(runId),
	leaseState: (runId) => memory.leaseState(runId),
	takeoverExpired: (runId, holderId, staleAfterMs) => memory.takeoverExpired(runId, holderId, staleAfterMs),
	listRuns: (filter) => memory.listRuns(filter),
	acquire: (runId, holderId) => memory.acquire(runId, holderId),
	takeover: (runId, holderId, expectedHolder) => memory.takeover(runId, holderId, expectedHolder),
	renew: (lease) => memory.renew(lease),
	async deleteOwnedRun(lease) {
		await memory.renew(lease);
		if (injectTakeover) {
			injectTakeover = false;
			const successor = await memory.takeover(lease.runId, "successor", lease.holderId);
			assert.equal(successor.status, "acquired");
			if (successor.status !== "acquired") return assert.fail("successor takeover failed");
			await memory.append(successor.lease, {
				type: "StatusChanged",
				payload: {
					workflowId: lease.runId,
					name: "delete-race",
					inputs: {},
					createdAt: 1,
					updatedAt: 2,
					status: "running",
					resumable: true,
					completedCheckpoints: 0,
					pendingPrompts: 0,
				},
			});
			for await (const entry of memory.read(lease.runId)) expectedEntries.push(entry);
		}
		await memory.deleteOwnedRun(lease);
	},
	release: (lease) => memory.release(lease),
	append: (lease, event, options) => memory.append(lease, event, options),
	read: (runId, fromSeq) => memory.read(runId, fromSeq),
	readKey: (runId, key) => memory.readKey(runId, key),
	deleteRun: (runId) => memory.deleteRun(runId),
	close: () => memory.close(),
};
const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
try {
	await backend.commitWorkflowRegistration({
		workflowId: "run",
		name: "delete-race",
		inputs: {},
		createdAt: 1,
		status: "paused",
	});
	injectTakeover = true;
	await assert.rejects(backend.deleteWorkflowIfInactive("run"), (error: Error) => {
		assert.ok(error instanceof JournalOwnershipError);
		assert.ok(error.cause instanceof StaleLeaseError);
		assert.equal(error.cause.runId, "run");
		assert.equal(error.cause.heldEpoch, 1);
		assert.equal(error.cause.currentEpoch, 2);
		return true;
	});
	const runs = await memory.listRuns();
	console.log(
		JSON.stringify({
			staleDeletionRejected: true,
			survivingRuns: runs.map((run) => ({ runId: run.runId, status: run.status })),
		}),
	);
	assert.equal(runs.length, 1, "a stale owner must not delete the successor's running workflow");
	assert.equal(runs[0]?.status, "running");
	const retainedEntries: JournalEntry[] = [];
	for await (const entry of memory.read("run")) retainedEntries.push(entry);
	assert.deepEqual(retainedEntries, expectedEntries);
} finally {
	await backend.close();
	await memory.close();
}
