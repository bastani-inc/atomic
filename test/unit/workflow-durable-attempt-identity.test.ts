import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowRunSnapshots,
	durableWorkflowRunSnapshots,
	listCompletedFromBackend,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { ForkTargetNotFoundError } from "../../packages/workflows/src/durable/fork-errors.js";
import { durableForkPoints, forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowPolicyFromContext } from "../../packages/workflows/src/extension/workflow-policy.js";
import { workflowResumeAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

beforeEach(() => store.clear());
afterEach(async () => {
	setDurableBackend(undefined);
	store.clear();
	await closeMemoryTestBackends();
});

/** Where an attempt fails: a stage, the tool, or inside the child workflow. */
type Point = "s1" | "t1" | "s2" | "child";
/**
 * How an attempt ends: it runs to completion, exits after a node, fails at a point, completes past a failure of `s2`
 * it caught, or calls a tool of its own before `t1`.
 */
type Ending =
	| { readonly kind: "complete" }
	| { readonly kind: "exit"; readonly after: "s1" | "t1" | "s2" }
	| Fail
	| { readonly kind: "caught" }
	| { readonly kind: "detour" };
type Fail = { readonly kind: "fail"; readonly at: Point };

interface Behaviour {
	ending: Ending;
}

function definitions(behaviour: Behaviour): { parent: WorkflowDefinition; child: WorkflowDefinition } {
	const fails = (point: Point) => behaviour.ending.kind === "fail" && behaviour.ending.at === point;
	const child = workflow({
		name: "attempt-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("c1").prompt("c1");
			await ctx.tool("ct", {}, async () => {
				if (fails("child")) throw new Error("planned child failure");
				return "ct";
			});
			return {};
		},
	}) as WorkflowDefinition;
	const exitAfter = (node: "s1" | "t1" | "s2", ctx: { exit(options: { reason: string }): never }) => {
		if (behaviour.ending.kind === "exit" && behaviour.ending.after === node) ctx.exit({ reason: `after ${node}` });
	};
	const parent = workflow({
		name: "attempt-parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("s1").prompt("s1");
			exitAfter("s1", ctx);
			if (behaviour.ending.kind === "detour") await ctx.tool("detour", {}, async () => "detour");
			await ctx.tool("t1", {}, async () => {
				if (fails("t1")) throw new Error("planned tool failure");
				return "t1";
			});
			exitAfter("t1", ctx);
			try {
				await ctx.stage("s2").prompt("s2");
			} catch (error) {
				if (behaviour.ending.kind !== "caught") throw error;
			}
			exitAfter("s2", ctx);
			await ctx.workflow(child);
			return {};
		},
	}) as WorkflowDefinition;
	return { parent, child };
}

/** A run's graph by name, so the live and durable runs compare whatever ids they carry. */
interface GraphView {
	readonly name: string;
	readonly status: string;
	readonly stages: readonly string[];
	readonly tools: readonly string[];
}

function toolStatus(status: string): string {
	// A completed tool replays from its checkpoint, so the durable view calls it cached.
	return status === "completed" ? "cached" : status;
}

/**
 * The runs the root reaches through the boundary stages of its graph. A child run left in the live store by an earlier
 * attempt that the latest attempt never reached hangs off no stage of it. Failed or skipped boundaries count only a child they actually started.
 */
function graph(runs: readonly RunSnapshot[], rootId: string): readonly GraphView[] {
	const views: GraphView[] = [];
	const visit = (snapshot: RunSnapshot) => {
		views.push({
			name: snapshot.name,
			status: snapshot.id === rootId ? "root" : snapshot.status,
			stages: snapshot.stages.map((stage) => `${stage.name}:${stage.status}`),
			tools: snapshot.toolNodes.map((tool) => `${tool.name}:${toolStatus(tool.status)}`),
		});
		const boundaries = new Set(
			snapshot.stages
				.filter(
					(stage) =>
						stage.startedChildRunId !== undefined || (stage.status !== "failed" && stage.status !== "skipped"),
				)
				.map((stage) => stage.id),
		);
		for (const childRun of runs)
			if (childRun.parentRunId === snapshot.id && boundaries.has(childRun.parentStageId ?? "")) visit(childRun);
	};
	const root = runs.find((candidate) => candidate.id === rootId);
	if (root !== undefined) visit(root);
	return views;
}

interface Harness {
	readonly backend: MemoryJournalBackend;
	readonly runId: string;
	readonly behaviour: Behaviour;
	/** Resume the run through the workflow tool and wait for it to settle. */
	resume(ending: Ending): Promise<RunSnapshot>;
}

