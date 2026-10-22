import { mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { scheduleUnrelatedRejection } from "./workflow-unhandled-rejection-unrelated.js";

const mode = process.argv[2];
const POOL_SIZE = 5;
const ITEMS = 12;
const directory = join(tmpdir(), `workflow-tool-rejection-pool-${process.pid}`);
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "x.tmp"), "payload");

const child = workflow({
	name: "child",
	description: "",
	inputs: { topic: Type.String() },
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("child-work", { topic: ctx.inputs.topic }, async () => "done");
		return {};
	},
});

const renameTemporaryFile = async (): Promise<string> => {
	await rename(join(directory, "x.tmp"), join(directory, "x"));
	return "saved";
};

const afterRunStopped = Promise.withResolvers<void>();
const rollingPool = workflow({
	name: "rolling-pool",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		const inFlight = new Map<number, Promise<void>>();
		const branch = async (index: number): Promise<void> => {
			await ctx.workflow(child, { inputs: { topic: `topic-${index}` } });
			await ctx.tool(`save-${index}`, { index }, renameTemporaryFile);
		};
		let next = 0;
		while (next < ITEMS || inFlight.size > 0) {
			while (next < ITEMS && inFlight.size < POOL_SIZE) {
				const index = next++;
				const promise = branch(index);
				inFlight.set(index, promise);
				void promise.finally(() => inFlight.delete(index));
			}
			await Promise.race(inFlight.values());
		}
		return {};
	},
});
const lateAdmission = workflow({
	name: "late-admission",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("first", {}, async () => "first");
		void (async () => {
			await afterRunStopped.promise;
			await ctx.tool("late-save", {}, async () => "late");
		})();
		return {};
	},
});
const handledFailure = workflow({
	name: "handled-failure",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await rename(join(directory, "x.tmp"), join(directory, "x"));
		try {
			await ctx.tool("save", {}, renameTemporaryFile);
		} catch {}
		return {};
	},
});

const definition = mode === "late-admission" ? lateAdmission : mode === "unrelated-rejection" ? handledFailure : rollingPool;
const result = await run(
	definition,
	{},
	{
		registry: createRegistry([definition, child] as WorkflowDefinition[]),
		store: createStore(),
		durableBackend: await createMemoryTestBackend(),
	},
);
afterRunStopped.resolve();
await delay(100);
console.log(JSON.stringify({ status: result.status, error: result.error }));
if (mode === "unrelated-rejection") {
	scheduleUnrelatedRejection();
	await delay(100);
}
