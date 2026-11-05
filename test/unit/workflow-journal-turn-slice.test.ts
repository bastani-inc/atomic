import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	createTurnSlicer,
	JournalDurableBackend,
	JournalExecutionRetiredError,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { JournalEntry } from "../../packages/workflows/src/durable/journal/types.js";

/** Each journal read advances the virtual clock this far, as a synchronous SQLite statement holds the thread. */
const OPERATION_COST_MS = 2;
const OPERATIONS = 128;
/** The journal's turn budget (TURN_BUDGET_MS in journal-backend.ts). */
const TURN_BUDGET_MS = 8;
/** Waiting operations that make a fan-out (FAN_OUT_WAITING_OPERATIONS in journal-backend.ts). */
const FAN_OUT_WAITING_OPERATIONS = 32;
/** Operations that spend one turn's budget; a turn may start one more just before it is spent. */
const OPERATIONS_PER_BUDGET = TURN_BUDGET_MS / OPERATION_COST_MS;
/** Turns a test waits for work that should finish in the next one before it reports what is still missing. */
const SETTLE_TURNS = 10;

class SynchronousCostJournal extends MemoryRunJournal {
	/** Every read's run, in the order the reads started. */
	readonly readRuns: string[] = [];
	/** Runs whose read then waits on this promise, as a read waiting on I/O does. */
	readonly io = new Map<string, Promise<void>>();
	onRead: (runId: string) => void = () => {};
	override async *read(runId: string, fromSeq?: number): AsyncIterable<JournalEntry> {
		this.readRuns.push(runId);
		vi.advanceTimersByTime(OPERATION_COST_MS);
		this.onRead(runId);
		const io = this.io.get(runId);
		if (io !== undefined) await io;
		yield* super.read(runId, fromSeq);
	}
}

// The journal measures its turns with `performance.now()`. A virtual clock that only the reads advance makes every
// turn's operation count exact, whatever else the host is doing.
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["performance"] });
	// A turn the journal began on the other clock ends at the next check phase.
	await nextTurn();
});

afterEach(() => {
	vi.useRealTimers();
});

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function afterTurns(count: number): Promise<string> {
	for (let turn = 0; turn < count; turn++) await nextTurn();
	return `still pending after ${count} turns`;
}

/**
 * Runs `work` while an immediate that re-arms itself marks every event-loop turn, and returns the runs read in each
 * turn. The first entry is the turn that started `work`.
 */
async function readsByTurn(journal: SynchronousCostJournal, work: () => Promise<void>): Promise<string[][]> {
	const turnStarts = [journal.readRuns.length];
	let ticking = true;
	const tick = () => {
		turnStarts.push(journal.readRuns.length);
		if (ticking) setImmediate(tick);
	};
	setImmediate(tick);
	try {
		await work();
	} finally {
		ticking = false;
	}
	turnStarts.push(journal.readRuns.length);
	return turnStarts.slice(1).map((end, index) => journal.readRuns.slice(turnStarts[index], end));
}

async function catchUpAll(
	backend: JournalDurableBackend,
	prefix: string,
	count: number,
	completed: string[] = [],
): Promise<void> {
	await Promise.all(
		Array.from({ length: count }, (_, index) =>
			backend.catchUpWorkflow(`${prefix}-${index}`).then(() => {
				completed.push(`${prefix}-${index}`);
			}),
		),
	);
}

function assertSpendsBudgetPerTurn(operationsPerTurn: readonly number[]): void {
	assert.ok(
		operationsPerTurn.every((operations) => operations <= OPERATIONS_PER_BUDGET + 1),
		`a turn ran more than the ${TURN_BUDGET_MS} ms budget plus one operation of ${OPERATION_COST_MS} ms: ${operationsPerTurn.join(", ")}`,
	);
	assert.ok(
		operationsPerTurn.slice(0, -1).every((operations) => operations >= OPERATIONS_PER_BUDGET),
		`a turn yielded before spending its ${TURN_BUDGET_MS} ms budget: ${operationsPerTurn.join(", ")}`,
	);
}

test("a fan-out's journal work spreads over event-loop turns, checking the budget before every operation", async () => {
	const journal = new SynchronousCostJournal();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: true });
	try {
		const completed: string[] = [];
		const turns = await readsByTurn(journal, () => catchUpAll(backend, "fan-out", OPERATIONS, completed));

		const queued = Array.from({ length: OPERATIONS }, (_, index) => `fan-out-${index}`);
		assert.deepEqual(turns.flat(), queued, "every operation reads its run once, in the order they were queued");
		assert.deepEqual(completed, queued, "operations complete in the order they were queued");
		assertSpendsBudgetPerTurn(turns.map((reads) => reads.length));
	} finally {
		await backend.close();
	}
});

test("journal work below a fan-out's worth runs directly in its turn, and spends that turn's budget", async () => {
	const journal = new SynchronousCostJournal();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: true });
	try {
		const direct = FAN_OUT_WAITING_OPERATIONS - 1;
		const turns = await readsByTurn(journal, async () => {
			await catchUpAll(backend, "direct", direct);
			await catchUpAll(backend, "fan-out", FAN_OUT_WAITING_OPERATIONS);
		});

		const operationsPerTurn = turns.map((reads) => reads.length);
		assert.equal(
			operationsPerTurn[0],
			direct,
			`the ${direct} direct operations did not run alone in one turn: ${operationsPerTurn.join(", ")}`,
		);
		assertSpendsBudgetPerTurn(operationsPerTurn.slice(1));
	} finally {
		await backend.close();
	}
});

