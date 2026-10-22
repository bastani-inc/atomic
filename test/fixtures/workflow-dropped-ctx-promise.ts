import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageContext, WorkflowDefinition, WorkflowRunContext } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { healthy } from "./workflow-unhandled-rejection-healthy.js";

type Step = (ctx: WorkflowRunContext) => Promise<unknown>;

const [disposition = "", call = "", companion = "none"] = process.argv.slice(2);
const caught: string[] = [];

const failingChild = workflow({
	name: "failing-child",
	description: "",
	inputs: {},
	outputs: {},
	run: async () => {
		throw new Error("child workflow body failed");
	},
});

const model = {} as Parameters<StageContext["setModel"]>[0];

const calls: Record<string, readonly Step[]> = {
	task: [(ctx) => ctx.task("task-call", { prompt: "do the work" })],
	"stage-prompt": [(ctx) => ctx.stage("stage-call").prompt("do the work")],
	"stage-methods": [
		(ctx) => ctx.stage("stage-steer").steer("more"),
		(ctx) => ctx.stage("stage-follow-up").followUp("more"),
		(ctx) => ctx.stage("stage-send-user-message").sendUserMessage("more"),
		(ctx) => ctx.stage("stage-set-model").setModel(model),
		(ctx) => ctx.stage("stage-set-thinking-level").setThinkingLevel("low"),
		(ctx) => ctx.stage("stage-cycle-model").cycleModel(),
		(ctx) => Promise.resolve(ctx.stage("stage-cycle-thinking-level").cycleThinkingLevel()),
		(ctx) => ctx.stage("stage-navigate-tree").navigateTree("entry"),
		(ctx) => ctx.stage("stage-compact").compact(),
	],
	chain: [(ctx) => ctx.chain([{ name: "chain-call", task: "do the work" }])],
	parallel: [(ctx) => ctx.parallel([{ name: "parallel-call", task: "do the work" }])],
	workflow: [(ctx) => ctx.workflow(failingChild)],
};

const steps = calls[call];
if (steps === undefined || (disposition !== "dropped" && disposition !== "handled")) {
	throw new Error(`unknown mode "${disposition}:${call}"`);
}

const definition = workflow({
	name: "dropped-ctx-promise",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		for (const step of steps) {
			if (disposition === "dropped") {
				void step(ctx);
				continue;
			}
			try {
				await step(ctx);
			} catch (error) {
				caught.push(error instanceof Error ? error.message : String(error));
			}
		}
		await delay(200);
		return {};
	},
});

const options = async () => ({
	registry: createRegistry([definition, failingChild, healthy] as WorkflowDefinition[]),
	store: createStore(),
	durableBackend: await createMemoryTestBackend(),
	adapters: {
		prompt: {
			prompt: async (): Promise<string> => {
				throw new Error("prompt adapter failed");
			},
		},
	},
});

const droppingOptions = await options();
const healthyOptions = await options();
const droppingRun = run(definition, {}, droppingOptions);
const healthyRun = companion === "healthy" ? run(healthy, {}, healthyOptions) : undefined;
const result = await droppingRun;
const healthyResult = await healthyRun;
await delay(100);
const inspection = await inspectTargetedDurableWorkflow(droppingOptions.durableBackend, result.runId);
console.log(
	JSON.stringify({
		status: result.status,
		error: result.error,
		caught,
		inspected: inspection.kind === "found" ? { kind: inspection.kind, status: inspection.detail.status } : inspection,
		healthy: healthyResult === undefined ? undefined : { status: healthyResult.status, error: healthyResult.error },
	}),
);
