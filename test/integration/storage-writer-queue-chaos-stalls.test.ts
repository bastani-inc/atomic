import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { sleep } from "../helpers/runtime.js";
import {
	assertIntact,
	CHAOS_TEST_TIMEOUT_MS,
	createWriterQueueChaosHarness,
	rows,
	ticketsOf,
	untilQueued,
} from "./storage-writer-queue-chaos-helpers.js";

/**
 * Simultaneous host-stall chaos for the cross-process writers' queue: writers suspended together past a ticket's
 * lifetime or removal age preserve queue order and tickets once resumed.
 */

const STALL_PAST_TICKET_MS = 3_000;
const STALL_PAST_REMOVAL_MS = 21_000;
const RESUME_GAP_MS = 50;
/**
 * How long after the host continues a writer short of CPU first runs again: several of a waiting writer's 250 ms
 * rechecks, well within the 1.5 s a waiting writer has between refreshing its ticket and the ticket going stale.
 */
const STARVED_RESUME_MS = 800;

const harness = createWriterQueueChaosHarness();
const { database, startWriter, startHolder } = harness;

afterEach(async () => {
	await harness.cleanup();
});

/** Waits until the process has refreshed its ticket at least once: it is past its first look at the queue. */
async function untilWaiting(writers: string, pid: number): Promise<void> {
	const ticket = await untilQueued(writers, pid);
	const queuedAt = statSync(join(writers, ticket)).mtimeMs;
	while (statSync(join(writers, ticket)).mtimeMs === queuedAt) await sleep(5);
}

for (const settled of ["as soon as they queue", "once they wait"] as const)
	test.skipIf(process.platform === "win32")(
		`writers stalled together past a ticket's lifetime ${settled} keep their order when they continue`,
		async () => {
			const { path, writers } = database("queue-chaos-stalled-together-");
			const holder = await startHolder(path);
			const first = await startWriter(path, { label: "first" });
			const second = await startWriter(path, { label: "second" });
			for (const writer of [first, second]) {
				writer.go();
				if (settled === "once they wait") await untilWaiting(writers, writer.pid);
				else await untilQueued(writers, writer.pid);
			}
			first.child.kill("SIGSTOP");
			second.child.kill("SIGSTOP");
			await sleep(STALL_PAST_TICKET_MS);
			holder.child.kill("SIGKILL");
			await holder.child.exited;
			second.child.kill("SIGCONT");
			await sleep(RESUME_GAP_MS);
			first.child.kill("SIGCONT");
			const reports = await Promise.all([first.report(), second.report()]);
			assert.deepEqual(
				reports.map((report) => report.committed),
				[1, 1],
			);
			assert.deepEqual(
				rows(path).map((row) => row.writer),
				["first", "second"],
			);
			assertIntact(path);
		},
		CHAOS_TEST_TIMEOUT_MS,
	);

test.skipIf(process.platform === "win32")(
	"a writer that runs again before another stalled with it keeps its place behind it through several of its rechecks",
	async () => {
		const { path, writers } = database("queue-chaos-stalled-starved-");
		const holder = await startHolder(path);
		const first = await startWriter(path, { label: "first" });
		const second = await startWriter(path, { label: "second" });
		for (const writer of [first, second]) {
			writer.go();
			await untilWaiting(writers, writer.pid);
		}
		first.child.kill("SIGSTOP");
		second.child.kill("SIGSTOP");
		await sleep(STALL_PAST_TICKET_MS);
		holder.child.kill("SIGKILL");
		await holder.child.exited;
		second.child.kill("SIGCONT");
		await sleep(STARVED_RESUME_MS);
		first.child.kill("SIGCONT");
		const reports = await Promise.all([first.report(), second.report()]);
		assert.deepEqual(
			reports.map((report) => report.committed),
			[1, 1],
		);
		assert.deepEqual(
			rows(path).map((row) => row.writer),
			["first", "second"],
		);
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a writer that starts after a stall queues behind the writers the stall left waiting instead of overtaking them",
	async () => {
		const { path, writers } = database("queue-chaos-stalled-newcomer-");
		const holder = await startHolder(path);
		const waiting = await startWriter(path, { label: "waiting" });
		const newcomer = await startWriter(path, { label: "newcomer" });
		waiting.go();
		await untilWaiting(writers, waiting.pid);
		holder.child.kill("SIGSTOP");
		waiting.child.kill("SIGSTOP");
		await sleep(STALL_PAST_TICKET_MS);
		holder.child.kill("SIGKILL");
		await holder.child.exited;
		newcomer.go();
		await sleep(STARVED_RESUME_MS);
		waiting.child.kill("SIGCONT");
		const reports = await Promise.all([waiting.report(), newcomer.report()]);
		assert.deepEqual(
			reports.map((report) => report.committed),
			[1, 1],
		);
		assert.deepEqual(
			rows(path).map((row) => row.writer),
			["waiting", "newcomer"],
		);
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a holder stalled with its waiters past the removal age keeps their tickets when it commits",
	async () => {
		const { path, writers } = database("queue-chaos-stalled-holder-removal-");
		const holder = await startHolder(path);
		const first = await startWriter(path, { label: "first" });
		const second = await startWriter(path, { label: "second" });
		for (const writer of [first, second]) {
			writer.go();
			await untilWaiting(writers, writer.pid);
		}
		const tickets = [first, second].map((writer) => ticketsOf(writers, writer.pid));
		for (const child of [holder.child, first.child, second.child]) child.kill("SIGSTOP");
		await sleep(STALL_PAST_REMOVAL_MS);
		holder.child.kill("SIGCONT");
		await holder.commit();
		assert.deepEqual(
			[first, second].map((writer) => ticketsOf(writers, writer.pid)),
			tickets,
			"the holder's release removed no ticket of a writer stalled with it",
		);
		second.child.kill("SIGCONT");
		await sleep(RESUME_GAP_MS);
		first.child.kill("SIGCONT");
		const reports = await Promise.all([first.report(), second.report()]);
		assert.deepEqual(
			reports.map((report) => report.committed),
			[1, 1],
		);
		assert.deepEqual(
			rows(path).map((row) => row.writer),
			["first", "second"],
		);
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);
