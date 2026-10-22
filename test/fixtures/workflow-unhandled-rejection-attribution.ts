import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition, WorkflowRunContext } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { failElsewhere } from "./workflow-unhandled-rejection-foreign.js";
import { healthy } from "./workflow-unhandled-rejection-healthy.js";
import { scheduleUnrelatedRejection } from "./workflow-unhandled-rejection-unrelated.js";

type Branch = (ctx: WorkflowRunContext, index: number) => Promise<void>;

const [failure = "", poolStyle = "rolling", companion = "none"] = process.argv.slice(2);
const POOL_SIZE = 3;
const ITEMS = 6;
const missingFile = join(tmpdir(), `workflow-unhandled-rejection-${process.pid}`, "missing.tmp");

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

const branches: Record<string, Branch> = {
	"tool-string": async (ctx, index) => {
		await ctx.tool(`save-${index}`, { index }, async (): Promise<string> => {
			throw "boom-string";
		});
	},
	"tool-undefined": async (ctx, index) => {
		await ctx.tool(`save-${index}`, { index }, async (): Promise<string> => {
			throw undefined;
		});
	},
	"tool-number": async (ctx, index) => {
		await ctx.tool(`save-${index}`, { index }, async (): Promise<string> => {
			throw 4242;
		});
	},
	"tool-foreign-error": async (ctx, index) => {
		await ctx.tool(`save-${index}`, { index }, () => failElsewhere("tool"));
	},
	"author-error-after-workflow": async (ctx, index) => {
		await ctx.workflow(child, { inputs: { topic: `topic-${index}` } });
		throw new Error(`author error after child ${index}`);
	},
	"author-string-after-workflow": async (ctx, index) => {
		await ctx.workflow(child, { inputs: { topic: `topic-${index}` } });
		throw `author string after child ${index}`;
	},
	"fs-error-after-tool": async (ctx, index) => {
		await ctx.tool(`first-${index}`, { index }, async () => "first");
		await rename(missingFile, `${missingFile}.renamed`);
	},
	"helper-error-after-tool": async (ctx, index) => {
		await ctx.tool(`first-${index}`, { index }, async () => "first");
		await failElsewhere("helper");
	},
	"task-rejects": async (ctx, index) => {
		await ctx.task(`task-${index}`, { prompt: "do the work" });
	},
	"stage-rejects": async (ctx, index) => {
		await ctx.stage(`stage-${index}`).prompt("do the work");
	},
};

if (branches[failure] === undefined && failure !== "late-author-error") throw new Error(`unknown failure mode "${failure}"`);
const branch: Branch = branches[failure] ?? (async () => {});

const pool = workflow({
	name: "rolling-pool",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		const inFlight = new Map<number, Promise<void>>();
		let next = 0;
		while (next < ITEMS || inFlight.size > 0) {
			while (next < ITEMS && inFlight.size < POOL_SIZE) {
				const index = next++;
				const promise = branch(ctx, index);
				inFlight.set(index, promise);
				void promise.finally(() => inFlight.delete(index));
			}
			const settled = Promise.race(inFlight.values());
			await (poolStyle === "tolerant" ? settled.catch(() => {}) : settled);
		}
		return {};
	},
});

const lateAuthor = workflow({
	name: "late-author",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("first", {}, async () => "first");
		void (async () => {
			await delay(150);
			throw new Error("author error after the run ended");
		})();
		return {};
	},
});
const healthySameModule = workflow({
	name: "healthy-same-module",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await delay(300);
		await ctx.tool("healthy-work", {}, async () => "done");
		await delay(300);
		return {};
	},
});
const definition = failure === "late-author-error" ? lateAuthor : pool;
const companionDefinition = companion === "same-module" ? healthySameModule : healthy;

const options = async () => ({
	registry: createRegistry([definition, child, healthy, healthySameModule] as WorkflowDefinition[]),
	store: createStore(),
	durableBackend: await createMemoryTestBackend(),
	adapters: {
		prompt: {
			prompt: () => failElsewhere("prompt"),
		},
	},
});

const poolOptions = await options();
const healthyOptions = await options();
const poolRun = run(definition, {}, poolOptions);
const healthyRun = companion === "healthy" || companion === "same-module" ? run(companionDefinition, {}, healthyOptions) : undefined;
const result = await poolRun;
const healthyResult = await healthyRun;
await delay(failure === "late-author-error" ? 400 : 100);
const inspection = await inspectTargetedDurableWorkflow(poolOptions.durableBackend, result.runId);
console.log(
	JSON.stringify({
		status: result.status,
		error: result.error,
		inspected: inspection.kind === "found" ? { kind: inspection.kind, status: inspection.detail.status } : inspection,
		healthy: healthyResult === undefined ? undefined : { status: healthyResult.status, error: healthyResult.error },
	}),
);
if (companion === "unrelated") {
	scheduleUnrelatedRejection();
	await delay(100);
}
