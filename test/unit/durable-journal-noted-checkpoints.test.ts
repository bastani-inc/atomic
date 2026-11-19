/**
 * A pooled worker notes each checkpoint its host accepted locally (`noteRecordedCheckpoint`) before the root's journal
 * holds it: the host ships it later, after every event the journal holds when the worker notes it. Until its own event
 * is folded, the noted checkpoint is the latest result of its stage, whatever earlier events the worker's catch-up
 * folds meanwhile; once it is folded, the worker's view reads as the journal does.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import { afterEach, beforeEach, test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { JournalEntry } from "../../packages/workflows/src/durable/journal/types.js";
import { latestStageSessionCheckpoints } from "../../packages/workflows/src/durable/stage-primitive.js";
import type {
	DurableStageCheckpoint,
	DurableToolCheckpoint,
	DurableUiCheckpoint,
} from "../../packages/workflows/src/durable/types.js";
import { poolWorkerCommit } from "../../packages/workflows/src/workers/pool-commit.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Checkpoints the worker's catch-up folds in one extension: folding them takes several turns of the event loop. */
const EXTENSION_CHECKPOINTS = 20_000;
/** Writing 20,000 checkpoints through a backend, and folding them, is structural cost. */
const EXTENSION_TEST_TIMEOUT_MS = 120_000;
/** The worker's selection: the checkpoints of the child it runs. */
const CHILD = { ids: [], prefixes: ["child:"] };

/** A result of the child's task; a prompt restart records a superseding one under the same replay key. */
function taskResult(output: string, completedAt: number): DurableStageCheckpoint {
	return {
		kind: "stage",
		workflowId: "root",
		checkpointId: `child:task:${output}`,
		name: "task",
		replayKey: "child:task",
		output,
		completedAt,
	};
}

function toolResult(id: string, argsHash: string, completedAt: number): DurableToolCheckpoint {
	return {
		kind: "tool",
		workflowId: "root",
		checkpointId: `child:${id}`,
		name: "step",
		argsHash,
		output: id,
		completedAt,
	};
}

function answer(response: string, completedAt: number): DurableUiCheckpoint {
	return {
		kind: "ui",
		workflowId: "root",
		checkpointId: `child:answer:${response}`,
		promptKind: "input",
		message: "Proceed?",
		promptHash: "child:proceed",
		response,
		completedAt,
	};
}

let directory: string;
let writer: JournalDurableBackend;
let reader: JournalDurableBackend;

/** The root's writer, and a worker's reader of the root narrowed to its child, that has folded the run's start. */
beforeEach(async () => {
	directory = makeTempDirectory("noted-checkpoints-");
	const path = join(directory, "journal.sqlite");
	writer = await JournalDurableBackend.open(await openSqlRunJournal(path));
	reader = await JournalDurableBackend.open(await openSqlRunJournal(path), { runs: [] });
	await writer.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	await reader.retainCheckpoints("root", CHILD);
	await reader.catchUpWorkflow("root");
});

afterEach(async () => {
	await reader.close();
	await writer.close();
	removeTempDirectory(directory);
});

function assertReadsAsJournal(): void {
	assert.deepEqual(reader.getWorkflow("root"), writer.getWorkflow("root"));
	assert.deepEqual(reader.listCheckpoints("root"), writer.listCheckpoints("root"));
}

test("a noted result stays the latest while an earlier result folds, and once it ships (#4768)", async () => {
	// The journal holds an earlier result and answer the worker has not folded yet when it notes its own.
	await writer.commitCheckpoint(taskResult("older", 100));
	await writer.commitCheckpoint(answer("older", 101));
	const noted = taskResult("newest", 1_000);
	const notedAnswer = answer("newest", 1_001);
	reader.noteRecordedCheckpoint(noted);
	reader.noteRecordedCheckpoint(notedAnswer);
	await reader.catchUpWorkflow("root");
	assert.equal(reader.getStageOutput("root", noted.replayKey), "newest");
	assert.equal(reader.getUiResponse("root", notedAnswer.promptHash), "newest");
	await writer.commitCheckpoint(noted);
	await writer.commitCheckpoint(notedAnswer);
	await reader.catchUpWorkflow("root");
	assert.equal(reader.getStageOutput("root", noted.replayKey), "newest");
	assert.equal(reader.getUiResponse("root", notedAnswer.promptHash), "newest");
	assertReadsAsJournal();
});