test("a queued operation waiting on I/O holds the queue only until the next turn, ahead of work queued after it", async () => {
	const journal = new SynchronousCostJournal();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: true });
	try {
		const waitingRun = `fan-out-${FAN_OUT_WAITING_OPERATIONS - 1}`;
		const io = Promise.withResolvers<void>();
		journal.io.set(waitingRun, io.promise);
		const waitingRead = Promise.withResolvers<void>();
		journal.onRead = (runId) => {
			if (runId === waitingRun) waitingRead.resolve();
		};
		const completed: string[] = [];
		let completedWhileWaiting: string[] = [];
		const turns = await readsByTurn(journal, async () => {
			const fanOut = catchUpAll(backend, "fan-out", FAN_OUT_WAITING_OPERATIONS, completed);
			await waitingRead.promise;
			// Queued while the drain still waits on the fan-out's last operation, with far fewer than a fan-out's worth waiting.
			const late = backend.catchUpWorkflow("late").then(() => {
				completed.push("late");
			});
			await Promise.race([late, afterTurns(SETTLE_TURNS)]);
			completedWhileWaiting = [...completed];
			io.resolve();
			await Promise.all([fanOut, late]);
		});

		assert.deepEqual(
			completedWhileWaiting,
			[...Array.from({ length: FAN_OUT_WAITING_OPERATIONS - 1 }, (_, index) => `fan-out-${index}`), "late"],
			`the queue did not go on while ${waitingRun} waited on I/O`,
		);
		const turnOf = (runId: string) => turns.findIndex((reads) => reads.includes(runId));
		assert.equal(
			turnOf("late"),
			turnOf(waitingRun) + 1,
			"work queued behind the waiting operation started in its turn",
		);
		assert.equal(completed.at(-1), waitingRun);
	} finally {
		await backend.close();
	}
});

test("a queued operation that throws synchronously rejects its own promise, and the queue goes on", async () => {
	const slice = createTurnSlicer(0);
	const failure = new Error("synchronous failure");
	const failing = slice<never>(
		() => {
			throw failure;
		},
		() => 1,
	);
	const next = slice(
		async () => "next",
		() => 1,
	);
	await assert.rejects(Promise.race([failing, afterTurns(SETTLE_TURNS)]), (error) => error === failure);
	assert.equal(await Promise.race([next, afterTurns(SETTLE_TURNS)]), "next");
});

const CHILDREN_PER_ROOT = 64;

function registration(workflowId: string) {
	return { workflowId, name: "child", inputs: {}, createdAt: 1, status: "running" as const };
}

test("a fan-out's queued journal work keeps its own root's execution when another root retires mid-queue", async () => {
	const journal = new SynchronousCostJournal();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: true });
	try {
		const queuedB = Promise.withResolvers<readonly Promise<void>[]>();
		let lateWriteOfRetiredRoot: Promise<void> | undefined;
		const rootA = backend.withWorkflowLease("root-a", async () => {
			const retire = backend.captureWorkflowRetirement("root-a");
			// Root A starts the fan-out, so the queue drains from root A's async context.
			const writes = Array.from({ length: CHILDREN_PER_ROOT }, (_, index) =>
				backend.commitWorkflowRegistration(registration(`a-${index}`)),
			);
			// Root B queues its children behind root A's while they are still waiting.
			await queuedB.promise;
			await retire();
			lateWriteOfRetiredRoot = backend.commitWorkflowRegistration(registration("a-late"));
			// Its rejection is asserted below, after both roots finish; until then this keeps it from being reported as
			// unhandled when it settles first.
			lateWriteOfRetiredRoot.catch(() => {});
			await Promise.allSettled(writes);
		});
		const rootB = backend.withWorkflowLease("root-b", async () => {
			const writes = Array.from({ length: CHILDREN_PER_ROOT }, (_, index) =>
				backend.commitWorkflowRegistration(registration(`b-${index}`)),
			);
			queuedB.resolve(writes);
			return await Promise.allSettled(writes);
		});
		const [, outcomes] = await Promise.all([rootA, rootB]);

		const refused = outcomes.filter((outcome) => outcome.status === "rejected");
		assert.deepEqual(
			refused.map((outcome) => String(outcome.reason)),
			[],
			"root B's child registrations are refused for root A's retirement",
		);
		for (let index = 0; index < CHILDREN_PER_ROOT; index++)
			assert.ok((await journal.getRun(`b-${index}`)) !== undefined, `root B's child b-${index} is not journaled`);
		assert.ok(lateWriteOfRetiredRoot !== undefined);
		await assert.rejects(lateWriteOfRetiredRoot, JournalExecutionRetiredError);
		assert.equal(await journal.getRun("a-late"), undefined);
	} finally {
		await backend.close();
	}
});
