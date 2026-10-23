import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

test("concurrent durable child boundaries keep their own scope while a run budget is checked (#3869)", async () => {
	const directory = makeTempDirectory("concurrent-child-budget-");
	const backend = await JournalDurableBackend.open(
		await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
	);
	try {
		const child = workflow({
			name: "budgeted-child",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.tool("noop", {}, async () => 1);
				return {};
			},
		});
		const parent = workflow({
			name: "budgeted-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await Promise.all(Array.from({ length: 3 }, () => ctx.workflow(child)));
				return {};
			},
		});
		const result = await run(
			parent,
			{},
			{
				runId: "root",
				cwd: directory,
				store: createStore(),
				durableBackend: backend,
				budget: { maxTokens: 100 },
			},
		);
		assert.equal(result.status, "completed", JSON.stringify(result));
		const keys = result.stages.map((stage) => stage.replayKey).sort();
		assert.equal(keys.length, 3);
		assert.ok(
			keys.every((key, index) => key === `workflow:workflow:budgeted-child:${key?.split(":")[3]}:${index + 1}`),
			`every child boundary must use its durable scope, got ${JSON.stringify(keys)}`,
		);
	} finally {
		await backend.close();
		removeTempDirectory(directory);
	}
});
