/**
 * A pooled root keeps only its own checkpoints in its parent's memory (#4318), and still resumes like one that keeps
 * every checkpoint: a completed child replays from the journal without running again, and a child that failed is
 * checked against its recorded checkpoints and dispatched again under the identity its boundary recorded.
 *
 * The pool here is a stand-in with the real pool's contract for the root's backend: it narrows the root when it is
 * prepared (`LocalWorkerPool.prepare`) and receives every child the root starts. The children are recorded by a first
 * run with in-process children, which write into the root's run the same scoped checkpoints workers write.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type {
	ResolvedInputs,
	RunOpts,
	RunResult,
} from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { bindChildWorkerDispatcher } from "../../packages/workflows/src/workers/dispatch.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

const releases: (() => void)[] = [];
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await closeMemoryTestBackends();
});

const CHILDREN = 24;
const POOL_WIDTH = 6;
/** Tool checkpoints each child records besides its stage, as a pooled child's stage sessions add up. */
const CHILD_TOOLS = 12;
/** Structural: records a pooled root through the real engine, then resumes it. */
const POOLED_RESUME_TIMEOUT_MS = 90_000;

/** The child boundary scopes the root opened: every checkpoint under one is a child's. */
function childScopes(checkpoints: readonly DurableCheckpoint[], rootId: string): string[] {
	return checkpoints.flatMap((checkpoint) =>
		checkpoint.kind === "stage" &&
		checkpoint.topology?.boundary?.event === "start" &&
		checkpoint.topology.run?.runId === rootId
			? [checkpoint.replayKey]
			: [],
	);
}

function ownCheckpoints(checkpoints: readonly DurableCheckpoint[], rootId: string): DurableCheckpoint[] {
	const scopes = childScopes(checkpoints, rootId);
	return checkpoints.filter((checkpoint) => !scopes.some((scope) => checkpoint.checkpointId.startsWith(`${scope}:`)));
}

/** Every checkpoint of the run, as a backend that keeps all of them folds it. */
async function fullFold(backend: MemoryJournalBackend, rootId: string): Promise<readonly DurableCheckpoint[]> {
	const full = await JournalDurableBackend.open(backend.journal, { runs: [rootId], ownsJournal: false });
	try {
		return full.listCheckpoints(rootId);
	} finally {
		await full.close();
	}
}

