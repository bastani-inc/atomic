import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { expireWorkflowLease } from "../helpers/workflow-lease.js";

const [mode, directory] = process.argv.slice(2);
assert.ok(directory);
const runId = "cached-stage-restart";
const path = join(directory, "journal.sqlite");
if (mode === "resume") expireWorkflowLease(path, runId);
const journal = await openSqlRunJournal(path);
const backend = await JournalDurableBackend.open(journal);
const replayMetadata = () => backend.listCheckpoints(runId).filter((entry) => entry.checkpointId.startsWith("stage-replay-meta:"));
if (mode === "resume") assert.equal(replayMetadata().length, 1);
const definition = workflow({
	name: "cached-stage-restart",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("once", {}, async () => {
			await appendFile(join(directory, "effects.txt"), "once\n");
			return "saved";
		});
		const cached = ctx.stage("cached");
		assert.equal(typeof cached.prompt, "function");
		if (mode === "seed") await cached.complete("saved");
		await ctx.tool("barrier", {}, async () => {
			await appendFile(join(directory, "effects.txt"), "barrier\n");
			return "barrier";
		});
		if (mode === "cached") {
			assert.equal(replayMetadata().length, 1);
			await writeFile(join(directory, "cached-ready"), "ready");
			await new Promise<void>(() => { setInterval(() => {}, 1000); });
		}
		return {};
	},
});
try {
	const result = await run(definition, {}, {
		runId,
		cwd: directory,
		store: createStore(),
		durableBackend: backend,
		adapters: { complete: { complete: async (text) => text } },
	});
	assert.equal(result.status, "completed", JSON.stringify(result));
	if (mode === "resume") assert.equal(replayMetadata().length, 1);
} finally {
	await backend.close();
}
