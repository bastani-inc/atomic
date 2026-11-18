/**
 * A pending-stage transition archives the delivery receipts of a sticky broadcast whose stages ended (#3931).
 *
 * A `/**` send in a 150-stage fan-out is delivered to every live stage, so its entry keeps 150 receipts. When those
 * stages end, the next transition of the root run archives them, and every send queued behind that transition (the
 * run's pending-stage transitions are one FIFO) waits for it. One journal commit per receipt held sends for seconds
 * under load, past the sender's wait; the receipts are queued together and commit as one batch.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import { PendingStageTransitionLedger } from "../../packages/workflows/src/shared/pending-stage-transition-ledger.js";
import type {
	PendingStageMessage,
	PendingStageMessageDelivery,
	RunSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Stages a broadcast reached, as in the 150-child pattern fan-out. */
const DELIVERED_STAGES = 150;
/** Receipts on one chain that need two journal transactions: more than one batch holds. */
const RECEIPTS_ACROSS_BATCHES = 300;
/** One batch of queued appends, the one it may queue behind, and slack: never one transaction per receipt. */
const ARCHIVE_TRANSACTION_BOUND = 4;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function countingBackend(options: { failTransaction?: () => boolean } = {}) {
	const directory = makeTempDirectory("receipt-archive-batching-");
	cleanups.push(() => removeTempDirectory(directory));
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
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
			if (options.failTransaction?.() === true) throw new Error("injected storage failure");
			return database.transaction(body);
		},
		close: () => database.close(),
	};
	const journal = await SqlRunJournal.open(counted);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	cleanups.push(async () => {
		await backend.close();
		await journal.close();
		database.close();
	});
	await backend.commitWorkflowRegistration({
		workflowId: "run",
		name: "test",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	return { backend, journal, transactions: () => transactions };
}

function delivery(index: number): PendingStageMessageDelivery {
	return {
		runId: `child-${index}`,
		stageId: "stage",
		sessionId: `session-${index}`,
		admission: "transport",
		deliveredAt: "2026-10-24T21:00:00.000Z",
	};
}

function broadcast(): PendingStageMessage {
	return {
		id: "broadcast",
		runId: "run",
		stageKey: "workflow:run/**",
		targetPath: "workflow:run/**",
		sticky: true,
		from: { id: "sender" },
		message: { id: "broadcast", timestamp: 1, content: { text: "hello" } },
		queuedAt: "2026-10-24T20:59:42.835Z",
		admissionOrder: 1,
		status: "queued",
		deliveries: Array.from({ length: DELIVERED_STAGES }, (_, index) => delivery(index)),
	};
}

/** Every delivered stage has ended. */
function endedStage(runId: string): RunSnapshot {
	return { id: runId, stages: [{ id: "stage", name: "stage", status: "completed" }] } as unknown as RunSnapshot;
}

test("a transition archives a broadcast's receipts for 150 ended stages in a few journal transactions, not one per receipt (#3931)", async () => {
	const { backend, journal, transactions } = await countingBackend();
	const entry = broadcast();
	assert.equal(await backend.persistPendingStageMessages("run", [entry]), true);
	const before = transactions();

	const compacted = await new PendingStageTransitionLedger().compact(backend, "run", [entry], endedStage, undefined);

	const archiveTransactions = transactions() - before;
	assert.ok(
		archiveTransactions <= ARCHIVE_TRANSACTION_BOUND,
		`${archiveTransactions} journal transactions archived ${DELIVERED_STAGES} receipts`,
	);
	assert.deepEqual(compacted.messages[0]?.deliveries, []);
	const receipts = [];
	for await (const written of journal.read("run"))
		if (written.event.type === RUN_EVENT_TYPES.messageDelivered) receipts.push(written.event.payload);
	assert.deepEqual(
		receipts,
		Array.from({ length: DELIVERED_STAGES }, (_, index) => ({
			messageId: "broadcast",
			delivery: delivery(index),
			accounting: { messageRunId: "run", deliveryCount: index + 1 },
		})),
	);
	for (let index = 0; index < DELIVERED_STAGES; index++)
		assert.equal(await backend.hasPendingStageDeliveryReceipt("run", "broadcast", delivery(index)), true);
});

test("a receipt chain whose first batch fails writes none of the receipts queued after it, leaving no gap (#3931)", async () => {
	let failNext = false;
	const { backend, journal } = await countingBackend({
		failTransaction: () => {
			const fail = failNext;
			failNext = false;
			return fail;
		},
	});
	const entry = broadcast();
	assert.equal(await backend.persistPendingStageMessages("run", [entry]), true);
	failNext = true;
	const chain = { queued: 0 };
	const results = await Promise.allSettled(
		Array.from({ length: RECEIPTS_ACROSS_BATCHES }, (_, index) =>
			backend.archivePendingStageDeliveryReceipt(
				"run",
				"broadcast",
				delivery(index),
				{ messageRunId: "run", deliveryCount: index + 1 },
				chain,
			),
		),
	);

	assert.equal(chain.queued, RECEIPTS_ACROSS_BATCHES);
	assert.ok(results.every((result) => result.status === "rejected"));
	const receipts = [];
	for await (const written of journal.read("run"))
		if (written.event.type === RUN_EVENT_TYPES.messageDelivered) receipts.push(written.event.payload);
	assert.deepEqual(receipts, []);
	assert.equal(
		await backend.hasPendingStageDeliveryReceipt("run", "broadcast", delivery(RECEIPTS_ACROSS_BATCHES - 1)),
		false,
	);
});
