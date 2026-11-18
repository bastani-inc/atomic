/**
 * A run's snapshot tail is how the workflow catalog lists a run without reading its history: its latest snapshot event
 * and the checkpoints recorded after it. One statement used to walk back to that snapshot, visiting every event after
 * it, so a run with a hundred thousand checkpoints after its snapshot held the event loop for that whole walk, for
 * seconds when the pages were not cached (#5480). The walk now runs in bounded statements and gives the event loop a
 * turn between them, and finds what the single statement found.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import { afterEach, beforeEach, test } from "vitest";
import type { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	RUN_EVENT_TYPES as E,
	type RunEvent,
	type RunJournalSeedEvent,
} from "../../packages/workflows/src/durable/journal/types.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Events after the snapshot: far more than one bounded statement visits. */
const LONG_TAIL_EVENTS = 40_000;

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

/** Calls the tail while counting the turns the event loop got meanwhile. */
async function tailCountingTurns(runId: string) {
	let turns = 0;
	let running = true;
	const tick = () => {
		if (!running) return;
		turns++;
		setImmediate(tick);
	};
	setImmediate(tick);
	try {
		return { tail: await journal.snapshotTail(runId), turns };
	} finally {
		running = false;
	}
}

test("a snapshot behind a long tail of checkpoints is found in bounded statements with turns between them (#5480)", async () => {
	const runId = testRunId("long-tail");
	await seed(runId, [
		{ event: snapshotEvent(runId, E.runStarted, "started") },
		{ event: snapshotEvent(runId, E.statusChanged, "latest snapshot") },
		...tailEvents(LONG_TAIL_EVENTS),
	]);
	const version = (await journal.runVersions()).get(runId);
	const { tail, turns } = await tailCountingTurns(runId);
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