async function harness(first: Ending, label: string): Promise<Harness> {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const behaviour: Behaviour = { ending: first };
	const { parent, child } = definitions(behaviour);
	const adapters = {
		prompt: {
			prompt: async (text: string) => {
				const ending = behaviour.ending;
				if ((ending.kind === "fail" && ending.at === text) || (ending.kind === "caught" && text === "s2"))
					throw new Error(`planned ${text}`);
				return text;
			},
		},
	};
	const runId = testRunId(label);
	const firstRun = await run(
		parent,
		{},
		{ runId, store, registry: createRegistry([parent, child]), durableBackend: backend, adapters },
	);
	assert.equal(firstRun.status, first.kind === "fail" ? "failed" : "completed", firstRun.error);
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({ store, registry: createRegistry([parent, child]), jobs, adapters });
	return {
		backend,
		runId,
		behaviour,
		async resume(ending) {
			behaviour.ending = ending;
			const result = await workflowResumeAction(
				{ action: "resume", runId },
				{ getRuntime: () => runtime, policy: workflowPolicyFromContext(), ensureWorkflowResourcesLoaded() {} },
			);
			assert.ok(result.action === "resume");
			assert.equal(result.status, "running", JSON.stringify(result));
			assert.equal(result.runId, runId);
			await jobs.get(runId)?.promise;
			const live = store.run(runId);
			assert.ok(live, "the resumed run is live");
			return live;
		},
	};
}

async function durableViews(backend: MemoryJournalBackend, runId: string) {
	const handle = backend.getWorkflow(runId);
	assert.ok(handle, "the run is durable");
	const retained = durableWorkflowRunSnapshots(backend, handle);
	const entry = listCompletedFromBackend(backend).find((candidate) => candidate.workflowId === runId);
	const completed =
		entry === undefined ? undefined : await completedWorkflowRunSnapshots(backend, entry, new MemorySessionStore());
	return { retained, completed };
}

async function assertDurableMatchesLive(h: Harness, live: RunSnapshot, label: string): Promise<void> {
	const liveRuns = [live, ...store.runs().filter((candidate) => candidate.rootRunId === h.runId)];
	const expected = graph(liveRuns, h.runId);
	const { retained, completed } = await durableViews(h.backend, h.runId);
	console.log("LIVE", JSON.stringify(live.toolNodes), live.status, JSON.stringify(h.backend.getWorkflow(h.runId)));
	console.log(
		JSON.stringify(
			h.backend
				.listCheckpoints(h.runId)
				.map((c) => [
					c.kind,
					c.checkpointId,
					c.kind === "ui" ? 0 : c.attempt,
					c.kind === "tool" ? c.throwingFailureError : c.kind === "stage" ? c.topology?.status : "",
				]),
		),
	);
	assert.deepEqual(graph(retained, h.runId), expected, `${label}: retained durable view`);
	if (completed !== undefined) assert.deepEqual(graph(completed, h.runId), expected, `${label}: completed view`);
}

const FAILURE_POINTS: readonly Point[] = ["s1", "t1", "s2", "child"];
const CONTINUATIONS: ReadonlyArray<{ readonly label: string; readonly ending: (failed: Point) => Ending }> = [
	{ label: "completes", ending: () => ({ kind: "complete" }) },
	{ label: "exits after s1", ending: () => ({ kind: "exit", after: "s1" }) },
	{ label: "exits after t1", ending: () => ({ kind: "exit", after: "t1" }) },
	{ label: "exits after s2", ending: () => ({ kind: "exit", after: "s2" }) },
	{ label: "fails again", ending: (failed) => ({ kind: "fail", at: failed }) },
];

describe("the durable view of a resumed run shows what its latest attempt reached (#4874)", () => {
	for (const point of FAILURE_POINTS) {
		for (const continuation of CONTINUATIONS) {
			test(`a run that failed at ${point} and then ${continuation.label} reads durably as it ran live (#4874)`, async () => {
				const label = `${point}-${continuation.label}`;
				const h = await harness({ kind: "fail", at: point }, `attempt-${point}`);
				const live = await h.resume(continuation.ending(point));
				await assertDurableMatchesLive(h, live, label);
			});
		}
	}
});

