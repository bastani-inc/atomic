import assert from "node:assert/strict";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowResumeAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { INTERACTIVE_WORKFLOW_POLICY, type WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { sleep } from "../helpers/runtime.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

/**
 * One transient storage refusal of one durable record (#5027): whichever record it hits, in a first or a resumed
 * attempt, the run stays inspectable and resumable, and completes once resumed.
 */

let answering: ReturnType<typeof setInterval> | undefined;
afterEach(() => {
	if (answering !== undefined) clearInterval(answering);
	answering = undefined;
	store.clear();
	setDurableBackend(undefined);
});

/** Where an attempt fails on purpose. */
interface Plan {
	failT2: boolean;
	failS2: boolean;
}

/** Which commit to refuse: the `nth` commit of attempt `attempt`, or the first whose id starts with `prefix`. */
type Refusal =
	| { readonly attempt: number; readonly nth: number }
	| { readonly attempt: number; readonly prefix: string };

function definitions(plan: { current: Plan }): { parent: WorkflowDefinition; child: WorkflowDefinition } {
	const child = workflow({
		name: "refused-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("c1").prompt("c1");
			await ctx.tool("ct", {}, async () => "ct");
			return {};
		},
	}) as WorkflowDefinition;
	const parent = workflow({
		name: "refused-parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("s1").prompt("s1");
			assert.equal(await ctx.ui.confirm("go on?"), true);
			await ctx.tool("t1", {}, async () => "t1");
			await ctx.tool("t2", {}, async () => {
				if (plan.current.failT2) throw new Error("planned t2 failure");
				return "t2";
			});
			await ctx.stage("s2").prompt("s2");
			await ctx.workflow(child);
			return {};
		},
	}) as WorkflowDefinition;
	return { parent, child };
}

const settled = (status: string) => (status === "cached" || status === "replayed" ? "completed" : status);

/** A run and the child runs its boundaries reach, by name and status, so live and durable runs compare. */
function graph(runs: readonly RunSnapshot[], rootId: string): unknown {
	const visit = (snapshot: RunSnapshot): unknown => ({
		stages: snapshot.stages.map((stage) => `${stage.name}:${settled(stage.status)}`).sort(),
		tools: snapshot.toolNodes.map((tool) => `${tool.name}:${settled(tool.status)}`).sort(),
		children: runs
			.filter(
				(candidate) =>
					candidate.parentRunId === snapshot.id &&
					snapshot.stages.some(
						(stage) =>
							stage.id === candidate.parentStageId && stage.status !== "failed" && stage.status !== "skipped",
					),
			)
			.map(visit),
	});
	const root = runs.find((candidate) => candidate.id === rootId);
	return root === undefined ? undefined : visit(root);
}

function durableGraph(backend: DurableWorkflowBackend, runId: string): unknown {
	const handle = backend.getWorkflow(runId);
	assert.ok(handle, "the run is durable");
	return graph(durableWorkflowRunSnapshots(backend, handle), runId);
}

function liveGraph(runId: string): unknown {
	return graph(
		store.runs().filter((candidate) => candidate.id === runId || candidate.rootRunId === runId),
		runId,
	);
}

async function waitEnded(runId: string): Promise<RunSnapshot> {
	for (let i = 0; i < 2000; i++) {
		await jobTracker.get(runId)?.promise.catch(() => {});
		const live = store.run(runId);
		if (live !== undefined && live.endedAt !== undefined && live.status !== "running") return live;
		await sleep(5);
	}
	throw new Error(`run ${runId} did not end`);
}

/**
 * Run the workflow under one refusal: attempt 0 follows `plans[0]`, each resume the next plan, then plain resumes
 * until it completes. Every attempt must leave a durable view, every resume must be accepted, and the run must
 * complete with a durable view, after reopening, that is the live one.
 */
