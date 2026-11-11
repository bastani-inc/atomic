import assert from "node:assert/strict";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function collectGarbage(): void {
	v8.setFlagsFromString("--expose-gc");
	try {
		const gc = vm.runInNewContext("gc") as () => void;
		for (let round = 0; round < 3; round++) gc();
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const TEXT_BYTES = 200_000;
const STAGES = 40;

async function openBackend(): Promise<JournalDurableBackend> {
	const dir = makeTempDirectory("journal-text-sharing-");
	cleanups.push(() => removeTempDirectory(dir));
	const database = await openNodeSqliteDatabase(join(dir, "journal.sqlite"));
	cleanups.push(() => database.close());
	const journal = await SqlRunJournal.open(database);
	cleanups.push(() => journal.close());
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	cleanups.push(() => backend.close());
	await backend.commitWorkflowRegistration({
		workflowId: "run",
		name: "test",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	return backend;
}

/**
 * A stage checkpoint whose output and result are long texts: the same text, two different texts, a text output with
 * no result, or a text result with an output that is not text.
 */
type StageTexts = "same" | "different" | "output only" | "result only";

function stageCheckpoint(index: number, result: StageTexts): DurableStageCheckpoint {
	const text = `${index}:${"r".repeat(TEXT_BYTES)}`;
	return {
		kind: "stage",
		workflowId: "run",
		checkpointId: `stage-${index}`,
		name: `stage-${index}`,
		replayKey: `stage:${index}`,
		output: result === "result only" ? { summary: `stage ${index}` } : text,
		...(result === "output only" ? {} : { result: result === "different" ? `${text}!` : text }),
		completedAt: index,
	};
}

/** Heap the backend adds while the caller, as the workflow store does, keeps every checkpoint it wrote. */
async function heapGrownByBackend(result: StageTexts, commits: "one by one" | "in a burst"): Promise<number> {
	const backend = await openBackend();
	collectGarbage();
	const before = process.memoryUsage().heapUsed;
	const written: DurableStageCheckpoint[] = [];
	const burst: Promise<void>[] = [];
	for (let index = 0; index < STAGES; index++) {
		const checkpoint = stageCheckpoint(index, result);
		written.push(checkpoint);
		if (commits === "one by one") await backend.commitCheckpoint(checkpoint);
		else burst.push(backend.commitCheckpoint(checkpoint));
	}
	await Promise.all(burst);
	collectGarbage();
	const grown = process.memoryUsage().heapUsed - before;
	assert.equal(backend.listCheckpoints("run").length, STAGES);
	assert.equal(written.length, STAGES);
	return grown;
}

for (const commits of ["one by one", "in a burst"] as const) {
	test(`a stage's result text is kept once for the writer and the journal projection together, committed ${commits} (#4642)`, async () => {
		const oneCopy = TEXT_BYTES * STAGES;
		const sameText = await heapGrownByBackend("same", commits);
		const twoTexts = await heapGrownByBackend("different", commits);

		assert.ok(sameText < oneCopy * 1.4, `the writer's text is the only copy: ${sameText} bytes for ${STAGES} stages`);
		assert.ok(twoTexts > oneCopy * 1.8, `a result that differs from the output is its own text: ${twoTexts} bytes`);
		assert.ok(twoTexts < oneCopy * 2.4, `and the writer's is the only copy of it too: ${twoTexts} bytes`);
	});
}

test("a stage's text is kept once when only its output or only its result is text (#4642)", async () => {
	const oneCopy = TEXT_BYTES * STAGES;
	for (const texts of ["output only", "result only"] as const) {
		const grown = await heapGrownByBackend(texts, "one by one");
		assert.ok(
			grown < oneCopy * 1.4,
			`${texts}: the writer's text is the only copy: ${grown} bytes for ${STAGES} stages`,
		);
	}
});

test("sharing stage text does not retain the writer's mutable output (#4642)", async () => {
	const backend = await openBackend();
	const output = { text: "saved", nested: { count: 1 } };
	const checkpoint = { ...stageCheckpoint(1, "different"), output };
	await backend.commitCheckpoint(checkpoint);
	output.text = "changed";
	output.nested.count = 2;
	const recorded = backend.listCheckpoints("run")[0] as DurableStageCheckpoint;
	assert.deepEqual(recorded.output, { text: "saved", nested: { count: 1 } });
	assert.equal(recorded.result, checkpoint.result);
});

test("a checkpoint reads back as written, whether or not its texts are shared (#4642)", async () => {
	const backend = await openBackend();
	const same = stageCheckpoint(1, "same");
	const different = stageCheckpoint(2, "different");
	await backend.commitCheckpoint(same);
	await backend.commitCheckpoint(different);
	const read = (id: string) => backend.listCheckpoints("run").find((checkpoint) => checkpoint.checkpointId === id);

	assert.equal((read("stage-1") as DurableStageCheckpoint).output, same.output);
	assert.equal((read("stage-1") as DurableStageCheckpoint).result, same.result);
	assert.equal((read("stage-2") as DurableStageCheckpoint).output, different.output);
	assert.equal((read("stage-2") as DurableStageCheckpoint).result, different.result);
});
