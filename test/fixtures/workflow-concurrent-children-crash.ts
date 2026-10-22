import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { initializeDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";
import { expireWorkflowLease } from "../helpers/workflow-lease.js";

const [mode, directory] = process.argv.slice(2);
assert.ok(directory);
const POOL_SIZE = 5;
const runId = "318af3df-df3d-4c59-8ad4-ae7159f237fb";
process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = join(directory, "journal.sqlite");
if (mode === "resume") expireWorkflowLease(process.env.ATOMIC_WORKFLOW_JOURNAL_PATH, runId);
const backend = await initializeDurableBackend();
assert.ok(backend instanceof JournalDurableBackend);
const store = createStore();

const child = workflow({
	name: "child",
	description: "",
	inputs: { topic: Type.String() },
	outputs: {},
	async run(ctx) {
		await ctx.tool("child-work", { topic: ctx.inputs.topic }, async () => {
			await appendFile(join(directory, "children.txt"), `${ctx.inputs.topic}\n`);
			if (mode === "start") await new Promise<void>(() => setInterval(() => {}, 1000));
			return "done";
		});
		return {};
	},
});
const definition = workflow({
	name: "rolling-pool",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const inFlight = new Map<number, Promise<void>>();
		for (let index = 0; index < POOL_SIZE; index++) {
			const branch = async (): Promise<void> => {
				await ctx.workflow(child, { inputs: { topic: `topic-${index}` } });
				await ctx.tool(`save-${index}`, { index }, async () => {
					await appendFile(join(directory, "saves.txt"), `${index}\n`);
					return "saved";
				});
			};
			inFlight.set(index, branch().finally(() => inFlight.delete(index)));
		}
		while (inFlight.size > 0) await Promise.race(inFlight.values());
		return {};
	},
});

const describeInspection = async (): Promise<{ kind: string; status?: string; childRuns?: number }> => {
	const inspected = await inspectTargetedDurableWorkflow(backend, runId);
	if (inspected.kind !== "found") return { kind: inspected.kind };
	return {
		kind: inspected.kind,
		status: inspected.detail.status,
		childRuns: inspected.runs.filter((candidate) => candidate.parentRunId === runId).length,
	};
};

if (mode === "start") {
	void run(definition, {}, { runId, cwd: directory, store, modelOwner: "concurrent-children-fixture" });
	const deadline = Date.now() + 30_000;
	for (;;) {
		const started = (await readFile(join(directory, "children.txt"), "utf8").catch(() => "")).trim().split("\n");
		if (started.filter(Boolean).length >= POOL_SIZE) break;
		assert.ok(Date.now() < deadline, "children did not start");
		await sleep(20);
	}
	await writeFile(join(directory, "ready"), "ready");
	await new Promise<void>(() => setInterval(() => {}, 1000));
} else {
	const inspected = await describeInspection();
	if (mode === "resume") {
		const runtime = createExtensionRuntime({ definitions: [definition, child] as WorkflowDefinition[], cwd: directory, store });
		const resumed = await runtime.resumeDurableWorkflow(runId);
		assert.ok(resumed.ok, JSON.stringify(resumed));
		const deadline = Date.now() + 30_000;
		while (store.runs().find((entry) => entry.id === runId)?.endedAt === undefined) {
			assert.ok(Date.now() < deadline, "resumed workflow did not settle");
			await sleep(20);
		}
		console.log(JSON.stringify({ inspected, resumed: store.runs().find((entry) => entry.id === runId)?.status }));
	} else {
		console.log(JSON.stringify({ inspected }));
	}
	await backend.close();
}
