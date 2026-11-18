/**
 * The reads a workflow catalog catch-up makes of a SQL journal. With the local SQLite store each statement holds the
 * event loop while it runs, so before #5480 a few of them could freeze Atomic on a large journal: the walk back to a
 * run's latest snapshot past every later event, every run's latest event in one statement, every shard of a store in
 * one turn, and pages of a megabyte. Each now runs in bounded statements with turns of the event loop between them,
 * and reads what the single statement read.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { type SQLInputValue, type SQLOutputValue, StatementSync } from "node:sqlite";
import { setImmediate } from "node:timers";
import { afterEach, beforeEach, test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { ShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import type { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	RUN_EVENT_TYPES as E,
	type RunEvent,
	type RunJournal,
	type RunJournalSeedEvent,
} from "../../packages/workflows/src/durable/journal/types.js";
import { observeJournalRead } from "../helpers/journal-read-observation.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Events after the snapshot: far more than one bounded statement visits. */
const LONG_TAIL_EVENTS = 40_000;
/** Runs in a journal: more than one bounded statement of `runVersions` looks up. */
const MANY_RUNS = 600;
/** Characters of payload one page of a run's read returns at most, events larger than that aside. */
const QUARTER_MEGABYTE = 256 * 1024;

let directory: string;
let journal: SqlRunJournal;

beforeEach(async () => {
	directory = makeTempDirectory("journal-snapshot-tail-");
	journal = await openSqlRunJournal(join(directory, "journal.sqlite"));
});

afterEach(async () => {
	await journal.close();
	removeTempDirectory(directory);
});

function snapshotEvent(runId: string, type: typeof E.runStarted | typeof E.statusChanged, marker: string): RunEvent {
	return { type, payload: { workflowId: runId, status: "running", marker } } as RunEvent;
}

/** `count` events that are not snapshots: every third one a checkpoint, completed at `1_000 + its index`. */
function tailEvents(count: number, from = 0): RunJournalSeedEvent[] {
	return Array.from({ length: count }, (_, offset) => {
		const index = from + offset;
		if (index % 3 === 0)
			return {
				event: {
					type: E.checkpointRecorded,
					payload: { kind: "tool", checkpointId: `c${index}`, completedAt: 1_000 + index },
				},
				key: JSON.stringify([E.checkpointRecorded, "tool", `c${index}`]),
			} as RunJournalSeedEvent;
		return {
			event: { type: index % 3 === 1 ? E.messageDelivered : E.messageSettled, payload: { index } },
		} as RunJournalSeedEvent;
	});
}

async function seed(runId: string, events: readonly RunJournalSeedEvent[]): Promise<void> {
	assert.equal(
		await journal.createRunWithEvents(
			{ runId, name: "tail", cwd: "/project", createdAt: 1, status: "running" },
			events,
		),
		"created",
	);
}

/** Runs `read` while counting the turns the event loop got meanwhile. */
async function countingTurns<T>(read: () => Promise<T>): Promise<{ readonly value: T; readonly turns: number }> {
	let turns = 0;
	let running = true;
	const tick = () => {
		if (!running) return;
		turns++;
		setImmediate(tick);
	};
	setImmediate(tick);
	try {
		const value = await read();
		return { value, turns };
	} finally {
		running = false;
	}
}

/** A run's first event, whose handle a catch-up lists the run by when it reads no later snapshot. */
function startedEvent(runId: string): RunEvent {
	return {
		type: E.runStarted,
		payload: {
			workflowId: runId,
			name: "catch-up",
			inputs: {},
			status: "running",
			createdAt: 1,
			updatedAt: 1,
			completedCheckpoints: 0,
			pendingPrompts: 0,
			pendingStageMessages: [],
		},
	} as RunEvent;
}

/**
 * Counts the statements that return rows the local SQLite store runs while a call of `journal[method]` is in flight,
 * calling `onFirst` once the first of them has run. `settled()` waits for every such call to end.
 */
function countStatementsOf(
	journal: SqlRunJournal,
	method: "snapshotTail" | "runVersions",
	onFirst: () => void,
): { readonly count: () => number; readonly settled: () => Promise<void>; restore(): void } {
	const all = StatementSync.prototype.all;
	const original = journal[method];
	const calls: Promise<unknown>[] = [];
	let inFlight = 0;
	let statements = 0;
	Reflect.set(StatementSync.prototype, "all", function (this: StatementSync, ...params: SQLInputValue[]) {
		const rows: Record<string, SQLOutputValue>[] = Reflect.apply(all, this, params);
		if (inFlight > 0 && ++statements === 1) onFirst();
		return rows;
	});
	Reflect.set(journal, method, (...args: unknown[]) => {
		inFlight++;
		const call = Reflect.apply(original, journal, args) as Promise<unknown>;
		calls.push(call);
		void call.then(
			() => inFlight--,
			() => inFlight--,
		);
		return call;
	});
	return {
		count: () => statements,
		settled: async () => {
			await Promise.allSettled(calls);
		},
		restore() {
			StatementSync.prototype.all = all;
			Reflect.set(journal, method, original);
		},
	};
}