test("folding an older retry restores pending task, answer and tool lookups without overriding a later completion (#5480)", async () => {
	const first = [
		taskResult("old", 500),
		answer("old", 500),
		toolResult("old-tie", "tie", 500),
		toolResult("old-skew", "skew", 900),
	];
	const later = [
		taskResult("new", 400),
		answer("new", 400),
		toolResult("new-tie", "tie", 500),
		toolResult("new-skew", "skew", 600),
	];
	for (const c of first) await writer.commitCheckpoint(c);
	for (const c of [...later, ...first]) reader.noteRecordedCheckpoint(c);
	await reader.catchUpWorkflow("root");
	assert.equal(reader.getStageOutput("root", "child:task"), "new");
	assert.equal(reader.getUiResponse("root", "child:proceed"), "new");
	assert.equal(reader.getToolOutput("root", "tie"), "new-tie");
	assert.equal(reader.getToolOutput("root", "skew"), "old-skew");
	for (const c of later) await writer.commitCheckpoint(c);
	await reader.catchUpWorkflow("root");
	assertReadsAsJournal();
});

test("a retimed tool receipt gives way to the already folded winner when its journal time is restored (#5480)", async () => {
	const first = toolResult("folded", "same", 45);
	const whilePending = toolResult("during", "other", 49);
	const canonical = toolResult("retried", "same", 42);
	const other = toolResult("retried-other", "other", 42);
	await writer.commitCheckpoint(first);
	await reader.catchUpWorkflow("root");
	for (const c of [whilePending, canonical, other]) await writer.commitCheckpoint(c);
	reader.noteRecordedCheckpoint({ ...canonical, completedAt: 50 });
	reader.noteRecordedCheckpoint({ ...other, completedAt: 50 });
	assert.equal(reader.getToolOutput("root", "same"), "retried");
	await reader.catchUpWorkflow("root");
	for (const hash of ["same", "other"])
		assert.deepEqual(reader.getToolCheckpoint("root", hash), writer.getToolCheckpoint("root", hash));
	assertReadsAsJournal();
});

test("a later noted result keeps its stage when an earlier noted result ships (#4768)", async () => {
	const first = taskResult("first", 1_000);
	const second = taskResult("second", 2_000);
	reader.noteRecordedCheckpoint(first);
	reader.noteRecordedCheckpoint(second);
	await writer.commitCheckpoint(first);
	await reader.catchUpWorkflow("root");
	assert.equal(reader.getStageOutput("root", second.replayKey), "second");
	await writer.commitCheckpoint(second);
	await reader.catchUpWorkflow("root");
	assert.equal(reader.getStageOutput("root", second.replayKey), "second");
	assertReadsAsJournal();
});

test("a noted tool result keeps its lookup from an earlier one completed at the same time, not from one completed later (#4768)", async () => {
	await writer.commitCheckpoint(toolResult("tie-earlier", "tie", 500));
	// Another process's clock ran ahead: its earlier result reads as completed after the worker's.
	await writer.commitCheckpoint(toolResult("skew-earlier", "skew", 900));
	const notedTie = toolResult("tie-noted", "tie", 500);
	const notedSkew = toolResult("skew-noted", "skew", 600);
	reader.noteRecordedCheckpoint(notedTie);
	reader.noteRecordedCheckpoint(notedSkew);
	await reader.catchUpWorkflow("root");
	assert.equal(reader.getToolOutput("root", "tie"), "tie-noted");
	assert.equal(reader.getToolOutput("root", "skew"), "skew-earlier");
	await writer.commitCheckpoint(notedTie);
	await writer.commitCheckpoint(notedSkew);
	await reader.catchUpWorkflow("root");
	assert.equal(reader.getToolOutput("root", "tie"), writer.getToolOutput("root", "tie"));
	assert.equal(reader.getToolOutput("root", "skew"), writer.getToolOutput("root", "skew"));
	assertReadsAsJournal();
});

test("the worker recovers the latest noted stage session on a completion tie before shipment (#5480)", async () => {
	const earlier = { ...taskResult("older", 100), sessionId: "s-older" };
	const noted = { ...taskResult("latest", 100), sessionId: "s-newer" };
	await writer.commitCheckpoint(earlier);
	reader.noteRecordedCheckpoint(noted);
	await reader.catchUpWorkflow("root");
	assert.equal(reader.getStageSession("root", noted.replayKey)?.sessionId, "s-newer");
	assert.equal(latestStageSessionCheckpoints(reader, "root").get(noted.replayKey)?.sessionId, "s-newer");
});