describe("a resumed run keeps what its latest attempt did (#4874)", () => {
	test("a failure the resumed attempt caught and completed past stays failed (#4874)", async () => {
		const h = await harness({ kind: "fail", at: "t1" }, "attempt-caught");
		const live = await h.resume({ kind: "caught" });
		assert.equal(live.status, "completed", live.error);
		assert.equal(live.stages.find((stage) => stage.name === "s2")?.status, "failed");
		await assertDurableMatchesLive(h, live, "caught");
	});

	test("a resumed attempt that fails before reaching its failed tool keeps that tool failed (#4874)", async () => {
		const h = await harness({ kind: "fail", at: "t1" }, "attempt-detour");
		const live = await h.resume({ kind: "detour" });
		assert.equal(live.status, "failed");
		assert.deepEqual(
			live.toolNodes.map((tool) => `${tool.name}:${tool.status}`),
			["t1:failed"],
		);
		await assertDurableMatchesLive(h, live, "detour");
	});

	test("a child run again in two later attempts reads as the last one (#4874)", async () => {
		const h = await harness({ kind: "fail", at: "child" }, "attempt-child-thrice");
		await assertDurableMatchesLive(h, await h.resume({ kind: "fail", at: "child" }), "failed again");
		const live = await h.resume({ kind: "complete" });
		assert.equal(live.status, "completed", live.error);
		await assertDurableMatchesLive(h, live, "completed");
	});

	test("a run resumed twice reads as its last attempt, after one that failed elsewhere (#4874)", async () => {
		const h = await harness({ kind: "fail", at: "t1" }, "attempt-twice");
		await assertDurableMatchesLive(h, await h.resume({ kind: "fail", at: "s2" }), "failed at s2");
		const live = await h.resume({ kind: "exit", after: "s1" });
		assert.equal(live.status, "completed", live.error);
		await assertDurableMatchesLive(h, live, "exit after s1");
	});
});

describe("forking a resumed run (#4874)", () => {
	const stageNames = (snapshot: RunSnapshot | undefined) => snapshot?.stages.map((stage) => stage.name);
	const forkRoot = async (h: Harness, fromStage: string) => {
		const { runId } = await forkDurableRun(h.backend, {
			source: "sdk",
			runId: h.runId,
			fromStage,
			cwd: tmpdir(),
			carryMessages: "all",
			definition: definitions(h.behaviour).parent,
		});
		const fork = h.backend.getWorkflow(runId);
		assert.ok(fork, "the fork is durable");
		return { runId, root: durableWorkflowRunSnapshots(h.backend, fork).find((candidate) => candidate.id === runId) };
	};

	test("fork points are the stages the latest attempt reached (#4874)", async () => {
		const h = await harness({ kind: "fail", at: "child" }, "attempt-fork-points");
		await h.resume({ kind: "exit", after: "s1" });
		const points = [];
		for await (const point of durableForkPoints(h.backend, h.runId)) points.push(point.stagePath);
		assert.deepEqual(points, ["s1"]);
		await assert.rejects(forkRoot(h, "s2"), ForkTargetNotFoundError);
	});

	test("a fork from a stage of a later attempt keeps what that attempt replayed before it (#4874)", async () => {
		const h = await harness({ kind: "fail", at: "s2" }, "attempt-fork");
		await h.resume({ kind: "complete" });
		const fromS2 = await forkRoot(h, "s2");
		assert.deepEqual(stageNames(fromS2.root), ["s1"]);
		assert.deepEqual(
			fromS2.root?.toolNodes.map((tool) => tool.name),
			["t1"],
		);
		const fromChild = await forkRoot(h, "workflow:attempt-child");
		assert.deepEqual(stageNames(fromChild.root), ["s1", "s2"]);
	});

	test("a fork from a stage an earlier attempt completed leaves the later attempts out (#4874)", async () => {
		const h = await harness({ kind: "fail", at: "child" }, "attempt-fork-earlier");
		await h.resume({ kind: "fail", at: "child" });
		const fromS2 = await forkRoot(h, "s2");
		assert.deepEqual(stageNames(fromS2.root), ["s1"]);
		assert.deepEqual(
			fromS2.root?.toolNodes.map((tool) => tool.name),
			["t1"],
		);
	});

	test("a whole-run fork of a resumed run reads as its source's latest attempt (#4874)", async () => {
		const h = await harness({ kind: "fail", at: "child" }, "attempt-fork-whole");
		await h.resume({ kind: "exit", after: "s1" });
		const { runId } = await forkDurableRun(h.backend, {
			source: "sdk",
			runId: h.runId,
			cwd: tmpdir(),
			carryMessages: "all",
			definition: definitions(h.behaviour).parent,
		});
		const source = durableWorkflowRunSnapshots(h.backend, h.backend.getWorkflow(h.runId)!);
		const fork = durableWorkflowRunSnapshots(h.backend, h.backend.getWorkflow(runId)!);
		assert.deepEqual(graph(fork, runId), graph(source, h.runId));
		assert.deepEqual(stageNames(fork[0]), ["s1"]);
	});

	test("a forked run resumed from its fork point reads durably as it ran live (#4874)", async () => {
		const h = await harness({ kind: "fail", at: "s2" }, "attempt-fork-run");
		await h.resume({ kind: "complete" });
		const fork = await forkRoot(h, "s2");
		h.behaviour.ending = { kind: "exit", after: "s2" };
		const { parent, child } = definitions(h.behaviour);
		const result = await run(
			parent,
			{},
			{
				runId: fork.runId,
				store,
				registry: createRegistry([parent, child]),
				durableBackend: h.backend,
				adapters: { prompt: { prompt: async (text: string) => text } },
			},
		);
		assert.equal(result.status, "completed", result.error);
		const live = store.run(fork.runId);
		assert.ok(live);
		await assertDurableMatchesLive({ ...h, runId: fork.runId }, live, "fork");
	});
});