async function runWithRefusal(
	refusal: Refusal,
	plans: readonly Plan[],
): Promise<{ refused: string | undefined; errors: readonly string[] }> {
	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	let attempt = 0;
	let commits = 0;
	let refused: string | undefined;
	const commit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = ((checkpoint: DurableCheckpoint, options?: { readonly signal?: AbortSignal }) => {
		commits += 1;
		const hit =
			refused === undefined &&
			attempt === refusal.attempt &&
			("nth" in refusal ? commits === refusal.nth : checkpoint.checkpointId.startsWith(refusal.prefix));
		if (hit) {
			refused = checkpoint.checkpointId;
			return Promise.reject(
				new StorageUnavailableError(
					{ adapter: "test", location: "refused" },
					new Error("journal refused") as never,
				),
			);
		}
		return commit(checkpoint, options);
	}) as typeof backend.commitCheckpoint;

	const plan = { current: plans[0]! };
	const { parent, child } = definitions(plan);
	const runtime = createExtensionRuntime({
		store,
		registry: createRegistry([parent, child]),
		adapters: {
			prompt: {
				prompt: async (text: string) => {
					if (text === "s2" && plan.current.failS2) throw new Error("planned s2 failure");
					return text;
				},
			},
		},
	});
	answering = setInterval(() => {
		for (const live of store.runs())
			for (const stage of live.stages)
				if (stage.pendingPrompt !== undefined)
					store.resolveStagePendingPrompt(live.id, stage.id, stage.pendingPrompt.id, true);
	}, 2);

	const started = await runtime.dispatch({ action: "run", workflow: parent.name, inputs: {} });
	assert.ok("runId" in started, JSON.stringify(started));
	const errors: string[] = [];
	const where = () => `refused ${refused ?? "nothing"} in attempt ${attempt}`;
	/** Resume `runId` until it completes, from attempt `first`, with a durable view after every attempt. */
	const complete = async (runId: string, first: number, plans: readonly Plan[]): Promise<void> => {
		// A fork waits paused for its first attempt.
		let live = first === FORK ? undefined : await waitEnded(runId);
		for (let next = first; ; next++) {
			assert.notEqual(durableGraph(backend, runId), undefined, `${where()}: the run has a durable view`);
			if (live?.status === "completed") return;
			if (live !== undefined) errors.push(live.error ?? "");
			assert.ok(next <= first + plans.length + 2, `${where()}: the run completes once resumed (${live?.error})`);
			attempt = next;
			commits = 0;
			plan.current = plans[next - first] ?? { failT2: false, failS2: false };
			const resume = async () => {
				const result = await workflowResumeAction(
					{ action: "resume", runId },
					{
						getRuntime: () => runtime,
						policy: INTERACTIVE_WORKFLOW_POLICY,
						ensureWorkflowResourcesLoaded: async () => {},
					},
				);
				assert.ok(result.action === "resume", JSON.stringify(result));
				return result;
			};
			let resumed = await resume();
			// A resume whose own first record is refused is refused as a whole; it is asked again, as a user would.
			if (resumed.status !== "running" && /Storage unavailable/.test(resumed.message ?? ""))
				resumed = await resume();
			assert.equal(resumed.status, "running", `${where()}: the run is resumable: ${JSON.stringify(resumed)}`);
			live = await waitEnded(runId);
		}
	};
	const runId = started.runId;
	await complete(runId, 1, plans.slice(1));
	const expected = liveGraph(runId);
	assert.deepEqual(durableGraph(backend, runId), expected, `${where()}: the durable view is the live one`);
	// A fork from s2 replays s1, the prompt and the tools into a run of its own, then runs s2 and the child.
	const fork = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		fromStage: "s2",
		cwd: process.cwd(),
		carryMessages: "before",
		definition: parent,
	});
	const forkRoot = durableWorkflowRunSnapshots(backend, backend.getWorkflow(fork.runId)!).find(
		(candidate) => candidate.id === fork.runId,
	);
	assert.ok(
		forkRoot?.stages.some((stage) => stage.name === "s1"),
		`${where()}: a fork keeps what came before s2`,
	);
	await complete(fork.runId, FORK, []);
	const forkExpected = liveGraph(fork.runId);
	assert.deepEqual(durableGraph(backend, fork.runId), forkExpected, `${where()}: the fork's durable view`);
	const reopened = await backend.reopen();
	assert.deepEqual(durableGraph(reopened, runId), expected, `${where()}: the reopened durable view is the live one`);
	assert.deepEqual(durableGraph(reopened, fork.runId), forkExpected, `${where()}: the reopened fork's view`);
	return { refused, errors };
}

/** The attempts of a fork of the completed run are numbered from here. */
const FORK = 100;

const COMPLETES: readonly Plan[] = [{ failT2: false, failS2: false }];
/** Attempt 0 fails at s2, so attempt 1 replays s1, the prompt, t1 and t2 and runs s2 and the child. */
const RESUMED: readonly Plan[] = [
	{ failT2: false, failS2: true },
	{ failT2: false, failS2: false },
];

