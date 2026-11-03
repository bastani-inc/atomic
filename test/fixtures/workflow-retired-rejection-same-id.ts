import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const DURABLE_RUN_ID = "retired-rejection-same-id";
const RETIRED_FAILURE = "retired listener failure";
const PAST_ENDED_RUN_GRACE_MS = 60_000;
const OBSERVATION_TIMEOUT_MS = 10_000;
const [abortTiming = "within-grace"] = process.argv.slice(2);

const controllersOfFirstRun: AbortController[] = [];
let capturing = true;
const NativeAbortController = globalThis.AbortController;
globalThis.AbortController = class extends NativeAbortController {
	constructor() {
		super();
		if (capturing) controllersOfFirstRun.push(this);
	}
};

let retiredRejections = 0;
const retiredRejectionObserved = Promise.withResolvers<void>();
process.on("unhandledRejection", (reason) => {
	if (!(reason instanceof Error) || reason.message !== RETIRED_FAILURE) return;
	retiredRejections += 1;
	retiredRejectionObserved.resolve();
});

const retiring = workflow({
	name: "retiring",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("leave-listener", {}, async ({ signal }) => {
			signal.addEventListener("abort", () => {
				void Promise.reject(new Error(RETIRED_FAILURE));
			});
			return "done";
		});
		return {};
	},
});

const replacementStarted = Promise.withResolvers<void>();
const replacementGate = Promise.withResolvers<void>();
const replacement = workflow({
	name: "replacement",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("wait-for-gate", {}, async () => {
			replacementStarted.resolve();
			await replacementGate.promise;
			return "released";
		});
		return {};
	},
});

async function start(definition: WorkflowDefinition) {
	return run(
		definition,
		{},
		{
			runId: DURABLE_RUN_ID,
			registry: createRegistry([definition]),
			store: createStore(),
			durableBackend: await createMemoryTestBackend(),
		},
	);
}

const first = await start(retiring as WorkflowDefinition);
capturing = false;
const secondRun = start(replacement as WorkflowDefinition);
await replacementStarted.promise;
if (abortTiming === "after-grace") {
	const realNow = Date.now;
	Date.now = () => realNow() + PAST_ENDED_RUN_GRACE_MS;
}
for (const controller of controllersOfFirstRun) controller.abort(new Error("retired execution aborted"));
const observationTimedOut = Promise.withResolvers<void>();
const observationTimer = setTimeout(observationTimedOut.resolve, OBSERVATION_TIMEOUT_MS);
await Promise.race([retiredRejectionObserved.promise, observationTimedOut.promise]);
clearTimeout(observationTimer);
await delay(100);
replacementGate.resolve();
const second = await secondRun;
await delay(100);
console.log(
	JSON.stringify({
		retiredRejections,
		first: { status: first.status, error: first.error },
		replacement: { status: second.status, error: second.error },
	}),
);
