import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import { sleep } from "../helpers/runtime.js";
import {
	assertIntact,
	CHAOS_TEST_TIMEOUT_MS,
	createWriterQueueChaosHarness,
	rows,
	untilQueued,
} from "./storage-writer-queue-chaos-helpers.js";

const harness = createWriterQueueChaosHarness();
const { database, startWriter, startHolder } = harness;

afterEach(async () => {
	await harness.cleanup();
});

test(
	"pipelined leadingOnly and finisher writers survive crash/restart of a holder and queued waiter with checkpoints (#6706)",
	async () => {
		const { path, writers } = database("queue-pipelined-crash-");

		// First commit rows via both leadingOnly and finisher before any crash.
		const initialLeading = await startWriter(path, {
			label: "init-lead",
			transactions: 5,
			concurrency: 2,
			mode: "leadingOnly",
		});
		const initialFinisher = await startWriter(path, {
			label: "init-fin",
			transactions: 5,
			concurrency: 2,
			mode: "finisher",
		});
		initialLeading.go();
		initialFinisher.go();
		const [rInitLead, rInitFin] = await Promise.all([initialLeading.report(), initialFinisher.report()]);
		assert.deepEqual([rInitLead.committed, rInitLead.errors], [5, []]);
		assert.deepEqual([rInitFin.committed, rInitFin.errors], [5, []]);

		// Hold the lock mid-transaction (uncommitted row), queue a waiter that crashes, and queue surviving
		// leadingOnly + finisher writers behind it.
		const holder = await startHolder(path);
		const killedWaiter = await startWriter(path, { label: "killed-waiter", mode: "leadingOnly" });
		const survivorLeading = await startWriter(path, {
			label: "surv-lead",
			transactions: 8,
			concurrency: 3,
			mode: "leadingOnly",
		});
		const survivorFinisher = await startWriter(path, {
			label: "surv-fin",
			transactions: 8,
			concurrency: 3,
			mode: "finisher",
		});

		killedWaiter.go();
		await untilQueued(writers, killedWaiter.pid);
		survivorLeading.go();
		await untilQueued(writers, survivorLeading.pid);
		survivorFinisher.go();
		await untilQueued(writers, survivorFinisher.pid);

		// Crash both the queued waiter and the active lock holder with SIGKILL.
		killedWaiter.child.kill("SIGKILL");
		await killedWaiter.child.exited;
		holder.child.kill("SIGKILL");
		await holder.child.exited;

		const [rSurvLead, rSurvFin] = await Promise.all([survivorLeading.report(), survivorFinisher.report()]);
		assert.deepEqual([rSurvLead.committed, rSurvLead.errors], [8, []]);
		assert.deepEqual([rSurvFin.committed, rSurvFin.errors], [8, []]);

		// Checkpoint the WAL cleanly after crash recovery, then run a restarted writer process.
		const checkpointer = new DatabaseSync(path, { timeout: 10_000 });
		try {
			checkpointer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} finally {
			checkpointer.close();
		}

		const restarted = await startWriter(path, {
			label: "restarted",
			transactions: 6,
			concurrency: 2,
			mode: "finisher",
		});
		restarted.go();
		const rRestarted = await restarted.report();
		assert.deepEqual([rRestarted.committed, rRestarted.errors], [6, []]);

		const written = rows(path);
		const byLabel = (label: string) => written.filter((row) => row.writer === label).map((row) => row.seq);
		assert.deepEqual(
			byLabel("init-lead").sort((a, b) => a - b),
			[0, 1, 2, 3, 4],
		);
		assert.deepEqual(
			byLabel("init-fin").sort((a, b) => a - b),
			[0, 1, 2, 3, 4],
		);
		assert.deepEqual(byLabel("killed-waiter"), []);
		assert.deepEqual(
			byLabel("surv-lead").sort((a, b) => a - b),
			[0, 1, 2, 3, 4, 5, 6, 7],
		);
		assert.deepEqual(
			byLabel("surv-fin").sort((a, b) => a - b),
			[0, 1, 2, 3, 4, 5, 6, 7],
		);
		assert.deepEqual(
			byLabel("restarted").sort((a, b) => a - b),
			[0, 1, 2, 3, 4, 5],
		);
		assert.equal(written.length, 32);
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test(
	"concurrent cross-process leadingOnly and finisher writers commit intact alongside PASSIVE, RESTART, and TRUNCATE checkpoints (#6706)",
	async () => {
		const { path } = database("queue-pipelined-checkpoints-");
		const started = await Promise.all([
			startWriter(path, { label: "lead-a", transactions: 15, concurrency: 4, mode: "leadingOnly" }),
			startWriter(path, { label: "lead-b", transactions: 15, concurrency: 4, mode: "leadingOnly" }),
			startWriter(path, { label: "fin-a", transactions: 15, concurrency: 4, mode: "finisher", busyMs: 1 }),
			startWriter(path, { label: "fin-b", transactions: 15, concurrency: 4, mode: "finisher", busyMs: 1 }),
		]);
		for (const writer of started) writer.go();

		// Interleave WAL checkpoints on a separate connection while cross-process pipelined writers contend.
		const checkpointer = new DatabaseSync(path, { timeout: 1_000 });
		let done = false;
		const reportsPromise = Promise.all(started.map((writer) => writer.report())).finally(() => {
			done = true;
		});
		const modes = ["PASSIVE", "RESTART", "TRUNCATE"] as const;
		let step = 0;
		try {
			while (!done) {
				const mode = modes[step++ % modes.length]!;
				try {
					checkpointer.exec(`PRAGMA wal_checkpoint(${mode})`);
				} catch {
					// SQLITE_BUSY from RESTART/TRUNCATE while writers hold the lock is expected; keep going.
				}
				await sleep(5);
			}
		} finally {
			checkpointer.close();
		}

		const reports = await reportsPromise;
		for (const report of reports) assert.deepEqual([report.committed, report.errors], [15, []]);

		const written = rows(path);
		assert.equal(written.length, 60);
		for (const label of ["lead-a", "lead-b", "fin-a", "fin-b"]) {
			assert.deepEqual(
				written
					.filter((row) => row.writer === label)
					.map((row) => row.seq)
					.sort((a, b) => a - b),
				Array.from({ length: 15 }, (_, seq) => seq),
				`${label} committed every transaction once`,
			);
		}
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);
