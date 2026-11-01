import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import type { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { JournalEntry } from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * Resolves once the store clock that stamps journal events, SQLite's `unixepoch('subsec')`, reads later than it does
 * now. A replaced history is told from the one it replaced by its events' store times, so the replacement has to be
 * written after the clock has moved on. It moves every millisecond on most platforms, but on Windows SQLite reads it
 * from `GetSystemTimeAsFileTime`, which moves only at the system clock tick, about every 15.6 ms.
 */
async function untilStoreClockTicks(): Promise<void> {
	const store = new DatabaseSync(":memory:");
	try {
		const clock = store.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now");
		const now = () => Number(clock.get()?.now);
		const before = now();
		while (now() <= before) await sleep(1);
	} finally {
		store.close();
	}
}

interface ObservedRead {
	readonly runId: string;
	readonly fromSeq: number;
	events: number;
}

function observeReads(journal: SqlRunJournal): ObservedRead[] {
	const read = journal.read.bind(journal);
	const reads: ObservedRead[] = [];
	journal.read = async function* (runId: string, fromSeq?: number): AsyncIterable<JournalEntry> {
		const observed: ObservedRead = { runId, fromSeq: fromSeq ?? 1, events: 0 };
		reads.push(observed);
		for await (const entry of read(runId, fromSeq)) {
			observed.events++;
			yield entry;
		}
	};
	return reads;
}

async function register(backend: JournalDurableBackend, workflowId: string): Promise<void> {
	await backend.commitWorkflowRegistration({
		workflowId,
		name: workflowId,
		inputs: {},
		createdAt: 1,
		status: "running",
	});
}

async function checkpoint(backend: JournalDurableBackend, workflowId: string, id: string): Promise<void> {
	await backend.commitCheckpoint({
		kind: "tool",
		workflowId,
		checkpointId: id,
		name: id,
		argsHash: id,
		output: id,
		completedAt: Date.now(),
	});
}

let directory: string;
let path: string;
let writer: JournalDurableBackend;
let reader: JournalDurableBackend<SqlRunJournal>;
let reads: ObservedRead[];

async function assertMatchesFreshRead(runId: string): Promise<void> {
	const fresh = await JournalDurableBackend.open(await openSqlRunJournal(path), { runs: [runId] });
	try {
		assert.deepEqual(reader.getWorkflow(runId), fresh.getWorkflow(runId));
		assert.deepEqual(reader.listCheckpoints(runId), fresh.listCheckpoints(runId));
	} finally {
		await fresh.close();
	}
}

beforeEach(async () => {
	directory = makeTempDirectory("journal-catch-up-");
	path = join(directory, "journal.sqlite");
	writer = await JournalDurableBackend.open(await openSqlRunJournal(path));
	for (const workflowId of ["root", "unrelated"]) {
		await register(writer, workflowId);
		await checkpoint(writer, workflowId, `${workflowId}-first`);
	}
	const journal = await openSqlRunJournal(path);
	reads = observeReads(journal);
	reader = await JournalDurableBackend.open(journal, { runs: [] });
});

afterEach(async () => {
	await reader.close();
	await writer.close();
	removeTempDirectory(directory);
});

test("a backend opened for no runs reads no journal events (#3887)", () => {
	assert.deepEqual(reads, []);
	assert.equal(reader.getWorkflow("root"), undefined);
	assert.equal(reader.getWorkflow("unrelated"), undefined);
});

test("catching up a run folds only the events appended since its last folded event (#3887)", async () => {
	await reader.catchUpWorkflow("root");
	assert.deepEqual(
		reads.map(({ runId, fromSeq }) => ({ runId, fromSeq })),
		[{ runId: "root", fromSeq: 1 }],
	);
	const folded = reads[0]!.events;
	await assertMatchesFreshRead("root");
	await checkpoint(writer, "root", "root-second");
	await checkpoint(writer, "root", "root-third");
	reads.length = 0;
	await reader.catchUpWorkflow("root");
	assert.deepEqual(reads, [{ runId: "root", fromSeq: folded, events: 3 }]);
	await assertMatchesFreshRead("root");
	assert.equal(reader.getWorkflow("unrelated"), undefined);
});

test("catching up a run whose history was replaced rebuilds it from its first event (#3887)", async () => {
	await checkpoint(writer, "root", "root-second");
	await reader.catchUpWorkflow("root");
	const folded = reads[0]!.events;
	await writer.deleteWorkflow("root");
	await untilStoreClockTicks();
	await register(writer, "root");
	for (const id of ["replaced-first", "replaced-second", "replaced-third"]) await checkpoint(writer, "root", id);
	reads.length = 0;
	await reader.catchUpWorkflow("root");
	assert.deepEqual(
		reads.map(({ fromSeq }) => fromSeq),
		[folded, 1],
	);
	await assertMatchesFreshRead("root");
	assert.deepEqual(
		reader.listCheckpoints("root").map((entry) => entry.checkpointId),
		["replaced-first", "replaced-second", "replaced-third"],
	);
	await writer.deleteWorkflow("root");
	await reader.catchUpWorkflow("root");
	assert.equal(reader.getWorkflow("root"), undefined);
});
