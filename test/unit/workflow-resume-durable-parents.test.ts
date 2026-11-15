import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowRunSnapshots,
	listCompletedFromBackend,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

afterEach(closeMemoryTestBackends);

/** Layers of stages started together; every layer waits for the previous one. */
type Plan = readonly (readonly string[])[];

const ISSUE_PLAN: Plan = [["A", "B"], ["S", "T"], ["Z"]];

function dagWorkflow(name: string, plan: Plan): WorkflowDefinition {
	return workflow({
		name,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			for (const layer of plan) await Promise.all(layer.map((stage) => ctx.stage(stage).prompt(stage)));
			return {};
		},
	}) as WorkflowDefinition;
}

function parentWorkflow(child: WorkflowDefinition): WorkflowDefinition {
	return workflow({
		name: `${child.name}-parent`,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.workflow(child);
			return {};
		},
	}) as WorkflowDefinition;
}

/** A prompt adapter whose `failing` stage fails, after its siblings had time to finish, while `failing` is set. */
function promptAdapter(state: { failing: string | undefined }) {
	return {
		prompt: async (text: string) => {
			if (text === state.failing) {
				await new Promise((resolve) => setTimeout(resolve, 15));
				throw new Error(`planned failure in ${text}`);
			}
			return text;
		},
	};
}

async function runWith(
	definition: WorkflowDefinition,
	registry: readonly WorkflowDefinition[],
	backend: MemoryJournalBackend,
	runId: string,
	state: { failing: string | undefined },
): Promise<RunResult> {
	return run(
		definition,
		{},
		{
			runId,
			registry: createRegistry([...registry]),
			store: createStore(),
			durableBackend: backend,
			adapters: { prompt: promptAdapter(state) },
		},
	);
}

/** The run's edges by stage name, so runs with different stage ids compare. */
function edges(run: Pick<RunSnapshot, "stages">): readonly string[] {
	const names = new Map(run.stages.map((stage) => [stage.id, stage.name]));
	return run.stages
		.flatMap((stage) => stage.parentIds.map((parentId) => `${names.get(parentId) ?? parentId} -> ${stage.name}`))
		.sort();
}

function stageNames(run: Pick<RunSnapshot, "stages">): readonly string[] {
	return run.stages.map((stage) => stage.name);
}

async function inspectCompleted(backend: MemoryJournalBackend, runId: string): Promise<readonly RunSnapshot[]> {
	const entry = listCompletedFromBackend(backend).find((candidate) => candidate.workflowId === runId);
	assert.ok(entry, `completed catalog lists ${runId}`);
	return completedWorkflowRunSnapshots(backend, entry, new MemorySessionStore());
}

/** Edges of an uninterrupted run of `plan`. */
async function controlEdges(plan: Plan, name: string): Promise<readonly string[]> {
	const definition = dagWorkflow(name, plan);
	const result = await runWith(
		definition,
		[definition],
		await createMemoryTestBackend(),
		testRunId(`${name}-control`),
		{
			failing: undefined,
		},
	);
	assert.equal(result.status, "completed");
	return edges(result);
}

describe("a stage re-run on a same-id resume keeps its durable parents (#4871)", () => {
	test("the resumed root run has the edges of an uninterrupted run, and completed inspection rebuilds it (#4871)", async () => {
		const name = "resume-parents-root";
		const control = await controlEdges(ISSUE_PLAN, name);
		const definition = dagWorkflow(name, ISSUE_PLAN);
		const backend = await createMemoryTestBackend();
		const runId = testRunId(name);
		const state = { failing: "S" as string | undefined };

		const first = await runWith(definition, [definition], backend, runId, state);
		assert.equal(first.status, "failed");
		assert.equal(first.stages.find((stage) => stage.name === "T")?.status, "completed");

		state.failing = undefined;
		const resumed = await runWith(definition, [definition], backend, runId, state);
		assert.equal(resumed.status, "completed");
		assert.deepEqual(edges(resumed), control);

		const inspected = await inspectCompleted(backend, runId);
		const root = inspected.find((candidate) => candidate.id === runId);
		assert.ok(root, "completed inspection rebuilds the run");
		assert.deepEqual(stageNames(root), ["A", "B", "S", "T", "Z"]);
		assert.deepEqual(edges(root), control);
	});

	test("the same body as a child workflow can be resumed and then re-run with the same id (#4871)", async () => {
		const name = "resume-parents-child";
		const control = await controlEdges(ISSUE_PLAN, name);
		const child = dagWorkflow(name, ISSUE_PLAN);
		const parent = parentWorkflow(child);
		const backend = await createMemoryTestBackend();
		const runId = testRunId(`${name}-parent`);
		const state = { failing: "S" as string | undefined };
		const childEdges = async (): Promise<readonly string[]> => {
			const childRun = (await inspectCompleted(backend, runId)).find((candidate) => candidate.name === name);
			assert.ok(childRun, "completed inspection rebuilds the child run");
			assert.deepEqual(stageNames(childRun), ["A", "B", "S", "T", "Z"]);
			return edges(childRun);
		};

		assert.equal((await runWith(parent, [parent, child], backend, runId, state)).status, "failed");
		state.failing = undefined;
		assert.equal((await runWith(parent, [parent, child], backend, runId, state)).status, "completed");
		assert.deepEqual(await childEdges(), control);

		const rerun = await runWith(parent, [parent, child], backend, runId, state);
		assert.equal(rerun.status, "completed", rerun.error);
		assert.deepEqual(await childEdges(), control);
	});

	test("random small DAGs resumed after one failing stage keep the edges of an uninterrupted run (#4871)", async () => {
		const random = mulberry32(4871);
		for (let seed = 0; seed < 30; seed++) {
			const plan = randomPlan(random);
			const stages = plan.flat();
			const failing = stages[Math.floor(random() * stages.length)]!;
			const name = `resume-parents-dag-${seed}`;
			const control = await controlEdges(plan, name);
			const definition = dagWorkflow(name, plan);
			const backend = await createMemoryTestBackend();
			const runId = testRunId(name);
			const state = { failing: failing as string | undefined };
			const label = `seed ${seed}: ${JSON.stringify(plan)} failing ${failing}`;

			assert.equal((await runWith(definition, [definition], backend, runId, state)).status, "failed", label);
			state.failing = undefined;
			const resumed = await runWith(definition, [definition], backend, runId, state);
			assert.equal(resumed.status, "completed", label);
			assert.deepEqual(edges(resumed), control, label);
			const root = (await inspectCompleted(backend, runId)).find((candidate) => candidate.id === runId);
			assert.ok(root, `completed inspection rebuilds ${label}`);
			assert.deepEqual(edges(root), control, label);
		}
	});
});

/** Two to four layers of one to three uniquely named stages. */
function randomPlan(random: () => number): Plan {
	let next = 0;
	const layers = 2 + Math.floor(random() * 3);
	return Array.from({ length: layers }, () =>
		Array.from({ length: 1 + Math.floor(random() * 3) }, () => `s${next++}`),
	);
}

/** Deterministic PRNG so a failing DAG reproduces from its seed. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
