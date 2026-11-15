import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { durableForkPoints, forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowResumeAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { sleep } from "../helpers/runtime.js";
import { configureCurrentTestStoreBackend } from "../helpers/store-backend.js";

/**
 * A fork resumes as a run cut at its fork point's first record. Each of its stages, the fork point included, keeps the
 * parents it has in the source: a stage that ran in parallel with an earlier replayed one does not take that one as its
 * parent, and the stage that joins them keeps both (#5042).
 */

afterEach(() => {
	store.clear();
	configureCurrentTestStoreBackend(undefined);
});

type Shape = "stages" | "tasks" | "tools" | "tool-then-stages" | "child-stages" | "child-tools" | "beside-child";
let failing: string | undefined;

function definitions(shape: Shape) {
	const tool = (ctx: any, name: string) =>
		ctx.tool(name, {}, async () => {
			if (failing === name) throw new Error(`planned ${name} failure`);
			return name;
		});
	// `start → [a ‖ b] → finish → c`: by stages, by tasks, by tools around stages created in parallel, or with both stages created
	// before the tool `start` (#4888).
	const body = async (ctx: any, kind: string) => {
		if (kind === "tasks") {
			await ctx.task("start", { prompt: "start" });
			await Promise.all([ctx.task("a", { prompt: "a" }), ctx.task("b", { prompt: "b" })]);
			await ctx.task("finish", { prompt: "finish" });
		} else if (kind === "tool-then-stages") {
			await tool(ctx, "start");
			await Promise.all([ctx.stage("a").prompt("a"), ctx.stage("b").prompt("b")]);
			await tool(ctx, "finish");
		} else if (kind === "stages") {
			await ctx.stage("start").prompt("start");
			await Promise.all([ctx.stage("a").prompt("a"), ctx.stage("b").prompt("b")]);
			await ctx.stage("finish").prompt("finish");
		} else {
			const a = ctx.stage("a");
			const b = ctx.stage("b");
			await tool(ctx, "start");
			await Promise.all([a.prompt("a"), b.prompt("b")]);
			await tool(ctx, "finish");
		}
		await ctx.stage("c").prompt("c");
	};
	const child = workflow({
		name: "fork-parents-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await body(ctx, shape === "beside-child" ? "stages" : shape.replace("child-", ""));
			return {};
		},
	});
	const parent = workflow({
		name: "fork-parents",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			if (shape === "beside-child") {
				// `s0 → [a ‖ child] → z0`: the child workflow's boundary is a fork point beside a stage.
				await ctx.stage("s0").prompt("s0");
				await Promise.all([ctx.stage("a").prompt("a"), ctx.workflow(child, {})]);
				await ctx.stage("z0").prompt("z0");
			} else if (shape.startsWith("child-")) {
				await ctx.stage("s0").prompt("s0");
				await ctx.workflow(child, {});
				await ctx.stage("z0").prompt("z0");
			} else await body(ctx, shape);
			return {};
		},
	});
	const runtime = createExtensionRuntime({
		store,
		registry: createRegistry([parent, child]),
		adapters: {
			prompt: {
				prompt: async (text) => {
					await sleep(1);
					if (failing === text) throw new Error(`planned ${text} failure`);
					return text;
				},
			},
		},
	});
	return { parent, runtime };
}

async function settled(runId: string): Promise<RunSnapshot | undefined> {
	for (let attempt = 0; attempt < 1500; attempt++) {
		await jobTracker.get(runId)?.promise.catch(() => {});
		const run = store.runs().find((candidate) => candidate.id === runId);
		if (run !== undefined && run.status !== "running") return run;
		await sleep(10);
	}
	return store.runs().find((candidate) => candidate.id === runId);
}

/** Each node of every run of the view as `name<-parents`, by name, with each run's nodes under its own name. */
function edges(view: readonly RunSnapshot[]): string[] {
	return view
		.flatMap((run) => {
			const nodes = [...run.stages, ...(run.toolNodes ?? [])];
			const names = new Map(nodes.map((node) => [node.id, node.name]));
			return nodes.map(
				(node) =>
					`${run.name}:${node.name}<-${node.parentIds
						.map((id) => names.get(id) ?? `?${id}`)
						.sort()
						.join("+")}`,
			);
		})
		.sort();
}