describe("a tool that ends badly in two attempts reads as the latest one (#4874)", () => {
	type ToolEnding = "throw" | "wait";

	async function toolRun(label: string) {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const state = { ending: "throw" as ToolEnding, entered: Promise.withResolvers<void>() };
		const definition = workflow({
			name: `attempt-tool-${label}`,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("s1").prompt("s1");
				await ctx.tool("t1", {}, async ({ signal }) => {
					if (state.ending === "throw") throw new Error("planned tool failure");
					state.entered.resolve();
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
					throw new Error("cancelled by the pause");
				});
				return {};
			},
		}) as WorkflowDefinition;
		const jobs = createJobTracker();
		const adapters = { prompt: { prompt: async (text: string) => text } };
		const runtime = createExtensionRuntime({ store, registry: createRegistry([definition]), jobs, adapters });
		const runId = testRunId(label);
		/** Start an attempt in the background, through the workflow tool once the run exists. */
		const start = async (ending: ToolEnding, first: boolean) => {
			state.ending = ending;
			state.entered = Promise.withResolvers<void>();
			if (first) runDetached(definition, {}, { runId, store, jobs, durableBackend: backend, adapters });
			else {
				const result = await workflowResumeAction(
					{ action: "resume", runId },
					{ getRuntime: () => runtime, policy: workflowPolicyFromContext(), ensureWorkflowResourcesLoaded() {} },
				);
				assert.ok(result.action === "resume");
				assert.equal(result.status, "running", JSON.stringify(result));
			}
			if (ending === "wait") {
				await state.entered.promise;
				const quit = await quitRun(runId, { store });
				assert.equal(quit.ok, true);
			}
			await jobs.get(runId)?.promise;
			const live = store.run(runId);
			assert.ok(live);
			return live;
		};
		const durableTool = () => {
			if (process.env.DUMP_4874)
				console.log(
					JSON.stringify(
						backend
							.listCheckpoints(runId)
							.map((c) => [
								c.kind,
								c.checkpointId,
								c.kind === "ui" ? 0 : c.attempt,
								c.kind === "tool"
									? [c.throwingFailureError, c.cancelled]
									: c.kind === "stage"
										? c.topology?.status
										: "",
							]),
					),
				);
			const handle = backend.getWorkflow(runId);
			assert.ok(handle);
			const root = durableWorkflowRunSnapshots(backend, handle).find((candidate) => candidate.id === runId);
			return root?.toolNodes.map((tool) => `${tool.name}:${tool.status}`);
		};
		const liveTool = (live: RunSnapshot) => live.toolNodes.map((tool) => `${tool.name}:${tool.status}`);
		return { start, durableTool, liveTool };
	}

	test("a tool that failed, then was cancelled by a pause, reads as cancelled (#4874)", async () => {
		const r = await toolRun("failed-then-cancelled");
		assert.deepEqual(r.liveTool(await r.start("throw", true)), ["t1:failed"]);
		const live = await r.start("wait", false);
		assert.deepEqual(r.liveTool(live), ["t1:cancelled"]);
		assert.deepEqual(r.durableTool(), r.liveTool(live));
	});

	test("a tool that was cancelled by a pause, then failed, reads as failed (#4874)", async () => {
		const r = await toolRun("cancelled-then-failed");
		assert.deepEqual(r.liveTool(await r.start("wait", true)), ["t1:cancelled"]);
		const live = await r.start("throw", false);
		assert.deepEqual(r.liveTool(live), ["t1:failed"]);
		assert.deepEqual(r.durableTool(), r.liveTool(live));
	});
});