test("a late receipt for a folded result during selection restoration is not counted twice (#5480)", async () => {
	const own = taskResult("own", 10);
	await writer.commitCheckpoint(own);
	await reader.catchUpWorkflow("root");
	await reader.retainCheckpoints("root", { ids: [], prefixes: [] });
	let late = false;
	const read = reader.journal.readKey.bind(reader.journal);
	reader.journal.readKey = async (...args) => {
		if (!late) reader.noteRecordedCheckpoint(own);
		late = true;
		return read(...args);
	};
	await reader.retainCheckpoints("root", { ids: [own.checkpointId], prefixes: CHILD.prefixes });
	reader.journal.readKey = read;
	assert.ok(late);
	await writer.commitCheckpoint(taskResult("next", 11));
	await reader.catchUpWorkflow("root");
	assert.equal(reader.getStageOutput("root", own.replayKey), "next");
	assertReadsAsJournal();
});

test("a narrowed worker keeps a still-selected local receipt until its event folds (#5480)", async () => {
	const local = taskResult("unshipped", 15);
	reader.noteRecordedCheckpoint(local);
	await reader.retainCheckpoints("root", { ids: [local.checkpointId], prefixes: [] });
	assert.equal(reader.getStageOutput("root", local.replayKey), local.output);
	await writer.commitCheckpoint(local);
	await reader.catchUpWorkflow("root");
	assertReadsAsJournal();
});

test("a result noted after its own event was folded changes nothing (#4768)", async () => {
	const noted = taskResult("noted", 1_000);
	// The host shipped the result and the worker folded it before the host's receipt reached the worker.
	await writer.commitCheckpoint(noted);
	await reader.catchUpWorkflow("root");
	reader.noteRecordedCheckpoint(noted);
	await writer.commitCheckpoint(taskResult("later", 2_000));
	await reader.catchUpWorkflow("root");
	assert.equal(reader.getStageOutput("root", noted.replayKey), "later");
	assertReadsAsJournal();
});

test(
	"a result noted while a catch-up folds in turns stays the latest, and reads as the journal once it ships (#5480)",
	async () => {
		await Promise.all(
			Array.from({ length: EXTENSION_CHECKPOINTS }, (_, i) =>
				writer.commitCheckpoint({
					kind: "tool",
					workflowId: "root",
					checkpointId: `child:fill-${i}`,
					name: "fill",
					argsHash: `fill-${i}`,
					output: i,
					completedAt: 100 + i,
				}),
			),
		);
		await writer.commitCheckpoint(taskResult("older", 100_000));
		const noted = taskResult("newest", 1_000_000);
		const commit = poolWorkerCommit({
			send: async () => ({ at: noted.completedAt, local: true }),
			catchUp: () => reader.catchUpWorkflow("root"),
			noteLocal: (checkpoint) => reader.noteRecordedCheckpoint(checkpoint),
		});
		// The worker's host accepts the result in the first turn after the catch-up has read the journal.
		const read = reader.journal.read.bind(reader.journal);
		let extending = true;
		let notedWhileExtending = false;
		reader.journal.read = async function* (runId, fromSeq): AsyncIterable<JournalEntry> {
			for await (const entry of read(runId, fromSeq)) yield entry;
			setImmediate(() => {
				void commit({ kind: "checkpoint", checkpoint: noted }).then(() => {
					notedWhileExtending = extending;
				});
			});
		};
		await reader.catchUpWorkflow("root");
		extending = false;
		reader.journal.read = read;
		assert.ok(notedWhileExtending, "the result was noted between the turns of the catch-up's fold");
		assert.equal(reader.getStageOutput("root", noted.replayKey), "newest");
		await writer.commitCheckpoint(noted);
		await reader.catchUpWorkflow("root");
		assert.equal(reader.getStageOutput("root", noted.replayKey), "newest");
		assertReadsAsJournal();
	},
	EXTENSION_TEST_TIMEOUT_MS,
);

test("a noted checkpoint a narrower selection lets go of is counted once when it ships (#4768)", async () => {
	const noted = taskResult("newest", 1_000);
	reader.noteRecordedCheckpoint(noted);
	// A worker's attempt ends before its host has shipped the attempt's last checkpoint.
	await reader.retainCheckpoints("root", { ids: [], prefixes: [] });
	await writer.commitCheckpoint(noted);
	await reader.catchUpWorkflow("root");
	assert.deepEqual(reader.getWorkflow("root"), writer.getWorkflow("root"));
});
