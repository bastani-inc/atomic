import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { RunContinuationOpts, RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
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

/** Where the source run fails: in a stage's call, or in the last tool. */
type FailAt = "agent" | "review" | "finish" | "none";

interface Shape {
	failAt: FailAt;
	/** Arguments of the `start` tool: a fork that changes them no longer reaches the tool its stage follows. */
	startArgs: Record<string, string>;
	/** Whether the definition no longer calls `start`. */
	removeStart?: boolean;
}

/**
 * Two stages, each created before the tool its first call follows, so each stage's recorded parent is a tool the fork
 * has not replayed yet when it replays the stage (#4945): `agent`, `start`, the agent's call, `review`, `check`, the
 * review's call, then `finish`.
 */
function stagesBeforeTools(shape: Shape, name = "fork-stage-before-tool"): WorkflowDefinition {
	return workflow({
		name,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const agent = ctx.stage("agent");
			if (shape.removeStart !== true) await ctx.tool("start", shape.startArgs, async () => "started");
			await agent.prompt("agent");
			const review = ctx.stage("review");
			await ctx.tool("check", {}, async () => "checked");
			await review.prompt("review");
			await ctx.tool("finish", {}, async () => {
				if (shape.failAt === "finish") throw new Error("planned finish failure");
				return "finished";
			});
			return {};
		},
	}) as WorkflowDefinition;
}

function inChild(child: WorkflowDefinition): WorkflowDefinition {
	return workflow({
		name: "fork-stage-before-tool-parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("prepare", {}, async () => "prepared");
			const result = await ctx.workflow(child);
			if (result.status !== "completed") throw new Error(`child ${result.status}`);
			return {};
		},
	}) as WorkflowDefinition;
}

async function runWith(
	definition: WorkflowDefinition,
	definitions: readonly WorkflowDefinition[],
	backend: MemoryJournalBackend,
	runId: string,
	shape: Shape,
	options: { continuation?: RunContinuationOpts; store?: Store } = {},
): Promise<RunResult> {
	return run(
		definition,
		{},
		{
			runId,
			registry: createRegistry([...definitions]),
			store: options.store ?? createStore(),
			durableBackend: backend,
			adapters: {
				prompt: {
					prompt: async (text: string) => {
						if (text === shape.failAt) throw new Error(`planned ${text} failure`);
						return text;
					},
				},
			},
			...(options.continuation === undefined ? {} : { continuation: options.continuation }),
		},
	);
}

/** The run's edges, by stage and tool name, so runs with different node ids compare. */
function edges(run: Pick<RunSnapshot, "stages" | "toolNodes">): readonly string[] {
	const nodes = [...run.stages, ...run.toolNodes];
	const names = new Map(nodes.map((node) => [node.id, node.name]));
	return nodes
		.flatMap((node) => node.parentIds.map((parentId) => `${names.get(parentId) ?? parentId} -> ${node.name}`))
		.sort();
}

/** Each stage's recorded parents, by stage name, as the run's stage records name them. */
function recordedStageParents(backend: MemoryJournalBackend, runId: string): Map<string, readonly string[]> {
	const parents = new Map<string, readonly string[]>();
	for (const checkpoint of backend.listCheckpoints(runId)) {
		if (checkpoint.kind !== "stage") continue;
		const record = checkpoint as DurableStageCheckpoint;
		if (record.topology !== undefined) parents.set(record.name, [...record.topology.parentIds].sort());
	}
	return parents;
}

/** The control: the same workflow run straight through. */
async function control(definition: WorkflowDefinition, definitions: readonly WorkflowDefinition[]) {
	const result = await runWith(definition, definitions, await createMemoryTestBackend(), testRunId("fork-control"), {
		failAt: "none",
		startArgs: {},
	});
	assert.equal(result.status, "completed", result.error);
	return result;
}