describe("a refused durable write leaves the run inspectable and resumable (#5027)", () => {
	test("a refused tool replay record keeps the resumed attempt's durable view (#5027)", async () => {
		const { refused } = await runWithRefusal({ attempt: 1, prefix: "tool-replay-meta:" }, RESUMED);
		assert.match(refused ?? "", /^tool-replay-meta:/);
	});

	test("a refused tool failure record keeps the failed tool the resume frontier (#5027)", async () => {
		const { refused } = await runWithRefusal({ attempt: 0, prefix: "tool-failure:" }, [
			{ failT2: true, failS2: false },
		]);
		assert.match(refused ?? "", /^tool-failure:/);
	});

	test("a refused tool failure record in a resumed attempt keeps the run resumable (#5027)", async () => {
		const { refused } = await runWithRefusal({ attempt: 1, prefix: "tool-failure:" }, [
			{ failT2: true, failS2: false },
			{ failT2: true, failS2: false },
		]);
		assert.match(refused ?? "", /^tool-failure:/);
	});

	test("a refused stage replay record names the stage the attempt failed at (#5027)", async () => {
		const { refused } = await runWithRefusal({ attempt: 1, prefix: "stage-replay-meta:" }, RESUMED);
		assert.match(refused ?? "", /^stage-replay-meta:/);
	});

	test("a refused failure record of a failed stage keeps the stage's own failure (#5027)", async () => {
		const { refused, errors } = await runWithRefusal({ attempt: 0, prefix: "stage-meta:stage:s2:" }, RESUMED);
		assert.match(refused ?? "", /^stage-meta:stage:s2:/);
		assert.match(errors[0] ?? "", /planned s2 failure/);
	});

	test("a refused replay record of a forked run's stage leaves the fork resumable (#5027)", async () => {
		const { refused } = await runWithRefusal({ attempt: FORK, prefix: "stage-replay-meta:" }, COMPLETES);
		assert.match(refused ?? "", /^stage-replay-meta:/);
	});

	test("a refused stage completion record names the stage the attempt failed at (#5027)", async () => {
		for (const prefix of ["stage:stage:s1:", "stage:stage:s2:"]) {
			const { refused } = await runWithRefusal({ attempt: 0, prefix }, COMPLETES);
			assert.equal(refused?.startsWith(prefix), true, prefix);
			store.clear();
		}
	});
});

test("an answer no prompt node records is not lost to a refusal: the attempt fails instead (#5027)", async () => {
	const backend = await createMemoryTestBackend();
	const commit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = ((checkpoint: DurableCheckpoint, options?: { readonly signal?: AbortSignal }) =>
		checkpoint.checkpointId.startsWith("ui:")
			? Promise.reject(
					new StorageUnavailableError({ adapter: "test", location: "refused" }, new Error("refused") as never),
				)
			: commit(checkpoint, options)) as typeof backend.commitCheckpoint;
	let asked = 0;
	const def = workflow({
		name: "refused-answer",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.ui.confirm("go on?");
			await ctx.tool("after", {}, async () => "after");
			return {};
		},
	}) as WorkflowDefinition;
	const ui = {
		input: async () => "",
		confirm: async () => {
			asked += 1;
			return true;
		},
		select: async <T extends string>(_: string, options: readonly T[]) => options[0]!,
		editor: async () => "",
		custom: async <T>() => undefined as T,
	};
	const result = await run(def, {}, { store: createStore(), durableBackend: backend, ui });
	assert.equal(asked, 1);
	assert.equal(result.status, "failed", "the run does not go on past an answer it could not record");
	assert.match(result.error ?? "", /Storage unavailable/);
	assert.equal(
		backend.listCheckpoints(result.runId).some((checkpoint) => checkpoint.checkpointId.startsWith("tool:")),
		false,
	);
});

/** More than either attempt commits; a case past the last commit refuses nothing and must simply complete. */
const SWEEP = 40;

describe("one refusal at every checkpoint write (#5027)", () => {
	for (const [label, attempt, plans] of [
		["a first attempt", 0, COMPLETES],
		["a resumed attempt", 1, RESUMED],
	] as const) {
		test(`one refused write in ${label} leaves the run inspectable, resumable and completing (#5027)`, {
			timeout: 300_000,
		}, async () => {
			const refusedIds: string[] = [];
			for (let nth = 1; nth <= SWEEP; nth++) {
				const { refused } = await runWithRefusal({ attempt, nth }, plans);
				if (refused !== undefined) refusedIds.push(refused);
				store.clear();
				setDurableBackend(undefined);
			}
			// The sweep reached the run's every record kind, so a run that commits more can't slip past it.
			assert.ok(refusedIds.length < SWEEP, `the sweep covers every write: ${refusedIds.length}`);
			assert.ok(refusedIds.some((id) => id.startsWith(attempt === 0 ? "stage:stage:s1:" : "stage-replay-meta:")));
		});
	}
});
