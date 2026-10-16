import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { initializeDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { sleep } from "../helpers/runtime.js";
import { expireWorkflowLease } from "../helpers/workflow-lease.js";

const [mode, directory] = process.argv.slice(2);
assert.ok(directory);
const runId = "218af3df-df3d-4c59-8ad4-ae7159f237fb";
process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = join(directory, "journal.sqlite");
if (mode === "resume") expireWorkflowLease(process.env.ATOMIC_WORKFLOW_JOURNAL_PATH, runId);
const backend = await initializeDurableBackend();
assert.ok(backend instanceof JournalDurableBackend);
const store = createStore();
const definition = workflow({
	name: "journal-process-restart",
	description: "Checkpoint restart fixture",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const value = await ctx.tool("saved-effect", { raw: "  value\n", values: [2, 1, 2] }, async () => {
			await appendFile(join(directory, "effects.txt"), "effect\n");
			return { raw: "  value\n", values: [2, 1, 2] };
		});
		assert.deepEqual(value, { raw: "  value\n", values: [2, 1, 2] });
		if (mode === "start" || mode === "pause-exit") {
			await writeFile(join(directory, "checkpoint-ready"), "ready");
			await new Promise<void>(() => {
				if (mode === "start") setInterval(() => {}, 1000);
			});
		}
		await ctx.stage("finished-stage").prompt("finish");
		return {};
	},
});
const adapters = {
	prompt: {
		async prompt() {
			await appendFile(join(directory, "stages.txt"), "stage\n");
			return "done";
		},
	},
};
if (mode === "pause-exit") {
	const execution = run(definition, {}, { runId, cwd: directory, store, adapters });
	while (backend.getWorkflow(runId)?.completedCheckpoints !== 1) await sleep(10);
	assert.equal((await quitRun(runId, { store })).ok, true);
	assert.equal((await execution).status, "paused");
	assert.equal(backend.getWorkflow(runId)?.modelOwner, undefined);
} else if (mode === "start") {
	await run(definition, {}, { runId, cwd: directory, store, adapters, modelOwner: "restart-fixture" });
} else {
	const runtime = createExtensionRuntime({ definitions: [definition], cwd: directory, store, adapters });
	const resumed = await runtime.resumeDurableWorkflow(runId);
	if (mode === "live") {
		assert.ok(!resumed.ok);
		assert.equal(resumed.reason, "owned_elsewhere");
	} else {
		assert.ok(resumed.ok, JSON.stringify(resumed));
		const deadline = Date.now() + 15_000;
		while (store.runs().find((entry) => entry.id === runId)?.endedAt === undefined) {
			assert.ok(Date.now() < deadline, "resumed workflow did not settle");
			await sleep(10);
		}
		const completed = store.runs().find((entry) => entry.id === runId);
		assert.equal(completed?.status, "completed", JSON.stringify(completed));
		assert.ok(backend.listCheckpoints(runId).some((entry) => entry.kind === "stage"));
	}
	await backend.close();
	console.log(JSON.stringify(resumed));
}
