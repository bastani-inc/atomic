import assert from "node:assert/strict";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { registerRunJournalConformance } from "../../packages/workflows/src/durable/journal/conformance.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES, type RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { observeJournalRead } from "../helpers/journal-read-observation.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

interface CallCounts {
	append: number;
	appendMany: number;
	changeToken: number;
	runVersions: number;
	snapshotTail: number;
	listRuns: number;
	read: number;
}

interface AdapterJournal {
	readonly journal: RunJournal;
	readonly backing: SqlRunJournal;
	readonly calls: CallCounts;
}

const cleanups: (() => Promise<void> | void)[] = [];
const backings = new WeakMap<RunJournal, SqlRunJournal>();

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openBacking(): Promise<SqlRunJournal> {
	const directory = makeTempDirectory("adapter-journal-");
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const backing = await SqlRunJournal.open(database);
	const close = backing.close.bind(backing);
	backing.close = async () => {
		await close();
		await database.close();
		removeTempDirectory(directory);
	};
	return backing;
}

function adapterJournal(backing: SqlRunJournal): AdapterJournal {
	const calls: CallCounts = {
		append: 0,
		appendMany: 0,
		changeToken: 0,
		runVersions: 0,
		snapshotTail: 0,
		listRuns: 0,
		read: 0,
	};
	const journal: RunJournal = {
		createRun: (header) => backing.createRun(header),
		getRun: (runId) => backing.getRun(runId),
		listRuns: (filter) => {
			calls.listRuns++;
			return backing.listRuns(filter);
		},
		acquire: (runId, holderId) => backing.acquire(runId, holderId),
		takeover: (runId, holderId, expectedHolder) => backing.takeover(runId, holderId, expectedHolder),
		takeoverExpired: (runId, holderId, staleAfterMs) => backing.takeoverExpired(runId, holderId, staleAfterMs),
		leaseState: (runId) => backing.leaseState(runId),
		renew: (lease) => backing.renew(lease),
		release: (lease) => backing.release(lease),
		append: (lease, event, options) => {
			calls.append++;
			return backing.append(lease, event, options);
		},
		read: (runId, fromSeq) => {
			calls.read++;
			return backing.read(runId, fromSeq);
		},
		readKey: (runId, key) => backing.readKey(runId, key),
		deleteOwnedRun: (lease, expectSeq) => backing.deleteOwnedRun(lease, expectSeq),
		deleteRun: (runId) => backing.deleteRun(runId),
		close: () => backing.close(),
		changeToken: () => {
			calls.changeToken++;
			return backing.changeToken();
		},
		runVersions: () => {
			calls.runVersions++;
			return backing.runVersions();
		},
		snapshotTail: (runId) => {
			calls.snapshotTail++;
			return backing.snapshotTail(runId);
		},
		appendMany: (lease, appends) => {
			calls.appendMany++;
			return backing.appendMany(lease, appends);
		},
	};
	backings.set(journal, backing);
	return { journal, backing, calls };
}

async function openBackend(journal: RunJournal): Promise<JournalDurableBackend> {
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	cleanups.push(() => backend.close());
	return backend;
}

function sticky(): PendingStageMessage {
	return {
		id: "sticky",
		runId: "run",
		stageKey: "workflow:run/child-*/**",
		targetPath: "workflow:run/child-*/**",
		sticky: true,
		from: { id: "sender" },
		message: { id: "sticky", timestamp: 1, content: { text: "hello" } },
		queuedAt: "2026-10-24T20:59:42.835Z",
		admissionOrder: 1,
		status: "queued",
	};
}

registerRunJournalConformance(
	test,
	"storage-adapter journal with optional members",
	async () => adapterJournal(await openBacking()).journal,
	(journal) => {
		const backing = backings.get(journal);
		assert.ok(backing);
		return observeJournalRead(backing);
	},
);

test("an adapter journal's appendMany batches delivery receipts (#3964)", async () => {
	const { journal, calls } = adapterJournal(await openBacking());
	cleanups.push(() => journal.close());
	const backend = await openBackend(journal);
	await backend.commitWorkflowRegistration({
		workflowId: "run",
		name: "test",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	assert.equal(await backend.persistPendingStageMessages("run", [sticky()]), true);
	const appendsBefore = calls.append;
	await Promise.all(
		Array.from({ length: 50 }, (_, index) =>
			backend.archivePendingStageDeliveryReceipt(
				"run",
				"sticky",
				{
					runId: `child-${index}`,
					stageId: "stage",
					sessionId: `session-${index}`,
					admission: "context",
					deliveredAt: "2026-10-24T21:00:00.000Z",
				},
				{ messageRunId: "run", deliveryCount: index + 1 },
			),
		),
	);
	assert.ok(calls.appendMany > 0, "appendMany was never called");
	assert.ok(calls.append - appendsBefore < 50, `${calls.append - appendsBefore} single appends for 50 receipts`);
	const delivered = [];
	for await (const entry of journal.read("run"))
		if (entry.event.type === RUN_EVENT_TYPES.messageDelivered) delivered.push(entry);
	assert.equal(delivered.length, 50);
	assert.equal(backend.getPendingStageMessageDeliveryCount("run", "sticky", "run"), 50);
});

test("an adapter journal's change tracking skips re-reading unchanged runs on resume (#3964)", async () => {
	const backing = await openBacking();
	const writer = adapterJournal(backing);
	cleanups.push(() => backing.close());
	const writerBackend = await openBackend(writer.journal);
	await writerBackend.commitWorkflowRegistration({
		workflowId: "run",
		name: "test",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	const reader = adapterJournal(backing);
	const backend = await openBackend(reader.journal);
	await backend.hydrateResumableWorkflows();
	assert.ok(reader.calls.changeToken > 0, "changeToken was never called");
	const reads = reader.calls.read;
	const listed = reader.calls.listRuns;
	await backend.hydrateResumableWorkflows();
	assert.equal(reader.calls.read, reads);
	assert.equal(reader.calls.listRuns, listed);
});
