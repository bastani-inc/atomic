import assert from "node:assert/strict";
import { test } from "vitest";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowArgumentCompletions } from "../../packages/workflows/src/extension/workflow-command-completions.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";

function completionFixture() {
	const store = createStore();
	const id = testRunId("completion-stage-slot");
	store.recordRunStart({
		id,
		name: "demo",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	const runtime = createExtensionRuntime({ store });
	return { id, complete: (partial: string) => workflowArgumentCompletions(partial, runtime, store) };
}

test.each(["resume", "pause"])("%s completes only the run argument, not the stage or message (#5224)", (command) => {
	const { id, complete } = completionFixture();
	for (const flags of command === "pause" ? ["", "--yes ", "-y "] : ["", "--accept-entry-changes "]) {
		const head = `${command} ${flags}`;
		assert.deepEqual(
			complete(`${head}${id.slice(0, 8)}`)?.map((item) => item.value),
			[`${head}${id} `],
		);
		for (const tail of [" ", ` ${id.slice(0, 2)}`, " plan ", " --"]) {
			assert.equal(complete(`${head}${id}${tail}`), null, `${head}${id}${tail}`);
		}
	}
	if (command === "pause") {
		assert.deepEqual(
			complete("pause --")?.map((item) => item.value),
			["pause --all ", "pause --yes "],
		);
	}
});

test("fork offers one run argument and one --from flag, never run IDs as stages (#5224)", () => {
	const { id, complete } = completionFixture();
	assert.deepEqual(
		complete(`fork ${id.slice(0, 8)}`)?.map((item) => item.value),
		[`fork ${id} `],
	);
	assert.deepEqual(
		complete(`fork ${id} `)?.map((item) => item.value),
		[`fork ${id} --from `],
	);
	assert.deepEqual(
		complete(`fork ${id} --f`)?.map((item) => item.value),
		[`fork ${id} --from `],
	);
	for (const partial of [
		`fork ${id} ${id.slice(0, 2)}`,
		`fork ${id} --from `,
		`fork ${id} --from ${id.slice(0, 2)}`,
		`fork ${id} --from plan `,
		`fork ${id} --from plan --f`,
		`fork ${id} --from=plan `,
		`fork ${id} --from=plan --f`,
		"fork --from ",
		"fork --from=",
	]) {
		assert.equal(complete(partial), null, partial);
	}
});