/** Runs the source until it fails at `failAt` and returns its snapshot, as its store and its records hold it. */
async function failedSource(
	backend: MemoryJournalBackend,
	shape: Shape,
	definition: (shape: Shape) => WorkflowDefinition,
	definitions: (shape: Shape) => readonly WorkflowDefinition[],
	fromRecords: boolean,
): Promise<RunSnapshot> {
	const store = createStore();
	const sourceId = testRunId(`fork-source-${shape.failAt}`);
	const failed = await runWith(definition(shape), definitions(shape), backend, sourceId, shape, { store });
	assert.equal(failed.status, "failed");
	const source = fromRecords
		? durableWorkflowRunSnapshots(backend, backend.getWorkflow(sourceId)!).find((run) => run.id === sourceId)
		: store.runs().find((candidate) => candidate.id === sourceId);
	assert.ok(source, "the source run has a snapshot");
	return source;
}

function resumePoint(source: RunSnapshot, failAt: FailAt): RunContinuationOpts {
	if (failAt === "finish") {
		const frontier = source.toolNodes.find((node) => node.name === "finish");
		assert.ok(frontier, "the source recorded the failed tool");
		return { source, resumeFromToolNodeId: frontier.id };
	}
	const failedStage = source.stages.find((stage) => stage.name === failAt);
	assert.ok(failedStage, `the source recorded the failed stage ${failAt}`);
	return { source, resumeFromStageId: failedStage.id };
}

describe("a fork of a run whose stage is created before a tool (#4945)", () => {
	test.each(["agent", "review", "finish"] as const)(
		"a root workflow forked from %s completes with the source's graph (#4945)",
		async (failAt) => {
			const expected = edges(await control(stagesBeforeTools({ failAt: "none", startArgs: {} }), []));
			const backend = await createMemoryTestBackend();
			const shape: Shape = { failAt, startArgs: {} };
			const definition = (current: Shape) => stagesBeforeTools(current);
			const source = await failedSource(backend, shape, definition, (current) => [definition(current)], false);
			const sourceParents = recordedStageParents(backend, source.id);

			shape.failAt = "none";
			const forkId = testRunId(`fork-${failAt}`);
			const fork = await runWith(definition(shape), [definition(shape)], backend, forkId, shape, {
				continuation: resumePoint(source, failAt),
			});
			assert.equal(fork.status, "completed", fork.error);
			const replayed = fork.stages.filter((stage) => stage.replayed === true).map((stage) => stage.name);
			assert.deepEqual(replayed, failAt === "agent" ? [] : failAt === "review" ? ["agent"] : ["agent", "review"]);
			// A stage the source never created runs live and keeps the parents it was created with under a continuation,
			// so only a fork that re-creates every stage from the source draws the whole graph the same way.
			if (failAt === "agent") assert.ok(edges(fork).includes("start -> agent"), edges(fork).join(", "));
			else assert.deepEqual(edges(fork), expected);

			// The fork's records name the same parents for every stage the source recorded: its prefix.
			const forkParents = recordedStageParents(backend, forkId);
			assert.ok(sourceParents.size > 0);
			for (const [name, parents] of sourceParents) assert.deepEqual(forkParents.get(name), parents, name);
		},
	);

	test.each(["review", "finish"] as const)(
		"a root workflow forked from %s of the run's records completes (#4945)",
		async (failAt) => {
			const expected = edges(await control(stagesBeforeTools({ failAt: "none", startArgs: {} }), []));
			const backend = await createMemoryTestBackend();
			const shape: Shape = { failAt, startArgs: {} };
			const definition = (current: Shape) => stagesBeforeTools(current);
			const source = await failedSource(backend, shape, definition, (current) => [definition(current)], true);
			shape.failAt = "none";
			const fork = await runWith(definition(shape), [definition(shape)], backend, testRunId("fork-records"), shape, {
				continuation: resumePoint(source, failAt),
			});
			assert.equal(fork.status, "completed", fork.error);
			assert.deepEqual(edges(fork), expected);
		},
	);

	test.each(["agent", "review", "finish"] as const)(
		"a child workflow forked from %s inside its parent completes (#4945)",
		async (failAt) => {
			const controlChild = stagesBeforeTools({ failAt: "none", startArgs: {} }, "fork-stage-before-tool-child");
			const controlRun = await control(inChild(controlChild), [controlChild]);
			const backend = await createMemoryTestBackend();
			const shape: Shape = { failAt, startArgs: {} };
			const child = (current: Shape) => stagesBeforeTools(current, "fork-stage-before-tool-child");
			const source = await failedSource(
				backend,
				shape,
				(current) => inChild(child(current)),
				(current) => [inChild(child(current)), child(current)],
				false,
			);
			const boundary = source.stages.find((stage) => stage.name === "workflow:fork-stage-before-tool-child");
			assert.ok(
				boundary,
				`the source recorded the child boundary: ${source.stages.map((stage) => stage.name).join(", ")}`,
			);

			shape.failAt = "none";
			const fork = await runWith(
				inChild(child(shape)),
				[inChild(child(shape)), child(shape)],
				backend,
				testRunId("fork-child"),
				shape,
				{ continuation: { source, resumeFromStageId: boundary.id } },
			);
			assert.equal(fork.status, "completed", fork.error);
			assert.deepEqual(edges(fork), edges(controlRun));
		},
	);

	test("a fork whose stage's tool parent never materialises fails loudly (#4945)", async () => {
		const backend = await createMemoryTestBackend();
		const shape: Shape = { failAt: "review", startArgs: {} };
		const definition = (current: Shape) => stagesBeforeTools(current);
		const source = await failedSource(backend, shape, definition, (current) => [definition(current)], false);

		// The fork's `start` takes other arguments, so it is another tool, not the one the replayed `agent` follows.
		const changed: Shape = { failAt: "none", startArgs: { changed: "yes" } };
		const forkId = testRunId("fork-mismatch");
		const fork = await runWith(definition(changed), [definition(changed)], backend, forkId, changed, {
			continuation: resumePoint(source, "review"),
		});
		assert.equal(fork.status, "failed");
		assert.match(fork.error ?? "", /insufficient_state: replay topology mismatch/);
		assert.equal(
			fork.toolNodes.some((node) => node.name === "finish"),
			false,
		);
	});
});