test("a snapshot behind a long tail of checkpoints is found in bounded statements with turns between them (#5480)", async () => {
	const runId = testRunId("long-tail");
	await seed(runId, [
		{ event: snapshotEvent(runId, E.runStarted, "started") },
		{ event: snapshotEvent(runId, E.statusChanged, "latest snapshot") },
		...tailEvents(LONG_TAIL_EVENTS),
	]);
	const version = (await journal.runVersions()).get(runId);
	const { value: tail, turns } = await countingTurns(() => journal.snapshotTail(runId));
	assert.ok(turns > 0, "the event loop turned while the tail was read");
	const lastCheckpoint = LONG_TAIL_EVENTS - 1 - ((LONG_TAIL_EVENTS - 1) % 3);
	assert.deepEqual(
		{
			version: tail?.version,
			seq: tail?.snapshot.seq,
			event: tail?.snapshot.event,
			laterCheckpoints: tail?.laterCheckpoints,
			lastCheckpointAt: tail?.lastCheckpointAt,
		},
		{
			version,
			seq: 2,
			event: snapshotEvent(runId, E.statusChanged, "latest snapshot"),
			laterCheckpoints: Math.ceil(LONG_TAIL_EVENTS / 3),
			lastCheckpointAt: 1_000 + lastCheckpoint,
		},
	);
});

test("a catch-up no caller waits for any more stops walking back to a snapshot at the next statement (#5480)", async () => {
	const runId = testRunId("abandoned-snapshot-walk");
	await seed(runId, [{ event: startedEvent(runId) }, ...tailEvents(LONG_TAIL_EVENTS)]);
	const backend = await JournalDurableBackend.open(journal, { runs: [], ownsJournal: false });
	const controller = new AbortController();
	// The sole caller stops waiting as soon as the walk has read its first statement's events.
	const walk = countStatementsOf(journal, "snapshotTail", () => controller.abort(new Error("caller gave up")));
	try {
		await assert.rejects(backend.hydrateResumableWorkflows({ signal: controller.signal }), /caller gave up/);
		await walk.settled();
	} finally {
		walk.restore();
	}
	assert.equal(walk.count(), 1, `the walk ran ${walk.count() - 1} statements after its last caller stopped waiting`);
	// The stopped walk let go of the read it held: the next catch-up reads the same journal to the end.
	await backend.hydrateResumableWorkflows();
	assert.equal(backend.getWorkflow(runId)?.completedCheckpoints, Math.ceil(LONG_TAIL_EVENTS / 3));
	await backend.close();
});

test("a catch-up no caller waits for any more stops reading run versions at the next statement (#5480)", async () => {
	const runIds = Array.from({ length: MANY_RUNS }, (_, index) => testRunId(`abandoned-versions-${index}`));
	for (const runId of runIds) await seed(runId, [{ event: startedEvent(runId) }]);
	const backend = await JournalDurableBackend.open(journal, { runs: [], ownsJournal: false });
	const controller = new AbortController();
	const versions = countStatementsOf(journal, "runVersions", () => controller.abort(new Error("caller gave up")));
	try {
		await assert.rejects(backend.hydrateResumableWorkflows({ signal: controller.signal }), /caller gave up/);
		await versions.settled();
	} finally {
		versions.restore();
	}
	assert.equal(versions.count(), 1, `${versions.count() - 1} statements after its last caller stopped waiting`);
	await backend.hydrateResumableWorkflows();
	assert.deepEqual(
		runIds.filter((runId) => backend.getWorkflow(runId) === undefined),
		[],
		"the next catch-up lists every run",
	);
	await backend.close();
});

for (const method of ["changeToken", "runVersions"] as const)
	test(`a catch-up no caller waits for any more stops its ${method} read at the next shard of a store (#5480)`, async () => {
		const controller = new AbortController();
		let catchingUp = false;
		let shardReads = 0;
		const store = await ShardedRunJournal.open({
			directory: join(directory, "store"),
			openShard: async (path) => {
				const shard: RunJournal = await openSqlRunJournal(path);
				const read = shard[method]!;
				Reflect.set(shard, method, (...args: unknown[]) => {
					// The sole caller stops waiting while the first shard is read.
					if (catchingUp && ++shardReads === 1) controller.abort(new Error("caller gave up"));
					return Reflect.apply(read, shard, args) as Promise<unknown>;
				});
				return shard;
			},
		});
		try {
			// A running root keeps its shard busy, so each new root takes a shard of its own.
			const roots = ["first", "second", "third"];
			for (const runId of roots)
				assert.equal(
					await store.createRun({ runId, name: "wf", cwd: "/project", createdAt: 1, status: "running" }),
					"created",
				);
			assert.equal(new Set(roots.map((runId) => store.shardOf(runId)?.id)).size, roots.length);
			const backend = await JournalDurableBackend.open(store, { runs: [], ownsJournal: false });
			const list = store[method];
			let listing: Promise<unknown> | undefined;
			Reflect.set(store, method, (...args: unknown[]) => {
				listing = Reflect.apply(list, store, args) as Promise<unknown>;
				return listing;
			});
			catchingUp = true;
			await assert.rejects(backend.hydrateResumableWorkflows({ signal: controller.signal }), /caller gave up/);
			await Promise.allSettled([listing]);
			assert.equal(shardReads, 1, `the catch-up read ${shardReads} shards`);
			await backend.close();
		} finally {
			await store.close();
		}
	});

