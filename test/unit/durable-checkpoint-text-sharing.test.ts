import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { describe, test } from "vitest";
import { createJournalProjection, normalizedCheckpoint } from "../../packages/workflows/src/durable/backend.js";
import type { DurableCheckpoint, DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";

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
const CHECKPOINTS = 40;

/** A stage checkpoint as a journal hands it back: every field decoded into a value of its own. */
function decodedStageCheckpoint(index: number, result: string): DurableStageCheckpoint {
	const text = `${index}:${"r".repeat(TEXT_BYTES)}`;
	return JSON.parse(
		JSON.stringify({
			kind: "stage",
			workflowId: "run",
			checkpointId: `stage-${index}`,
			name: `stage-${index}`,
			replayKey: `stage:${index}`,
			output: text,
			result: result === "same" ? text : `${text}!`,
			completedAt: index,
		}),
	);
}

function heapAfterFolding(result: "same" | "different"): number {
	collectGarbage();
	const before = process.memoryUsage().heapUsed;
	const projection = createJournalProjection();
	projection.registerWorkflow({ workflowId: "run", name: "w", inputs: {}, createdAt: 1, status: "running" });
	for (let index = 0; index < CHECKPOINTS; index++) projection.recordCheckpoint(decodedStageCheckpoint(index, result));
	collectGarbage();
	const grown = process.memoryUsage().heapUsed - before;
	assert.equal(projection.listCheckpoints("run").length, CHECKPOINTS);
	return grown;
}

describe("a stage checkpoint keeps the text of its result once (#4642)", () => {
	test("the output and the result of one stage take the memory of one string, not two", () => {
		const sameText = heapAfterFolding("same");
		const twoTexts = heapAfterFolding("different");
		const oneCopy = TEXT_BYTES * CHECKPOINTS;
		assert.ok(sameText < oneCopy * 1.5, `shared: ${sameText} bytes for ${CHECKPOINTS} stages of ${TEXT_BYTES}`);
		assert.ok(twoTexts > oneCopy * 1.8, `a result that differs from the output is kept as its own: ${twoTexts}`);
	});

	test("what the checkpoint reads back is unchanged, whether or not the texts are equal", () => {
		const equal = normalizedCheckpoint(decodedStageCheckpoint(1, "same"));
		assert.equal(equal.kind === "stage" && equal.result, equal.kind === "stage" && equal.output);
		const different = normalizedCheckpoint(decodedStageCheckpoint(2, "different")) as DurableStageCheckpoint;
		assert.notEqual(different.result, different.output);
		const structured: DurableCheckpoint = {
			kind: "stage",
			workflowId: "run",
			checkpointId: "s",
			name: "s",
			replayKey: "k",
			output: { value: 1 },
			result: "text",
			completedAt: 1,
		};
		assert.equal((normalizedCheckpoint(structured) as DurableStageCheckpoint).result, "text");
		assert.deepEqual((normalizedCheckpoint(structured) as DurableStageCheckpoint).output, { value: 1 });
	});
});