function durableEdges(backend: JournalTestBackend, runId: string): string[] {
	return edges(durableWorkflowRunSnapshots(backend, backend.getWorkflow(runId)!));
}

async function resume(shape: Shape, runId: string): Promise<RunSnapshot | undefined> {
	const { runtime } = definitions(shape);
	const resumed = await workflowResumeAction(
		{ action: "resume", runId },
		{ getRuntime: () => runtime, policy: INTERACTIVE_WORKFLOW_POLICY, ensureWorkflowResourcesLoaded: async () => {} },
	);
	assert.ok(resumed.action === "resume");
	assert.equal(resumed.status, "running", JSON.stringify(resumed));
	return settled(runId);
}

async function source(shape: Shape) {
	failing = undefined;
	const backend = await JournalTestBackend.create();
	configureCurrentTestStoreBackend(backend);
	const { runtime } = definitions(shape);
	const started = await runtime.dispatch({ action: "run", workflow: "fork-parents", inputs: {} });
	assert.ok("runId" in started);
	const run = await settled(started.runId);
	assert.equal(run?.status, "completed", String(run?.error));
	const points: string[] = [];
	for await (const point of durableForkPoints(backend, started.runId, { cwd: process.cwd() } as never))
		points.push(point.stagePath);
	return { backend, runId: started.runId, edges: durableEdges(backend, started.runId), points };
}

async function fork(shape: Shape, backend: JournalTestBackend, runId: string, fromStage: string) {
	const forked = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		carryMessages: "before",
		definition: definitions(shape).parent,
		cwd: process.cwd(),
		fromStage,
	} as never);
	return forked.runId;
}

for (const shape of [
	"stages",
	"tasks",
	"tools",
	"tool-then-stages",
	"child-stages",
	"child-tools",
	"beside-child",
] as const)
	test(`a fork from each stage of a parallel ${shape} run keeps the source's parent edges (#5042)`, async () => {
		const origin = await source(shape);
		assert.ok(origin.points.length >= 3, JSON.stringify(origin.points));
		for (const fromStage of origin.points) {
			const forkId = await fork(shape, origin.backend, origin.runId, fromStage);
			const run = await resume(shape, forkId);
			assert.equal(run?.status, "completed", `from ${fromStage}: ${String(run?.error)}`);
			assert.deepEqual(durableEdges(origin.backend, forkId), origin.edges, `from ${fromStage}`);
		}
	});

test("a fork from a parallel stage that fails after it resumes with the source's parent edges (#5042)", async () => {
	const origin = await source("tools");
	const forkId = await fork("tools", origin.backend, origin.runId, "b");
	failing = "finish";
	assert.equal((await resume("tools", forkId))?.status, "failed");
	failing = undefined;
	const run = await resume("tools", forkId);
	assert.equal(run?.status, "completed", String(run?.error));
	assert.deepEqual(durableEdges(origin.backend, forkId), origin.edges);
});

for (const shape of ["stages", "tool-then-stages"] as const)
	test(`a fork from each stage of a resumed parallel ${shape} run reads back as its live run, with the source's edges (#5042)`, async () => {
		const backend = await JournalTestBackend.create();
		configureCurrentTestStoreBackend(backend);
		failing = "a";
		const started = await definitions(shape).runtime.dispatch({
			action: "run",
			workflow: "fork-parents",
			inputs: {},
		});
		assert.ok("runId" in started);
		assert.equal((await settled(started.runId))?.status, "failed");
		failing = undefined;
		const resumed = await resume(shape, started.runId);
		assert.equal(resumed?.status, "completed", String(resumed?.error));
		const sourceEdges = durableEdges(backend, started.runId);
		assert.deepEqual(edges([resumed!]), sourceEdges, "the resumed source reads back as it ran");
		const points: string[] = [];
		for await (const point of durableForkPoints(backend, started.runId, { cwd: process.cwd() } as never))
			points.push(point.stagePath);
		assert.ok(points.includes("a"), JSON.stringify(points));
		for (const fromStage of points) {
			const forkId = await fork(shape, backend, started.runId, fromStage);
			const run = await resume(shape, forkId);
			assert.equal(run?.status, "completed", `from ${fromStage}: ${String(run?.error)}`);
			assert.deepEqual(edges([run!]), sourceEdges, `from ${fromStage}: live`);
			assert.deepEqual(durableEdges(backend, forkId), sourceEdges, `from ${fromStage}: durable`);
		}
	});