test("a run with no snapshot event behind a long tail has no snapshot tail (#5480)", async () => {
	const runId = testRunId("no-snapshot");
	await seed(runId, tailEvents(LONG_TAIL_EVENTS));
	assert.equal(await journal.snapshotTail(runId), undefined);
});

test("a snapshot among the latest events is read with the checkpoints after it (#5480)", async () => {
	const runId = testRunId("recent-snapshot");
	await seed(runId, [
		{ event: snapshotEvent(runId, E.runStarted, "started") },
		...tailEvents(LONG_TAIL_EVENTS),
		{ event: snapshotEvent(runId, E.statusChanged, "recent") },
		...tailEvents(4, LONG_TAIL_EVENTS),
	]);
	const tail = await journal.snapshotTail(runId);
	assert.equal(tail?.snapshot.seq, LONG_TAIL_EVENTS + 2);
	assert.deepEqual(tail?.snapshot.event, snapshotEvent(runId, E.statusChanged, "recent"));
	// The checkpoints among the four events after the snapshot.
	assert.equal(tail?.laterCheckpoints, [0, 1, 2, 3].filter((offset) => (LONG_TAIL_EVENTS + offset) % 3 === 0).length);
	assert.equal(tail?.version.seq, LONG_TAIL_EVENTS + 6);
});

test("every run's latest event is read in bounded statements with turns between them (#5480)", async () => {
	const runIds = Array.from({ length: MANY_RUNS }, (_, index) => testRunId(`versions-${index}`));
	await Promise.all(
		runIds.map((runId, index) =>
			seed(runId, [{ event: snapshotEvent(runId, E.runStarted, "started") }, ...tailEvents(index % 3)]),
		),
	);
	const { value: versions, turns } = await countingTurns(() => journal.runVersions());
	assert.ok(turns > 0, "the event loop turned while the versions were read");
	assert.deepEqual(
		runIds.map((runId) => versions.get(runId)?.seq),
		runIds.map((_, index) => 1 + (index % 3)),
	);
	assert.equal(versions.size, MANY_RUNS);
});

test("a store of several shards gives the event loop a turn between shards while it lists them (#5480)", async () => {
	const store = await ShardedRunJournal.open({
		directory: join(directory, "store"),
		openShard: (path) => openSqlRunJournal(path),
	});
	try {
		// A running root keeps its shard busy, so each new root takes a shard of its own.
		const roots = ["first", "second", "third"];
		for (const runId of roots)
			assert.equal(
				await store.createRun({ runId, name: "wf", cwd: "/project", createdAt: 1, status: "running" }),
				"created",
			);
		assert.equal(new Set(roots.map((runId) => store.shardOf(runId)?.id)).size, roots.length);
		// The first listing opens the shards; the turns that count are a listing's own.
		await store.runVersions();
		const versions = await countingTurns(() => store.runVersions());
		const token = await countingTurns(() => store.changeToken());
		assert.ok(versions.turns >= roots.length - 1, `${versions.turns} turns while the versions were read`);
		assert.ok(token.turns >= roots.length - 1, `${token.turns} turns while the change token was read`);
		assert.deepEqual([...versions.value.keys()].sort(), [...roots].sort());
	} finally {
		await store.close();
	}
});

test("a page of a run's read holds at most a quarter megabyte of payload (#5480)", async () => {
	const runId = testRunId("large-events");
	const payload = "x".repeat(QUARTER_MEGABYTE / 4);
	await seed(runId, [
		{ event: snapshotEvent(runId, E.runStarted, "started") },
		...Array.from({ length: 12 }, (_, index) => ({
			event: { type: E.summaryRecorded, payload: { index, payload } } as RunEvent,
		})),
	]);
	const observed = observeJournalRead(journal);
	try {
		const read = await Array.fromAsync(journal.read(runId));
		assert.equal(read.length, 13);
		// A page ends with the event that takes it past a quarter megabyte: the small first event and four large ones,
		// then four large ones at a time.
		assert.deepEqual(observed.pageSizes.slice(0, 3), [5, 4, 4]);
	} finally {
		observed.restore();
	}
});
