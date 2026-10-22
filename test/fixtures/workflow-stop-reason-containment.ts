import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { cancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { killRun, pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition, WorkflowRunContext } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { abortFromTimer } from "./workflow-stop-reason-abort.js";
import { healthy } from "./workflow-unhandled-rejection-healthy.js";

type Call = (ctx: WorkflowRunContext, index: number) => unknown;

const [stop = "", call = "", timing = "after", companion = "none"] = process.argv.slice(2);
const POOL_SIZE = 3;
const ITEMS = 6;
const release = Promise.withResolvers<void>();
const started = Promise.withResolvers<void>();

const child = workflow({
	name: "stop-child",
	description: "",
	inputs: {},
	outputs: {},
	run: async () => ({}),
});

const calls: Record<string, Call> = {
	stage: (ctx, index) => ctx.stage(`late-stage-${index}`),
	task: (ctx, index) => ctx.task(`late-task-${index}`, { prompt: "do the work" }),
	workflow: (ctx) => ctx.workflow(child),
	exit: (ctx) => ctx.exit({ reason: "pool finished early", outputs: {} }),
	ui: (ctx) => ctx.ui.confirm("proceed?"),
};

const late = calls[call];
if (late === undefined) throw new Error(`unknown call "${call}"`);

const pool = workflow({
	name: "stop-pool",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		const inFlight = new Map<number, Promise<void>>();
		let next = 0;
		while (next < ITEMS || inFlight.size > 0) {
			while (next < ITEMS && inFlight.size < POOL_SIZE) {
				const index = next++;
				const promise = (async () => {
					started.resolve();
					await release.promise;
					await late(ctx, index);
				})();
				inFlight.set(index, promise);
				void promise.finally(() => inFlight.delete(index));
			}
			await Promise.race(inFlight.values());
		}
		return {};
	},
});

const nestedParent = workflow({
	name: "stop-parent",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.workflow(pool);
		return {};
	},
});

const definition = (stop === "kill-nested" ? nestedParent : pool) as WorkflowDefinition;

const options = async () => ({
	registry: createRegistry([definition, pool, child, healthy] as WorkflowDefinition[]),
	store: createStore(),
	durableBackend: await createMemoryTestBackend(),
});

const poolOptions = await options();
const healthyOptions = await options();
const runId = crypto.randomUUID();
const controller = new AbortController();

const startPool = (): Promise<RunResult> => {
	if (stop === "kill-detached") {
		const settled = Promise.withResolvers<RunResult>();
		runDetached(definition, {}, {
			...poolOptions,
			runId,
			cancellation: cancellationRegistry,
			onRawSettled: (_ok, result, error) => {
				if (result !== undefined) settled.resolve(result);
				else settled.reject(error);
			},
		});
		return settled.promise;
	}
	return run(definition, {}, {
		...poolOptions,
		runId,
		cancellation: cancellationRegistry,
		...(stop === "caller-abort" ? { signal: controller.signal } : {}),
	});
};

const requestStop = async (): Promise<void> => {
	if (stop === "kill" || stop === "kill-detached" || stop === "kill-nested") {
		await killRun(runId, { store: poolOptions.store, cancellation: cancellationRegistry });
	} else if (stop === "quit") {
		await quitRun(runId, { store: poolOptions.store });
	} else if (stop === "caller-abort") {
		await abortFromTimer(controller);
	} else if (stop === "paused-exit" || stop === "paused-exit-then-kill") {
		await pauseRun(runId, { store: poolOptions.store });
	} else {
		throw new Error(`unknown stop "${stop}"`);
	}
};

const healthyRun = companion === "healthy" ? run(healthy, {}, healthyOptions) : undefined;
const pending = startPool();
await started.promise;
if (timing === "before") {
	release.resolve();
	await delay(100);
}
const stopping = requestStop();
if (timing === "during") release.resolve();
await stopping;
if (stop === "paused-exit" || stop === "paused-exit-then-kill") {
	release.resolve();
	await delay(200);
	if (stop === "paused-exit") await resumeRun(runId, { store: poolOptions.store });
	else await killRun(runId, { store: poolOptions.store, cancellation: cancellationRegistry });
}
const result = await pending;
if (timing === "after" || timing === "late") {
	await delay(100);
	if (timing === "late") {
		const realNow = Date.now;
		Date.now = () => realNow() + 60_000;
	}
	release.resolve();
}
const healthyResult = await healthyRun;
await delay(300);
const inspection = await inspectTargetedDurableWorkflow(poolOptions.durableBackend, result.runId);
console.log(
	JSON.stringify({
		status: result.status,
		error: result.error,
		exited: result.exited,
		exitReason: result.exitReason,
		storeStatus: poolOptions.store.runs().find((entry) => entry.id === runId)?.status,
		inspected: inspection.kind === "found" ? { kind: inspection.kind, status: inspection.detail.status } : inspection,
		healthy: healthyResult === undefined ? undefined : { status: healthyResult.status, error: healthyResult.error },
	}),
);