/** The run as its records rebuild it. */
function durableView(backend: MemoryJournalBackend, runId: string): RunSnapshot | undefined {
	const handle = backend.getWorkflow(runId);
	assert.ok(handle, "the run is registered");
	return durableWorkflowRunSnapshots(backend, handle).find((candidate) => candidate.id === runId);
}

const CHANGES = [
	["changed", { startArgs: { changed: "yes" } }],
	["removed", { startArgs: {}, removeStart: true }],
] as const;

describe("a resume whose definition changed the tool a replayed stage follows (#4945)", () => {
	test.each(
		(["review", "finish"] as const).flatMap((failAt) =>
			CHANGES.flatMap(([change, edit]) =>
				(["same id", "continuation"] as const).map((resume) => [failAt, change, resume, edit] as const),
			),
		),
	)(
		"a root workflow failed at %s with its tool %s fails loudly on a %s resume and stays readable (#4945)",
		async (failAt, _change, resume, edit) => {
			const backend = await createMemoryTestBackend();
			const store = createStore();
			const shape: Shape = { failAt, startArgs: {} };
			const runId = testRunId(`resume-changed-tool-${failAt}`);
			const failed = await runWith(stagesBeforeTools(shape), [stagesBeforeTools(shape)], backend, runId, shape, {
				store,
			});
			assert.equal(failed.status, "failed");
			const source = store.runs().find((candidate) => candidate.id === runId);
			assert.ok(source);

			const changed: Shape = { failAt: "none", ...edit };
			const definition = stagesBeforeTools(changed);
			const resumed = await runWith(definition, [definition], backend, runId, changed, {
				...(resume === "continuation" ? { continuation: resumePoint(source, failAt) } : {}),
			});
			assert.equal(resumed.status, "failed", "the replayed agent stage follows a tool the run no longer reaches");
			// A changed tool can also be caught first, where the run reaches it with another identity.
			assert.match(resumed.error ?? "", /insufficient_state: replay topology mismatch for /);
			// The records still rebuild the run, with the stage's recorded parent.
			const view = durableView(backend, runId);
			assert.ok(view, "the run's records rebuild it");
			assert.ok(edges(view).includes("start -> agent"), edges(view).join(", "));
		},
	);

	test.each(
		(["review", "finish"] as const).flatMap((failAt) =>
			CHANGES.map(([change, edit]) => [failAt, change, edit] as const),
		),
	)(
		"a child workflow failed at %s with its tool %s fails its parent loudly on resume and stays readable (#4945)",
		async (failAt, _change, edit) => {
			const backend = await createMemoryTestBackend();
			const shape: Shape = { failAt, startArgs: {} };
			const child = (current: Shape) => stagesBeforeTools(current, "fork-stage-before-tool-child");
			const runId = testRunId(`resume-changed-child-tool-${failAt}`);
			const failed = await runWith(
				inChild(child(shape)),
				[inChild(child(shape)), child(shape)],
				backend,
				runId,
				shape,
			);
			assert.equal(failed.status, "failed");

			const changed: Shape = { failAt: "none", ...edit };
			const resumed = await runWith(
				inChild(child(changed)),
				[inChild(child(changed)), child(changed)],
				backend,
				runId,
				changed,
			);
			assert.equal(resumed.status, "failed");
			assert.match(resumed.error ?? "", /insufficient_state: replay topology mismatch for stage "agent"/);
			assert.ok(durableView(backend, runId), "the run's records rebuild it");
		},
	);

	test.each(CHANGES)(
		"a stage after parallel tools, with one of them %s, fails loudly on resume and stays readable (#4945)",
		async (_change, edit) => {
			const backend = await createMemoryTestBackend();
			const parallel = (current: Shape, failZ: boolean) =>
				workflow({
					name: "fork-stage-before-parallel-tools",
					description: "",
					inputs: {},
					outputs: {},
					run: async (ctx) => {
						const agent = ctx.stage("agent");
						await Promise.all([
							current.removeStart === true
								? Promise.resolve()
								: ctx.tool("start", current.startArgs, async () => "started"),
							ctx.tool("other", {}, async () => "other"),
						]);
						await agent.prompt("agent");
						await ctx.stage("z").prompt(failZ ? "review" : "z");
						return {};
					},
				}) as WorkflowDefinition;
			const runId = testRunId("resume-changed-parallel-tool");
			const shape: Shape = { failAt: "review", startArgs: {} };
			assert.equal((await runWith(parallel(shape, true), [], backend, runId, shape)).status, "failed");
			const changed: Shape = { failAt: "none", ...edit };
			const resumed = await runWith(parallel(changed, false), [], backend, runId, changed);
			assert.equal(resumed.status, "failed");
			assert.match(resumed.error ?? "", /insufficient_state: replay topology mismatch for stage "agent"/);
			assert.ok(durableView(backend, runId), "the run's records rebuild it");
		},
	);

	test("a resume with the same definition still completes, with the source's graph (#4945)", async () => {
		const backend = await createMemoryTestBackend();
		const shape: Shape = { failAt: "finish", startArgs: {} };
		const runId = testRunId("resume-same-tool");
		const expected = edges(await control(stagesBeforeTools({ failAt: "none", startArgs: {} }), []));
		assert.equal((await runWith(stagesBeforeTools(shape), [], backend, runId, shape)).status, "failed");
		shape.failAt = "none";
		const resumed = await runWith(stagesBeforeTools(shape), [], backend, runId, shape);
		assert.equal(resumed.status, "completed", resumed.error);
		assert.deepEqual(edges(resumed), expected);
		const view = durableView(backend, runId);
		assert.ok(view);
		assert.deepEqual(edges(view), expected);
	});
});
