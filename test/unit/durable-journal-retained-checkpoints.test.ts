import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	type CheckpointSelection,
	JournalDurableBackend,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { JournalEntry, RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * A local worker reads the root run, which holds the checkpoints of every pooled child, and keeps in memory only the
 * checkpoints of the child it runs (#4197). These tests check that a backend narrowed that way reads like one that
 * keeps every checkpoint, restricted to the selected ones, over a SQL journal (read through its key index) and over a
 * journal without one (read in full).
 */

const ROOT = "root";

/** The selection a worker narrows the root to for the child of `scope`. */
function child(scope: string): CheckpointSelection {
	return { ids: [`boundary-start:${scope}`], prefixes: [`${scope}:`, `boundary-terminal:${scope}:`] };
}

function selected(selection: CheckpointSelection, checkpoint: DurableCheckpoint): boolean {
	return (
		selection.ids.includes(checkpoint.checkpointId) ||
		selection.prefixes.some((prefix) => checkpoint.checkpointId.startsWith(prefix))
	);
}

let clock = 1_000;

function tool(id: string, output = `output of ${id}`): DurableCheckpoint {
	return { kind: "tool", workflowId: ROOT, checkpointId: id, name: id, argsHash: id, output, completedAt: clock++ };
}

function ui(id: string, promptHash: string, response: string): DurableCheckpoint {
	return {
		kind: "ui",
		workflowId: ROOT,
		checkpointId: id,
		promptKind: "input",
		message: promptHash,
		promptHash,
		response,
		completedAt: clock++,
	};
}

function stage(id: string, replayKey: string, output: string): DurableCheckpoint {
	return { kind: "stage", workflowId: ROOT, checkpointId: id, name: id, replayKey, output, completedAt: clock++ };
}

/** Checkpoints of two children and of the root itself, as the root's journal interleaves them. */
function childCheckpoints(scope: string): DurableCheckpoint[] {
	return [
		stage(`boundary-start:${scope}`, scope, "start"),
		tool(`${scope}:tool:a`),
		// The same prompt answered twice: the later answer is the one a replay reads.
		ui(`${scope}:ui:2`, `${scope}:prompt`, "first answer"),
		ui(`${scope}:ui:10`, `${scope}:prompt`, "second answer"),
		stage(`${scope}:stage:s`, `${scope}:s`, `stage output of ${scope}`),
	];
}

interface Harness {
	readonly writer: JournalDurableBackend;
	readonly open: () => Promise<{ readonly backend: JournalDurableBackend; readonly reads: number[] }>;
	readonly close: () => Promise<void>;
}

/** Counts the events each full read of the run returns, so a test sees whether narrowing read the whole run. */
function countReads(journal: RunJournal): number[] {
	const read = journal.read.bind(journal);
	const reads: number[] = [];
	journal.read = async function* (runId: string, fromSeq?: number): AsyncIterable<JournalEntry> {
		const index = reads.push(0) - 1;
		for await (const entry of read(runId, fromSeq)) {
			reads[index]!++;
			yield entry;
		}
	};
	return reads;
}

const harnesses: Record<string, () => Promise<Harness>> = {
	async sql() {
		const directory = makeTempDirectory("journal-retained-checkpoints-");
		const path = join(directory, "journal.sqlite");
		const writer = await JournalDurableBackend.open(await openSqlRunJournal(path));
		const opened: JournalDurableBackend[] = [];
		const closers: (() => Promise<void>)[] = [];
		return {
			writer,
			async open() {
				const journal: SqlRunJournal = await openSqlRunJournal(path);
				const reads = countReads(journal);
				// The journal with its key index, as a local worker's read-only view of a SQL journal provides it.
				const indexed = Object.assign(Object.create(journal) as SqlRunJournal, {
					readKeyRange: (runId: string, fromKey: string, toKey: string) =>
						SqlRunJournal.readKeyRange(journal, runId, fromKey, toKey),
				});
				const backend = await JournalDurableBackend.open(indexed, { runs: [], ownsJournal: false });
				opened.push(backend);
				closers.push(() => journal.close());
				return { backend, reads };
			},
			async close() {
				for (const backend of opened) await backend.close();
				for (const close of closers) await close();
				await writer.close();
				removeTempDirectory(directory);
			},
		};
	},
	async memory() {
		const journal = new MemoryRunJournal();
		const writer = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const opened: JournalDurableBackend[] = [];
		return {
			writer,
			async open() {
				// Its own view of the shared journal, so counting its reads leaves the writer's alone.
				const view = Object.create(journal) as RunJournal;
				const reads = countReads(view);
				const backend = await JournalDurableBackend.open(view, { runs: [], ownsJournal: false });
				opened.push(backend);
				return { backend, reads };
			},
			async close() {
				for (const backend of opened) await backend.close();
				await writer.close();
				await journal.close();
			},
		};
	},
};

let harness: Harness | undefined;
afterEach(async () => {
	await harness?.close();
	harness = undefined;
});

async function record(writer: JournalDurableBackend, checkpoints: readonly DurableCheckpoint[]): Promise<void> {
	for (const checkpoint of checkpoints) await writer.commitCheckpoint(checkpoint);
}

async function setUp(kind: string): Promise<Harness> {
	harness = await harnesses[kind]!();
	await harness.writer.commitWorkflowRegistration({
		workflowId: ROOT,
		name: ROOT,
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	return harness;
}

/** What a backend that keeps every checkpoint reads, restricted to `selection`. */
async function expected(selection: CheckpointSelection) {
	const { backend } = await harness!.open();
	await backend.catchUpWorkflow(ROOT);
	return {
		handle: backend.getWorkflow(ROOT),
		checkpoints: backend.listCheckpoints(ROOT).filter((checkpoint) => selected(selection, checkpoint)),
		outputs: (scope: string) => ({
			tool: backend.getToolOutput(ROOT, `${scope}:tool:a`),
			ui: backend.getUiResponse(ROOT, `${scope}:prompt`),
			stage: backend.getStageOutput(ROOT, `${scope}:s`),
		}),
	};
}

function reads(backend: JournalDurableBackend, scope: string) {
	return {
		tool: backend.getToolOutput(ROOT, `${scope}:tool:a`),
		ui: backend.getUiResponse(ROOT, `${scope}:prompt`),
		stage: backend.getStageOutput(ROOT, `${scope}:s`),
	};
}

for (const kind of Object.keys(harnesses)) {
	describe(`over a ${kind} journal`, () => {
		test("a backend narrowed to one child keeps only that child's checkpoints, read as a full fold reads them (#4197)", async () => {
			const { writer, open } = await setUp(kind);
			// `child:a:1` is a prefix of `child:a:10`, whose checkpoints are another child's.
			await record(writer, [tool("root-step"), ...childCheckpoints("child:a:1"), ...childCheckpoints("child:a:10")]);
			const { backend } = await open();
			await backend.retainCheckpoints(ROOT, child("child:a:1"));
			await backend.catchUpWorkflow(ROOT);
			const full = await expected(child("child:a:1"));
			assert.deepEqual(backend.listCheckpoints(ROOT), full.checkpoints);
			assert.deepEqual(reads(backend, "child:a:1"), full.outputs("child:a:1"));
			assert.equal(reads(backend, "child:a:1").ui, "second answer");
			assert.deepEqual(reads(backend, "child:a:10"), { tool: undefined, ui: undefined, stage: undefined });
			assert.equal(backend.getToolOutput(ROOT, "root-step"), undefined);
			// The run's handle still counts every checkpoint, as a backend that keeps them all does.
			assert.deepEqual(backend.getWorkflow(ROOT), full.handle);
		});

		test("narrowing to another child reads that child's earlier checkpoints back and lets the previous child's go (#4197)", async () => {
			const { writer, open } = await setUp(kind);
			await record(writer, [...childCheckpoints("child:a:1"), ...childCheckpoints("child:b:1")]);
			const { backend, reads: journalReads } = await open();
			await backend.retainCheckpoints(ROOT, child("child:a:1"));
			await backend.catchUpWorkflow(ROOT);
			const fullReadsBefore = journalReads.length;
			// The child of `child:b:1` replays on this backend: what it recorded on another attempt is read back.
			await backend.retainCheckpoints(ROOT, child("child:b:1"));
			const full = await expected(child("child:b:1"));
			assert.deepEqual(backend.listCheckpoints(ROOT), full.checkpoints);
			assert.deepEqual(reads(backend, "child:b:1"), full.outputs("child:b:1"));
			assert.equal(reads(backend, "child:b:1").ui, "second answer", "answers are read back in the order recorded");
			assert.deepEqual(reads(backend, "child:a:1"), { tool: undefined, ui: undefined, stage: undefined });
			assert.deepEqual(backend.getWorkflow(ROOT), full.handle);
			if (kind === "sql")
				assert.equal(journalReads.length, fullReadsBefore, "a SQL journal reads the child through its key index");
			else assert.equal(journalReads.length, fullReadsBefore + 1, "a journal without a key index is read once");
			// What the child records next is folded in as the root goes on; another child's checkpoints are not.
			await record(writer, [tool("child:b:1:tool:later"), tool("child:a:1:tool:later")]);
			await backend.catchUpWorkflow(ROOT);
			assert.equal(backend.getToolOutput(ROOT, "child:b:1:tool:later"), "output of child:b:1:tool:later");
			assert.equal(backend.getToolOutput(ROOT, "child:a:1:tool:later"), undefined);
			assert.deepEqual(backend.getWorkflow(ROOT), (await expected(child("child:b:1"))).handle);
		});

		test("a backend narrowed to no checkpoints keeps none and reads nothing back (#4197)", async () => {
			const { writer, open } = await setUp(kind);
			await record(writer, childCheckpoints("child:a:1"));
			const { backend, reads: journalReads } = await open();
			await backend.retainCheckpoints(ROOT, child("child:a:1"));
			await backend.catchUpWorkflow(ROOT);
			const fullReadsBefore = journalReads.length;
			await backend.retainCheckpoints(ROOT, { ids: [], prefixes: [] });
			assert.deepEqual(backend.listCheckpoints(ROOT), []);
			assert.equal(journalReads.length, fullReadsBefore);
			assert.deepEqual(backend.getWorkflow(ROOT), (await expected(child("child:a:1"))).handle);
		});
	});
}
