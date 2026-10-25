import assert from "node:assert/strict";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import {
	JournalDurableBackend,
	JournalOwnershipError,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	type JournalEntry,
	RUN_EVENT_TYPES,
	type RunJournal,
} from "../../packages/workflows/src/durable/journal/types.js";
import type {
	PendingStageMessage,
	PendingStageMessageDelivery,
} from "../../packages/workflows/src/shared/store-types.js";
import { JournalTestDatabase } from "../helpers/journal-database.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

interface CountingJournal {
	readonly path: string;
	readonly journal: SqlRunJournal;
	/** Journal transactions begun so far. */
	transactions(): number;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function databasePath(): string {
	const dir = makeTempDirectory("journal-batching-");
	cleanups.push(() => removeTempDirectory(dir));
	return join(dir, "journal.sqlite");
}

async function countingJournal(path = databasePath()): Promise<CountingJournal> {
	const database = await openNodeSqliteDatabase(path);
	let transactions = 0;
	const counted: SqliteDatabase = {
		get descriptor() {
			return database.descriptor;
		},
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: (sql, ...params) => database.get(sql, ...params),
		all: (sql, ...params) => database.all(sql, ...params),
		transaction: (body) => {
			transactions++;
			return database.transaction(body);
		},
		close: () => database.close(),
	};
	const journal = await SqlRunJournal.open(counted);
	cleanups.push(() => database.close());
	return { path, journal, transactions: () => transactions };
}

async function openBackend(journal: RunJournal): Promise<JournalDurableBackend> {
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	cleanups.push(async () => {
		await backend.close();
		await journal.close();
	});
	return backend;
}

async function register(backend: JournalDurableBackend): Promise<void> {
	await backend.commitWorkflowRegistration({
		workflowId: "run",
		name: "test",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
}

function message(id: string, admissionOrder = 1): PendingStageMessage {
	return {
		id,
		runId: "run",
		stageKey: "workflow:run/child-*/**",
		targetPath: "workflow:run/child-*/**",
		sticky: true,
		from: { id: "sender" },
		message: { id, timestamp: 1, content: { text: `hello from ${id}` } },
		queuedAt: "2026-10-24T20:59:42.835Z",
		admissionOrder,
		status: "queued",
	};
}

function delivery(index: number): PendingStageMessageDelivery {
	return {
		runId: `child-${index}`,
		stageId: "stage",
		sessionId: `session-${index}`,
		admission: "context",
		deliveredAt: `2026-10-24T21:00:${String(index % 60).padStart(2, "0")}.000Z`,
	};
}

/** Issue `count` receipts for one sticky message without awaiting any, as concurrent stage deliveries do. */
function receiptBurst(backend: JournalDurableBackend, messageId: string, count: number, from = 0): Promise<void>[] {
	return Array.from({ length: count }, (_, offset) =>
		backend.archivePendingStageDeliveryReceipt("run", messageId, delivery(from + offset), {
			messageRunId: "run",
			deliveryCount: from + offset + 1,
		}),
	);
}

async function journalEntries(journal: RunJournal): Promise<JournalEntry[]> {
	const result: JournalEntry[] = [];
	for await (const entry of journal.read("run")) result.push(entry);
	return result;
}

/** Everything the projection exposes about the run's pending-stage messages and receipts. */
function projectionState(backend: JournalDurableBackend, messageIds: readonly string[], receipts: number) {
	const workflow = backend.getWorkflow("run");
	return {
		pendingStageMessages: workflow?.pendingStageMessages,
		status: workflow?.status,
		counts: messageIds.map((id) => backend.getPendingStageMessageDeliveryCount("run", id, "run")),
		receipts: Array.from({ length: receipts }, (_, index) =>
			backend.hasCachedPendingStageDeliveryReceipt("run", messageIds[0]!, delivery(index)),
		),
	};
}

test("a receipt burst commits in a few journal transactions and a pending-stage message queued behind it waits only for them", async () => {
	const { journal, transactions } = await countingJournal();
	const backend = await openBackend(journal);
	await register(backend);
	const sticky = message("sticky");
	assert.equal(await backend.persistPendingStageMessages("run", [sticky]), true);
	const before = transactions();
	const receipts = receiptBurst(backend, sticky.id, 300);
	const queued = backend.persistPendingStageMessages("run", [sticky, message("next", 2)]);
	assert.equal(await queued, true);
	const beforeQueuedCommitted = transactions() - before;
	await Promise.all(receipts);

	// One transaction per receipt put 301 commits ahead of the pending-stage message; a batch is 256 receipts.
	assert.ok(beforeQueuedCommitted <= 4, `${beforeQueuedCommitted} journal transactions before the message committed`);
	const written = (await journalEntries(journal)).slice(-301);
	assert.deepEqual(
		written.map((entry) => entry.event.type),
		[...Array<string>(300).fill(RUN_EVENT_TYPES.messageDelivered), RUN_EVENT_TYPES.messageQueued],
	);
	assert.deepEqual(
		written
			.slice(0, 300)
			.map((entry) => (entry.event.payload as { accounting: { deliveryCount: number } }).accounting),
		Array.from({ length: 300 }, (_, index) => ({ messageRunId: "run", deliveryCount: index + 1 })),
	);
	assert.deepEqual(
		written.map((entry) => entry.seq),
		Array.from({ length: 301 }, (_, index) => written[0]!.seq + index),
	);
});

test("batched receipts and settlements fold to the state a fresh hydrate and a reopen read", async () => {
	const { path, journal } = await countingJournal();
	const backend = await openBackend(journal);
	await register(backend);
	const sticky = message("sticky");
	const settled = message("settled", 2);
	assert.equal(await backend.persistPendingStageMessages("run", [sticky, settled]), true);
	const burst = [
		...receiptBurst(backend, sticky.id, 40),
		backend.archivePendingStageMessage("run", settled),
		backend.archivePendingStageMessage("run", settled),
		...receiptBurst(backend, sticky.id, 40, 40),
		backend.persistPendingStageMessages("run", [sticky]).then(() => {}),
		...receiptBurst(backend, sticky.id, 20, 80),
	];
	await Promise.all(burst);
	const ids = [sticky.id, settled.id];
	const live = projectionState(backend, ids, 100);
	assert.deepEqual(live.counts, [100, 0]);
	assert.ok(live.receipts.every(Boolean));
	assert.deepEqual(await backend.readSettledPendingStageMessage("run", settled.id), settled);
	const settlements = (await journalEntries(journal)).filter((entry) => entry.event.type === "MessageSettled");
	assert.equal(settlements.length, 1);

	const hydrated = await openBackend((await countingJournal(path)).journal);
	assert.deepEqual(projectionState(hydrated, ids, 100), live);

	await backend.close();
	const reopened = await openBackend((await countingJournal(path)).journal);
	assert.deepEqual(projectionState(reopened, ids, 100), live);
	assert.deepEqual(await reopened.readSettledPendingStageMessage("run", settled.id), settled);
});

test("a pool append guard failure rejects only its own receipt in a batch", async () => {
	const { journal, transactions } = await countingJournal();
	const backend = await openBackend(journal);
	await register(backend);
	const sticky = message("sticky");
	assert.equal(await backend.persistPendingStageMessages("run", [sticky]), true);
	const storage = sqlPoolStorage(journal)!;
	const before = (await journalEntries(journal)).length;
	const started = transactions();
	const stale = new Error("Stale work lease");
	const results = await Promise.allSettled([
		...receiptBurst(backend, sticky.id, 2),
		storage.withAppendGuard(
			async () => {
				throw stale;
			},
			() => receiptBurst(backend, sticky.id, 1, 2)[0]!,
		),
		storage.withAppendGuard(
			async () => {},
			() => receiptBurst(backend, sticky.id, 1, 3)[0]!,
		),
	]);
	assert.deepEqual(
		results.map((result) => result.status),
		["fulfilled", "fulfilled", "rejected", "fulfilled"],
	);
	assert.equal((results[2] as PromiseRejectedResult).reason, stale);
	assert.equal(transactions() - started, 1);
	const written = (await journalEntries(journal)).slice(before);
	assert.deepEqual(
		written.map((entry) => [
			entry.seq,
			(entry.event.payload as { delivery: Readonly<Record<string, string>> }).delivery,
		]),
		[
			[before + 1, delivery(0)],
			[before + 2, delivery(1)],
			[before + 3, delivery(3)],
		],
	);
	assert.equal(backend.hasCachedPendingStageDeliveryReceipt("run", sticky.id, delivery(2)), false);
	assert.equal(backend.hasCachedPendingStageDeliveryReceipt("run", sticky.id, delivery(3)), true);
});

test("a batch whose lease was taken over writes nothing and rejects every receipt with the ownership loss", async () => {
	const { path, journal } = await countingJournal();
	const backend = await openBackend(journal);
	await register(backend);
	const sticky = message("sticky");
	assert.equal(await backend.persistPendingStageMessages("run", [sticky]), true);
	const before = (await journalEntries(journal)).length;
	const connection = new JournalTestDatabase(path);
	try {
		connection.run("UPDATE wf_leases SET holder_id = 'other', epoch = epoch + 1");
	} finally {
		connection.close();
	}
	const results = await Promise.allSettled(receiptBurst(backend, sticky.id, 5));
	for (const result of results) {
		assert.equal(result.status, "rejected");
		assert.ok((result as PromiseRejectedResult).reason instanceof JournalOwnershipError);
	}
	assert.equal((await journalEntries(journal)).length, before);
});

test("a memory journal keeps receipts and a pending-stage message queued behind them in issue order", async () => {
	const journal = new MemoryRunJournal();
	const backend = await openBackend(journal);
	await register(backend);
	const sticky = message("sticky");
	assert.equal(await backend.persistPendingStageMessages("run", [sticky]), true);
	const receipts = receiptBurst(backend, sticky.id, 20);
	assert.equal(await backend.persistPendingStageMessages("run", [sticky, message("next", 2)]), true);
	await Promise.all(receipts);
	const written = (await journalEntries(journal)).slice(-21);
	assert.deepEqual(
		written.map((entry) => entry.event.type),
		[...Array<string>(20).fill(RUN_EVENT_TYPES.messageDelivered), RUN_EVENT_TYPES.messageQueued],
	);
	assert.equal(backend.getPendingStageMessageDeliveryCount("run", sticky.id, "run"), 20);
	const hydrated = await JournalDurableBackend.open(journal, { ownsJournal: false });
	cleanups.push(() => hydrated.close());
	assert.deepEqual(projectionState(hydrated, [sticky.id], 20), projectionState(backend, [sticky.id], 20));
});