function childRuns(store: Store, rootId: string) {
	return store
		.runs()
		.filter((candidate) => candidate.id !== rootId)
		.map((candidate) => ({
			id: candidate.id,
			name: candidate.name,
			status: candidate.status,
			parentRunId: candidate.parentRunId,
			stages: candidate.stages.map((stage) => [stage.name, stage.status, stage.result]),
			tools: candidate.toolNodes.map((tool) => [
				tool.name,
				tool.status === "cached" ? "completed" : tool.status,
				tool.result,
			]),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
}

interface HeldCheckpoints {
	/** What the root's backend listed for it, and what a backend keeping every checkpoint folded, at the same moment. */
	readonly held: readonly DurableCheckpoint[];
	readonly full: readonly DurableCheckpoint[];
}

interface PooledControl {
	interrupt: boolean;
	failing: string | undefined;
}

function pooledRoot(backend: MemoryJournalBackend, rootId: string) {
	const executions = new Map<string, number>();
	const atFinish: HeldCheckpoints[] = [];
	const control: PooledControl = { interrupt: true, failing: undefined };
	const child = workflow({
		name: "pooled-child",
		description: "",
		inputs: { item: Type.String() },
		outputs: { value: Type.String() },
		run: async (ctx) => {
			await ctx.stage("work").complete(`done-${ctx.inputs.item}`);
			for (let step = 0; step < CHILD_TOOLS; step++)
				await ctx.tool("step", { item: ctx.inputs.item, step }, async () => `${ctx.inputs.item}-${step}`);
			const value = await ctx.tool("record", { item: ctx.inputs.item }, async () => {
				if (control.failing === ctx.inputs.item) throw new Error(`${ctx.inputs.item} failed`);
				executions.set(ctx.inputs.item, (executions.get(ctx.inputs.item) ?? 0) + 1);
				return ctx.inputs.item;
			});
			return { value };
		},
	});
	const root = workflow({
		name: "pooled-root",
		description: "",
		inputs: {},
		outputs: { values: Type.Array(Type.String()) },
		run: async (ctx) => {
			const values: string[] = [];
			const failures: Error[] = [];
			const inFlight = new Map<number, Promise<void>>();
			let next = 0;
			while (next < CHILDREN || inFlight.size > 0) {
				while (next < CHILDREN && inFlight.size < POOL_WIDTH) {
					const index = next++;
					inFlight.set(
						index,
						ctx.workflow(child, { inputs: { item: `item-${index}` } }).then(
							(result) => {
								if (!result.exited) values[index] = String(result.outputs.value);
								inFlight.delete(index);
							},
							(error: Error) => {
								failures.push(error);
								inFlight.delete(index);
							},
						),
					);
				}
				await Promise.race(inFlight.values());
			}
			await ctx.tool("finish", {}, async () => {
				atFinish.push({ held: [...backend.listCheckpoints(rootId)], full: await fullFold(backend, rootId) });
				if (failures.length > 0) throw new Error(`${failures.length} children failed`);
				if (control.interrupt) throw new Error("interrupted after every child completed");
				return true;
			});
			return { values };
		},
	}) as WorkflowDefinition;
	return {
		root,
		child,
		executions,
		/** Captured when the root reaches its last tool, after every child settled. */
		atFinish,
		control,
	};
}

type PooledRoot = ReturnType<typeof pooledRoot>;

/** A stand-in pool for the root: it narrows the root's backend when prepared and receives every child. */
function attachPool(
	backend: MemoryJournalBackend,
	rootId: string,
	dispatch: (definition: WorkflowDefinition, inputs: ResolvedInputs, options: RunOpts) => Promise<RunResult>,
): void {
	releases.push(
		bindChildWorkerDispatcher(
			backend,
			{ validateOptions: () => {}, prepare: (root) => backend.retainOwnCheckpoints(root), run: dispatch },
			rootId,
		),
	);
}

function runOptions(pooled: PooledRoot, backend: MemoryJournalBackend, rootId: string, store: Store) {
	return {
		runId: rootId,
		registry: createRegistry([pooled.root, pooled.child] as WorkflowDefinition[]),
		store,
		durableBackend: backend,
		adapters: { complete: { complete: async (text: string) => text } },
	};
}

/** The root held exactly its own checkpoints, while its children's stayed in the journal. */
function assertHeldOwnCheckpoints(atFinish: HeldCheckpoints | undefined, rootId: string): void {
	assert.ok(atFinish !== undefined);
	assert.deepEqual(atFinish.held, ownCheckpoints(atFinish.full, rootId));
	assert.ok(atFinish.full.length > atFinish.held.length + CHILDREN * CHILD_TOOLS, "the children's stayed out");
}

test(
	"a resumed pooled root replays every completed child while its parent keeps only the root's own checkpoints (#4318)",
	async () => {
		const backend = await createMemoryTestBackend();
		const rootId = "pooled-root-own-checkpoints";
		const pooled = pooledRoot(backend, rootId);

		const firstStore = createStore();
		const first = await run(pooled.root, {}, runOptions(pooled, backend, rootId, firstStore));
		assert.equal(first.status, "failed");
		assert.equal(pooled.executions.size, CHILDREN);
		// Without a pool the root holds every checkpoint, its children's included.
		assert.deepEqual(pooled.atFinish[0]?.held, pooled.atFinish[0]?.full);

		const dispatched: (string | undefined)[] = [];
		attachPool(backend, rootId, async (_definition, _inputs, options) => {
			dispatched.push(options.runId);
			throw new Error("a completed child was dispatched again");
		});
		pooled.control.interrupt = false;
		const resumedStore = createStore();
		const resumed = await run(pooled.root, {}, runOptions(pooled, backend, rootId, resumedStore));
		assert.equal(resumed.status, "completed", resumed.error);
		assert.deepEqual(
			resumed.result?.values,
			Array.from({ length: CHILDREN }, (_, index) => `item-${index}`),
		);
		assert.deepEqual(dispatched, []);
		assert.ok(
			[...pooled.executions.values()].every((count) => count === 1),
			"no completed child re-ran its work",
		);
		assert.deepEqual(childRuns(resumedStore, rootId), childRuns(firstStore, rootId));
		assertHeldOwnCheckpoints(pooled.atFinish[1], rootId);

		// The handle counts every checkpoint, and once the root ended its next full read holds every one again.
		const final = await fullFold(backend, rootId);
		assert.equal(backend.getWorkflow(rootId)?.completedCheckpoints, final.length);
		await backend.hydrateWorkflow(rootId);
		assert.deepEqual(backend.listCheckpoints(rootId), final);
	},
	POOLED_RESUME_TIMEOUT_MS,
);

test(
	"a resumed pooled root checks a failed child's checkpoints and dispatches it again under its recorded identity (#4318)",
	async () => {
		const backend = await createMemoryTestBackend();
		const rootId = "pooled-root-failed-child";
		const pooled = pooledRoot(backend, rootId);
		pooled.control.interrupt = false;
		pooled.control.failing = "item-3";

		const firstStore = createStore();
		const first = await run(pooled.root, {}, runOptions(pooled, backend, rootId, firstStore));
		assert.equal(first.status, "failed");
		const failedChild = firstStore
			.runs()
			.find((candidate) => candidate.parentRunId === rootId && candidate.status === "failed");
		assert.ok(failedChild !== undefined);
		const recorded = await fullFold(backend, rootId);
		const failedScope = childScopes(recorded, rootId).find((scope) =>
			recorded.some(
				(checkpoint) =>
					checkpoint.kind === "stage" &&
					checkpoint.replayKey === scope &&
					checkpoint.topology?.boundary?.child.runId === failedChild.id,
			),
		);
		assert.ok(failedScope !== undefined);
		assert.ok(
			recorded.some((checkpoint) => checkpoint.checkpointId.startsWith(`${failedScope}:`)),
			"the failed child recorded checkpoints of its own",
		);

		const dispatched: { runId: string | undefined; scope: string | undefined; item: unknown }[] = [];
		attachPool(backend, rootId, async (_definition, inputs, options) => {
			dispatched.push({ runId: options.runId, scope: options.durableScope?.scopePrefix, item: inputs.item });
			return {
				runId: options.runId!,
				status: "completed",
				result: { value: inputs.item },
				stages: [],
				toolNodes: [],
			};
		});
		pooled.control.failing = undefined;
		// The resuming host's clock is behind the one that recorded the failure: the child's new terminal record
		// still sorts after the failed one, from the terminal records the root checked (#4318).
		const failedTerminal = recorded.find(
			(checkpoint) => checkpoint.checkpointId === `boundary-terminal:${failedScope}:failed`,
		);
		assert.ok(failedTerminal !== undefined);
		const clock = vi.spyOn(Date, "now").mockReturnValue(failedTerminal.completedAt - 60_000);
		let resumed: RunResult;
		try {
			resumed = await run(pooled.root, {}, runOptions(pooled, backend, rootId, createStore()));
		} finally {
			clock.mockRestore();
		}
		assert.equal(resumed.status, "completed", resumed.error);
		const completedTerminal = (await fullFold(backend, rootId)).find(
			(checkpoint) => checkpoint.checkpointId === `boundary-terminal:${failedScope}:completed`,
		);
		assert.equal(completedTerminal?.completedAt, failedTerminal.completedAt + 1);
		assert.deepEqual(
			resumed.result?.values,
			Array.from({ length: CHILDREN }, (_, index) => `item-${index}`),
		);
		assert.deepEqual(dispatched, [{ runId: failedChild.id, scope: failedScope, item: "item-3" }]);
		assertHeldOwnCheckpoints(pooled.atFinish.at(-1), rootId);
	},
	POOLED_RESUME_TIMEOUT_MS,
);

test("preparing a local worker pool for a root keeps only the root's own checkpoints in its backend (#4318)", async () => {
	const directory = makeTempDirectory("pool-root-own-checkpoints-");
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const pool = new LocalWorkerPool(backend, { journalPath: path, workers: 1, definitions: [] });
	const tool = (id: string, completedAt: number): DurableCheckpoint => ({
		kind: "tool",
		workflowId: "root",
		checkpointId: id,
		name: id,
		argsHash: id,
		output: id,
		completedAt,
	});
	const start = (child: number, completedAt: number): DurableCheckpoint => ({
		kind: "stage",
		workflowId: "root",
		checkpointId: `boundary-start:workflow:pooled-child:${child}`,
		name: "workflow:pooled-child",
		replayKey: `workflow:pooled-child:${child}`,
		completedAt,
		topology: {
			version: 1,
			stageId: `boundary-${child}`,
			parentIds: [],
			sourceOrder: child,
			status: "running",
			run: { runId: "root", runName: "root" },
			boundary: {
				version: 1,
				event: "start",
				status: "running",
				replayScope: `workflow:pooled-child:${child}`,
				alias: "pooled-child",
				workflow: "pooled-child",
				invocationFingerprint: `fingerprint-${child}`,
				child: {
					runId: `child-${child}`,
					runName: "pooled-child",
					parentRunId: "root",
					parentStageId: `boundary-${child}`,
					rootRunId: "root",
				},
			},
		},
	});
	try {
		await backend.commitWorkflowRegistration({
			workflowId: "root",
			name: "root",
			inputs: {},
			createdAt: 0,
			status: "running",
		});
		await backend.commitCheckpoint(start(1, 1));
		await backend.commitCheckpoint(tool("workflow:pooled-child:1:before", 2));
		await pool.prepare("root");
		await backend.commitCheckpoint(tool("workflow:pooled-child:1:after", 3));
		await backend.commitCheckpoint(start(2, 4));
		await backend.commitCheckpoint(tool("workflow:pooled-child:2:child", 5));
		await backend.commitCheckpoint(tool("root-after", 6));
		const listed = () => backend.listCheckpoints("root").map((checkpoint) => checkpoint.checkpointId);
		// The first child folded before the pool attached: its checkpoints stay until the root's boundary reads them
		// again. The second child started under the pool: the root keeps none of its checkpoints.
		assert.deepEqual(listed(), [
			"boundary-start:workflow:pooled-child:1",
			"workflow:pooled-child:1:before",
			"workflow:pooled-child:1:after",
			"boundary-start:workflow:pooled-child:2",
			"root-after",
		]);
		backend.releaseCheckpointScope("root", "workflow:pooled-child:1");
		assert.deepEqual(listed(), [
			"boundary-start:workflow:pooled-child:1",
			"boundary-start:workflow:pooled-child:2",
			"root-after",
		]);
		assert.equal(backend.getWorkflow("root")?.completedCheckpoints, 6);
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});
