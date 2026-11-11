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

function stageCheckpoint(index: number, result: "same" | "different"): DurableStageCheckpoint {
	const text = `${index}:${"r".repeat(TEXT_BYTES)}`;
	return {
		kind: "stage",
		workflowId: "run",
		checkpointId: `stage-${index}`,
		name: `stage-${index}`,
		replayKey: `stage:${index}`,
		output: text,
		result: result === "same" ? text : `${text}!`,
		completedAt: index,
	};
}

/** Heap the backend adds while the caller, as the workflow store does, keeps every checkpoint it wrote. */
async function heapGrownByBackend(result: "same" | "different", commits: "one by one" | "in a burst"): Promise<number> {
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
