import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { SqliteDatabase, SqliteExecutor } from "../../packages/coding-agent/src/core/storage/database.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type {
	PendingStageMessage,
	PendingStageMessageDelivery,
} from "../../packages/workflows/src/shared/store-types.js";
import {
	decodeStream,
	makeTempDirectory,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
} from "../helpers/runtime.js";

const RECEIPTS = 2_000;
const CALLERS = 160;
/**
 * Journal write transactions the root may issue while a mid-burst pending-stage message waits to persist. One
 * transaction per receipt would put it behind every queued receipt (about one per caller); batching leaves only the
 * batch already in flight, the batch it queues behind, and its own write.
 */
const QUEUED_PERSIST_TRANSACTION_BOUND = 4;
/** Lock holder: one fsync'd write transaction holding the write lock for this long, then a gap. */
const LOCK_HOLD_MS = 30;
const LOCK_GAP_MS = 1;
/** 2,000 fsync'd receipts contending a second process's write lock, plus that process's startup. */
const CONTENDED_BURST_TIMEOUT_MS = 120_000;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A second process that takes the journal file's write lock periodically, as the pool coordinator does. */
async function startLockHolder(path: string): Promise<SpawnedProcess> {
	const script = `
		const { DatabaseSync } = require("node:sqlite");
		const db = new DatabaseSync(process.argv[1]);
		db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
		db.exec("CREATE TABLE IF NOT EXISTS lock_holder(at INTEGER)");
		const pause = new Int32Array(new SharedArrayBuffer(4));
		const insert = db.prepare("INSERT INTO lock_holder VALUES (?)");
		let announced = false;
		const cycle = () => {
			db.exec("BEGIN IMMEDIATE");
			insert.run(Date.now());
			Atomics.wait(pause, 0, 0, ${LOCK_HOLD_MS});
			db.exec("COMMIT");
			if (!announced) { announced = true; process.stdout.write("ready\\n"); }
			setTimeout(cycle, ${LOCK_GAP_MS});
		};
		cycle();
	`;
	const holder = spawnProcess([process.execPath, "-e", script, path], { stdout: "pipe", stderr: "inherit" });
	cleanups.push(async () => {
		holder.kill("SIGKILL");
		await holder.exited;
	});
	const reader = decodeStream(holder.stdout!).getReader();
	let output = "";
	while (!output.includes("ready")) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`lock holder exited before taking the lock: ${output}`);
		output += value;
	}
	reader.releaseLock();
	return holder;
}

function message(id: string, admissionOrder: number): PendingStageMessage {
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
		deliveredAt: "2026-10-24T21:00:00.000Z",
	};
}

test(
	"a pending-stage message queued mid receipt burst persists promptly while another process contends the write lock",
	async () => {
		const dir = makeTempDirectory("journal-receipt-burst-");
		cleanups.push(() => removeTempDirectory(dir));
		const path = join(dir, "journal.sqlite");
		const journal = await openSqlRunJournal(path);
		const { database } = journal as unknown as { readonly database: SqliteDatabase };
		const transaction = database.transaction.bind(database);
		let transactions = 0;
		database.transaction = <T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> => {
			transactions++;
			return transaction(callback);
		};
		const backend = await JournalDurableBackend.open(journal);
		cleanups.push(() => backend.close());
		await backend.commitWorkflowRegistration({
			workflowId: "run",
			name: "root",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		const sticky = message("sticky", 1);
		assert.equal(await backend.persistPendingStageMessages("run", [sticky]), true);
		await startLockHolder(path);

		let issued = 0;
		let stopped = false;
		let midBurst!: () => void;
		const reachedMidBurst = new Promise<void>((resolve) => {
			midBurst = resolve;
		});
		const caller = async () => {
			while (!stopped && issued < RECEIPTS) {
				const index = issued++;
				if (index === RECEIPTS / 2) midBurst();
				await backend.archivePendingStageDeliveryReceipt("run", sticky.id, delivery(index), {
					messageRunId: "run",
					deliveryCount: index + 1,
				});
			}
		};
		const callers = Array.from({ length: CALLERS }, caller);
		try {
			await reachedMidBurst;
			const before = transactions;
			assert.equal(await backend.persistPendingStageMessages("run", [sticky, message("pattern", 2)]), true);
			const waitedBehind = transactions - before;
			assert.ok(
				waitedBehind <= QUEUED_PERSIST_TRANSACTION_BOUND,
				`pending-stage message waited behind ${waitedBehind} journal transactions from ${CALLERS} receipt callers`,
			);
			await Promise.all(callers);
		} finally {
			stopped = true;
			await Promise.allSettled(callers);
		}
		assert.equal(backend.getPendingStageMessageDeliveryCount("run", sticky.id, "run"), RECEIPTS);
		assert.deepEqual(
			backend.getWorkflow("run")?.pendingStageMessages?.map((entry) => entry.id),
			["sticky", "pattern"],
		);
	},
	CONTENDED_BURST_TIMEOUT_MS,
);
